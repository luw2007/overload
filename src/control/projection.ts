import type { Database } from "bun:sqlite";
import { canonicalJson, controlPayloadHash, verifyControlEventEnvelope, type VerifiedControlOutboxEvent } from "./outbox";
import type { AttentionItem } from "./types";

/** Deterministic refusal of a well-formed-looking control event (invalid snapshot, envelope/snapshot mismatch,
 *  same-revision payload conflict, hash/identity mismatch): retrying can never apply it. */
export class ControlProjectionConflictError extends Error {
  constructor(message: string) { super(message); this.name = "ControlProjectionConflictError"; }
}

function validAttention(value: unknown): value is AttentionItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.item_id === "string" && typeof item.work_id === "string" && Number.isSafeInteger(item.revision)
    && ["open","applying","resolved","superseded"].includes(item.state as string)
    && ["not_started","applying","succeeded","failed","unknown"].includes(item.effect_state as string)
    && (item.effect_detail===null||item.effect_detail===undefined||typeof item.effect_detail==="string");
}

/** Outbox entity identity of one prerequisite edge; shared by the control writer and this projection. */
export function workDependencyEntityId(workId: string, prerequisiteWorkId: string): string {
  return `work_dependency:${JSON.stringify([workId, prerequisiteWorkId])}`;
}

