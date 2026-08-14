/**
 * test/p2-outbox.test.ts — notification outbox semantics against the FROZEN P2
 * contract (p2-freeze.md protocols 4/5, tech-solution §2.5).
 *
 * Two layers:
 *  - CONTRACT (always runs): drives the N8 reference outbox
 *    (test/lib/p2/outbox.ts) over the frozen DDL (test/lib/p2/schema.ts).
 *    Must pass BEFORE N5/N6/N7 merge.
 *  - REAL (explicit SKIP until the entry exists): spawns N7's notifier
 *    (`src/notify/notifier.ts --once --ledger <db> --sink file:<path>`)
 *    against a crafted ledger. Activates once node/n7 lands.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openLedgerP2 } from "./lib/p2/schema";
import {
  ATTEMPTING_RETRY_GRACE_MS,
  REMINDER_INTERVAL_MS,
  SINK_BACKOFF_MIN,
} from "../src/shared/types";
import {
  backoffMsForFailure,
  getNotification,
  insertPendingRequestWithInitial,
  insertReminderIfDue,
  markAttempting,
  markSent,
  markSinkFailure,
  notificationsFor,
  pickDueNotifications,
} from "./lib/p2/outbox";
import { makeTempDir, cleanupTempDir, nextCounter } from "./lib/util";

const REPO = process.cwd();
const N7_NOTIFIER = join(REPO, "src/notify/notifier.ts");
const HAS_N7 = existsSync(N7_NOTIFIER);

// ─── CONTRACT LAYER ─────────────────────────────────────────────────────────

let db: Database;
let root: string;
const NOW = 1_800_000_000_000;
const SINK = "file:/tmp/does-not-matter";

beforeEach(() => {
  root = makeTempDir(`n8-obx-${nextCounter()}`);
  db = openLedgerP2(join(root, "ledger.db"));
});
afterEach(() => {
  try { db.close(); } catch { /* */ }
  cleanupTempDir(root);
});

let uid = 0;
function newRequest(suffix = String(++uid)) {
  return {
    request_uid: `local:pi:s#${suffix}#req-${suffix}`,
    stable_id: "local:pi:s",
    writer_id: "pi-1-aaaa0001",
    origin_emitter_id: "pi-1-aaaa0001",
    request_id: `req-${suffix}`,
  };
}

describe("contract: same-transaction initial enqueue (protocol 4)", () => {
  test("a pending request row implies its initial notification row, atomically", () => {
    const r = newRequest();
    insertPendingRequestWithInitial(db, r, SINK, NOW);
    const req = db.query("SELECT state FROM requests WHERE request_uid=?").get(r.request_uid) as { state: string };
    expect(req.state).toBe("pending");
    const rows = notificationsFor(db, r.request_uid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "initial", reminder_seq: 0, state: "pending", retry_count: 0 });
    expect(rows[0]!.attempt_at).toBeNull();
  });

  test("a failed transaction leaves NEITHER row (no pending request without its notification)", () => {
    const r = newRequest();
    // Pre-seed a conflicting initial row → the txn's notification insert fails
    // → the whole txn (including the request insert) rolls back.
    db.query(
      `INSERT INTO notifications(request_uid, sink, kind, reminder_seq, state) VALUES(?, ?, 'initial', 0, 'sent')`,
    ).run(r.request_uid, SINK);
    expect(() => insertPendingRequestWithInitial(db, r, SINK, NOW)).toThrow();
    const req = db.query("SELECT state FROM requests WHERE request_uid=?").get(r.request_uid);
    expect(req).toBeNull(); // rolled back together — NEITHER row survived
    const rows = notificationsFor(db, r.request_uid);
    expect(rows).toHaveLength(1); // only the pre-seeded row
  });

  test("UNIQUE(request_uid, sink, kind, reminder_seq) is the final duplicate guard", () => {
    const r = newRequest();
    insertPendingRequestWithInitial(db, r, SINK, NOW);
    let threw = false;
    try {
      db.query(
        `INSERT INTO notifications(request_uid, sink, kind, reminder_seq, state) VALUES(?, ?, 'initial', 0, 'pending')`,
      ).run(r.request_uid, SINK);
    } catch (e) {
      threw = /UNIQUE/i.test(String((e as Error).message));
    }
    expect(threw).toBe(true);
  });
});

