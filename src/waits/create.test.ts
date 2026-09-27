import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlError, cancelConditionWait, createWork, getConditionWait, listConditionWaits, upsertAttention } from "../control/store";
import { openMailbox, registerTarget } from "../decision-bot/mailbox";
import type {
  ConditionWait, Contract, CreateWaitInput, GithubPrMergedCondition, PrBaseline, WaitBaselineSnapshot, WaitCondition, WaitSourceAdapter, WaitSourceAdapters,
} from "../control/types";
import { createWait } from "./create";

const T = 1_700_000_000_000;
const MIN = 60_000;
const contract: Contract = {
  objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [],
  scope: { allowed_effects: ["resume"] }, budget: {}, stop_conditions: [], decision_owner: "owner",
};
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Separate real control and mailbox SQLite files, as B06 requires. */
function databases() {
  const dir = mkdtempSync(join(tmpdir(), "waits-create-")); dirs.push(dir);
  const control = new Database(join(dir, "control.db"), { create: true });
  control.exec("PRAGMA foreign_keys=ON");
  const mailbox = openMailbox(join(dir, "mailbox.db"));
  const work = createWork(control, { title: "w", source: "test", contract }, T);
  const item = upsertAttention(control, { item_id: "item-1", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: "decide after merge", trigger: "pr", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null,
    source_link: null, approval_id: "ap-1", consumer_owner: "orchestrator", contract_revision: work.revision, decision_mode: "human_only", evidence: {} }, T);
  return { control, mailbox, work, item };
}

type Calls = { baseline: WaitCondition[]; observe: number };
function prAdapter(calls: Calls, snapshot: (condition: GithubPrMergedCondition) => WaitBaselineSnapshot<PrBaseline>): WaitSourceAdapter<GithubPrMergedCondition, PrBaseline> {
  return {
    kind: "github_pr_merged",
    async establishBaseline(condition, ctx) { ctx.signal.throwIfAborted(); calls.baseline.push(condition); return snapshot(condition); },
    async observe() { calls.observe++; throw new Error("createWait must not observe"); },
  };
}
function unusedAdapter<K extends keyof WaitSourceAdapters>(kind: K): WaitSourceAdapters[K] {
  return { kind, async establishBaseline() { throw new Error(`unexpected ${kind} baseline`); }, async observe() { throw new Error("unexpected observe"); } } as unknown as WaitSourceAdapters[K];
}
function adapters(pr: WaitSourceAdapters["github_pr_merged"]): WaitSourceAdapters {
  return { github_pr_merged: pr, check_new_result: unusedAdapter("check_new_result"), work_completed: unusedAdapter("work_completed") };
}
function open(condition: GithubPrMergedCondition, establishedAt: number, state: PrBaseline["state"] = "OPEN"): WaitBaselineSnapshot<PrBaseline> {
  return { baseline: { ...condition.source, state, merged_at: state === "MERGED" ? "2023-11-14T20:00:00Z" : null, updated_at: "2023-11-14T22:13:20Z", observed_at: establishedAt },
    baseline_generation: establishedAt, fingerprint: `pr:${state}`, established_at: establishedAt };
}
function input(workId: string, itemId: string, extra: Partial<CreateWaitInput> = {}): CreateWaitInput {
  return { work_id: workId, item_id: itemId, deadline_at: T + 24 * 60 * MIN,
    condition: { kind: "github_pr_merged", source: { provider: "github", host: "GitHub.com", owner: "Acme", repo: "App", number: 7 } }, ...extra };
}
/** Monotonic test clock: baseline sample, then mailbox read, then INSERT each take a later tick. */
function clock(start = T + 1000) { let now = start; return () => (now += 100); }
async function rejected(promise: Promise<unknown>, code: ControlError["code"], message: RegExp): Promise<void> {
  try { await promise; } catch (error) {
    expect(error).toBeInstanceOf(ControlError);
    expect((error as ControlError).code).toBe(code);
    expect((error as ControlError).message).toMatch(message);
    return;
  }
  throw new Error("expected rejection");
}

