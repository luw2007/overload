import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createConditionWait, createWork, openControl, upsertAttention } from "../control/store";
import { openMailbox, registerTarget } from "../decision-bot/mailbox";
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
  upsertAttention(ctrl, {
    item_id: "att-follow-up", work_id: work.work_id, state: "applying",
    effect_state: "applying", urgency: "inbox",
    conclusion: "Verify the accepted change", trigger: "answer recorded", impact: "change is applying",
    recommendation: "wait", options: ["stop"], owner: "operator", expires_at: null, source_link: null,
    approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only",
    evidence: {
      occurred_effects: [{ kind: "tool-run", evidence: { state: "succeeded", summary: "patch written" } }],
      remaining_responsibility: "Operator verifies the deployed behavior",
    },
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

async function browserProbe(base: string): Promise<Record<string, any>> {
  const script = String.raw`
import json, sys
from playwright.sync_api import sync_playwright

base = sys.argv[1]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    package_revision = {"value": 1}

    def route_package(route):
        revision = package_revision["value"]
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "package_type": "decision_view", "item_id": "att-defer-1", "work_id": "probe-work",
            "attention_revision": revision, "material_fingerprint": "fp-current",
            "conclusion": "Needs decision", "trigger": "test trigger",
            "trigger_evidence": [{"summary": "current evidence" if revision == 2 else "initial evidence", "reference": "test:probe"}],
            "impact": "test impact", "recommendation": "continue", "owner": "operator",
            "contract_revision": 1, "expires_at": None, "source_link": None,
            "options": [{"id": "stop", "label": "Stop", "effect": "Stops work", "consequence": "No duplicate action"}]
        }))

    def route_resolve(route):
        package_revision["value"] = 2
        route.fulfill(status=409, content_type="application/json", body=json.dumps({
            "error": "stale attention revision", "current_revision": 2,
            "decision_package_url": "/api/context/decision-package?item_id=att-defer-1&work_id=probe-work"
        }))

    page.route("**/api/context/decision-package?*", route_package)
    page.route("**/api/attention/att-defer-1/resolve", route_resolve)
    page.goto(base + "/decide")
    page.locator('button[data-action="resolve"][data-option="stop"]').click()
    page.locator('#error button', has_text="Reload current decisions").wait_for()
    page.get_by_text("Draft answer retained: stop", exact=False).wait_for()
    follow_up = page.locator('[data-item-id="att-follow-up"]')
    follow_up.wait_for()
    result = {
        "draft": page.get_by_text("Draft answer retained: stop", exact=False).inner_text(),
        "error": page.locator("#error").inner_text(),
        "reload_buttons": page.locator('#error button', has_text="Reload current decisions").count(),
        "current_evidence": page.get_by_text("current evidence", exact=False).count(),
        "follow_up": follow_up.inner_text(),
        "follow_up_actions": follow_up.locator('button[data-action="resolve"]').count(),
        "done_has_follow_up": "Verify the accepted change" in page.locator('button[data-done="all"]').inner_text(),
    }
    print(json.dumps(result))
    browser.close()
`;
  const proc = Bun.spawn(["python3", "-c", script, base], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`browser probe failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim());
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


describe("attention browser behavior", () => {
  test("applying Work remains visible and stale conflict preserves the draft against the current package", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-attention-browser-"));
    roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const db = new Database(ledgerPath);
    db.exec(SCHEMA_SQL);
    db.close();
    const controlPath = seedAttention(root);
    const base = await boot(root, ledgerPath, controlPath);

    const dom = await browserProbe(base);
    expect(dom.follow_up).toContain("Verify the accepted change");
    expect(dom.follow_up).toContain("patch written");
    expect(dom.follow_up).toContain("Operator verifies the deployed behavior");
    expect(dom.follow_up_actions).toBe(0);
    expect(dom.done_has_follow_up).toBe(false);
    expect(dom.draft).toContain("Draft answer retained: stop");
    expect(dom.draft).toContain("Refresh the current package before retrying");
    expect(dom.error).toContain("No changes were applied");
    expect(dom.reload_buttons).toBe(1);
    expect(dom.current_evidence).toBeGreaterThan(0);
  }, 20_000);
});

describe("B09 generic Resume shares the conservative wait-recovery gate", () => {
  test("a wait-unknown session and every unproven session render no Resume in a real browser and never reach the executor", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-resume-browser-"));
    roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const db = new Database(ledgerPath);
    db.exec(SCHEMA_SQL);
    const now = Date.now();
    for (const [stableId, runtime, writer, pid] of [["local:pi:crashed", "pi", "w-crashed", 7101], ["local:omp:ended", "omp", "w-ended", 7102], ["local:pi:bare", "pi", null, null]] as const) {
      db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)", [stableId, "local", runtime, `${runtime}-session`, "agent", "/repo", "main", now - 60_000, now - 60_000]);
      if (writer) db.run("INSERT INTO session_incarnations VALUES (?,?,?,?,?,?,?)", [stableId, writer, "process", pid, "boot", now - 60_000, now - 60_000]);
    }
    db.run("INSERT INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail) VALUES ('local','e-ended',1,?,'local:omp:ended','w-ended','session_ended','{}')", [now - 30_000]);
    db.close();
    // A watching wait whose original decision is linked to local:pi:crashed (dead pid, no session_ended).
    const controlPath = join(root, "control.db");
    const control = openControl(controlPath);
    const work = createWork(control, { title: "resume gate", source: "test", contract: { objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [], scope: { repo: "acme/app" }, budget: {}, stop_conditions: [], decision_owner: "owner" } });
    const item = upsertAttention(control, { item_id: "resume-item", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox", conclusion: "resume after merge?",
      trigger: "pr", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null, source_link: null, approval_id: "ap-1", consumer_owner: "orchestrator",
      contract_revision: work.revision, decision_mode: "human_only", evidence: {} });
    const source = { provider: "github", host: "github.com", owner: "acme", repo: "app", number: 7 } as const;
    const wait = createConditionWait(control, { work_id: work.work_id, item_id: item.item_id, deadline_at: now + 86_400_000, condition: { kind: "github_pr_merged", source } },
      { actor: "owner", baseline: { baseline: { ...source, state: "OPEN", merged_at: null, updated_at: "2026-09-27T00:00:00Z", observed_at: now }, baseline_generation: now, fingerprint: "pr:OPEN", established_at: now }, now });
    control.close();
    const mailbox = openMailbox(controlPath);
    registerTarget(mailbox, { consumerOwner: "orchestrator", approvalId: "ap-1", targetVersion: "tv-1", stableId: "local:pi:crashed", question: "resume after merge?", options: ["approve"],
      effect: "resume_checkpoint", scope: {}, evidence: {}, expiresAt: now + 3_600_000, workId: work.work_id, contractRevision: work.revision });
    mailbox.close();
    writeFileSync(join(root, "host"), "local\n");
    const calls: string[][] = [];
    const server = startWebServer({ ledgerPath, controlPath, orchestratorPath: join(root, "orch.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0, actor: "owner", conditionWaits: true,
      processAlive: () => false, resume: async (_command, args) => { calls.push(args); return { ok: true }; } });
    servers.push(server);

    const waits = await (await fetch(`http://127.0.0.1:${server.port}/api/waits`)).json() as { items: Array<{ wait: { wait_id: string }; recovery_capability: { state: string; reason: string }; actions: { resume: boolean } }> };
    const waitRow = waits.items.find((row) => row.wait.wait_id === wait.wait_id)!;
    expect(waitRow.recovery_capability).toMatchObject({ state: "unknown", reason: "liveness_unknown" });
    expect(waitRow.actions.resume).toBe(false);

    const script = String.raw`
import json, sys
from playwright.sync_api import sync_playwright

base = sys.argv[1]
ids = ["local:pi:crashed", "local:omp:ended", "local:pi:bare"]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(base + "/agents")
    rows = {}
    for stable_id in ids:
        row = page.locator("tr", has_text=stable_id)
        row.wait_for()
        rows[stable_id] = row.inner_text()
    posts = page.evaluate("""async (ids) => Promise.all(ids.map(async (id) => {
        const response = await fetch('/api/resume-session/' + encodeURIComponent(id), { method: 'POST' });
        return { status: response.status, body: await response.json() };
    }))""", ids)
    print(json.dumps({"resume_buttons": page.locator("button.resume").count(), "rows": rows, "posts": posts}))
    browser.close()
`;
    const proc = Bun.spawn(["python3", "-c", script, `http://127.0.0.1:${server.port}`], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (exitCode !== 0) throw new Error(`browser probe failed (${exitCode}): ${stderr}`);
    const dom = JSON.parse(stdout.trim());

    expect(dom.resume_buttons).toBe(0);
    expect(dom.rows["local:pi:crashed"]).toContain("Resume unknown (liveness_unknown)");
    expect(dom.rows["local:pi:bare"]).toContain("Resume unknown (liveness_unknown)");
    expect(dom.rows["local:omp:ended"]).toContain("Resume unknown (no_session_file)");
    expect(dom.posts).toEqual([
      { status: 409, body: { resumed: false, reason: "liveness_unknown" } },
      { status: 409, body: { resumed: false, reason: "no_session_file" } },
      { status: 409, body: { resumed: false, reason: "liveness_unknown" } },
    ]);
    // The wait's session reports exactly the wait's recovery class on the generic Sessions surface.
    expect(dom.rows["local:pi:crashed"]).toContain(`Resume ${waitRow.recovery_capability.state} (${waitRow.recovery_capability.reason})`);
    expect(calls).toEqual([]);
  }, 20_000);
});
