import type { Database } from "bun:sqlite";

export type SessionSummary = { stable_id: string; runtime: string | null; origin: string | null; created_at: number | null; state: string | null; queue: string | null; q5_reason: string | null; last_event_at: number | null };
export type IncarnationRow = { writer_id: string; liveness_domain: string; pid: number | null; proc_boot_id: string | null; started_at: number | null; last_seen_at: number | null };
export type PendingRequestRow = { request_uid: string; kind: string; created_at: number; detail: Record<string, unknown> | null };
export type EventRow = { ingest_seq: number; at: number; emitter_id: string; writer_id: string; kind: string; detail: Record<string, unknown> | null };
export type SessionDetail = {
  session: {
    stable_id: string; origin: string | null; runtime: string | null; app: string | null; created_at: number | null;
    cwd: string | null; branch: string | null; state: string | null; queue: string | null; q5_reason: string | null;
    last_event_at: number | null; last_heartbeat_at: number | null; last_progress_at: number | null;
    binding: string | null;
  };
  incarnations: IncarnationRow[];
  pending_requests: PendingRequestRow[];
  /** Newest first and heartbeat-free: the question is what the turn last did. */
  events: EventRow[];
};
export type Q1Row = { request_uid: string; stable_id: string; host: string | null; kind: string; created_at: number; detail: Record<string, unknown> | null; binding: string | null; platform: string | null; summary: string | null; options: string[] | null };
export type JumpTarget = { source: "host" | "attachment"; platform: string | null; binding: string | null; tty: string | null; host: string | null };
export type Q2Row = { stable_id: string; origin: string; last_event_at: number };
export type ArchiveRow = { stable_id: string; origin: string; last_event_at: number };
export type HungRow = { stable_id: string; q5_reason: string; state: string; host: string | null; since: number | null; hung_ms: number; binding: string | null; detail: Record<string, unknown> | null };
export type ZombieView = {
  groups: Array<{ q5_reason: string; rows: Array<{ stable_id: string; last_event_at: number }> }>;
  orphaned_requests: Array<{ request_uid: string; stable_id: string; resolved_at: number | null }>;
};
export type HealthView = {
  open_incidents: Array<{ source: string; opened_at: number; detail: Record<string, unknown> | null }>;
  coverage_gaps: number;
  telemetry_gaps: number;
};

type JsonRow = { detail: string | null };

// Health reflects currently active collection problems; stale gap history must age out.
const HEALTH_GAP_WINDOW_MS = 24 * 60 * 60 * 1000;