describe("createWait", () => {
  test("samples the live baseline with the normalized identity before inserting; created_at follows the sample", async () => {
    const { control, mailbox, work, item } = databases();
    const calls: Calls = { baseline: [], observe: 0 };
    const now = clock();
    const wait = await createWait(control, input(work.work_id, item.item_id), {
      actor: "owner", adapters: adapters(prAdapter(calls, (condition) => open(condition, T + 1150))), mailbox, now, signal: new AbortController().signal,
    });
    expect(calls.baseline).toEqual([{ kind: "github_pr_merged", source: { provider: "github", host: "github.com", owner: "acme", repo: "app", number: 7 } }]);
    expect(calls.observe).toBe(0);
    expect(wait).toMatchObject({ state: "watching", baseline_established_at: T + 1150, last_confirmed_at: T + 1150, created_at: T + 1300, version: 1, actor: "owner", decision_owner: "owner" });
    expect(wait.baseline_established_at).toBeLessThan(wait.created_at);
    expect(getConditionWait(control, wait.wait_id)).toEqual(wait);
    control.close(); mailbox.close();
  });

  test("B03: a PR merged before creation is recorded as baseline only", async () => {
    const { control, mailbox, work, item } = databases();
    const calls: Calls = { baseline: [], observe: 0 };
    const wait = await createWait(control, input(work.work_id, item.item_id), {
      actor: "owner", adapters: adapters(prAdapter(calls, (condition) => open(condition, T + 1150, "MERGED"))), mailbox, now: clock(), signal: new AbortController().signal,
    });
    expect(wait).toMatchObject({ state: "watching", ready_at: null, disposition_state: null });
    expect((wait.baseline as PrBaseline).state).toBe("MERGED");
    control.close(); mailbox.close();
  });

  test("owner, target and duplicate checks run before any source IO", async () => {
    const { control, mailbox, work, item } = databases();
    const calls: Calls = { baseline: [], observe: 0 };
    const deps = { adapters: adapters(prAdapter(calls, (condition) => open(condition, T + 1150))), mailbox, signal: new AbortController().signal };
    await rejected(createWait(control, input(work.work_id, item.item_id), { ...deps, actor: "mallory", now: clock() }), "forbidden", /decision owner/);
    await rejected(createWait(control, input(work.work_id, "missing"), { ...deps, actor: "owner", now: clock() }), "not_found", /attention/);
    await rejected(createWait(control, input(work.work_id, item.item_id, { deadline_at: T }), { ...deps, actor: "owner", now: clock() }), "invalid", /deadline/);
    expect(calls.baseline).toHaveLength(0);
    const first = await createWait(control, input(work.work_id, item.item_id), { ...deps, actor: "owner", now: clock() });
    await rejected(createWait(control, input(work.work_id, item.item_id), { ...deps, actor: "owner", now: clock(T + 5000) }), "conflict", /active_wait_exists/);
    expect(calls.baseline).toHaveLength(1);
    cancelConditionWait(control, first.wait_id, 1, { actor: "owner", reason: "retry", now: T + 6000 });
    const second = await createWait(control, input(work.work_id, item.item_id), { ...deps, actor: "owner", now: clock(T + 7000) });
    expect(second.wait_id).not.toBe(first.wait_id);
    expect(second.baseline_established_at).toBe(T + 1150);
    control.close(); mailbox.close();
  });

  test("baseline failure or abort creates nothing and never fabricates an empty baseline", async () => {
    const { control, mailbox, work, item } = databases();
    const failing: WaitSourceAdapters["github_pr_merged"] = { kind: "github_pr_merged", async establishBaseline() { throw new Error("gh: HTTP 502"); }, async observe() { throw new Error("no"); } };
    await expect(createWait(control, input(work.work_id, item.item_id), { actor: "owner", adapters: adapters(failing), mailbox, now: clock(), signal: new AbortController().signal })).rejects.toThrow("HTTP 502");
    const aborted = new AbortController(); aborted.abort();
    const calls: Calls = { baseline: [], observe: 0 };
    await expect(createWait(control, input(work.work_id, item.item_id), { actor: "owner", adapters: adapters(prAdapter(calls, (condition) => open(condition, T + 1150))), mailbox, now: clock(), signal: aborted.signal })).rejects.toThrow();
    expect(calls.baseline).toHaveLength(0);
    const late = new AbortController();
    const slow: WaitSourceAdapters["github_pr_merged"] = { kind: "github_pr_merged", async establishBaseline(condition) { late.abort(); return open(condition, T + 1150); }, async observe() { throw new Error("no"); } };
    await expect(createWait(control, input(work.work_id, item.item_id), { actor: "owner", adapters: adapters(slow), mailbox, now: clock(), signal: late.signal })).rejects.toThrow();
    expect(listConditionWaits(control)).toEqual([]);
    control.close(); mailbox.close();
  });

  test("a baseline sampled after the creation clock (clock regression) is rejected", async () => {
    const { control, mailbox, work, item } = databases();
    const calls: Calls = { baseline: [], observe: 0 };
    await rejected(createWait(control, input(work.work_id, item.item_id), {
      actor: "owner", adapters: adapters(prAdapter(calls, (condition) => open(condition, T + 99_000))), mailbox, now: clock(), signal: new AbortController().signal,
    }), "invalid", /clock regression/);
    expect(listConditionWaits(control)).toEqual([]);
    control.close(); mailbox.close();
  });

  test("a mismatched adapter kind is refused", async () => {
    const { control, mailbox, work, item } = databases();
    const wrong = { ...unusedAdapter("check_new_result") } as unknown as WaitSourceAdapters["github_pr_merged"];
    await rejected(createWait(control, input(work.work_id, item.item_id), { actor: "owner", adapters: adapters(wrong), mailbox, now: clock(), signal: new AbortController().signal }), "invalid", /no source adapter/);
    control.close(); mailbox.close();
  });
});

