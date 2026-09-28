import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getObject, getObjectVersion } from "./context-pool";
import type { ContextObject, ObjectVersion } from "./context-pool";
import { checkVisibility } from "./visibility-policy";
import type { VisibilityLevel } from "./visibility-policy";

// ========== 类型 ==========

export type FetchResult =
  | { payload: string; visibility: VisibilityLevel; budget_limited?: boolean; content_hash: string }
  | { blocked: true; reason: string; code: "needs_context" | "forbidden" | "unavailable" | "budget_exceeded" };

export interface FetchBudget {
  max_bytes?: number;
  max_fetch_count?: number;
  deadline_ms?: number;
}

type Purpose = "decision_view" | "agent_task" | "recovery" | "audit";

// ========== 模块级缓存 ==========

interface CacheEntry {
  payload: string;
  content_hash: string;
  fetched_at: number;
}

// 缓存有界：TTL 5 分钟 + LRU 上限 100 条。长驻 web server 下旧原文不得无限常驻内存。
const FETCH_CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_CACHE_MAX_ENTRIES = 100;

const fetchCache = new Map<string, CacheEntry>();
// 预算计数器按装配会话（getContextPackage 一次调用）累计，由 beginFetchSession 在装配开始时重置，
// 不跨请求污染。
let fetchCount = 0;
let fetchCallStart = 0;

export function clearFetchCache(): void {
  fetchCache.clear();
  fetchCount = 0;
  fetchCallStart = 0;
}

/** 标记一次装配开始：重置取数预算计时与计数。由 getContextPackage 入口调用。 */
export function beginFetchSession(): void {
  fetchCount = 0;
  fetchCallStart = 0;
}

/** 读缓存：过期条目视为未命中并淘汰。命中后刷新 LRU 位置。 */
function readCache(key: string, now: number): CacheEntry | undefined {
  const entry = fetchCache.get(key);
  if (!entry) return undefined;
  if (now - entry.fetched_at > FETCH_CACHE_TTL_MS) {
    fetchCache.delete(key);
    return undefined;
  }
  // 刷新 LRU：删除后重写会把条目挪到 Map 末尾（最近使用）。
  fetchCache.delete(key);
  fetchCache.set(key, entry);
  return entry;
}

/** 写缓存：先清过期条目，超 LRU 上限时淘汰最久未用（Map 头部）。 */
function writeCache(key: string, entry: CacheEntry): void {
  for (const [k, v] of fetchCache) {
    if (entry.fetched_at - v.fetched_at > FETCH_CACHE_TTL_MS) fetchCache.delete(k);
    else break; // Map 按插入时间近似有序，过期条目集中在前部。
  }
  fetchCache.delete(key); // 幂等刷新位置
  fetchCache.set(key, entry);
  while (fetchCache.size > FETCH_CACHE_MAX_ENTRIES) {
    const oldest = fetchCache.keys().next().value;
    if (oldest === undefined) break;
    fetchCache.delete(oldest);
  }
}

export function invalidateFetchCache(actor?: string, work_id?: string, purpose?: string): void {
  const hasFilter = actor !== undefined || work_id !== undefined || purpose !== undefined;
  if (!hasFilter) {
    fetchCache.clear();
    return;
  }
  for (const key of fetchCache.keys()) {
    const parts = key.split("\0");
    const keyActor = parts[0] ?? "";
    const keyWork = parts[1] ?? "";
    const keyPurpose = parts[2] ?? "";
    if (
      (actor === undefined || keyActor === actor) &&
      (work_id === undefined || keyWork === work_id) &&
      (purpose === undefined || keyPurpose === purpose)
    ) {
      fetchCache.delete(key);
    }
  }
}

// ========== 源取数 ==========

type SourceBlocked = { blocked: true; reason: string; code: "unavailable" | "forbidden" };

