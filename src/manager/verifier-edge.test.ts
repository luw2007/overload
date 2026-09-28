// Verifier edge cases for the manager core (docs/plans/overload-20260928-manager-chat.md §1.1–§1.4, §2, §3, §5 A/C).
// `test.failing` marks a confirmed defect: it passes while the defect exists and flips to a failure once fixed.
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "../web/server";
import { createWork, openControl, upsertAttention } from "../control/store";
import { runManagerCli } from "../cli/manager";
import { buildManagerContext } from "./context";
import { readManagerView } from "./inspect";
import { beginManagerTurn, listManagerTurns } from "./store";
import { askManager, DEFAULT_MANAGER_CONFIG, HISTORY_TURNS, type RunModel } from "./turn";
import { controlDb, item, ledgerDb, NOW, session, work } from "./test-fixtures";

const config = { ...DEFAULT_MANAGER_CONFIG, model: "fake/model" };
const brief = { version: "collaboration_brief_v0", purpose: "p", context: "c", constraints: [], inputs: [], acceptance: ["a"], return_requirement: "r" };
const triage = (item_id: string, patch: Record<string, unknown> = {}) => ({ item_id, kind: "user_gate", order: 1, urgency: "inferred", reason: "r", evidence_refs: [], dependency_status: "not_applicable", ...patch });
const envelope = (patch: Record<string, unknown> = {}) => ({ message: "m", triage: [triage("i1")], handoffs: [], protected_action: null, gaps: [], ...patch });
const reply = (value: unknown) => "## 结论\n正文\n```json\n" + JSON.stringify(value) + "\n```";
const run = (text: string): RunModel => async () => ({ ok: true, text });
function setup() { const control = controlDb(), ledger = ledgerDb(); item(control, work(control), "i1", { urgency: "now" }); session(ledger, "s1"); return { control, ledger }; }
function followUp(db: Database, workId: string, id: string) {
  // An open item whose effect failed is both actionable and a follow-up (store.listAttentionFollowUps visibility rule).
  upsertAttention(db, { item_id: id, work_id: workId, state: "resolved", effect_state: "failed", urgency: "inbox", conclusion: `fu ${id}`, trigger: "t", impact: "i", recommendation: null, options: ["ok"], owner: "owner", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {} }, NOW - 500);
}

describe("envelope validation is all-or-nothing (§1.3)", () => {
  test.each([
    ["json parse error", "x\n```json\n{not json\n```"],
    ["protected_action missing", reply({ ...envelope(), protected_action: undefined })],
    ["protected_action bad kind", reply(envelope({ protected_action: { kind: "approve", description: "d" } }))],
    ["order 0", reply(envelope({ triage: [triage("i1", { order: 0 })] }))],
    ["urgency enum", reply(envelope({ triage: [triage("i1", { urgency: "high" })] }))],
    ["dependency_status enum", reply(envelope({ triage: [triage("i1", { dependency_status: "done" })] }))],
    ["target_kind not session", reply(envelope({ handoffs: [{ target_kind: "stable_id", target_id: "s1", brief }] }))],
    ["brief wrong version", reply(envelope({ handoffs: [{ target_kind: "session", target_id: "s1", brief: { ...brief, version: "v1" } }] }))],
    ["gaps not array", reply(envelope({ gaps: "none" }))],
    ["one good + one bad handoff", reply(envelope({ handoffs: [{ target_kind: "session", target_id: "s1", brief }, { target_kind: "session", target_id: "ghost", brief }] }))],
    ["good handoff + unknown triage item", reply(envelope({ triage: [triage("nope")], handoffs: [{ target_kind: "session", target_id: "s1", brief }] }))],
  ])("%s → invalid_envelope, body kept, zero deliveries", async (_name, text) => {
    const { control, ledger } = setup(); let delivered = 0;
    const turn = await askManager({ control, ledger, config, runModel: run(text), deliverHandoff: async (h) => { delivered++; return { target_id: h.target_id, request_id: "r", state: "delivered", reason: null }; } }, { question: "q", source: "web" });
    expect(turn.status).toBe("invalid_envelope");
    expect(turn.failure_reason).toBeTruthy();
    expect(turn.answer_markdown).toBeTruthy();
    expect(turn.handoff_receipts).toBeNull();
    expect(delivered).toBe(0);
  });

  test("valid handoffs are each delivered once; a throwing deliverer becomes an undelivered receipt", async () => {
    const { control, ledger } = setup(); session(ledger, "s2", { runtime: "omp" });
    const calls: string[] = [];
    const turn = await askManager({ control, ledger, config, runModel: run(reply(envelope({ handoffs: [{ target_kind: "session", target_id: "s1", brief }, { target_kind: "session", target_id: "s2", brief }] }))),
      deliverHandoff: async (h) => { calls.push(h.target_id); if (h.target_id === "s2") throw new Error("boom"); return { target_id: h.target_id, request_id: "req-1", state: "delivered", reason: null }; } }, { question: "转交", source: "web" });
    expect(turn.status).toBe("answered");
    expect(calls).toEqual(["s1", "s2"]);
    expect(turn.handoff_receipts).toEqual([{ target_id: "s1", request_id: "req-1", state: "delivered", reason: null }, { target_id: "s2", request_id: null, state: "undelivered", reason: "boom" }]);
    expect(turn.answer_markdown).toContain("未转交");
  });

  test("triage may reference follow_up items but not recent_done-only or cap-omitted items", async () => {
    const control = controlDb(), ledger = ledgerDb(); const w = work(control);
    followUp(control, w, "fu1");
    item(control, w, "gone", { state: "resolved", evidence: { effect_verified_at: NOW - 10 } }); // verified → done only, not a follow-up
    for (let i = 0; i < 49; i++) item(control, w, `n${String(i).padStart(2, "0")}`, { urgency: "now", at: NOW - 900 + i });
    const ctx = buildManagerContext(control, ledger, { now: NOW });
    expect(ctx.attention.follow_up.map((f) => f.item_id)).toContain("fu1");
    expect(ctx.coverage.attention_omitted).toBe(1);
    expect(ctx.recent_done.map((x) => x.item_id)).toContain("gone");
    expect(ctx.attention.follow_up.map((x) => x.item_id)).not.toContain("gone");
    const omitted = "n00"; // oldest, cut by the 48 cap
    expect(ctx.attention.now.some((x) => x.item_id === omitted)).toBe(false);
    const ok = await askManager({ control, ledger, config, runModel: run(reply(envelope({ triage: [triage("fu1", { kind: "agent_work" })] }))), now: () => NOW }, { question: "q", source: "web" });
    expect(ok.status).toBe("answered");
    for (const id of ["gone", omitted]) {
      const bad = await askManager({ control, ledger, config, runModel: run(reply(envelope({ triage: [triage(id)] }))), now: () => NOW }, { question: "q", source: "web" });
      expect(bad.status).toBe("invalid_envelope");
    }
  });
});

