/**
 * §2.4b/§2.4c classifier — N8 reference implementation of the FROZEN P2
 * contract (p2-freeze.md protocol 2 + docs/plans/…-tech-solution.md §2.4).
 *
 * Queue predicates (frozen):
 *   Q1 = requests.pending (sole source)
 *   Q2 = done ∧ origin ∈ {agent, unknown}   (Q4 closed until P4)
 *   Q3 = working/idle ∧ heartbeat not expired (STALL_PROFILE_MS.narrow)
 *   Q5 = four MUTUALLY EXCLUSIVE reasons (Q5Reason): stalled / dead_incarnation
 *        / telemetry_gap / orphaned_request
 *
 * Determinism rules this reference pins down (N5 must match observably):
 *   - queue_transitions idempotency: UNIQUE(subject, queue, direction,
 *     source_seq, classifier_version); replay/reduce never clears the table.
 *   - classifier_activations watermark: one row per version despite repeated
 *     runs; only journal rows with ingest_seq > the activation watermark are
 *     classified under that version (replay-deterministic version choice).
 *   - Q5 precedence when multiple evidence sources fire simultaneously:
 *     dead_incarnation > telemetry_gap > (q3 if heartbeat fresh) > stalled.
 *     Exactly one q5_reason is ever recorded (mutual exclusivity).
 *   - terminal states are sticky (§2.4a): recon evidence cannot move
 *     done/vanished/failed sessions; extension events beat recon events for
 *     live states.
 */
import { Database } from "bun:sqlite";
import {
  STALL_PROFILE_MS,
  type QueueName,
  type Q5Reason,
  type RequestState,
  type SessionState,
} from "../../../src/shared/types";

export const CLASSIFIER_VERSION = 1;

export type Origin = "agent" | "human" | "unknown";

/**
 * §2.4a origin resolution: session_started.detail.parent (any non-empty
 * lineage value ⇒ agent-launched) > attachment/orca lineage > unknown, and
 * unknown is TREATED AS agent for Q2. "human" arises from an orca worktree
 * with no parentWorktreeId (human-lached top-level worktree).
 */
export function normalizeOrigin(raw: string | null | undefined): Origin {
  if (!raw || raw === "unknown") return "unknown";
  if (raw === "human") return "human";
  return "agent";
}

export interface SessionQueueInput {
  stable_id: string;
  state: SessionState;
  /** Raw sessions.current origin value (unnormalized). */
  origin: string | null;
  last_heartbeat_at: number | null;
}

/** Recon evidence accumulated for a session (from admin-spool findings). */
export interface SessionEvidence {
  /** emitter_dead (process domain, no shutdown) — §2.4c dead_incarnation. */
  dead_incarnation?: boolean;
  /** telemetry_gap finding joined by cwd — authoritative degradation path. */
  telemetry_gap?: boolean;
  /** emitter_stalled: heartbeat silence beyond profile ∧ pid alive. */
  stalled?: boolean;
}

export interface QueueAssignment {
  queue: QueueName | null;
  q5_reason?: Q5Reason;
}

const TERMINAL: SessionState[] = ["done", "vanished", "failed"];

/** Session queue predicate (pure). */
export function queueForSession(
  s: SessionQueueInput,
  now: number,
  ev: SessionEvidence = {},
): QueueAssignment {
  // Terminal states are sticky: recon evidence never moves them (§2.4a).
  if (TERMINAL.includes(s.state)) {
    if (s.state === "done") {
      const o = normalizeOrigin(s.origin);
      return o === "agent" || o === "unknown" ? { queue: "q2" } : { queue: null };
    }
    return { queue: null }; // vanished/failed: no queue in v1
  }
  if (ev.dead_incarnation) return { queue: "q5", q5_reason: "dead_incarnation" };
  if (ev.telemetry_gap) return { queue: "q5", q5_reason: "telemetry_gap" };
  if (s.state === "awaiting_human") return { queue: null }; // its pending request is the Q1 subject
  const fresh =
    s.last_heartbeat_at !== null && now - s.last_heartbeat_at < STALL_PROFILE_MS.narrow;
  if (fresh) return { queue: "q3" };
  if (ev.stalled) return { queue: "q5", q5_reason: "stalled" };
  // Heartbeat expired without recon confirmation: limbo (no queue) until the
  // recon daemon confirms stall/death — an unconfirmed guess is never recorded.
  return { queue: null };
}

