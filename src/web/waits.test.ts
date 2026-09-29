import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cancelConditionWait, createConditionWait, createWork, expireConditionWait, getAttention, getConditionWait, listConditionWaits,
  observeConditionWait, openControl, recordWaitRedecision, upsertAttention,
} from "../control/store";
import type { Contract, GithubPrMergedCondition, PrBaseline, WaitBaselineSnapshot, WaitSourceAdapter, WaitSourceAdapters } from "../control/types";
import { checkpointReference, getTarget, grantApproval, resumeGrantScope } from "../decision-bot/mailbox";
import { probeCheckpoint } from "../shared/checkpoint";
import type { CheckpointProbe, ProcessProbe } from "../shared/resume";
import { startWebServer, type ConditionWaitReadModel } from "./server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "../ingest/schema.sql"), "utf8");
const DAY = 86_400_000;
const contract: Contract = {
  objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [],
  scope: { cwd: "." }, budget: {}, stop_conditions: [], decision_owner: "owner",
};
const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
  delete process.env.OVERLOAD_ACTOR;
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Fixture = { root: string; ledgerPath: string; controlPath: string; workId: string; items: string[] };

/** Real temp ledger + control/mailbox files; one open Inbox item per requested id. */
function fixture(itemIds: string[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "overload-web-waits-")); roots.push(root);
  writeFileSync(join(root, "host"), "local\n");
  const ledgerPath = join(root, "ledger.db");
  const ledger = new Database(ledgerPath); ledger.exec(SCHEMA_SQL); ledger.close();
  const controlPath = join(root, "control.db");
  const control = openControl(controlPath);
  const work = createWork(control, { title: "Release train", source: "test", contract });
  for (const itemId of itemIds) {
    upsertAttention(control, { item_id: itemId, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
      conclusion: `Decide ${itemId}`, trigger: "pr", impact: "release blocked", recommendation: null, options: ["continue", "stop"], owner: "owner", expires_at: null,
      source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {} });
  }
  control.close();
  return { root, ledgerPath, controlPath, workId: work.work_id, items: itemIds };
}

const pr = (number: number): GithubPrMergedCondition => ({ kind: "github_pr_merged", source: { provider: "github", host: "github.com", owner: "acme", repo: "app", number } });
function openSnapshot(condition: GithubPrMergedCondition, at: number): WaitBaselineSnapshot<PrBaseline> {
  return { baseline: { ...condition.source, state: "OPEN", merged_at: null, updated_at: "2026-09-27T00:00:00Z", observed_at: at }, baseline_generation: at, fingerprint: `pr:${condition.source.number}:open`, established_at: at };
}

/** Server-owned PR adapter double: counts baseline reads, optionally fails like the real provider. */
function adapters(calls: { baseline: number }, fail?: Error): WaitSourceAdapters {
  const github: WaitSourceAdapter<GithubPrMergedCondition, PrBaseline> = {
    kind: "github_pr_merged",
    async establishBaseline(condition) { calls.baseline++; if (fail) throw fail; return openSnapshot(condition, Date.now() - 5); },
    async observe() { throw new Error("the Web never observes"); },
  };
  const unused = (kind: string) => ({ kind, async establishBaseline() { throw new Error(`unexpected ${kind}`); }, async observe() { throw new Error("unexpected"); } });
  return { github_pr_merged: github, check_new_result: unused("check_new_result"), work_completed: unused("work_completed") } as unknown as WaitSourceAdapters;
}

