import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_SCHEMA_VERSION, ControlError, cancelConditionWait, claimWaitDispatch, completeWork, createConditionWait,
  createWork, createWorkDependency, ensureControlSchema, expireConditionWait, getActiveDependencyEdge, getAttention,
  getConditionWait, getWork, listConditionWaits, listDueConditionWaits, listPendingWaitDispositions, observeConditionWait, promoteWork,
  recordWaitDispatch, recordWaitEffect, recordWaitRedecision, reviseContract, revokeWorkDependency, upsertAttention,
} from "./store";
import { ControlEventVerificationError, canonicalJson, controlPayloadHash, publishControlEvents, verifyControlOutboxEvent } from "./outbox";
import { applyControlEvent } from "./projection";
import { initializeLedger } from "../ingest/ingest";
import type { ConditionWait, Contract, CreateWaitInput, WaitBaselineSnapshot, WaitObservation } from "./types";

const T = 1_700_000_000_000;
const MIN = 60_000;
const contract: Contract = {
  objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [],
  scope: { allowed_effects: ["write"] }, budget: { retry_limit: 1 },
  stop_conditions: [{ id: "risk", kind: "hard", description: "unexpected destructive effect" }], decision_owner: "owner",
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function memory(): Database { const db = new Database(":memory:"); db.exec("PRAGMA foreign_keys=ON"); ensureControlSchema(db); return db; }
function tempPath(): string { const dir = mkdtempSync(join(tmpdir(), "control-waits-")); dirs.push(dir); return join(dir, "control.db"); }
function open(path: string): Database { const db = new Database(path, { create: true }); db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON"); ensureControlSchema(db); return db; }

function workWithItem(db: Database, itemId = "item-1", overrides: Partial<Contract> = {}) {
  const work = createWork(db, { title: "w", source: "test", contract: { ...contract, ...overrides } }, T);
  const item = upsertAttention(db, { item_id: itemId, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: "decide after merge", trigger: "pr", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
    source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {} }, T);
  return { work, item };
}
function prInput(workId: string, itemId: string, extra: Partial<CreateWaitInput> = {}): CreateWaitInput {
  return { work_id: workId, item_id: itemId, deadline_at: T + 24 * 60 * MIN,
    condition: { kind: "github_pr_merged", source: { provider: "github", host: "github.com", owner: "acme", repo: "app", number: 7 } }, ...extra };
}
function prBaseline(establishedAt = T + 500, state: "OPEN" | "MERGED" = "OPEN"): WaitBaselineSnapshot {
  return { baseline: { provider: "github", host: "github.com", owner: "acme", repo: "app", number: 7, state,
    merged_at: state === "MERGED" ? "2023-11-14T22:00:00Z" : null, updated_at: "2023-11-14T22:13:20Z", observed_at: establishedAt },
  baseline_generation: establishedAt, fingerprint: `fp-${state}`, established_at: establishedAt };
}
function created(db: Database, itemId = "item-1") {
  const { work, item } = workWithItem(db, itemId);
  const wait = createConditionWait(db, prInput(work.work_id, item.item_id), { actor: "owner", baseline: prBaseline(), now: T + 1000 });
  return { work, item, wait };
}
function outbox(db: Database, entityId: string) {
  return db.query("SELECT * FROM control_outbox WHERE entity_id=? ORDER BY entity_version, kind").all(entityId) as Array<Record<string, unknown>>;
}
function kinds(db: Database, entityId: string): string[] { return outbox(db, entityId).map((row) => `${row.kind}@${row.entity_version}`); }
function obs(kind: "same" | "changed_not_ready" | "ready", fingerprint: string, generation: number, at: number): WaitObservation {
  return { kind, observed: { fingerprint, generation }, fingerprint, source_generation: generation, observed_at: at };
}
function expectControl(fn: () => unknown, code: ControlError["code"], message?: string | RegExp): ControlError {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe(code);
    if (message !== undefined) expect((error as ControlError).message).toMatch(message);
    return error as ControlError;
  }
  throw new Error("expected ControlError");
}
function readyWait(db: Database) {
  const setup = created(db);
  const ready = observeConditionWait(db, setup.wait.wait_id, 1, obs("ready", "merged", T + 5000, T + 6000), { next_check_at: null }, T + 6000);
  return { ...setup, wait: ready.wait };
}
/** Store state-machine fixture only: authorized_resume creation fails closed in production until a frozen mailbox scope exists. */
function authorizedReady(db: Database) {
  const setup = created(db);
  const grant = { consumer_owner: "orchestrator", approval_id: "ap", target_version: "tv", approved_effect: "resume_checkpoint", work_revision: 1,
    attention_revision: 1, attempt_id: "att", checkpoint_reference: "cp", execution_owner: "runner", expires_at: T + 99 * MIN };
  db.query("UPDATE control_waits SET disposition='authorized_resume', authorization_json=? WHERE wait_id=?").run(canonicalJson(grant), setup.wait.wait_id);
  const ready = observeConditionWait(db, setup.wait.wait_id, 1, obs("ready", "merged", T + 5000, T + 6000), { next_check_at: null }, T + 6000);
  return { ...setup, wait: ready.wait };
}

describe("control schema v7 migration", () => {
  test("fresh database is v7 with the frozen wait and dependency DDL", () => {
    const db = memory();
    expect(CONTROL_SCHEMA_VERSION).toBe(8);
    expect(db.query("SELECT version FROM control_schema_meta WHERE id=1").get()).toEqual({ version: 8 });
    const names = (db.query("SELECT name FROM sqlite_master WHERE name LIKE 'control_wait%' OR name LIKE 'control_work_dependencies%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(["control_waits", "control_waits_due", "control_waits_exact_unsettled", "control_waits_item", "control_waits_work",
      "control_work_dependencies", "control_work_dependencies_prerequisite"]);
    db.close();
  });

  test("v6 database with existing Work/Attention migrates additively without creating waits", () => {
    const path = tempPath();
    const db = open(path);
    const { work, item } = workWithItem(db);
    db.exec(`DROP TABLE control_waits; DROP TABLE control_work_dependencies; UPDATE control_schema_meta SET version=6 WHERE id=1;`);
    db.close();
    const reopened = open(path);
    expect(reopened.query("SELECT version FROM control_schema_meta WHERE id=1").get()).toEqual({ version: 8 });
    expect(getWork(reopened, work.work_id)?.revision).toBe(1);
    expect(getAttention(reopened, item.item_id)?.revision).toBe(item.revision);
    expect(reopened.query("SELECT COUNT(*) AS n FROM control_waits").get()).toEqual({ n: 0 });
    expect(reopened.query("SELECT COUNT(*) AS n FROM control_work_dependencies").get()).toEqual({ n: 0 });
    reopened.close();
  });

  test("a newer schema is refused instead of bypassing v7 constraints", () => {
    const db = memory();
    db.query("UPDATE control_schema_meta SET version=9 WHERE id=1").run();
    expectControl(() => ensureControlSchema(db), "blocked", /newer than supported 8/);
    db.close();
  });

  test("DDL rejects baseline samples later than creation and ready rows without ready facts", () => {
    const db = memory();
    const { wait } = created(db);
    expect(() => db.query("UPDATE control_waits SET baseline_established_at=created_at+1 WHERE wait_id=?").run(wait.wait_id)).toThrow();
    expect(() => db.query("UPDATE control_waits SET state='ready', next_check_at=NULL, disposition_state='pending' WHERE wait_id=?").run(wait.wait_id)).toThrow();
    expect(() => db.query("UPDATE control_waits SET next_check_at=deadline_at WHERE wait_id=?").run(wait.wait_id)).toThrow();
    db.close();
  });
});

describe("createConditionWait", () => {
  test("persists the live baseline, its real sample time and wait.created in one transaction", () => {
    const db = memory();
    const { work, item, wait } = created(db);
    expect(wait).toMatchObject({ work_id: work.work_id, item_id: item.item_id, state: "watching", version: 1, actor: "owner", decision_owner: "owner",
      baseline_established_at: T + 500, created_at: T + 1000, baseline_generation: T + 500, source_generation: T + 500,
      observed_fingerprint: "fp-OPEN", observed_generation: 1, unchanged_count: 0, last_observed_at: T + 500, last_confirmed_at: T + 500,
      next_check_at: T + 1000 + 5 * MIN, transient_budget: 3, transient_failures: 0, disposition: "redecide", resume_grant: null, disposition_state: null });
    expect(wait.observed).toEqual(prBaseline().baseline as unknown as Record<string, unknown>);
    expect(wait.source_identity).toEqual({ host: "github.com", number: 7, owner: "acme", provider: "github", repo: "app" });
    const rows = outbox(db, wait.wait_id);
    expect(rows.map((row) => [row.kind, row.entity_version, row.work_id, row.item_id])).toEqual([["wait.created", 1, work.work_id, item.item_id]]);
    expect(JSON.parse(rows[0]!.payload as string)).toEqual({ wait: JSON.parse(canonicalJson(wait)) });
    db.close();
  });

  test("a deadline inside the first interval schedules the last pre-deadline check (DDL next_check_at < deadline_at)", () => {
    const db = memory();
    const { work, item } = workWithItem(db);
    const wait = createConditionWait(db, prInput(work.work_id, item.item_id, { deadline_at: T + 1000 + MIN }), { actor: "owner", baseline: prBaseline(), now: T + 1000 });
    expect(wait.next_check_at).toBe(T + 1000 + MIN - 1);
    db.close();
  });

  test("B03: a source already changed before creation is only the baseline, never ready", () => {
    const db = memory();
    const { work, item } = workWithItem(db);
    const wait = createConditionWait(db, prInput(work.work_id, item.item_id), { actor: "owner", baseline: prBaseline(T + 500, "MERGED"), now: T + 1000 });
    expect(wait.state).toBe("watching");
    expect(wait.ready_at).toBeNull();
    expect((wait.baseline as { state: string }).state).toBe("MERGED");
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1"]);
    db.close();
  });

  test("rejects clock regression, past deadlines, untrusted identity and client-owned fields", () => {
    const db = memory();
    const { work, item } = workWithItem(db);
    const input = prInput(work.work_id, item.item_id);
    expectControl(() => createConditionWait(db, input, { actor: "owner", baseline: prBaseline(T + 2000), now: T + 1000 }), "invalid", /clock regression/);
    expectControl(() => createConditionWait(db, { ...input, deadline_at: T + 1000 }, { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "invalid", /deadline/);
    expectControl(() => createConditionWait(db, input, { actor: "mallory", baseline: prBaseline(), now: T + 1000 }), "forbidden");
    expectControl(() => createConditionWait(db, input, { actor: "", baseline: prBaseline(), now: T + 1000 }), "invalid", /actor/);
    expectControl(() => createConditionWait(db, { ...input, actor: "owner" } as CreateWaitInput, { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "invalid", /unexpected/);
    expectControl(() => createConditionWait(db, { ...input, transient_budget: 4 }, { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "invalid");
    expectControl(() => createConditionWait(db, { ...input, transient_budget: 0 }, { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "invalid");
    const other = prBaseline(); (other.baseline as { number: number }).number = 8;
    expectControl(() => createConditionWait(db, input, { actor: "owner", baseline: other, now: T + 1000 }), "invalid", /identity/);
    const check: CreateWaitInput = { ...input, condition: { kind: "check_new_result", source: { orchestrator_db: "local", work_id: work.work_id, task_id: "t", attempt_id: "a", check_id: "ci", check_def_version: "unknown" } } };
    expectControl(() => createConditionWait(db, check, { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "invalid", /exact check definition/);
    expect(db.query("SELECT COUNT(*) AS n FROM control_waits").get()).toEqual({ n: 0 });
    db.close();
  });

  test("requires an active Work, a current open item of the same Work and a decision owner", () => {
    const db = memory();
    const { work, item } = workWithItem(db);
    const second = workWithItem(db, "item-2");
    expectControl(() => createConditionWait(db, prInput(work.work_id, second.item.item_id), { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "invalid", /another work/);
    reviseContract(db, work.work_id, 1, contract, "narrow", T + 100);
    expectControl(() => createConditionWait(db, prInput(work.work_id, item.item_id), { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "conflict", /not an open responsibility/);
    const stale = upsertAttention(db, { ...getAttention(db, second.item.item_id)!, item_id: "stale", work_id: work.work_id, contract_revision: 2 }, T);
    db.query("UPDATE control_attention SET contract_revision=1 WHERE item_id=?").run(stale.item_id); // responsibility bound to an older contract
    expectControl(() => createConditionWait(db, prInput(work.work_id, stale.item_id), { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "conflict", /stale contract revision/);
    const bare = createWork(db, { title: "no contract", source: "test" }, T);
    const bareItem = upsertAttention(db, { ...getAttention(db, second.item.item_id)!, item_id: "bare", work_id: bare.work_id, contract_revision: 1 }, T);
    expectControl(() => createConditionWait(db, prInput(bare.work_id, bareItem.item_id), { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "blocked", /decision owner/);
    const candidate = createWork(db, { title: "c", source: "test", contract, candidate: true }, T);
    expectControl(() => createConditionWait(db, prInput(candidate.work_id, item.item_id), { actor: "owner", baseline: prBaseline(), now: T + 1000 }), "conflict", /not active/);
    db.close();
  });

  test("one unsettled wait per exact normalized condition; 409 carries the existing wait", () => {
    const db = memory();
    const { work, item, wait } = created(db);
    const shouted = prInput(work.work_id, item.item_id, { condition: { kind: "github_pr_merged", source: { provider: "github", host: " GitHub.com ", owner: "ACME", repo: "App", number: 7 } } });
    const error = expectControl(() => createConditionWait(db, shouted, { actor: "owner", baseline: prBaseline(), now: T + 2000 }), "conflict", "active_wait_exists");
    expect(error.details).toMatchObject({ code: "active_wait_exists", wait_id: wait.wait_id, version: 1, state: "watching" });
    const otherItem = upsertAttention(db, { ...getAttention(db, item.item_id)!, item_id: "item-9" }, T);
    expect(createConditionWait(db, prInput(work.work_id, otherItem.item_id), { actor: "owner", baseline: prBaseline(), now: T + 2000 }).wait_id).not.toBe(wait.wait_id);
    cancelConditionWait(db, wait.wait_id, 1, { actor: "owner", reason: "no longer needed", now: T + 3000 });
    const fresh = createConditionWait(db, prInput(work.work_id, item.item_id), { actor: "owner", baseline: prBaseline(T + 3500), now: T + 4000 });
    expect(fresh.wait_id).not.toBe(wait.wait_id);
    expect(fresh.baseline_established_at).toBe(T + 3500);
    db.close();
  });

  test("a hash shared by a different canonical identity fails closed", () => {
    const db = memory();
    const { work, item, wait } = created(db);
    cancelConditionWait(db, wait.wait_id, 1, { actor: "owner", reason: "done", now: T + 2000 });
    db.query("UPDATE control_waits SET source_identity=? WHERE wait_id=?").run(canonicalJson({ forged: true }), wait.wait_id);
    expectControl(() => createConditionWait(db, prInput(work.work_id, item.item_id), { actor: "owner", baseline: prBaseline(), now: T + 3000 }), "blocked", /collision/);
    db.close();
  });
});

describe("cancel/list/due", () => {
  test("only the current owner cancels a watching wait; repeats return the current state", () => {
    const db = memory();
    const { wait } = created(db);
    expectControl(() => cancelConditionWait(db, wait.wait_id, 1, { actor: "mallory", reason: "x", now: T + 2000 }), "forbidden");
    expectControl(() => cancelConditionWait(db, wait.wait_id, 2, { actor: "owner", reason: "x", now: T + 2000 }), "conflict", "stale wait version");
    const cancelled = cancelConditionWait(db, wait.wait_id, 1, { actor: "owner", reason: "not needed", now: T + 2000 });
    expect(cancelled).toMatchObject({ state: "cancelled", state_reason: "not needed", version: 2, next_check_at: null, disposition_state: null });
    const again = expectControl(() => cancelConditionWait(db, wait.wait_id, 2, { actor: "owner", reason: "x", now: T + 3000 }), "conflict");
    expect(again.details).toMatchObject({ code: "wait_not_cancellable", state: "cancelled", version: 2 });
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1", "wait.cancelled@2"]);
    db.close();
  });

  test("ready cannot be cancelled away", () => {
    const db = memory();
    const { wait } = readyWait(db);
    expectControl(() => cancelConditionWait(db, wait.wait_id, wait.version, { actor: "owner", reason: "x", now: T + 7000 }), "conflict", /not cancellable/);
    db.close();
  });

  test("lists newest first with bounded limits and due rows by next_check_at", () => {
    const db = memory();
    const { work, item, wait } = created(db);
    const second = createConditionWait(db, prInput(work.work_id, upsertAttention(db, { ...getAttention(db, item.item_id)!, item_id: "i2" }, T).item_id),
      { actor: "owner", baseline: prBaseline(), now: T + 2000 });
    expect(listConditionWaits(db).map((row) => row.wait_id)).toEqual([second.wait_id, wait.wait_id]);
    expect(listConditionWaits(db, { item_id: item.item_id }).map((row) => row.wait_id)).toEqual([wait.wait_id]);
    expect(listConditionWaits(db, { state: "watching", limit: 1 })).toHaveLength(1);
    expectControl(() => listConditionWaits(db, { state: "done" as never }), "invalid");
    expect(listDueConditionWaits(db, T + 1000 + 5 * MIN, 10).map((row) => row.wait_id)).toEqual([wait.wait_id]);
    expect(listDueConditionWaits(db, T + 999, 10)).toEqual([]);
    db.close();
  });

  test("pending dispositions list oldest-first and drop out once recorded", () => {
    const db = memory();
    const { work, item, wait } = created(db);
    const other = createConditionWait(db, prInput(work.work_id, upsertAttention(db, { ...getAttention(db, item.item_id)!, item_id: "p2" }, T).item_id),
      { actor: "owner", baseline: prBaseline(), now: T + 1000 });
    expect(listPendingWaitDispositions(db, 10)).toEqual([]);
    const late = observeConditionWait(db, other.wait_id, 1, { kind: "error", error_kind: "permission_denied", detail: "403", observed_at: T + 3000 }, { next_check_at: null }, T + 3000).wait;
    const early = observeConditionWait(db, wait.wait_id, 1, obs("ready", "merged", T + 1500, T + 2000), { next_check_at: null }, T + 2000).wait;
    expect(listPendingWaitDispositions(db, 10).map((row) => row.wait_id)).toEqual([early.wait_id, late.wait_id]);
    expect(listPendingWaitDispositions(db, 1).map((row) => row.wait_id)).toEqual([early.wait_id]);
    expectControl(() => listPendingWaitDispositions(db, 0), "invalid");
    recordWaitRedecision(db, early.wait_id, early.version, { attention_revision: getAttention(db, item.item_id)!.revision, reason: "merged", now: T + 4000 });
    expect(listPendingWaitDispositions(db, 10).map((row) => row.wait_id)).toEqual([late.wait_id]);
    db.close();
  });
});

describe("observeConditionWait", () => {
  test("B01: identical snapshots only count and reschedule, across restarts", () => {
    const path = tempPath();
    let db = open(path);
    const { item, wait } = created(db);
    let result = observeConditionWait(db, wait.wait_id, 1, obs("same", "fp-OPEN", T + 500, T + 2000), { next_check_at: T + 2000 + 5 * MIN }, T + 2000);
    db.close();
    db = open(path);
    result = observeConditionWait(db, wait.wait_id, 2, obs("changed_not_ready", "fp-OPEN", T + 500, T + 3000), { next_check_at: T + 3000 + 5 * MIN }, T + 3000);
    expect(result.became_ready).toBe(false);
    expect(result.wait).toMatchObject({ state: "watching", version: 3, unchanged_count: 2, observed_generation: 1, source_generation: T + 500,
      last_observed_at: T + 3000, last_confirmed_at: T + 3000, next_check_at: T + 3000 + 5 * MIN });
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1", "wait.observed@2", "wait.observed@3"]);
    expect(getAttention(db, item.item_id)?.revision).toBe(1);
    db.close();
  });

  test("a real change resets the counter and bumps observed_generation; regressions are rejected", () => {
    const db = memory();
    const { wait } = created(db);
    const changed = observeConditionWait(db, wait.wait_id, 1, obs("changed_not_ready", "fp-CLOSED", T + 1500, T + 2000), { next_check_at: T + 3 * MIN }, T + 2000);
    expect(changed.wait).toMatchObject({ observed_generation: 2, unchanged_count: 0, source_generation: T + 1500, observed_fingerprint: "fp-CLOSED" });
    expectControl(() => observeConditionWait(db, wait.wait_id, 2, obs("changed_not_ready", "fp-X", T + 1000, T + 3000), { next_check_at: T + 4 * MIN }, T + 3000), "invalid", /regresses/);
    expectControl(() => observeConditionWait(db, wait.wait_id, 2, obs("same", "fp-CLOSED", T + 1600, T + 3000), { next_check_at: T + 4 * MIN }, T + 3000), "invalid", /same observation/);
    expectControl(() => observeConditionWait(db, wait.wait_id, 2, obs("same", "fp-CLOSED", T + 1500, T + 100), { next_check_at: T + 4 * MIN }, T + 3000), "invalid", /chronology/);
    expect(getConditionWait(db, wait.wait_id)?.version).toBe(2);
    db.close();
  });

  test("B02: ready is a single CAS; replay, concurrent and out-of-order observations cannot re-trigger it", () => {
    const path = tempPath();
    const a = open(path);
    const b = open(path);
    const { wait } = created(a);
    const first = observeConditionWait(a, wait.wait_id, 1, obs("ready", "merged", T + 5000, T + 6000), { next_check_at: null }, T + 6000);
    expect(first.became_ready).toBe(true);
    expect(first.wait).toMatchObject({ state: "ready", ready_at: T + 6000, ready_observation_fingerprint: "merged", source_generation: T + 5000,
      next_check_at: null, disposition_state: "pending", version: 2 });
    expectControl(() => observeConditionWait(b, wait.wait_id, 1, obs("ready", "merged", T + 5000, T + 6000), { next_check_at: null }, T + 6100), "conflict", "stale wait version");
    expectControl(() => observeConditionWait(b, wait.wait_id, 2, obs("ready", "merged", T + 5000, T + 6000), { next_check_at: null }, T + 6100), "conflict", /ready/);
    expectControl(() => observeConditionWait(b, wait.wait_id, 2, obs("changed_not_ready", "old", T + 900, T + 6000), { next_check_at: T + 9 * MIN }, T + 6100), "conflict");
    expect(outbox(a, wait.wait_id).filter((row) => row.kind === "wait.ready")).toHaveLength(1);
    a.close(); b.close();
  });

  test("B03: ready must advance past both the baseline and the persisted high-water", () => {
    const db = memory();
    const { wait } = created(db);
    expectControl(() => observeConditionWait(db, wait.wait_id, 1, obs("ready", "merged", T + 500, T + 2000), { next_check_at: null }, T + 2000), "invalid", /advance/);
    observeConditionWait(db, wait.wait_id, 1, obs("changed_not_ready", "closed", T + 1500, T + 2000), { next_check_at: T + 3 * MIN }, T + 2000);
    expectControl(() => observeConditionWait(db, wait.wait_id, 2, obs("ready", "merged", T + 1500, T + 3000), { next_check_at: null }, T + 3000), "invalid", /advance/);
    expect(getConditionWait(db, wait.wait_id)?.state).toBe("watching");
    db.close();
  });

  test("B05: transient budget persists across restarts and the third consecutive failure expires", () => {
    const path = tempPath();
    let db = open(path);
    const { wait } = created(db);
    const error = (at: number): Extract<WaitObservation, { kind: "error" }> => ({ kind: "error", error_kind: "transient", detail: "network reset", observed_at: at });
    let current = observeConditionWait(db, wait.wait_id, 1, error(T + 2000), { next_check_at: null }, T + 2000).wait;
    expect(current).toMatchObject({ state: "watching", transient_failures: 1, last_error_kind: "transient", last_confirmed_at: T + 500, observed_fingerprint: "fp-OPEN" });
    expect(current.next_check_at).toBe(current.retry_after_at);
    expect(current.next_check_at! - (T + 2000)).toBeGreaterThanOrEqual(5 * MIN);
    expect(current.next_check_at! - (T + 2000)).toBeLessThan(5 * MIN + 30_000);
    db.close();
    db = open(path);
    current = observeConditionWait(db, wait.wait_id, 2, { ...error(T + 3000), error_kind: "rate_limited", retry_after_at: T + 20 * MIN }, { next_check_at: null }, T + 3000).wait;
    expect(current).toMatchObject({ transient_failures: 2, retry_after_at: T + 20 * MIN, next_check_at: T + 20 * MIN });
    expectControl(() => expireConditionWait(db, wait.wait_id, 3, "transient_budget_exhausted", T + 3500), "conflict", /not reached/);
    db.close();
    db = open(path);
    current = observeConditionWait(db, wait.wait_id, 3, { ...error(T + 4000), error_kind: "unknown" }, { next_check_at: null }, T + 4000).wait;
    expect(current).toMatchObject({ state: "expired", state_reason: "transient_budget_exhausted", transient_failures: 3, next_check_at: null, disposition_state: "pending" });
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1", "wait.observation_failed@2", "wait.observation_failed@3", "wait.expired@4"]);
    db.close();
  });

  test("success resets the consecutive count; a tightened budget of 1 stops on the first failure", () => {
    const db = memory();
    const { work, item, wait } = created(db);
    observeConditionWait(db, wait.wait_id, 1, { kind: "error", error_kind: "transient", detail: "x", observed_at: T + 2000 }, { next_check_at: null }, T + 2000);
    const ok = observeConditionWait(db, wait.wait_id, 2, obs("same", "fp-OPEN", T + 500, T + 3000), { next_check_at: T + 9 * MIN }, T + 3000).wait;
    expect(ok).toMatchObject({ transient_failures: 0, last_error_kind: null, retry_after_at: null });
    const tight = createConditionWait(db, prInput(work.work_id, upsertAttention(db, { ...getAttention(db, item.item_id)!, item_id: "tight" }, T).item_id, { transient_budget: 1 }),
      { actor: "owner", baseline: prBaseline(), now: T + 1000 });
    expect(observeConditionWait(db, tight.wait_id, 1, { kind: "error", error_kind: "transient", detail: "x", observed_at: T + 2000 }, { next_check_at: null }, T + 2000).wait)
      .toMatchObject({ state: "expired", state_reason: "transient_budget_exhausted", transient_failures: 1 });
    db.close();
  });

  test("permanent errors settle unavailable and keep the last confirmed snapshot", () => {
    const db = memory();
    const { wait } = created(db);
    const result = observeConditionWait(db, wait.wait_id, 1, { kind: "error", error_kind: "permission_denied", detail: "HTTP 403", observed_at: T + 2000 }, { next_check_at: null }, T + 2000);
    expect(result.wait).toMatchObject({ state: "unavailable", state_reason: "permission_denied", last_error_kind: "permission_denied", last_error_detail: "HTTP 403",
      observed_fingerprint: "fp-OPEN", last_confirmed_at: T + 500, disposition_state: "pending", next_check_at: null });
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1", "wait.unavailable@2"]);
    db.close();
  });

  test("B05: deadline expiry never observes, and a schedule past the deadline expires in the same CAS", () => {
    const db = memory();
    const { work, item } = workWithItem(db);
    const wait = createConditionWait(db, prInput(work.work_id, item.item_id, { deadline_at: T + 10 * MIN }), { actor: "owner", baseline: prBaseline(), now: T + 1000 });
    expectControl(() => expireConditionWait(db, wait.wait_id, 1, "deadline", T + 9 * MIN), "conflict", /not reached/);
    const hinted = observeConditionWait(db, wait.wait_id, 1, { kind: "error", error_kind: "rate_limited", detail: "429", observed_at: T + 2000, retry_after_at: T + 60 * MIN }, { next_check_at: null }, T + 2000);
    expect(hinted.wait).toMatchObject({ state: "expired", state_reason: "deadline", transient_failures: 1 });
    const other = createConditionWait(db, prInput(work.work_id, upsertAttention(db, { ...item, item_id: "d2" }, T).item_id, { deadline_at: T + 10 * MIN }), { actor: "owner", baseline: prBaseline(), now: T + 1000 });
    expect(observeConditionWait(db, other.wait_id, 1, obs("same", "fp-OPEN", T + 500, T + 6 * MIN), { next_check_at: T + 11 * MIN }, T + 6 * MIN).wait)
      .toMatchObject({ state: "expired", state_reason: "deadline", unchanged_count: 1 });
    const third = createConditionWait(db, prInput(work.work_id, upsertAttention(db, { ...item, item_id: "d3" }, T).item_id, { deadline_at: T + 10 * MIN }), { actor: "owner", baseline: prBaseline(), now: T + 1000 });
    expectControl(() => observeConditionWait(db, third.wait_id, 1, obs("same", "fp-OPEN", T + 500, T + 10 * MIN), { next_check_at: null }, T + 10 * MIN), "conflict", /deadline/);
    expect(expireConditionWait(db, third.wait_id, 1, "deadline", T + 10 * MIN)).toMatchObject({ state: "expired", state_reason: "deadline", disposition_state: "pending", version: 2 });
    db.close();
  });
});

describe("dispositions", () => {
  test("redecision lands the original Attention in the same transaction and frees the unique slot", () => {
    const db = memory();
    const { work, item, wait } = readyWait(db);
    expectControl(() => recordWaitRedecision(db, wait.wait_id, wait.version, { attention_revision: item.revision + 5, reason: "merged", now: T + 7000 }), "conflict", /stale attention/);
    const done = recordWaitRedecision(db, wait.wait_id, wait.version, { attention_revision: item.revision, reason: "PR merged; decide next step", now: T + 7000 });
    expect(done).toMatchObject({ state: "ready", disposition_state: "redecision_recorded", disposition_at: T + 7000, version: 3 });
    const landed = getAttention(db, item.item_id)!;
    expect(landed).toMatchObject({ revision: item.revision + 1, state: "open", effect_state: "not_started" });
    expect(landed.evidence.wait_redecision).toMatchObject({ wait_id: wait.wait_id, wait_version: 3, wait_state: "ready", reason: "PR merged; decide next step" });
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1", "wait.ready@2", "wait.disposition_redecision@3"]);
    expect(outbox(db, item.item_id).map((row) => row.kind)).toContain("attention.wait_redecision");
    expectControl(() => recordWaitRedecision(db, wait.wait_id, 3, { attention_revision: landed.revision, reason: "again", now: T + 8000 }), "conflict");
    expectControl(() => claimWaitDispatch(db, wait.wait_id, 3, "claim", "dispatch", T + 8000), "conflict");
    const next = createConditionWait(db, prInput(work.work_id, item.item_id), { actor: "owner", baseline: prBaseline(T + 8500), now: T + 9000 });
    expect(next.wait_id).not.toBe(wait.wait_id);
    db.close();
  });

  test("redecide waits can never be claimed for execution", () => {
    const db = memory();
    const { wait } = readyWait(db);
    expectControl(() => claimWaitDispatch(db, wait.wait_id, wait.version, "claim", "dispatch", T + 7000), "conflict", /authorized/);
    db.close();
  });

  test("B06: a blocked authorized disposition records blocked + redecision on one version and consumes nothing", () => {
    const db = memory();
    const { item, wait } = authorizedReady(db);
    const blocked = recordWaitRedecision(db, wait.wait_id, wait.version, { attention_revision: item.revision, reason: "stale_target", now: T + 7000 });
    expect(blocked.disposition_detail).toMatchObject({ blocked_reason: "stale_target" });
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1", "wait.ready@2", "wait.disposition_blocked@3", "wait.disposition_redecision@3"]);
    db.close();
  });

  test("claim → accepted dispatch → bound effect; replays are idempotent and conflicts fail closed", () => {
    const db = memory();
    const { item, wait } = authorizedReady(db);
    expectControl(() => claimWaitDispatch(db, wait.wait_id, wait.version - 1, "c1", "d1", T + 7000), "conflict", "stale wait version");
    const claimed = claimWaitDispatch(db, wait.wait_id, wait.version, "c1", "d1", T + 7000);
    expect(claimed).toMatchObject({ disposition_state: "dispatching", disposition_claim_id: "c1", dispatch_id: "d1", version: 3 });
    expectControl(() => claimWaitDispatch(db, wait.wait_id, 3, "c2", "d2", T + 7100), "conflict");
    expectControl(() => recordWaitDispatch(db, wait.wait_id, 3, "c2", { state: "accepted", dispatch_id: "d1", accepted_at: T + 7200 }, T + 7200), "conflict", /claim/);
    expectControl(() => recordWaitDispatch(db, wait.wait_id, 3, "c1", { state: "accepted", dispatch_id: "other", accepted_at: T + 7200 }, T + 7200), "conflict", /dispatch id/);
    const dispatched = recordWaitDispatch(db, wait.wait_id, 3, "c1", { state: "accepted", dispatch_id: "d1", accepted_at: T + 7200 }, T + 7200);
    expect(dispatched).toMatchObject({ disposition_state: "dispatched", version: 4 });
    expect(getAttention(db, item.item_id)).toMatchObject({ state: "applying", effect_state: "applying" });
    const effect = { state: "succeeded" as const, evidence: { runtime_event: "e-1", dispatch_id: "d1" }, observed_at: T + 9000 };
    expectControl(() => recordWaitEffect(db, wait.wait_id, 4, "c2", effect), "conflict", /claim/);
    const observed = recordWaitEffect(db, wait.wait_id, 4, "c1", effect);
    expect(observed).toMatchObject({ disposition_state: "effect_succeeded", effect_observed_at: T + 9000, version: 5 });
    expect(recordWaitEffect(db, wait.wait_id, 4, "c1", effect).version).toBe(5);
    expectControl(() => recordWaitEffect(db, wait.wait_id, 5, "c1", { ...effect, state: "failed" }), "conflict", /conflicting/);
    expect(kinds(db, wait.wait_id)).toEqual(["wait.created@1", "wait.ready@2", "wait.disposition_claimed@3", "wait.disposition_dispatched@4", "wait.effect_observed@5"]);
    db.close();
  });

  test("unknown dispatch keeps the slot occupied until redecided and never erases the unknown effect", () => {
    const db = memory();
    const { work, item, wait } = authorizedReady(db);
    claimWaitDispatch(db, wait.wait_id, wait.version, "c1", "d1", T + 7000);
    const unknown = recordWaitDispatch(db, wait.wait_id, 3, "c1", { state: "unknown", reason: "launcher timed out" }, T + 7200);
    expect(unknown).toMatchObject({ disposition_state: "effect_unknown", effect_observed_at: T + 7200 });
    expect(getAttention(db, item.item_id)).toMatchObject({ state: "open", effect_state: "unknown" });
    expectControl(() => createConditionWait(db, prInput(work.work_id, item.item_id), { actor: "owner", baseline: prBaseline(T + 7300), now: T + 7400 }), "conflict", "active_wait_exists");
    const settled = recordWaitRedecision(db, wait.wait_id, 4, { attention_revision: getAttention(db, item.item_id)!.revision, reason: "verify launch", now: T + 7500 });
    expect(settled.disposition_state).toBe("redecision_recorded");
    expect(getAttention(db, item.item_id)?.effect_state).toBe("unknown");

    db.close();
  });

  test("rejected dispatch returns the original responsibility to a human on one version", () => {
    const db = memory();
    const { item, wait } = authorizedReady(db);
    claimWaitDispatch(db, wait.wait_id, wait.version, "c1", "d1", T + 7000);
    const rejected = recordWaitDispatch(db, wait.wait_id, 3, "c1", { state: "rejected", reason: "process alive" }, T + 7200);
    expect(rejected).toMatchObject({ disposition_state: "redecision_recorded", disposition_detail: { blocked_reason: "dispatch rejected: process alive" } });
    expect(getAttention(db, item.item_id)).toMatchObject({ state: "open", effect_state: "not_started", revision: item.revision + 1 });
    expect(kinds(db, wait.wait_id).slice(-2)).toEqual(["wait.disposition_blocked@4", "wait.disposition_redecision@4"]);
    db.close();
  });
});

describe("work dependencies", () => {
  test("owner-only CAS create/revoke with outbox snapshots and typed conflicts", () => {
    const db = memory();
    const dependent = createWork(db, { title: "d", source: "test", contract }, T);
    const prerequisite = createWork(db, { title: "p", source: "test", contract }, T);
    const input = { work_id: dependent.work_id, prerequisite_work_id: prerequisite.work_id, actor: "owner", now: T + 10 };
    expectControl(() => createWorkDependency(db, { ...input, actor: "mallory" }), "forbidden");
    expectControl(() => createWorkDependency(db, { ...input, prerequisite_work_id: dependent.work_id }), "invalid");
    const edge = createWorkDependency(db, input);
    expect(edge).toEqual({ work_id: dependent.work_id, prerequisite_work_id: prerequisite.work_id, revision: 1, state: "active", created_by: "owner", created_at: T + 10 });
    expectControl(() => createWorkDependency(db, input), "conflict", /already active/);
    expect(getActiveDependencyEdge(db, dependent.work_id, prerequisite.work_id)).toEqual(edge);
    expectControl(() => revokeWorkDependency(db, dependent.work_id, prerequisite.work_id, 2, { actor: "owner", reason: "x", now: T + 20 }), "conflict", /stale/);
    expectControl(() => revokeWorkDependency(db, dependent.work_id, prerequisite.work_id, 1, { actor: "mallory", reason: "x", now: T + 20 }), "forbidden");
    const revoked = revokeWorkDependency(db, dependent.work_id, prerequisite.work_id, 1, { actor: "owner", reason: "scope changed", now: T + 20 });
    expect(revoked).toMatchObject({ revision: 2, state: "revoked" });
    expect(getActiveDependencyEdge(db, dependent.work_id, prerequisite.work_id)).toBeNull();
    expect(createWorkDependency(db, { ...input, now: T + 30 })).toMatchObject({ revision: 3, state: "active" });
    const events = db.query("SELECT kind,entity_version,payload FROM control_outbox WHERE kind LIKE 'work.dependency_%' ORDER BY entity_version").all() as Array<{ kind: string; entity_version: number; payload: string }>;
    expect(events.map((row) => [row.kind, row.entity_version])).toEqual([["work.dependency_created", 1], ["work.dependency_revoked", 2], ["work.dependency_created", 3]]);
    expect(JSON.parse(events[1]!.payload)).toMatchObject({ edge: { revision: 2, state: "revoked" }, reason: "scope changed", actor: "owner" });
    db.close();
  });

  test("work_completed waits require the exact active edge revision", () => {
    const db = memory();
    const { work, item } = workWithItem(db);
    const prerequisite = createWork(db, { title: "p", source: "test", contract }, T);
    const input: CreateWaitInput = { work_id: work.work_id, item_id: item.item_id, deadline_at: T + 60 * MIN, condition: { kind: "work_completed", source: { prerequisite_work_id: prerequisite.work_id, dependency_revision: 1 } } };
    const baseline: WaitBaselineSnapshot = { baseline: { prerequisite_work_id: prerequisite.work_id, dependency_revision: 1, work_revision: 1, state: "active", observed_at: T + 500 }, baseline_generation: 1, fingerprint: "w1", established_at: T + 500 };
    expectControl(() => createConditionWait(db, input, { actor: "owner", baseline, now: T + 1000 }), "blocked", /dependency edge/);
    createWorkDependency(db, { work_id: work.work_id, prerequisite_work_id: prerequisite.work_id, actor: "owner", now: T + 100 });
    const ahead: WaitBaselineSnapshot = { ...baseline, baseline: { ...baseline.baseline, dependency_revision: 2 } as WaitBaselineSnapshot["baseline"] };
    expectControl(() => createConditionWait(db, { ...input, condition: { kind: "work_completed", source: { prerequisite_work_id: prerequisite.work_id, dependency_revision: 2 } } }, { actor: "owner", baseline: ahead, now: T + 1000 }), "conflict", /dependency revision/);
    expectControl(() => createConditionWait(db, input, { actor: "owner", baseline: ahead, now: T + 1000 }), "invalid", /identity/);
    expectControl(() => createConditionWait(db, input, { actor: "owner", baseline: { ...baseline, baseline_generation: 2 }, now: T + 1000 }), "invalid", /work_revision/);
    expect(createConditionWait(db, input, { actor: "owner", baseline, now: T + 1000 })).toMatchObject({ state: "watching", baseline_generation: 1 });
    db.close();
  });
});

describe("completeWork", () => {
  test("only the owner completes an active Work after human acceptance and all responsibility closes", () => {
    const db = memory();
    const human: Contract = { ...contract, acceptance: [{ id: "h", kind: "human", description: "owner accepts" }] };
    const { work, item, wait } = created(db);
    expectControl(() => completeWork(db, work.work_id, 1, { actor: "mallory", evidence: { pr: 7 }, now: T + 2000 }), "forbidden");
    expectControl(() => completeWork(db, work.work_id, 2, { actor: "owner", evidence: { pr: 7 }, now: T + 2000 }), "conflict", /stale/);
    expectControl(() => completeWork(db, work.work_id, 1, { actor: "owner", evidence: {}, now: T + 2000 }), "invalid", /evidence/);
    expectControl(() => completeWork(db, work.work_id, 1, { actor: "owner", evidence: { pr: 7 }, now: T + 2000 }), "blocked", /attention/);
    db.query("UPDATE control_attention SET state='resolved', effect_state='succeeded' WHERE item_id=?").run(item.item_id);
    expectControl(() => completeWork(db, work.work_id, 1, { actor: "owner", evidence: { pr: 7 }, now: T + 2000 }), "blocked", /condition wait/);
    cancelConditionWait(db, wait.wait_id, 1, { actor: "owner", reason: "done", now: T + 2000 });
    const completed = completeWork(db, work.work_id, 1, { actor: "owner", evidence: { pr: 7 }, now: T + 3000 });
    expect(completed).toMatchObject({ state: "completed", revision: 2, updated_at: T + 3000 });
    expect(getWork(db, work.work_id)).toEqual(completed);
    const row = db.query("SELECT * FROM control_outbox WHERE entity_id=? AND kind='work.completed'").get(work.work_id) as Record<string, unknown>;
    const verified = verifyControlOutboxEvent(db, row);
    expect(verified).toMatchObject({ entity_version: 2, work_id: work.work_id, item_id: null });
    expect(verified.payload).toEqual({ work: JSON.parse(canonicalJson(completed)), actor: "owner", evidence: { pr: 7 } });
    expectControl(() => completeWork(db, work.work_id, 2, { actor: "owner", evidence: { pr: 7 }, now: T + 4000 }), "conflict", /not active/);

    const gated = createWork(db, { title: "h", source: "test", contract: human }, T);
    expectControl(() => completeWork(db, gated.work_id, 1, { actor: "owner", evidence: { ok: true }, now: T + 2000 }), "blocked", /human acceptance/);
    db.close();
  });
});

describe("verifyControlOutboxEvent", () => {
  function row(db: Database) {
    const work = createWork(db, { title: "w", source: "test", contract }, T);
    return db.query("SELECT * FROM control_outbox WHERE entity_id=? AND kind='work.created'").get(work.work_id) as Record<string, unknown>;
  }
  function invalid(fn: () => unknown, message: RegExp): void {
    expect(fn).toThrow(ControlEventVerificationError);
    expect(fn).toThrow(message);
  }

  test("accepts genuine rows and rejects every forged or coerced field as invalid_response", () => {
    const db = memory();
    const genuine = row(db);
    expect(verifyControlOutboxEvent(db, genuine).kind).toBe("work.created");
    const payload = JSON.parse(genuine.payload as string) as { work: Record<string, unknown> };
    const tampered = canonicalJson({ work: { ...payload.work, state: "completed" } });
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, payload: tampered }), /payload hash mismatch/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, payload: tampered, payload_hash: controlPayloadHash(JSON.parse(tampered)) }), /differs from the recorded event/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, payload: JSON.stringify(payload, null, 1) }), /canonical/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, payload: "{" }), /malformed/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, entity_version: String(genuine.entity_version) }), /entity_version/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, entity_version: 2 }), /event_id/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, kind: "work.completed" }), /event_id/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, producer_id: "someone-else" }), /producer/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, work_id: undefined }), /work_id/);
    invalid(() => verifyControlOutboxEvent(db, { ...genuine, work_id: "another" }), /differs from the recorded event/);
    const unrecorded = { ...genuine, entity_id: "ghost", event_id: "0".repeat(64) };
    invalid(() => verifyControlOutboxEvent(db, unrecorded), /event_id/);
    db.close();
  });
});

