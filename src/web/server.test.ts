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
  const now = Date.now();
  const root = mkdtempSync(join(tmpdir(), "overload-web-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, origin TEXT, cwd TEXT, branch TEXT, created_at INTEGER, first_seen_at INTEGER);
    CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE requests(request_uid TEXT PRIMARY KEY, stable_id TEXT, writer_id TEXT, origin_emitter_id TEXT, request_id TEXT, kind TEXT, state TEXT, created_at INTEGER, resolved_at INTEGER, detail TEXT);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, at INTEGER, stable_id TEXT, writer_id TEXT, emitter_id TEXT, kind TEXT, detail TEXT);
    CREATE TABLE current(stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT, queue TEXT, q5_reason TEXT, origin TEXT, last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER, last_progress_at INTEGER, frozen INTEGER DEFAULT 0);
    CREATE TABLE attachments(stable_id TEXT, platform TEXT, binding TEXT, observed_at INTEGER, valid INTEGER);
    CREATE TABLE session_hosts(stable_id TEXT PRIMARY KEY, app TEXT, session_id TEXT, tty TEXT, observed_at INTEGER);
    CREATE TABLE incidents(id INTEGER PRIMARY KEY, source TEXT, opened_at INTEGER, closed_at INTEGER, detail TEXT);
    CREATE TABLE coverage_gaps(id INTEGER PRIMARY KEY, stable_id TEXT, emitter_id TEXT, from_seq INTEGER, from_at INTEGER, to_at INTEGER, reason TEXT);
  `);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["remote:pi:alpha", "buildbox", "pi", "alpha", "agent", "/repo", "main", 1_700_000_000_000, 1_700_000_000_000]);
  db.run("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)", ["req-1", "remote:pi:alpha", "writer", "emitter", "one", "decision", 1_700_000_001_000, JSON.stringify({ question: "ship?" })]);
  db.run("INSERT INTO attachments VALUES ('remote:pi:alpha', 'cmux', 'workspace-42', 1700000002000, 1)");
  db.run("INSERT INTO session_hosts VALUES ('remote:pi:alpha', 'cmux', 'terminal-7', '/dev/ttys007', 1700000003000)");
  db.run("INSERT INTO current VALUES ('done:pi:beta', 'writer', 'done', 'q2', NULL, 'agent', 2, 1700000003000, NULL, NULL, 0)");
  db.run("INSERT INTO incidents VALUES (1, 'recon', 1700000004000, NULL, ?)", [JSON.stringify({ reason: "adapter unavailable" })]);
  db.run("INSERT INTO coverage_gaps VALUES (1, 'remote:pi:alpha', 'emitter', 1, ?, ?, 'missing_seq')", [now - 60_000, now]);
  db.run("INSERT INTO journal VALUES (1, ?, 'remote:pi:alpha', 'writer', 'emitter', 'telemetry_gap', ?)", [now - 60_000, JSON.stringify({ platform: "cmux", native_id: "term-9" })]);
  db.run("INSERT INTO current VALUES ('remote:pi:alpha', 'writer', 'working', 'q5', 'turn_hung', 'agent', 9, 1700000009000, 1700000009000, 1700000005000, 0)");
  db.run("INSERT INTO journal VALUES (2, 1700000005000, 'remote:pi:alpha', 'writer', 'emitter', 'tool_activity', ?)", [JSON.stringify({ tool: "bash" })]);
  db.run("INSERT INTO journal VALUES (3, 1700000009000, 'remote:pi:alpha', 'writer', 'emitter', 'heartbeat', '{}')");
  db.close();
  return path;
}

async function runningServer(path: string, jump?: (target: { source: "host" | "attachment"; platform: string | null; binding: string | null; tty: string | null; host: string | null }) => Promise<{ opened: boolean }>) {
  const server = startWebServer({ ledgerPath: path, port: 0, jump });
  servers.push(server);
  return { server, base: `http://127.0.0.1:${server.port}` };
}

