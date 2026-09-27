import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, controlEventId, controlPayloadHash, enqueueControlEvent } from "../../control/outbox";
import {
  ControlError, completeWork, createWork, createWorkDependency, getConditionWait, getWork, observeConditionWait, openControl, redirectWork,
  revokeWorkDependency, upsertAttention,
} from "../../control/store";
import type {
  ConditionWait, Contract, WaitErrorKind, WaitObservation, WaitSourceAdapter, WaitSourceAdapters, WorkBaseline, WorkCompletedCondition,
} from "../../control/types";
import { openMailbox } from "../../decision-bot/mailbox";
import { createWait } from "../create";
import { WorkSourceError, createWorkCompleteAdapter } from "./work-complete";

const T = 1_700_000_000_000;
const MIN = 60_000;
const contract: Contract = {
  objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [],
  scope: { allowed_effects: ["write"] }, budget: { retry_limit: 1 },
  stop_conditions: [{ id: "risk", kind: "hard", description: "unexpected destructive effect" }], decision_owner: "owner",
};
type WorkWait = ConditionWait & { condition: WorkCompletedCondition; baseline: WorkBaseline };
const dirs: string[] = [];
const opened: Database[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function unused<K extends keyof WaitSourceAdapters>(kind: K): WaitSourceAdapters[K] {
  return { kind, async establishBaseline() { throw new Error(`unexpected ${kind}`); }, async observe() { throw new Error(`unexpected ${kind}`); } } as unknown as WaitSourceAdapters[K];
}

/** Real WAL control DB (writer connection) + a separate mailbox; the adapter opens its own read-only connection by path. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "waits-work-")); dirs.push(dir);
  const controlPath = join(dir, "control.db");
  const control = openControl(controlPath); opened.push(control);
  const mailbox = openMailbox(join(dir, "mailbox.db")); opened.push(mailbox);
  const waiting = createWork(control, { title: "successor", source: "test", contract }, T);
  const prerequisite = createWork(control, { title: "prerequisite", source: "test", contract }, T);
  const edge = createWorkDependency(control, { work_id: waiting.work_id, prerequisite_work_id: prerequisite.work_id, actor: "owner", now: T + 1 });
  const item = upsertAttention(control, { item_id: "item-1", work_id: waiting.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: "continue after prerequisite", trigger: "dependency", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
    source_link: null, approval_id: null, consumer_owner: null, contract_revision: waiting.revision, decision_mode: "human_only", evidence: {} }, T + 2);
  const adapter = createWorkCompleteAdapter({ controlPath });
  let now = T + 1000;
  const tick = () => (now += 100);
  const ctx = (at = tick()) => ({ now: at, signal: new AbortController().signal });
  const condition: WorkCompletedCondition = { kind: "work_completed", source: { prerequisite_work_id: prerequisite.work_id, dependency_revision: edge.revision } };

  async function create(): Promise<WorkWait> {
    const adapters: WaitSourceAdapters = { github_pr_merged: unused("github_pr_merged"), check_new_result: unused("check_new_result"), work_completed: adapter };
    const wait = await createWait(control, { work_id: waiting.work_id, item_id: item.item_id, condition, deadline_at: T + 24 * 60 * MIN },
      { actor: "owner", adapters, mailbox, now: tick, signal: new AbortController().signal });
    return wait as WorkWait;
  }
  const current = (waitId: string) => getConditionWait(control, waitId) as WorkWait;
  /** One runner step: read-only adapter observation, then the store CAS the runner owns. */
  async function step(wait: WorkWait, using: WaitSourceAdapter<WorkCompletedCondition, WorkBaseline> = adapter) {
    const at = tick();
    const observation = await using.observe(wait, ctx(at));
    const next = observation.kind === "error" ? null : at + 5 * MIN;
    return { observation, ...observeConditionWait(control, wait.wait_id, wait.version, observation, { next_check_at: next }, at) };
  }
  const outbox = (kind: string, entityId: string) => control.query("SELECT * FROM control_outbox WHERE kind=? AND entity_id=? ORDER BY entity_version")
    .all(kind, entityId) as Record<string, unknown>[];
  const complete = (at = tick()) => completeWork(control, prerequisite.work_id, getWork(control, prerequisite.work_id)!.revision, { actor: "owner", evidence: { review: "accepted" }, now: at });
  const redirect = (action: "activate" | "pause" | "stop", at = tick()) =>
    redirectWork(control, prerequisite.work_id, getWork(control, prerequisite.work_id)!.revision, { reason: action, affected_work_ids: [], action }, at);
  return { dir, controlPath, control, waiting, prerequisite, edge, item, adapter, condition, ctx, tick, create, current, step, outbox, complete, redirect };
}

