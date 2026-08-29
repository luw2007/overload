/**
 * test/notify-nudge.test.ts — P5 recall-nudge contract (src/notify/nudge.ts):
 * exactly one aggregated notification per empty→non-empty Now transition.
 * Runs the real ledger DDL (src/ingest/schema.sql) on a temp file so the
 * production Now-count query and this test cannot drift apart.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { nudgeOnce } from "../src/notify/nudge";

const SCHEMA_SQL = readFileSync(join(process.cwd(), "src/ingest/schema.sql"), "utf8");

let dir: string;
let ledgerPath: string;
let statePath: string;
let sent: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nudge-"));
  ledgerPath = join(dir, "ledger.db");
  statePath = join(dir, "nudge.state");
  const db = new Database(ledgerPath);
  db.exec(SCHEMA_SQL);
  db.close();
  sent = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run() {
  return nudgeOnce({ ledgerPath, statePath, notify: async (message) => { sent.push(message); } });
}

function addPendingRequest(uid: string): void {
  const db = new Database(ledgerPath);
  const now = Date.now();
  db.query(`INSERT INTO sessions(stable_id, host, runtime, session, origin, created_at, first_seen_at)
    VALUES (?, 'local', 'pi', ?, 'unknown', ?, ?)`).run(uid, uid, now, now);
  db.query(`INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, detail)
    VALUES (?, ?, 'w1', 'e1', ?, 'ask', 'pending', ?, NULL)`).run(uid, uid, uid, now);
  db.close();
}

describe("nudgeOnce", () => {
  test("empty Now: no notification, no state churn", async () => {
    const first = await run();
    expect(first).toEqual({ count: 0, notified: false });
    expect(sent).toEqual([]);
  });

  test("empty→non-empty notifies once with the aggregated count", async () => {
    await run();
    addPendingRequest("r1");
    addPendingRequest("r2");
    const result = await run();
    expect(result).toEqual({ count: 2, notified: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("2 项待处理");
    expect(sent[0]).toContain("http://127.0.0.1:4870/now");
  });

  test("non-empty→still non-empty stays silent even when the count grows", async () => {
    addPendingRequest("r1");
    await run(); // notifies, persists 1
    addPendingRequest("r2");
    const result = await run();
    expect(result).toEqual({ count: 2, notified: false });
    expect(sent).toHaveLength(1);
  });

  test("draining to empty re-arms the nudge", async () => {
    addPendingRequest("r1");
    await run();
    const db = new Database(ledgerPath);
    db.query("UPDATE requests SET state='acked'").run();
    db.close();
    const drained = await run();
    expect(drained).toEqual({ count: 0, notified: false });
    addPendingRequest("r2");
    const rearmed = await run();
    expect(rearmed.notified).toBe(true);
    expect(sent).toHaveLength(2);
  });

  test("corrupt state file reads as empty and does not crash", async () => {
    writeFileSync(statePath, "not-a-number\n");
    addPendingRequest("r1");
    const result = await run();
    expect(result).toEqual({ count: 1, notified: true });
  });
});