describe("web API", () => {
  test("binds loopback and exposes summary counts", async () => {
    const { server, base } = await runningServer(seedLedger());
    expect(server.hostname).toBe("127.0.0.1");
    const response = await fetch(`${base}/api/summary`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ q1: 1, q2: 1, hung: 1, open_incidents: 1, coverage_gaps: 1, telemetry_gaps: 1 });
  });

  test("separates unproven completed sessions into archive", async () => {
    const path = seedLedger();
    const db = new Database(path);
    db.run("INSERT INTO current VALUES ('done:pi:unknown', 'writer', 'done', 'q2', NULL, 'unknown', 3, 1700000004000, NULL, NULL, 0)");
    db.close();
    const { base } = await runningServer(path);

    expect(await (await fetch(`${base}/api/q2`)).json()).toEqual([{
      stable_id: "done:pi:beta", origin: "agent", last_event_at: 1_700_000_003_000,
    }]);
    expect(await (await fetch(`${base}/api/archive`)).json()).toEqual([{
      stable_id: "done:pi:unknown", origin: "unknown", last_event_at: 1_700_000_004_000,
    }]);
  });

  test("serves archive as a dashboard route", async () => {
    const { base } = await runningServer(seedLedger());
    const response = await fetch(`${base}/archive`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-tab="archive"');
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
      binding: "terminal-7",
    }]);
  });

  test("surfaces a pending decision", async () => {
    const { base } = await runningServer(seedLedger());
    const response = await fetch(`${base}/api/summary`);
    expect(await response.json()).toMatchObject({ q1: 1 });
  });

  test("prefers a structured host target over a reconciliation attachment", async () => {
    let target: unknown;
    const { base } = await runningServer(seedLedger(), async (input) => {
      target = input;
      return { opened: true };
    });
    const response = await fetch(`${base}/api/jump/req-1`, { method: "POST" });
    expect(await response.json()).toEqual({ opened: true });
    expect(target).toEqual({ source: "host", platform: "cmux", binding: "terminal-7", tty: "/dev/ttys007", host: "buildbox" });
  });
  test("exposes host context as the Q1 jump identifier", async () => {
    const { base } = await runningServer(seedLedger());
    const response = await fetch(`${base}/api/q1`);
    expect((await response.json())[0].binding).toBe("terminal-7");
  });
  test("omits a jump binding when the host lacks a precise session id", async () => {
    const path = seedLedger();
    const db = new Database(path);
    db.run("UPDATE session_hosts SET session_id=NULL, tty='/dev/ttys007' WHERE stable_id='remote:pi:alpha'");
    db.run("DELETE FROM attachments WHERE stable_id='remote:pi:alpha'");
    db.close();
    const { base } = await runningServer(path);
    expect((await (await fetch(`${base}/api/q1`)).json())[0].binding).toBeNull();
  });
  test("ack moves a pending request to the acked terminal and is idempotent", async () => {
    const path = seedLedger();
    const { base } = await runningServer(path);
    const first = await fetch(`${base}/api/ack/req-1`, { method: "POST" });
    expect(await first.json()).toEqual({ acked: true });
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT state FROM requests WHERE request_uid='req-1'").get()).toEqual({ state: "acked" });
    db.close();
    const second = await fetch(`${base}/api/ack/req-1`, { method: "POST" });
    expect(await second.json()).toEqual({ acked: false });
  });

  test("serves session detail and returns 404 for missing resources", async () => {
    const { base } = await runningServer(seedLedger());
    const detail = await fetch(`${base}/api/sessions/${encodeURIComponent("remote:pi:alpha")}`);
    expect(detail.status).toBe(200);
    const view = await detail.json();
    expect(view.session).toMatchObject({
      stable_id: "remote:pi:alpha", state: "working", queue: "q5", q5_reason: "turn_hung",
      last_progress_at: 1_700_000_005_000, app: "cmux", binding: "terminal-7",
    });
    // Newest first, heartbeat-free: the top row must be what the turn last did.
    expect(view.events.map((row: { kind: string }) => row.kind)).toEqual(["tool_activity", "telemetry_gap"]);
    expect(view.pending_requests).toHaveLength(1);
    expect((await fetch(`${base}/api/sessions/missing`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  test("returns pending decisions newest-first", async () => {
    const path = seedLedger();
    const db = new Database(path);
    db.run("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ["req-2", "remote:pi:alpha", "writer", "emitter", "request-2", "decision", "pending", 1_700_000_002_000, null, "{}"]);
    db.close();
    const { base } = await runningServer(path);
    expect((await (await fetch(`${base}/api/q1`)).json()).map((row: { request_uid: string }) => row.request_uid)).toEqual(["req-2", "req-1"]);
  });

  test("serves dashboard routes for tabs and session deep links", async () => {
    const { base } = await runningServer(seedLedger());
    for (const path of ["/q1", "/sessions", `/sessions/${encodeURIComponent("remote:pi:alpha")}`]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Overload dashboard");
    }
  });

  test("bounds the session list and carries queue state for drill-down", async () => {
    const { base } = await runningServer(seedLedger());
    const rows = await (await fetch(`${base}/api/sessions`)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stable_id: "remote:pi:alpha", state: "working", queue: "q5", q5_reason: "turn_hung" });
  });
});
