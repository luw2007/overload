import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SessionSummary = { stable_id: string; runtime: string | null; origin: string | null; created_at: number | null };
export type IncarnationRow = { writer_id: string; liveness_domain: string; pid: number | null; proc_boot_id: string | null; started_at: number | null; last_seen_at: number | null };
export type PendingRequestRow = { request_uid: string; kind: string; created_at: number; detail: Record<string, unknown> | null };
export type EventRow = { ingest_seq: number; at: number; emitter_id: string; writer_id: string; kind: string; detail: Record<string, unknown> | null };
export type SessionDetail = {
  session: { stable_id: string; origin: string | null; runtime: string | null; created_at: number | null; cwd: string | null; branch: string | null };
  incarnations: IncarnationRow[];
  pending_requests: PendingRequestRow[];
  events: EventRow[];
};
export type Q1Row = { request_uid: string; stable_id: string; host: string | null; kind: string; created_at: number; detail: Record<string, unknown> | null; failed: boolean; binding: string | null; platform: string | null };
export type JumpTarget = { platform: string | null; binding: string | null; host: string | null };
export type Q2Row = { stable_id: string; origin: string; last_event_at: number };
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

export function querySessions(db: Database): SessionSummary[] {
  return db.query(`SELECT stable_id, runtime, origin, created_at FROM sessions ORDER BY first_seen_at, stable_id`).all() as SessionSummary[];
}

export function querySession(db: Database, stableId: string): SessionDetail | null {
  const session = db.query("SELECT stable_id, origin, runtime, created_at, cwd, branch FROM sessions WHERE stable_id=?").get(stableId) as SessionDetail["session"] | null;
  if (!session) return null;
  const incarnations = db.query(`SELECT writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at FROM session_incarnations WHERE stable_id=? ORDER BY started_at, writer_id`).all(stableId) as IncarnationRow[];
  const pending = db.query(`SELECT request_uid, kind, created_at, detail FROM requests WHERE stable_id=? AND state='pending' ORDER BY created_at, request_uid`).all(stableId) as Array<PendingRequestRow & JsonRow>;
  const events = db.query(`SELECT ingest_seq, at, emitter_id, writer_id, kind, detail FROM journal WHERE stable_id=? ORDER BY ingest_seq`).all(stableId) as Array<EventRow & JsonRow>;
  return {
    session,
    incarnations,
    pending_requests: pending.map(withParsedDetail),
    events: events.map(withParsedDetail),
  };
}

export function queryQ1(db: Database): Q1Row[] {
  const rows = db.query(`SELECT r.request_uid, r.stable_id, s.host, r.kind, r.created_at, r.detail,
    EXISTS(SELECT 1 FROM notifications n WHERE n.request_uid=r.request_uid AND n.state='failed_permanent') failed,
    (SELECT binding FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1) binding,
    (SELECT platform FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1) platform
    FROM requests r LEFT JOIN sessions s ON s.stable_id=r.stable_id
    WHERE r.state='pending' ORDER BY failed DESC, r.created_at, r.request_uid`).all() as Array<Omit<Q1Row, "detail" | "failed"> & JsonRow & { failed: number }>;
  return rows.map((row) => ({ ...withParsedDetail(row), failed: !!row.failed }));
}

export function queryJumpTarget(db: Database, requestUid: string): JumpTarget | null {
  return db.query(`SELECT s.host,
    (SELECT binding FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1) binding,
    (SELECT platform FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1) platform
    FROM requests r JOIN sessions s ON s.stable_id=r.stable_id
    WHERE r.request_uid=?`).get(requestUid) as JumpTarget | null;
}

export function queryQ2(db: Database): Q2Row[] {
  return db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q2' ORDER BY last_event_at, stable_id").all() as Q2Row[];
}

