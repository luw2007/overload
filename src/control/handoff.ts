import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { canonicalJson } from "./outbox";
import { ControlError } from "./store";
import type {
  CollaborationBrief, CreateHandoffInput, HandoffAckDecision, HandoffConclusionKind, HandoffReceipt,
  HandoffRequest, HandoffReturn, HandoffState, HandoffTarget,
} from "./handoff-types";

export const HANDOFF_TTL_MS = 7 * 86_400_000;
const MAX_ORIGINAL_MESSAGE = 20_000;
const MAX_TEXT = 20_000;
const ACK_DECISIONS = new Set(["adopt", "defer", "reject", "no_change"]);
const STATES = new Set(["pending", "read", "acknowledged", "concluded", "expired"]);

export function ensureHandoffSchema(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS handoff_requests(
  request_id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('manager_turn','attention_item')), source_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind='session'), target_id TEXT NOT NULL,
  brief TEXT NOT NULL, original_message TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending','read','acknowledged','concluded','expired')),
  created_at INTEGER NOT NULL, read_at INTEGER, acknowledged_at INTEGER,
  ack_decision TEXT CHECK(ack_decision IS NULL OR ack_decision IN ('adopt','defer','reject','no_change')), ack_reason TEXT,
  conclusion_kind TEXT CHECK(conclusion_kind IS NULL OR conclusion_kind IN ('decision','conclusion')), conclusion_text TEXT, concluded_at INTEGER);
CREATE INDEX IF NOT EXISTS handoff_requests_target ON handoff_requests(target_kind,target_id,state);
CREATE TABLE IF NOT EXISTS handoff_returns(
  request_id TEXT PRIMARY KEY, destination_kind TEXT NOT NULL, destination_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued','presented','explicit_unverified')),
  presented_at INTEGER, last_error TEXT);