describe("contract: reminder anti-storm (protocol 4, reminder side)", () => {
  test("repeated passes within the window insert at most ONE reminder", () => {
    const r = newRequest();
    insertPendingRequestWithInitial(db, r, SINK, NOW);
    markSent(db, notificationsFor(db, r.request_uid)[0]!.notification_uid, NOW); // initial delivered
    db.query("UPDATE requests SET next_reminder_at=? WHERE request_uid=?").run(NOW - 1, r.request_uid);

    expect(insertReminderIfDue(db, SINK, NOW)).not.toBeNull();
    expect(insertReminderIfDue(db, SINK, NOW + 1_000)).toBeNull();
    expect(insertReminderIfDue(db, SINK, NOW + 60_000)).toBeNull();
    expect(insertReminderIfDue(db, SINK, NOW + REMINDER_INTERVAL_MS - 1)).toBeNull();
    const reminders = notificationsFor(db, r.request_uid).filter((n) => n.kind === "reminder");
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.reminder_seq).toBe(1);
    expect(reminders[0]!.state).toBe("pending");

    // The undelivered reminder BLOCKS further inserts even past the window
    // ("no pending/attempting row" clause) — deliver it, and only then does
    // the next window open for reminder_seq=2.
    expect(insertReminderIfDue(db, SINK, NOW + REMINDER_INTERVAL_MS + 1)).toBeNull();
    markSent(db, reminders[0]!.notification_uid, NOW + REMINDER_INTERVAL_MS + 2);
    expect(insertReminderIfDue(db, SINK, NOW + REMINDER_INTERVAL_MS + 3)).not.toBeNull();
    const reminders2 = notificationsFor(db, r.request_uid).filter((n) => n.kind === "reminder");
    expect(reminders2).toHaveLength(2);
    expect(reminders2[1]!.reminder_seq).toBe(2);
  });

  test("an undelivered (pending/attempting) notification row BLOCKS new reminders", () => {
    const r = newRequest();
    insertPendingRequestWithInitial(db, r, SINK, NOW); // initial still pending
    db.query("UPDATE requests SET next_reminder_at=NULL WHERE request_uid=?").run(r.request_uid);
    expect(insertReminderIfDue(db, SINK, NOW)).toBeNull();

    const r2 = newRequest();
    insertPendingRequestWithInitial(db, r2, SINK, NOW);
    markAttempting(db, notificationsFor(db, r2.request_uid)[0]!.notification_uid, NOW);
    expect(insertReminderIfDue(db, SINK, NOW)).toBeNull();
    expect(notificationsFor(db, r2.request_uid)).toHaveLength(1);
  });

  test("non-pending requests never get reminders", () => {
    const r = newRequest();
    insertPendingRequestWithInitial(db, r, SINK, NOW);
    markSent(db, notificationsFor(db, r.request_uid)[0]!.notification_uid, NOW);
    db.query("UPDATE requests SET state='resolved' WHERE request_uid=?").run(r.request_uid);
    db.query("UPDATE requests SET next_reminder_at=NULL WHERE request_uid=?").run(r.request_uid);
    expect(insertReminderIfDue(db, SINK, NOW)).toBeNull();
  });
});

