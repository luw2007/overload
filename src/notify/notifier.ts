#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ATTEMPTING_RETRY_GRACE_MS,
  REMINDER_INTERVAL_MS,
  SINK_BACKOFF_MIN,
  type NotificationKind,
  type NotificationState,
} from "../shared/types";
import { openLedger } from "../ingest/ingest";

const DEFAULT_NOTIFY_INTERVAL_MS = 5_000;
const MAX_FAILURES = SINK_BACKOFF_MIN.length + 1;

export interface NotificationRow {
  notification_uid: number;
  request_uid: string;
  sink: string;
  kind: NotificationKind;
  reminder_seq: number;
  state: NotificationState;
  attempt_at: number | null;
  sent_at: number | null;
  retry_count: number;
  stable_id: string | null;
  summary: string;
  binding: string | null;
}

export interface NotificationSink {
  deliver(notification: NotificationRow): Promise<void>;
}

export function claimNext(db: Database, sink: string, now = Date.now()): NotificationRow | null {
  let claimed: NotificationRow | null = null;
  db.transaction(() => {
    const candidate = db.query(`SELECT notification_uid FROM notifications
      WHERE sink=? AND ((state='pending' AND (attempt_at IS NULL OR attempt_at<=?))
        OR (state='attempting' AND attempt_at<=?))
      ORDER BY notification_uid LIMIT 1`).get(sink, now, now - ATTEMPTING_RETRY_GRACE_MS) as { notification_uid: number } | null;
    if (!candidate) return;
    db.query("UPDATE notifications SET state='attempting', attempt_at=? WHERE notification_uid=?")
      .run(now, candidate.notification_uid);
    claimed = readNotification(db, candidate.notification_uid);
  }).immediate();
  return claimed;
}

function readNotification(db: Database, uid: number): NotificationRow {
  const raw = db.query(`SELECT n.*, r.stable_id, r.detail,
      (SELECT binding FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1
        ORDER BY a.observed_at DESC LIMIT 1) AS binding
    FROM notifications n JOIN requests r ON r.request_uid=n.request_uid
    WHERE n.notification_uid=?`).get(uid) as Record<string, unknown> | null;
  if (!raw) throw new Error(`notification ${uid} disappeared after claim`);
  let detail: Record<string, unknown> = {};
  try {
    const parsed = typeof raw.detail === "string" ? JSON.parse(raw.detail) : {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) detail = parsed;
  } catch { /* Malformed request detail is displayed using the request id. */ }
  const summaryValue = detail.summary ?? detail.preview ?? detail.question ?? detail.message;
  const summary = typeof summaryValue === "string" && summaryValue.trim()
    ? summaryValue.trim() : String(raw.request_uid);
  return { ...raw, summary, detail: undefined } as unknown as NotificationRow;
}

export function markSent(db: Database, uid: number, now = Date.now()): void {
  db.transaction(() => {
    db.query("UPDATE notifications SET state='sent', sent_at=? WHERE notification_uid=? AND state='attempting'")
      .run(now, uid);
  }).immediate();
}

export function markFailed(db: Database, uid: number, now = Date.now()): void {
  db.transaction(() => {
    const row = db.query("SELECT retry_count FROM notifications WHERE notification_uid=? AND state='attempting'")
      .get(uid) as { retry_count: number } | null;
    if (!row) return;
    const failures = row.retry_count + 1;
    if (failures >= MAX_FAILURES) {
      db.query("UPDATE notifications SET state='failed_permanent', retry_count=?, attempt_at=? WHERE notification_uid=?")
        .run(failures, now, uid);
      return;
    }
    const delay = SINK_BACKOFF_MIN[failures - 1] * 60_000;
    db.query("UPDATE notifications SET state='pending', retry_count=?, attempt_at=? WHERE notification_uid=?")
      .run(failures, now + delay, uid);
  }).immediate();
}

export function enqueueReminders(db: Database, now = Date.now()): number {
  let inserted = 0;
  db.transaction(() => {
    const due = db.query(`SELECT r.request_uid, n.sink,
        COALESCE(MAX(CASE WHEN n.kind='reminder' THEN n.reminder_seq END), 0) AS previous_seq
      FROM requests r JOIN notifications n ON n.request_uid=r.request_uid
      WHERE r.state='pending' AND r.next_reminder_at IS NOT NULL AND r.next_reminder_at<=?
      GROUP BY r.request_uid, n.sink
      HAVING SUM(CASE WHEN n.state IN ('pending','attempting') THEN 1 ELSE 0 END)=0`)
      .all(now) as Array<{ request_uid: string; sink: string; previous_seq: number }>;
    for (const row of due) {
      const result = db.query(`INSERT OR IGNORE INTO notifications
        (request_uid,sink,kind,reminder_seq,state) VALUES (?,?,'reminder',?,'pending')`)
        .run(row.request_uid, row.sink, row.previous_seq + 1);
      if (Number(result.changes) === 0) continue;
      db.query("UPDATE requests SET next_reminder_at=next_reminder_at+? WHERE request_uid=?")
        .run(REMINDER_INTERVAL_MS, row.request_uid);
      inserted++;
    }
  }).immediate();
  return inserted;
}