describe("turn lifecycle", () => {
  test("a running turn older than timeout_ms no longer blocks (§1.4 single-flight window)", async () => {
    const { control, ledger } = setup();
    beginManagerTurn(control, { source: "web", question: "stuck", model: "m", now: NOW - config.timeout_ms - 1, timeoutMs: config.timeout_ms });
    const turn = await askManager({ control, ledger, config, runModel: run(reply(envelope())), now: () => NOW }, { question: "q", source: "web" });
    expect(turn.status).toBe("answered");
  });

  test("a throwing runModel is stored as failed with the fixed text, and never retried", async () => {
    const { control, ledger } = setup(); let calls = 0;
    const turn = await askManager({ control, ledger, config, runModel: async () => { calls++; throw new Error("spawn"); } }, { question: "q", source: "cli" });
    expect(turn.status).toBe("failed");
    expect(turn.answer_markdown).toBe("本轮未完成：internal_error: spawn。不会自动重放。");
    expect(calls).toBe(1);
  });

  test(`prompt history holds exactly the last ${HISTORY_TURNS} turns, oldest first, excluding the current one`, async () => {
    const { control, ledger } = setup(); const prompts: string[] = [];
    const model: RunModel = async (o) => { prompts.push(o.prompt); return { ok: true, text: reply(envelope()) }; };
    for (let i = 0; i < HISTORY_TURNS + 2; i++) await askManager({ control, ledger, config, runModel: model, now: () => NOW + i }, { question: `question-${i}`, source: "web" });
    const last = prompts.at(-1)!;
    const history = last.slice(last.indexOf("Recent conversation"), last.indexOf("Context-only materials"));
    const asked = [...history.matchAll(/Owner: (question-\d+)/g)].map((m) => m[1]);
    expect(asked).toEqual(Array.from({ length: HISTORY_TURNS }, (_, k) => `question-${k + 1}`));
    expect(last.endsWith(`Current owner message:\nquestion-${HISTORY_TURNS + 1}`)).toBe(true);
  });

  test("oversized question is rejected before any turn row is written", async () => {
    const { control, ledger } = setup();
    await expect(askManager({ control, ledger, config, runModel: run("") }, { question: "x".repeat(20_001), source: "web" })).rejects.toThrow();
    expect(listManagerTurns(control)).toHaveLength(0);
  });
});

