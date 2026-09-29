import type { Database } from "bun:sqlite";
import { ControlError, ensureControlSchema, getAttention, getWork, upsertAttention } from "./store";
import { ensureRootProblem, getObject, objectId, linkProblemObject } from "./context-pool";
import {
  externalObservationIdempotencyKey,
  validateExternalObservationInput,
  type ExternalObservationInput,
} from "../shared/external-observation-contract";

export type ExternalObservationState = "unmatched" | "attention_open" | "historical" | "recovered";

export type ExternalObservation = ExternalObservationInput & {
  observation_id: string;
  state: ExternalObservationState;
  attention_item_id: string | null;
  recovered_by: string | null;
  created_at: number;
  updated_at: number;
};

export type IngestExternalObservationResult =
  | { status: "created"; observation: ExternalObservation }
  | { status: "idempotent"; observation: ExternalObservation }
  | { status: "quarantined"; reason: string };

function rowToObservation(row: Record<string, unknown>): ExternalObservation {
  const recovery = row.recovery_of === null ? null : JSON.parse(row.recovery_of as string) as ExternalObservationInput["recovery_of"];
  return {
    observation_id: row.observation_id as string,
    source_id: row.source_id as string,
    source_event_id: row.source_event_id as string,
    observation_revision: row.observation_revision as number,
    work_id: row.work_id as string | null,
    kind: row.kind as ExternalObservationInput["kind"],
    subject: row.subject as string,
    summary: row.summary as string,
    content_hash: row.content_hash as string,
    observed_at: row.observed_at as string,
    urgency: row.urgency as ExternalObservationInput["urgency"],
    deep_link: row.deep_link as string | null,
    recovery_of: recovery,
    state: row.state as ExternalObservationState,
    attention_item_id: row.attention_item_id as string | null,
    recovered_by: row.recovered_by as string | null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

export function ensureExternalObservationSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_external_observations(
    observation_id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    observation_revision INTEGER NOT NULL CHECK(observation_revision >= 1),
    work_id TEXT,
    kind TEXT NOT NULL CHECK(kind IN ('live','historical','recovery')),
    subject TEXT NOT NULL,
    summary TEXT NOT NULL,
    content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
    observed_at TEXT NOT NULL,
    urgency TEXT NOT NULL CHECK(urgency IN ('now','inbox')),
    deep_link TEXT,
    recovery_of TEXT,
    state TEXT NOT NULL CHECK(state IN ('unmatched','attention_open','historical','recovered')),
    attention_item_id TEXT,
    recovered_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(source_id,source_event_id,observation_revision),
    CHECK((kind='recovery' AND recovery_of IS NOT NULL) OR (kind<>'recovery' AND recovery_of IS NULL)),
    CHECK((state='attention_open' AND attention_item_id IS NOT NULL) OR (state<>'attention_open')),
    FOREIGN KEY(work_id) REFERENCES control_works(work_id),
    FOREIGN KEY(attention_item_id) REFERENCES control_attention(item_id)
  );
  CREATE INDEX IF NOT EXISTS control_external_observations_work
    ON control_external_observations(work_id, observed_at DESC, observation_id);
  CREATE INDEX IF NOT EXISTS control_external_observations_unmatched
    ON control_external_observations(state, observed_at, observation_id)
    WHERE state='unmatched';
  CREATE TABLE IF NOT EXISTS control_external_observation_quarantine(
    observation_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(observation_id,content_hash)
  );`);
}

export function getExternalObservation(db: Database, observationId: string): ExternalObservation | null {
  ensureControlSchema(db);
  ensureExternalObservationSchema(db);
  const row = db.query("SELECT * FROM control_external_observations WHERE observation_id=?").get(observationId) as Record<string, unknown> | null;
  return row ? rowToObservation(row) : null;
}

export function listExternalObservations(
  db: Database,
  input: { work_id?: string; state?: ExternalObservationState; limit?: number } = {},
): ExternalObservation[] {
  ensureControlSchema(db);
  ensureExternalObservationSchema(db);
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ControlError("invalid", "limit must be 1..200");
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (input.work_id !== undefined) { clauses.push("work_id=?"); values.push(input.work_id); }
  if (input.state !== undefined) { clauses.push("state=?"); values.push(input.state); }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.query(`SELECT * FROM control_external_observations ${where} ORDER BY observed_at DESC,observation_id DESC LIMIT ?`).all(...values, limit) as Record<string, unknown>[];
  return rows.map(rowToObservation);
}

function attentionItemId(observationId: string): string {
  return `external:${observationId}`;
}

function attentionForObservation(db: Database, input: ExternalObservationInput, observationId: string, now: number): string {
  const work = input.work_id ? getWork(db, input.work_id) : null;
  if (!work || !work.contract) throw new ControlError("not_found", "external observation work with contract not found");
  const itemId = attentionItemId(observationId);
  const existing = getAttention(db, itemId);
  const meta = input.kind === "recovery"
    ? { conclusion: "外部恢复证据需要核对", recommendation: "核对恢复证据后回到原现场确认当前状态。", impact: "恢复链路的当前状态必须由责任人确认。" }
    : { conclusion: "外部观察需要判断是否改变当前工作", recommendation: "查看证据与原现场；仅在其改变决策或恢复路径时处理。", impact: "未核对的外部观察不得自动改变工作、审批或恢复。" };
  upsertAttention(db, {
    item_id: itemId,
    work_id: work.work_id,
    state: "open",
    effect_state: "not_started",
    urgency: input.urgency ?? "inbox",
    conclusion: meta.conclusion,
    trigger: input.subject,
    impact: meta.impact,
    recommendation: meta.recommendation,
    options: ["continue", "narrow", "stop"],
    owner: work.contract.decision_owner,
    expires_at: null,
    source_link: input.deep_link ?? null,
    approval_id: null,
    consumer_owner: null,
    contract_revision: work.revision,
    decision_mode: "human_only",
    evidence: {
      external_observation_id: observationId,
      source_id: input.source_id,
      source_event_id: input.source_event_id,
      observation_revision: input.observation_revision,
      kind: input.kind,
      subject: input.subject,
      summary: input.summary,
      content_hash: input.content_hash,
      observed_at: input.observed_at,
      ...(input.recovery_of ? { recovery_of: input.recovery_of } : {}),
    },
    ...(existing ? { expected_revision: existing.revision } : {}),
  }, now);
  return itemId;
}

export function ingestExternalObservation(
  db: Database,
  input: ExternalObservationInput,
  now = Date.now(),
): IngestExternalObservationResult {
  ensureControlSchema(db);
  ensureExternalObservationSchema(db);
  try { validateExternalObservationInput(input); } catch (error) {
    throw new ControlError("invalid", error instanceof Error ? error.message : "invalid external observation");
  }
  const observationId = externalObservationIdempotencyKey(input.source_id, input.source_event_id, input.observation_revision);
  const tx = db.transaction(() => {
    const existingRow = db.query("SELECT * FROM control_external_observations WHERE observation_id=?").get(observationId) as Record<string, unknown> | null;
    if (existingRow) {
      const existing = rowToObservation(existingRow);
      if (existing.content_hash === input.content_hash) return { status: "idempotent", observation: existing } as IngestExternalObservationResult;
      db.query("INSERT OR IGNORE INTO control_external_observation_quarantine(observation_id,content_hash,reason,created_at) VALUES(?,?,?,?)")
        .run(observationId, input.content_hash, "integrity_error: same idempotency key different content hash", now);
      return { status: "quarantined", reason: "integrity_error: same idempotency key different content hash" } as IngestExternalObservationResult;
    }

    let state: ExternalObservationState = "unmatched";
    let itemId: string | null = null;
    let recoveredBy: string | null = null;
    if (input.work_id) {
      const work = getWork(db, input.work_id);
      if (!work) throw new ControlError("not_found", `external observation work not found: ${input.work_id}`);
      const root = ensureRootProblem(db, work.work_id, now);
      const objectKey = `external-observation:${observationId}`;
      const objectIdForObservation = objectId(work.work_id, "fact", objectKey);
      if (!getObject(db, objectIdForObservation)) {
        db.query(`INSERT INTO control_context_objects(object_id,work_id,primary_problem_id,ctype,fact_subtype,revision,purged_at,tombstone_reason,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run(objectIdForObservation, work.work_id, root.problem_id, "fact", "external_state", 1, null, null, now, now);
        db.query(`INSERT INTO control_context_object_versions(object_id,revision,reference,source_type,sensitivity,shareable,expires_at,staleness_ms,collected_at,derived_from,summary_short,summary_long,content_hash,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          objectIdForObservation, 1, `external-observation:${observationId}`, "extension", "clean", 0, null, null,
          Date.parse(input.observed_at), null, input.summary, null, input.content_hash, now,
        );
        linkProblemObject(db, { problem_id: root.problem_id, object_id: objectIdForObservation, revision: 1, role: "fact" }, now);
      }
      if (input.kind === "historical") state = "historical";
      else {
        itemId = attentionForObservation(db, input, observationId, now);
        state = "attention_open";
      }
    }
    if (input.kind === "recovery") {
      const recovery = input.recovery_of!;
      const originalId = externalObservationIdempotencyKey(recovery.source_id, recovery.source_event_id, recovery.observation_revision);
      const original = db.query("SELECT observation_id FROM control_external_observations WHERE observation_id=?").get(originalId) as { observation_id: string } | null;
      if (!original) throw new ControlError("not_found", "recovery observation source not found");
      recoveredBy = original.observation_id;
    }

    db.query(`INSERT INTO control_external_observations(
      observation_id,source_id,source_event_id,observation_revision,work_id,kind,subject,summary,content_hash,observed_at,urgency,deep_link,recovery_of,state,attention_item_id,recovered_by,created_at,updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      observationId, input.source_id, input.source_event_id, input.observation_revision, input.work_id,
      input.kind, input.subject, input.summary, input.content_hash, input.observed_at, input.urgency ?? "inbox",
      input.deep_link ?? null, input.recovery_of ? JSON.stringify(input.recovery_of) : null, state, itemId, recoveredBy, now, now,
    );
    const observation = getExternalObservation(db, observationId)!;
    return { status: "created", observation } as IngestExternalObservationResult;
  });
  return tx.immediate() as IngestExternalObservationResult;
}
