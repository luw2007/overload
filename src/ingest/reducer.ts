import { Database } from "bun:sqlite";
import { CLASSIFIER_VERSION, classify, queueAfter, type ClassifiableCurrent, type ClassifierEvent } from "./classifier";

const SOURCE_TERMINALS = new Set(["resolved", "cancelled", "timed_out"]);
const SESSION_TERMINALS = new Set(["done", "failed", "vanished"]);
const RECON_EVENTS = new Set(["emitter_dead", "emitter_drained", "emitter_stalled", "telemetry_gap", "session_vanished"]);

type JournalRow = { ingest_seq: number; at: number; stable_id: string; writer_id: string; emitter_id: string; kind: string; detail: string | null };
type RequestRow = { state: string };
type CurrentRow = ClassifiableCurrent & { writer_id: string | null; last_ingest_seq: number | null; last_event_at: number | null; last_heartbeat_at: number | null; frozen: number };

function objectDetail(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { return {}; }
}
function stringDetail(detail: Record<string, unknown>, key: string): string | undefined {
  return typeof detail[key] === "string" && (detail[key] as string).length > 0 ? detail[key] as string : undefined;
}
function requestId(detail: Record<string, unknown>): string | undefined { return stringDetail(detail, "request_id"); }
function terminalState(detail: Record<string, unknown>): string {
  const candidate = detail.state ?? detail.outcome;
  if (typeof candidate === "string" && SOURCE_TERMINALS.has(candidate)) return candidate;
  return detail.error === true ? "cancelled" : "resolved";
}
function targetStableId(row: JournalRow, detail: Record<string, unknown>): string {
  return stringDetail(detail, "stable_id") ?? row.stable_id;
}
function platformFor(stableId: string): string { return stableId.split(":")[1] ?? "unknown"; }
function isIncidentOpen(db: Database, source: string): boolean {
  return db.query("SELECT 1 FROM incidents WHERE source=? AND closed_at IS NULL LIMIT 1").get(source) != null;
}
function ensureCurrent(db: Database, stableId: string, writerId: string, row: JournalRow): CurrentRow {
  const session = db.query("SELECT origin FROM sessions WHERE stable_id=?").get(stableId) as { origin: string | null } | null;
  db.query(`INSERT OR IGNORE INTO current(stable_id, writer_id, state, origin, last_ingest_seq, last_event_at)
    VALUES (?, ?, 'idle', ?, ?, ?)`).run(stableId, writerId, session?.origin ?? "unknown", row.ingest_seq, row.at);
  return db.query("SELECT * FROM current WHERE stable_id=?").get(stableId) as CurrentRow;
}

export function reduceJournal(db: Database, batchSize = 500): number {
  let processed = 0;
  const transaction = db.transaction(() => {
    db.query("INSERT OR IGNORE INTO reducer_cursor(id, journal_seq) VALUES (1, 0)").run();
    const cursor = (db.query("SELECT journal_seq FROM reducer_cursor WHERE id=1").get() as { journal_seq: number }).journal_seq;
    const rows = db.query(`SELECT ingest_seq, at, stable_id, writer_id, emitter_id, kind, detail
      FROM journal WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`).all(cursor, batchSize) as JournalRow[];
    for (const row of rows) applyEvent(db, row);
    if (rows.length) db.query("UPDATE reducer_cursor SET journal_seq=? WHERE id=1").run(rows.at(-1)!.ingest_seq);
    processed = rows.length;
  });
  transaction.immediate();
  return processed;
}

function applyEvent(db: Database, row: JournalRow): void {
  const detail = objectDetail(row.detail);
  if (row.kind === "classifier_activated") {
    const version = typeof detail.version === "number" ? detail.version : CLASSIFIER_VERSION;
    db.query("INSERT OR IGNORE INTO classifier_activations(version, activated_at_journal_seq, activated_at) VALUES (?, ?, ?)").run(version, row.ingest_seq, row.at);
    return;
  }
  if (row.kind === "source_outage" || row.kind === "source_recovered") { applyIncident(db, row, detail); return; }
  if (row.kind === "attachment_observed") applyAttachment(db, row, detail);
  applyRequestEvent(db, row, detail);
  applySessionEvent(db, row, detail);
}

