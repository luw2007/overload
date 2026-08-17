import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "./server";

const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function seedLedger(): string {
  const root = mkdtempSync(join(tmpdir(), "overload-web-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, origin TEXT, cwd TEXT, branch TEXT, created_at INTEGER, first_seen_at INTEGER);
    CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE requests(request_uid TEXT PRIMARY KEY, stable_id TEXT, writer_id TEXT, origin_emitter_id TEXT, request_id TEXT, kind TEXT, state TEXT, created_at INTEGER, resolved_at INTEGER, detail TEXT);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, at INTEGER, stable_id TEXT, writer_id TEXT, emitter_id TEXT, kind TEXT, detail TEXT);
    CREATE TABLE current(stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT, queue TEXT, q5_reason TEXT, origin TEXT, last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER, frozen INTEGER DEFAULT 0);
    CREATE TABLE notifications(notification_uid INTEGER PRIMARY KEY, request_uid TEXT, sink TEXT, kind TEXT, reminder_seq INTEGER, state TEXT, attempt_at INTEGER, sent_at INTEGER, retry_count INTEGER);
    CREATE TABLE attachments(stable_id TEXT, platform TEXT, binding TEXT, observed_at INTEGER, valid INTEGER);
    CREATE TABLE incidents(id INTEGER PRIMARY KEY, source TEXT, opened_at INTEGER, closed_at INTEGER, detail TEXT);
    CREATE TABLE coverage_gaps(id INTEGER PRIMARY KEY, stable_id TEXT, emitter_id TEXT, from_seq INTEGER, from_at INTEGER, to_at INTEGER, reason TEXT);
  `);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["remote:pi:alpha", "buildbox", "pi", "alpha", "agent", "/repo", "main", 1_700_000_000_000, 1_700_000_000_000]);
  db.run("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)", ["req-1", "remote:pi:alpha", "writer", "emitter", "one", "decision", 1_700_000_001_000, JSON.stringify({ question: "ship?" })]);
  db.run("INSERT INTO notifications VALUES (1, 'req-1', 'osascript', 'initial', 0, 'failed_permanent', NULL, NULL, 6)");
  db.run("INSERT INTO attachments VALUES ('remote:pi:alpha', 'cmux', 'workspace-42', 1700000002000, 1)");
  db.run("INSERT INTO current VALUES ('done:pi:beta', 'writer', 'done', 'q2', NULL, 'agent', 2, 1700000003000, NULL, 0)");
  db.run("INSERT INTO incidents VALUES (1, 'notifier', 1700000004000, NULL, ?)", [JSON.stringify({ retries: 6 })]);
  db.run("INSERT INTO coverage_gaps VALUES (1, 'remote:pi:alpha', 'emitter', 1, 1, 2, 'missing_seq')");
  db.run("INSERT INTO journal VALUES (1, 1700000000000, 'remote:pi:alpha', 'writer', 'emitter', 'telemetry_gap', '{}')");
  db.close();
  return path;
}

async function runningServer(path: string) {
  const server = startWebServer({ ledgerPath: path, port: 0 });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe("web API", () => {
  test("binds loopback and exposes summary counts", async () => {
    const { server, base } = await runningServer(seedLedger());
    expect(server.hostname).toBe("127.0.0.1");
    const response = await fetch(`${base}/api/summary`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ q1: 1, q2: 1, open_incidents: 1, coverage_gaps: 1, telemetry_gaps: 1 });
  });

  test("Q1 JSON preserves the CLI query semantics", async () => {
    const { base } = await runningServer(seedLedger());
    const response = await fetch(`${base}/api/q1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{
      request_uid: "req-1",
      stable_id: "remote:pi:alpha",
      host: "buildbox",
      kind: "decision",
      created_at: 1_700_000_001_000,
      detail: { question: "ship?" },
      failed: true,
      binding: "workspace-42",
    }]);
  });

  test("ack cancels a pending request and is idempotent", async () => {
    const path = seedLedger();
    const { base } = await runningServer(path);
    const first = await fetch(`${base}/api/ack/req-1`, { method: "POST" });
    expect(await first.json()).toEqual({ acked: true });
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT state FROM requests WHERE request_uid='req-1'").get()).toEqual({ state: "cancelled" });
    db.close();
    const second = await fetch(`${base}/api/ack/req-1`, { method: "POST" });
    expect(await second.json()).toEqual({ acked: false });
  });

  test("serves session detail and returns 404 for missing resources", async () => {
    const { base } = await runningServer(seedLedger());
    const detail = await fetch(`${base}/api/sessions/${encodeURIComponent("remote:pi:alpha")}`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).session.stable_id).toBe("remote:pi:alpha");
    expect((await fetch(`${base}/api/sessions/missing`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });
});
