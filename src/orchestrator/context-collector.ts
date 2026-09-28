import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { FactObservedPayload, FactSubtype, Sensitivity, SourceType } from "../shared/context-contract";

/**
 * T2b context-collector（Execution owner）。
 *
 * 职责边界（红线）：
 *  - 本模块只从 orchestrator 自己的持久存储（tasks / task_events，只读）采集事实，
 *    产出 context.fact_observed 事件。
 *  - 严禁 import src/control/*，不写任何 control_* 表。事件经 orchestrator spool
 *    （NDJSON 文件）传递，由 Core 的 ingestFactObserved reducer 事务投影到 context-pool。
 *  - 权威源只用持久存储：不读 runner 内存 map（receiptByToolCall 等）。
 *  - actor 由服务端运行上下文注入（ctx.actor），不从请求体自填。
 */

// 与 Core reducer（src/control/context-reducer.ts）共享同一权威类型定义。
// FactObservedEvent 是 FactObservedPayload 的别名，保持 collector 侧既有命名。
export type FactObservedEvent = FactObservedPayload;
export type FactSourceType = SourceType;
export type { FactSubtype, Sensitivity };

export interface CollectorContext {
  /** orchestrator 自己的 DB（本模块只读采集，不向控制库写入）。 */
  orchestratorDb: Database;
  work_id: string;
  problem_id?: string;
  /** 服务端注入的 actor，不从请求体自填。 */
  actor: string;
  /** 源实例 ID，缺省记为 'orchestrator'。 */
  runtime_id?: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * 稳定序列化：对对象按键名排序后 JSON.stringify，保证同值不同键序产出同一字符串。
 * 用于 code_state / external_state（源不是 task_events.detail 原文，而是 tasks 字段的投影）。
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/**
 * 采集端去重状态。
 * 权威源是 orchestrator DB 的 context_collector_cursor 表（纯追加，重启后不丢失）。
 * 模块级 Map 仅作为进程内缓存，DB 始终为准。
 *
 * 语义（与 reducer idempotency_key 对齐）：
 *  - 从未观测 → revision=1 发出。
 *  - 已观测且 content_hash 未变 → 不重复发出（同一 source_event_id + 同 revision）。
 *  - 已观测但 content_hash 变了（同源新观测，如测试重跑）→ revision+1 发出新版本。
 */
const observed = new Map<string, { revision: number; contentHash: string }>();

/** 测试用：清空进程内缓存（DB cursor 不受影响，跨进程去重仍生效）。 */
export function resetCollectorDedup(): void {
  observed.clear();
}

type EmitInput = {
  objectCanonicalKey: string;
  reference: string;
  sourceType: FactSourceType;
  sourceEventId: string;
  factSubtype: FactSubtype;
  /**
   * sha256(canonical_source_bytes)。
   *  - test_result / observation_evidence：= sha256(task_events.detail 列原始字符串)。
   *    fetchOnDemand 对 orchestrator:task_event:<id> 返回同一 detail 原文，hash 校验通过。
   *  - code_state / external_state：= sha256(stableStringify(tasks 字段投影))。
   *    这两个 subtype 的 reference（orchestrator:task:<id>:branch / :pr）不匹配 fetcher
   *    的任何 handler，fetchOnDemand 返回 unavailable——full 取源不支持，hash 仅作去重/版本签名。
   */
  contentHash: string;
  /** 源事件发生时间（epoch ms）。test_result/observation_evidence = task_events.at；code/external = tasks.updated_at。 */
  collectedAt: number;
  sensitivity: Sensitivity;
  attempt?: string | null;
  expiresAt?: string | null;
  derivedFrom?: string[] | null;
};

function buildEvent(ctx: CollectorContext, input: EmitInput): FactObservedEvent | null {
  const contentHash = input.contentHash;
  const db = ctx.orchestratorDb;

  // 先查 DB cursor（权威源），内存 Map 仅作缓存加速。
  let revision: number;
  const cached = observed.get(input.sourceEventId);
  const row = db.query(
    "SELECT observation_revision, content_hash FROM context_collector_cursor WHERE source_event_id=?"
  ).get(input.sourceEventId) as { observation_revision: number; content_hash: string } | undefined;

  if (row) {
    if (row.content_hash === contentHash) {
      // 同 source_event_id + 同观测内容：已发过，跳过。
      observed.set(input.sourceEventId, { revision: row.observation_revision, contentHash });
      return null;
    }
    revision = row.observation_revision + 1;
  } else if (cached) {
    // DB 无记录但内存有（不太可能，防御性）→ 以内存为准。
    if (cached.contentHash === contentHash) return null;
    revision = cached.revision + 1;
  } else {
    revision = 1;
  }

  // 更新 DB cursor（权威源）和内存缓存。
  db.run(
    "INSERT INTO context_collector_cursor(source_event_id, observation_revision, content_hash, last_collected_at) VALUES(?,?,?,?) ON CONFLICT(source_event_id) DO UPDATE SET observation_revision=excluded.observation_revision, content_hash=excluded.content_hash, last_collected_at=excluded.last_collected_at",
    [input.sourceEventId, revision, contentHash, Date.now()]
  );
  observed.set(input.sourceEventId, { revision, contentHash });

  return {
    work_id: ctx.work_id,
    problem_id: ctx.problem_id ?? null,
    object_canonical_key: input.objectCanonicalKey,
    reference: input.reference,
    source_type: input.sourceType,
    source_id: ctx.runtime_id ?? "orchestrator",
    source_identity: ctx.actor,
    source_event_id: input.sourceEventId,
    observation_revision: revision,
    attempt: input.attempt ?? null,
    fact_subtype: input.factSubtype,
    content_hash: contentHash,
    sensitivity: input.sensitivity,
    collected_at: new Date(input.collectedAt).toISOString(),
    expires_at: input.expiresAt ?? null,
    derived_from: input.derivedFrom ? JSON.stringify(input.derivedFrom) : null,
  };
}

type TaskRow = {
  task_id: string;
  repo: string;
  base_ref: string;
  branch: string | null;
  worktree: string | null;
  attempt_id: string | null;
  pr_url: string | null;
  state: string;
  ci_observation_failures: number;
  updated_at: number;
};

function workTasks(db: Database, workId: string): TaskRow[] {
  return db
    .query(
      `SELECT task_id, repo, base_ref, branch, worktree, attempt_id, pr_url, state, ci_observation_failures, updated_at
       FROM tasks WHERE work_id=?`,
    )
    .all(workId) as TaskRow[];
}

type EventRow = {
  id: number;
  task_id: string;
  at: number;
  event: string;
  detail: string | null;
};

/** 每 task 在指定事件集合里的最新一条 task_events（按自增 id 取最大）。 */
function latestEventsPerTask(db: Database, workId: string, events: string[]): EventRow[] {
  if (events.length === 0) return [];
  const placeholders = events.map(() => "?").join(",");
  return db
    .query(
      `SELECT e.id, e.task_id, e.at, e.event, e.detail
       FROM task_events e
       JOIN tasks t ON t.task_id = e.task_id
       JOIN (
         SELECT task_id, MAX(id) AS max_id FROM task_events
         WHERE event IN (${placeholders}) GROUP BY task_id
       ) m ON e.id = m.max_id
       WHERE t.work_id = ?`,
    )
    .all(...events, workId) as EventRow[];
}

/**
 * test_result ← task_events 中每 task 最新的 runner_exit（证据/检查结论，持久化在 orchestrator DB）。
 * source_event_id 按 task（逻辑上的"该任务的测试/检查"），重跑产生新 detail 时 revision 递增。
 *
 * content_hash = sha256(task_events.detail 列原始字符串)，与 on-demand-fetcher 的
 * orchestrator:task_event:<id> 返回值逐字节一致，full 取源 hash 校验通过。
 * detail 为 NULL 时源字节为空串（fetcher 此时返回 unavailable，hash 不会被校验，仅作签名）。
 */
export function collectTestResults(ctx: CollectorContext): FactObservedEvent[] {
  const out: FactObservedEvent[] = [];
  for (const row of latestEventsPerTask(ctx.orchestratorDb, ctx.work_id, ["runner_exit"])) {
    const rawDetail = row.detail ?? "";
    const ev = buildEvent(ctx, {
      objectCanonicalKey: `invocation:${row.task_id}`,
      reference: `orchestrator:task_event:${row.id}`,
      sourceType: "orchestrator",
      sourceEventId: `invocation:${row.task_id}`,
      factSubtype: "test_result",
      contentHash: sha256(rawDetail),
      collectedAt: row.at,
      sensitivity: "clean",
      attempt: attemptFor(ctx.orchestratorDb, row.task_id),
      derivedFrom: [`orchestrator:task:${row.task_id}`, `orchestrator:task_event:${row.id}`],
    });
    if (ev) out.push(ev);
  }
  return out;
}

/**
 * code_state ← tasks 表中已落分支的任务（分支即代码状态的持久句柄；git sha 不在 orchestrator DB 持久化）。
 * content_hash = sha256(stableStringify({repo, branch, base_ref, worktree}))。
 * reference = orchestrator:task:<id>:branch —— fetcher 无此 handler，full 取源返回 unavailable。
 * collected_at = tasks.updated_at（无 task_events.at）。
 */
export function collectCodeState(ctx: CollectorContext): FactObservedEvent[] {
  const out: FactObservedEvent[] = [];
  for (const task of workTasks(ctx.orchestratorDb, ctx.work_id)) {
    if (!task.branch) continue;
    const sourceBytes = stableStringify({
      repo: task.repo,
      branch: task.branch,
      base_ref: task.base_ref,
      worktree: task.worktree,
    });
    const ev = buildEvent(ctx, {
      objectCanonicalKey: `git:${task.repo}:${task.branch}`,
      reference: `orchestrator:task:${task.task_id}:branch`,
      sourceType: "orchestrator",
      sourceEventId: `git:${task.repo}:${task.branch}`,
      factSubtype: "code_state",
      contentHash: sha256(sourceBytes),
      collectedAt: task.updated_at,
      sensitivity: "clean",
      attempt: task.attempt_id,
      derivedFrom: [`orchestrator:task:${task.task_id}`],
    });
    if (ev) out.push(ev);
  }
  return out;
}

/**
 * external_state ← tasks 表中已有 PR 的任务（PR/CI 外部系统状态，持久化在 orchestrator DB）。
 * content_hash = sha256(stableStringify({pr_url, state, ci_observation_failures}))。
 * reference = orchestrator:task:<id>:pr —— fetcher 无此 handler，full 取源返回 unavailable。
 * collected_at = tasks.updated_at。
 */
export function collectExternalState(ctx: CollectorContext): FactObservedEvent[] {
  const out: FactObservedEvent[] = [];
  for (const task of workTasks(ctx.orchestratorDb, ctx.work_id)) {
    if (!task.pr_url) continue;
    const sourceBytes = stableStringify({
      pr_url: task.pr_url,
      state: task.state,
      ci_observation_failures: task.ci_observation_failures,
    });
    const ev = buildEvent(ctx, {
      objectCanonicalKey: `pr:${task.repo}:${task.pr_url}`,
      reference: `orchestrator:task:${task.task_id}:pr`,
      sourceType: "orchestrator",
      sourceEventId: `pr:${task.task_id}`,
      factSubtype: "external_state",
      contentHash: sha256(sourceBytes),
      collectedAt: task.updated_at,
      sensitivity: "clean",
      attempt: task.attempt_id,
      derivedFrom: [`orchestrator:task:${task.task_id}`],
    });
    if (ev) out.push(ev);
  }
  return out;
}

/**
 * observation_evidence ← task_events 中的诊断类事件（append-only，每条观测独立）。
 * ledger effect_observed 的跨库读取本专项退化为 orchestrator 自己记录的诊断快照（plan §6.1 允许）。
 * content_hash = sha256(task_events.detail 列原始字符串)，与 fetcher 源返回值一致。
 */
export function collectObservationEvidence(ctx: CollectorContext): FactObservedEvent[] {
  const diagnosticEvents = [
    "check_absent",
    "spawn_fail",
    "worktree_fail",
    "runner_dead",
    "ci_observation_failed",
    "bind_timeout",
    "no_attempt",
    "liveness_unknown",
    "tick_error",
  ];
  const out: FactObservedEvent[] = [];
  for (const row of diagnosticEvents.length ? allDiagnosticEvents(ctx, diagnosticEvents) : []) {
    const rawDetail = row.detail ?? "";
    const ev = buildEvent(ctx, {
      objectCanonicalKey: `evidence:${row.task_id}:${row.event}:${row.id}`,
      reference: `orchestrator:task_event:${row.id}`,
      sourceType: "orchestrator",
      sourceEventId: `task-event:${row.id}`,
      factSubtype: "observation_evidence",
      contentHash: sha256(rawDetail),
      collectedAt: row.at,
      sensitivity: "clean",
      attempt: attemptFor(ctx.orchestratorDb, row.task_id),
      derivedFrom: [`orchestrator:task:${row.task_id}`],
    });
    if (ev) out.push(ev);
  }
  return out;
}

function allDiagnosticEvents(ctx: CollectorContext, events: string[]): EventRow[] {
  const placeholders = events.map(() => "?").join(",");
  return ctx.orchestratorDb
    .query(
      `SELECT e.id, e.task_id, e.at, e.event, e.detail
       FROM task_events e JOIN tasks t ON t.task_id = e.task_id
       WHERE t.work_id=? AND e.event IN (${placeholders}) ORDER BY e.id`,
    )
    .all(ctx.work_id, ...events) as EventRow[];
}

function attemptFor(db: Database, taskId: string): string | null {
  const row = db.query("SELECT attempt_id FROM tasks WHERE task_id=?").get(taskId) as
    | { attempt_id: string | null }
    | undefined;
  return row?.attempt_id ?? null;
}

/** 采集该 work 的所有新事实（不写 spool；调用方决定写入时机）。 */
export function collectFacts(ctx: CollectorContext): FactObservedEvent[] {
  // OVERLOAD_CONTEXT_ASSEMBLY_ENABLED=false：采集层一并停用，不采集、不写 spool。
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") return [];
  return [
    ...collectTestResults(ctx),
    ...collectCodeState(ctx),
    ...collectExternalState(ctx),
    ...collectObservationEvidence(ctx),
  ];
}

// ========== Fix 3: 持久全局序号 + 原子写入 ==========

/**
 * context_collector_cursor 中的 meta 行：source_event_id='__seq__'，observation_revision=当前 spool 序号。
 * 每次 collectAndSpool / spoolContextEnvelope 在同一 DB 事务内取号并自增，重启不碰撞、多实例不重复。
 * content_hash 列对 meta 行无意义，存空串。
 */
const SEQ_META_KEY = "__seq__";

function allocateSeq(db: Database): number {
  db.run("BEGIN IMMEDIATE");
  try {
    const row = db
      .query("SELECT observation_revision FROM context_collector_cursor WHERE source_event_id=?")
      .get(SEQ_META_KEY) as { observation_revision: number } | undefined;
    const next = (row?.observation_revision ?? 0) + 1;
    db.run(
      `INSERT INTO context_collector_cursor(source_event_id, observation_revision, content_hash, last_collected_at)
       VALUES(?,?,?,?)
       ON CONFLICT(source_event_id) DO UPDATE SET
         observation_revision=excluded.observation_revision,
         last_collected_at=excluded.last_collected_at`,
      [SEQ_META_KEY, next, "", Date.now()],
    );
    db.exec("COMMIT");
    return next;
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw err;
  }
}

/** 测试用：读取当前持久序号（不递增）。 */
export function peekCollectorSeq(db: Database): number {
  const row = db
    .query("SELECT observation_revision FROM context_collector_cursor WHERE source_event_id=?")
    .get(SEQ_META_KEY) as { observation_revision: number } | undefined;
  return row?.observation_revision ?? 0;
}

/**
 * 原子写入一个 seg 文件：
 *   1. 写 active-context-collector.<seq>.ndjson.tmp
 *   2. fsync tmp
 *   3. rename tmp → .ndjson（同目录原子 rename）
 * ingest 只认 .ndjson，.tmp 在写完前不可见。
 */
function writeSegmentAtomic(spoolDir: string, seq: number, lines: string[]): string {
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  const tmpFile = join(spoolDir, `active-context-collector.${seq}.ndjson.tmp`);
  const finalFile = join(spoolDir, `active-context-collector.${seq}.ndjson`);
  writeFileSync(tmpFile, lines.join(""), { mode: 0o600 });
  const fd = openSync(tmpFile, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmpFile, finalFile);
  return finalFile;
}

/**
 * 通用：把一个 envelope 写入 collector spool。供 collectAndSpool 与
 * orchestrator 的 context.pending / recovery_* 事件共用（Fix 5）。
 *
 * envelope: {v:1, at:<ts>, kind:<event_kind>, detail:<payload>}
 * kind 取值：
 *   context.fact_observed     —— collector 事实
 *   context.pending           —— T6 上下文不足
 *   context.recovery_jump     —— T7 活会话 blocked-on-ask 跳转
 *   context.recovery_package  —— T7 终止后 checkpoint 恢复包
 *   context.recovery_reconcile—— T7 活性未知，先对账
 */
export function spoolContextEnvelope(
  db: Database,
  spoolDir: string,
  kind: string,
  detail: Record<string, unknown>,
  at: number = Date.now(),
): string {
  const seq = allocateSeq(db);
  const envelope = { v: 1, at, kind, detail };
  const line = `${JSON.stringify(envelope)}\n`;
  return writeSegmentAtomic(spoolDir, seq, [line]);
}

/**
 * 采集并写入 orchestrator spool 目录（NDJSON，每行一个 envelope）。
 * envelope.kind = 'context.fact_observed'，detail = 16 字段 payload。
 * 每次调用写一个新的 seg 文件 active-context-collector.<seq>.ndjson（写完即密封，
 * collector 不再追加），ingest 扫描目录处理后重命名为 .processed.<ts>。
 *
 * Fix 3: seq 来自 DB 持久 meta 行（重启不碰撞、多实例串行）；
 *        写入走 tmp + fsync + rename，ingest 只见完整 .ndjson。
 */
export function collectAndSpool(
  ctx: CollectorContext,
  spoolDir: string,
): { events: number; spooled: number } {
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") return { events: 0, spooled: 0 };
  const events = collectFacts(ctx);
  if (events.length === 0) return { events: 0, spooled: 0 };
  const seq = allocateSeq(ctx.orchestratorDb);
  const lines = events.map((ev) =>
    `${JSON.stringify({ v: 1, at: Date.now(), kind: "context.fact_observed", detail: ev })}\n`,
  );
  writeSegmentAtomic(spoolDir, seq, lines);
  return { events: events.length, spooled: events.length };
}
