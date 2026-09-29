/**
 * Context spool 摄入器（Core 侧 / control）。
 *
 * 扫描 spoolDir 下所有 active-context-collector*.ndjson（排除 .processed.*），
 * 逐行摄入三类事件到 control DB：
 *   1. context.fact_observed        → reducer 投影到 context-pool（对象池事实）。
 *   2. context.external_observation → 受校验的外部观察，按既有 Work/Attention 路由。
 *   3. 用户可见注意力事件 → upsert control_attention（决策卡）：
 *        - context.pending
 *        - context.recovery_jump
 *        - context.recovery_package
 *        - context.recovery_reconcile
 *
 * 架构红线：
 *  - 本模块属于 control 侧，由 web server 的 publish loop 定时调用。
 *  - orchestrator 只写 NDJSON 文件（collectAndSpool），不直写 control DB。
 *  - 摄入完成后将文件重命名为 .processed.<ts> 保留审计，不删除。
 *  - collector 每次写一个新 seg 文件（写完即密封），ingest 不会读到半成品；单次
 *    pass 只在整段可落入预算时处理，绝不 checkpoint 到文件中间而重复投影。
 *
 * fail-closed：缺必填字段、work 不存在、跨 work 一律计入 failed，不静默放行。
 */
import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ControlError, upsertAttention, getWork } from "./store";
import { ingestFactObservedOrThrow } from "./context-reducer";
import { ingestExternalObservation } from "./external-observations";
import { validateFactObservedPayload, type FactObservedPayload } from "../shared/context-contract";
import { validateExternalObservationInput, type ExternalObservationInput } from "../shared/external-observation-contract";

export interface IngestStats {
  /** 从 spool 文件读取的非空行数 */
  read: number;
  /** 新投影 / 新建 attention 卡 */
  created: number;
  /** 幂等跳过 / 既有 attention 卡更新 */
  idempotent: number;
  /** 冲突隔离（同 idempotency_key 异 content_hash） */
  quarantined: number;
  /** 校验失败或其他错误 */
  failed: number;
  /** 本轮预算耗尽而保留给后续 pass 的文件数 */
  deferred: number;
  /** 本轮开始时仍待处理的文件数 */
  backlog_files: number;
  /** 本轮开始时待处理文件的总字节数 */
  backlog_bytes: number;
  /** 本轮安全重命名为 processed 的文件数 */
  processed_files: number;
  /** 过长且没有完整记录边界的文件数；原文件保留供恢复 */
  blocked_files: number;
  /** 实际从磁盘扫描的字节数 */
  bytes_read: number;
  /** Another importer owns the spool pass; no file was read or renamed. */
  busy: boolean;
  errors: Array<{ line: number; reason: string }>;
}

export interface ContextIngestOptions {
  max_files?: number;
  max_lines?: number;
  max_bytes?: number;
}

const DEFAULT_MAX_FILES = 4;
const DEFAULT_MAX_LINES = 1_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const EMPTY: IngestStats = { read: 0, created: 0, idempotent: 0, quarantined: 0, failed: 0, deferred: 0, backlog_files: 0, backlog_bytes: 0, processed_files: 0, blocked_files: 0, bytes_read: 0, busy: false, errors: [] };

// ========== 用户可见注意力事件摄入 ==========

type AttentionKind =
  | "context.pending"
  | "context.recovery_jump"
  | "context.recovery_package"
  | "context.recovery_reconcile";

const ATTENTION_KIND_META: Record<AttentionKind, {
  conclusion: string;
  urgency: "now" | "inbox";
  recommendation: string;
  /** detail 中作为 trigger 的字段 */
  triggerField: "reason" | "jump_target" | "checkpoint_reference";
}> = {
  "context.pending": {
    conclusion: "需要人补充上下文：任务推进被阻塞",
    urgency: "now",
    recommendation: "通过 deep_link 查看任务，补齐 required_context 后继续",
    triggerField: "reason",
  },
  "context.recovery_jump": {
    conclusion: "活会话等待人介入：跳回原现场",
    urgency: "now",
    recommendation: "通过 deep_link 跳回阻塞现场继续（进程仍在，勿重启）",
    triggerField: "jump_target",
  },
  "context.recovery_package": {
    conclusion: "进程终止：需要人决定是否从 checkpoint 恢复",
    urgency: "now",
    recommendation: "核对 incomplete_steps 后从 checkpoint_reference 续跑",
    triggerField: "checkpoint_reference",
  },
  "context.recovery_reconcile": {
    conclusion: "现场对账：liveness 未知，需要人核对",
    urgency: "inbox",
    recommendation: "对账 ledger/incarnation/jsonl/surface 后决定 spawn 或恢复",
    triggerField: "reason",
  },
};