CREATE INDEX IF NOT EXISTS handoff_returns_destination ON handoff_returns(destination_kind,destination_id,state);`);
}

export function handoffRequestId(input: { source_kind: string; source_id: string; target_kind: string; target_id: string }): string {
  return createHash("sha256").update(`${input.source_kind}|${input.source_id}|${input.target_kind}|${input.target_id}`).digest("hex");
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ControlError("invalid", `${field} is required`);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new ControlError("invalid", `${field} must be a string array`);
  return value;
}

export function parseBrief(value: unknown): CollaborationBrief {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlError("invalid", "brief must be an object");
  const brief = value as Record<string, unknown>;
  if (brief.version !== "collaboration_brief_v0") throw new ControlError("invalid", "brief.version must be collaboration_brief_v0");
  return {
    version: "collaboration_brief_v0",
    purpose: nonEmpty(brief.purpose, "brief.purpose"),
    context: typeof brief.context === "string" ? brief.context : "",
    constraints: stringList(brief.constraints ?? [], "brief.constraints"),
    inputs: stringList(brief.inputs ?? [], "brief.inputs"),
    acceptance: stringList(brief.acceptance ?? [], "brief.acceptance"),
    return_requirement: nonEmpty(brief.return_requirement, "brief.return_requirement"),
  };
}

type Row = Omit<HandoffRequest, "brief"> & { brief: string };
function fromRow(row: Row): HandoffRequest { return { ...row, brief: JSON.parse(row.brief) }; }

export function getHandoff(db: Database, requestId: string): HandoffRequest | null {
  ensureHandoffSchema(db);
  const row = db.query("SELECT * FROM handoff_requests WHERE request_id=?").get(requestId) as Row | null;
  return row ? fromRow(row) : null;
}

function requireHandoff(db: Database, requestId: string): HandoffRequest {
  const row = getHandoff(db, requestId);
  if (!row) throw new ControlError("not_found", `handoff not found: ${requestId}`);
  return row;
}

export function createHandoffRequest(db: Database, input: CreateHandoffInput, now = Date.now()): HandoffReceipt {
  ensureHandoffSchema(db);
  if (input.source_kind !== "manager_turn" && input.source_kind !== "attention_item") throw new ControlError("invalid", "source_kind must be manager_turn or attention_item");
  if (input.target_kind !== "session") throw new ControlError("invalid", "target_kind must be session");
  nonEmpty(input.source_id, "source_id");
  nonEmpty(input.target_id, "target_id");
  const brief = canonicalJson(parseBrief(input.brief));
  const original = input.original_message ?? null;
  if (original !== null && (typeof original !== "string" || original.length > MAX_ORIGINAL_MESSAGE)) throw new ControlError("invalid", `original_message must be a string of at most ${MAX_ORIGINAL_MESSAGE} characters`);
  const requestId = handoffRequestId(input);
  db.transaction(() => {
    const existing = db.query("SELECT brief FROM handoff_requests WHERE request_id=?").get(requestId) as { brief: string } | null;
    if (existing) {
      if (existing.brief !== brief) throw new ControlError("conflict", "handoff_conflict: a different brief already exists for this source and target");
      return;
    }
    db.run("INSERT INTO handoff_requests(request_id,source_kind,source_id,target_kind,target_id,brief,original_message,state,created_at) VALUES(?,?,?,?,?,?,?,'pending',?)",
      [requestId, input.source_kind, input.source_id, input.target_kind, input.target_id, brief, original, now]);
  }).immediate();
  return { request_id: requestId, priority_changed: false, todo_created: false, execution_interrupted: false };
}

/** Requests the receiver has not yet acted on: pending, read, or deferred. */
export function listPendingHandoffs(db: Database, target: HandoffTarget): HandoffRequest[] {
  ensureHandoffSchema(db);
  return (db.query("SELECT * FROM handoff_requests WHERE target_kind=? AND target_id=? AND (state IN ('pending','read') OR (state='acknowledged' AND ack_decision='defer')) ORDER BY created_at, request_id")
    .all(target.target_kind, target.target_id) as Row[]).map(fromRow);
}

export function listHandoffs(db: Database, state?: HandoffState): HandoffRequest[] {
  ensureHandoffSchema(db);
  if (state !== undefined && !STATES.has(state)) throw new ControlError("invalid", `unknown handoff state: ${state}`);
  const rows = state ? db.query("SELECT * FROM handoff_requests WHERE state=? ORDER BY created_at DESC").all(state) : db.query("SELECT * FROM handoff_requests ORDER BY created_at DESC").all();
  return (rows as Row[]).map(fromRow);
}

export function markHandoffRead(db: Database, requestId: string, now = Date.now()): HandoffRequest {
  ensureHandoffSchema(db);
  const row = requireHandoff(db, requestId);
  if (row.state === "expired") throw new ControlError("conflict", "handoff expired");
  if (row.state === "pending") db.run("UPDATE handoff_requests SET state='read', read_at=? WHERE request_id=? AND state='pending'", [now, requestId]);
  return requireHandoff(db, requestId);
}

export function acknowledgeHandoff(db: Database, requestId: string, decision: HandoffAckDecision, reason: string, now = Date.now()): HandoffRequest {
  ensureHandoffSchema(db);
  if (!ACK_DECISIONS.has(decision)) throw new ControlError("invalid", "decision must be adopt|defer|reject|no_change");
  if (typeof reason !== "string" || reason.length > MAX_TEXT) throw new ControlError("invalid", "reason must be a string");
  const row = requireHandoff(db, requestId);
  const open = row.state === "pending" || row.state === "read" || (row.state === "acknowledged" && row.ack_decision === "defer");
  if (!open) throw new ControlError("conflict", `handoff cannot be acknowledged in state ${row.state}${row.ack_decision ? `/${row.ack_decision}` : ""}`);
  db.run("UPDATE handoff_requests SET state='acknowledged', read_at=COALESCE(read_at,?), acknowledged_at=?, ack_decision=?, ack_reason=? WHERE request_id=?", [now, now, decision, reason, requestId]);
  return requireHandoff(db, requestId);
}

function returnDestination(row: HandoffRequest): Pick<HandoffReturn, "destination_kind" | "destination_id"> {
  return row.source_kind === "manager_turn"
    ? { destination_kind: "manager_conversation", destination_id: "owner" }
    : { destination_kind: "attention_item", destination_id: row.source_id };
}

/** One immutable conclusion per request; it is queued to return to the origin. */
export function recordHandoffConclusion(db: Database, requestId: string, kind: HandoffConclusionKind, text: string, now = Date.now()): HandoffRequest {
  ensureHandoffSchema(db);
  if (kind !== "decision" && kind !== "conclusion") throw new ControlError("invalid", "kind must be decision|conclusion");
  nonEmpty(text, "text");
  if (text.length > MAX_TEXT) throw new ControlError("invalid", `text must be at most ${MAX_TEXT} characters`);
  db.transaction(() => {
    const row = requireHandoff(db, requestId);
    if (row.state === "concluded") throw new ControlError("conflict", "handoff already concluded");
    if (row.state === "expired") throw new ControlError("conflict", "handoff expired");
    db.run("UPDATE handoff_requests SET state='concluded', conclusion_kind=?, conclusion_text=?, concluded_at=? WHERE request_id=?", [kind, text, now, requestId]);
    const destination = returnDestination(row);
    db.run("INSERT INTO handoff_returns(request_id,destination_kind,destination_id,state) VALUES(?,?,?,'queued')", [requestId, destination.destination_kind, destination.destination_id]);
  }).immediate();
  return requireHandoff(db, requestId);
}

export function listHandoffReturns(db: Database, destination: { destination_kind: string; destination_id: string }): Array<HandoffReturn & { request: HandoffRequest }> {
  ensureHandoffSchema(db);
  const rows = db.query("SELECT * FROM handoff_returns WHERE destination_kind=? AND destination_id=? ORDER BY rowid").all(destination.destination_kind, destination.destination_id) as HandoffReturn[];
  return rows.map((row) => ({ ...row, request: requireHandoff(db, row.request_id) }));
}

export function markReturnPresented(db: Database, requestId: string, now = Date.now()): HandoffReturn {
  ensureHandoffSchema(db);
  db.run("UPDATE handoff_returns SET state='presented', presented_at=? WHERE request_id=? AND state='queued'", [now, requestId]);
  const row = db.query("SELECT * FROM handoff_returns WHERE request_id=?").get(requestId) as HandoffReturn | null;
  if (!row) throw new ControlError("not_found", `handoff return not found: ${requestId}`);
  return row;
}

/** Expires unconcluded requests older than ttlMs; returns the number expired. */
export function expireStaleHandoffs(db: Database, now = Date.now(), ttlMs = HANDOFF_TTL_MS): number {
  ensureHandoffSchema(db);
  return db.run("UPDATE handoff_requests SET state='expired' WHERE state IN ('pending','read','acknowledged') AND created_at <= ?", [now - ttlMs]).changes;
}