/** Waits are enabled unless a test passes `conditionWaits` explicitly (`undefined` = resolve from env). */
function boot(f: Fixture, options: { actor?: string; waitAdapters?: WaitSourceAdapters; conditionWaits?: boolean } = {}): string {
  const server = startWebServer({ ledgerPath: f.ledgerPath, controlPath: f.controlPath, orchestratorPath: join(f.root, "orch.db"), spoolRoot: f.root,
    publishIntervalMs: 60_000, port: 0, actor: options.actor, waitAdapters: options.waitAdapters ?? adapters({ baseline: 0 }),
    conditionWaits: "conditionWaits" in options ? options.conditionWaits : true });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

async function call(base: string, path: string, body?: unknown, origin = base): Promise<{ status: number; data: any }> {
  const response = await fetch(base + path, body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  return { status: response.status, data: await response.json() };
}

const createBody = (f: Fixture, itemId: string, number = 7) => ({ work_id: f.workId, item_id: itemId, condition: pr(number), deadline_at: Date.now() + DAY });

describe("/api/waits routes", () => {
  test("without a server actor every wait route is 501 and nothing is created", async () => {
    const f = fixture(["item-a"]);
    const calls = { baseline: 0 };
    const base = boot(f, { waitAdapters: adapters(calls) });
    expect((await call(base, "/api/waits")).status).toBe(501);
    expect((await call(base, "/api/waits", createBody(f, "item-a"))).status).toBe(501);
    expect(calls.baseline).toBe(0);
    const control = openControl(f.controlPath);
    try { expect(listConditionWaits(control)).toEqual([]); } finally { control.close(); }
  });

  test("§14.1: creation is default-off; only OVERLOAD_CONDITION_WAITS=1 enables it", async () => {
    const saved = process.env.OVERLOAD_CONDITION_WAITS;
    try {
      for (const value of [undefined, "", "0", "true", "yes", " 1"]) {
        if (value === undefined) delete process.env.OVERLOAD_CONDITION_WAITS; else process.env.OVERLOAD_CONDITION_WAITS = value;
        const f = fixture(["item-a"]);
        const calls = { baseline: 0 };
        const refused = await call(boot(f, { actor: "owner", waitAdapters: adapters(calls), conditionWaits: undefined }), "/api/waits", createBody(f, "item-a"));
        expect(refused).toMatchObject({ status: 503, data: { error: "disabled", code: "condition_waits_disabled" } });
        expect(calls.baseline).toBe(0);
        const control = openControl(f.controlPath);
        try { expect(listConditionWaits(control)).toEqual([]); } finally { control.close(); }
      }
      process.env.OVERLOAD_CONDITION_WAITS = "1";
      const f = fixture(["item-a"]);
      const calls = { baseline: 0 };
      const created = await call(boot(f, { actor: "owner", waitAdapters: adapters(calls), conditionWaits: undefined }), "/api/waits", createBody(f, "item-a"));
      expect(created.status).toBe(201);
      expect(calls.baseline).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.OVERLOAD_CONDITION_WAITS; else process.env.OVERLOAD_CONDITION_WAITS = saved;
    }
  });

  test("§14.1/§14.3: a disabled server lists, reads and cancels existing waits, marks watching observation paused, and touches no adapter", async () => {
    const f = fixture(["item-a", "item-b"]);
    const enabled = boot(f, { actor: "owner" });
    const created = (await call(enabled, "/api/waits", createBody(f, "item-a"))).data.wait;
    const other = (await call(enabled, "/api/waits", createBody(f, "item-b", 8))).data.wait;
    const control = openControl(f.controlPath);
    try { cancelConditionWait(control, other.wait_id, 1, { actor: "owner", reason: "history" }); } finally { control.close(); }
    // Enabled: observation active with a real next-check promise; gate is reported as enabled.
    const live = await call(enabled, "/api/waits");
    expect(live.data.gate).toEqual({ enabled: true, reason: null });
    const liveRow = (live.data.items as ConditionWaitReadModel[]).find((m) => m.wait.wait_id === created.wait_id)!;
    expect(liveRow.observation).toEqual({ state: "active", reason: null });
    expect(liveRow.schedule.next_check_at).toBe(created.next_check_at);
    expect(typeof liveRow.schedule.next_check_at).toBe("number");

    const calls = { baseline: 0 };
    const disabled = boot(f, { actor: "owner", waitAdapters: adapters(calls), conditionWaits: false });
    const listed = await call(disabled, "/api/waits");
    expect(listed.data.gate).toEqual({ enabled: false, reason: "condition_waits_disabled" });
    const byId = Object.fromEntries((listed.data.items as ConditionWaitReadModel[]).map((m) => [m.wait.wait_id, m]));
    expect(Object.keys(byId).sort()).toEqual([created.wait_id, other.wait_id].sort());
    // Paused: no next-check promise in the schedule; the persisted row (and its last confirmation) is untouched.
    expect(byId[created.wait_id]).toMatchObject({ observation: { state: "paused", reason: "condition_waits_disabled" }, schedule: { next_check_at: null, deadline_at: created.deadline_at },
      wait: { state: "watching", version: 1, next_check_at: created.next_check_at }, latest_observation: { confirmed_at: created.last_confirmed_at }, actions: { cancel: true } });
    // Terminal rows were not being observed either way; they are never "paused".
    expect(byId[other.wait_id].observation).toEqual({ state: "stopped", reason: null });
    const read = (await call(disabled, `/api/waits/${created.wait_id}`)).data;
    expect(read).toMatchObject({ wait: { state: "watching", version: 1 }, observation: { state: "paused" }, schedule: { next_check_at: null } });
    const cancelled = await call(disabled, `/api/waits/${created.wait_id}/cancel`, { expected_version: 1, reason: "paused rollout" });
    expect(cancelled.status).toBe(200);
    expect(cancelled.data.wait).toMatchObject({ state: "cancelled" });
    expect((await call(disabled, `/api/waits/${created.wait_id}`)).data.observation).toEqual({ state: "stopped", reason: null });
    expect(calls.baseline).toBe(0);
  });

  test("§14.3: a stale cancel on a disabled server returns the current row still marked paused", async () => {
    const f = fixture(["item-a"]);
    const created = (await call(boot(f, { actor: "owner" }), "/api/waits", createBody(f, "item-a"))).data.wait;
    const stale = await call(boot(f, { actor: "owner", conditionWaits: false }), `/api/waits/${created.wait_id}/cancel`, { expected_version: 99, reason: "late" });
    expect(stale.status).toBe(409);
    expect(stale.data.current).toMatchObject({ wait: { state: "watching", version: 1 }, observation: { state: "paused" }, schedule: { next_check_at: null } });
  });

  test("create samples the server-owned adapter, binds the server actor and never returns resume_grant", async () => {
    const f = fixture(["item-a"]);
    const calls = { baseline: 0 };
    const base = boot(f, { actor: "owner", waitAdapters: adapters(calls) });
    const created = await call(base, "/api/waits", createBody(f, "item-a"));
    expect(created.status).toBe(201);
    expect(calls.baseline).toBe(1);
    expect(created.data.wait).toMatchObject({ state: "watching", version: 1, actor: "owner", decision_owner: "owner", has_resume_grant: false, disposition: "redecide" });
    expect("resume_grant" in created.data.wait).toBe(false);
    expect(["unsupported", "unknown"]).toContain(created.data.recovery_capability.state);

    const one = await call(base, `/api/waits/${created.data.wait.wait_id}`);
    expect(one.status).toBe(200);
    expect(one.data.condition_summary).toBe("GitHub PR acme/app#7 is merged");
    expect(one.data.schedule.next_check_at).toBeGreaterThan(0);
    expect(one.data.attention).toMatchObject({ item_id: "item-a", state: "open" });
    expect(one.data.actions).toMatchObject({ cancel: true, answer: false, resume: false });
    expect(JSON.stringify(one.data)).not.toContain("\"resume_grant\"");
    const list = await call(base, `/api/waits?item_id=item-a&state=watching`);
    expect(list.data.items.map((m: any) => m.wait.wait_id)).toEqual([created.data.wait.wait_id]);
    expect((await call(base, "/api/waits/missing")).status).toBe(404);
    expect((await call(base, "/api/waits?state=bogus")).status).toBe(400);
  });

  test("client-supplied actor/owner fields, cross-origin posts and ready/resume routes are refused", async () => {
    const f = fixture(["item-a"]);
    const calls = { baseline: 0 };
    const base = boot(f, { actor: "owner", waitAdapters: adapters(calls) });
    expect((await call(base, "/api/waits", { ...createBody(f, "item-a"), actor: "owner" })).status).toBe(400);
    expect((await call(base, "/api/waits", { ...createBody(f, "item-a"), decision_owner: "owner" })).status).toBe(400);
    expect((await call(base, "/api/waits", createBody(f, "item-a"), "http://evil.example")).status).toBe(403);
    expect((await call(base, "/api/waits", { ...createBody(f, "item-a"), deadline_at: Date.now() - 1 })).status).toBe(400);
    expect(calls.baseline).toBe(0);
    const created = await call(base, "/api/waits", createBody(f, "item-a"));
    const id = created.data.wait.wait_id;
    for (const op of ["ready", "observe", "resume", "dispatch"]) expect((await call(base, `/api/waits/${id}/${op}`, {})).status).toBe(404);
    expect((await call(base, `/api/waits/${id}/cancel`, { expected_version: 1, reason: "x", actor: "someone" })).status).toBe(400);
  });

  test("a trusted actor that is not the decision owner is 403 and sees a redacted read model", async () => {
    const f = fixture(["item-a"]);
    const owner = boot(f, { actor: "owner" });
    const created = await call(owner, "/api/waits", createBody(f, "item-a"));
    const other = boot(f, { actor: "mallory" });
    expect((await call(other, "/api/waits", createBody(f, "item-a", 8))).status).toBe(403);
    const view = await call(other, `/api/waits/${created.data.wait.wait_id}`);
    expect(view.data.wait.condition).toEqual({ kind: "github_pr_merged" });
    expect(view.data.wait.source_identity).toEqual({});
    expect(view.data.wait.observed).toBeNull();
    expect(view.data.wait.baseline).toBeNull();
    expect(view.data.condition_summary).not.toContain("acme");
    expect(view.data.actions).toEqual({ cancel: false, jump_url: null, answer: false, resume: false });
    expect((await call(other, `/api/waits/${created.data.wait.wait_id}/cancel`, { expected_version: 1, reason: "not mine" })).status).toBe(403);
  });

  test("duplicate exact condition is 409 active_wait_exists with the current row; unsupported provider is 422 and creates nothing", async () => {
    const f = fixture(["item-a", "item-b"]);
    const base = boot(f, { actor: "owner" });
    const first = await call(base, "/api/waits", createBody(f, "item-a"));
    const duplicate = await call(base, "/api/waits", createBody(f, "item-a"));
    expect(duplicate.status).toBe(409);
    expect(duplicate.data).toMatchObject({ code: "active_wait_exists", wait_id: first.data.wait.wait_id, version: 1, state: "watching" });
    expect(duplicate.data.current.wait.wait_id).toBe(first.data.wait.wait_id);

    const unsupported = Object.assign(new Error("host ghe.example is not a supported provider"), { error_kind: "unsupported_provider" });
    const rejecting = boot(f, { actor: "owner", waitAdapters: adapters({ baseline: 0 }, unsupported) });
    const refused = await call(rejecting, "/api/waits", createBody(f, "item-b", 9));
    expect(refused.status).toBe(422);
    expect(refused.data.error_kind).toBe("unsupported_provider");
    const unreachable = Object.assign(new Error("gh: connection reset"), { error_kind: "transient" });
    const failing = boot(f, { actor: "owner", waitAdapters: adapters({ baseline: 0 }, unreachable) });
    expect(await call(failing, "/api/waits", createBody(f, "item-b", 9))).toMatchObject({ status: 409, data: { code: "baseline_unbindable", error_kind: "transient" } });
    const control = openControl(f.controlPath);
    try { expect(listConditionWaits(control, { item_id: "item-b" })).toEqual([]); } finally { control.close(); }
  });

  test("cancel is version CAS: a stale version returns 409 with the current row and changes nothing", async () => {
    const f = fixture(["item-a"]);
    const base = boot(f, { actor: "owner" });
    const created = (await call(base, "/api/waits", createBody(f, "item-a"))).data.wait;
    const control = openControl(f.controlPath);
    try {
      const now = Date.now();
      observeConditionWait(control, created.wait_id, 1, { kind: "same", observed: created.observed, fingerprint: created.observed_fingerprint, source_generation: created.source_generation, observed_at: now }, { next_check_at: now + 300_000 }, now);
      const stale = await call(base, `/api/waits/${created.wait_id}/cancel`, { expected_version: 1, reason: "no longer needed" });
      expect(stale.status).toBe(409);
      expect(stale.data).toMatchObject({ wait_id: created.wait_id, version: 2, state: "watching", expected_version: 1 });
      expect(stale.data.current.wait).toMatchObject({ version: 2, state: "watching", unchanged_count: 1 });
      expect(getConditionWait(control, created.wait_id)).toMatchObject({ version: 2, state: "watching" });
      const ok = await call(base, `/api/waits/${created.wait_id}/cancel`, { expected_version: 2, reason: "no longer needed" });
      expect(ok.status).toBe(200);
      expect(ok.data.wait).toMatchObject({ state: "cancelled", version: 3, state_reason: "no longer needed" });
      expect("resume_grant" in ok.data.wait).toBe(false);
      expect((await call(base, `/api/waits/${created.wait_id}/cancel`, { expected_version: 3, reason: "again" })).status).toBe(409);
      // Cancelling a wait never touches the original Attention.
      expect(getAttention(control, "item-a")).toMatchObject({ state: "open", revision: 1 });
    } finally { control.close(); }
  });
});

/** Seeds one wait per state directly through the control store (the observer's own API). */
function seedStates(f: Fixture) {
  const control = openControl(f.controlPath);
  try {
    const t0 = Date.now() - 60_000;
    const make = (itemId: string, number: number, deadline = t0 + DAY) => createConditionWait(control, { work_id: f.workId, item_id: itemId, condition: pr(number), deadline_at: deadline },
      { actor: "owner", baseline: openSnapshot(pr(number), t0), now: t0 + 100 });
    const watching = make("item-watch", 1);
    const ready = make("item-ready", 2);
    const merged = observeConditionWait(control, ready.wait_id, 1, { kind: "ready", observed: { ...pr(2).source, state: "MERGED", merged_at: "2026-09-27T01:00:00Z", updated_at: "2026-09-27T01:00:00Z" },
      fingerprint: "pr:2:merged", source_generation: t0 + 500, observed_at: t0 + 500 }, { next_check_at: null }, t0 + 600).wait;
    recordWaitRedecision(control, ready.wait_id, merged.version, { attention_revision: 1, reason: "condition met", now: t0 + 700 });
    const denied = make("item-unavailable", 3);
    const failed = observeConditionWait(control, denied.wait_id, 1, { kind: "error", error_kind: "permission_denied", detail: "gh: HTTP 403 resource not accessible", observed_at: t0 + 500 }, { next_check_at: null }, t0 + 600).wait;
    recordWaitRedecision(control, denied.wait_id, failed.version, { attention_revision: 1, reason: "source unavailable", now: t0 + 700 });
    const late = make("item-expired", 4, t0 + 1_000);
    const expired = expireConditionWait(control, late.wait_id, 1, "deadline", t0 + 1_001);
    recordWaitRedecision(control, late.wait_id, expired.version, { attention_revision: 1, reason: "deadline passed", now: t0 + 1_002 });
    const history = make("item-cancelled", 5);
    cancelConditionWait(control, history.wait_id, 1, { actor: "owner", reason: "merged elsewhere", now: t0 + 200 });
    return { watching: watching.wait_id };
  } finally { control.close(); }
}

/**
 * Real Chromium over the real server. The script pauses on "PAUSE" so the test can advance the wait through the
 * observer's store API (a concurrent runner round) before the stale Cancel is confirmed.
 */
async function browser(base: string, watchingId: string, shots: string, onPause: () => void): Promise<Record<string, any>> {
  const script = String.raw`
import json, sys
from playwright.sync_api import sync_playwright
base, watching, shots = sys.argv[1], sys.argv[2], sys.argv[3]
out = {}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 1800})
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.set_default_timeout(10000)
    page.goto(base + "/decide")
    page.locator('.row[data-item-id="item-ready"]').wait_for()
    # Decision packages load per row after the owed list renders; actions exist only once each row's package is in.
    page.wait_for_function("() => ![...document.querySelectorAll('.row[data-item-id] .row-note')].some(n => n.textContent.startsWith('Loading decision context'))")
    main = page.locator("main")
    out["owed_items"] = sorted(page.locator('.row[data-item-id]').evaluate_all("els => els.map(e => e.dataset.itemId)"))
    out["top_line"] = page.locator(".summary").inner_text()
    out["ready_note"] = page.locator('.row[data-item-id="item-ready"] .wait-note').inner_text()
    out["toggle"] = page.locator('[data-action="toggle-waits"]').inner_text()
    out["collapsed_rows"] = page.locator(".row.wait").count()
    out["create_buttons"] = page.locator('[data-action="wait-create"]').count()
    out["create_disabled_notes"] = page.locator(".wait-create-disabled").count()
    page.locator('[data-action="toggle-waits"]').click()
    try:
        page.locator('.row.wait[data-wait-state="watching"]').wait_for()
    except Exception:
        sys.stderr.write(json.dumps({"page_errors": page_errors, "main": main.inner_html()[:4000]}))
        raise
    rows = {}
    for state in ["watching", "ready", "unavailable", "expired", "cancelled"]:
        row = page.locator('.row.wait[data-wait-state="%s"]' % state)
        rows[state] = {"text": row.inner_text(), "buttons": row.locator("button").evaluate_all("els => els.map(e => e.textContent)")}
    out["rows"] = rows
    out["resume_buttons"] = main.locator("button", has_text="Resume").count()
    out["paused_rows"] = page.locator('.row.wait[data-observation="paused"]').count()
    page.screenshot(path=shots + "/decide-waits.png", full_page=True)
    page.locator('.row.wait[data-wait-state="ready"] [data-action="wait-review"]').click()
    out["revealed_in_view"] = page.locator('.row[data-item-id="item-ready"]').evaluate("el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }")
    page.goto(base + "/works")
    page.locator("details.work summary").click()
    out["work_rows"] = page.locator("details.work .row.wait").count()
    out["work_heading"] = page.locator("details.work h3").inner_text()
    page.screenshot(path=shots + "/work-detail-waits.png", full_page=True)
    page.goto(base + "/decide")
    page.locator('[data-action="toggle-waits"]').click()
    row = page.locator('.row.wait[data-wait-id="%s"]' % watching)
    row.locator('[data-action="wait-cancel"]').click()
    page.fill("#wait-cancel-reason", "no longer needed")
    print("PAUSE", flush=True)
    sys.stdin.readline()
    page.locator('[data-action="wait-cancel-save"]').click()
    page.locator("#error").wait_for(state="visible")
    page.wait_for_function("id => document.querySelector('.row.wait[data-wait-id=\"' + id + '\"]')?.dataset.version === '2'", arg=watching)
    out["stale_error"] = page.locator("#error").inner_text()
    out["stale_row_version"] = row.get_attribute("data-version")
    out["stale_row_state"] = row.get_attribute("data-wait-state")
    page.screenshot(path=shots + "/stale-cancel.png", full_page=True)
    page.reload()
    page.locator('[data-action="toggle-waits"]').click()
    out["after_reload_version"] = page.locator('.row.wait[data-wait-id="%s"]' % watching).get_attribute("data-version")
    browser.close()
print(json.dumps(out), flush=True)
`;
  const proc = Bun.spawn(["python3", "-c", script, base, watchingId, shots], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of proc.stdout) {
    text += decoder.decode(chunk);
    if (text.includes("PAUSE\n") && !text.includes("RESUMED")) { onPause(); proc.stdin.write("go\n"); proc.stdin.flush(); text += "RESUMED\n"; }
  }
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`browser probe failed (${code}): ${stderr}`);
  return JSON.parse(text.split("\n").filter((line) => line.startsWith("{")).pop()!);
}

describe("condition waits in the browser", () => {
  test("watching is quiet, ready/unavailable/expired return with named exits, no Resume, stale cancel shows the current row", async () => {
    const f = fixture(["item-watch", "item-ready", "item-unavailable", "item-expired", "item-cancelled"]);
    const { watching } = seedStates(f);
    const base = boot(f, { actor: "owner" });
    const shots = process.env.OVERLOAD_WAIT_SCREENSHOTS ?? join(f.root, "shots");
    mkdirSync(shots, { recursive: true });
    const dom = await browser(base, watching, shots, () => {
      const control = openControl(f.controlPath);
      try {
        const current = getConditionWait(control, watching)!;
        const now = Date.now();
        observeConditionWait(control, watching, current.version, { kind: "same", observed: current.observed!, fingerprint: current.observed_fingerprint!, source_generation: current.source_generation, observed_at: now }, { next_check_at: now + 300_000 }, now);
      } finally { control.close(); }
    });

    // Quiet watching: the waiting item is not owed and not counted; other items stay owed.
    expect(dom.owed_items).toEqual(["item-cancelled", "item-expired", "item-ready", "item-unavailable"]);
    expect(dom.top_line).toMatch(/^4 decisions owed/);
    expect(dom.toggle).toContain("1 watching");
    expect(dom.collapsed_rows).toBe(0);
    expect(dom.ready_note).toContain("Condition met");

    const { rows } = dom;
    expect(rows.watching.text).toContain("GitHub PR acme/app#1 is merged");
    expect(rows.watching.text).toContain("Watching quietly");
    expect(rows.watching.text).toMatch(/Next check\s+\S/);
    expect(rows.watching.text).toContain("Return the original decision to you to re-decide");
    expect(rows.watching.buttons).toEqual(["Cancel wait"]);
    expect(rows.ready.text).toContain("Condition met");
    expect(rows.ready.text).toContain("original decision returned to you");
    expect(rows.ready.text).toContain("— not watching");
    expect(rows.ready.buttons).toEqual(["Re-decide now"]);
    expect(rows.unavailable.text).toContain("permission_denied: gh: HTTP 403 resource not accessible");
    expect(rows.unavailable.buttons).toEqual(["Decide without this wait"]);
    expect(rows.expired.text).toContain("Deadline passed; the condition was not confirmed");
    expect(rows.expired.buttons).toEqual(["Decide without this wait"]);
    expect(rows.cancelled.text).toContain("merged elsewhere");
    expect(rows.cancelled.buttons).toEqual([]);
    for (const row of Object.values(rows) as Array<{ text: string }>) expect(row.text).toMatch(/Recovery\s+(Unknown|Not supported)/);
    expect(dom.resume_buttons).toBe(0);
    expect(dom.revealed_in_view).toBe(true);
    expect(dom.work_rows).toBe(5);
    expect(dom.work_heading).toContain("1 watching · 5 total");
    // Enabled server: create is offered, nothing is marked paused, the watching row promises a next check.
    expect(dom.create_buttons).toBe(4);
    expect(dom.create_disabled_notes).toBe(0);
    expect(dom.paused_rows).toBe(0);
    expect(rows.watching.text).not.toContain("paused");

    // Stale cancellation: the observer advanced the wait to v2 while the dialog held v1.
    expect(dom.stale_error).toContain("Nothing was cancelled");
    expect(dom.stale_row_version).toBe("2");
    expect(dom.stale_row_state).toBe("watching");
    expect(dom.after_reload_version).toBe("2");
    const control = openControl(f.controlPath);
    try { expect(getConditionWait(control, watching)).toMatchObject({ state: "watching", version: 2 }); } finally { control.close(); }
  }, 60_000);

  test("§14.3: with condition waits disabled, watching rows show observation paused, no next-check promise, no create, and cancel still works", async () => {
    const f = fixture(["item-watch", "item-ready", "item-unavailable", "item-expired", "item-cancelled"]);
    const { watching } = seedStates(f);
    const base = boot(f, { actor: "owner", conditionWaits: false });
    const shots = process.env.OVERLOAD_WAIT_SCREENSHOTS ?? join(f.root, "shots");
    mkdirSync(shots, { recursive: true });
    const script = String.raw`
import json, sys
from playwright.sync_api import sync_playwright
base, watching, shots = sys.argv[1], sys.argv[2], sys.argv[3]
out = {}
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1280, "height": 1800})
    page_errors = []
    page.on("pageerror", lambda error: page_errors.append(str(error)))
    page.set_default_timeout(10000)
    page.goto(base + "/decide")
    page.locator('.row[data-item-id="item-ready"]').wait_for()
    page.wait_for_function("() => ![...document.querySelectorAll('.row[data-item-id] .row-note')].some(n => n.textContent.startsWith('Loading decision context'))")
    out["toggle"] = page.locator('[data-action="toggle-waits"]').inner_text()
    out["create_buttons"] = page.locator('[data-action="wait-create"]').count()
    out["create_disabled_notes"] = page.locator(".wait-create-disabled").evaluate_all("els => els.map(e => e.textContent)")
    page.locator('[data-action="toggle-waits"]').click()
    row = page.locator('.row.wait[data-wait-id="%s"]' % watching)
    row.wait_for()
    out["watching"] = {"text": row.inner_text(), "observation": row.get_attribute("data-observation"), "state": row.get_attribute("data-wait-state"),
        "badge": row.locator(".badge").inner_text(), "next_check": row.locator("dt:text-is('Next check') + dd").inner_text(),
        "buttons": row.locator("button").evaluate_all("els => els.map(e => e.textContent)")}
    ready = page.locator('.row.wait[data-wait-state="ready"]')
    out["ready"] = {"text": ready.inner_text(), "observation": ready.get_attribute("data-observation")}
    out["paused_rows"] = page.locator('.row.wait[data-observation="paused"]').count()
    page.screenshot(path=shots + "/decide-waits-paused.png", full_page=True)
    page.goto(base + "/works")
    page.locator("details.work summary").click()
    out["work_paused_rows"] = page.locator('details.work .row.wait[data-observation="paused"]').count()
    page.screenshot(path=shots + "/work-detail-waits-paused.png", full_page=True)
    page.goto(base + "/decide")
    page.locator('[data-action="toggle-waits"]').click()
    page.locator('.row.wait[data-wait-id="%s"] [data-action="wait-cancel"]' % watching).click()
    page.fill("#wait-cancel-reason", "rollout paused")
    page.locator('[data-action="wait-cancel-save"]').click()
    page.wait_for_function("id => document.querySelector('.row.wait[data-wait-id=\"' + id + '\"]')?.dataset.waitState === 'cancelled'", arg=watching)
    after = page.locator('.row.wait[data-wait-id="%s"]' % watching)
    out["after_cancel"] = {"observation": after.get_attribute("data-observation"), "text": after.inner_text()}
    out["page_errors"] = page_errors
    browser.close()
print(json.dumps(out), flush=True)
`;
    const proc = Bun.spawn(["python3", "-c", script, base, watching, shots], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`browser probe failed (${code}): ${stderr}`);
    const dom = JSON.parse(stdout.trim().split("\n").pop()!);

    expect(dom.page_errors).toEqual([]);
    expect(dom.toggle).toContain("1 watching (observation paused)");
    // Create is never offered; each open item says why instead.
    expect(dom.create_buttons).toBe(0);
    expect(dom.create_disabled_notes).toEqual(Array(4).fill("Condition waits are disabled on this server"));
    expect(dom.watching).toMatchObject({ observation: "paused", state: "watching", badge: "Observation paused", buttons: ["Cancel wait"] });
    expect(dom.watching.text).toContain("Observation paused · condition waits are disabled on this server");
    expect(dom.watching.text).not.toContain("Watching quietly");
    // No next-check promise: the dd carries no timestamp, only the paused explanation.
    expect(dom.watching.next_check).toBe("— paused, no check scheduled while condition waits are disabled");
    expect(dom.watching.text).toMatch(/Last confirmed\s+PR open/);
    // Terminal rows are unaffected by the gate.
    expect(dom.ready.observation).toBeNull();
    expect(dom.ready.text).toContain("Condition met");
    expect(dom.paused_rows).toBe(1);
    expect(dom.work_paused_rows).toBe(1);
    expect(dom.after_cancel.observation).toBeNull();
    expect(dom.after_cancel.text).toContain("rollout paused");
    const control = openControl(f.controlPath);
    try { expect(getConditionWait(control, watching)).toMatchObject({ state: "cancelled", state_reason: "rollout paused" }); } finally { control.close(); }
  }, 60_000);
});

const GRANT_STABLE_ID = "local:pi:grant-session";
const GRANT_RUNTIME_SESSION = "grant-runtime-session";
const GRANT_PID = 4242;
type GrantFixture = Fixture & { itemId: string; sessionFile: string; checkpointProbe: CheckpointProbe };

/**
 * `fixture` plus an Attention item owning an orchestrator approval slot, a terminated pi session in the real ledger
 * (dead pid + session_ended) and an intact session file under temporary runtime roots read by the real checkpoint probe.
 */
function grantFixture(): GrantFixture {
  const f = fixture([]);
  const control = openControl(f.controlPath);
  try {
    upsertAttention(control, { item_id: "item-g", work_id: f.workId, state: "open", effect_state: "not_started", urgency: "inbox",
      conclusion: "Resume after merge", trigger: "pr", impact: "release blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
      source_link: null, approval_id: "ap-g", consumer_owner: "orchestrator", contract_revision: 1, decision_mode: "human_only", evidence: {} });
  } finally { control.close(); }
  const ledger = new Database(f.ledgerPath);
  try {
    const t0 = Date.now() - 60_000;
    ledger.run("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,branch,created_at,first_seen_at) VALUES(?,?,?,?,?,?,?,?,?)",
      [GRANT_STABLE_ID, "local", "pi", GRANT_RUNTIME_SESSION, "human", "/repo", "main", t0, t0]);
    ledger.run("INSERT INTO session_incarnations(stable_id,writer_id,liveness_domain,pid,proc_boot_id,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
      [GRANT_STABLE_ID, "writer-1", "process", GRANT_PID, "boot-1", t0, t0]);
    ledger.run("INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind) VALUES(?,?,?,?,?,?,?)", ["local", "writer-1", 1, t0, GRANT_STABLE_ID, "writer-1", "session_ended"]);
  } finally { ledger.close(); }
  const roots = { pi: join(f.root, "pi-sessions"), omp: join(f.root, "omp-sessions") };
  mkdirSync(join(roots.pi, "--repo--"), { recursive: true });
  mkdirSync(roots.omp, { recursive: true });
  const sessionFile = join(roots.pi, "--repo--", `2026-09-28T00-00-00-000Z_${GRANT_RUNTIME_SESSION}.jsonl`);
  writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: GRANT_RUNTIME_SESSION, cwd: "/repo", timestamp: "2026-09-28T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "e1" })}\n`);
  return { ...f, itemId: "item-g", sessionFile, checkpointProbe: (input) => probeCheckpoint(input, { sessionRoots: roots }) };
}

function bootGrant(f: GrantFixture, options: { actor?: string; waitAdapters?: WaitSourceAdapters; processAlive?: ProcessProbe } = {}): string {
  const server = startWebServer({ ledgerPath: f.ledgerPath, controlPath: f.controlPath, orchestratorPath: join(f.root, "orch.db"), spoolRoot: f.root,
    publishIntervalMs: 60_000, port: 0, actor: options.actor, waitAdapters: options.waitAdapters ?? adapters({ baseline: 0 }), conditionWaits: true,
    processAlive: options.processAlive ?? (() => false), checkpointProbe: f.checkpointProbe });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const grantBody = (f: GrantFixture, extra: Record<string, unknown> = {}) =>
  ({ work_id: f.workId, item_id: f.itemId, condition: pr(9), deadline_at: Date.now() + DAY, stable_id: GRANT_STABLE_ID, ...extra });

/** Nothing pinned and nothing watching: no approval target in the mailbox, no wait row in control. */
function assertNothingCreated(f: GrantFixture) {
  const db = openControl(f.controlPath);
  try {
    const mailbox = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='approval_targets'").get();
    expect(mailbox ? getTarget(db, "orchestrator", "ap-g") : null).toBeNull();
    expect(listConditionWaits(db)).toEqual([]);
  } finally { db.close(); }
}

describe("POST /api/waits/resume-grant", () => {
  test("501 without a server actor; client-supplied checkpoint, grant or identity fields are 400; nothing is pinned", async () => {
    const f = grantFixture();
    const calls = { baseline: 0 };
    expect((await call(bootGrant(f, { waitAdapters: adapters(calls) }), "/api/waits/resume-grant", grantBody(f))).status).toBe(501);
    const base = bootGrant(f, { actor: "owner", waitAdapters: adapters(calls) });
    for (const field of ["checkpoint_reference", "disposition", "authorization", "attempt_id", "execution_owner", "actor", "file", "byte_len", "last_entry_id"]) {
      const refused = await call(base, "/api/waits/resume-grant", grantBody(f, { [field]: "client" }));
      expect(refused).toMatchObject({ status: 400, data: { error: "invalid", code: "server_derived_field" } });
    }
    expect(calls.baseline).toBe(0);
    assertNothingCreated(f);
  });

  test("403 for a non-owner actor, before any checkpoint pin or baseline read", async () => {
    const f = grantFixture();
    const calls = { baseline: 0 };
    const refused = await call(bootGrant(f, { actor: "intruder", waitAdapters: adapters(calls) }), "/api/waits/resume-grant", grantBody(f));
    expect(refused).toMatchObject({ status: 403, data: { error: "forbidden" } });
    expect(calls.baseline).toBe(0);
    assertNothingCreated(f);
  });

  test("409 checkpoint_unavailable for a missing checkpoint or unproven liveness; nothing is pinned", async () => {
    const f = grantFixture();
    const calls = { baseline: 0 };
    // The recorded pid is still visible after session_ended: liveness is unknown, so no checkpoint is pinned.
    const alive = await call(bootGrant(f, { actor: "owner", waitAdapters: adapters(calls), processAlive: (pid) => pid === GRANT_PID }), "/api/waits/resume-grant", grantBody(f));
    expect(alive).toMatchObject({ status: 409, data: { error: "conflict", code: "checkpoint_unavailable" } });
    expect(alive.data.message).toContain("liveness_unknown");
    rmSync(f.sessionFile);
    const missing = await call(bootGrant(f, { actor: "owner", waitAdapters: adapters(calls) }), "/api/waits/resume-grant", grantBody(f));
    expect(missing).toMatchObject({ status: 409, data: { error: "conflict", code: "checkpoint_unavailable" } });
    expect(missing.data.message).toContain("no_session_file");
    expect(calls.baseline).toBe(0);
    assertNothingCreated(f);
  });

  test("success pins the server-probed checkpoint grant with the owner's approval and creates the authorized_resume wait bound to it", async () => {
    const f = grantFixture();
    const base = bootGrant(f, { actor: "owner" });
    const created = await call(base, "/api/waits/resume-grant", grantBody(f));
    expect(created.status).toBe(201);
    expect(created.data.wait).toMatchObject({ disposition: "authorized_resume", has_resume_grant: true, state: "watching", item_id: f.itemId, actor: "owner" });
    expect("resume_grant" in created.data.wait).toBe(false);
    expect(JSON.stringify(created.data)).not.toContain(f.sessionFile);
    const db = openControl(f.controlPath);
    try {
      const target = getTarget(db, "orchestrator", "ap-g")!;
      const scope = resumeGrantScope(target)!;
      expect(target).toMatchObject({ effect: "resume_checkpoint", state: "active", stableId: GRANT_STABLE_ID, workId: f.workId, contractRevision: 1 });
      expect(scope).toMatchObject({ stable_id: GRANT_STABLE_ID, runtime: "pi", session: GRANT_RUNTIME_SESSION, cwd: "/repo", file: f.sessionFile,
        last_entry_id: "e1", byte_len: readFileSync(f.sessionFile).byteLength, item_id: f.itemId, execution_owner: "maintenance", condition: pr(9) });
      expect(grantApproval(db, "orchestrator", "ap-g")).toEqual({ answer: "approve", actor: "owner" });
      const wait = getConditionWait(db, created.data.wait.wait_id)!;
      expect(wait.resume_grant).toMatchObject({
        consumer_owner: "orchestrator", approval_id: "ap-g", target_version: target.targetVersion, approved_effect: "resume_checkpoint",
        attempt_id: target.attemptId, checkpoint_reference: checkpointReference(scope),
        execution_owner: "maintenance", expires_at: wait.deadline_at,
      });
      // The same exact condition again is the existing wait's 409; its grant stays pinned and active.
      const duplicate = await call(base, "/api/waits/resume-grant", grantBody(f));
      expect(duplicate).toMatchObject({ status: 409, data: { code: "active_wait_exists", wait_id: wait.wait_id } });
      expect(getTarget(db, "orchestrator", "ap-g")).toMatchObject({ state: "active", targetVersion: target.targetVersion });
    } finally { db.close(); }
  });

  test("a wait that cannot bind its baseline closes the just-pinned grant", async () => {
    const f = grantFixture();
    const failure = Object.assign(new Error("rate limited"), { error_kind: "rate_limited", retry_after_at: null });
    const refused = await call(bootGrant(f, { actor: "owner", waitAdapters: adapters({ baseline: 0 }, failure) }), "/api/waits/resume-grant", grantBody(f));
    expect(refused).toMatchObject({ status: 409, data: { code: "baseline_unbindable", error_kind: "rate_limited" } });
    const db = openControl(f.controlPath);
    try {
      expect(getTarget(db, "orchestrator", "ap-g")).toMatchObject({ effect: "resume_checkpoint", state: "closed" });
      expect(listConditionWaits(db)).toEqual([]);
    } finally { db.close(); }
  });
});
