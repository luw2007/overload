import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlPayloadHash } from "../../control/outbox";
import { createWork, getAttention, getConditionWait, observeConditionWait, openControl, upsertAttention } from "../../control/store";
import type {
  CheckBaseline, CheckNewResultCondition, ConditionWait, Contract, WaitErrorKind, WaitObservation, WaitSourceAdapter, WaitSourceAdapters,
} from "../../control/types";
import { openMailbox } from "../../decision-bot/mailbox";
import {
  getCheckResults, getNextResultSetVersion, insertCheckResults, insertSignalSample, type CheckResultInput,
} from "../../orchestrator/anomaly-store";
import { openStore } from "../../orchestrator/store";
import { createWait } from "../create";
import { CheckSourceError, createCheckResultAdapter } from "./check-result";

const T = 1_700_000_000_000;
const MIN = 60_000;
const contract: Contract = {
  objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [],
  scope: { allowed_effects: ["write"] }, budget: {}, stop_conditions: [], decision_owner: "owner",
};
type CheckWait = ConditionWait & { condition: CheckNewResultCondition; baseline: CheckBaseline };
type Source = CheckNewResultCondition["source"];
const dirs: string[] = [];
const opened: Database[] = [];
afterEach(() => {
  // close() is idempotent, so a test may close a DB early.
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** One sampling window exactly as `sampleTask` writes it: allocate the Work's next version, then sample + results in one transaction. */
function window(db: Database, workId: string, taskId: string, attemptId: string, at: number, items: CheckResultInput[]): number {
  const version = getNextResultSetVersion(db, workId);
  db.transaction(() => {
    insertSignalSample(db, taskId, attemptId, at, 1, 0, 0, version, workId);
    if (items.length) insertCheckResults(db, version, taskId, attemptId, at, items, workId);
  })();
  return version;
}
const ci = (status: string, fingerprint: string | null, def: string | null = "def-1", evidence = "ev"): CheckResultInput =>
  ({ check_id: "ci", status, fingerprint, check_def_version: def, evidence_ref: evidence });

/**
 * Real SQLite files throughout: the migrated orchestrator store stays open as the writer (the orchestrator
 * is running) while the adapter opens its own read-only connection by path; control and mailbox are separate DBs.
 */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "waits-check-"));
  dirs.push(dir);
  const orchestratorPath = join(dir, "orchestrator.db");
  const h = {
    dir, orchestratorPath,
    orch: openStore(orchestratorPath),
    control: openControl(join(dir, "control.db")),
    mailbox: openMailbox(join(dir, "mailbox.db")),
    adapter: createCheckResultAdapter({ orchestratorPath }),
    now: T + 1000,
  };
  opened.push(h.orch, h.control, h.mailbox);
  const workA = createWork(h.control, { title: "work A", source: "test", contract }, T);
  const workB = createWork(h.control, { title: "work B", source: "test", contract }, T);
  const itemA = upsertAttention(h.control, { item_id: "item-a", work_id: workA.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: "decide after the next ci result", trigger: "check", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
    source_link: null, approval_id: null, consumer_owner: null, contract_revision: workA.revision, decision_mode: "human_only", evidence: {} }, T + 1);
  const itemB = upsertAttention(h.control, { item_id: "item-b", work_id: workB.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: "decide after the next ci result", trigger: "check", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
    source_link: null, approval_id: null, consumer_owner: null, contract_revision: workB.revision, decision_mode: "human_only", evidence: {} }, T + 1);
  const tick = () => (h.now += 100);
  const source = (workId = workA.work_id): Source => ({
    orchestrator_db: "local", work_id: workId, task_id: "task-1", attempt_id: "att-1", check_id: "ci", check_def_version: "def-1",
  });
  const ctx = (at = tick(), signal = new AbortController().signal) => ({ now: at, signal });
  const unexpected = async () => { throw new Error("unexpected source adapter"); };

  async function create(src = source(), itemId = itemA.item_id, check = h.adapter): Promise<CheckWait> {
    const workId = itemId === itemA.item_id ? workA.work_id : workB.work_id;
    const adapters = {
      github_pr_merged: { kind: "github_pr_merged", establishBaseline: unexpected, observe: unexpected },
      check_new_result: check,
      work_completed: { kind: "work_completed", establishBaseline: unexpected, observe: unexpected },
    } as WaitSourceAdapters;
    const wait = await createWait(h.control, { work_id: workId, item_id: itemId, condition: { kind: "check_new_result", source: src }, deadline_at: T + 24 * 60 * MIN },
      { actor: "owner", adapters, mailbox: h.mailbox, now: tick, signal: new AbortController().signal });
    return wait as CheckWait;
  }
  const current = (waitId: string) => getConditionWait(h.control, waitId) as CheckWait;
  /** Runner step: read the row, observe outside any transaction, then one short CAS. */
  async function step(waitId: string, adapter: WaitSourceAdapter<CheckNewResultCondition, CheckBaseline> = h.adapter) {
    const before = current(waitId);
    const at = tick();
    const observation = await adapter.observe(before, ctx(at));
    const { wait, became_ready } = observeConditionWait(h.control, waitId, before.version, observation, { next_check_at: at + 5 * MIN }, at);
    return { observation, wait: wait as CheckWait, became_ready };
  }
  const events = (waitId: string) => (h.control.query("SELECT kind,entity_version FROM control_outbox WHERE entity_id=? ORDER BY entity_version,kind").all(waitId) as
    { kind: string; entity_version: number }[]).map((row) => `${row.entity_version}:${row.kind}`);
  const counts = () => h.control.query(`SELECT (SELECT COUNT(*) FROM control_works) AS works,(SELECT COUNT(*) FROM control_attention) AS items,
    (SELECT COUNT(*) FROM control_waits) AS waits`).get() as { works: number; items: number; waits: number };
  return { h, workA, workB, itemA, itemB, source, ctx, tick, create, current, step, events, counts };
}