describe("contract: delivery, grace retry, backoff schedule, failed_permanent (protocol 5)", () => {
  function freshPendingRow() {
    const r = newRequest();
    insertPendingRequestWithInitial(db, r, SINK, NOW);
    return notificationsFor(db, r.request_uid)[0]!.notification_uid;
  }

  test("pending row is due immediately; attempting row retries only after the grace", () => {
    const n1 = freshPendingRow();
    expect(pickDueNotifications(db, NOW)).toContain(n1);

    markAttempting(db, n1, NOW);
    expect(pickDueNotifications(db, NOW + ATTEMPTING_RETRY_GRACE_MS - 1)).not.toContain(n1);
    expect(pickDueNotifications(db, NOW + ATTEMPTING_RETRY_GRACE_MS + 1)).toContain(n1);
  });

  test("attempting → sent is the happy path; sent rows are never re-picked", () => {
    const n = freshPendingRow();
    markAttempting(db, n, NOW);
    markSent(db, n, NOW + 5);
    const row = getNotification(db, n)!;
    expect(row.state).toBe("sent");
    expect(row.sent_at).toBe(NOW + 5);
    expect(pickDueNotifications(db, NOW + 10_000)).not.toContain(n);
  });

  test("backoff schedule is exactly SINK_BACKOFF_MIN minutes per failure", () => {
    expect(SINK_BACKOFF_MIN).toEqual([1, 5, 15, 15, 15]);
    expect(backoffMsForFailure(1)).toBe(60_000);
    expect(backoffMsForFailure(2)).toBe(300_000);
    expect(backoffMsForFailure(3)).toBe(900_000);
    expect(backoffMsForFailure(4)).toBe(900_000);
    expect(backoffMsForFailure(5)).toBe(900_000);
    expect(() => backoffMsForFailure(6)).toThrow();
  });

  test("failures 1..5 bounce pending with escalating attempt_at; 6th → failed_permanent", () => {
    const n = freshPendingRow();
    const t0 = NOW;
    const schedule = SINK_BACKOFF_MIN.map((m) => m * 60_000);
    for (let i = 1; i <= 5; i++) {
      markAttempting(db, n, t0 + i);
      markSinkFailure(db, n, t0 + i);
      const row = getNotification(db, n)!;
      expect(row.state).toBe("pending");
      expect(row.retry_count).toBe(i);
      expect(row.attempt_at).toBe(t0 + i + schedule[i - 1]!);
      // The backoff gate actually defers the next attempt.
      expect(pickDueNotifications(db, t0 + i + schedule[i - 1]! - 1)).not.toContain(n);
      expect(pickDueNotifications(db, t0 + i + schedule[i - 1]! + 1)).toContain(n);
    }
    // 6th failure → terminal failure state (persistent alert surface).
    markAttempting(db, n, t0 + 6);
    markSinkFailure(db, n, t0 + 6);
    const row = getNotification(db, n)!;
    expect(row.state).toBe("failed_permanent");
    expect(row.retry_count).toBe(6);
    expect(pickDueNotifications(db, t0 + 999_999)).not.toContain(n);
  });
});

// ─── REAL LAYER (explicit SKIP until node/n7 lands) ─────────────────────────

test("entry inventory: notifier entry exists on this tree", () => {
  console.log(`[n8] real-layer entry: src/notify/notifier.ts=${existsSync(N7_NOTIFIER)} ` +
    `(real-layer tests ${HAS_N7 ? "ACTIVE" : "SKIPPED until N7 merges"})`);
  expect(true).toBe(true);
});