// Ledger-side read projections of control-owned wait/work/edge snapshots (Phase B §7.3).
// Created lazily here so the projection owner keeps its own DDL; rows only move forward by entity version.
// Coverage is "from cutover onward": events applied before these tables existed are deduped by applied_control_events
// and never replayed here, so an older Work/edge has no row until its next revision. No production reader relies on
// completeness; a reader that needs it must fall back to the control DB.
function ensureControlProjectionSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS control_wait_projection(
    wait_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, item_id TEXT NOT NULL, version INTEGER NOT NULL,
    condition_kind TEXT NOT NULL, state TEXT NOT NULL, disposition_state TEXT, wait TEXT NOT NULL,
    event_id TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS control_wait_projection_item ON control_wait_projection(item_id, updated_at DESC, wait_id DESC);
  CREATE INDEX IF NOT EXISTS control_wait_projection_work ON control_wait_projection(work_id, updated_at DESC, wait_id DESC);
  CREATE TABLE IF NOT EXISTS control_work_projection(
    work_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state TEXT NOT NULL, work TEXT NOT NULL,
    event_id TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS control_work_dependency_projection(
    work_id TEXT NOT NULL, prerequisite_work_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
    edge TEXT NOT NULL, event_id TEXT NOT NULL,
    PRIMARY KEY(work_id, prerequisite_work_id)
  );`);
}

const WAIT_STATES = ["watching", "ready", "unavailable", "expired", "cancelled"];
const WAIT_DISPOSITION_STATES = ["pending", "redecision_recorded", "dispatching", "dispatched", "effect_succeeded", "effect_failed", "effect_unknown"];
const WAIT_CONDITION_KINDS = ["github_pr_merged", "check_new_result", "work_completed"];
// Same-revision precedence for Work snapshots: promoteWork publishes contract.revised (candidate) and work.promoted (active) at one revision.
const WORK_STATE_RANK: Record<string, number> = { candidate: 0, active: 1, stopped: 2, completed: 2 };

function snapshot(value: unknown, eventId: string, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlProjectionConflictError(`invalid ${name} snapshot: ${eventId}`);
  return value as Record<string, unknown>;
}
function positive(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

function projectWait(db: Database, event: VerifiedControlOutboxEvent): void {
  const wait = snapshot(event.payload.wait, event.event_id, "wait");
  const condition = wait.condition as Record<string, unknown> | null;
  if (!text(wait.wait_id) || !text(wait.work_id) || !text(wait.item_id) || !positive(wait.version) || !text(wait.state)
    || !WAIT_STATES.includes(wait.state) || !(wait.disposition_state === null || WAIT_DISPOSITION_STATES.includes(wait.disposition_state as string))
    || !condition || typeof condition !== "object" || !WAIT_CONDITION_KINDS.includes(condition.kind as string) || typeof wait.updated_at !== "number") {
    throw new ControlProjectionConflictError(`invalid wait snapshot: ${event.event_id}`);
  }
  if (!event.kind.startsWith("wait.") || event.entity_id !== wait.wait_id || event.entity_version !== wait.version
    || event.work_id !== wait.work_id || event.item_id !== wait.item_id) throw new ControlProjectionConflictError(`wait envelope does not match its snapshot: ${event.event_id}`);
  const current = db.query("SELECT version,wait FROM control_wait_projection WHERE wait_id=?").get(wait.wait_id) as { version: number; wait: string } | null;
  const serialized = canonicalJson(wait);
  if (current && wait.version < current.version) return; // late delivery: applied, never rolled back
  if (current && wait.version === current.version) {
    // One version may be published under several kinds (e.g. disposition_blocked + disposition_redecision) with one payload.
    if (current.wait !== serialized) throw new ControlProjectionConflictError(`wait version payload mismatch: ${wait.wait_id}@${wait.version}`);
    return;
  }
  db.query(`INSERT INTO control_wait_projection(wait_id,work_id,item_id,version,condition_kind,state,disposition_state,wait,event_id,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(wait_id) DO UPDATE SET work_id=excluded.work_id,item_id=excluded.item_id,version=excluded.version,
    condition_kind=excluded.condition_kind,state=excluded.state,disposition_state=excluded.disposition_state,wait=excluded.wait,
    event_id=excluded.event_id,updated_at=excluded.updated_at`)
    .run(wait.wait_id, wait.work_id, wait.item_id, wait.version, condition.kind as string, wait.state, wait.disposition_state as string | null, serialized, event.event_id, wait.updated_at);
}

function projectWork(db: Database, event: VerifiedControlOutboxEvent): void {
  const work = snapshot(event.payload.work, event.event_id, "work");
  if (!text(work.work_id) || !positive(work.revision) || !text(work.state) || !(work.state in WORK_STATE_RANK) || typeof work.updated_at !== "number") {
    throw new ControlProjectionConflictError(`invalid work snapshot: ${event.event_id}`);
  }
  if (event.entity_id !== work.work_id || event.entity_version !== work.revision || event.work_id !== work.work_id || event.item_id !== null) {
    throw new ControlProjectionConflictError(`work envelope does not match its snapshot: ${event.event_id}`);
  }
  const current = db.query("SELECT revision,state,work FROM control_work_projection WHERE work_id=?").get(work.work_id) as { revision: number; state: string; work: string } | null;
  const serialized = canonicalJson(work);
  if (current && work.revision < current.revision) return;
  if (current && work.revision === current.revision) {
    if (current.work === serialized || WORK_STATE_RANK[work.state]! < WORK_STATE_RANK[current.state]!) return;
    if (WORK_STATE_RANK[work.state] === WORK_STATE_RANK[current.state]) throw new ControlProjectionConflictError(`work revision payload mismatch: ${work.work_id}@${work.revision}`);
  }
  db.query(`INSERT INTO control_work_projection(work_id,revision,state,work,event_id,updated_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(work_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,work=excluded.work,event_id=excluded.event_id,updated_at=excluded.updated_at`)
    .run(work.work_id, work.revision, work.state, serialized, event.event_id, work.updated_at);
}

function projectDependency(db: Database, event: VerifiedControlOutboxEvent): void {
  const edge = snapshot(event.payload.edge, event.event_id, "dependency");
  if (!text(edge.work_id) || !text(edge.prerequisite_work_id) || !positive(edge.revision) || (edge.state !== "active" && edge.state !== "revoked")) {
    throw new ControlProjectionConflictError(`invalid dependency snapshot: ${event.event_id}`);
  }
  const expectedKind = edge.state === "active" ? "work.dependency_created" : "work.dependency_revoked";
  if (event.kind !== expectedKind || event.entity_id !== workDependencyEntityId(edge.work_id, edge.prerequisite_work_id)
    || event.entity_version !== edge.revision || event.work_id !== edge.work_id || event.item_id !== null) {
    throw new ControlProjectionConflictError(`dependency envelope does not match its snapshot: ${event.event_id}`);
  }
  const current = db.query("SELECT revision,edge FROM control_work_dependency_projection WHERE work_id=? AND prerequisite_work_id=?")
    .get(edge.work_id, edge.prerequisite_work_id) as { revision: number; edge: string } | null;
  const serialized = canonicalJson(edge);
  if (current && edge.revision < current.revision) return;
  if (current && edge.revision === current.revision) {
    if (current.edge !== serialized) throw new ControlProjectionConflictError(`dependency revision payload mismatch: ${event.entity_id}@${edge.revision}`);
    return;
  }
  db.query(`INSERT INTO control_work_dependency_projection(work_id,prerequisite_work_id,revision,state,edge,event_id) VALUES (?,?,?,?,?,?)
    ON CONFLICT(work_id,prerequisite_work_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,edge=excluded.edge,event_id=excluded.event_id`)
    .run(edge.work_id, edge.prerequisite_work_id, edge.revision, edge.state, serialized, event.event_id);
}

export function applyControlEvent(db: Database, detail: Record<string, unknown>, at: number): void {
  const eventId = detail.event_id;
  const suppliedHash = detail.payload_hash;
  const payload = detail.payload;
  if (typeof eventId !== "string" || !eventId || typeof suppliedHash !== "string" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ControlProjectionConflictError("invalid control event");
  }
  const actualHash = controlPayloadHash(payload as Record<string, unknown>);
  if (actualHash !== suppliedHash) throw new ControlProjectionConflictError(`control event payload hash mismatch: ${eventId}`);
  const existing = db.query("SELECT payload_hash FROM applied_control_events WHERE event_id=?").get(eventId) as { payload_hash: string } | null;
  if (existing) {
    if (existing.payload_hash !== suppliedHash) throw new ControlProjectionConflictError(`control event identity mismatch: ${eventId}`);
    return;
  }
  const payloadRow = payload as Record<string, unknown>;
  const kind = typeof detail.event_kind === "string" ? detail.event_kind : "";
  // Wait/work/edge snapshots are control-owned: verify the full envelope identity with the shared verifier before projecting.
  if ("wait" in payloadRow || "work" in payloadRow || "edge" in payloadRow || kind.startsWith("wait.") || kind.startsWith("work.")) {
    const event = verifyControlEventEnvelope(detail);
    ensureControlProjectionSchema(db);
    if ("wait" in payloadRow || kind.startsWith("wait.")) projectWait(db, event);
    else if ("edge" in payloadRow || kind.startsWith("work.dependency_")) projectDependency(db, event);
    else projectWork(db, event);
  }
  if (detail.event_kind === "attention.feedback") {
    if (typeof payloadRow.item_id !== "string" || !Number.isSafeInteger(payloadRow.revision) || typeof payloadRow.useful !== "boolean") throw new ControlProjectionConflictError(`invalid attention feedback: ${eventId}`);
    db.query("INSERT INTO control_attention_feedback(event_id,item_id,revision,useful,reason,created_at) VALUES (?,?,?,?,?,?)").run(eventId,payloadRow.item_id,payloadRow.revision,payloadRow.useful?1:0,typeof payloadRow.reason==="string"?payloadRow.reason:null,at);
  }
  const item = payloadRow.attention;
  if (item !== undefined) {
    if (!validAttention(item)) throw new ControlProjectionConflictError(`invalid attention snapshot: ${eventId}`);
    const current = db.query("SELECT revision,event_id FROM control_attention WHERE item_id=?").get(item.item_id) as { revision:number;event_id:string }|null;
    if (current && item.revision < current.revision) {
      // Valid late delivery: mark business event applied without rolling projection back.
    } else if (!current || item.revision > current.revision) {
      db.query(`INSERT INTO control_attention(item_id,work_id,revision,state,effect_state,effect_detail,urgency,owner,conclusion,trigger,impact,recommendation,options,expires_at,defer_until,acknowledged_at,source_link,approval_id,consumer_owner,contract_revision,decision_mode,evidence,event_id,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(item_id) DO UPDATE SET work_id=excluded.work_id,revision=excluded.revision,state=excluded.state,effect_state=excluded.effect_state,effect_detail=excluded.effect_detail,urgency=excluded.urgency,owner=excluded.owner,conclusion=excluded.conclusion,trigger=excluded.trigger,impact=excluded.impact,recommendation=excluded.recommendation,options=excluded.options,expires_at=excluded.expires_at,defer_until=excluded.defer_until,acknowledged_at=excluded.acknowledged_at,source_link=excluded.source_link,approval_id=excluded.approval_id,consumer_owner=excluded.consumer_owner,contract_revision=excluded.contract_revision,decision_mode=excluded.decision_mode,evidence=excluded.evidence,event_id=excluded.event_id,updated_at=excluded.updated_at`)
        .run(item.item_id,item.work_id,item.revision,item.state,item.effect_state,item.effect_detail??null,item.urgency,item.owner,item.conclusion,item.trigger,item.impact,item.recommendation,JSON.stringify(item.options),item.expires_at,item.defer_until,item.acknowledged_at,item.source_link,item.approval_id,item.consumer_owner,item.contract_revision,item.decision_mode,JSON.stringify(item.evidence),eventId,item.updated_at);
    } else if (current && item.revision === current.revision && current.event_id !== eventId) {
      const projected = db.query("SELECT work_id,state,effect_state,effect_detail,urgency,owner,conclusion,trigger,impact,recommendation,options,expires_at,defer_until,acknowledged_at,source_link,approval_id,consumer_owner,contract_revision,decision_mode,evidence,updated_at FROM control_attention WHERE item_id=?").get(item.item_id) as Record<string,unknown>;
      const comparable = {...item, created_at: undefined, item_id: undefined, revision: undefined};
      let existingComparable: Record<string, unknown>;
      // A projected row that no longer parses means local projection corruption, not a bad event:
      // say so instead of surfacing a bare SyntaxError from the ingest loop.
      try { existingComparable = {...projected,options:JSON.parse(projected.options as string),evidence:JSON.parse(projected.evidence as string)}; }
      catch { throw new Error(`corrupt attention projection: ${item.item_id}@${item.revision}`); }
      delete comparable.created_at; delete comparable.item_id; delete comparable.revision;
      if (canonicalJson(comparable) !== canonicalJson(existingComparable)) throw new ControlProjectionConflictError(`attention revision payload mismatch: ${item.item_id}@${item.revision}`);
    }
  }
  db.query("INSERT INTO applied_control_events(event_id,payload_hash,applied_at) VALUES (?,?,?)").run(eventId,suppliedHash,at);
}