function error(observation: WaitObservation): { kind: WaitErrorKind; detail: string } {
  if (observation.kind !== "error") throw new Error(`expected an error observation, got ${observation.kind}`);
  return { kind: observation.error_kind, detail: observation.detail };
}
async function baselineFailure(promise: Promise<unknown>): Promise<WaitErrorKind> {
  try { await promise; } catch (thrown) {
    expect(thrown).toBeInstanceOf(CheckSourceError);
    return (thrown as CheckSourceError).error_kind;
  }
  throw new Error("expected establishBaseline to fail");
}
function fileHash(path: string): string {
  const hash = createHash("sha256");
  for (const file of [path, `${path}-wal`]) if (existsSync(file)) hash.update(readFileSync(file));
  return hash.digest("hex");
}
/** Rows the orchestrator may later commit out of order: a direct write at an explicit version. */
function rawResult(db: Database, row: { version: number; work: string; task?: string; attempt?: string; check?: string; def?: string | null; status?: string; at?: number }): void {
  db.run(`INSERT INTO attempt_check_results(result_set_version,work_id,task_id,attempt_id,observed_at,check_id,status,fingerprint,check_def_version,evidence_ref)
    VALUES(?,?,?,?,?,?,?,?,?,?)`, [row.version, row.work, row.task ?? "task-1", row.attempt ?? "att-1", row.at ?? T, row.check ?? "ci", row.status ?? "fail", "fp", row.def === undefined ? "def-1" : row.def, "ev"]);
}
/** The running orchestrator writer holds its lock exclusively (as during recovery), so every reader gets SQLITE_BUSY. */
function holdExclusive(orch: Database): void {
  orch.exec("PRAGMA locking_mode=EXCLUSIVE");
  insertSignalSample(orch, "task-lock", "att-lock", T, 0, 0, 0, 1, "work-lock");
}
/** NORMAL mode releases the held lock at the writer's next access. */
function releaseExclusive(orch: Database): void {
  orch.exec("PRAGMA locking_mode=NORMAL");
  orch.query("SELECT COUNT(*) FROM tasks").get();
}