describe.skipIf(!HAS_N7)("real: N7 notifier --once --sink file:<path>", () => {
  let rootReal: string;
  let ledger: string;
  let sinkFile: string;
  let roDir: string;

  beforeEach(() => {
    rootReal = makeTempDir(`n8-obx-real-${nextCounter()}`);
    ledger = join(rootReal, "ledger.db");
    sinkFile = join(rootReal, "sink.out");
    roDir = join(rootReal, "ro");
    mkdirSync(roDir, { recursive: true });
    Bun.spawnSync(["chmod", "500", roDir]);
  });
  afterEach(() => {
    try { Bun.spawnSync(["chmod", "700", roDir]); } catch { /* */ }
    cleanupTempDir(rootReal);
  });

  function craftPendingRequest(suffix: string): { requestUid: string; notifUid: number } {
    const db = openLedgerP2(ledger);
    const r = {
      request_uid: `local:pi:s#${suffix}#req-${suffix}`,
      stable_id: "local:pi:s",
      writer_id: "pi-1-aaaa0001",
      origin_emitter_id: "pi-1-aaaa0001",
      request_id: `req-${suffix}`,
    };
    insertPendingRequestWithInitial(db, r, `file:${sinkFile}`, NOW);
    const row = db.query("SELECT notification_uid FROM notifications WHERE request_uid=?").get(r.request_uid) as
      | { notification_uid: number }
      | undefined;
    db.close();
    return { requestUid: r.request_uid, notifUid: row!.notification_uid };
  }

  async function runNotifier(sink: string): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", N7_NOTIFIER, "--once", "--ledger", ledger, "--sink", sink], {
      cwd: REPO,
      env: { ...process.env, HOME: rootReal },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return { code: proc.exitCode, out, err };
  }

  function notifRow(notifUid: number) {
    const db = new Database(ledger);
    try {
      return db.query("SELECT * FROM notifications WHERE notification_uid=?").get(notifUid) as {
        state: string; retry_count: number; attempt_at: number | null; sent_at: number | null;
      };
    } finally {
      db.close();
    }
  }

  test("pending initial → attempting → sent with one file-sink line", async () => {
    const { notifUid, requestUid } = craftPendingRequest("r1");
    const res = await runNotifier(`file:${sinkFile}`);
    expect(res.code).toBe(0);
    const row = notifRow(notifUid);
    expect(row.state).toBe("sent");
    expect(row.sent_at).not.toBeNull();
    const lines = readFileSync(sinkFile, "utf8").split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(requestUid);
  });

  test("crash-between-steps state (stale attempting) retries after the grace and does not duplicate the initial row", async () => {
    const { notifUid, requestUid } = craftPendingRequest("r2");
    // Persisted state after a kill between "txn mark attempting" and
    // "txn mark sent": attempting with attempt_at older than the grace.
    const db = new Database(ledger);
    db.query("UPDATE notifications SET state='attempting', attempt_at=? WHERE notification_uid=?")
      .run(Date.now() - ATTEMPTING_RETRY_GRACE_MS - 30_000, notifUid);
    db.close();

    const res = await runNotifier(`file:${sinkFile}`);
    expect(res.code).toBe(0);
    expect(notifRow(notifUid).state).toBe("sent");

    const db2 = new Database(ledger);
    const initials = db2.query(
      "SELECT COUNT(*) AS n FROM notifications WHERE request_uid=? AND kind='initial'",
    ).get(requestUid) as { n: number };
    db2.close();
    expect(initials.n).toBe(1); // UNIQUE backstop — no duplicate initial row
  });

  test("reminder anti-storm across repeated --once passes within one window", async () => {
    const { notifUid, requestUid } = craftPendingRequest("r3");
    // Initial already delivered → reminder eligible when the window opens.
    const db = new Database(ledger);
    db.query("UPDATE notifications SET state='sent', sent_at=? WHERE notification_uid=?").run(Date.now() - 1, notifUid);
    db.query("UPDATE requests SET next_reminder_at=? WHERE request_uid=?").run(Date.now() - 1, requestUid);
    db.close();

    await runNotifier(`file:${sinkFile}`);
    await runNotifier(`file:${sinkFile}`);
    await runNotifier(`file:${sinkFile}`);

    const db2 = new Database(ledger);
    const reminders = db2.query(
      "SELECT COUNT(*) AS n FROM notifications WHERE request_uid=? AND kind='reminder'",
    ).get(requestUid) as { n: number };
    db2.close();
    expect(reminders.n).toBeLessThanOrEqual(1);
    expect(reminders.n).toBe(1);
  });

  test("forced sink failure: backoff-gated retries then failed_permanent on the 6th", async () => {
    const { notifUid } = craftPendingRequest("r4");
    const badSink = `file:${join(roDir, "sink.out")}`;
    const windows: Array<[number, number, number]> = [];
    for (let i = 1; i <= 6; i++) {
      const t0 = Date.now();
      const res = await runNotifier(badSink);
      const t1 = Date.now();
      expect(res.code).toBe(0); // sink errors must never crash the pass
      const row = notifRow(notifUid);
      if (i <= 5) {
        expect(row.state).toBe("pending");
        expect(row.retry_count).toBe(i);
        expect(row.attempt_at).not.toBeNull();
        const backoff = SINK_BACKOFF_MIN[i - 1]! * 60_000;
        expect(row.attempt_at!).toBeGreaterThanOrEqual(t0 + backoff);
        expect(row.attempt_at!).toBeLessThanOrEqual(t1 + backoff);
        windows.push([t0, t1, row.attempt_at!]);
        // Age the schedule so the next pass is due (deterministic time control).
        const db = new Database(ledger);
        db.query("UPDATE notifications SET attempt_at=? WHERE notification_uid=?").run(Date.now() - 1, notifUid);
        db.close();
      } else {
        expect(row.state).toBe("failed_permanent");
        expect(row.retry_count).toBeGreaterThanOrEqual(6);
      }
    }
    expect(windows).toHaveLength(5);
    expect(existsSync(join(roDir, "sink.out"))).toBe(false);
  }, 60_000);
});
