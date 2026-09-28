import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWork, openControl, upsertAttention } from "../control/store";
import { startWebServer } from "./server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const servers: Array<{ stop(c?: boolean): void }> = [];
const SCHEMA_SQL = readFileSync(join(__dirname, "../ingest/schema.sql"), "utf8");
const APP_JS = readFileSync(join(__dirname, "static/app.js"), "utf8");

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function seedLedger(root: string): string {
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  const now = Date.now();
  db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)",
    ["remote:pi:alpha", "buildbox", "pi", "alpha", "agent", "/repo", "main", now - 7200000, now - 7200000]);
  db.run("INSERT INTO requests VALUES (?,?,?,?,?,?,'pending',?,NULL,?)",
    ["req-jump-1", "remote:pi:alpha", "writer", "emitter", "one", "decision", now - 7200000, JSON.stringify({ question: "deploy?" })]);
  db.run("INSERT INTO current VALUES (?,?,?,?,?,?,?,?,?,?)",
    ["remote:pi:alpha", "writer", "awaiting_human", "q1", null, "agent", 1, now, now, now]);
  db.run("INSERT INTO attachments VALUES (?,?,?,?,?)",
    ["remote:pi:alpha", "cmux", "ws-1", now, 1]);
  db.run("INSERT INTO session_hosts VALUES (?,?,?,?,?)",
    ["remote:pi:alpha", "cmux", "terminal-7", "/dev/ttys007", now]);
  db.close();
  return path;
}

function seedAttention(root: string): string {
  const ctrlPath = join(root, "control.db");
  const ctrl = openControl(ctrlPath);
  const work = createWork(ctrl, { title: "test-work", source: "test" });
  upsertAttention(ctrl, {
    item_id: "att-defer-1", work_id: work.work_id, state: "open",
    effect_state: "not_started", urgency: "now",
    conclusion: "需要决策", trigger: "test", impact: "test impact",
    recommendation: "continue", options: ["stop", "continue", "defer"],
    owner: "operator", expires_at: null, source_link: null,
    approval_id: null, consumer_owner: null,
    contract_revision: work.revision, decision_mode: "human_only", evidence: {}
  });
  ctrl.close();
  return ctrlPath;
}

async function boot(root: string, ledgerPath: string, controlPath?: string, jump?: any) {
  writeFileSync(join(root, "host"), "local\n");
  const server = startWebServer({
    ledgerPath, controlPath, orchestratorPath: join(root, "orch.db"),
    spoolRoot: root, publishIntervalMs: 60_000, port: 0, jump,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

describe("q1 jump route regression", () => {
  test("app.js decisionCard uses route=jump (not q1)", () => {
    // The q1 decisionCard renders jumpActions(row, "request_uid", "jump")
    // which generates data-route="jump" on the jump button.
    // Previously it was "q1" which had no matching POST route on the server.
    expect(APP_JS).toContain('jumpActions(row, "request_uid", "jump")');
    expect(APP_JS).not.toContain('jumpActions(row, "request_uid", "q1")');
  });

  test("POST /api/jump/:uid is received by server with fake jump handler", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-jump-"));
    roots.push(root);
    const ledgerPath = seedLedger(root);
    let jumpCalled = false;
    let jumpTarget: any = null;
    const fakeJump = async (target: any) => {
      jumpCalled = true;
      jumpTarget = target;
      return { opened: true, method: "fake" };
    };
    const base = await boot(root, ledgerPath, undefined, fakeJump);

    const res = await fetch(`${base}/api/jump/req-jump-1`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.opened).toBe(true);
    expect(jumpCalled).toBe(true);
    expect(jumpTarget.binding).toBe("terminal-7");
  });

  test("POST /api/jump-session/:stableId is received by server", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-jump-"));
    roots.push(root);
    const ledgerPath = seedLedger(root);
    let jumpCalled = false;
    const fakeJump = async (target: any) => {
      jumpCalled = true;
      return { opened: true, method: "fake" };
    };
    const base = await boot(root, ledgerPath, undefined, fakeJump);

    const res = await fetch(`${base}/api/jump-session/remote:pi:alpha`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
    });
    expect(res.status).toBe(200);
    expect(jumpCalled).toBe(true);
  });
});

describe("attention defer integration", () => {
  test("POST /api/attention/:id/defer sets defer_until and removes from Now", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-defer-"));
    roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const db = new Database(ledgerPath);
    db.exec(SCHEMA_SQL);
    db.close();
    const controlPath = seedAttention(root);
    const base = await boot(root, ledgerPath, controlPath);

    // Before: item is in Now
    const nowBefore = await (await fetch(`${base}/api/attention/now`)).json();
    expect(nowBefore.some((i: any) => i.item_id === "att-defer-1")).toBe(true);

    // Defer for 1 hour
    const deferUntil = Date.now() + 3600000;
    const res = await fetch(`${base}/api/attention/att-defer-1/defer`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ expected_revision: 1, defer_until: deferUntil }),
    });
    expect(res.status).toBe(200);
    const deferred = await res.json();
    expect(deferred.defer_until).toBe(deferUntil);
    expect(deferred.state).toBe("open");

    // After: item is NOT in Now (defer_until > now filters it out)
    const nowAfter = await (await fetch(`${base}/api/attention/now`)).json();
    expect(nowAfter.some((i: any) => i.item_id === "att-defer-1")).toBe(false);

    // Deferred item is also hidden from inbox (defer_until > now filter applies before zone check)
    const inboxAfter = await (await fetch(`${base}/api/attention/inbox`)).json();
    expect(inboxAfter.some((i: any) => i.item_id === "att-defer-1")).toBe(false);
  });

  test("defer without defer_until returns 400", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-defer-"));
    roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const db = new Database(ledgerPath);
    db.exec(SCHEMA_SQL);
    db.close();
    const controlPath = seedAttention(root);
    const base = await boot(root, ledgerPath, controlPath);

    const res = await fetch(`${base}/api/attention/att-defer-1/defer`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ expected_revision: 1 }),
    });
    expect(res.status).toBe(400);
  });

  test("defer with past defer_until returns 400", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-defer-"));
    roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const db = new Database(ledgerPath);
    db.exec(SCHEMA_SQL);
    db.close();
    const controlPath = seedAttention(root);
    const base = await boot(root, ledgerPath, controlPath);

    const res = await fetch(`${base}/api/attention/att-defer-1/defer`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ expected_revision: 1, defer_until: Date.now() - 1000 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("generic attention option filtering", () => {
  test("app.js decisionRow filters non-valid options for generic attention", () => {
    // decisionRow renders only stop/continue/narrow/defer as buttons for items without approval_id;
    // other options (approve/deny) render as disabled .option-chip with title explaining they need linked approval.
    expect(APP_JS).toContain("item.approval_id?item.options:item.options.filter(o=>['stop','continue','narrow','defer'].includes(o))");
    expect(APP_JS).toContain("此选项需要 linked approval");
  });

  test("app.js resolveItem sends defer to /api/attention/:id/defer with defer_until", () => {
    expect(APP_JS).toContain("if(option==='defer')");
    expect(APP_JS).toContain("/api/attention/${encodeURIComponent(id)}/defer");
    expect(APP_JS).toContain("defer_until:Date.now()+3600000");
  });
});