describe("check_new_result baseline", () => {
  test("records the Work's highest result_set_version across samples and results, and the exact tuple's last observed_at", async () => {
    const f = fixture();
    const work = f.workA.work_id;
    window(f.h.orch, work, "task-1", "att-1", T - 5000, [ci("fail", "fp-1")]);                                         // v1 exact
    window(f.h.orch, work, "task-1", "att-1", T - 4000, [ci("fail", "fp-1"), { check_id: "lint", status: "pass" }]); // v2 exact
    window(f.h.orch, work, "task-1", "att-1", T - 3000, [ci("pass", null, "def-2")]);                                // v3 other definition
    window(f.h.orch, work, "task-1", "att-1", T - 2000, []);                                                         // v4 sample only
    const wait = await f.create();
    expect(wait.baseline).toEqual({ attempt_id: "att-1", check_id: "ci", check_def_version: "def-1", result_set_version: 4, observed_at: T - 4000 });
    expect(wait).toMatchObject({ state: "watching", baseline_generation: 4, source_generation: 4, observed_generation: 1, ready_at: null });
    expect(wait.baseline_established_at).toBeLessThan(wait.created_at);
    const { observation, wait: after } = await f.step(wait.wait_id);
    expect(observation.kind).toBe("same");
    expect(after).toMatchObject({ state: "watching", unchanged_count: 1, source_generation: 4, observed_generation: 1 });
  });

  test("an empty Work baselines at 0 with no observed result; the first result for the exact check is ready", async () => {
    const f = fixture();
    const wait = await f.create();
    expect(wait.baseline).toEqual({ attempt_id: "att-1", check_id: "ci", check_def_version: "def-1", result_set_version: 0, observed_at: null });
    expect(wait.baseline_generation).toBe(0);
    const version = window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("fail", "fp-1")]);
    const { observation, wait: after, became_ready } = await f.step(wait.wait_id);
    expect(version).toBe(1);
    expect(became_ready).toBe(true);
    expect(observation).toMatchObject({ kind: "ready", source_generation: 1 });
    expect(after).toMatchObject({ state: "ready", source_generation: 1, disposition_state: "pending" });
  });

  test("source failures reject creation with the classified CheckSourceError and create nothing", async () => {
    const f = fixture();
    const missing = createCheckResultAdapter({ orchestratorPath: join(f.h.dir, "absent.db") });
    expect(await baselineFailure(f.create(f.source(), f.itemA.item_id, missing))).toBe("source_missing");
    holdExclusive(f.h.orch);
    expect(await baselineFailure(f.create())).toBe("transient");
    expect(f.counts().waits).toBe(0);
  });
});

describe("B01: repeated identical source state is quiet", () => {
  test("unrelated activity leaves the wait `same`; unchanged_count grows, generations/Attention/outbox stay quiet, and the source is never written", async () => {
    const f = fixture();
    const work = f.workA.work_id;
    window(f.h.orch, work, "task-1", "att-1", T - 1000, [ci("fail", "fp-1")]);
    const wait = await f.create();
    const attention = getAttention(f.h.control, f.itemA.item_id)!;
    const totals = f.counts();
    // Everything below is a newer version, but none is a new result for the exact work/task/attempt/check/definition.
    window(f.h.orch, work, "task-1", "att-1", T + 2000, [{ check_id: "lint", status: "fail", check_def_version: "def-1" }]); // other check
    window(f.h.orch, work, "task-1", "att-old", T + 2100, [ci("pass", null)]);                                          // other attempt
    window(f.h.orch, work, "task-2", "att-1", T + 2200, [ci("pass", null)]);                                            // other task
    window(f.h.orch, work, "task-1", "att-1", T + 2300, [ci("pass", null, "def-2")]);                                   // other definition
    window(f.h.orch, work, "task-1", "att-1", T + 2400, []);                                                            // sample only
    window(f.h.orch, f.workB.work_id, "task-1", "att-1", T + 2500, [ci("pass", null)]);                                 // same tuple, other Work
    const sourceHash = fileHash(f.h.orchestratorPath);
    const fingerprints = new Set<string>();
    for (let round = 1; round <= 3; round++) {
      // A fresh adapter per round models a maintenance restart: nothing is carried in memory.
      const { observation, wait: after } = await f.step(wait.wait_id, round === 2 ? createCheckResultAdapter({ orchestratorPath: f.h.orchestratorPath }) : f.h.adapter);
      expect(observation).toMatchObject({ kind: "same", source_generation: 1 });
      if (observation.kind === "same") fingerprints.add(observation.fingerprint);
      expect(after).toMatchObject({ state: "watching", unchanged_count: round, source_generation: 1, observed_generation: 1, version: round + 1, transient_failures: 0 });
      expect((after.observed as Record<string, unknown>).work_result_set_version).toBe(6);
    }
    expect([...fingerprints]).toEqual([wait.observed_fingerprint!]);
    expect(f.events(wait.wait_id)).toEqual(["1:wait.created", "2:wait.observed", "3:wait.observed", "4:wait.observed"]);
    expect(getAttention(f.h.control, f.itemA.item_id)).toEqual(attention);
    expect(f.counts()).toEqual(totals);
    expect(fileHash(f.h.orchestratorPath)).toBe(sourceHash);
  });
});