const ATTENTION_KINDS = new Set(Object.keys(ATTENTION_KIND_META) as AttentionKind[]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * 摄入一个用户可见注意力事件，upsert 一张 control_attention 卡。
 * 幂等键 = (work_id, task_id, kind) → 同一事件重复到达只更新不新建。
 * 返回 true=新建，false=更新既有卡。校验失败抛 ControlError。
 */
function ingestAttentionEvent(
  db: Database,
  kind: AttentionKind,
  detail: unknown,
  now = Date.now(),
): boolean {
  const d = asRecord(detail);
  if (!d) throw new ControlError("invalid", `${kind}: detail must be an object`);

  const workId = asNonEmptyString(d.work_id);
  const taskId = asNonEmptyString(d.task_id);
  const owner = asNonEmptyString(d.owner);
  const deepLink = asNonEmptyString(d.deep_link);
  if (!workId) throw new ControlError("invalid", `${kind}: work_id is required`);
  if (!taskId) throw new ControlError("invalid", `${kind}: task_id is required`);
  if (!owner) throw new ControlError("invalid", `${kind}: owner is required`);

  const meta = ATTENTION_KIND_META[kind];
  const trigger = asNonEmptyString(d[meta.triggerField]) ?? "(unspecified)";

  // work 必须已存在（upsertAttention 校验 contract_revision === work.revision）。
  const work = getWork(db, workId);
  if (!work) throw new ControlError("not_found", `${kind}: work not found: ${workId}`);

  const itemId = `ctx:${kind}:${workId}:${taskId}`;
  const existing = db.query("SELECT revision FROM control_attention WHERE item_id=?").get(itemId) as { revision: number } | null;

  upsertAttention(db, {
    item_id: itemId,
    work_id: workId,
    state: "open",
    // schema effect_state 枚举无 'open'（仅 not_started/applying/succeeded/failed/unknown）。
    // 偏离记录：待人处理的开放卡映射为 effect_state='not_started'、state='open'。
    effect_state: "not_started",
    urgency: meta.urgency,
    conclusion: meta.conclusion,
    trigger: trigger,
    impact: taskId,
    recommendation: meta.recommendation,
    options: [],
    owner: owner,
    // 24h 时效：有时效的决策必须显示有效期。
    expires_at: now + 24 * 60 * 60 * 1000,
    source_link: deepLink,
    approval_id: null,
    consumer_owner: "orchestrator",
    contract_revision: work.revision,
    decision_mode: "human_only",
    evidence: {
      kind,
      task_id: taskId,
      deep_link: deepLink,
      ...d,
    },
    // upsertAttention 更新既有卡要求 CAS：传入当前 revision。
    ...(existing ? { expected_revision: existing.revision } : {}),
  }, now);

  return !existing;
}

/** 扫描 spoolDir 下所有待处理的 collector seg 文件，按 mtime 排序。 */
function findPendingFiles(spoolDir: string): string[] {
  let entries: string[];
  try { entries = readdirSync(spoolDir); } catch { return []; }
  const pending: { path: string; mtime: number }[] = [];
  for (const name of entries) {
    if (!name.startsWith("active-context-collector")) continue;
    if (!name.endsWith(".ndjson")) continue;
    if (name.includes(".processed.") || name.includes(".quarantine.")) continue;
    const full = join(spoolDir, name);
    try {
      const st = statSync(full);
      pending.push({ path: full, mtime: st.mtimeMs });
    } catch { /* 文件已被移动，跳过 */ }
  }
  pending.sort((a, b) => a.mtime - b.mtime);
  return pending.map((p) => p.path);
}

function validateOptions(options: ContextIngestOptions): Required<ContextIngestOptions> {
  const max_files = options.max_files ?? DEFAULT_MAX_FILES;
  const max_lines = options.max_lines ?? DEFAULT_MAX_LINES;
  const max_bytes = options.max_bytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(max_files) || max_files < 1 || max_files > 100) throw new ControlError("invalid", "max_files must be 1..100");
  if (!Number.isSafeInteger(max_lines) || max_lines < 1 || max_lines > 100_000) throw new ControlError("invalid", "max_lines must be 1..100000");
  if (!Number.isSafeInteger(max_bytes) || max_bytes < 1 || max_bytes > 64 * 1024 * 1024) throw new ControlError("invalid", "max_bytes must be 1..67108864");
  return { max_files, max_lines, max_bytes };
}

/** A crashed importer is recoverable after this bounded ownership lease expires. */
const INGEST_LEASE_MS = 5 * 60 * 1000;

function acquireIngestLease(db: Database, spoolDir: string, now: number): string | null {
  const spoolKey = createHash("sha256").update(resolve(spoolDir)).digest("hex");
  const token = randomUUID();
  const acquired = db.transaction(() => {
    db.query("INSERT OR IGNORE INTO control_context_ingest_leases(spool_key,owner_token,lease_until,updated_at) VALUES(?,?,?,?)")
      .run(spoolKey, token, now + INGEST_LEASE_MS, now);
    const row = db.query("SELECT owner_token,lease_until FROM control_context_ingest_leases WHERE spool_key=?").get(spoolKey) as { owner_token: string; lease_until: number } | null;
    if (row?.owner_token === token) return true;
    return !!db.query("UPDATE control_context_ingest_leases SET owner_token=?,lease_until=?,updated_at=? WHERE spool_key=? AND lease_until<=?")
      .run(token, now + INGEST_LEASE_MS, now, spoolKey, now).changes;
  }).immediate() as boolean;
  return acquired ? `${spoolKey}:${token}` : null;
}

