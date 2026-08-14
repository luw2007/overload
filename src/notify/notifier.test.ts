import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { claimNext, createFileSink, enqueueReminders, markFailed, markSent, pruneObsolete } from "./notifier";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function ledger(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE requests(request_uid TEXT PRIMARY KEY, stable_id TEXT, state TEXT, next_reminder_at INTEGER, detail TEXT);
    CREATE TABLE notifications(notification_uid INTEGER PRIMARY KEY AUTOINCREMENT, request_uid TEXT NOT NULL,
      sink TEXT NOT NULL, kind TEXT NOT NULL, reminder_seq INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
      attempt_at INTEGER, sent_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(request_uid, sink, kind, reminder_seq));
    CREATE TABLE attachments(stable_id TEXT, platform TEXT, binding TEXT, observed_at INTEGER, valid INTEGER DEFAULT 1,
      PRIMARY KEY(stable_id, platform));
  `);
  db.query("INSERT INTO requests VALUES (?, ?, 'pending', ?, ?)").run("req-1", "local:pi:s1", 1_000, JSON.stringify({ summary: "Choose deployment" }));
  db.query("INSERT INTO attachments VALUES (?, ?, ?, ?, 1)").run("local:pi:s1", "herdr", "herdr agent focus abc", 900);
  return db;
}

describe("notifier outbox", () => {
  test("claims a pending delivery and sends one JSON line with context", async () => {
    const db = ledger();
    db.query("INSERT INTO notifications(request_uid,sink,kind,state) VALUES (?,?,'initial','pending')").run("req-1", "file:test");
    const row = claimNext(db, "file:test", 2_000);
    expect(row?.state).toBe("attempting");
    expect(row?.summary).toBe("Choose deployment");
    expect(row?.binding).toBe("herdr agent focus abc");

    const root = await mkdtemp(join(tmpdir(), "overload-notify-")); roots.push(root);
    await createFileSink(join(root, "deliveries.ndjson")).deliver(row!);
    markSent(db, row!.notification_uid, 2_001);
    expect(db.query("SELECT state,sent_at FROM notifications").get()).toEqual({ state: "sent", sent_at: 2_001 });
    expect(JSON.parse((await readFile(join(root, "deliveries.ndjson"), "utf8")).trim()).request_uid).toBe("req-1");
    db.close();
  });

  test("prunes undelivered notifications for requests that are no longer pending", () => {
    const db = ledger();
    db.query("INSERT INTO requests VALUES (?, ?, 'resolved', NULL, '{}')").run("req-2", "local:pi:s2");
    db.query("INSERT INTO requests VALUES (?, ?, 'orphaned', NULL, '{}')").run("req-3", "local:pi:s3");
    for (const uid of ["req-1", "req-2", "req-3"]) {
      db.query("INSERT INTO notifications(request_uid,sink,kind,state) VALUES (?,?,'initial','pending')").run(uid, "file:test");
    }
    db.query("INSERT INTO notifications(request_uid,sink,kind,state,sent_at) VALUES (?,?,'reminder','sent',5)").run("req-2", "file:test");

    expect(pruneObsolete(db)).toBe(2);
    // Pending request keeps its queue entry; delivered history rows survive.
    const rows = db.query("SELECT request_uid, state FROM notifications ORDER BY notification_uid").all();
    expect(rows).toEqual([
      { request_uid: "req-1", state: "pending" },
      { request_uid: "req-2", state: "sent" },
    ]);
    db.close();
  });

  test("reclaims stale attempting rows but not fresh ones", () => {
    const db = ledger();
    db.query("INSERT INTO notifications(request_uid,sink,kind,state,attempt_at) VALUES (?,?,'initial','attempting',?)")
      .run("req-1", "file:test", 10_000);
    expect(claimNext(db, "file:test", 39_999)).toBeNull();
    expect(claimNext(db, "file:test", 40_000)?.notification_uid).toBe(1);
    db.close();
  });

  test("backs off five failures and makes the sixth permanent", () => {
    const db = ledger();
    db.query("INSERT INTO notifications(request_uid,sink,kind,state) VALUES (?,?,'initial','pending')").run("req-1", "file:test");
    const expected = [60_000, 300_000, 900_000, 900_000, 900_000];
    for (let failure = 1; failure <= 6; failure++) {
      const now = failure * 1_000_000;
      const row = claimNext(db, "file:test", now)!;
      markFailed(db, row.notification_uid, now);
      const stored = db.query("SELECT state,retry_count,attempt_at FROM notifications").get() as Record<string, number | string | null>;
      expect(stored.retry_count).toBe(failure);
      if (failure < 6) {
        expect(stored.state).toBe("pending");
        expect(stored.attempt_at).toBe(now + expected[failure - 1]);
        db.query("UPDATE notifications SET attempt_at=?").run((stored.attempt_at as number) - 1);
      } else {
        expect(stored.state).toBe("failed_permanent");
        expect(stored.attempt_at).toBe(now);
      }
    }
    db.close();
  });

  test("inserts one due reminder per sink and advances its window", () => {
    const db = ledger();
    db.query("INSERT INTO notifications(request_uid,sink,kind,reminder_seq,state) VALUES (?,?,'initial',0,'sent')").run("req-1", "file:test");
    expect(enqueueReminders(db, 1_000)).toBe(1);
    expect(enqueueReminders(db, 1_000)).toBe(0);
    expect(db.query("SELECT kind,reminder_seq,state FROM notifications WHERE kind='reminder'").get())
      .toEqual({ kind: "reminder", reminder_seq: 1, state: "pending" });
    expect(db.query("SELECT next_reminder_at FROM requests").get()).toEqual({ next_reminder_at: 901_000 });
    db.close();
  });
});
