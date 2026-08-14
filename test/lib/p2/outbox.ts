/**
 * §2.5 notification outbox — N8 reference implementation of the FROZEN P2
 * contract (p2-freeze.md protocols 4/5 + docs/plans/…-tech-solution.md §2.5).
 *
 * Frozen semantics this reference pins down (N5 enqueue-side / N7 delivery
 * side must match observably):
 *
 *  - Initial enqueue atomicity: the reducer inserts the notifications(initial,
 *    pending, reminder_seq=0) row in the SAME transaction that sets the
 *    request pending. There is no observable state where the request is
 *    pending and the initial row is missing; a failed txn leaves NEITHER row.
 *  - Reminder anti-storm: single transaction {condition: request pending ∧ no
 *    pending/attempting row for (request_uid, sink) ∧ now ≥
 *    requests.next_reminder_at; action: insert reminder row (reminder_seq =
 *    prev+1) + next_reminder_at = now + REMINDER_INTERVAL_MS}. At most one
 *    reminder per window; UNIQUE(request_uid, sink, kind, reminder_seq) is the
 *    final guard.
 *  - Delivery: txn mark attempting → run sink → txn mark sent. attempting rows
 *    older than ATTEMPTING_RETRY_GRACE_MS are retried. Sink failure: state
 *    back to pending, retry_count++, next attempt gated by SINK_BACKOFF_MIN
 *    (1/5/15/15/15 minutes); the 6th failure → failed_permanent.
 */
import { Database } from "bun:sqlite";
import {
  ATTEMPTING_RETRY_GRACE_MS,
  REMINDER_INTERVAL_MS,
  SINK_BACKOFF_MIN,
} from "../../../src/shared/types";

export interface NewRequest {
  request_uid: string;
  stable_id: string;
  writer_id: string;
  origin_emitter_id: string;
  request_id: string;
  kind?: string;
  detail?: string | null;
}

/**
 * ONE transaction: request row (pending) + notifications(initial, pending,
 * reminder_seq=0). Throws (and rolls back BOTH writes) if any insert fails —
 * e.g. a pre-existing conflicting notification row.
 */
