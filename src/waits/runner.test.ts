import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishControlEvents } from "../control/outbox";
import { applyControlEvent } from "../control/projection";
import {
  ControlError, completeWork, createConditionWait, createWork, createWorkDependency, getAttention, getConditionWait, getWork, observeConditionWait,
  openControl, upsertAttention,
} from "../control/store";
import type {
  ConditionWait, Contract, GithubPrMergedCondition, ObserveContext, PrBaseline, WaitErrorKind, WaitObservation, WaitSourceAdapters,
} from "../control/types";
import { initializeLedger } from "../ingest/ingest";
import { openMailbox } from "../decision-bot/mailbox";
import { createWait } from "./create";
import { createChildProcessRegistry, ObserveWaitsFailure, observeDueWaits } from "./runner";
import { createWorkCompleteAdapter } from "./sources/work-complete";

const T = 1_700_000_000_000;
const MIN = 60_000;
const contract: Contract = {
  objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [],
  scope: { allowed_effects: ["write"] }, budget: {}, stop_conditions: [], decision_owner: "owner",
};
const dirs: string[] = [];
const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Observe = (wait: ConditionWait, ctx: ObserveContext) => Promise<WaitObservation>;

function unused<K extends keyof WaitSourceAdapters>(kind: K): WaitSourceAdapters[K] {
  return { kind, async establishBaseline() { throw new Error(`unexpected ${kind} baseline`); }, async observe() { throw new Error(`unexpected ${kind} observe`); } } as unknown as WaitSourceAdapters[K];
}

/** Real control/mailbox SQLite files per test; the runner opens its own connections by path on every round (a restart). */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "waits-runner-")); dirs.push(dir);
  const paths = {
    controlPath: join(dir, "control.db"), mailboxPath: join(dir, "mailbox.db"),
    ledgerPath: join(dir, "missing-ledger.db"), orchestratorPath: join(dir, "missing-orchestrator.db"),
  };
  const control = openControl(paths.controlPath); opened.push(control);
  const work = createWork(control, { title: "w", source: "test", contract }, T);
  let now = T + 10 * MIN;
  const calls: Array<{ wait_id: string; version: number; now: number }> = [];
  let observe: Observe = async () => { throw new Error("no script"); };
  const pr: WaitSourceAdapters["github_pr_merged"] = {
    kind: "github_pr_merged",
    async establishBaseline() { throw new Error("runner must not re-baseline"); },
    async observe(wait, ctx) { calls.push({ wait_id: wait.wait_id, version: wait.version, now: ctx.now }); return observe(wait, ctx); },
  };
  const adapters: WaitSourceAdapters = { github_pr_merged: pr, check_new_result: unused("check_new_result"), work_completed: unused("work_completed") };

  /** A watching PR wait on its own Attention item; baseline sampled before creation at T+1000. */
  function wait(number: number, deadlineAt = T + 24 * 60 * MIN): ConditionWait {
    const item = upsertAttention(control, { item_id: `item-${number}`, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
      conclusion: "decide after merge", trigger: "pr", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
      source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {} }, T);
    const condition: GithubPrMergedCondition = { kind: "github_pr_merged", source: { provider: "github", host: "github.com", owner: "acme", repo: "app", number } };
    const baseline: PrBaseline = { ...condition.source, state: "OPEN", merged_at: null, updated_at: "2023-11-14T22:13:20Z", observed_at: T + 500 };
    return createConditionWait(control, { work_id: work.work_id, item_id: item.item_id, deadline_at: deadlineAt, condition },
      { actor: "owner", baseline: { baseline, baseline_generation: 10, fingerprint: "pr:OPEN", established_at: T + 500 }, now: T + 1000 });
  }
  const run = (options: Parameters<typeof observeDueWaits>[1] = {}, extra: Partial<Parameters<typeof observeDueWaits>[0]> = {}) =>
    observeDueWaits({ ...paths, adapters, now: () => now, ...extra }, options);
  const row = (waitId: string) => getConditionWait(control, waitId)!;
  const outbox = (waitId: string) => (control.query("SELECT kind, entity_version FROM control_outbox WHERE entity_id=? ORDER BY entity_version, kind")
    .all(waitId) as Array<{ kind: string; entity_version: number }>).map((event) => `${event.kind}@${event.entity_version}`);
  const project = () => {
    const details: Array<Record<string, unknown>> = [];
    publishControlEvents(control, join(dir, "no-ledger", "ledger.db"), (detail) => { details.push(detail); }, now);
    const ledger = new Database(":memory:"); opened.push(ledger); initializeLedger(ledger);
    details.reverse().forEach((detail, index) => applyControlEvent(ledger, detail, index + 1));
    return ledger;
  };
  return {
    dir, paths, control, work, adapters, calls, wait, run, row, outbox, project,
    set now(value: number) { now = value; }, get now() { return now; },
    script(next: Observe) { observe = next; },
  };
}