export function queryZombie(db: Database): ZombieView {
  const rows = db.query("SELECT stable_id, q5_reason, last_event_at FROM current WHERE queue='q5' ORDER BY q5_reason, last_event_at, stable_id").all() as Array<{ stable_id: string; q5_reason: string; last_event_at: number }>;
  const groups: ZombieView["groups"] = [];
  for (const row of rows) {
    if (row.q5_reason === "orphaned_request") continue;
    let group = groups.at(-1);
    if (!group || group.q5_reason !== row.q5_reason) {
      group = { q5_reason: row.q5_reason, rows: [] };
      groups.push(group);
    }
    group.rows.push({ stable_id: row.stable_id, last_event_at: row.last_event_at });
  }
  const orphaned_requests = db.query(`SELECT request_uid, stable_id, resolved_at FROM requests WHERE state='orphaned' ORDER BY resolved_at, request_uid`).all() as ZombieView["orphaned_requests"];
  return { groups, orphaned_requests };
}

export function queryHealth(db: Database): HealthView {
  const incidents = db.query("SELECT source, opened_at, detail FROM incidents WHERE closed_at IS NULL ORDER BY opened_at").all() as Array<HealthView["open_incidents"][number] & JsonRow>;
  const coverage_gaps = (db.query("SELECT count(*) n FROM coverage_gaps").get() as { n: number }).n;
  const telemetry_gaps = (db.query("SELECT count(*) n FROM journal WHERE kind='telemetry_gap'").get() as { n: number }).n;
  return { open_incidents: incidents.map(withParsedDetail), coverage_gaps, telemetry_gaps };
}

export function ackRequest(db: Database, requestUid: string): { changes: number } {
  const result = db.query("UPDATE requests SET state='cancelled', resolved_at=? WHERE request_uid=? AND state='pending'").run(Date.now(), requestUid);
  return { changes: Number(result.changes) };
}

export type AttentionView = {
  /** Notifications delivered to the human in the trailing 24h — each one is a flexibility trigger. */
  interruptions_24h: number;
  /** interruptions_24h x refocus cost (Gloria Mark: ~20min to regain focus after an interruption). */
  refocus_cost_min: number;
  pending_decisions: number;
  pending_decision_avg_wait_ms: number | null;
  /** Distinct sessions currently demanding human attention (pending asks + q2/q5). */
  open_contexts: number;
};

export const DEFAULT_REFOCUS_COST_MIN = 20;
const DAY_MS = 86_400_000;

export function queryAttention(db: Database, now = Date.now(), refocusCostMin = DEFAULT_REFOCUS_COST_MIN): AttentionView {
  // bun:sqlite rows are untyped; named-const casts document the aggregate shapes.
  const interruptions = db.query("SELECT count(*) n FROM notifications WHERE state='sent' AND sent_at >= ?").get(now - DAY_MS) as { n: number };
  const pending = db.query("SELECT count(*) n, avg(? - created_at) w FROM requests WHERE state='pending'").get(now) as { n: number; w: number | null };
  const contexts = db.query(`SELECT count(*) n FROM (
    SELECT stable_id FROM requests WHERE state='pending'
    UNION SELECT stable_id FROM current WHERE queue IN ('q2','q5'))`).get() as { n: number };
  return {
    interruptions_24h: interruptions.n,
    refocus_cost_min: interruptions.n * refocusCostMin,
    pending_decisions: pending.n,
    pending_decision_avg_wait_ms: pending.w == null ? null : Math.round(pending.w),
    open_contexts: contexts.n,
  };
}

/** refocus_cost_min from ~/.overload/config.json; invalid/missing falls back to 20. */
export function configRefocusCostMin(): number {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(homedir(), ".overload", "config.json"), "utf8"));
    if (raw && typeof raw === "object" && "refocus_cost_min" in raw) {
      const value = raw.refocus_cost_min;
      if (typeof value === "number" && value > 0) return value;
    }
  } catch { /* fall through to default */ }
  return DEFAULT_REFOCUS_COST_MIN;
}

export function formatAttention(view: AttentionView): string {
  const wait = view.pending_decision_avg_wait_ms == null ? "-" : `${Math.round(view.pending_decision_avg_wait_ms / 60_000)}m`;
  return `interruptions(24h)=${view.interruptions_24h} (~${view.refocus_cost_min}min refocus) · pending decisions=${view.pending_decisions} avg_wait=${wait} · open contexts=${view.open_contexts}`;
}
