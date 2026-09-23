import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, getAttention, getWork, openControl, upsertAttention } from "../control/store";
import { loadWebConfig, startWebServer } from "./server";

const roots: string[] = [];
const servers: Array<{ stop(c?: boolean): void }> = [];
const SCHEMA_SQL = readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8");

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  delete process.env.OVERLOAD_ANSWERS_PATH;
});

function seedLedger(): string {
  const root = mkdtempSync(join(tmpdir(), "overload-audit-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["remote:pi:alpha", "buildbox", "pi", "alpha", "agent", "/repo", "main", 1_700_000_000_000, 1_700_000_000_000]);
  db.run("INSERT INTO current VALUES ('remote:pi:alpha', 'writer', 'working', 'q5', 'turn_hung', 'agent', 9, 1_700_000_000_900, 1_700_000_000_900, 1_700_000_000_500)");
  db.run("INSERT INTO current VALUES ('done:pi:beta', 'writer', 'done', 'q2', NULL, 'agent', 2, 1_700_000_003_000, NULL, NULL)");
  db.run("INSERT INTO incidents VALUES (1, 'recon', 1_700_000_004_000, NULL, ?)", [JSON.stringify({ reason: "x" })]);
  db.run("INSERT INTO coverage_gaps VALUES (1, 'remote:pi:alpha', 'emitter', 1, 1_700_000_000_000, 1_700_000_000_000, 'missing_seq')");
  db.close();
  return path;
}

async function boot(path: string, controlPath?: string, policyPath?: string) {
  const root = join(path, "..");
  writeFileSync(join(root, "host"), "local\n");
  const server = startWebServer({ ledgerPath: path, controlPath, policyPath, orchestratorPath: join(root, "orch.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0 });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return { server, base };
}

describe("WEB-01 loadWebConfig", () => {
  test("custom positive web_port wins; missing/invalid fall back to 4870", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-webcfg-"));
    roots.push(root);
    const good = join(root, "good.json");
    writeFileSync(good, JSON.stringify({ web_port: 9999 }));
    expect((await loadWebConfig(good)).web_port).toBe(9999);

    const missing = join(root, "does-not-exist.json");
    expect((await loadWebConfig(missing)).web_port).toBe(4870);

    const bad = join(root, "bad.json");
    writeFileSync(bad, JSON.stringify({ web_port: "not-a-number" }));
    expect((await loadWebConfig(bad)).web_port).toBe(4870);

    const zero = join(root, "zero.json");
    writeFileSync(zero, JSON.stringify({ web_port: 0 }));
    expect((await loadWebConfig(zero)).web_port).toBe(4870);
  });
});

describe("WEB-03/04 SPA shell + static", () => {
  test("GET / returns the SPA shell as text/html", async () => {
    const { base } = await boot(seedLedger());
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain('id="main"');
  });

  test("static assets serve with correct types and traversal is blocked", async () => {
    const { base } = await boot(seedLedger());
    const js = await fetch(`${base}/static/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    const css = await fetch(`${base}/static/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    const trap = await fetch(`${base}/static/..%2fpackage.json`);
    expect(trap.status).toBe(400);
  });
});

describe("WEB-07/08/25 attention zones, capabilities, health", () => {
  test("GET /api/attention/(now|inbox|done) delegate to listAttention", async () => {
    const path = seedLedger();
    const root = join(path, "..");
    const ctrl = join(root, "control.db");
    const control = openControl(ctrl);
    const work = createWork(control, { title: "w", source: "test" });
    upsertAttention(control, { item_id: "now-1", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: "r", options: ["a", "b"], owner: "op", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {} }, 1);
    control.close();
    const { base } = await boot(path, ctrl);
    for (const zone of ["now", "inbox", "done"] as const) {
      const res = await fetch(`${base}/api/attention/${zone}`);
      expect(res.status).toBe(200);
      expect(Array.isArray(await res.json())).toBe(true);
    }
  });

  test("GET /api/capabilities reports notifications + web bind/port", async () => {
    const { base } = await boot(seedLedger());
    const res = await fetch(`${base}/api/capabilities`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.web).toMatchObject({ available: true, bind: "127.0.0.1" });
    expect(typeof body.web.port).toBe("number");
    expect(body).toHaveProperty("notifications");
  });

  test("GET /api/health returns incidents + gap counts", async () => {
    const { base } = await boot(seedLedger());
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.open_incidents)).toBe(true);
    expect(typeof body.coverage_gaps).toBe("number");
    expect(typeof body.telemetry_gaps).toBe("number");
  });
});

describe("WEB-10 ledger window validation", () => {
  test("invalid since/until window returns 400", async () => {
    const { base } = await boot(seedLedger());
    expect((await fetch(`${base}/api/ledger?since=abc&until=2`)).status).toBe(400);
    expect((await fetch(`${base}/api/ledger?since=5&until=2`)).status).toBe(400);
    expect((await fetch(`${base}/api/ledger?since=-1&until=2`)).status).toBe(400);
  });
});

describe("WEB-14 works list/create", () => {
  test("GET /api/works lists and POST creates a 201", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const control = openControl(ctrl);
    createWork(control, { title: "existing", source: "test" });
    control.close();
    const { base } = await boot(path, ctrl);
    const list = await fetch(`${base}/api/works`);
    expect(list.status).toBe(200);
    expect((await list.json()).length).toBe(1);

    const created = await fetch(`${base}/api/works`, {
      method: "POST",
      headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ title: "new", source: "audit" }),
    });
    expect(created.status).toBe(201);
    const list2 = await (await fetch(`${base}/api/works`)).json();
    expect(list2.length).toBe(2);
  });
});