describe("B02: a new result is ready exactly once", () => {
  test("a new result set with the same status and fingerprint is still ready; generation and fingerprint bind the new version", async () => {
    const f = fixture();
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T - 1000, [ci("fail", "fp-1", "def-1", "ev-1")]);
    const wait = await f.create();
    const version = window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("fail", "fp-1", "def-1", "ev-1")]);
    const { observation, wait: after, became_ready } = await f.step(wait.wait_id);
    const facts = { work_id: f.workA.work_id, task_id: "task-1", attempt_id: "att-1", check_id: "ci", check_def_version: "def-1",
      result_set_version: version, status: "fail", result_fingerprint: "fp-1", evidence_ref: "ev-1" };
    expect(observation).toEqual({ kind: "ready", observed: { ...facts, result_observed_at: T + 2000 }, fingerprint: controlPayloadHash(facts), source_generation: 2, observed_at: after.last_observed_at! });
    expect(became_ready).toBe(true);
    expect(after).toMatchObject({ state: "ready", source_generation: 2, observed_generation: 2, ready_observation_fingerprint: controlPayloadHash(facts), disposition_state: "pending" });
  });

  test("the latest exact-definition result is the ready fact when several arrived between polls", async () => {
    const f = fixture();
    const wait = await f.create();
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("fail", "fp-1")]);
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2100, [ci("pass", null)]);
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2200, [ci("unknown", null, "def-2")]);
    const { observation } = await f.step(wait.wait_id);
    expect(observation).toMatchObject({ kind: "ready", source_generation: 2, observed: { status: "pass", result_set_version: 2 } });
  });

  test("replaying the same source event and racing two observers yield one watching→ready, one wait.ready, no new Work or item", async () => {
    const f = fixture();
    const wait = await f.create();
    const totals = f.counts();
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("fail", "fp-1")]);
    // Two observers read the same row version and the same new result concurrently.
    const [first, second] = await Promise.all([f.h.adapter.observe(wait, f.ctx()), createCheckResultAdapter({ orchestratorPath: f.h.orchestratorPath }).observe(wait, f.ctx())]);
    expect(first).toMatchObject({ kind: "ready", source_generation: 1 });
    expect(second).toMatchObject({ kind: "ready", source_generation: 1 });
    const won = observeConditionWait(f.h.control, wait.wait_id, wait.version, first, { next_check_at: f.h.now + 5 * MIN }, f.h.now);
    expect(won.became_ready).toBe(true);
    expect(() => observeConditionWait(f.h.control, wait.wait_id, wait.version, second, { next_check_at: f.h.now + 5 * MIN }, f.h.now)).toThrow(/stale wait version/);
    // Replay of the identical event after ready: the adapter still reports the fact, the store refuses to advance again.
    const replay = await f.h.adapter.observe(wait, f.ctx());
    expect(replay).toMatchObject({ kind: "ready", source_generation: 1 });
    expect(() => observeConditionWait(f.h.control, wait.wait_id, won.wait.version, replay, { next_check_at: f.h.now + 5 * MIN }, f.tick())).toThrow(/wait is ready/);
    expect(f.events(wait.wait_id)).toEqual(["1:wait.created", "2:wait.ready"]);
    expect(f.current(wait.wait_id)).toMatchObject({ state: "ready", version: 2, source_generation: 1 });
    expect(f.counts()).toEqual(totals);
    expect(getAttention(f.h.control, f.itemA.item_id)).toMatchObject({ state: "open", revision: 1 });
  });
});