describe("snapshot (§1.1)", () => {
  test("snapshot_id is stable for unchanged data with sessions/ended fixtures and changes when data changes", () => {
    const control = controlDb(), ledger = ledgerDb(); const w = work(control);
    item(control, w, "a"); session(ledger, "live"); session(ledger, "ended", { ended: true });
    const a = buildManagerContext(control, ledger, { now: NOW }), b = buildManagerContext(control, ledger, { now: NOW + 60_000 });
    expect(a.snapshot_id).toBe(b.snapshot_id);
    item(control, w, "b");
    expect(buildManagerContext(control, ledger, { now: NOW }).snapshot_id).not.toBe(a.snapshot_id);
  });

  test("inbox and follow_up caps are per zone and omitted counts are exact", () => {
    const control = controlDb(); const w = work(control);
    for (let i = 0; i < 52; i++) item(control, w, `b${String(i).padStart(2, "0")}`, { urgency: "inbox", at: NOW - 2000 + i });
    const ctx = buildManagerContext(control, null, { now: NOW });
    expect(ctx.attention.inbox).toHaveLength(48);
    expect(ctx.coverage).toMatchObject({ attention_included: 48, attention_omitted: 4 });
    // newest are kept
    expect(ctx.attention.inbox[0]!.item_id).toBe("b51");
  });

  test("session and target strings are redacted too", () => {
    const control = controlDb(), ledger = ledgerDb();
    ledger.run("INSERT INTO sessions(stable_id,host,runtime,session,cwd,branch,created_at,first_seen_at) VALUES('s','local','pi','s','/repo/token=abc123456','main',?,?)", [NOW, NOW]);
    ledger.run("INSERT INTO current(stable_id,state,queue,q5_reason,last_event_at) VALUES('s','working','q3',NULL,?)", [NOW]);
    const ctx = buildManagerContext(control, ledger, { now: NOW });
    expect(JSON.stringify(ctx)).not.toContain("abc123456");
    expect(ctx.targets[0]!.cwd).toContain("[REDACTED]");
  });

  test.failing("DEFECT: watching waits are dropped silently when >200 newer waits exist (no omitted count)", () => {
    const control = controlDb(); const w = work(control);
    const insert = (id: string, state: string, updated: number) => {
      item(control, w, `it-${id}`);
      control.run(`INSERT INTO control_waits(wait_id,work_id,item_id,condition_kind,condition_json,source_identity,source_identity_hash,baseline_json,baseline_established_at,baseline_generation,source_generation,state,deadline_at,next_check_at,actor,decision_owner,disposition,created_at,updated_at)
        VALUES(?,?,?,'work_completed','{"kind":"work_completed"}','{}',?,'{}',?,0,0,?,?,?,'a','owner','redecide',?,?)`, [id, w, `it-${id}`, "h".repeat(64), NOW - 30 * 86_400_000, state, NOW + 86_400_000, state === "watching" ? NOW + 60_000 : null, NOW - 30 * 86_400_000, updated]);
    };
    insert("old-watch", "watching", NOW - 10 * 86_400_000);
    for (let i = 0; i < 200; i++) insert(`c${i}`, "cancelled", NOW - 1000 + i);
    expect((control.query("SELECT COUNT(*) n FROM control_waits").get() as { n: number }).n).toBe(201);
    const ctx = buildManagerContext(control, null, { now: NOW });
    expect(ctx.waits.some((x) => x.wait_id === "old-watch")).toBe(true);
  });
});

describe("paged reads (§1.2)", () => {
  test("pagination has no duplicates or gaps when every row shares updated_at", () => {
    const control = controlDb(); const w = work(control);
    for (let i = 0; i < 29; i++) item(control, w, `t${i}`, { urgency: i % 3 ? "inbox" : "now", at: NOW - 100 });
    for (let i = 0; i < 25; i++) item(control, w, `d${i}`, { state: "resolved", at: NOW - 100 });
    for (const [view, total] of [["attention", 29], ["done", 25]] as const) {
      const seen: string[] = []; let cursor: string | undefined;
      do { const page = readManagerView(control, null, { view, cursor, now: NOW }); expect(page.total).toBe(total); seen.push(...page.rows.map((r) => (r as { item_id: string }).item_id)); cursor = page.next_cursor ?? undefined; } while (cursor);
      expect(seen).toHaveLength(total); expect(new Set(seen).size).toBe(total);
    }
  });

  test("sessions view pages across the ledger; a cursor past the end is an empty last page", () => {
    const control = controlDb(), ledger = ledgerDb();
    for (let i = 0; i < 13; i++) session(ledger, `s${String(i).padStart(2, "0")}`, { at: NOW - 1000 });
    const first = readManagerView(control, ledger, { view: "sessions", now: NOW });
    expect(first).toMatchObject({ total: 13, next_cursor: "12" }); expect(first.rows).toHaveLength(12);
    const second = readManagerView(control, ledger, { view: "sessions", cursor: first.next_cursor!, now: NOW });
    expect(second.rows).toHaveLength(1); expect(second.next_cursor).toBeNull();
    expect(readManagerView(control, ledger, { view: "sessions", cursor: "999", now: NOW })).toMatchObject({ rows: [], next_cursor: null, total: 13 });
  });
});

