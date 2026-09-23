/**
 * 跨 Execution→Core 的入站事件权威类型定义。
 *
 * 本文件是 shared 层：不依赖 control/* 或 orchestrator/*，只定义纯类型与校验器。
 * Execution 侧（context-collector）与 Core 侧（context-reducer）必须从此处导入，
 * 避免两边各自维护一份隐式重复的 payload 形状。
 *
 * 校验失败抛 Error（不是 ControlError）——shared 层不引入 control 层错误类型。
 */

export type FactSubtype = "code_state" | "test_result" | "external_state" | "observation_evidence";
export type Sensitivity = "unknown" | "clean" | "suspected" | "confirmed_secret";
export type SourceType = "orchestrator" | "extension" | "ingest" | "manual";

/**
 * content_hash 权威定义（Execution collector 与 Core reducer/fetcher 必须共同遵守）。
 *
 *   content_hash = sha256(canonical_source_bytes)
 *
 * canonical_source_bytes 是 fetchOnDemand 将来 full 取源时取回的**同一份源字节**，
 * 即权威源列的原始字符串本身——不是 `{event,at,detail}` 包装 JSON，也不是摘要。
 *
 * 逐源 canonical_source_bytes：
 *   - `orchestrator:task_event:<id>` → orchestrator.db `task_events.detail` 列的原始字符串。
 *   - `journal:<seq>`               → ledger.db `journal.detail` 列的原始字符串。
 *   - `contract:<work_id>@<rev>`     → `control_contract_revisions.contract` 原始字符串。
 *   - `attention:<item_id>@<rev>`    → 该行被 fetch 时 `JSON.stringify(row)` 的字节。
 *   - `artifact:<id>@<ver>`         → 该行被 fetch 时 `JSON.stringify(row)` 的字节。
 *
 * 纪律：
 *   - collector（Execution 侧）必须按本定义计算 content_hash 后再放进 payload；
 *     不得对包装事件 JSON 哈希，否则 full 取源时 hash 校验必然失败。
 *   - Core reducer 只**存储并比较**传入的 content_hash，绝不重新计算；
 *     真相以 collector 上报值为准，Core 不揣测源字节形状。
 *   - on-demand-fetcher 在 full 取源后对取回字节算 sha256，必须等于
 *     version.content_hash；不等即 blocked(needs_context)。这正是本定义的闭环校验。
 */
export interface FactObservedPayload {
  work_id: string;
  problem_id: string | null;
  object_canonical_key: string;
  reference: string;
  source_type: SourceType;
  source_id: string;
  source_identity: string;
  source_event_id: string;
  observation_revision: number;
  attempt: string | null;
  fact_subtype: FactSubtype;
  /** sha256(canonical_source_bytes)，权威源原文哈希，见文件头注释。 */
  content_hash: string;
  sensitivity: Sensitivity;
  collected_at: string; // ISO8601
  expires_at: string | null;
  derived_from: string | null;
}

const FACT_SUBTYPES: ReadonlySet<string> = new Set([
  "code_state",
  "test_result",
  "external_state",
  "observation_evidence",
]);
const SENSITIVITIES: ReadonlySet<string> = new Set([
  "unknown",
  "clean",
  "suspected",
  "confirmed_secret",
]);
const SOURCE_TYPES: ReadonlySet<string> = new Set([
  "orchestrator",
  "extension",
  "ingest",
  "manual",
]);

// 12 个必填字符串字段（problem_id / attempt / expires_at / derived_from 可空）。
const REQUIRED_STRING_FIELDS: ReadonlyArray<keyof FactObservedPayload> = [
  "work_id",
  "object_canonical_key",
  "reference",
  "source_type",
  "source_id",
  "source_identity",
  "source_event_id",
  "fact_subtype",
  "content_hash",
  "sensitivity",
  "collected_at",
];

/**
 * 校验 FactObservedPayload。失败抛 Error（shared 层，不抛 ControlError）。
 */
export function validateFactObservedPayload(payload: unknown): asserts payload is FactObservedPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be an object");
  }
  const p = payload as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    const value = p[field];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`missing required field: ${field}`);
    }
  }
  const revision = p.observation_revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("observation_revision must be a positive integer");
  }
  const factSubtype = p.fact_subtype;
  if (typeof factSubtype !== "string" || !FACT_SUBTYPES.has(factSubtype)) {
    throw new Error(`invalid fact_subtype: ${String(factSubtype)}`);
  }
  const sensitivity = p.sensitivity;
  if (typeof sensitivity !== "string" || !SENSITIVITIES.has(sensitivity)) {
    throw new Error(`invalid sensitivity: ${String(sensitivity)}`);
  }
  const sourceType = p.source_type;
  if (typeof sourceType !== "string" || !SOURCE_TYPES.has(sourceType)) {
    throw new Error(`invalid source_type: ${String(sourceType)}`);
  }
}