export function createFileSink(path: string): NotificationSink {
  return {
    async deliver(notification) {
      const line = JSON.stringify({
        notification_uid: notification.notification_uid,
        request_uid: notification.request_uid,
        kind: notification.kind,
        reminder_seq: notification.reminder_seq,
        summary: notification.summary,
        binding: notification.binding,
      });
      await appendFile(path, `${line}\n`, { encoding: "utf8", mode: 0o600 });
    },
  };
}

export function createOsascriptSink(): NotificationSink {
  return {
    async deliver(notification) {
      const body = notification.binding
        ? `${notification.summary}\n${notification.binding}` : notification.summary;
      const script = `on run argv
  display notification (item 1 of argv) with title "Overload"
end run`;
      const process = Bun.spawn(["osascript", "-e", script, body], { stdout: "ignore", stderr: "pipe" });
      const stderr = await new Response(process.stderr).text();
      const status = await process.exited;
      if (status !== 0) throw new Error(`osascript exited ${status}: ${stderr.trim()}`);
    },
  };
}

/** Drop undelivered notifications whose request is no longer pending: delivering
 *  them would notify about already-answered or orphaned asks (loop-1 E2). The
 *  requests journal keeps the truth; the outbox row has no remaining purpose. */
export function pruneObsolete(db: Database): number {
  let removed = 0;
  db.transaction(() => {
    const result = db.query(`DELETE FROM notifications WHERE state IN ('pending','attempting')
      AND request_uid IN (SELECT request_uid FROM requests WHERE state!='pending')`).run();
    removed = Number(result.changes);
  }).immediate();
  return removed;
}

export async function runOnce(db: Database, sinkName: string, sink: NotificationSink, now = Date.now()): Promise<number> {
  pruneObsolete(db);
  enqueueReminders(db, now);
  let delivered = 0;
  for (;;) {
    const row = claimNext(db, sinkName, now);
    if (!row) return delivered;
    try {
      await sink.deliver(row);
      markSent(db, row.notification_uid, Date.now());
      delivered++;
    } catch (error) {
      markFailed(db, row.notification_uid, Date.now());
      console.error(`overload notifier: delivery ${row.notification_uid} failed: ${errorMessage(error)}`);
    }
  }
}

async function loadNotifyInterval(path: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const value = parsed.notify_interval_ms;
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
      ? value : DEFAULT_NOTIFY_INTERVAL_MS;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      console.error(`overload notifier: ignoring invalid config ${path}`);
    return DEFAULT_NOTIFY_INTERVAL_MS;
  }
}

function parseArgs(args: string[]): { once: boolean; ledger: string; sinkName: string; sink: NotificationSink } {
  let once = false;
  let ledger = join(homedir(), ".overload", "ledger.db");
  let sinkValue = "osascript";
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === "--once" && !once) once = true;
    else if (argument === "--ledger" && args[index + 1]) ledger = args[++index];
    else if (argument === "--sink" && args[index + 1]) sinkValue = args[++index];
    else throw new Error("usage: bun src/notify/notifier.ts [--once] [--ledger PATH] [--sink osascript|file:PATH]");
  }
  if (sinkValue === "osascript") return { once, ledger, sinkName: sinkValue, sink: createOsascriptSink() };
  if (sinkValue.startsWith("file:") && sinkValue.length > 5)
    return { once, ledger, sinkName: sinkValue, sink: createFileSink(sinkValue.slice(5)) };
  throw new Error("--sink must be osascript or file:PATH");
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

async function main(): Promise<void> {
  process.umask(0o077);
  let options;
  try { options = parseArgs(Bun.argv.slice(2)); }
  catch (error) { console.error(errorMessage(error)); process.exit(2); }
  const db = await openLedger(options.ledger);
  const interval = await loadNotifyInterval(join(homedir(), ".overload", "config.json"));
  try {
    do {
      await runOnce(db, options.sinkName, options.sink);
      if (!options.once) await Bun.sleep(interval);
    } while (!options.once);
  } finally { db.close(); }
}

if (import.meta.main) await main();