function fetchFromSource(
  db: Database,
  reference: string,
  work_id: string,
): { payload: string } | SourceBlocked {
  // 路径穿越/绝对路径防护：reference 必须是已注册 handle，绝不拼接为文件路径。
  // 拒绝 ".."、NUL、裸绝对路径；未注册 handle 一律走最后的 unknown handle 分支。
  if (
    typeof reference !== "string" ||
    !reference.trim() ||
    reference.includes("\0") ||
    reference.includes("..")
  ) {
    return { blocked: true, reason: "unknown reference handle", code: "unavailable" };
  }
  // work_id 是跨 work 读取绑定的必要参数：缺省一律拒绝，不静默放行。
  if (typeof work_id !== "string" || !work_id.trim()) {
    return { blocked: true, reason: "work_id is required for cross-work source binding", code: "forbidden" };
  }
  // contract:<work_id>@<rev>
  const contractMatch = reference.match(/^contract:([^@]+)@(\d+)$/);
  if (contractMatch) {
    const [, workId, revStr] = contractMatch;
    const row = db
      .query("SELECT contract FROM control_contract_revisions WHERE work_id=? AND revision=?")
      .get(workId, parseInt(revStr, 10)) as { contract: string } | null;
    if (!row) return { blocked: true, reason: "contract revision not found", code: "unavailable" };
    return { payload: row.contract };
  }

  // attention:<item_id>@<rev>
  const attentionMatch = reference.match(/^attention:([^@]+)@(\d+)$/);
  if (attentionMatch) {
    const [, itemId, revStr] = attentionMatch;
    const row = db
      .query("SELECT * FROM control_attention WHERE item_id=? AND revision=?")
      .get(itemId, parseInt(revStr, 10)) as Record<string, unknown> | null;
    if (!row) return { blocked: true, reason: "attention item revision not found", code: "unavailable" };
    return { payload: JSON.stringify(row) };
  }

  // journal:<seq> — 从 ledger.db 只读跨库读取
  const journalMatch = reference.match(/^journal:(\d+)$/);
  if (journalMatch) {
    const [, seqStr] = journalMatch;
    const ledgerPath = process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
    try {
      const ledgerDb = new Database(ledgerPath, { readonly: true });
      try {
        // 跨 work 绑定：journal 表若有 work_id 列则强制校验归属；无该列时无法在
        // 取源层判定（依赖 collector 正确注册 reference 到本 work 的对象），记录偏离。
        const cols = (ledgerDb.query("PRAGMA table_info(journal)").all() as Array<{ name: string }>)
          .map((c) => c.name);
        const hasWorkCol = cols.includes("work_id");
        const sql = hasWorkCol
          ? "SELECT detail FROM journal WHERE ingest_seq=? AND work_id=?"
          : "SELECT detail FROM journal WHERE ingest_seq=?";
        const row = hasWorkCol
          ? ledgerDb.query(sql).get(parseInt(seqStr, 10), work_id) as { detail: string | null } | null
          : ledgerDb.query(sql).get(parseInt(seqStr, 10)) as { detail: string | null } | null;
        if (!row || row.detail == null) {
          return hasWorkCol
            ? { blocked: true, reason: "cross-work: journal entry not bound to this work", code: "forbidden" }
            : { blocked: true, reason: "journal entry not found", code: "unavailable" };
        }
        return { payload: row.detail };
      } finally {
        ledgerDb.close();
      }
    } catch {
      return { blocked: true, reason: "ledger db unavailable", code: "unavailable" };
    }
  }

  // orchestrator:task_event:<id> — 从 orchestrator.db 只读跨库读取
  const orchMatch = reference.match(/^orchestrator:task_event:(\d+)$/);
  if (orchMatch) {
    const [, idStr] = orchMatch;
    const orchPath = process.env.OVERLOAD_ORCHESTRATOR_PATH ?? join(homedir(), ".overload", "orchestrator.db");
    try {
      const orchDb = new Database(orchPath, { readonly: true });
      try {
        // 跨 work 绑定：task_events.task_id → tasks.task_id，必须满足 tasks.work_id = 当前 work。
        // A work 的上下文引用 B work 的 task_event 在此被拦截，不返回正文。
        const row = orchDb.query(
          `SELECT te.detail
           FROM task_events te
           JOIN tasks t ON te.task_id = t.task_id
           WHERE te.id = ? AND t.work_id = ?`,
        ).get(parseInt(idStr, 10), work_id) as { detail: string | null } | null;
        if (!row || row.detail == null) {
          return { blocked: true, reason: "cross-work: task_event not bound to this work", code: "forbidden" };
        }
        return { payload: row.detail };
      } finally {
        orchDb.close();
      }
    } catch {
      return { blocked: true, reason: "orchestrator db unavailable", code: "unavailable" };
    }
  }

  // artifact:<artifact_id>@<version_id> — 从 control DB 同库查 mgmt_artifacts + mgmt_artifact_versions
  const artifactMatch = reference.match(/^artifact:([^@]+)@([^@]+)$/);
  if (artifactMatch) {
    const [, artifactId, versionId] = artifactMatch;
    const row = db.query(
      `SELECT a.artifact_id, a.kind, a.canonical_key, v.version_id, v.content_kind, v.content_sha256, v.snapshot_path, v.snapshot_state, v.sensitivity
       FROM mgmt_artifacts a
       JOIN mgmt_artifact_versions v ON v.artifact_id = a.artifact_id
       WHERE a.artifact_id=? AND v.version_id=? AND a.work_id=?`,
    ).get(artifactId, versionId, work_id) as Record<string, unknown> | null;
    if (!row) return { blocked: true, reason: "cross-work: artifact not bound to this work", code: "forbidden" };
    return { payload: JSON.stringify(row) };
  }

  // 外部 git:<repo>@sha 和 http/https URL — 本阶段不实现
  if (/^git:/.test(reference) || /^https?:\/\//.test(reference)) {
    return { blocked: true, reason: "external source not implemented", code: "unavailable" };
  }

  // 非法 handle — 不接受任意文件路径，不造值
  return { blocked: true, reason: "unknown reference handle", code: "unavailable" };
}