describe("createWait authorized_resume (B06 control rules)", () => {
  const grant = (workRevision: number, attentionRevision: number, overrides: Record<string, unknown> = {}) => ({
    kind: "authorized_resume" as const,
    authorization: { consumer_owner: "orchestrator" as const, approval_id: "ap-1", target_version: "tv-1", approved_effect: "resume_checkpoint" as const,
      work_revision: workRevision, attention_revision: attentionRevision, attempt_id: "att-1", checkpoint_reference: "cp-1", execution_owner: "runner", expires_at: T + 60 * MIN, ...overrides },
  });
  function target(mailbox: Database, workId: string, extra: Record<string, unknown> = {}) {
    return registerTarget(mailbox, { consumerOwner: "orchestrator", approvalId: "ap-1", targetVersion: "tv-1", question: "resume after merge?", options: ["approve"],
      effect: "resume_checkpoint", scope: { attempt_id: "att-1" }, evidence: {}, expiresAt: T + 60 * MIN, workId, contractRevision: 1, attemptId: "att-1", ...extra });
  }
  async function attempt(control: Database, mailbox: Database, workId: string, itemId: string, disposition: ReturnType<typeof grant>) {
    const calls: Calls = { baseline: [], observe: 0 };
    return createWait(control, input(workId, itemId, { disposition }), { actor: "owner", adapters: adapters(prAdapter(calls, (condition) => open(condition, T + 1150))), mailbox, now: clock(), signal: new AbortController().signal });
  }

  test("every expressible mailbox mismatch rejects creation instead of degrading", async () => {
    const { control, mailbox, work, item } = databases();
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1)), "conflict", /approval target not found/);
    target(mailbox, work.work_id);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1, { target_version: "tv-0" })), "conflict", /stale target version/);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1, { expires_at: T + 61 * MIN })), "conflict", /expir/);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1, { attempt_id: "att-2" })), "conflict", /attempt/);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1, { approved_effect: "answer_blocked_request" })), "conflict", /effect/);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 2)), "blocked", /authorization scope/);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1, { expires_at: T })), "blocked", /expired/);
    mailbox.run("UPDATE approval_targets SET state='closed' WHERE approval_id='ap-1'");
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1)), "conflict", /closed/);
    mailbox.run("UPDATE approval_targets SET state='active' WHERE approval_id='ap-1'");
    mailbox.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,answer,actor,consumed_at) VALUES ('r','orchestrator','ap-1','tv-1','approve','owner',?)", [T]);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1)), "conflict", /already consumed/);
    expect(listConditionWaits(control)).toEqual([]);
    control.close(); mailbox.close();
  });

  test("a live target without a pinned grant scope, or a pre-authorized answer, still fails closed", async () => {
    const { control, mailbox, work, item } = databases();
    target(mailbox, work.work_id);
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1)), "conflict", /invalid authorization: the approval does not pin a resume checkpoint/);
    target(mailbox, work.work_id, { effect: "answer_blocked_request" });
    await rejected(attempt(control, mailbox, work.work_id, item.item_id, grant(1, 1, { approved_effect: "answer_blocked_request" })), "blocked", /authorization_post_condition_unverifiable/);
    expect(listConditionWaits(control)).toEqual([]);
    const redecide: ConditionWait = await createWait(control, input(work.work_id, item.item_id), {
      actor: "owner", adapters: adapters(prAdapter({ baseline: [], observe: 0 }, (condition) => open(condition, T + 1150))), mailbox, now: clock(), signal: new AbortController().signal,
    });
    expect(redecide).toMatchObject({ disposition: "redecide", resume_grant: null });
    expect(mailbox.query("SELECT state,consumed_at FROM approval_targets WHERE approval_id='ap-1'").get()).toEqual({ state: "active", consumed_at: null });
    control.close(); mailbox.close();
  });
});
