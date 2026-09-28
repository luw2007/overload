/**
 * Context spool 摄入器（Core 侧 / control）。
 *
 * 扫描 spoolDir 下所有 active-context-collector*.ndjson（排除 .processed.*），
 * 逐行摄入两类事件到 control DB：
 *   1. context.fact_observed        → reducer 投影到 context-pool（对象池事实）。
 *   2. 用户可见注意力事件 → upsert control_attention（决策卡）：
 *        - context.pending
 *        - context.recovery_jump
 *        - context.recovery_package
 *        - context.recovery_reconcile
 *
 * 架构红线：
 *  - 本模块属于 control 侧，由 web server 的 publish loop 定时调用。
 *  - orchestrator 只写 NDJSON 文件（collectAndSpool），不直写 control DB。
 *  - 摄入完成后将文件重命名为 .processed.<ts> 保留审计，不删除。
 *  - collector 每次写一个新 seg 文件（写完即密封），ingest 不会读到半成品。
 *
 * fail-closed：缺必填字段、work 不存在、跨 work 一律计入 failed，不静默放行。
 */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { ControlError, upsertAttention, getWork } from "./store";
import { ingestFactObservedOrThrow } from "./context-reducer";
import { validateFactObservedPayload, type FactObservedPayload } from "../shared/context-contract";

export interface IngestStats {
  /** 从 spool 文件读取的行数 */
  read: number;
  /** 新投影 / 新建 attention 卡 */
  created: number;
  /** 幂等跳过 / 既有 attention 卡更新 */
  idempotent: number;
  /** 冲突隔离（同 idempotency_key 异 content_hash） */
  quarantined: number;
  /** 校验失败或其他错误 */
  failed: number;
  errors: Array<{ line: number; reason: string }>;
}

const EMPTY: IngestStats = { read: 0, created: 0, idempotent: 0, quarantined: 0, failed: 0, errors: [] };

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
    if (name.includes(".processed.")) continue;
    const full = join(spoolDir, name);
    try {
      const st = statSync(full);
      pending.push({ path: full, mtime: st.mtimeMs });
    } catch { /* 文件已被移动，跳过 */ }
  }
  pending.sort((a, b) => a.mtime - b.mtime);
  return pending.map((p) => p.path);
}

/**
 * 扫描 spoolDir 下所有 active-context-collector*.ndjson（排除 .processed.*），
 * 按 mtime 顺序逐个摄入到 control DB。处理完后每个文件重命名为 .processed.<ts>。
 *
 * 本函数在调用方事务外运行；每行 ingest 内部已有 immediate 事务。
 */
export function ingestContextSpool(controlDb: Database, spoolDir: string): IngestStats {
  // OVERLOAD_CONTEXT_ASSEMBLY_ENABLED=false：ingest 层停用，返回全 0，不读 spool、不写表。
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") return { ...EMPTY, errors: [] };

  const files = findPendingFiles(spoolDir);
  if (files.length === 0) return { ...EMPTY, errors: [] };

  const stats: IngestStats = { read: 0, created: 0, idempotent: 0, quarantined: 0, failed: 0, errors: [] };

  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    stats.read += lines.length;

    // 失败行（JSON 解析失败、未知 kind、非 Conflict 的 ControlError）写入 quarantine sidecar，
    // 不随 .processed 改名而静默丢失。Conflict 已由 reducer 落 control_context_fact_quarantine 表。
    const failedRows: Array<{ line: number; reason: string; raw: string }> = [];
    const recordFailed = (lineNo: number, reason: string, rawLine: string): void => {
      stats.failed++;
      stats.errors.push({ line: lineNo, reason });
      failedRows.push({ line: lineNo, reason, raw: rawLine });
    };

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1;
      let envelope: unknown;
      try {
        envelope = JSON.parse(lines[i]);
      } catch (err) {
        recordFailed(lineNo, `invalid JSON: ${(err as Error).message}`, lines[i]);
        continue;
      }

      const kind =
        envelope && typeof envelope === "object" && "kind" in envelope
          ? (envelope as { kind: unknown }).kind
          : null;
      const detail =
        envelope && typeof envelope === "object" && "detail" in envelope
          ? (envelope as { detail: unknown }).detail
          : envelope;

      try {
        if (kind === "context.fact_observed") {
          // 事实投影：校验 + reducer 摄入。
          try {
            validateFactObservedPayload(detail);
          } catch (err) {
            recordFailed(lineNo, (err as Error).message, lines[i]);
            continue;
          }
          const payload = detail as FactObservedPayload;
          const result = ingestFactObservedOrThrow(controlDb, payload, { actor: payload.source_identity });
          if (result.status === "created") stats.created++;
          else stats.idempotent++;
        } else if (typeof kind === "string" && ATTENTION_KINDS.has(kind as AttentionKind)) {
          // 用户可见注意力事件：upsert control_attention。
          const isNew = ingestAttentionEvent(controlDb, kind as AttentionKind, detail);
          if (isNew) stats.created++;
          else stats.idempotent++;
        } else {
          recordFailed(lineNo, `unknown or missing event kind: ${String(kind)}`, lines[i]);
        }
      } catch (err) {
        if (err instanceof ControlError && err.code === "conflict") {
          stats.quarantined++;
          stats.errors.push({ line: lineNo, reason: err.message });
        } else {
          recordFailed(lineNo, err instanceof Error ? err.message : String(err), lines[i]);
        }
      }
    }

    // 失败行落 quarantine sidecar（NDJSON，含原始行与原因），供人工/重放恢复。
    if (failedRows.length > 0) {
      const sidecar = join(spoolDir, `${basename(file)}.quarantine.${Date.now()}.ndjson`);
      writeFileSync(sidecar, failedRows.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    }

    // 重命名保留审计（不删除）。
    const processed = join(spoolDir, `${basename(file)}.processed.${Date.now()}`);
    renameSync(file, processed);
  }

  return stats;
}