describe("B03: facts at or before the baseline never trigger", () => {
  test("a wait created after the source already changed stays quiet on those results; only a strictly later version is ready", async () => {
    const f = fixture();
    const work = f.workA.work_id;
    window(f.h.orch, work, "task-1", "att-1", T - 3000, [ci("fail", "fp-1")]);
    window(f.h.orch, work, "task-1", "att-1", T - 2000, [ci("pass", null)]); // the "changed" result already exists
    const wait = await f.create();
    expect(wait.baseline).toMatchObject({ result_set_version: 2, observed_at: T - 2000 });
    expect((await f.step(wait.wait_id)).observation.kind).toBe("same");
    // The same "changed" fact observed again (a replayed event at the baseline generation) is still quiet.
    expect((await f.step(wait.wait_id)).observation).toMatchObject({ kind: "same", source_generation: 2 });
    const next = window(f.h.orch, work, "task-1", "att-1", T + 3000, [ci("pass", null)]);
    const { observation, became_ready } = await f.step(wait.wait_id);
    expect(became_ready).toBe(true);
    expect(observation).toMatchObject({ kind: "ready", source_generation: next });
  });

  test("an exact-tuple row committed late below the baseline is quiet; ready must also exceed the persisted source generation", async () => {
    const f = fixture();
    const work = f.workA.work_id;
    window(f.h.orch, work, "task-1", "att-1", T - 3000, [{ check_id: "lint", status: "pass" }]); // v1, no "ci"
    window(f.h.orch, work, "task-1", "att-1", T - 2000, []);                                      // v2
    const wait = await f.create();
    // A producer that allocated v1 earlier commits its exact "ci" result only now: an old event, never a trigger.
    rawResult(f.h.orch, { version: 1, work, status: "pass" });
    expect((await f.step(wait.wait_id)).observation).toMatchObject({ kind: "same", source_generation: 2 });
    window(f.h.orch, work, "task-1", "att-1", T + 3000, [ci("fail", "fp-3")]); // v3
    // A persisted high-water already at v3 (e.g. recorded by a newer observation) makes v3 old too.
    const raised = { ...f.current(wait.wait_id), source_generation: 3 };
    const quiet = await f.h.adapter.observe(raised, f.ctx());
    expect(quiet).toMatchObject({ kind: "changed_not_ready", source_generation: 3 });
    expect(await f.h.adapter.observe(f.current(wait.wait_id), f.ctx())).toMatchObject({ kind: "ready", source_generation: 3 });
  });

  test("a second wait created after the first became ready baselines past that result and is not triggered by it", async () => {
    const f = fixture();
    const first = await f.create();
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("fail", "fp-1")]);
    expect((await f.step(first.wait_id)).became_ready).toBe(true);
    const second = await f.create(f.source(f.workA.work_id), f.itemB.item_id);
    expect(second.baseline_generation).toBe(1);
    const replay = await f.step(second.wait_id);
    expect(replay.observation.kind).toBe("same");
    expect(replay.wait.state).toBe("watching");
  });
});