function parseDetail(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function withParsedDetail<T extends JsonRow>(row: T): Omit<T, "detail"> & { detail: Record<string, unknown> | null } {
  return { ...row, detail: parseDetail(row.detail) };
}

function detailSummary(detail: Record<string, unknown> | null): string | null {
  const value = detail?.summary;
  return typeof value === "string" && value ? value : null;
}

function detailOptions(detail: Record<string, unknown> | null): string[] | null {
  const value = detail?.options;
  if (!Array.isArray(value)) return null;
  const labels = value.filter((entry): entry is string => typeof entry === "string");
  return labels.length ? labels : null;
}

export function querySessions(db: Database, limit = -1): SessionSummary[] {
  return db.query(`SELECT s.stable_id, s.runtime, s.origin, s.created_at,
    c.state, c.queue, c.q5_reason, COALESCE(c.last_event_at, s.first_seen_at) last_event_at
    FROM sessions s LEFT JOIN current c ON c.stable_id=s.stable_id
    ORDER BY last_event_at DESC, s.stable_id LIMIT ?`).all(limit) as SessionSummary[];
}

export function querySession(db: Database, stableId: string, eventLimit = 200): SessionDetail | null {
  const session = db.query(`SELECT s.stable_id, s.origin, s.runtime, h.app, s.created_at, s.cwd, s.branch,
    c.state, c.queue, c.q5_reason, c.last_event_at, c.last_heartbeat_at, c.last_progress_at,
    COALESCE((SELECT session_id FROM session_hosts h WHERE h.stable_id=s.stable_id AND h.session_id IS NOT NULL),
      (SELECT binding FROM attachments a WHERE a.stable_id=s.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1)) binding
    FROM sessions s LEFT JOIN current c ON c.stable_id=s.stable_id
    LEFT JOIN session_hosts h ON h.stable_id=s.stable_id AND h.session_id IS NOT NULL
    WHERE s.stable_id=?`).get(stableId) as SessionDetail["session"] | null;
  if (!session) return null;
  const incarnations = db.query(`SELECT writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at FROM session_incarnations WHERE stable_id=? ORDER BY started_at DESC, writer_id DESC`).all(stableId) as IncarnationRow[];
  const pending = db.query(`SELECT request_uid, kind, created_at, detail FROM requests WHERE stable_id=? AND state='pending' ORDER BY created_at DESC, request_uid DESC`).all(stableId) as Array<PendingRequestRow & JsonRow>;
  // Heartbeats are liveness, not history: 900 of them would bury the one
  // tool_activity that says where the turn actually stopped.
  const events = db.query(`SELECT ingest_seq, at, emitter_id, writer_id, kind, detail FROM journal
    WHERE kind<>'heartbeat' AND (stable_id=? OR
      (kind IN ('turn_hung','dead_connection') AND json_extract(detail, '$.stable_id')=?))
    ORDER BY ingest_seq DESC LIMIT ?`).all(stableId, stableId, eventLimit) as Array<EventRow & JsonRow>;
  return {
    session,
    incarnations,
    pending_requests: pending.map(withParsedDetail),
    events: events.map(withParsedDetail),
  };
}

export function queryQ1(db: Database): Q1Row[] {
  const rows = db.query(`SELECT r.request_uid, r.stable_id, s.host, r.kind, r.created_at, r.detail,
    COALESCE((SELECT session_id FROM session_hosts h WHERE h.stable_id=r.stable_id AND h.session_id IS NOT NULL),
      (SELECT binding FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1)) binding,
    COALESCE((SELECT lower(app) FROM session_hosts h WHERE h.stable_id=r.stable_id AND h.session_id IS NOT NULL),
      (SELECT platform FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1)) platform
    FROM requests r LEFT JOIN sessions s ON s.stable_id=r.stable_id
    WHERE r.state='pending' ORDER BY r.created_at DESC, r.request_uid DESC`).all() as Array<Omit<Q1Row, "detail" | "summary" | "options"> & JsonRow>;
  return rows.map((row) => {
    const parsed = withParsedDetail(row);
    return { ...parsed, summary: detailSummary(parsed.detail), options: detailOptions(parsed.detail) };
  });
}

/** Keyed by session, not request: a hung turn has no pending request to jump from. */
export function queryJumpTarget(db: Database, stableId: string): JumpTarget | null {
  return db.query(`SELECT s.host,
    CASE WHEN h.stable_id IS NOT NULL THEN 'host' ELSE 'attachment' END source,
    COALESCE(lower(h.app), a.platform) platform,
    COALESCE(h.session_id, h.tty, a.binding) binding,
    h.tty
    FROM sessions s
    LEFT JOIN session_hosts h ON h.stable_id=s.stable_id AND h.session_id IS NOT NULL
    LEFT JOIN attachments a ON a.stable_id=s.stable_id AND a.valid=1
      AND a.observed_at=(SELECT MAX(observed_at) FROM attachments WHERE stable_id=s.stable_id AND valid=1)
    WHERE s.stable_id=?`).get(stableId) as JumpTarget | null;
}

export function requestSession(db: Database, requestUid: string): string | null {
  const row = db.query("SELECT stable_id FROM requests WHERE request_uid=?").get(requestUid) as { stable_id: string } | null;
  return row?.stable_id ?? null;
}

/** Q5 sessions whose turn is provably stuck: heartbeat alive, progress frozen. */
export function queryHung(db: Database, now = Date.now()): HungRow[] {
  const rows = db.query(`SELECT c.stable_id, c.q5_reason, c.state, s.host,
    COALESCE(c.last_progress_at, c.last_event_at) since,
    (SELECT j.detail FROM journal j WHERE j.kind=c.q5_reason
       AND json_extract(j.detail, '$.stable_id')=c.stable_id ORDER BY j.ingest_seq DESC LIMIT 1) detail,
    COALESCE((SELECT session_id FROM session_hosts h WHERE h.stable_id=c.stable_id AND h.session_id IS NOT NULL),
      (SELECT binding FROM attachments a WHERE a.stable_id=c.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1)) binding
    FROM current c LEFT JOIN sessions s ON s.stable_id=c.stable_id
    WHERE c.q5_reason IN ('turn_hung','dead_connection')
    ORDER BY since DESC, c.stable_id DESC`).all() as Array<Omit<HungRow, "detail" | "hung_ms"> & JsonRow>;
  return rows.map((row) => ({ ...withParsedDetail(row), hung_ms: row.since ? Math.max(0, now - row.since) : 0 }));
}

/** Completed agent work with proven lineage; may require a human close-out. */
export function queryQ2(db: Database): Q2Row[] {
  return db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q2' AND origin<>'unknown' ORDER BY last_event_at DESC, stable_id DESC").all() as Q2Row[];
}

/** Finished sessions lacking lineage; retained for audit, not human action. */
export function queryArchive(db: Database): ArchiveRow[] {
  return db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q2' AND origin='unknown' ORDER BY last_event_at DESC, stable_id DESC").all() as ArchiveRow[];
}

export function queryZombie(db: Database): ZombieView {
  const rows = db.query("SELECT stable_id, q5_reason, last_event_at FROM current WHERE queue='q5' ORDER BY q5_reason, last_event_at DESC, stable_id DESC").all() as Array<{ stable_id: string; q5_reason: string; last_event_at: number }>;
  const groups: ZombieView["groups"] = [];
  for (const row of rows) {
    // Hung turns have their own surface; counting them twice inflates Zombie.
    if (row.q5_reason === "orphaned_request" || row.q5_reason === "turn_hung" || row.q5_reason === "dead_connection") continue;
    let group = groups.at(-1);
    if (!group || group.q5_reason !== row.q5_reason) {
      group = { q5_reason: row.q5_reason, rows: [] };
      groups.push(group);
    }
    group.rows.push({ stable_id: row.stable_id, last_event_at: row.last_event_at });
  }
  const orphaned_requests = db.query(`SELECT request_uid, stable_id, resolved_at FROM requests WHERE state='orphaned' ORDER BY resolved_at DESC, request_uid DESC`).all() as ZombieView["orphaned_requests"];
  return { groups, orphaned_requests };
}

export function queryHealth(db: Database): HealthView {
  const incidents = db.query("SELECT source, opened_at, detail FROM incidents WHERE closed_at IS NULL ORDER BY opened_at DESC, source DESC").all() as Array<HealthView["open_incidents"][number] & JsonRow>;
  // Distinct subjects, not event rows: recon re-reports the same gap hourly, so
  // a raw count says how long a problem has existed, never how many there are.
  // Only recent gaps represent current collection health; open incidents remain
  // unwindowed above because they are unresolved until explicitly closed.
  const cutoff = Date.now() - HEALTH_GAP_WINDOW_MS;
  // bun:sqlite returns untyped rows; these aggregates are shaped by their SQL.
  const coverage = db.query(`SELECT count(DISTINCT COALESCE(stable_id, emitter_id)) n
    FROM coverage_gaps WHERE from_at>=?`).get(cutoff) as { n: number };
  const telemetry = db.query(`SELECT count(DISTINCT json_extract(detail, '$.native_id')) n
    FROM journal WHERE kind='telemetry_gap' AND at>=?`).get(cutoff) as { n: number };
  return { open_incidents: incidents.map(withParsedDetail), coverage_gaps: coverage.n, telemetry_gaps: telemetry.n };
}

export function ackRequest(db: Database, requestUid: string): { changes: number } {
  // Historical cancelled rows are intentionally left unchanged: their local-vs-source
  // origin cannot be recovered reliably, so only future local acknowledgements use acked.
  const result = db.query("UPDATE requests SET state='acked', resolved_at=? WHERE request_uid=? AND state='pending'").run(Date.now(), requestUid);
  return { changes: Number(result.changes) };
}

