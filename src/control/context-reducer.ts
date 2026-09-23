import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ControlError, ensureControlSchema } from "./store";
import { enqueueControlEvent } from "./outbox";
import { getObject, getProblem, linkProblemObject, objectId } from "./context-pool";
import {
  validateFactObservedPayload,
  type FactObservedPayload,
  type FactSubtype,
  type Sensitivity,
} from "../shared/context-contract";

export type { FactObservedPayload, FactSubtype, Sensitivity } from "../shared/context-contract";

export type IngestResult =
  | { status: "created"; object_id: string; revision: number }
  | { status: "idempotent"; object_id: string; revision: number }
  | { status: "quarantined"; reason: string };

// idempotency_key = sha256(source_type + source_id + source_event_id + observation_revision)
// 不含 fact_subtype，不含 content_hash。
export function factIdempotencyKey(
  source_type: string,
  source_id: string,
  source_event_id: string,
  observation_revision: number,
): string {
  return createHash("sha256")
    .update(source_type + source_id + source_event_id + observation_revision)
    .digest("hex");
}

export function ensureContextReducerSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_context_fact_dedup(
    idempotency_key TEXT PRIMARY KEY,
    object_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS control_context_fact_quarantine(
    idempotency_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (idempotency_key, content_hash)
  );`);
  // 乱序防护：dedup 表冗余记录源三元组 + observation_revision，用于对同一
  // (source_type, source_id, source_event_id) 维护已摄入的最大 observation_revision。
  // 旧库幂等 ALTER 补列（SQLite 不支持 ADD COLUMN IF NOT EXISTS，按 table_info 探测）。
  const cols = (db.query("PRAGMA table_info(control_context_fact_dedup)").all() as Array<{ name: string }>)
    .map((c) => c.name);
  if (!cols.includes("source_type")) db.exec("ALTER TABLE control_context_fact_dedup ADD COLUMN source_type TEXT");
  if (!cols.includes("source_id")) db.exec("ALTER TABLE control_context_fact_dedup ADD COLUMN source_id TEXT");
  if (!cols.includes("source_event_id")) db.exec("ALTER TABLE control_context_fact_dedup ADD COLUMN source_event_id TEXT");
  if (!cols.includes("observation_revision")) db.exec("ALTER TABLE control_context_fact_dedup ADD COLUMN observation_revision INTEGER");
  db.exec("CREATE INDEX IF NOT EXISTS idx_context_fact_dedup_source ON control_context_fact_dedup(source_type, source_id, source_event_id, observation_revision)");
}

export function getQuarantinedEvents(
  db: Database,
): Array<{ idempotency_key: string; content_hash: string; created_at: number }> {
  ensureContextReducerSchema(db);
  return db.query(
    "SELECT idempotency_key, content_hash, created_at FROM control_context_fact_quarantine ORDER BY created_at, idempotency_key",
  ).all() as Array<{ idempotency_key: string; content_hash: string; created_at: number }>;
}

function validatePayload(payload: FactObservedPayload): void {
  // shared 层校验抛 Error；reducer 包装为 ControlError('invalid') 保持调用方错误语义一致。
  try {
    validateFactObservedPayload(payload);
  } catch (err) {
    throw new ControlError("invalid", err instanceof Error ? err.message : "invalid payload");
  }
}

function assertAuthorizedForSecret(db: Database, work_id: string, actor?: string): void {
  if (!actor || !actor.trim()) {
    throw new ControlError("blocked", "confirmed_secret requires authorization");
  }
  const row = db.query("SELECT contract FROM control_works WHERE work_id=?").get(work_id) as
    | { contract: string | null }
    | null;
  if (!row || !row.contract) throw new ControlError("blocked", "confirmed_secret requires authorization");
  try {
    const contract = JSON.parse(row.contract) as { decision_owner?: string };
    if (typeof contract.decision_owner === "string" && contract.decision_owner === actor) return;
  } catch {
    /* fall through to share check */
  }
  const share = db.query("SELECT 1 FROM control_context_shares WHERE granted_by=? AND shared_with_work=?")
    .get(actor, work_id);
  if (!share) throw new ControlError("blocked", "confirmed_secret requires authorization");
}

type DedupRow = { object_id: string; revision: number; content_hash: string };

export function ingestFactObserved(
  db: Database,
  payload: FactObservedPayload,
  opts: { actor?: string; purpose?: string } = {},
): IngestResult {
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  // context.assembly_enabled 开关：设为 "false" 时不写新表（保留已有数据）
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") {
    return { status: "quarantined", reason: "context assembly disabled" } as IngestResult;
  }
  validatePayload(payload);

  const idemKey = factIdempotencyKey(
    payload.source_type,
    payload.source_id,
    payload.source_event_id,
    payload.observation_revision,
  );

  // 快速路径：已处理过的同 key 直接返回，不进事务。
  const existing = db
    .query("SELECT object_id, revision, content_hash FROM control_context_fact_dedup WHERE idempotency_key=?")
    .get(idemKey) as DedupRow | null;

  if (existing) {
    if (existing.content_hash === payload.content_hash) {
      return { status: "idempotent", object_id: existing.object_id, revision: existing.revision };
    }
    db.query(
      "INSERT OR IGNORE INTO control_context_fact_quarantine(idempotency_key, content_hash, created_at) VALUES (?,?,?)",
    ).run(idemKey, payload.content_hash, Date.now());
    return { status: "quarantined", reason: "integrity_error: same idempotency_key different content_hash" };
  }

  if (payload.sensitivity === "confirmed_secret") {
    assertAuthorizedForSecret(db, payload.work_id, opts.actor);
  }

  const object_id = objectId(payload.work_id, "fact", payload.object_canonical_key);
  const now = Date.now();

  const tx = db.transaction(() => {
    // 事务内二次检查，防并发竞态。
    const inside = db
      .query("SELECT object_id, revision, content_hash FROM control_context_fact_dedup WHERE idempotency_key=?")
      .get(idemKey) as DedupRow | null;
    if (inside) {
      if (inside.content_hash === payload.content_hash) {
        return { status: "idempotent", object_id: inside.object_id, revision: inside.revision } as IngestResult;
      }
      db.query(
        "INSERT OR IGNORE INTO control_context_fact_quarantine(idempotency_key, content_hash, created_at) VALUES (?,?,?)",
      ).run(idemKey, payload.content_hash, now);
      return {
        status: "quarantined",
        reason: "integrity_error: same idempotency_key different content_hash",
      } as IngestResult;
    }

    // 乱序防护：同一 (source_type, source_id, source_event_id) 已摄入的最大
    // observation_revision。旧于最大值的迟到观测一律 quarantine，不覆盖已有对象；
    // OrThrow 版本据此抛 conflict。等于最大值的精确重放已由上方 idemKey 命中处理。
    const maxRow = db.query(
      "SELECT MAX(observation_revision) AS max_rev FROM control_context_fact_dedup WHERE source_type=? AND source_id=? AND source_event_id=?",
    ).get(payload.source_type, payload.source_id, payload.source_event_id) as { max_rev: number | null };
    const maxRev = maxRow && typeof maxRow.max_rev === "number" ? maxRow.max_rev : null;
    if (maxRev !== null && payload.observation_revision < maxRev) {
      db.query(
        "INSERT OR IGNORE INTO control_context_fact_quarantine(idempotency_key, content_hash, created_at) VALUES (?,?,?)",
      ).run(idemKey, payload.content_hash, now);
      return {
        status: "quarantined",
        reason: `out_of_order_observation_revision: got ${payload.observation_revision}, already ingested max ${maxRev}`,
      } as IngestResult;
    }

    // 跨 work problem 校验（事务内读，保证一致性）。
    if (payload.problem_id) {
      const problem = getProblem(db, payload.problem_id);
      if (!problem) throw new ControlError("invalid", "problem not found");
      if (problem.work_id !== payload.work_id) {
        throw new ControlError("conflict", "cross-work problem reference");
      }
    }

    const collectedAt = Date.parse(payload.collected_at);
    if (Number.isNaN(collectedAt)) throw new ControlError("invalid", "invalid collected_at ISO8601");
    const expiresAt = payload.expires_at ? Date.parse(payload.expires_at) : null;
    if (expiresAt !== null && Number.isNaN(expiresAt)) throw new ControlError("invalid", "invalid expires_at ISO8601");

    const existingObj = getObject(db, object_id);
    const revision = existingObj ? existingObj.revision + 1 : 1;
    const summaryShort = `fact:${payload.fact_subtype} from ${payload.source_type}:${payload.source_id}`;

    if (existingObj) {
      db.query("UPDATE control_context_objects SET revision=?, updated_at=? WHERE object_id=?")
        .run(revision, now, object_id);
    } else {
      db.query(
        `INSERT INTO control_context_objects(object_id,work_id,primary_problem_id,ctype,fact_subtype,revision,purged_at,tombstone_reason,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ).run(object_id, payload.work_id, payload.problem_id ?? null, "fact", payload.fact_subtype, 1, null, null, now, now);
    }

    db.query(
      `INSERT INTO control_context_object_versions(object_id,revision,reference,source_type,sensitivity,shareable,expires_at,staleness_ms,collected_at,derived_from,summary_short,summary_long,content_hash,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      object_id,
      revision,
      payload.reference,
      payload.source_type,
      payload.sensitivity,
      0, // fact 默认不可共享
      expiresAt,
      null,
      collectedAt,
      payload.derived_from,
      summaryShort,
      null, // summary_long 由 assembler 按需生成
      payload.content_hash,
      now,
    );

    if (payload.problem_id) {
      linkProblemObject(db, { problem_id: payload.problem_id, object_id, revision, role: "fact" }, now);
    }

    db.query(
      "INSERT INTO control_context_fact_dedup(idempotency_key, object_id, revision, content_hash, created_at, source_type, source_id, source_event_id, observation_revision) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(idemKey, object_id, revision, payload.content_hash, now, payload.source_type, payload.source_id, payload.source_event_id, payload.observation_revision);

    enqueueControlEvent(db, {
      entity_id: object_id,
      entity_version: revision,
      kind: "context.updated",
      work_id: payload.work_id,
      payload: {
        object_id,
        revision,
        fact_subtype: payload.fact_subtype,
        content_hash: payload.content_hash,
      },
    }, now);

    return { status: "created", object_id, revision } as IngestResult;
  });

  return tx.immediate() as IngestResult;
}


/**
 * ingestFactObserved 的 OrThrow 版本：冲突（quarantined）直接抛 ControlError('conflict')，
 * 供 HTTP 端点和 spool 摄入器使用，确保冲突输入不会被当成成功消费。
 * created / idempotent 正常返回。
 */
export function ingestFactObservedOrThrow(
  db: Database,
  payload: FactObservedPayload,
  opts: { actor?: string; purpose?: string; now?: number } = {},
): Extract<IngestResult, { status: "created" | "idempotent" }> {
  const result = ingestFactObserved(db, payload, opts);
  if (result.status === "quarantined") {
    throw new ControlError("conflict", result.reason);
  }
  return result;
}