function applyIncident(db: Database, row: JournalRow, detail: Record<string, unknown>): void {
  const source = stringDetail(detail, "source");
  if (!source) return;
  if (row.kind === "source_outage") {
    if (!isIncidentOpen(db, source)) db.query("INSERT OR IGNORE INTO incidents(source, opened_at, detail) VALUES (?, ?, ?)").run(source, row.at, row.detail);
    db.query(`UPDATE current SET frozen=1 WHERE stable_id LIKE ? OR stable_id IN
      (SELECT stable_id FROM attachments WHERE platform=? AND valid=1)`).run(`%:${source}:%`, source);
  } else {
    db.query("UPDATE incidents SET closed_at=? WHERE source=? AND closed_at IS NULL").run(row.at, source);
    db.query(`UPDATE current SET frozen=0 WHERE stable_id LIKE ? OR stable_id IN
      (SELECT stable_id FROM attachments WHERE platform=? AND valid=1)`).run(`%:${source}:%`, source);
  }
}

function applyAttachment(db: Database, row: JournalRow, detail: Record<string, unknown>): void {
  const stableId = targetStableId(row, detail), platform = stringDetail(detail, "platform"), binding = stringDetail(detail, "binding");
  if (!platform || !binding) return;
  db.query(`INSERT INTO attachments(stable_id, platform, binding, observed_at, valid) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(stable_id, platform) DO UPDATE SET binding=excluded.binding, observed_at=excluded.observed_at, valid=1`)
    .run(stableId, platform, binding, row.at);
  db.query("UPDATE sessions SET origin=CASE WHEN origin='unknown' AND ?='orca' THEN 'agent' ELSE origin END WHERE stable_id=?").run(platform, stableId);
  db.query("UPDATE current SET origin=CASE WHEN origin='unknown' AND ?='orca' THEN 'agent' ELSE origin END WHERE stable_id=?").run(platform, stableId);
}

function applySessionEvent(db: Database, row: JournalRow, detail: Record<string, unknown>): void {
  const relevant = new Set(["session_started", "working", "settled", "decision_requested", "session_ended", "session_vanished", "emitter_dead", "emitter_drained", "emitter_stalled", "telemetry_gap", "heartbeat", "tool_activity"]);
  if (!relevant.has(row.kind)) return;
  // A platform process without an attributable session is health evidence only;
  // never create a synthetic overload-admin current row for it.
  if (row.kind === "telemetry_gap" && !stringDetail(detail, "stable_id")) return;
  const stableId = targetStableId(row, detail);
  if (RECON_EVENTS.has(row.kind) && isIncidentOpen(db, stringDetail(detail, "platform") ?? platformFor(stableId))) return;
  const current = ensureCurrent(db, stableId, row.writer_id, row);
  // Re-reduction retains derived tables. A row already reflected by this
  // subject must not classify against its later state and invent transitions.
  if (current.last_ingest_seq != null && row.ingest_seq <= current.last_ingest_seq) return;
  const newerWriter = current.writer_id !== row.writer_id && row.kind === "session_started";
  if (current.writer_id !== row.writer_id && !newerWriter) return;
  if (SESSION_TERMINALS.has(current.state) && !newerWriter) return;

  let state = newerWriter ? "idle" : current.state;
  let origin = current.origin;
  if (row.kind === "session_started") origin = stringDetail(detail, "parent") ?? stringDetail(detail, "origin") ?? origin;
  if (row.kind === "working") state = "working";
  else if (row.kind === "settled") state = "idle";
  else if (row.kind === "decision_requested") state = "awaiting_human";
  else if (row.kind === "session_ended") state = "done";
  else if (row.kind === "session_vanished") state = "vanished";

  const view = { ...current, stable_id: stableId, state, origin };
  const classifierEvent: ClassifierEvent = { ingest_seq: row.ingest_seq, at: row.at, kind: row.kind, detail };
  for (const transition of classify(current, classifierEvent)) {
    db.query(`INSERT OR IGNORE INTO queue_transitions(subject, queue, direction, at, source_seq, classifier_version)
      VALUES (?, ?, ?, ?, ?, ?)`).run(transition.subject, transition.queue, transition.direction, transition.at, transition.source_seq, transition.classifier_version);
  }
  const queue = queueAfter(view, classifierEvent);
  const heartbeat = row.kind === "heartbeat" || row.kind === "tool_activity" || row.kind === "working" ? row.at : current.last_heartbeat_at;
  db.query(`UPDATE current SET writer_id=?, state=?, queue=?, q5_reason=?, origin=?, last_ingest_seq=?,
    last_event_at=?, last_heartbeat_at=? WHERE stable_id=?`).run(row.writer_id, state, queue.queue, queue.q5_reason, origin, row.ingest_seq, row.at, heartbeat, stableId);
}