const same: Observe = async (wait, ctx) => ({ kind: "same", observed: { state: "OPEN" }, fingerprint: wait.observed_fingerprint!, source_generation: wait.source_generation, observed_at: ctx.now });
const merged: Observe = async (wait, ctx) => ({ kind: "ready", observed: { state: "MERGED" }, fingerprint: "pr:MERGED", source_generation: wait.source_generation + 1, observed_at: ctx.now });
const failing = (errorKind: WaitErrorKind, retryAfterAt?: number): Observe => async (_wait, ctx) =>
  ({ kind: "error", error_kind: errorKind, detail: `${errorKind} from source`, observed_at: ctx.now, ...(retryAfterAt === undefined ? {} : { retry_after_at: retryAfterAt }) });
const zero = { claimed: 0, observed: 0, ready: 0, unavailable: 0, expired: 0, conflicted: 0, timed_out: 0 };

describe("observeDueWaits", () => {
  test("B01: an unchanged source stays quiet across maintenance restarts; only the unchanged count moves", async () => {
    const f = fixture();
    const w = f.wait(7);
    f.script(same);
    const attentionEvents = () => (f.control.query("SELECT COUNT(*) AS n FROM control_outbox WHERE kind LIKE 'attention.%'").get() as { n: number }).n;
    const before = attentionEvents();
    expect(await f.run()).toMatchObject({ ...zero, claimed: 1, observed: 1 });
    expect(f.row(w.wait_id)).toMatchObject({ state: "watching", version: 2, unchanged_count: 1, source_generation: 10, observed_generation: w.observed_generation,
      observed_fingerprint: "pr:OPEN", last_confirmed_at: T + 10 * MIN, next_check_at: T + 15 * MIN, transient_failures: 0 });
    f.now = T + 12 * MIN;
    expect(await f.run()).toMatchObject(zero);
    f.now = T + 15 * MIN;
    expect(await f.run()).toMatchObject({ ...zero, claimed: 1, observed: 1 });
    expect(f.row(w.wait_id)).toMatchObject({ state: "watching", version: 3, unchanged_count: 2, observed_generation: w.observed_generation, next_check_at: T + 20 * MIN });
    expect(f.calls.map((call) => call.version)).toEqual([1, 2]);
    expect(f.outbox(w.wait_id)).toEqual(["wait.created@1", "wait.observed@2", "wait.observed@3"]);
    expect(attentionEvents()).toBe(before);
    expect(getAttention(f.control, `item-7`)!.revision).toBe(1);
    const projected = f.project().query("SELECT version, state FROM control_wait_projection WHERE wait_id=?").get(w.wait_id);
    expect(projected).toEqual({ version: 3, state: "watching" });
  });

  test("B02: two concurrent observers, replay and a stale version yield exactly one ready and one disposition", async () => {
    const f = fixture();
    const w = f.wait(7);
    const worksBefore = (f.control.query("SELECT COUNT(*) AS n FROM control_works").get() as { n: number }).n;
    let arrived = 0;
    const barrier = Promise.withResolvers<void>();
    f.script(async (wait, ctx) => { if (++arrived === 2) barrier.resolve(); await barrier.promise; return merged(wait, ctx); });
    const [a, b] = await Promise.all([f.run(), f.run()]);
    expect(f.calls).toHaveLength(2);
    expect(a.ready + b.ready).toBe(1);
    expect(a.conflicted + b.conflicted).toBe(1);
    const ready = f.row(w.wait_id);
    expect(ready).toMatchObject({ state: "ready", source_generation: 11, ready_observation_fingerprint: "pr:MERGED", disposition_state: "redecision_recorded", version: 3 });
    f.script(merged);
    f.now = T + 60 * MIN;
    expect(await f.run()).toMatchObject(zero);
    expect(f.calls).toHaveLength(2);
    expect(() => observeConditionWait(f.control, w.wait_id, 1, { kind: "ready", observed: { state: "MERGED" }, fingerprint: "pr:MERGED", source_generation: 11, observed_at: f.now },
      { next_check_at: null }, f.now)).toThrow(ControlError);
    expect(f.outbox(w.wait_id)).toEqual(["wait.created@1", "wait.ready@2", "wait.disposition_redecision@3"]);
    const item = getAttention(f.control, "item-7")!;
    expect(item).toMatchObject({ revision: 2, state: "open" });
    expect(item.evidence.wait_redecision).toMatchObject({ wait_id: w.wait_id, wait_state: "ready" });
    expect((f.control.query("SELECT COUNT(*) AS n FROM control_works").get() as { n: number }).n).toBe(worksBefore);
    const projected = f.project().query("SELECT version, state, disposition_state FROM control_wait_projection WHERE wait_id=?").get(w.wait_id);
    expect(projected).toEqual({ version: 3, state: "ready", disposition_state: "redecision_recorded" });
  });

  test("B04: permanent source errors settle unavailable, keep the last confirmed snapshot and return to a human", async () => {
    const f = fixture();
    const kinds: WaitErrorKind[] = ["permission_denied", "unsupported_provider", "configuration", "invalid_response", "identity_mismatch", "source_missing"];
    const waits = kinds.map((_, index) => f.wait(index + 1));
    f.script(async (wait, ctx) => failing(kinds[(wait.condition as GithubPrMergedCondition).source.number - 1]!)(wait, ctx));
    expect(await f.run({ concurrency: 4 })).toMatchObject({ ...zero, claimed: 6, unavailable: 6 });
    waits.forEach((w, index) => {
      expect(f.row(w.wait_id)).toMatchObject({ state: "unavailable", state_reason: kinds[index], last_error_kind: kinds[index], transient_failures: 0,
        observed_fingerprint: "pr:OPEN", last_confirmed_at: w.last_confirmed_at, next_check_at: null, disposition_state: "redecision_recorded" });
      expect(getAttention(f.control, `item-${index + 1}`)!.revision).toBe(2);
    });
  });

  test("B04: rate limits, unknown errors and adapter crashes stay watching with persisted, bounded retry", async () => {
    const f = fixture();
    const limited = f.wait(1);
    const unknown = f.wait(2);
    const crashed = f.wait(3);
    const hint = T + 17 * MIN;
    f.script(async (wait, ctx) => {
      const number = (wait.condition as GithubPrMergedCondition).source.number;
      if (number === 3) throw new Error("adapter bug");
      return failing(number === 1 ? "rate_limited" : "unknown", number === 1 ? hint : undefined)(wait, ctx);
    });
    expect(await f.run()).toMatchObject({ ...zero, claimed: 3, observed: 3 });
    expect(f.row(limited.wait_id)).toMatchObject({ state: "watching", transient_failures: 1, last_error_kind: "rate_limited", retry_after_at: hint, next_check_at: hint,
      observed_fingerprint: "pr:OPEN", last_confirmed_at: limited.last_confirmed_at, unchanged_count: 0 });
    for (const w of [unknown, crashed]) {
      const current = f.row(w.wait_id);
      expect(current).toMatchObject({ state: "watching", transient_failures: 1, last_error_kind: "unknown", last_confirmed_at: w.last_confirmed_at });
      expect(current.next_check_at).toBeGreaterThanOrEqual(f.now + 5 * MIN);
      expect(current.next_check_at).toBeLessThan(f.now + 5 * MIN + 30_000);
      expect(current.retry_after_at).toBe(current.next_check_at);
    }
    expect(f.row(crashed.wait_id).last_error_detail).toContain("adapter bug");
    expect(f.outbox(limited.wait_id)).toEqual(["wait.created@1", "wait.observation_failed@2"]);
    expect(getAttention(f.control, "item-1")!.revision).toBe(1);
  });

  test("B04: a busy control database during the CAS writes nothing and the next round commits", async () => {
    const f = fixture();
    const w = f.wait(7);
    const locker = new Database(f.paths.controlPath); opened.push(locker);
    f.script(async (wait, ctx) => { locker.exec("BEGIN IMMEDIATE"); return same(wait, ctx); });
    expect(await f.run()).toMatchObject({ ...zero, claimed: 1, conflicted: 1 });
    locker.exec("ROLLBACK");
    expect(f.row(w.wait_id)).toMatchObject({ version: 1, unchanged_count: 0, last_confirmed_at: w.last_confirmed_at, transient_failures: 0 });
    f.script(same);
    expect(await f.run()).toMatchObject({ ...zero, claimed: 1, observed: 1 });
    expect(f.row(w.wait_id)).toMatchObject({ version: 2, unchanged_count: 1 });
  });

  test("an adapter claim the store rejects fails closed as invalid_response instead of becoming same or ready", async () => {
    const f = fixture();
    const drifted = f.wait(1);
    const stale = f.wait(2);
    f.script(async (wait, ctx) => (wait.condition as GithubPrMergedCondition).source.number === 1
      ? { kind: "same", observed: { state: "OPEN" }, fingerprint: "pr:DRIFTED", source_generation: wait.source_generation, observed_at: ctx.now }
      : { kind: "ready", observed: { state: "MERGED" }, fingerprint: "pr:MERGED", source_generation: wait.baseline_generation, observed_at: ctx.now });
    expect(await f.run()).toMatchObject({ ...zero, claimed: 2, unavailable: 2 });
    for (const w of [drifted, stale]) {
      const current = f.row(w.wait_id);
      expect(current).toMatchObject({ state: "unavailable", state_reason: "invalid_response", ready_at: null, observed_fingerprint: "pr:OPEN", disposition_state: "redecision_recorded" });
      expect(current.last_error_detail).toStartWith("source observation rejected:");
    }
  });

  test("B05: a reached deadline expires without touching the source and reopens the original item", async () => {
    const f = fixture();
    const w = f.wait(7, T + 8 * MIN);
    f.script(same);
    f.now = T + 8 * MIN;
    expect(await f.run()).toMatchObject({ ...zero, claimed: 1, expired: 1 });
    expect(f.calls).toHaveLength(0);
    expect(f.row(w.wait_id)).toMatchObject({ state: "expired", state_reason: "deadline", next_check_at: null, disposition_state: "redecision_recorded" });
    expect(getAttention(f.control, "item-7")!.evidence.wait_redecision).toMatchObject({ wait_id: w.wait_id, wait_state: "expired", state_reason: "deadline" });
  });

  test("B05: the third consecutive transient failure expires the wait; restarts between rounds never reset the count", async () => {
    const f = fixture();
    const w = f.wait(7);
    f.script(failing("transient"));
    for (const expected of [1, 2]) {
      f.now = f.row(w.wait_id).next_check_at!;
      expect(await f.run()).toMatchObject({ ...zero, claimed: 1, observed: 1 });
      expect(f.row(w.wait_id)).toMatchObject({ state: "watching", transient_failures: expected });
    }
    f.now = f.row(w.wait_id).next_check_at!;
    expect(await f.run()).toMatchObject({ ...zero, claimed: 1, expired: 1 });
    expect(f.row(w.wait_id)).toMatchObject({ state: "expired", state_reason: "transient_budget_exhausted", transient_failures: 3, next_check_at: null,
      last_confirmed_at: w.last_confirmed_at, disposition_state: "redecision_recorded" });
    f.now = T + 23 * 60 * MIN;
    expect(await f.run()).toMatchObject(zero);
    expect(f.calls).toHaveLength(3);
  });

  test("B05: after the hard run deadline nothing more is claimed and late adapter results are never committed", async () => {
    const f = fixture();
    const waits = [f.wait(1), f.wait(2), f.wait(3)];
    let settled = 0;
    // Keeps running past the abort and then answers "ready": a late result that must never be committed.
    f.script(async (wait, ctx) => {
      const aborted = Promise.withResolvers<void>();
      ctx.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
      await aborted.promise;
      settled++;
      return merged(wait, ctx);
    });
    const result = await f.run({ runBudgetMs: 300 });
    expect(result).toMatchObject({ ...zero, claimed: 2, timed_out: 2 });
    expect(settled).toBe(2);
    expect(result.duration_ms).toBeLessThan(1000);
    for (const w of waits) {
      expect(f.row(w.wait_id)).toMatchObject({ state: "watching", version: 1, transient_failures: 0 });
      expect(f.outbox(w.wait_id)).toEqual(["wait.created@1"]);
    }
  });

  test("B05: a run-deadline abort TERMs, KILLs and reaps the adapter's child before returning, recording nothing", async () => {
    const f = fixture();
    const w = f.wait(7);
    const children = createChildProcessRegistry(100);
    const pidFile = join(f.dir, "child.pid");
    f.script(async (_wait, ctx) => {
      const out = await children.executor("/bin/sh", ["-c", `trap "" TERM; echo $$ >"${pidFile}"; while :; do sleep 0.05; done`], { signal: ctx.signal });
      return { kind: "error", error_kind: "transient", detail: out.stderr || "child failed", observed_at: ctx.now };
    });
    const result = await f.run({ runBudgetMs: 300 }, { children });
    expect(result).toMatchObject({ ...zero, claimed: 1, timed_out: 1 });
    expect(result.duration_ms).toBeLessThan(1000);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Bun.spawnSync(["/bin/kill", "-0", String(pid)], { stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);
    expect(f.row(w.wait_id)).toMatchObject({ version: 1, transient_failures: 0 });
  });

  test("an item deadline before the run deadline kills the child and records a transient failure", async () => {
    const f = fixture();
    const w = f.wait(7);
    const children = createChildProcessRegistry(100);
    const pidFile = join(f.dir, "child.pid");
    f.script(async (wait, ctx) => {
      await children.executor("/bin/sh", ["-c", `trap "" TERM; echo $$ >"${pidFile}"; while :; do sleep 0.05; done`], { signal: ctx.signal });
      return same(wait, ctx);
    });
    const result = await f.run({ itemTimeoutMs: 150 }, { children });
    expect(result).toMatchObject({ ...zero, claimed: 1, observed: 1, timed_out: 1 });
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(Bun.spawnSync(["/bin/kill", "-0", String(pid)], { stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);
    expect(f.row(w.wait_id)).toMatchObject({ state: "watching", version: 2, transient_failures: 1, last_error_kind: "transient", unchanged_count: 0 });
  });

  test("a disposition left pending by an interrupted round is completed before new observations", async () => {
    const f = fixture();
    const w = f.wait(7);
    observeConditionWait(f.control, w.wait_id, 1, { kind: "ready", observed: { state: "MERGED" }, fingerprint: "pr:MERGED", source_generation: 11, observed_at: T + 9 * MIN },
      { next_check_at: null }, T + 9 * MIN);
    expect(f.row(w.wait_id).disposition_state).toBe("pending");
    expect(await f.run()).toMatchObject(zero);
    expect(f.row(w.wait_id)).toMatchObject({ state: "ready", disposition_state: "redecision_recorded", version: 3 });
    expect(getAttention(f.control, "item-7")!.revision).toBe(2);
  });

  test("batch size and concurrency stay bounded", async () => {
    const f = fixture();
    for (let number = 1; number <= 6; number++) f.wait(number);
    let inFlight = 0;
    let peak = 0;
    f.script(async (wait, ctx) => { peak = Math.max(peak, ++inFlight); await Promise.resolve(); inFlight--; return same(wait, ctx); });
    expect(await f.run({ batchSize: 3 })).toMatchObject({ ...zero, claimed: 3, observed: 3 });
    expect(peak).toBe(2);
    peak = 0;
    expect(await f.run({ concurrency: 10 })).toMatchObject({ ...zero, claimed: 3, observed: 3 });
    expect(peak).toBe(3);
    f.now = T + 16 * MIN;
    peak = 0;
    expect(await f.run({ concurrency: 10 })).toMatchObject({ ...zero, claimed: 6, observed: 6 });
    expect(peak).toBe(4);
  });

  test("a missing adapter or unusable option is a runner-level failure", async () => {
    const f = fixture();
    const w = f.wait(7);
    const broken = { ...f.adapters, check_new_result: undefined } as unknown as WaitSourceAdapters;
    const failure = await f.run({}, { adapters: broken }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ObserveWaitsFailure);
    expect((failure as ObserveWaitsFailure).result).toMatchObject(zero);
    await expect(f.run({ batchSize: 0 })).rejects.toThrow(RangeError);
    expect(f.row(w.wait_id).version).toBe(1);
  });
});

describe("waits cli observe --once", () => {
  const cli = join(import.meta.dir, "cli.ts");

  test("rejects anything but exactly one bounded round", () => {
    const out = Bun.spawnSync([process.execPath, "run", cli, "observe"], { stdout: "pipe", stderr: "pipe" });
    expect(out.exitCode).toBe(2);
    expect(out.stderr.toString()).toContain("usage: bun run src/waits/cli.ts observe --once");
  });

  test("real round with the production adapters: gated off by default, then with OVERLOAD_CONDITION_WAITS=1 a completed prerequisite becomes ready once and a restart stays quiet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "waits-cli-")); dirs.push(dir);
    const controlPath = join(dir, "control.db");
    const control = openControl(controlPath); opened.push(control);
    const mailbox = openMailbox(join(dir, "mailbox.db")); opened.push(mailbox);
    const start = Date.now() - 60 * MIN;
    const waiting = createWork(control, { title: "successor", source: "test", contract }, start);
    const prerequisite = createWork(control, { title: "prerequisite", source: "test", contract }, start);
    const edge = createWorkDependency(control, { work_id: waiting.work_id, prerequisite_work_id: prerequisite.work_id, actor: "owner", now: start + 1 });
    upsertAttention(control, { item_id: "item-1", work_id: waiting.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
      conclusion: "continue after prerequisite", trigger: "dependency", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
      source_link: null, approval_id: null, consumer_owner: null, contract_revision: waiting.revision, decision_mode: "human_only", evidence: {} }, start + 2);
    let tick = start + 1000;
    const adapters: WaitSourceAdapters = { github_pr_merged: unused("github_pr_merged"), check_new_result: unused("check_new_result"), work_completed: createWorkCompleteAdapter({ controlPath }) };
    const w = await createWait(control, { work_id: waiting.work_id, item_id: "item-1", deadline_at: start + 24 * 60 * MIN,
      condition: { kind: "work_completed", source: { prerequisite_work_id: prerequisite.work_id, dependency_revision: edge.revision } } },
    { actor: "owner", adapters, mailbox, now: () => (tick += 100), signal: new AbortController().signal });
    completeWork(control, prerequisite.work_id, getWork(control, prerequisite.work_id)!.revision, { actor: "owner", evidence: { review: "accepted" }, now: start + 2 * MIN });
    const env = { ...process.env, HOME: dir, OVERLOAD_ANSWERS_PATH: controlPath, OVERLOAD_ORCHESTRATOR_PATH: join(dir, "orchestrator.db"), OVERLOAD_LEDGER_PATH: join(dir, "ledger.db") };
    const round = async (gate: string | undefined) => {
      const roundEnv: Record<string, string | undefined> = { ...env, OVERLOAD_CONDITION_WAITS: gate };
      if (gate === undefined) delete roundEnv.OVERLOAD_CONDITION_WAITS;
      const proc = Bun.spawn([process.execPath, "run", cli, "observe", "--once"], { env: roundEnv, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { lines: stdout.trim().split("\n"), stderr, exitCode };
    };
    // §14.1/§14.3: unset or any value but "1" is off — no observation, no DB file, the watching row is untouched.
    for (const gate of [undefined, "", "true", "0"]) {
      const off = await round(gate);
      expect(off).toMatchObject({ exitCode: 0, stderr: "" });
      expect(off.lines.map((line) => JSON.parse(line))).toEqual([{ status: "disabled", reason: "OVERLOAD_CONDITION_WAITS is not 1" }]);
      expect(getConditionWait(control, w.wait_id)).toMatchObject({ state: "watching", version: 1, unchanged_count: 0 });
    }
    expect(existsSync(join(dir, "orchestrator.db")) || existsSync(join(dir, "ledger.db"))).toBe(false);
    const first = await round("1");
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expect(first.lines).toHaveLength(1);
    expect(JSON.parse(first.lines[0]!)).toMatchObject({ ...zero, claimed: 1, ready: 1 });
    expect(getConditionWait(control, w.wait_id)).toMatchObject({ state: "ready", disposition_state: "redecision_recorded" });
    const second = await round("1");
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.lines[0]!)).toMatchObject(zero);
    const kinds = (control.query("SELECT kind FROM control_outbox WHERE entity_id=? ORDER BY entity_version").all(w.wait_id) as Array<{ kind: string }>).map((event) => event.kind);
    expect(kinds).toEqual(["wait.created", "wait.ready", "wait.disposition_redecision"]);
    expect(existsSync(join(dir, ".overload"))).toBe(false);
  });
});