// ========== 主函数 ==========

export function fetchOnDemand(input: {
  reference: string;
  visibility: VisibilityLevel;
  actor: string;
  work_id: string;
  problem_id?: string;
  purpose: Purpose;
  channel?: string;
  target_model?: string;
  budget?: FetchBudget;
  version_pin?: { object_id: string; revision: number };
  db: Database;
}): FetchResult {
  // context.assembly_enabled 开关：设为 "false" 时不取数
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") {
    return { blocked: true, reason: "context assembly disabled", code: "unavailable" };
  }
  const { db, reference, actor, work_id, purpose } = input;

  // 解析 object + version
  let object: ContextObject | null;
  let version: ObjectVersion | null;

  if (input.version_pin) {
    object = getObject(db, input.version_pin.object_id);
    version = object ? getObjectVersion(db, object.object_id, input.version_pin.revision) : null;
  } else {
    const row = db
      .query(
        "SELECT object_id, revision FROM control_context_object_versions WHERE reference=? ORDER BY revision DESC LIMIT 1",
      )
      .get(reference) as { object_id: string; revision: number } | null;
    if (row) {
      object = getObject(db, row.object_id);
      version = object ? getObjectVersion(db, row.object_id, row.revision) : null;
    } else {
      object = null;
      version = null;
    }
  }

  if (!object || !version) {
    return { blocked: true, reason: "context object not found", code: "unavailable" };
  }

  // 权限检查在最前面
  const vis = checkVisibility({
    db,
    actor,
    work_id,
    problem_id: input.problem_id,
    object,
    version,
    purpose,
    channel: input.channel,
    target_model: input.target_model,
    requested_level: input.visibility,
  });

  if (!vis.allowed) {
    return {
      blocked: true,
      reason: vis.reason,
      code: vis.code === "unauthorized" ? "forbidden" : vis.code,
    };
  }

  const effectiveVisibility = vis.visibility;

  // 缓存 key
  const cacheKey = `${actor}\0${work_id}\0${purpose}\0${reference}\0${version.revision}`;

  // 缓存命中（过期条目在此被视为未命中并淘汰）
  const now = Date.now();
  const cached = readCache(cacheKey, now);
  if (cached) {
    return {
      payload: cached.payload,
      visibility: effectiveVisibility,
      content_hash: cached.content_hash,
    };
  }

  // deadline 检查（fetchCallStart 由 beginFetchSession 在装配开始时归零，本会话首次取数时打时间戳）
  if (fetchCallStart === 0) fetchCallStart = now;
  if (input.budget?.deadline_ms !== undefined && now - fetchCallStart > input.budget.deadline_ms) {
    return { blocked: true, reason: "deadline exceeded", code: "budget_exceeded" };
  }

  let payload: string;
  let contentHash = version.content_hash;
  let budgetLimited = false;

  if (effectiveVisibility === "hide") {
    payload = "";
  } else if (effectiveVisibility === "short") {
    payload = version.summary_short ?? "";
  } else if (effectiveVisibility === "long") {
    payload = version.summary_long ?? "";
  } else {
    // full — 从权威源取原文
    if (input.budget?.max_fetch_count !== undefined && fetchCount >= input.budget.max_fetch_count) {
      return { blocked: true, reason: "max fetch count exceeded", code: "budget_exceeded" };
    }

    const sourceResult = fetchFromSource(db, reference, work_id);
    if ("blocked" in sourceResult) {
      return sourceResult;
    }
    payload = sourceResult.payload;
    fetchCount++;

    // content_hash 验证
    const actualHash = createHash("sha256").update(payload).digest("hex");
    if (actualHash !== version.content_hash) {
      return { blocked: true, reason: "content_hash mismatch", code: "needs_context" };
    }
    contentHash = actualHash;
  }

  // max_bytes 预算
  if (input.budget?.max_bytes !== undefined) {
    const byteLen = Buffer.byteLength(payload, "utf8");
    if (byteLen > input.budget.max_bytes) {
      const buf = Buffer.from(payload, "utf8");
      payload = buf.subarray(0, input.budget.max_bytes).toString("utf8");
      budgetLimited = true;
    }
  }

  // 写缓存
  writeCache(cacheKey, { payload, content_hash: contentHash, fetched_at: now });

  const result: FetchResult = {
    payload,
    visibility: effectiveVisibility,
    content_hash: contentHash,
  };
  if (budgetLimited) result.budget_limited = true;
  return result;
}