/** Request queue predicate (pure). Q1's sole source is requests.pending. */
export function queueForRequest(state: RequestState): QueueAssignment {
  if (state === "pending") return { queue: "q1" };
  if (state === "orphaned") return { queue: "q5", q5_reason: "orphaned_request" };
  return { queue: null };
}

// ── queue_transitions (frozen UNIQUE 5-tuple idempotency) ──

export interface TransitionInput {
  subject: string;
  queue: QueueName;
  direction: "entered" | "left";
  at: number;
  source_seq: number;
  classifier_version?: number;
}

/** INSERT OR IGNORE against the frozen UNIQUE key. Returns true iff inserted. */
export function recordTransition(db: Database, t: TransitionInput): boolean {
  const version = t.classifier_version ?? CLASSIFIER_VERSION;
  const r = db
    .query(
      `INSERT OR IGNORE INTO queue_transitions(subject, queue, direction, at, source_seq, classifier_version)
       VALUES(?, ?, ?, ?, ?, ?)`,
    )
    .run(t.subject, t.queue, t.direction, t.at, t.source_seq, version);
  return Number(r.changes) === 1;
}

// ── classifier_activations watermark ──

export interface ActivationInput {
  version?: number;
  /** Journal seq at which the version became active (watermark). */
  activated_at_journal_seq: number;
  activated_at: number;
}

/** Idempotent activation (one row per version). Returns true iff inserted. */
export function activateClassifier(db: Database, a: ActivationInput): boolean {
  const r = db
    .query(
      `INSERT OR IGNORE INTO classifier_activations(version, activated_at_journal_seq, activated_at)
       VALUES(?, ?, ?)`,
    )
    .run(a.version ?? CLASSIFIER_VERSION, a.activated_at_journal_seq, a.activated_at);
  return Number(r.changes) === 1;
}

/** Version active for a given journal seq (0 = none yet). */
export function activeVersionAt(db: Database, journalSeq: number): number {
  const row = db
    .query(
      `SELECT version FROM classifier_activations WHERE activated_at_journal_seq <= ?
       ORDER BY activated_at_journal_seq DESC, version DESC LIMIT 1`,
    )
    .get(journalSeq) as { version: number } | null;
  return row?.version ?? 0;
}

/** Highest activation watermark (0 when no classifier has ever activated). */
export function activationWatermark(db: Database): number {
  const row = db
    .query("SELECT COALESCE(MAX(activated_at_journal_seq), 0) AS w FROM classifier_activations")
    .get() as { w: number };
  return row.w;
}

// ── contract mini-reducer (drives the predicates over a journal range) ──
//
// A deliberately minimal reducer that demonstrates the frozen reducer/classifier
// contract: process journal rows in (fromSeq, toSeq] inside ONE transaction,
// update current/requests/coverage_gaps, record queue_transitions, advance the
// watermark semantics. Re-running the same range must produce ZERO new
// transitions (UNIQUE backstop) and never clear derived tables.

export interface ReduceOpts {
  /** Exclusive lower journal seq (default: activation watermark). */
  fromSeq?: number;
  /** Inclusive upper journal seq (default: MAX(ingest_seq)). */
  toSeq?: number;
  /** Wall clock used for heartbeat freshness of the FINAL projection. */
  now: number;
}

export interface ReduceResult {
  processed: number;
  newTransitions: number;
  activated: boolean;
}

type JournalRow = {
  ingest_seq: number;
  at: number;
  stable_id: string;
  writer_id: string;
  emitter_id: string;
  kind: string;
  detail: string | null;
};

const REQUEST_TERMINALS = new Set(["resolved", "cancelled", "timed_out"]);