const roots: string[] = []; const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function temp(prefix: string) { const root = mkdtempSync(join(tmpdir(), prefix)); roots.push(root); return root; }
function startServer(runModel: RunModel) {
  const root = temp("mgr-verify-web-");
  const ledgerPath = join(root, "ledger.db"), controlPath = join(root, "control.db");
  const l = new Database(ledgerPath); l.exec(readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8")); l.close();
  const c = openControl(controlPath);
  const w = createWork(c, { title: "w", source: "test", contract: { objective: "o", acceptance: [{ id: "a", kind: "human", description: "d" }], non_goals: [], scope: { cwd: "." }, budget: {}, stop_conditions: [{ id: "s", kind: "judgment", description: "d" }], decision_owner: "owner" } });
  upsertAttention(c, { item_id: "i1", work_id: w.work_id, state: "open", effect_state: "not_started", urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null, options: ["ok"], owner: "owner", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {} });
  c.close(); writeFileSync(join(root, "host"), "local\n");
  const server = startWebServer({ ledgerPath, controlPath, orchestratorPath: join(root, "o.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0, manager: { config, runModel } });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (body: unknown) => fetch(`${base}/api/manager/ask`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { base, post, controlPath };
}

describe("HTTP entry (§3)", () => {
  test("two concurrent asks: one answers, the other gets 409 manager_busy; a later ask succeeds", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let calls = 0;
    const { post } = startServer(async () => { calls++; await gate; return { ok: true, text: reply(envelope()) }; });
    const first = post({ question: "a" });
    await Bun.sleep(150);
    const second = await post({ question: "b" });
    expect(second.status).toBe(409); expect(await second.json()).toMatchObject({ error: "manager_busy" });
    release();
    expect(await (await first).json()).toMatchObject({ status: "answered" });
    expect((await post({ question: "c" })).status).toBe(200);
    expect(calls).toBe(2);
  });

  test("input validation: non-object, feishu source, empty/oversized question, bad limit, GET-only routes", async () => {
    const { base, post, controlPath } = startServer(run(reply(envelope())));
    for (const body of ["[]", "not json", { question: "q", source: "feishu" }, { question: "  " }, { question: "x".repeat(20_001) }]) expect((await post(body)).status).toBe(400);
    for (const limit of ["0", "201", "abc", "1.5"]) expect((await fetch(`${base}/api/manager/turns?limit=${limit}`)).status).toBe(400);
    expect((await fetch(`${base}/api/manager/read?view=works&cursor=-3`)).status).toBe(400);
    const c = openControl(controlPath); expect(listManagerTurns(c)).toHaveLength(0); c.close();
    // wrong Host header is refused even for GET (loopback convention)
    expect((await fetch(`${base}/api/manager/context`, { headers: { host: "evil.example" } })).status).toBe(403);
  });
});

describe("CLI entry (§3)", () => {
  function cliPaths() { const root = temp("mgr-verify-cli-"); const configPath = join(root, "config.json"); writeFileSync(configPath, JSON.stringify({ manager: { model: "fake/m" } })); return { controlPath: join(root, "control.db"), ledgerPath: join(root, "none.db"), configPath }; }

  test("invalid envelope via CLI exits 1 and stays readable through turns", async () => {
    const p = cliPaths(); const lines: string[] = [];
    expect(await runManagerCli(["ask", "q"], { ...p, runModel: run("no json here"), out: (l) => lines.push(l) })).toBe(1);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "invalid_envelope" });
    lines.length = 0;
    expect(await runManagerCli(["turns", "1"], { ...p, out: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ status: "invalid_envelope", answer_markdown: "no json here" });
  });

  test.failing("DEFECT: `manager read <bad view>` throws instead of printing usage/error with a non-zero exit", async () => {
    const p = cliPaths();
    expect(await runManagerCli(["read", "bogus"], p)).not.toBe(0);
  });

  test.failing("DEFECT: `manager ask` while a turn is running throws ManagerBusyError instead of a clean manager_busy exit", async () => {
    const p = cliPaths();
    const c = openControl(p.controlPath); beginManagerTurn(c, { source: "web", question: "hold", model: "m", now: Date.now(), timeoutMs: 90_000 }); c.close();
    expect(await runManagerCli(["ask", "q"], { ...p, runModel: run(reply(envelope())), out: () => {} })).not.toBe(0);
  });
});