describe("cross-Work isolation", () => {
  test("another Work's identical tuple, higher versions and version collisions never baseline, trigger or conflict this Work", async () => {
    const f = fixture();
    const [a, b] = [f.workA.work_id, f.workB.work_id];
    window(f.h.orch, a, "task-1", "att-1", T - 1000, [ci("fail", "fp-a")]); // A v1
    for (let i = 0; i < 5; i++) window(f.h.orch, b, "task-1", "att-1", T - 900 + i, [ci("fail", "fp-b")]); // B v1..v5, same ids
    const waitA = await f.create(f.source(a), f.itemA.item_id);
    const waitB = await f.create(f.source(b), f.itemB.item_id);
    expect(waitA.baseline_generation).toBe(1);
    expect(waitB.baseline_generation).toBe(5);
    // B advances to v6 with the identical tuple; A sees nothing new.
    window(f.h.orch, b, "task-1", "att-1", T + 2000, [ci("pass", null)]);
    expect((await f.step(waitA.wait_id)).observation.kind).toBe("same");
    // A's next result is its own v2 — far below B's versions — and is ready at A's generation.
    const versionA = window(f.h.orch, a, "task-1", "att-1", T + 2100, [ci("pass", null)]);
    expect(versionA).toBe(2);
    expect(getCheckResults(f.h.orch, b, 2)[0]).toMatchObject({ work_id: b, status: "fail" }); // same (version, check) in B coexists
    const readyA = await f.step(waitA.wait_id);
    expect(readyA.observation).toMatchObject({ kind: "ready", source_generation: 2, observed: { work_id: a, status: "pass" } });
    const readyB = await f.step(waitB.wait_id);
    expect(readyB.observation).toMatchObject({ kind: "ready", source_generation: 6, observed: { work_id: b, status: "pass" } });
    expect(f.events(waitA.wait_id)).toEqual(["1:wait.created", "2:wait.observed", "3:wait.ready"]);
    expect(f.events(waitB.wait_id)).toEqual(["1:wait.created", "2:wait.ready"]);
  });
});

describe("definition change and unproven definitions", () => {
  test("a changed definition is never mapped onto the awaited one", async () => {
    const f = fixture();
    const wait = await f.create();
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("pass", null, "def-2")]);
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2100, [ci("fail", "fp", "def-2")]);
    const { observation, wait: after } = await f.step(wait.wait_id);
    expect(observation.kind).toBe("same");
    expect(after).toMatchObject({ state: "watching", source_generation: 0 });
  });

  test.each([null, "", "unknown"])("a new result with check_def_version %p is invalid_response → unavailable, keeping the last confirmed snapshot", async (def) => {
    const f = fixture();
    const wait = await f.create();
    const confirmed = (await f.step(wait.wait_id)).wait;
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("fail", "fp", def)]);
    const { observation, wait: after } = await f.step(wait.wait_id);
    expect(error(observation)).toEqual({ kind: "invalid_response", detail: expect.stringMatching(/no exact check definition/) });
    expect(after).toMatchObject({ state: "unavailable", state_reason: "invalid_response", last_error_kind: "invalid_response", disposition_state: "pending",
      observed_fingerprint: confirmed.observed_fingerprint, last_confirmed_at: confirmed.last_confirmed_at, source_generation: 0, ready_at: null });
    expect(f.events(wait.wait_id)).toEqual(["1:wait.created", "2:wait.observed", "3:wait.unavailable"]);
  });

  test("an exact-definition result is sufficient even beside an unproven one", async () => {
    const f = fixture();
    const wait = await f.create();
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2000, [ci("fail", "fp-1")]);
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T + 2100, [ci("fail", "fp-1", null)]);
    expect(await f.h.adapter.observe(wait, f.ctx())).toMatchObject({ kind: "ready", source_generation: 1 });
  });
});