export function insertPendingRequestWithInitial(
  db: Database,
  req: NewRequest,
  sink: string,
  now: number,
): void {
  const tx = db.transaction(() => {
    db.query(
      `INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, detail)
       VALUES(?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ).run(
      req.request_uid,
      req.stable_id,
      req.writer_id,
      req.origin_emitter_id,
      req.request_id,
      req.kind ?? "decision",
      now,
      req.detail ?? null,
    );
    db.query(
      `INSERT INTO notifications(request_uid, sink, kind, reminder_seq, state, attempt_at, retry_count)
       VALUES(?, ?, 'initial', 0, 'pending', NULL, 0)`,
    ).run(req.request_uid, sink);
  });
  tx.immediate();
}

/**
 * Reminder pass for ONE sink: inserts AT MOST ONE reminder row per call when a
 * due request qualifies (anti-storm: the window advance and the insert share a
 * single transaction; the UNIQUE constraint is the final guard). Returns the
 * notification_uid inserted, or null.
 */
export function insertReminderIfDue(
  db: Database,
  sink: string,
  now: number,
): number | null {
  let inserted: number | null = null;
  const tx = db.transaction(() => {
    const due = db
      .query(
        `SELECT r.request_uid FROM requests r
         WHERE r.state='pending'
           AND (r.next_reminder_at IS NULL OR r.next_reminder_at <= ?)
           AND NOT EXISTS (
             SELECT 1 FROM notifications n
             WHERE n.request_uid = r.request_uid AND n.sink = ?
               AND n.state IN ('pending','attempting'))
         ORDER BY r.created_at, r.request_uid LIMIT 1`,
      )
      .get(now, sink) as { request_uid: string } | undefined;
    if (!due) return;
    const prev = db
      .query(
        `SELECT COALESCE(MAX(reminder_seq), 0) AS m FROM notifications
         WHERE request_uid=? AND sink=? AND kind='reminder'`,
      )
      .get(due.request_uid, sink) as { m: number };
    const res = db
      .query(
        `INSERT INTO notifications(request_uid, sink, kind, reminder_seq, state, attempt_at, retry_count)
         VALUES(?, ?, 'reminder', ?, 'pending', NULL, 0)`,
      )
      .run(due.request_uid, sink, prev.m + 1);
    inserted = Number(res.lastInsertRowid);
    db.query("UPDATE requests SET next_reminder_at=? WHERE request_uid=?").run(
      now + REMINDER_INTERVAL_MS,
      due.request_uid,
    );
  });
  tx.immediate();
  return inserted;
}

export type NotificationRow = {
  notification_uid: number;
  request_uid: string;
  sink: string;
  kind: string;
  reminder_seq: number;
  state: string;
  attempt_at: number | null;
  sent_at: number | null;
  retry_count: number;
};

export function getNotification(db: Database, uid: number): NotificationRow | undefined {
  return db.query("SELECT * FROM notifications WHERE notification_uid=?").get(uid) as
    | NotificationRow
    | undefined;
}

export function notificationsFor(db: Database, requestUid: string): NotificationRow[] {
  return db
    .query("SELECT * FROM notifications WHERE request_uid=? ORDER BY notification_uid")
    .all(requestUid) as NotificationRow[];
}

/**
 * Due rows for a delivery pass: pending rows whose attempt_at is unset/past,
 * PLUS attempting rows stuck longer than ATTEMPTING_RETRY_GRACE_MS (crash
 * between the two transactional steps of a previous delivery).
 */
export function pickDueNotifications(db: Database, now: number): number[] {
  const rows = db
    .query(
      `SELECT notification_uid FROM notifications
       WHERE (state='pending' AND (attempt_at IS NULL OR attempt_at <= ?))
          OR (state='attempting' AND attempt_at IS NOT NULL AND attempt_at <= ?)`,
    )
    .all(now, now - ATTEMPTING_RETRY_GRACE_MS) as Array<{ notification_uid: number }>;
  return rows.map((r) => r.notification_uid);
}

/** Txn step 1: mark attempting (attempt_at = attempt start, drives the grace). */
export function markAttempting(db: Database, uid: number, now: number): void {
  const tx = db.transaction(() => {
    db.query(
      `UPDATE notifications SET state='attempting', attempt_at=? WHERE notification_uid=?`,
    ).run(now, uid);
  });
  tx.immediate();
}

/** Txn step 2 (success): mark sent. */
export function markSent(db: Database, uid: number, now: number): void {
  const tx = db.transaction(() => {
    db.query(
      `UPDATE notifications SET state='sent', sent_at=? WHERE notification_uid=?`,
    ).run(now, uid);
  });
  tx.immediate();
}

/** Backoff ms applied after the n-th sink failure (n = 1..5). */
export function backoffMsForFailure(failureCount: number): number {
  if (failureCount < 1 || failureCount > SINK_BACKOFF_MIN.length) {
    throw new RangeError(`failureCount out of schedule: ${failureCount}`);
  }
  return SINK_BACKOFF_MIN[failureCount - 1]! * 60_000;
}

/**
 * Sink failure: retry_count++; after the 6th failure → failed_permanent,
 * otherwise back to pending with attempt_at = now + backoff (frozen schedule).
 */
export function markSinkFailure(db: Database, uid: number, now: number): void {
  const tx = db.transaction(() => {
    const row = db
      .query("SELECT retry_count FROM notifications WHERE notification_uid=?")
      .get(uid) as { retry_count: number } | undefined;
    if (!row) return;
    const n = row.retry_count + 1;
    if (n >= 6) {
      db.query(
        `UPDATE notifications SET state='failed_permanent', retry_count=?, attempt_at=? WHERE notification_uid=?`,
      ).run(n, now, uid);
    } else {
      db.query(
        `UPDATE notifications SET state='pending', retry_count=?, attempt_at=? WHERE notification_uid=?`,
      ).run(n, now + backoffMsForFailure(n), uid);
    }
  });
  tx.immediate();
}
