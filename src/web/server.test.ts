import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { queryArchive, queryQ2 } from "../shared/queries";
import { startWebServer } from "./server";

const roots: string[] = [];
const SCHEMA_SQL = readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8");
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  delete process.env.OVERLOAD_ANSWERS_PATH;
});

function seedLedger(): string {
  const now = Date.now();
  const root = mkdtempSync(join(tmpdir(), "overload-web-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["remote:pi:alpha", "buildbox", "pi", "alpha", "agent", "/repo", "main", 1_700_000_000_000, 1_700_000_000_000]);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["local:pi:dead", "local", "pi", "pi-session", "agent", "/repo/pi", "main", 1_700_000_000_100, 1_700_000_000_100]);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["local:omp:dead", "local", "omp", "omp-session", "agent", "/repo/omp", "main", 1_700_000_000_200, 1_700_000_000_200]);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["local:pi:live", "local", "pi", "live-session", "agent", "/repo/live", "main", 1_700_000_000_300, 1_700_000_000_300]);
  db.run("INSERT INTO session_incarnations VALUES (?, ?, ?, ?, ?, ?, ?)", ["local:pi:live", "writer-live", "process", 4242, "boot", 1_700_000_000_300, 1_700_000_000_300]);
  db.run("INSERT INTO requests VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL, ?)", ["req-1", "remote:pi:alpha", "writer", "emitter", "one", "decision", 1_700_000_001_000, JSON.stringify({ question: "ship?" })]);
  db.run("INSERT INTO attachments VALUES ('remote:pi:alpha', 'cmux', 'workspace-42', 1700000002000, 1)");
  db.run("INSERT INTO session_hosts VALUES ('remote:pi:alpha', 'cmux', 'terminal-7', '/dev/ttys007', 1700000003000)");
  db.run("INSERT INTO current VALUES ('done:pi:beta', 'writer', 'done', 'q2', NULL, 'agent', 2, 1700000003000, NULL, NULL)");
  db.run("INSERT INTO incidents VALUES (1, 'recon', 1700000004000, NULL, ?)", [JSON.stringify({ reason: "adapter unavailable" })]);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["remote:pi:new", "remote", "pi", "new", "agent", "/repo", "main", 1_700_000_000_500, 1_700_000_000_500]);
  db.run("INSERT INTO current VALUES ('remote:pi:new', 'writer-new', 'working', 'q3', NULL, 'agent', 5, 1700000010000, 1700000010000, 1700000010000)");
  db.run("INSERT INTO session_hosts VALUES ('remote:pi:new', 'cmux', 'terminal-7', '/dev/ttys007', 1700000006000)");
  db.run("INSERT INTO coverage_gaps VALUES (1, 'remote:pi:alpha', 'emitter', 1, ?, ?, 'missing_seq')", [now - 60_000, now]);
  db.run("INSERT INTO journal(ingest_seq, host, emitter_id, seq, at, stable_id, writer_id, kind, detail) VALUES (1, 'local', 'emitter', 1, ?, 'remote:pi:alpha', 'writer', 'telemetry_gap', ?)", [now - 60_000, JSON.stringify({ platform: "cmux", native_id: "term-9" })]);
  db.run("INSERT INTO current VALUES ('remote:pi:alpha', 'writer', 'working', 'q5', 'turn_hung', 'agent', 9, 1700000009000, 1700000009000, 1700000005000)");
  db.run("INSERT INTO journal(ingest_seq, host, emitter_id, seq, at, stable_id, writer_id, kind, detail) VALUES (2, 'local', 'emitter', 2, 1700000005000, 'remote:pi:alpha', 'writer', 'tool_activity', ?)", [JSON.stringify({ tool: "bash" })]);
  db.run("INSERT INTO journal(ingest_seq, host, emitter_id, seq, at, stable_id, writer_id, kind, detail) VALUES (3, 'local', 'emitter', 3, 1700000009000, 'remote:pi:alpha', 'writer', 'heartbeat', '{}')");
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

  test("queries fresh readonly ledgers without the optional closeouts table", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-web-fresh-"));
    roots.push(root);
    const path = join(root, "ledger.db");
    const writable = new Database(path);
    writable.exec(await Bun.file(new URL("../ingest/schema.sql", import.meta.url)).text());
    writable.run("INSERT INTO current(stable_id, writer_id, state, queue, origin, last_event_at) VALUES ('known', 'w', 'done', 'q2', 'agent', 2), ('unknown', 'w', 'done', 'q2', 'unknown', 1)");
    writable.close();
    const readonly = new Database(path, { readonly: true });
    expect(queryQ2(readonly)).toEqual([{ stable_id: "known", origin: "agent", last_event_at: 2 }]);
    expect(queryArchive(readonly)).toEqual([{ stable_id: "unknown", origin: "unknown", last_event_at: 1 }]);
    readonly.close();
  });

  test("closeout moves q2 work to archive", async () => {
    const path = seedLedger();
    const { base } = await runningServer(path);
    const headers = { origin: base };
    expect(await (await fetch(`${base}/api/closeout/done:pi:beta`, { method: "POST", headers })).json()).toEqual({ closed: true });
    expect(await (await fetch(`${base}/api/q2`)).json()).toEqual([]);
    expect(await (await fetch(`${base}/api/archive`)).json()).toContainEqual({ stable_id: "done:pi:beta", origin: "agent", last_event_at: 1_700_000_003_000, closed_out: true });
    expect((await fetch(`${base}/api/closeout/missing`, { method: "POST", headers })).status).toBe(404);
  });

  test("reads, creates, and deletes an orchestrator answer mailbox row", async () => {
    const path = seedLedger();
    const answerPath = join(roots[roots.length - 1], "answers.db");
    process.env.OVERLOAD_ANSWERS_PATH = answerPath;
    const { base } = await runningServer(path);
    const id = "stable#writer#tool";
    expect((await fetch(`${base}/api/orchestrator/answer/${encodeURIComponent(id)}`)).status).toBe(404);
    const post = await fetch(`${base}/api/orchestrator/answer/${encodeURIComponent(id)}`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin" }, body: JSON.stringify({ answer: "approve" }) });
    expect(post.status).toBe(200);
    expect(await (await fetch(`${base}/api/orchestrator/answer/${encodeURIComponent(id)}`)).json()).toMatchObject({ answer: "approve", actor: "ui" });
    const noOrigin = await fetch(`${base}/api/orchestrator/answer/${encodeURIComponent(id)}`, { method: "DELETE" });
    expect(noOrigin.status).toBe(403);
    const remove = await fetch(`${base}/api/orchestrator/answer/${encodeURIComponent(id)}`, { method: "DELETE", headers: { origin: base } });
    expect(remove.status).toBe(200);
    expect((await fetch(`${base}/api/orchestrator/answer/${encodeURIComponent(id)}`)).status).toBe(404);
  });
  test("missing Origin blocks answer DELETE", async () => {
    const path = seedLedger();
    const answerPath = join(roots[roots.length - 1], "answers.db");
    process.env.OVERLOAD_ANSWERS_PATH = answerPath;
    const { base } = await runningServer(path);
    const response = await fetch(`${base}/api/orchestrator/answer/id`, { method: "DELETE" });
    expect(response.status).toBe(403);
  });
  test("archive includes q4 and unproven q2 rows", async () => {
    const path = seedLedger();
    const db = new Database(path);
    db.run("INSERT INTO current VALUES ('done:pi:unknown', 'writer', 'done', 'q2', NULL, 'unknown', 3, 1700000004000, NULL, NULL)");
    db.run("INSERT INTO current VALUES ('done:pi:autoverified', 'writer', 'done', 'q4', NULL, 'agent', 4, 1700000005000, NULL, NULL)");
    db.close();
    const { base } = await runningServer(path);

    expect(await (await fetch(`${base}/api/archive`)).json()).toEqual([
      { stable_id: "done:pi:autoverified", origin: "agent", last_event_at: 1_700_000_005_000 },
      { stable_id: "done:pi:unknown", origin: "unknown", last_event_at: 1_700_000_004_000 },
    ]);
  });

  test("serves legacy archive route with the dashboard shell", async () => {
    const { base } = await runningServer(seedLedger());
    const response = await fetch(`${base}/archive`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-tab="done"');
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
      summary: null,
      options: null,
      host_probe_error: null,
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
    const response = await fetch(`${base}/api/jump/req-1`, { method: "POST", headers: { origin: base } });
    expect(await response.json()).toEqual({ opened: true });
    expect(target).toEqual({ source: "host", platform: "cmux", binding: "terminal-7", tty: "/dev/ttys007", host: "buildbox", host_probe_error: null });
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
    const first = await fetch(`${base}/api/ack/req-1`, { method: "POST", headers: { origin: base } });
    expect(await first.json()).toEqual({ acked: true });
    const db = new Database(path, { readonly: true });
    expect(db.query("SELECT state FROM requests WHERE request_uid='req-1'").get()).toEqual({ state: "acked" });
    db.close();
    const second = await fetch(`${base}/api/ack/req-1`, { method: "POST", headers: { origin: base } });
    expect(await second.json()).toEqual({ acked: false });
  });

  describe("SEC-1: Origin/Host guard", () => {
    test("correct headers: POST /api/ack/<uid> succeeds and mutates state", async () => {
      const path = seedLedger();
      const { base } = await runningServer(path);
      const response = await fetch(`${base}/api/ack/req-1`, { method: "POST", headers: { origin: base, host: new URL(base).host } });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ acked: true });
      const db = new Database(path, { readonly: true });
      expect(db.query("SELECT state FROM requests WHERE request_uid='req-1'").get()).toEqual({ state: "acked" });
      db.close();
    });

    test("wrong Origin: 403 and no state change", async () => {
      const path = seedLedger();
      const { base } = await runningServer(path);
      const response = await fetch(`${base}/api/ack/req-1`, { method: "POST", headers: { origin: "https://evil.example" } });
      expect(response.status).toBe(403);
      const db = new Database(path, { readonly: true });
      expect(db.query("SELECT state FROM requests WHERE request_uid='req-1'").get()).toEqual({ state: "pending" });
      db.close();
    });

    test("wrong Host: 403", async () => {
      const { server } = await runningServer(seedLedger());
      const response = await fetch(`http://127.0.0.1:${server.port}/api/ack/req-1`, { method: "POST", headers: { origin: `http://127.0.0.1:${server.port}`, host: "evil.example" } });
      expect(response.status).toBe(403);
    });

    test("missing Origin: 403", async () => {
      const { base } = await runningServer(seedLedger());
      const response = await fetch(`${base}/api/ack/req-1`, { method: "POST" });
      expect(response.status).toBe(403);
    });

    test("GET /api/q1: correct Host succeeds, wrong Host 403", async () => {
      const { server } = await runningServer(seedLedger());
      const ok = await fetch(`http://127.0.0.1:${server.port}/api/q1`, { headers: { host: `127.0.0.1:${server.port}` } });
      expect(ok.status).toBe(200);
      const bad = await fetch(`http://127.0.0.1:${server.port}/api/q1`, { headers: { host: "evil.example" } });
      expect(bad.status).toBe(403);
    });
  });

  test("reports resume capability and launches pi and omp sessions through cmux", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const server = startWebServer({ ledgerPath: seedLedger(), port: 0, processAlive: (pid) => pid === 4242, resume: async (command, args) => {
      calls.push({ command, args });
      return { ok: true };
    } });
    servers.push(server);

    const sessions = await (await fetch(`${server.url}api/sessions`)).json() as Array<{ stable_id: string; resume_capability: { resumable: boolean; runtime?: string; reason?: string } }>;
    expect(sessions.find((row) => row.stable_id === "local:pi:dead")?.resume_capability).toEqual({ resumable: true, runtime: "pi" });
    expect(sessions.find((row) => row.stable_id === "local:omp:dead")?.resume_capability).toEqual({ resumable: true, runtime: "omp" });
    expect(sessions.find((row) => row.stable_id === "local:pi:live")?.resume_capability).toEqual({ resumable: false, reason: "process_alive" });
    expect(sessions.find((row) => row.stable_id === "remote:pi:alpha")?.resume_capability).toEqual({ resumable: false, reason: "remote_host_unsupported" });

    const origin = `http://127.0.0.1:${server.port}`;
    expect(await (await fetch(`${server.url}api/resume-session/${encodeURIComponent("local:pi:dead")}`, { method: "POST", headers: { origin } })).json()).toEqual({ resumed: true });
    expect(await (await fetch(`${server.url}api/resume-session/${encodeURIComponent("local:omp:dead")}`, { method: "POST", headers: { origin } })).json()).toEqual({ resumed: true });
    expect(calls).toEqual([
      { command: "cmux", args: ["new-workspace", "--cwd", "/repo/pi", "--command", "pi --resume='pi-session'", "--focus", "true"] },
      { command: "cmux", args: ["new-workspace", "--cwd", "/repo/omp", "--command", "omp --resume='omp-session'", "--focus", "true"] },
    ]);

    const conflict = await fetch(`${server.url}api/resume-session/${encodeURIComponent("local:pi:live")}`, { method: "POST", headers: { origin } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ resumed: false, reason: "process_alive" });
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
    expect(view.latest_surface_session).toMatchObject({ stable_id: "remote:pi:new", state: "working", last_event_at: 1_700_000_010_000 });
    const latest = await (await fetch(`${base}/api/sessions/${encodeURIComponent("remote:pi:new")}`)).json();
    expect(latest.latest_surface_session).toBeNull();
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

  test("serves dashboard routes for zones, legacy tabs, and session deep links", async () => {
    const { base } = await runningServer(seedLedger());
    for (const path of ["/now", "/inbox", "/done", "/sessions", "/health", "/q1", "/q2", "/archive", "/hung", "/zombie", `/sessions/${encodeURIComponent("remote:pi:alpha")}`]) {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Overload dashboard");
    }
  });

  test("bounds the session list and carries queue state for drill-down", async () => {
    const { base } = await runningServer(seedLedger());
    const rows = await (await fetch(`${base}/api/sessions`)).json();
    expect(rows).toHaveLength(5);
    expect(rows.find((row: { stable_id: string }) => row.stable_id === "remote:pi:alpha")).toMatchObject({ stable_id: "remote:pi:alpha", state: "working", queue: "q5", q5_reason: "turn_hung" });
  });

  describe("POST /api/orchestrator/answer/:approval_id", () => {
    function answersDb(root: string): string {
      const path = join(root, "answers.db");
      const db = new Database(path);
      db.exec("CREATE TABLE IF NOT EXISTS answers(approval_id TEXT PRIMARY KEY, answer TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL)");
      db.close();
      return path;
    }

    test("valid request inserts row and returns 200", async () => {
      const root = mkdtempSync(join(tmpdir(), "overload-answer-"));
      roots.push(root);
      const aPath = answersDb(root);
      process.env.OVERLOAD_ANSWERS_PATH = aPath;
      const { server } = await runningServer(seedLedger());
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/orchestrator/answer/test-approval-1`, {
        method: "POST",
        headers: { origin: base, host: `127.0.0.1:${server.port}`, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const db = new Database(aPath, { readonly: true });
      const row = db.query("SELECT approval_id, answer, actor FROM answers WHERE approval_id='test-approval-1'").get() as { approval_id: string; answer: string; actor: string } | null;
      db.close();
      expect(row).toEqual({ approval_id: "test-approval-1", answer: "approve", actor: "ui" });
      delete process.env.OVERLOAD_ANSWERS_PATH;
    });

    test("missing Sec-Fetch-* headers returns 403", async () => {
      const root = mkdtempSync(join(tmpdir(), "overload-answer-"));
      roots.push(root);
      const aPath = answersDb(root);
      process.env.OVERLOAD_ANSWERS_PATH = aPath;
      const { server } = await runningServer(seedLedger());
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/orchestrator/answer/test-approval-2`, {
        method: "POST",
        headers: { origin: base, host: `127.0.0.1:${server.port}`, "content-type": "application/json" },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(response.status).toBe(403);
      delete process.env.OVERLOAD_ANSWERS_PATH;
    });

    test("wrong Origin returns 403 (reuses checkOrigin)", async () => {
      const root = mkdtempSync(join(tmpdir(), "overload-answer-"));
      roots.push(root);
      answersDb(root);
      process.env.OVERLOAD_ANSWERS_PATH = join(root, "answers.db");
      const { server } = await runningServer(seedLedger());
      const response = await fetch(`http://127.0.0.1:${server.port}/api/orchestrator/answer/test-approval-3`, {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(response.status).toBe(403);
      delete process.env.OVERLOAD_ANSWERS_PATH;
    });

    test("missing answers.db is created", async () => {
      process.env.OVERLOAD_ANSWERS_PATH = join(tmpdir(), "nonexistent-" + Date.now(), "answers.db");
      const { server } = await runningServer(seedLedger());
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/orchestrator/answer/test-approval-4`, {
        method: "POST",
        headers: { origin: base, host: `127.0.0.1:${server.port}`, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
        body: JSON.stringify({ answer: "approve" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(existsSync(process.env.OVERLOAD_ANSWERS_PATH)).toBe(true);
      delete process.env.OVERLOAD_ANSWERS_PATH;
    });

    test("malformed JSON body returns 400", async () => {
      const root = mkdtempSync(join(tmpdir(), "overload-answer-"));
      roots.push(root);
      const aPath = answersDb(root);
      process.env.OVERLOAD_ANSWERS_PATH = aPath;
      const { server } = await runningServer(seedLedger());
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/orchestrator/answer/test-approval-5`, {
        method: "POST",
        headers: { origin: base, host: `127.0.0.1:${server.port}`, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
        body: "not json",
      });
      expect(response.status).toBe(400);
      delete process.env.OVERLOAD_ANSWERS_PATH;
    });

    test("missing answer field returns 400", async () => {
      const root = mkdtempSync(join(tmpdir(), "overload-answer-"));
      roots.push(root);
      const aPath = answersDb(root);
      process.env.OVERLOAD_ANSWERS_PATH = aPath;
      const { server } = await runningServer(seedLedger());
      const base = `http://127.0.0.1:${server.port}`;
      const response = await fetch(`${base}/api/orchestrator/answer/test-approval-6`, {
        method: "POST",
        headers: { origin: base, host: `127.0.0.1:${server.port}`, "content-type": "application/json", "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors" },
        body: JSON.stringify({ wrong: "field" }),
      });
      expect(response.status).toBe(400);
      delete process.env.OVERLOAD_ANSWERS_PATH;
    });
  });
});