describe("B04: unavailable, busy and unclassifiable sources", () => {
  // Checked-replacement DDL variants of the real schema: a no-op edit fails the fixture instead of passing silently.
  const schema = readFileSync(join(import.meta.dir, "../../orchestrator/schema.sql"), "utf8");
  const variant = (from: string, to: string) => {
    if (!schema.includes(from)) throw new Error(`fixture edit does not apply: ${from}`);
    return schema.replace(from, to);
  };
  test.each([
    { name: "legacy global (result_set_version, check_id) key", ddl: variant("PRIMARY KEY(work_id, result_set_version, check_id)", "PRIMARY KEY(result_set_version, check_id)") },
    { name: "nullable work_id", ddl: variant("work_id TEXT NOT NULL CHECK(work_id <> ''),", "work_id TEXT,") },
    { name: "work_id without the non-empty CHECK", ddl: variant("work_id TEXT NOT NULL CHECK(work_id <> ''),", "work_id TEXT NOT NULL,") },
  ])("an unmigrated store ($name) is configuration: never read compatibly, never migrated", async ({ ddl }) => {
    const f = fixture();
    const wait = await f.create();
    f.h.orch.close();
    const legacyPath = join(f.h.dir, "legacy.db");
    const legacy = new Database(legacyPath, { create: true });
    legacy.exec(ddl);
    legacy.close();
    const before = fileHash(legacyPath);
    const adapter = createCheckResultAdapter({ orchestratorPath: legacyPath });
    expect(await baselineFailure(adapter.establishBaseline(wait.condition, f.ctx()))).toBe("configuration");
    const { observation, wait: after } = await f.step(wait.wait_id, adapter);
    expect(error(observation).kind).toBe("configuration");
    expect(after).toMatchObject({ state: "unavailable", state_reason: "configuration" });
    expect(fileHash(legacyPath)).toBe(before);
  });

  test("missing file, non-file path and missing tables are source_missing → unavailable", async () => {
    const f = fixture();
    const wait = await f.create();
    mkdirSync(join(f.h.dir, "a-directory"));
    const empty = new Database(join(f.h.dir, "empty.db"), { create: true }); empty.exec("CREATE TABLE unrelated(x)"); empty.close();
    for (const path of ["absent.db", "a-directory", "empty.db"]) {
      const observation = await createCheckResultAdapter({ orchestratorPath: join(f.h.dir, path) }).observe(wait, f.ctx());
      expect(error(observation).kind).toBe("source_missing");
    }
    expect(existsSync(join(f.h.dir, "absent.db"))).toBe(false);
    const { wait: after } = await f.step(wait.wait_id, createCheckResultAdapter({ orchestratorPath: join(f.h.dir, "absent.db") }));
    expect(after).toMatchObject({ state: "unavailable", state_reason: "source_missing" });
  });

  test("an unreadable file is permission_denied → unavailable", async () => {
    const f = fixture();
    const wait = await f.create();
    chmodSync(f.h.orchestratorPath, 0o000);
    try {
      const { observation, wait: after } = await f.step(wait.wait_id);
      expect(error(observation).kind).toBe("permission_denied");
      expect(after).toMatchObject({ state: "unavailable", state_reason: "permission_denied" });
    } finally {
      chmodSync(f.h.orchestratorPath, 0o600);
    }
  });

  test("a corrupt file, malformed rows, conflicting writers and a regressed version are invalid_response", async () => {
    const f = fixture();
    const work = f.workA.work_id;
    const wait = await f.create();
    const garbage = join(f.h.dir, "garbage.db");
    writeFileSync(garbage, "not a sqlite database ".repeat(200));
    expect(error(await createCheckResultAdapter({ orchestratorPath: garbage }).observe(wait, f.ctx())).kind).toBe("invalid_response");

    const observe = async () => error(await f.h.adapter.observe(wait, f.ctx()));
    f.h.orch.run(`INSERT INTO attempt_check_results(result_set_version,work_id,task_id,attempt_id,observed_at,check_id,status,check_def_version)
      VALUES(1,?,'task-1','att-1','yesterday','ci','fail','def-1')`, [work]);
    expect(await observe()).toEqual({ kind: "invalid_response", detail: expect.stringMatching(/malformed/) });
    f.h.orch.run("DELETE FROM attempt_check_results WHERE work_id=?", [work]);

    // Version 1 written by two producers: the exact result plus another task's check at the same version.
    rawResult(f.h.orch, { version: 1, work });
    rawResult(f.h.orch, { version: 1, work, task: "task-2", attempt: "att-2", check: "lint" });
    expect(await observe()).toEqual({ kind: "invalid_response", detail: expect.stringMatching(/conflicting writers/) });
    f.h.orch.run("DELETE FROM attempt_check_results WHERE work_id=? AND check_id='lint'", [work]);
    insertSignalSample(f.h.orch, "task-2", "att-2", T, 1, 0, 0, 1, work); // a sample from another producer claims version 1
    expect(await observe()).toEqual({ kind: "invalid_response", detail: expect.stringMatching(/conflicting writers/) });
    f.h.orch.run("DELETE FROM attempt_signal_samples WHERE work_id=?", [work]);
    expect(await f.h.adapter.observe(wait, f.ctx())).toMatchObject({ kind: "ready", source_generation: 1 });

    // A persisted high-water above everything the Work now holds means the source was replaced or truncated.
    const regressed = { ...wait, source_generation: 9 };
    expect(error(await f.h.adapter.observe(regressed, f.ctx()))).toEqual({ kind: "invalid_response", detail: expect.stringMatching(/regressed/) });
  });

  test("SQLite busy is transient: persisted, retried with backoff, cleared by the next success, and bounded by the budget", async () => {
    const f = fixture();
    window(f.h.orch, f.workA.work_id, "task-1", "att-1", T - 1000, [ci("fail", "fp-1")]);
    const wait = await f.create();
    const confirmed = (await f.step(wait.wait_id)).wait;
    holdExclusive(f.h.orch);
    const failed = await f.step(wait.wait_id);
    expect(error(failed.observation).kind).toBe("transient");
    expect(failed.wait).toMatchObject({ state: "watching", transient_failures: 1, last_error_kind: "transient",
      observed_fingerprint: confirmed.observed_fingerprint, last_confirmed_at: confirmed.last_confirmed_at, unchanged_count: 1, source_generation: 1 });
    expect(failed.wait.next_check_at).toBe(failed.wait.retry_after_at);
    expect(failed.wait.retry_after_at!).toBeGreaterThan(failed.wait.updated_at);
    releaseExclusive(f.h.orch);
    const recovered = await f.step(wait.wait_id);
    expect(recovered.observation.kind).toBe("same");
    expect(recovered.wait).toMatchObject({ state: "watching", transient_failures: 0, last_error_kind: null, retry_after_at: null, unchanged_count: 2 });
    holdExclusive(f.h.orch);
    for (let i = 1; i <= 2; i++) expect((await f.step(wait.wait_id)).wait).toMatchObject({ state: "watching", transient_failures: i });
    const exhausted = await f.step(wait.wait_id);
    expect(exhausted.wait).toMatchObject({ state: "expired", state_reason: "transient_budget_exhausted", transient_failures: 3, ready_at: null,
      last_confirmed_at: recovered.wait.last_confirmed_at, observed_fingerprint: confirmed.observed_fingerprint });
    expect(f.events(wait.wait_id)).toEqual(["1:wait.created", "2:wait.observed", "3:wait.observation_failed", "4:wait.observed",
      "5:wait.observation_failed", "6:wait.observation_failed", "7:wait.expired"]);
  });

  test("unclassifiable access failures are unknown and count against the transient budget", async () => {
    const f = fixture();
    const wait = await f.create();
    const loop = join(f.h.dir, "loop.db");
    symlinkSync(join(f.h.dir, "loop-b.db"), loop);
    symlinkSync(loop, join(f.h.dir, "loop-b.db"));
    const { observation, wait: after } = await f.step(wait.wait_id, createCheckResultAdapter({ orchestratorPath: loop }));
    expect(error(observation)).toEqual({ kind: "unknown", detail: expect.stringMatching(/ELOOP/) });
    expect(after).toMatchObject({ state: "watching", transient_failures: 1, last_error_kind: "unknown", ready_at: null });
  });

  test("an aborted signal stops before reading and is never reported as a source result", async () => {
    const f = fixture();
    const wait = await f.create();
    const aborted = new AbortController(); aborted.abort();
    await expect(f.h.adapter.observe(wait, f.ctx(f.tick(), aborted.signal))).rejects.toThrow();
    await expect(f.h.adapter.establishBaseline(wait.condition, f.ctx(f.tick(), aborted.signal))).rejects.toThrow();
    expect(f.current(wait.wait_id)).toMatchObject({ version: 1, state: "watching" });
  });
});