describe("WEB-16/18 promote + attention ack/defer/feedback", () => {
  test("promote requires expected_revision", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const control = openControl(ctrl);
    const work = createWork(control, { title: "p", source: "test" });
    control.close();
    const { base } = await boot(path, ctrl);
    const contract = { objective: "x", acceptance: [], non_goals: [], scope: {}, budget: {}, stop_conditions: [], decision_owner: "op" };
    const bad = await fetch(`${base}/api/works/${work.work_id}/promote`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 999, contract, reason: "r" }),
    });
    expect(bad.status).toBe(409);
  });

  test("attention ack/defer/feedback mutate via the route", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const control = openControl(ctrl);
    const work = createWork(control, { title: "a", source: "test" });
    const item = upsertAttention(control, { item_id: "it-1", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox", conclusion: "c", trigger: "t", impact: "i", recommendation: "r", options: ["a", "b"], owner: "op", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {} }, 1);
    control.close();
    const { base } = await boot(path, ctrl);
    const h = { origin: base, "content-type": "application/json" };
    function mkItem(id: string) {
      const c2 = openControl(ctrl);
      const it = upsertAttention(c2, { item_id: id, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox", conclusion: "c", trigger: "t", impact: "i", recommendation: "r", options: ["a", "b"], owner: "op", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {} }, 1);
      c2.close();
      return it.revision;
    }
    const ackRev = mkItem("it-ack");
    const ack = await fetch(`${base}/api/attention/it-ack/ack`, { method: "POST", headers: h, body: JSON.stringify({ expected_revision: ackRev }) });
    expect(ack.status).toBe(200);

    const fbRev = mkItem("it-fb");
    const fb = await fetch(`${base}/api/attention/it-fb/feedback`, { method: "POST", headers: h, body: JSON.stringify({ expected_revision: fbRev, useful: true, reason: "helpful" }) });
    expect(fb.status).toBe(200);

    const deferRev = mkItem("it-defer");
    const defer = await fetch(`${base}/api/attention/it-defer/defer`, { method: "POST", headers: h, body: JSON.stringify({ expected_revision: deferRev, defer_until: 9_999_999_999_999 }) });
    expect(defer.status).toBe(200);
  });
});

describe("WEB-28 jump-session", () => {
  test("POST /api/jump-session/:stableId jumps or 404", async () => {
    let seen: unknown;
    const path = seedLedger();
    const root = join(path, "..");
    writeFileSync(join(root, "host"), "local\n");
    const server = startWebServer({
      ledgerPath: path, orchestratorPath: join(root, "orch.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0,
      jump: async (t) => { seen = t; return { opened: true }; },
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;
    const ok = await fetch(`${base}/api/jump-session/remote:pi:alpha`, { method: "POST", headers: { origin: base } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ opened: true });
    expect(seen).not.toBeNull();
    const missing = await fetch(`${base}/api/jump-session/no-such-session`, { method: "POST", headers: { origin: base } });
    expect(missing.status).toBe(404);
  });
});

describe("WEB-11 rules report over HTTP", () => {
  test("GET /api/rules returns the rules report shape", async () => {
    const path = seedLedger();
    const root = join(path, "..");
    const ctrl = join(root, "control.db");
    writeFileSync(join(root, "config.json"), JSON.stringify({ decision_bot: { enabled: true, model: "t", timeout_ms: 1000, max_output_bytes: 1024, rules: [] } }));
    const { base } = await boot(path, ctrl, join(root, "config.json"));
    const res = await fetch(`${base}/api/rules`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("rules");
    expect(Array.isArray(body.rules)).toBe(true);
  });
});

describe("WEB-30 closeout 409 for non-q2", () => {
  test("closeout rejects a q5 session with 409", async () => {
    const { base } = await boot(seedLedger());
    const res = await fetch(`${base}/api/closeout/remote:pi:alpha`, { method: "POST", headers: { origin: base } });
    expect(res.status).toBe(409);
  });
});