function releaseIngestLease(db: Database, lease: string): void {
  const separator = lease.indexOf(":");
  db.query("DELETE FROM control_context_ingest_leases WHERE spool_key=? AND owner_token=?")
    .run(lease.slice(0, separator), lease.slice(separator + 1));
}

/**
 * One bounded fair spool pass. A sealed file is only renamed after every line
 * has crossed a durable reducer boundary. A file that cannot fit the residual
 * pass budget remains untouched; an irreducibly oversized record is reported
 * and retained for recovery rather than partially consumed or discarded.
 */
export function ingestContextSpool(controlDb: Database, spoolDir: string, options: ContextIngestOptions = {}): IngestStats {
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") return { ...EMPTY, errors: [] };
  const lease = acquireIngestLease(controlDb, spoolDir, Date.now());
  if (!lease) return { ...EMPTY, busy: true, errors: [] };
  try {
    const limits = validateOptions(options);
    const files = findPendingFiles(spoolDir);
    const stats: IngestStats = { ...EMPTY, errors: [] };
    stats.backlog_files = files.length;
    for (const file of files) {
      try { stats.backlog_bytes += statSync(file).size; } catch { /* raced rename */ }
    }
    let remainingLines = limits.max_lines;
    let remainingBytes = limits.max_bytes;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex]!;
      if (fileIndex >= limits.max_files || remainingLines === 0 || remainingBytes === 0) {
        stats.deferred += files.length - fileIndex;
        break;
      }
      let raw: string;
      try { raw = readFileSync(file, "utf8"); } catch { continue; }
      const rawBytes = Buffer.byteLength(raw);
      if (rawBytes > remainingBytes) {
        stats.blocked_files++;
        stats.deferred += files.length - fileIndex;
        break;
      }
      const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
      if (lines.length > remainingLines) {
        stats.deferred += files.length - fileIndex;
        break;
      }
      remainingBytes -= rawBytes;
      remainingLines -= lines.length;
      stats.bytes_read += rawBytes;
      stats.read += lines.length;
      const failedRows: Array<{ line: number; reason: string; raw: string }> = [];
      const recordFailed = (lineNo: number, reason: string, rawLine: string): void => {
        stats.failed++;
        stats.errors.push({ line: lineNo, reason });
        failedRows.push({ line: lineNo, reason, raw: rawLine });
      };
      for (let i = 0; i < lines.length; i++) {
        const lineNo = i + 1;
        let envelope: unknown;
        try { envelope = JSON.parse(lines[i]!); }
        catch (error) { recordFailed(lineNo, `invalid JSON: ${(error as Error).message}`, lines[i]!); continue; }
        const kind = envelope && typeof envelope === "object" && "kind" in envelope ? (envelope as { kind: unknown }).kind : null;
        const detail = envelope && typeof envelope === "object" && "detail" in envelope ? (envelope as { detail: unknown }).detail : envelope;
        try {
          if (kind === "context.fact_observed") {
            try { validateFactObservedPayload(detail); }
            catch (error) { recordFailed(lineNo, (error as Error).message, lines[i]!); continue; }
            const payload = detail as FactObservedPayload;
            const result = ingestFactObservedOrThrow(controlDb, payload, { actor: payload.source_identity });
            if (result.status === "created") stats.created++; else stats.idempotent++;
          } else if (kind === "context.external_observation") {
            try { validateExternalObservationInput(detail); }
            catch (error) { recordFailed(lineNo, (error as Error).message, lines[i]!); continue; }
            const result = ingestExternalObservation(controlDb, detail as ExternalObservationInput);
            if (result.status === "created") stats.created++;
            else if (result.status === "idempotent") stats.idempotent++;
            else { stats.quarantined++; stats.errors.push({ line: lineNo, reason: result.reason }); }
          } else if (typeof kind === "string" && ATTENTION_KINDS.has(kind as AttentionKind)) {
            if (ingestAttentionEvent(controlDb, kind as AttentionKind, detail)) stats.created++; else stats.idempotent++;
          } else recordFailed(lineNo, `unknown or missing event kind: ${String(kind)}`, lines[i]!);
        } catch (error) {
          if (error instanceof ControlError && error.code === "conflict") {
            stats.quarantined++;
            stats.errors.push({ line: lineNo, reason: error.message });
          } else recordFailed(lineNo, error instanceof Error ? error.message : String(error), lines[i]!);
        }
      }
      if (failedRows.length) {
        writeFileSync(join(spoolDir, `${basename(file)}.quarantine.${Date.now()}.ndjson`), failedRows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
      }
      renameSync(file, join(spoolDir, `${basename(file)}.processed.${Date.now()}`));
      stats.processed_files++;
    }
    return stats;
  } finally {
    releaseIngestLease(controlDb, lease);
  }
}