function expectError(observation: WaitObservation, kind: WaitErrorKind, detail: RegExp): void {
  expect(observation.kind).toBe("error");
  if (observation.kind !== "error") return;
  expect(observation.error_kind).toBe(kind);
  expect(observation.detail).toMatch(detail);
}

async function rejectsSource(promise: Promise<unknown>, kind: WaitErrorKind, message: RegExp): Promise<void> {
  const error = await promise.then(() => null, (reason: unknown) => reason);
  expect(error).toBeInstanceOf(WorkSourceError);
  expect((error as WorkSourceError).error_kind).toBe(kind);
  expect((error as WorkSourceError).message).toMatch(message);
}

describe("work_completed baseline", () => {
  test("records the real sample time and prerequisite revision; createWait keeps it before INSERT (B03)", async () => {
    const f = fixture();
    const snapshot = await f.adapter.establishBaseline(f.condition, f.ctx(T + 900));
    expect(snapshot).toEqual({
      baseline: { prerequisite_work_id: f.prerequisite.work_id, dependency_revision: 1, work_revision: 1, state: "active", observed_at: T + 900 },
      baseline_generation: 1, fingerprint: controlPayloadHash({ prerequisite_work_id: f.prerequisite.work_id, dependency_revision: 1, work_revision: 1, state: "active" }),
      established_at: T + 900,
    });
    const wait = await f.create();
    expect(wait.baseline_established_at).toBeLessThan(wait.created_at);
    expect(wait.baseline).toMatchObject({ work_revision: 1, state: "active", observed_at: wait.baseline_established_at });
    expect(wait.source_generation).toBe(1);
  });

  test("missing prerequisite, missing DB or foreign schema rejects creation; the adapter never migrates", async () => {
    const f = fixture();
    await rejectsSource(f.adapter.establishBaseline({ kind: "work_completed", source: { prerequisite_work_id: "ghost", dependency_revision: 1 } }, f.ctx()), "source_missing", /prerequisite work not found/);
    await rejectsSource(createWorkCompleteAdapter({ controlPath: join(f.dir, "absent.db") }).establishBaseline(f.condition, f.ctx()), "source_missing", /cannot be opened/);
    const emptyPath = join(f.dir, "empty.db");
    new Database(emptyPath, { create: true }).close();
    await rejectsSource(createWorkCompleteAdapter({ controlPath: emptyPath }).establishBaseline(f.condition, f.ctx()), "configuration", /schema version missing/);
    const empty = new Database(emptyPath, { readonly: true });
    expect(empty.query("SELECT COUNT(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
    empty.close();
  });

  test("an aborted signal rejects before any read", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort(new Error("run deadline"));
    await expect(f.adapter.establishBaseline(f.condition, { now: T + 900, signal: controller.signal })).rejects.toThrow("run deadline");
    const wait = await f.create();
    await expect(f.adapter.observe(wait, { now: f.tick(), signal: controller.signal })).rejects.toThrow("run deadline");
  });
});

describe("work_completed observation", () => {
  test("B01: an unchanged prerequisite is `same` across observations and a fresh adapter/connection; no ready", async () => {
    const f = fixture();
    let wait = await f.create();
    const first = await f.step(wait);
    expect(first.observation).toMatchObject({ kind: "same", source_generation: 1, fingerprint: wait.observed_fingerprint });
    expect(first.wait).toMatchObject({ state: "watching", unchanged_count: 1, source_generation: 1, observed_generation: 1 });
    wait = f.current(wait.wait_id);
    // maintenance restart: a new adapter instance opens a new read-only connection
    const restarted = await f.step(wait, createWorkCompleteAdapter({ controlPath: f.controlPath }));
    expect(restarted.wait).toMatchObject({ state: "watching", unchanged_count: 2, source_generation: 1, observed_generation: 1 });
    expect(f.outbox("wait.ready", wait.wait_id)).toHaveLength(0);
    expect(f.outbox("wait.observed", wait.wait_id)).toHaveLength(2);
  });

  test("stopped or paused prerequisites are changed-not-ready, never completion", async () => {
    const f = fixture();
    let wait = await f.create();
    f.redirect("stop");
    const stopped = await f.step(wait);
    expect(stopped.observation).toMatchObject({ kind: "changed_not_ready", source_generation: 2, observed: { state: "stopped", work_revision: 2 } });
    expect(stopped.wait).toMatchObject({ state: "watching", unchanged_count: 0, source_generation: 2, observed_generation: 2 });
    wait = f.current(wait.wait_id);
    expect((await f.step(wait)).wait).toMatchObject({ state: "watching", unchanged_count: 1, source_generation: 2 });
  });

  test("B02: authoritative completion is ready once; replayed event, repeated and concurrent observations add nothing", async () => {
    const f = fixture();
    const wait = await f.create();
    const completed = f.complete();
    const [event] = f.outbox("work.completed", f.prerequisite.work_id);
    const ready = await f.step(wait);
    const facts = { prerequisite_work_id: f.prerequisite.work_id, dependency_revision: 1, work_revision: completed.revision, state: "completed", completion_event_id: event!.event_id };
    expect(ready.observation).toMatchObject({ kind: "ready", source_generation: 2, fingerprint: controlPayloadHash(facts), observed: facts });
    expect(ready).toMatchObject({ became_ready: true, wait: { state: "ready", source_generation: 2, ready_observation_fingerprint: controlPayloadHash(facts) } });

    // the owner replays the same completion event: the outbox identity dedups it, so the observation is identical
    enqueueControlEvent(f.control, { entity_id: f.prerequisite.work_id, entity_version: 2, kind: "work.completed", work_id: f.prerequisite.work_id,
      payload: JSON.parse(event!.payload as string) }, T + 9000);
    expect(f.outbox("work.completed", f.prerequisite.work_id)).toHaveLength(1);
    // two observers holding the pre-ready snapshot: both read ready, the CAS admits neither
    const [late1, late2] = await Promise.all([f.adapter.observe(wait, f.ctx()), f.adapter.observe(wait, f.ctx())]);
    expect(late1).toMatchObject({ kind: "ready", fingerprint: ready.observation.kind === "ready" ? ready.observation.fingerprint : "" });
    expect(late2.kind).toBe("ready");
    for (const late of [late1, late2]) {
      expect(() => observeConditionWait(f.control, wait.wait_id, wait.version, late, { next_check_at: null }, f.tick())).toThrow(ControlError);
    }
    const settled = f.current(wait.wait_id);
    expect(() => observeConditionWait(f.control, wait.wait_id, settled.version, late1, { next_check_at: null }, f.tick())).toThrow(/wait is ready/);
    expect(f.outbox("wait.ready", wait.wait_id)).toHaveLength(1);
    expect(f.current(wait.wait_id)).toEqual(settled);
  });

  test("B03: a prerequisite completed before the wait stays quiet; only a strictly newer completion with its own event is ready", async () => {
    const f = fixture();
    f.complete();
    const [early] = f.outbox("work.completed", f.prerequisite.work_id);
    let wait = await f.create();
    expect(wait.baseline).toMatchObject({ state: "completed", work_revision: 2 });
    const quiet = await f.step(wait);
    expect(quiet.observation).toMatchObject({ kind: "same", source_generation: 2 });
    expect(quiet.wait).toMatchObject({ state: "watching", unchanged_count: 1 });

    wait = f.current(wait.wait_id);
    f.redirect("activate");
    const reopened = await f.step(wait);
    // the old revision-2 completion event is still in the outbox; the current state decides
    expect(reopened.observation).toMatchObject({ kind: "changed_not_ready", source_generation: 3, observed: { state: "active" } });

    wait = f.current(wait.wait_id);
    f.complete();
    const events = f.outbox("work.completed", f.prerequisite.work_id);
    expect(events.map((row) => row.entity_version)).toEqual([2, 4]);
    const ready = await f.step(wait);
    expect(ready).toMatchObject({ became_ready: true, observation: { kind: "ready", source_generation: 4, observed: { completion_event_id: events[1]!.event_id } } });
    expect(events[1]!.event_id).not.toBe(early!.event_id);
  });
});

describe("work_completed unavailability", () => {
  test("revoked, re-created or missing edges are configuration; the wait settles unavailable, never ready", async () => {
    const f = fixture();
    const wait = await f.create();
    f.complete();
    revokeWorkDependency(f.control, f.waiting.work_id, f.prerequisite.work_id, 1, { actor: "owner", reason: "dropped", now: f.tick() });
    const revoked = await f.step(wait);
    expectError(revoked.observation, "configuration", /revoked/);
    expect(revoked.wait).toMatchObject({ state: "unavailable", state_reason: "configuration", disposition_state: "pending" });

    createWorkDependency(f.control, { work_id: f.waiting.work_id, prerequisite_work_id: f.prerequisite.work_id, actor: "owner", now: f.tick() });
    expectError(await f.adapter.observe(wait, f.ctx()), "configuration", /revision 3 is not the waited revision 1/);

    f.control.query("DELETE FROM control_work_dependencies WHERE work_id=?").run(f.waiting.work_id);
    expectError(await f.adapter.observe(wait, f.ctx()), "configuration", /edge no longer exists/);
    expect(f.outbox("wait.ready", wait.wait_id)).toHaveLength(0);
  });

  test("missing waiting/prerequisite Work, missing DB and foreign schema are permanent errors", async () => {
    const f = fixture();
    const wait = await f.create();
    expectError(await createWorkCompleteAdapter({ controlPath: join(f.dir, "absent.db") }).observe(wait, f.ctx()), "source_missing", /cannot be opened/);
    const emptyPath = join(f.dir, "empty.db");
    new Database(emptyPath, { create: true }).close();
    expectError(await createWorkCompleteAdapter({ controlPath: emptyPath }).observe(wait, f.ctx()), "configuration", /schema version missing/);
    f.control.exec("PRAGMA foreign_keys=OFF");
    f.control.query("DELETE FROM control_works WHERE work_id=?").run(f.prerequisite.work_id);
    expectError(await f.adapter.observe(wait, f.ctx()), "source_missing", /prerequisite work no longer exists/);
    f.control.query("DELETE FROM control_works WHERE work_id=?").run(f.waiting.work_id);
    expectError(await f.adapter.observe(wait, f.ctx()), "configuration", /waiting work no longer exists/);
  });

  test("a busy control database is transient", async () => {
    const f = fixture();
    const wait = await f.create();
    // a rollback-journal writer holding EXCLUSIVE blocks readers (WAL readers are never blocked)
    f.control.close();
    const locker = new Database(f.controlPath); opened.push(locker);
    locker.exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE");
    expectError(await f.adapter.observe(wait, f.ctx()), "transient", /busy/);
    locker.exec("ROLLBACK");
    expect((await f.adapter.observe(wait, f.ctx())).kind).toBe("same");
  });
});

describe("work_completed completion event verification (invalid_response, never ready)", () => {
  /** Mutates the recorded completion event in place, as corruption or a forged producer would. */
  type Tamper = (t: { control: Database; waiting: string; prerequisite: string }, row: Record<string, unknown>) => void;
  const rewrite = (control: Database, row: Record<string, unknown>, mutate: (payload: { work: Record<string, unknown> }) => void) => {
    const payload = JSON.parse(row.payload as string) as { work: Record<string, unknown> };
    mutate(payload);
    // hash and canonical text stay consistent: only the payload/identity checks can reject it
    control.query("UPDATE control_outbox SET payload=?,payload_hash=? WHERE event_id=?").run(canonicalJson(payload), controlPayloadHash(payload), row.event_id as string);
  };
  const cases: Array<[string, Tamper, RegExp]> = [
    ["tampered payload text", (t, row) => t.control.query("UPDATE control_outbox SET payload=replace(payload,'accepted','forged') WHERE event_id=?").run(row.event_id as string), /payload hash mismatch/],
    ["malformed payload JSON", (t, row) => t.control.query("UPDATE control_outbox SET payload='{' WHERE event_id=?").run(row.event_id as string), /malformed JSON/],
    ["non-canonical payload", (t, row) => t.control.query("UPDATE control_outbox SET payload=? WHERE event_id=?").run(` ${row.payload as string}`, row.event_id as string), /not canonical/],
    ["payload revision", (t, row) => rewrite(t.control, row, (payload) => { payload.work.revision = 3; }), /payload does not match/],
    ["payload state", (t, row) => rewrite(t.control, row, (payload) => { payload.work.state = "active"; }), /payload does not match/],
    ["payload work id", (t, row) => rewrite(t.control, row, (payload) => { payload.work.work_id = t.waiting; }), /payload does not match/],
    ["payload without work", (t, row) => rewrite(t.control, row, (payload) => { delete (payload as Partial<typeof payload>).work; }), /no work snapshot/],
    ["foreign producer", (t, row) => t.control.query("UPDATE control_outbox SET producer_id='foreign',event_id=? WHERE event_id=?")
      .run(controlEventId("foreign", t.prerequisite, 2, "work.completed"), row.event_id as string), /producer does not match/],
    ["event id not its identity", (t, row) => t.control.query("UPDATE control_outbox SET event_id=? WHERE event_id=?")
      .run(controlEventId(row.producer_id as string, t.prerequisite, 1, "work.completed"), row.event_id as string), /event_id does not match/],
    ["item-scoped envelope", (t, row) => t.control.query("UPDATE control_outbox SET item_id='item-1' WHERE event_id=?").run(row.event_id as string), /envelope/],
    ["envelope work id", (t, row) => t.control.query("UPDATE control_outbox SET work_id=? WHERE event_id=?").run(t.waiting, row.event_id as string), /envelope/],
    ["second producer's event", (t, row) => t.control.query(`INSERT INTO control_outbox(event_id,producer_id,entity_id,entity_version,kind,work_id,item_id,payload,payload_hash,created_at)
      VALUES (?,?,?,?,?,?,NULL,?,?,?)`).run(controlEventId("foreign", t.prerequisite, 2, "work.completed"), "foreign", t.prerequisite, 2, "work.completed",
      t.prerequisite, row.payload as string, row.payload_hash as string, T), /more than one/],
    ["event missing (direct SQL completion)", (t, row) => t.control.query("DELETE FROM control_outbox WHERE event_id=?").run(row.event_id as string), /without an authoritative work.completed event/],
  ];
  for (const [name, tamper, detail] of cases) {
    test(name, async () => {
      const f = fixture();
      const wait = await f.create();
      f.complete();
      tamper({ control: f.control, waiting: f.waiting.work_id, prerequisite: f.prerequisite.work_id }, f.outbox("work.completed", f.prerequisite.work_id)[0]!);
      const result = await f.step(wait);
      expectError(result.observation, "invalid_response", detail);
      expect(result).toMatchObject({ became_ready: false, wait: { state: "unavailable", state_reason: "invalid_response", ready_at: null } });
      expect(f.outbox("wait.ready", wait.wait_id)).toHaveLength(0);
    });
  }

  test("completed at a revision whose authoritative event is older (pause after completion) is invalid, not ready", async () => {
    const f = fixture();
    const wait = await f.create();
    f.complete();
    expect(f.redirect("pause")).toMatchObject({ state: "completed", revision: 3 });
    expectError(await f.adapter.observe(wait, f.ctx()), "invalid_response", /revision 3: completed without an authoritative/);
  });

  test("direct-SQL completion without an event and a regressed revision are invalid", async () => {
    const f = fixture();
    let wait = await f.create();
    f.control.query("UPDATE control_works SET state='completed',revision=2 WHERE work_id=?").run(f.prerequisite.work_id);
    expectError(await f.adapter.observe(wait, f.ctx()), "invalid_response", /without an authoritative/);
    f.control.query("UPDATE control_works SET state='active',revision=4 WHERE work_id=?").run(f.prerequisite.work_id);
    await f.step(wait);
    wait = f.current(wait.wait_id);
    expect(wait.source_generation).toBe(4);
    f.control.query("UPDATE control_works SET revision=3 WHERE work_id=?").run(f.prerequisite.work_id);
    expectError(await f.adapter.observe(wait, f.ctx()), "invalid_response", /regressed below 4/);
  });

  test("the adapter does not write: outbox, waits, works and attention material are unchanged by observation", async () => {
    const f = fixture();
    const wait = await f.create();
    f.complete();
    // an open attention item without material is what a store getter's ensureControlSchema would backfill
    f.control.query("DELETE FROM control_attention_material").run();
    const snapshot = () => ["control_outbox", "control_waits", "control_works", "control_work_dependencies", "control_attention_material"]
      .map((table) => f.control.query(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = snapshot();
    await f.adapter.establishBaseline(f.condition, f.ctx());
    expect((await f.adapter.observe(wait, f.ctx())).kind).toBe("ready");
    expect(snapshot()).toEqual(before);
  });
});