describe("wait/work outbox projection", () => {
  function publishAll(db: Database): Array<Record<string, unknown>> {
    const details: Array<Record<string, unknown>> = [];
    publishControlEvents(db, "/nonexistent-ledger-dir/ledger.db", (detail) => { details.push(detail); }, T + 100_000);
    return details;
  }
  function ledger(): Database { const db = new Database(":memory:"); initializeLedger(db); return db; }
  const waitRow = (db: Database, waitId: string) => db.query("SELECT version,state,disposition_state,wait FROM control_wait_projection WHERE wait_id=?").get(waitId) as { version: number; state: string; disposition_state: string | null; wait: string } | null;

  test("projects the newest wait version idempotently; late lower versions never roll back", () => {
    const control = memory();
    const { wait } = readyWait(control);
    const done = recordWaitRedecision(control, wait.wait_id, wait.version, { attention_revision: 1, reason: "merged", now: T + 7000 });
    const details = publishAll(control).filter((detail) => detail.entity_id === wait.wait_id);
    expect(details.map((detail) => `${detail.event_kind}@${detail.entity_version}`).sort()).toEqual(["wait.created@1", "wait.disposition_redecision@3", "wait.ready@2"]);
    const byVersion = (version: number) => details.find((detail) => detail.entity_version === version)!;
    const target = ledger();
    applyControlEvent(target, byVersion(3), 1);
    applyControlEvent(target, byVersion(1), 2);
    applyControlEvent(target, byVersion(2), 3);
    applyControlEvent(target, byVersion(3), 4);
    expect(waitRow(target, wait.wait_id)).toMatchObject({ version: 3, state: "ready", disposition_state: "redecision_recorded" });
    expect(JSON.parse(waitRow(target, wait.wait_id)!.wait)).toEqual(JSON.parse(canonicalJson(done)));
    expect(target.query("SELECT COUNT(*) AS n FROM applied_control_events WHERE event_id IN (?,?,?)").get(...details.map((detail) => detail.event_id as string))).toEqual({ n: 3 });
    target.close(); control.close();
  });

  test("forged or mismatched wait envelopes are rejected before projection", () => {
    const control = memory();
    const { wait } = created(control);
    const detail = publishAll(control).find((entry) => entry.entity_id === wait.wait_id)!;
    const target = ledger();
    const genuineWait = (detail.payload as { wait: ConditionWait }).wait;
    const forgedPayload = { wait: { ...genuineWait, state: "ready" } };
    expect(() => applyControlEvent(target, { ...detail, payload: forgedPayload }, 1)).toThrow(/payload hash mismatch/);
    expect(() => applyControlEvent(target, { ...detail, event_kind: "wait.ready" }, 1)).toThrow(ControlEventVerificationError);
    expect(() => applyControlEvent(target, { ...detail, item_id: "other" }, 1)).toThrow(/does not match/);
    expect(() => applyControlEvent(target, { ...detail, payload: { wait: { ...genuineWait, version: 2 } }, payload_hash: controlPayloadHash({ wait: { ...genuineWait, version: 2 } }) }, 1)).toThrow(/does not match/);
    expect(waitRow(target, wait.wait_id)).toBeNull();
    expect(target.query("SELECT COUNT(*) AS n FROM applied_control_events").get()).toEqual({ n: 0 });
    applyControlEvent(target, detail, 2);
    // Same identity, re-hashed different payload: the applied identity refuses a second payload.
    expect(() => applyControlEvent(target, { ...detail, payload: forgedPayload, payload_hash: controlPayloadHash(forgedPayload) }, 3)).toThrow(/identity mismatch/);
    expect(waitRow(target, wait.wait_id)).toMatchObject({ version: 1, state: "watching" });
    target.close(); control.close();
  });

  test("projects Work snapshots, completion, promotion precedence and dependency edges in version order", () => {
    const control = memory();
    const candidate = createWork(control, { title: "c", source: "test", contract, candidate: true }, T);
    promoteWork(control, candidate.work_id, 1, contract, "go", T + 10);
    const completed = completeWork(control, candidate.work_id, 2, { actor: "owner", evidence: { reviewed: true }, now: T + 20 });
    const other = createWork(control, { title: "o", source: "test", contract }, T);
    createWorkDependency(control, { work_id: other.work_id, prerequisite_work_id: candidate.work_id, actor: "owner", now: T + 30 });
    revokeWorkDependency(control, other.work_id, candidate.work_id, 1, { actor: "owner", reason: "dropped", now: T + 40 });
    const details = publishAll(control);
    const target = ledger();
    for (const detail of [...details].reverse()) applyControlEvent(target, detail, 1);
    expect(target.query("SELECT revision,state FROM control_work_projection WHERE work_id=?").get(candidate.work_id)).toEqual({ revision: completed.revision, state: "completed" });
    expect(target.query("SELECT revision,state FROM control_work_dependency_projection WHERE work_id=?").get(other.work_id)).toEqual({ revision: 2, state: "revoked" });
    const promotion = ledger();
    const promoted = details.filter((detail) => detail.entity_id === candidate.work_id && detail.entity_version === 2);
    expect(promoted.map((detail) => detail.event_kind).sort()).toEqual(["contract.revised", "work.promoted"]);
    for (const detail of promoted.sort((a, b) => String(b.event_kind).localeCompare(String(a.event_kind)))) applyControlEvent(promotion, detail, 1);
    expect(promotion.query("SELECT state FROM control_work_projection WHERE work_id=?").get(candidate.work_id)).toEqual({ state: "active" });
    target.close(); promotion.close(); control.close();
  });
});