function applyRequestEvent(db: Database, row: JournalRow, detail: Record<string, unknown>): void {
  if (row.kind === "emitter_drained") { orphanDrainedEmitter(db, row, detail); return; }
  if (row.kind === "session_ended") {
    db.query("UPDATE requests SET state='orphaned', resolved_at=? WHERE stable_id=? AND writer_id=? AND state='pending'").run(row.at, row.stable_id, row.writer_id);
    return;
  }
  if (row.kind !== "decision_requested" && row.kind !== "decision_resolved") return;
  const id = requestId(detail); if (!id) return;
  const uid = `${row.stable_id}#${row.writer_id}#${id}`;
  const existing = db.query("SELECT state FROM requests WHERE request_uid=?").get(uid) as RequestRow | null;
  const kind = stringDetail(detail, "request_kind") ?? stringDetail(detail, "kind") ?? "decision";
  if (row.kind === "decision_requested") {
    if (!existing) {
      db.query(`INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, next_reminder_at, detail)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`).run(uid, row.stable_id, row.writer_id, row.emitter_id, id, kind, row.at, row.at, row.detail);
      db.query(`INSERT OR IGNORE INTO notifications(request_uid, sink, kind, reminder_seq, state)
        VALUES (?, 'osascript', 'initial', 0, 'pending')`).run(uid);
    }
    return;
  }
  const state = terminalState(detail);
  if (!existing) {
    db.query(`INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, resolved_at, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(uid, row.stable_id, row.writer_id, row.emitter_id, id, kind, state, row.at, row.at, row.detail);
  } else if (existing.state === "pending" || existing.state === "orphaned") {
    db.query("UPDATE requests SET state=?, resolved_at=?, detail=? WHERE request_uid=?").run(state, row.at, row.detail, uid);
  }
}

function orphanDrainedEmitter(db: Database, row: JournalRow, detail: Record<string, unknown>): void {
  const emitterId = stringDetail(detail, "emitter_id"); if (!emitterId) return;
  const stableId = stringDetail(detail, "stable_id") ?? null;
  db.query("UPDATE requests SET state='orphaned', resolved_at=? WHERE origin_emitter_id=? AND state='pending'").run(row.at, emitterId);
  const last = db.query("SELECT seq, at FROM journal WHERE emitter_id=? AND ingest_seq<? ORDER BY ingest_seq DESC LIMIT 1").get(emitterId, row.ingest_seq) as { seq: number; at: number } | null;
  db.query(`INSERT INTO coverage_gaps(stable_id, emitter_id, from_seq, from_at, to_at, reason)
    VALUES (?, ?, ?, ?, ?, 'emitter_drained')`).run(stableId, emitterId, last?.seq ?? null, last?.at ?? null, row.at);
}