function detailOf(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function reduceClassifyPass(db: Database, opts: ReduceOpts): ReduceResult {
  let processed = 0;
  let newTransitions = 0;
  let activated = false;

  const watermark = activationWatermark(db);
  const from = Math.max(opts.fromSeq ?? watermark, watermark);
  const toRow = db.query("SELECT COALESCE(MAX(ingest_seq), 0) AS m FROM journal").get() as { m: number };
  const to = opts.toSeq ?? toRow.m;

  const tx = db.transaction(() => {
    // First-ever run: activate v1 at the batch boundary. Repeated runs keep a
    // single activation row (INSERT OR IGNORE) — the watermark is respected.
    if (activationWatermark(db) === 0 && to > 0) {
      activated = activateClassifier(db, { activated_at_journal_seq: from, activated_at: opts.now });
    }

    const rows = db
      .query(
        `SELECT ingest_seq, at, stable_id, writer_id, emitter_id, kind, detail
         FROM journal WHERE ingest_seq > ? AND ingest_seq <= ? ORDER BY ingest_seq`,
      )
      .all(from, to) as JournalRow[];

    // Per-session queues tracked in-memory for change detection; seeded from
    // the persisted `current` projection so replay sees consistent state.
    const sessionQueue = new Map<string, QueueAssignment>();
    // In-memory session projection (state/origin/hb). session_started RESETS it
    // (a new incarnation replays from scratch) — this is what makes a
    // re-reduce of an already-seen range produce byte-identical transitions:
    // the persisted end-state (e.g. a future last_heartbeat_at, terminal
    // state) never leaks backwards into replayed classification.
    const proj = new Map<string, { state: SessionState; origin: string | null; hb: number | null }>();
    const evidence = new Map<string, SessionEvidence>();
    const requestQueue = new Map<string, QueueAssignment>();

    const getProj = (stableId: string) => {
      const p = proj.get(stableId);
      if (p) return p;
      const row = db.query("SELECT state, origin, last_heartbeat_at FROM current WHERE stable_id=?").get(stableId) as
        | { state: SessionState; origin: string | null; last_heartbeat_at: number | null }
        | null;
      const seeded = row
        ? { state: row.state, origin: row.origin, hb: row.last_heartbeat_at }
        : { state: "idle" as SessionState, origin: null, hb: null };
      proj.set(stableId, seeded);
      return seeded;
    };

    const setSessionQueue = (stableId: string, next: QueueAssignment, at: number, seq: number) => {
      const prev = sessionQueue.get(stableId) ?? { queue: null };
      if (prev.queue === next.queue && prev.q5_reason === next.q5_reason) return;
      if (prev.queue !== null && prev.queue !== next.queue) {
        if (recordTransition(db, { subject: stableId, queue: prev.queue, direction: "left", at, source_seq: seq })) newTransitions++;
      }
      if (next.queue !== null) {
        if (recordTransition(db, { subject: stableId, queue: next.queue, direction: "entered", at, source_seq: seq })) newTransitions++;
      }
      sessionQueue.set(stableId, next);
      db.query("UPDATE current SET queue=?, q5_reason=? WHERE stable_id=?").run(
        next.queue,
        next.q5_reason ?? null,
        stableId,
      );
    };

    const setRequestQueue = (uid: string, next: QueueAssignment, at: number, seq: number) => {
      const prev = requestQueue.get(uid) ?? { queue: null };
      if (prev.queue === next.queue) return;
      if (prev.queue !== null && prev.queue !== next.queue) {
        if (recordTransition(db, { subject: uid, queue: prev.queue, direction: "left", at, source_seq: seq })) newTransitions++;
      }
      if (next.queue !== null) {
        if (recordTransition(db, { subject: uid, queue: next.queue, direction: "entered", at, source_seq: seq })) newTransitions++;
      }
      requestQueue.set(uid, next);
    };

    const reclassifySession = (stableId: string, at: number, seq: number) => {
      const cur = getProj(stableId);
      const next = queueForSession(
        {
          stable_id: stableId,
          state: cur.state,
          origin: cur.origin,
          last_heartbeat_at: cur.hb,
        },
        at, // classify at event time → replay deterministic
        evidence.get(stableId) ?? {},
      );
      setSessionQueue(stableId, next, at, seq);
    };

    for (const row of rows) {
      processed++;
      const d = detailOf(row.detail);
      const p = getProj(row.stable_id);

      switch (row.kind) {
        case "session_started": {
          const origin = typeof d.origin === "string" ? d.origin : typeof d.parent === "string" ? d.parent : "unknown";
          // New incarnation: reset the projection (state working, hb fresh-
          // unknown) so replay re-derives rather than inheriting end-state.
          proj.set(row.stable_id, { state: "working", origin, hb: null });
          db.query(
            `INSERT INTO current(stable_id, writer_id, state, origin, last_ingest_seq, last_event_at)
             VALUES(?, ?, 'working', ?, ?, ?)
             ON CONFLICT(stable_id) DO UPDATE SET writer_id=excluded.writer_id,
               last_ingest_seq=excluded.last_ingest_seq, last_event_at=excluded.last_event_at`,
          ).run(row.stable_id, row.writer_id, origin, row.ingest_seq, row.at);
          reclassifySession(row.stable_id, row.at, row.ingest_seq);
          break;
        }
        case "working":
        case "settled": {
          const state: SessionState = row.kind === "working" ? "working" : "idle";
          if (!TERMINAL.includes(p.state)) p.state = state;
          db.query(
            "UPDATE current SET state=?, last_ingest_seq=?, last_event_at=? WHERE stable_id=?",
          ).run(p.state, row.ingest_seq, row.at, row.stable_id);
          reclassifySession(row.stable_id, row.at, row.ingest_seq);
          break;
        }
        case "heartbeat":
        case "tool_activity": {
          p.hb = row.at;
          db.query(
            "UPDATE current SET last_heartbeat_at=?, last_ingest_seq=?, last_event_at=? WHERE stable_id=?",
          ).run(row.at, row.ingest_seq, row.at, row.stable_id);
          reclassifySession(row.stable_id, row.at, row.ingest_seq);
          break;
        }
        case "decision_requested": {
          const rid = typeof d.request_id === "string" ? d.request_id : null;
          if (rid) {
            const uid = `${row.stable_id}#${row.writer_id}#${rid}`;
            db.query(
              `INSERT OR IGNORE INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at)
               VALUES(?, ?, ?, ?, ?, 'decision', 'pending', ?)`,
            ).run(uid, row.stable_id, row.writer_id, row.emitter_id, rid, row.at);
            setRequestQueue(uid, queueForRequest("pending"), row.at, row.ingest_seq);
          }
          if (!TERMINAL.includes(p.state)) p.state = "awaiting_human";
          db.query(
            "UPDATE current SET state=?, last_ingest_seq=?, last_event_at=? WHERE stable_id=?",
          ).run(p.state, row.ingest_seq, row.at, row.stable_id);
          reclassifySession(row.stable_id, row.at, row.ingest_seq);
          break;
        }
        case "decision_resolved": {
          const rid = typeof d.request_id === "string" ? d.request_id : null;
          const st = typeof d.state === "string" && REQUEST_TERMINALS.has(d.state) ? d.state : "resolved";
          if (rid) {
            const uid = `${row.stable_id}#${row.writer_id}#${rid}`;
            db.query(
              "UPDATE requests SET state=?, resolved_at=? WHERE request_uid=? AND state IN ('pending','orphaned')",
            ).run(st, row.at, uid);
            setRequestQueue(uid, queueForRequest(st as RequestState), row.at, row.ingest_seq);
          }
          reclassifySession(row.stable_id, row.at, row.ingest_seq);
          break;
        }
        case "session_ended": {
          p.state = "done";
          db.query("UPDATE current SET state='done' WHERE stable_id=?").run(row.stable_id);
          // §2.4a: session_shutdown → done; its pending requests → orphaned.
          const pend = db
            .query("SELECT request_uid FROM requests WHERE stable_id=? AND state='pending'")
            .all(row.stable_id) as Array<{ request_uid: string }>;
          for (const p of pend) {
            db.query("UPDATE requests SET state='orphaned', resolved_at=? WHERE request_uid=?").run(row.at, p.request_uid);
            setRequestQueue(p.request_uid, queueForRequest("orphaned"), row.at, row.ingest_seq);
          }
          reclassifySession(row.stable_id, row.at, row.ingest_seq);
          break;
        }
        case "session_vanished": {
          p.state = "vanished";
          db.query("UPDATE current SET state='vanished' WHERE stable_id=?").run(row.stable_id);
          reclassifySession(row.stable_id, row.at, row.ingest_seq);
          break;
        }
        case "emitter_dead": {
          const sid = typeof d.stable_id === "string" ? d.stable_id : row.stable_id;
          const ev = evidence.get(sid) ?? {};
          ev.dead_incarnation = true;
          evidence.set(sid, ev);
          reclassifySession(sid, row.at, row.ingest_seq);
          break;
        }
        case "emitter_stalled": {
          const sid = typeof d.stable_id === "string" ? d.stable_id : row.stable_id;
          const ev = evidence.get(sid) ?? {};
          ev.stalled = true;
          evidence.set(sid, ev);
          reclassifySession(sid, row.at, row.ingest_seq);
          break;
        }
        case "telemetry_gap": {
          // Join by cwd (finding detail) → stable_id; fall back to envelope session.
          const cwd = typeof d.cwd === "string" ? d.cwd : null;
          const sid =
            (cwd
              ? (db.query("SELECT stable_id FROM sessions WHERE cwd=? ORDER BY first_seen_at LIMIT 1").get(cwd) as
                  | { stable_id: string }
                  | undefined)?.stable_id
              : undefined) ?? row.stable_id;
          const ev = evidence.get(sid) ?? {};
          ev.telemetry_gap = true;
          evidence.set(sid, ev);
          reclassifySession(sid, row.at, row.ingest_seq);
          break;
        }
        case "emitter_drained": {
          // Protocol 3: SOLE orphan trigger. That emitter's pending requests →
          // orphaned (Q5 orphaned_request) + coverage_gaps tail row
          // [last ingested seq at, drained at].
          const em = typeof d.emitter_id === "string" ? d.emitter_id : row.emitter_id;
          const pend = db
            .query("SELECT request_uid, stable_id FROM requests WHERE origin_emitter_id=? AND state='pending'")
            .all(em) as Array<{ request_uid: string; stable_id: string }>;
          const last = db
            .query("SELECT COALESCE(MAX(seq), 0) AS s, COALESCE(MAX(at), ?) AS a FROM journal WHERE emitter_id=?")
            .get(row.at, em) as { s: number; a: number };
          for (const p of pend) {
            db.query("UPDATE requests SET state='orphaned', resolved_at=? WHERE request_uid=?").run(row.at, p.request_uid);
            setRequestQueue(p.request_uid, queueForRequest("orphaned"), row.at, row.ingest_seq);
            db.query(
              `INSERT INTO coverage_gaps(stable_id, emitter_id, from_seq, from_at, to_at, reason)
               VALUES(?, ?, ?, ?, ?, 'orphaned_request')`,
            ).run(p.stable_id, em, last.s, last.a, row.at);
          }
          break;
        }
        case "attachment_observed": {
          const sid = typeof d.stable_id === "string" ? d.stable_id : row.stable_id;
          if (typeof d.platform === "string" && typeof d.binding === "string") {
            db.query(
              `INSERT INTO attachments(stable_id, platform, binding, observed_at, valid)
               VALUES(?, ?, ?, ?, 1)
               ON CONFLICT(stable_id, platform) DO UPDATE SET binding=excluded.binding, observed_at=excluded.observed_at, valid=1`,
            ).run(sid, d.platform, d.binding, row.at);
          }
          break;
        }
        case "source_outage": {
          if (typeof d.source === "string") {
            db.query(
              `INSERT INTO incidents(source, opened_at) VALUES(?, ?)
               ON CONFLICT(source, opened_at) DO NOTHING`,
            ).run(d.source, row.at);
            // Freeze sessions attached to the outage source (frozen-flag
            // semantics: no per-session judgments from a source while its
            // incident is open).
            db.query(
              `UPDATE current SET frozen=1 WHERE stable_id IN
                (SELECT stable_id FROM attachments WHERE platform=?)`,
            ).run(d.source);
          }
          break;
        }
        case "source_recovered": {
          if (typeof d.source === "string") {
            db.query(
              `UPDATE incidents SET closed_at=? WHERE source=? AND closed_at IS NULL`,
            ).run(row.at, d.source);
            db.query(
              `UPDATE current SET frozen=0 WHERE stable_id IN
                (SELECT stable_id FROM attachments WHERE platform=?)`,
            ).run(d.source);
          }
          break;
        }
        default:
          break;
      }
    }
  });
  tx.immediate();
  return { processed, newTransitions, activated };
}
