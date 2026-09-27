import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdapterService } from "../adapters/service";
import type { AgentRuntime, ChannelAdapter, SessionHandle, SessionReference } from "../adapters/types";
import {
  ControlError, createConditionWait, createWork, expireConditionWait, getAttention, getConditionWait, getWork, observeConditionWait, preflightConditionWait,
  reviseContract, upsertAttention,
} from "../control/store";
import type { ConditionWait, Contract, CreateWaitInput, PrBaseline, WaitBaselineSnapshot, WaitSourceAdapters } from "../control/types";
import {
  cancelTarget, checkpointReference, consumeDecision, getTarget, openMailbox, registerResumeGrant, registerTarget, writeHumanAnswer, type ResumeGrantScope,
} from "../decision-bot/mailbox";
import { probeCheckpoint, type Checkpoint } from "../shared/checkpoint";
import { inspectResume, resumeSession, type CheckpointProbe, type ResumeExecutor } from "../shared/resume";
import { createWait } from "./create";
import {
  createResumeGrant, dispatchAuthorizedRecovery, inspectWaitRecovery, listRecoveriesInFlight, observeRecoveryEffect, processRecoveryEffect,
  processWaitDisposition, RECOVERY_EFFECT_WINDOW_MS, revalidateReadyWait, type ReadyDisposition,
} from "./recovery";
import { observeDueWaits } from "./runner";

const T = 1_700_000_000_000;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const SOURCE = { provider: "github", host: "github.com", owner: "acme", repo: "app", number: 7 } as const;
const LEDGER_SCHEMA = readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8");
const STABLE_ID = "local:pi:session-1";
const RUNTIME_SESSION = "runtime-session-1";
const CONDITION = { kind: "github_pr_merged", source: { ...SOURCE } } as const;
const PID = 4242;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const contractWith = (extra: Partial<Contract> = {}): Contract => ({
  objective: "ship", acceptance: [{ id: "ci", kind: "check", description: "ci green" }], non_goals: [], scope: { repo: "acme/app" }, budget: {}, stop_conditions: [], decision_owner: "owner", ...extra,
});

/**
 * Real control, mailbox and ledger SQLite files plus real pi/omp session roots holding one intact pi session file.
 * Separate control and mailbox files by default (B06); `shared` uses production's single answers DB for both.
 */
function stores(options: { contract?: Contract; consumer?: "orchestrator" | "extension"; approval?: boolean; shared?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "waits-recovery-")); dirs.push(dir);
  const mailboxPath = join(dir, "mailbox.db");
  const mailbox = openMailbox(mailboxPath);
  const control = new Database(options.shared ? mailboxPath : join(dir, "control.db"), { create: true });
  control.exec("PRAGMA busy_timeout=5000");
  const ledgerPath = join(dir, "ledger.db");
  const ledger = new Database(ledgerPath, { create: true });
  ledger.exec(LEDGER_SCHEMA);
  const roots = { pi: join(dir, "pi-sessions"), omp: join(dir, "omp-sessions") };
  mkdirSync(join(roots.pi, "--repo--"), { recursive: true });
  mkdirSync(roots.omp, { recursive: true });
  const file = join(roots.pi, "--repo--", `2026-09-28T00-00-00-000Z_${RUNTIME_SESSION}.jsonl`);
  writeFileSync(file, `${JSON.stringify({ type: "session", id: RUNTIME_SESSION, cwd: "/repo", timestamp: "2026-09-28T00:00:00.000Z" })}\n${JSON.stringify({ type: "message", id: "e1" })}\n`);
  // The real runtime probe over temporary session roots: a byte-exact checkpoint, never a string check.
  const checkpointProbe: CheckpointProbe = (input) => probeCheckpoint(input, { sessionRoots: roots });
  const work = createWork(control, { title: "w", source: "test", contract: options.contract ?? contractWith() }, T);
  const item = upsertAttention(control, { item_id: "item-1", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: "decide after merge", trigger: "pr", impact: "blocked", recommendation: null, options: [], owner: "owner", expires_at: null, source_link: null,
    approval_id: options.approval === false ? null : "ap-1", consumer_owner: options.approval === false ? null : options.consumer ?? "orchestrator",
    contract_revision: work.revision, decision_mode: "human_only", evidence: {} }, T);
  return { dir, mailboxPath, ledgerPath, control, mailbox, ledger, work, item, roots, file, checkpointProbe };
}

function seedSession(ledger: Database, options: { host?: string; runtime?: string; origin?: string; pid?: number; ended?: boolean; requestUid?: string } = {}) {
  ledger.run("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,branch,created_at,first_seen_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [STABLE_ID, options.host ?? "local", options.runtime ?? "pi", RUNTIME_SESSION, options.origin ?? "human", "/repo", "main", T, T]);
  if (options.pid !== undefined) {
    ledger.run("INSERT INTO session_incarnations(stable_id,writer_id,liveness_domain,pid,proc_boot_id,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",
      [STABLE_ID, "writer-1", "process", options.pid, "boot-1", T, T]);
  }
  if (options.ended) ledger.run("INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind) VALUES(?,?,?,?,?,?,?)", ["local", "writer-1", 1, T, STABLE_ID, "writer-1", "session_ended"]);
  if (options.requestUid) {
    ledger.run("INSERT INTO requests(request_uid,stable_id,writer_id,request_id,kind,state,created_at) VALUES(?,?,?,?,?,?,?)",
      [options.requestUid, STABLE_ID, "writer-1", "call-1", "ask", "pending", T]);
  }
}

function baseline(at: number): WaitBaselineSnapshot<PrBaseline> {
  return { baseline: { ...SOURCE, state: "OPEN", merged_at: null, updated_at: "2023-11-14T22:13:20Z", observed_at: at }, baseline_generation: at, fingerprint: "pr:OPEN", established_at: at };
}
function makeWait(control: Database, workId: string, itemId: string, actor: string, at: number, disposition?: CreateWaitInput["disposition"]): ConditionWait {
  return createConditionWait(control, { work_id: workId, item_id: itemId, deadline_at: at + DAY, condition: { kind: "github_pr_merged", source: { ...SOURCE } },
    ...(disposition ? { disposition } : {}) }, { actor, baseline: baseline(at - 100), now: at });
}
function makeReady(control: Database, wait: ConditionWait, at: number): ConditionWait {
  return observeConditionWait(control, wait.wait_id, wait.version, { kind: "ready", observed: { ...SOURCE, state: "MERGED" }, fingerprint: "pr:MERGED",
    source_generation: at, observed_at: at }, { next_check_at: null }, at).wait;
}
const grant = (attentionRevision: number, extra: Record<string, unknown> = {}): CreateWaitInput["disposition"] => ({
  kind: "authorized_resume",
  authorization: { consumer_owner: "orchestrator", approval_id: "ap-1", target_version: "tv-1", approved_effect: "resume_checkpoint", work_revision: 1,
    attention_revision: attentionRevision, attempt_id: "att-1", checkpoint_reference: "cp-1", execution_owner: "maintenance", expires_at: T + 60 * MIN, ...extra },
} as CreateWaitInput["disposition"]);
function resumeTarget(mailbox: Database, workId: string, extra: Record<string, unknown> = {}) {
  return registerTarget(mailbox, { consumerOwner: "orchestrator", approvalId: "ap-1", targetVersion: "tv-1", stableId: STABLE_ID, question: "resume after merge?",
    options: ["approve"], effect: "resume_checkpoint", scope: { attempt_id: "att-1" }, evidence: {}, expiresAt: T + 60 * MIN, workId, contractRevision: 1, attemptId: "att-1", ...extra });
}
const outboxKinds = (control: Database, waitId: string) =>
  (control.query("SELECT kind FROM control_outbox WHERE entity_id=? ORDER BY entity_version, kind").all(waitId) as Array<{ kind: string }>).map((row) => row.kind);
const receipts = (mailbox: Database) => (mailbox.query("SELECT COUNT(*) n FROM decision_receipts").get() as { n: number }).n;
const SERVER = { actor: "maintenance", actor_source: "server" as const };
const probe = (alive: number[]) => (pid: number) => alive.includes(pid);

/**
 * Pins a frozen resume grant straight through the mailbox primitive (the matrix below varies session facts that the
 * grant-creation route would refuse up front): the owner's approval of exactly this checkpoint, Attention revision,
 * post-condition and execution owner.
 */
function pinGrant(s: ReturnType<typeof stores>, checkpoint: Checkpoint, extra: Record<string, unknown> = {}) {
  const condition = preflightConditionWait(s.control, { work_id: s.work.work_id, item_id: s.item.item_id, condition: CONDITION, deadline_at: T + DAY },
    { actor: "owner", now: T }).condition;
  const scope: ResumeGrantScope = {
    stable_id: STABLE_ID, runtime: checkpoint.runtime, session: checkpoint.session, cwd: checkpoint.cwd, file: checkpoint.file,
    last_entry_id: checkpoint.last_entry_id, byte_len: checkpoint.byte_len, attention_revision: s.item.revision, expires_at: T + 60 * MIN,
    item_id: s.item.item_id, execution_owner: "maintenance", condition,
  };
  const target = registerResumeGrant(s.mailbox, { consumerOwner: "orchestrator", approvalId: "ap-1", workId: s.work.work_id, contractRevision: 1,
    attemptId: "att-1", question: "resume after merge?", scope, actor: "owner", now: T });
  return grant(s.item.revision, { target_version: target.targetVersion, checkpoint_reference: checkpointReference(scope), ...extra });
}
const probed = (s: ReturnType<typeof stores>): Checkpoint => {
  const result = s.checkpointProbe({ runtime: "pi", session: RUNTIME_SESSION, cwd: "/repo" });
  if (!result.valid) throw new Error(`fixture checkpoint invalid: ${result.reason}`);
  return result.checkpoint;
};
/** Re-registers the grant target with the same content except `extra`. */
const reregister = (s: ReturnType<typeof stores>, extra: Record<string, unknown>) => {
  const { targetVersion, evidenceHash, state: _state, ...target } = getTarget(s.mailbox, "orchestrator", "ap-1")!;
  return registerTarget(s.mailbox, { ...target, targetVersion, evidenceHash, ...extra });
};

/** An authorized ready wait whose frozen grant binding holds: terminated local pi session, intact pinned checkpoint, active exact target. */
function authorizedReady(options: { contract?: Contract; grant?: Record<string, unknown>; session?: Parameters<typeof seedSession>[1] | null; shared?: boolean } = {}) {
  const s = stores({ contract: options.contract, shared: options.shared });
  const disposition = pinGrant(s, probed(s), options.grant);
  if (options.session !== null) seedSession(s.ledger, options.session ?? { pid: PID, ended: true });
  const wait = makeReady(s.control, makeWait(s.control, s.work.work_id, s.item.item_id, "owner", T + 1000, disposition), T + 5000);
  const targetVersion = getTarget(s.mailbox, "orchestrator", "ap-1")!.targetVersion;
  return { ...s, wait, disposition, targetVersion };
}

describe("B06 revalidateReadyWait: default re-decision and fail-closed authorization", () => {
  test("a ready redecide wait returns the original responsibility to its owner; the mailbox is never consumed", async () => {
    const s = stores();
    resumeTarget(s.mailbox, s.work.work_id);
    const wait = makeReady(s.control, makeWait(s.control, s.work.work_id, s.item.item_id, "owner", T + 1000), T + 5000);
    expect(revalidateReadyWait(s.control, s.mailbox, s.ledger, wait, { ...SERVER, now: T + 6000 }))
      .toEqual({ kind: "redecide", reason: "condition ready: the original decision returns to its owner", item_id: "item-1", attention_revision: s.item.revision });
    const outcome = await processWaitDisposition({ control: s.control, mailbox: s.mailbox, ledger: s.ledger, actor: "maintenance", now: () => T + 6000, signal: new AbortController().signal }, wait);
    expect(outcome.kind).toBe("redecision_recorded");
    expect(outcome.wait).toMatchObject({ state: "ready", disposition_state: "redecision_recorded", version: wait.version + 1 });
    const item = getAttention(s.control, "item-1")!;
    expect(item).toMatchObject({ revision: s.item.revision + 1, state: "open", effect_state: "not_started" });
    expect(item.evidence.wait_redecision).toMatchObject({ wait_id: wait.wait_id, wait_state: "ready", reason: "condition ready: the original decision returns to its owner" });
    expect(outboxKinds(s.control, wait.wait_id)).toEqual(["wait.created", "wait.ready", "wait.disposition_redecision"]);
    expect(s.mailbox.query("SELECT state,consumed_at FROM approval_targets WHERE approval_id='ap-1'").get()).toEqual({ state: "active", consumed_at: null });
    expect(receipts(s.mailbox)).toBe(0);
  });

  test("unavailable/expired waits always re-decide, even with a pre-existing grant", async () => {
    const s = stores();
    resumeTarget(s.mailbox, s.work.work_id);
    const watching = makeWait(s.control, s.work.work_id, s.item.item_id, "owner", T + 1000, grant(s.item.revision));
    const expired = expireConditionWait(s.control, watching.wait_id, watching.version, "deadline", T + 1000 + DAY);
    const disposition = revalidateReadyWait(s.control, s.mailbox, s.ledger, expired, { ...SERVER, now: T + 1000 + DAY });
    expect(disposition).toEqual({ kind: "redecide", reason: "wait expired: deadline", item_id: "item-1", attention_revision: s.item.revision });
    const outcome = await processWaitDisposition({ control: s.control, mailbox: s.mailbox, ledger: s.ledger, actor: "maintenance", now: () => T + 1000 + DAY, signal: new AbortController().signal }, expired);
    expect(outcome.wait.disposition_state).toBe("redecision_recorded");
    expect(outboxKinds(s.control, expired.wait_id)).toEqual(["wait.created", "wait.expired", "wait.disposition_redecision"]);
    expect(receipts(s.mailbox)).toBe(0);
  });

  const NOW = T + 6000;
  const cases: Array<{ name: string; reason: Extract<ReadyDisposition, { kind: "blocked" }>["reason"]; setup?: (s: ReturnType<typeof authorizedReady>) => void; fixture?: Parameters<typeof authorizedReady>[0]; now?: number; ledger?: null; alive?: number[] }> = [
    { name: "the frozen grant holds, but control and mailbox are separate stores: no effect observer can land the result", reason: "capability_unavailable" },
    { name: "Work declares a retry/cost budget this path cannot measure", reason: "capability_unavailable",
      fixture: { shared: true, contract: contractWith({ budget: { retry_limit: 2 } }) } },
    { name: "Work contract revised after ready", reason: "stale_contract",
      setup: (s) => { reviseContract(s.control, s.work.work_id, 1, contractWith({ objective: "ship v2" }), "scope change", T + 5500); } },
    { name: "decision owner changed after ready", reason: "stale_contract",
      setup: (s) => { reviseContract(s.control, s.work.work_id, 1, contractWith({ decision_owner: "someone-else" }), "handoff", T + 5500); } },
    { name: "Attention revised after the grant", reason: "stale_target",
      setup: (s) => { const { revision, created_at: _c, updated_at: _u, defer_until: _d, acknowledged_at: _a, ...rest } = getAttention(s.control, "item-1")!;
        upsertAttention(s.control, { ...rest, conclusion: "changed", expected_revision: revision }, T + 5500); } },
    { name: "observed evidence contradicts the ready fingerprint", reason: "stale_evidence",
      setup: (s) => { s.control.run("UPDATE control_waits SET observed_fingerprint='pr:CLOSED' WHERE wait_id=?", [s.wait.wait_id]); } },
    { name: "Work deadline budget exhausted", reason: "budget_exhausted", fixture: { contract: contractWith({ budget: { deadline_at: T + 10 * MIN } }) }, now: T + 10 * MIN },
    { name: "approved effect is human-only in the Contract", reason: "permission_denied", fixture: { contract: contractWith({ scope: { human_only_effects: ["resume_checkpoint"] } }) } },
    { name: "approved effect is outside the Contract allowed effects", reason: "permission_denied", fixture: { contract: contractWith({ scope: { repo: "acme/app", allowed_effects: ["write"] } }) } },
    { name: "mailbox target is human-only", reason: "permission_denied", setup: (s) => { reregister(s, { decisionMode: "human_only" }); } },
    { name: "grant expired", reason: "approval_expired", now: T + 60 * MIN },
    { name: "mailbox target version replaced before claim", reason: "stale_target", setup: (s) => { reregister(s, { targetVersion: "tv-2" }); } },
    { name: "mailbox receipt consumed before claim", reason: "approval_consumed",
      setup: (s) => { s.mailbox.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,answer,actor,consumed_at) VALUES ('r1','orchestrator','ap-1',?,'approve','owner',?)", [s.targetVersion, T + 5500]); } },
    { name: "mailbox target revoked before claim", reason: "stale_target", setup: (s) => { expect(cancelTarget(s.mailbox, "orchestrator", "ap-1", s.targetVersion)).toBe(true); } },
    { name: "the target is not a pinned resume grant (plain resume target)", reason: "permission_denied",
      setup: (s) => { reregister(s, { scope: { attempt_id: "att-1" } }); } },
    { name: "the grant was pinned for another post-condition", reason: "permission_denied",
      setup: (s) => { const scope = getTarget(s.mailbox, "orchestrator", "ap-1")!.scope as { resume_grant: ResumeGrantScope };
        reregister(s, { scope: { resume_grant: { ...scope.resume_grant, condition: { kind: "github_pr_merged", source: { ...SOURCE, number: 8 } } } } }); } },
    { name: "the decision owner's approval was withdrawn", reason: "permission_denied", setup: (s) => { s.mailbox.run("DELETE FROM answers WHERE approval_id='ap-1'"); } },
    { name: "the approval was recorded by someone other than the decision owner", reason: "permission_denied",
      setup: (s) => { s.mailbox.run("UPDATE answers SET actor='intruder' WHERE approval_id='ap-1'"); } },
    { name: "the authorization's checkpoint reference is not the pinned one", reason: "stale_target", fixture: { grant: { checkpoint_reference: "checkpoint:other" } } },
    { name: "an earlier effect of this approval is unknown", reason: "effect_unknown",
      setup: (s) => {
        s.mailbox.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,answer,actor,consumed_at) VALUES ('r0','orchestrator','ap-1','tv-0','approve','owner',?)", [T]);
        s.mailbox.run("INSERT INTO receipt_effect_observations(receipt_id,tool_call_id,state,evidence,observed_at) VALUES ('r0','tc-0','unknown','{}',?)", [T]);
      } },
    { name: "service actor is not the granted execution owner", reason: "execution_owner_mismatch", fixture: { grant: { execution_owner: "runner" } } },
    { name: "session process is alive", reason: "process_alive", fixture: { session: { pid: PID } }, alive: [PID] },
    { name: "session has no termination evidence (dead pid, no session_ended)", reason: "liveness_unknown", fixture: { session: { pid: PID } } },
    { name: "ledger unavailable", reason: "liveness_unknown", ledger: null },
    { name: "remote session", reason: "runtime_unsupported", fixture: { session: { host: "devbox", pid: PID, ended: true } } },
    { name: "orchestrator-owned session", reason: "runtime_unsupported", fixture: { session: { origin: "orch:task:t1:a1", pid: PID, ended: true } } },
    { name: "unsupported runtime", reason: "runtime_unsupported", fixture: { session: { runtime: "claude", pid: PID, ended: true } } },
    { name: "stale checkpoint: the session file was appended after the grant", reason: "checkpoint_invalid",
      setup: (s) => { appendFileSync(s.file, `${JSON.stringify({ type: "message", id: "e2" })}\n`); } },
    { name: "stale checkpoint: the session file is gone", reason: "checkpoint_invalid", setup: (s) => { rmSync(s.file); } },
    { name: "stale checkpoint: the session tail is truncated", reason: "checkpoint_invalid", setup: (s) => { appendFileSync(s.file, `{"type":"message","id":"e2"`); } },
  ];
  for (const c of cases) {
    test(`authorized ready wait blocks → re-decision: ${c.name}`, async () => {
      const s = authorizedReady(c.fixture);
      c.setup?.(s);
      const now = c.now ?? NOW;
      const ledger = c.ledger === null ? null : s.ledger;
      const alive = probe(c.alive ?? []);
      const receiptsBefore = receipts(s.mailbox);
      const targetBefore = s.mailbox.query("SELECT target_version,state,consumed_at FROM approval_targets WHERE approval_id='ap-1'").get();
      const executed: string[][] = [];
      const executor: ResumeExecutor = async (_command, args) => { executed.push(args); return { ok: true }; };
      expect(revalidateReadyWait(s.control, s.mailbox, ledger, s.wait, { ...SERVER, now }, alive, s.checkpointProbe)).toEqual({ kind: "blocked", reason: c.reason });
      const before = getAttention(s.control, "item-1")!;
      const outcome = await processWaitDisposition({ control: s.control, mailbox: s.mailbox, ledger, actor: "maintenance", now: () => now, signal: new AbortController().signal,
        processAlive: alive, checkpointProbe: s.checkpointProbe, executor }, s.wait);
      expect(outcome).toMatchObject({ kind: "redecision_recorded", disposition: { kind: "blocked", reason: c.reason } });
      expect(outcome.wait).toMatchObject({ disposition_state: "redecision_recorded", disposition_claim_id: null, dispatch_id: null });
      expect(outcome.wait.disposition_detail).toMatchObject({ blocked_reason: c.reason, redecision: { from: "pending", attention_revision: before.revision + 1 } });
      expect(outboxKinds(s.control, s.wait.wait_id)).toEqual(["wait.created", "wait.ready", "wait.disposition_blocked", "wait.disposition_redecision"]);
      expect(getAttention(s.control, "item-1")).toMatchObject({ revision: before.revision + 1, state: "open" });
      // No consumption, no claim, no process: the mailbox is exactly as the revalidation found it.
      expect(receipts(s.mailbox)).toBe(receiptsBefore);
      expect(s.mailbox.query("SELECT target_version,state,consumed_at FROM approval_targets WHERE approval_id='ap-1'").get()).toEqual(targetBefore);
      expect(executed).toEqual([]);
    });
  }

  test("each check re-reads the explicit mailbox DB; stale consent cannot move to a new wait", async () => {
    const s = authorizedReady({ shared: true });
    const check = () => revalidateReadyWait(s.control, s.mailbox, s.ledger, s.wait, { ...SERVER, now: NOW }, probe([]), s.checkpointProbe);
    expect(check()).toMatchObject({ kind: "resume_checkpoint", stable_id: STABLE_ID, approval_id: "ap-1" });
    s.mailbox.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,answer,actor,consumed_at) VALUES ('r1','orchestrator','ap-1',?,'approve','owner',?)", [s.targetVersion, NOW]);
    expect(check()).toEqual({ kind: "blocked", reason: "approval_consumed" });
    await processWaitDisposition({ control: s.control, mailbox: s.mailbox, ledger: s.ledger, actor: "maintenance", now: () => NOW, signal: new AbortController().signal,
      processAlive: probe([]), checkpointProbe: s.checkpointProbe }, s.wait);
    // The redecision advanced the Attention revision, so the old consent no longer binds a new wait.
    expect(() => makeWait(s.control, s.work.work_id, "item-1", "owner", NOW + 1000, s.disposition)).toThrow(/authorization scope does not match/);
  });

  test("revalidation rejects client identity, stale wait objects and unsettled waits", () => {
    const s = authorizedReady();
    const context = { actor: "maintenance", actor_source: "client", now: NOW } as unknown as Parameters<typeof revalidateReadyWait>[4];
    expect(() => revalidateReadyWait(s.control, s.mailbox, s.ledger, s.wait, context)).toThrow(ControlError);
    const stale = { ...s.wait, version: s.wait.version - 1 };
    expect(() => revalidateReadyWait(s.control, s.mailbox, s.ledger, stale, { ...SERVER, now: NOW })).toThrow(/stale wait version/);
    const fresh = stores();
    const watching = makeWait(fresh.control, fresh.work.work_id, "item-1", "owner", T + 2000);
    expect(() => revalidateReadyWait(fresh.control, fresh.mailbox, fresh.ledger, watching, { ...SERVER, now: NOW })).toThrow(/wait disposition is not started/);
  });

  test("processWaitDisposition is at-most-once and never writes after abort", async () => {
    const s = authorizedReady();
    const aborted = new AbortController(); aborted.abort();
    const deps = { control: s.control, mailbox: s.mailbox, ledger: s.ledger, actor: "maintenance", now: () => NOW, processAlive: probe([]), checkpointProbe: s.checkpointProbe };
    expect(await processWaitDisposition({ ...deps, signal: aborted.signal }, s.wait)).toMatchObject({ kind: "skipped", reason: "aborted" });
    expect(getConditionWait(s.control, s.wait.wait_id)).toMatchObject({ version: s.wait.version, disposition_state: "pending" });
    const first = await processWaitDisposition({ ...deps, signal: new AbortController().signal }, s.wait);
    expect(first.kind).toBe("redecision_recorded");
    await expect(processWaitDisposition({ ...deps, signal: new AbortController().signal }, s.wait)).rejects.toThrow(/stale wait version/);
    expect(await processWaitDisposition({ ...deps, signal: new AbortController().signal }, first.wait)).toMatchObject({ kind: "skipped", reason: "not_pending" });
    expect(outboxKinds(s.control, s.wait.wait_id).filter((kind) => kind === "wait.disposition_redecision")).toHaveLength(1);
  });
});

/** Real AdapterService on the daemon's shared control+mailbox file; the fake runtime only counts calls. */
function adapterHarness() {
  const dir = mkdtempSync(join(tmpdir(), "waits-recovery-adapter-")); dirs.push(dir);
  const path = join(dir, "answers.db");
  const db = openMailbox(path);
  const calls = { start: 0, connect: 0, answers: [] as Array<[string, string]>, submitted: [] as string[] };
  const handles = new Map<string, SessionHandle>();
  const runtime: AgentRuntime = {
    kind: "pi",
    capabilities: { restore: false, answer: true, steer: false },
    async start(request) {
      calls.start++;
      const handle: SessionHandle = {
        reference: { ...request, runtimeKind: "pi" },
        events: { async *[Symbol.asyncIterator]() { await Promise.withResolvers<void>().promise; } },
        async submit(turn) { calls.submitted.push(turn.turnId); return { state: "accepted", commandId: turn.turnId }; },
        async cancel(id) { return { state: "rejected", commandId: id }; },
        async answer(requestId, value) { calls.answers.push([requestId, value]); return { state: "accepted", commandId: requestId }; },
        async close() {},
      };
      handles.set(request.sessionId, handle);
      return handle;
    },
    async connect(reference) {
      calls.connect++;
      const handle = handles.get(reference.sessionId);
      if (!handle) throw new Error("not owned");
      return handle;
    },
  };
  const channel: ChannelAdapter = { kind: "test", instanceId: "channel-one", capabilities: { update: true, actions: true },
    async start() {}, async stop() {}, async send(message) { return { state: "sent", messageId: message.replaceMessageId ?? "message-1" }; } };
  const service = new AdapterService(db, { runtime, channels: [channel], cwd: dir, authorize: (identity) => (identity.userId === "owner" ? "operator" : null) });
  return { path, db, service, calls };
}

/** Drives a real adapter turn into a native blocked ask; control and mailbox are separate connections to the daemon's store file. */
async function blockedAdapterAsk(h: ReturnType<typeof adapterHarness>) {
  const control = new Database(h.path);
  const mailbox = openMailbox(h.path);
  await h.service.start();
  await h.service.accept({ kind: "message", eventId: "m1", identity: { instanceId: "channel-one", tenantId: "tenant", userId: "owner" },
    address: { instanceId: "channel-one", tenantId: "tenant", chatId: "chat" }, messageId: "m1", text: "do it", receivedAt: Date.now() });
  await h.service.tick();
  const conversation = h.db.query("SELECT id,session_reference FROM conversations").get() as { id: string; session_reference: string };
  const reference = JSON.parse(conversation.session_reference) as SessionReference;
  h.service.recordRuntimeEvent(conversation.id, { eventId: "blocked", sessionId: reference.sessionId, turnId: h.calls.submitted[0], kind: "blocked",
    requestId: "q", requestMethod: "confirm", options: ["yes", "no"], text: "Proceed?" });
  await h.service.tick();
  const itemId = `runtime:${reference.sessionId}:q`;
  const item = getAttention(control, itemId)!;
  const owner = getWork(control, item.work_id)!.contract!.decision_owner;
  return { control, mailbox, itemId, item, owner };
}

describe("B07 live blocked ask: existing answer consumer or jump, never a second process", () => {
  test("adapter-owned blocked ask is answerable only through mailbox → AdapterService → SessionHandle.answer", async () => {
    const h = adapterHarness();
    const { control, mailbox, itemId, item, owner } = await blockedAdapterAsk(h);
    try {
      const created = Date.now();
      const wait = makeReady(control, makeWait(control, item.work_id, itemId, owner, created), created + 1);
      expect(inspectWaitRecovery(control, mailbox, null, wait, { now: Date.now() })).toEqual({ state: "available", action: "answer_live_request" });

      const landed = await processWaitDisposition({ control, mailbox, ledger: null, actor: "maintenance", now: () => Date.now() + 2, signal: new AbortController().signal }, wait);
      expect(landed).toMatchObject({ kind: "redecision_recorded", disposition: { kind: "redecide" } });
      expect(getAttention(control, itemId)).toMatchObject({ state: "open", revision: item.revision + 1 });
      expect(h.calls.answers).toEqual([]);

      // The ownership lease is the durable proof of the live consumer; without it the ask is unknown, not answerable.
      mailbox.run("UPDATE runtime_ownership SET expires_at=0");
      expect(inspectWaitRecovery(control, mailbox, null, wait, { now: Date.now() })).toEqual({ state: "unknown", reason: "consumer_unavailable", jump_url: null });
      await h.service.tick();
      expect(inspectWaitRecovery(control, mailbox, null, wait, { now: Date.now() })).toEqual({ state: "available", action: "answer_live_request" });

      expect(writeHumanAnswer(mailbox, "extension", itemId, "yes", owner)).toEqual({ ok: true });
      await h.service.tick();
      expect(h.calls.answers).toEqual([["q", "yes"]]);
      expect({ start: h.calls.start, connect: h.calls.connect }).toEqual({ start: 1, connect: 0 });
      expect(inspectWaitRecovery(control, mailbox, null, wait, { now: Date.now() })).toEqual({ state: "unknown", reason: "request_not_pending", jump_url: null });
    } finally {
      await h.service.stop();
      control.close(); mailbox.close(); h.db.close();
    }
  });

  test("a pre-authorized answer_blocked_request over a live adapter ask is denied: native asks are human-only; no answer, receipt or process", async () => {
    const h = adapterHarness();
    const { control, mailbox, itemId, item, owner } = await blockedAdapterAsk(h);
    try {
      const target = getTarget(mailbox, "extension", itemId)!;
      const created = Date.now();
      const authorized = grant(item.revision, { consumer_owner: "extension", approval_id: itemId, target_version: target.targetVersion,
        approved_effect: "answer_blocked_request", work_revision: item.contract_revision, attempt_id: target.attemptId, expires_at: target.expiresAt });
      const wait = makeReady(control, makeWait(control, item.work_id, itemId, owner, created, authorized), created + 1);
      // AdapterService registers native asks with effect 'runtime-native-answer' and decision_mode 'human_only'.
      expect(target).toMatchObject({ effect: "runtime-native-answer", decisionMode: "human_only" });
      expect(revalidateReadyWait(control, mailbox, null, wait, { ...SERVER, now: created + 2 })).toEqual({ kind: "blocked", reason: "permission_denied" });
      const landed = await processWaitDisposition({ control, mailbox, ledger: null, actor: "maintenance", now: () => created + 2, signal: new AbortController().signal }, wait);
      expect(landed).toMatchObject({ kind: "redecision_recorded", disposition: { kind: "blocked", reason: "permission_denied" } });
      await h.service.tick();
      expect(h.calls.answers).toEqual([]);
      expect(receipts(mailbox)).toBe(0);
      expect({ start: h.calls.start, connect: h.calls.connect }).toEqual({ start: 1, connect: 0 });
      // The human can still answer the same live ask through the existing consumer.
      expect(inspectWaitRecovery(control, mailbox, null, wait, { now: Date.now() })).toEqual({ state: "available", action: "answer_live_request" });
    } finally {
      await h.service.stop();
      control.close(); mailbox.close(); h.db.close();
    }
  });

  test("ordinary ledger Q1 without an adapter consumer offers only the request jump", async () => {
    const s = stores({ consumer: "extension" });
    registerTarget(s.mailbox, { consumerOwner: "extension", approvalId: "ap-1", stableId: STABLE_ID, requestUid: "req-1", question: "ok?", options: ["approve", "deny"],
      effect: "gated_tool", scope: {}, evidence: {}, expiresAt: T + DAY });
    seedSession(s.ledger, { pid: PID, requestUid: "req-1" });
    const wait = makeReady(s.control, makeWait(s.control, s.work.work_id, s.item.item_id, "owner", T + 1000), T + 5000);
    expect(inspectWaitRecovery(s.control, s.mailbox, s.ledger, wait, { now: T + 6000, processAlive: probe([PID]) }))
      .toEqual({ state: "unknown", reason: "answer_consumer_unverified", jump_url: "/api/jump/req-1" });
    const outcome = await processWaitDisposition({ control: s.control, mailbox: s.mailbox, ledger: s.ledger, actor: "maintenance", now: () => T + 6000, signal: new AbortController().signal, processAlive: probe([PID]) }, wait);
    expect(outcome).toMatchObject({ kind: "redecision_recorded", disposition: { kind: "redecide" } });
    expect(receipts(s.mailbox)).toBe(0);
  });

  test("a live session that is not blocked on the request is shown with a session jump, never resumed", () => {
    const s = stores();
    resumeTarget(s.mailbox, s.work.work_id);
    seedSession(s.ledger, { pid: PID });
    const wait = makeWait(s.control, s.work.work_id, s.item.item_id, "owner", T + 1000);
    expect(inspectWaitRecovery(s.control, s.mailbox, s.ledger, wait, { now: T + 2000, processAlive: probe([PID]) }))
      .toEqual({ state: "unsupported", reason: "process_alive", jump_url: `/api/jump-session/${encodeURIComponent(STABLE_ID)}` });
  });
});

describe("B08/B09 recovery capability: a wait card never offers manual Resume; unsupported and unknown stay explicit", () => {
  const jump = `/api/jump-session/${encodeURIComponent(STABLE_ID)}`;
  const cases: Array<{ name: string; session?: Parameters<typeof seedSession>[1] | null; alive?: number[]; ledger?: null; approval?: false; noFile?: true; resumable?: true; expected: unknown }> = [
    { name: "B08: a resumable terminated local pi session resumes only through a grant pinned before the wait", session: { pid: PID, ended: true }, resumable: true,
      expected: { state: "unsupported", reason: "resume_requires_prior_grant", jump_url: jump } },
    { name: "checkpoint unknown: the recorded runtime session has no session file", session: { pid: PID, ended: true }, noFile: true,
      expected: { state: "unknown", reason: "no_session_file", jump_url: jump } },
    { name: "liveness unknown: dead pid without session_ended", session: { pid: PID }, expected: { state: "unknown", reason: "liveness_unknown", jump_url: jump } },
    { name: "liveness unknown: no incarnation recorded", session: {}, expected: { state: "unknown", reason: "liveness_unknown", jump_url: jump } },
    { name: "liveness unknown: pid still visible after session_ended", session: { pid: PID, ended: true }, alive: [PID],
      expected: { state: "unknown", reason: "liveness_unknown", jump_url: jump } },
    { name: "runtime unsupported", session: { runtime: "claude", pid: PID, ended: true }, expected: { state: "unsupported", reason: "runtime_unsupported", jump_url: jump } },
    { name: "remote session", session: { host: "devbox", pid: PID, ended: true }, expected: { state: "unsupported", reason: "remote_host_unsupported", jump_url: jump } },
    { name: "orchestrator-owned session", session: { origin: "orch:task:t1:a1", pid: PID, ended: true }, expected: { state: "unsupported", reason: "orchestrator_owned", jump_url: jump } },
    { name: "session missing from the ledger", session: null, expected: { state: "unknown", reason: "session_not_found", jump_url: null } },
    { name: "ledger unavailable", ledger: null, expected: { state: "unknown", reason: "ledger_unavailable", jump_url: null } },
    { name: "Attention has no session link", approval: false, expected: { state: "unsupported", reason: "no_session_link", jump_url: null } },
  ];
  for (const c of cases) {
    test(c.name, () => {
      const s = stores({ approval: c.approval });
      if (c.approval !== false) resumeTarget(s.mailbox, s.work.work_id);
      if (c.session !== null) seedSession(s.ledger, c.session ?? {});
      if (c.noFile) rmSync(s.file);
      const wait = makeWait(s.control, s.work.work_id, s.item.item_id, "owner", T + 1000, c.approval === false ? undefined : grant(s.item.revision));
      expect(inspectWaitRecovery(s.control, s.mailbox, c.ledger === null ? null : s.ledger, wait,
        { now: T + 2000, processAlive: probe(c.alive ?? []), checkpointProbe: s.checkpointProbe })).toEqual(c.expected as never);
    });
  }

  test("B09: generic Sessions Resume reads the same gate as wait recovery — same class and reason, executor never called", async () => {
    for (const c of cases.filter((row) => row.session && row.ledger !== null && row.approval !== false && !row.resumable)) {
      const s = stores();
      resumeTarget(s.mailbox, s.work.work_id);
      seedSession(s.ledger, c.session!);
      if (c.noFile) rmSync(s.file);
      const wait = makeWait(s.control, s.work.work_id, s.item.item_id, "owner", T + 1000, grant(s.item.revision));
      const processAlive = probe(c.alive ?? []);
      const recovery = inspectWaitRecovery(s.control, s.mailbox, s.ledger, wait, { now: T + 2000, processAlive, checkpointProbe: s.checkpointProbe });
      if (recovery.state === "available") throw new Error(`${c.name}: a wait card offered ${recovery.action}`);
      const calls: string[][] = [];
      expect(inspectResume(s.ledger, STABLE_ID, processAlive, s.checkpointProbe)).toEqual({ resumable: false, state: recovery.state, reason: recovery.reason } as never);
      expect(await resumeSession(s.ledger, STABLE_ID, { db: s.control, now: () => T + 2000 }, async (_command, args) => { calls.push(args); return { ok: true }; }, processAlive, s.checkpointProbe))
        .toEqual({ resumed: false, reason: recovery.reason });
      expect(calls).toEqual([]);
    }
  });
});

/** Stub source adapters: recovery never observes a source, it only acts on waits that are already ready. */
const unusedAdapters = (establish?: () => WaitBaselineSnapshot<PrBaseline>) => Object.fromEntries((["github_pr_merged", "check_new_result", "work_completed"] as const)
  .map((kind) => [kind, { kind, establishBaseline: async () => { if (!establish) throw new Error(`unused ${kind}`); return establish(); },
    observe: async () => { throw new Error(`unused ${kind}`); } }])) as unknown as WaitSourceAdapters; // test stub: only `kind` and the PR baseline are exercised
const outboxCount = (control: Database, waitId: string, kind: string) =>
  (control.query("SELECT COUNT(*) n FROM control_outbox WHERE entity_id=? AND kind=?").get(waitId, kind) as { n: number }).n;
const sessionStarted = (ledger: Database, at: number, writer = "writer-2", stableId = STABLE_ID) =>
  ledger.run("INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind) VALUES('local',?,?,?,?,?, 'session_started')", [writer, at, at, stableId, writer]);
const grow = (file: string) => appendFileSync(file, `${JSON.stringify({ type: "message", id: "resumed" })}\n`);

describe("B08 authorized resume: frozen grant binding, single dispatch, bound effect", () => {
  const NOW = T + 6000;
  /** Production layout: control and mailbox share the answers DB, so the effect observer is registered. */
  function launched() {
    const s = authorizedReady({ shared: true });
    const calls: string[][] = [];
    const executor: ResumeExecutor = async (_command, args) => { calls.push(args); return { ok: true }; };
    const deps = { control: s.control, mailbox: s.mailbox, ledger: s.ledger, actor: "maintenance", now: () => NOW, signal: new AbortController().signal,
      processAlive: probe([]), checkpointProbe: s.checkpointProbe, executor };
    return { ...s, calls, executor, deps };
  }
  const effectDeps = (s: ReturnType<typeof launched>, at: number) =>
    ({ control: s.control, mailbox: s.mailbox, ledger: s.ledger, now: () => at, signal: new AbortController().signal, checkpointProbe: s.checkpointProbe });

  test("grant creation pins the probed checkpoint scope and the owner's approval; createWait accepts exactly that binding", async () => {
    const s = stores({ shared: true });
    seedSession(s.ledger, { pid: PID, ended: true });
    const request = { work_id: s.work.work_id, item_id: s.item.item_id, condition: CONDITION, stable_id: STABLE_ID, attempt_id: "att-1",
      execution_owner: "maintenance", expires_at: T + 60 * MIN };
    const context = { actor: "owner", actor_source: "server" as const, now: T, processAlive: probe([]), checkpointProbe: s.checkpointProbe };
    expect(() => createResumeGrant(s.control, s.mailbox, s.ledger, request, { ...context, actor_source: "client" as never })).toThrow(/server-bound actor/);
    expect(() => createResumeGrant(s.control, s.mailbox, s.ledger, request, { ...context, processAlive: probe([PID]) })).toThrow(/checkpoint_unavailable: liveness_unknown/);

    const disposition = createResumeGrant(s.control, s.mailbox, s.ledger, request, context);
    const target = getTarget(s.mailbox, "orchestrator", "ap-1")!;
    const scope = (target.scope as { resume_grant: ResumeGrantScope }).resume_grant;
    const size = readFileSync(s.file).byteLength;
    expect(scope).toEqual({
      stable_id: STABLE_ID, runtime: "pi", session: RUNTIME_SESSION, cwd: "/repo", file: s.file, last_entry_id: "e1", byte_len: size,
      attention_revision: s.item.revision, expires_at: T + 60 * MIN, item_id: "item-1", execution_owner: "maintenance",
      condition: { kind: "github_pr_merged", source: { ...SOURCE } },
    });
    expect(target).toMatchObject({ effect: "resume_checkpoint", state: "active", stableId: STABLE_ID, workId: s.work.work_id, contractRevision: 1, attemptId: "att-1" });
    expect(disposition.authorization).toEqual({
      consumer_owner: "orchestrator", approval_id: "ap-1", target_version: target.targetVersion, approved_effect: "resume_checkpoint",
      work_revision: 1, attention_revision: s.item.revision, attempt_id: "att-1", checkpoint_reference: checkpointReference(scope),
      execution_owner: "maintenance", expires_at: T + 60 * MIN,
    });
    expect(s.mailbox.query("SELECT answer,actor FROM answers WHERE approval_id='ap-1'").get()).toEqual({ answer: "approve", actor: "owner" });
    expect(receipts(s.mailbox)).toBe(0);

    const create = (grant: CreateWaitInput["disposition"]) => createWait(s.control, { work_id: s.work.work_id, item_id: s.item.item_id, condition: CONDITION,
      deadline_at: T + DAY, disposition: grant }, { actor: "owner", adapters: unusedAdapters(() => baseline(T + 900)), mailbox: s.mailbox, now: () => T + 1000,
      signal: new AbortController().signal });
    // Any field that differs from the pinned scope is refused before a wait exists.
    await expect(create({ ...disposition, authorization: { ...disposition.authorization, checkpoint_reference: "checkpoint:other" } })).rejects.toThrow(/invalid authorization: the checkpoint reference/);
    await expect(create({ ...disposition, authorization: { ...disposition.authorization, execution_owner: "runner" } })).rejects.toThrow(/invalid authorization: the execution owner/);
    const wait = await create(disposition);
    expect(wait).toMatchObject({ disposition: "authorized_resume", resume_grant: disposition.authorization, state: "watching" });

    // A plain resume target (no pinned grant scope) never authorizes a wait.
    const other = stores({ shared: true });
    resumeTarget(other.mailbox, other.work.work_id);
    await expect(createWait(other.control, { work_id: other.work.work_id, item_id: other.item.item_id, condition: CONDITION, deadline_at: T + DAY,
      disposition: grant(other.item.revision) }, { actor: "owner", adapters: unusedAdapters(() => baseline(T + 900)), mailbox: other.mailbox,
      now: () => T + 1000, signal: new AbortController().signal })).rejects.toThrow(/invalid authorization: the approval does not pin a resume checkpoint/);
  });

  test("createResumeGrant refuses a session without an intact runtime checkpoint", () => {
    const s = stores({ shared: true });
    seedSession(s.ledger, { pid: PID, ended: true });
    rmSync(s.file);
    expect(() => createResumeGrant(s.control, s.mailbox, s.ledger, { work_id: s.work.work_id, item_id: s.item.item_id, condition: CONDITION,
      stable_id: STABLE_ID, attempt_id: "att-1", execution_owner: "maintenance", expires_at: T + 60 * MIN },
    { actor: "owner", actor_source: "server", now: T, processAlive: probe([]), checkpointProbe: s.checkpointProbe })).toThrow(/checkpoint_unavailable: no_session_file/);
    expect(getTarget(s.mailbox, "orchestrator", "ap-1")).toBeNull();
  });

  test("a verified grant dispatches once: claim, consume, re-probe, one background launch; accepted is only applying", async () => {
    const s = launched();
    expect(revalidateReadyWait(s.control, s.mailbox, s.ledger, s.wait, { ...SERVER, now: NOW }, probe([]), s.checkpointProbe)).toEqual({
      kind: "resume_checkpoint", stable_id: STABLE_ID, runtime: "pi", checkpoint_reference: s.disposition!.kind === "authorized_resume" ? s.disposition!.authorization.checkpoint_reference : "",
      approval_id: "ap-1", target_version: s.targetVersion,
    });
    const outcome = await processWaitDisposition(s.deps, s.wait);
    expect(outcome).toMatchObject({ kind: "dispatch_recorded", dispatch: { state: "accepted", accepted_at: NOW } });
    expect(s.calls).toEqual([["new-workspace", "--cwd", "/repo", "--command", `'pi' '--session' '${s.file}'`, "--focus", "false"]]);
    expect(outcome.wait).toMatchObject({ disposition_state: "dispatched", version: s.wait.version + 2 });
    expect(getAttention(s.control, "item-1")).toMatchObject({ state: "applying", effect_state: "applying" });
    expect(getTarget(s.mailbox, "orchestrator", "ap-1")?.state).toBe("consumed");
    expect(s.mailbox.query("SELECT answer,actor FROM decision_receipts WHERE approval_id='ap-1'").all()).toEqual([{ answer: "approve", actor: "owner" }]);
    expect(outboxKinds(s.control, s.wait.wait_id).filter((kind) => kind.startsWith("wait.disposition"))).toEqual(["wait.disposition_claimed", "wait.disposition_dispatched"]);
    expect(listRecoveriesInFlight(s.control, 10).map((wait) => wait.wait_id)).toEqual([s.wait.wait_id]);
  });

  test("stale checkpoint at dispatch: the re-probe differs from the grant, so the executor is never called", async () => {
    const s = launched();
    let probes = 0;
    const racing: CheckpointProbe = (input) => {
      // The session file changes between revalidation (probe 1) and the dispatch re-probe (probe 2).
      if (++probes === 2) grow(s.file);
      return s.checkpointProbe(input);
    };
    const outcome = await processWaitDisposition({ ...s.deps, checkpointProbe: racing }, s.wait);
    expect(probes).toBe(2);
    expect(outcome).toMatchObject({ kind: "dispatch_recorded", dispatch: { state: "rejected", reason: expect.stringMatching(/^checkpoint_invalid/) } });
    expect(s.calls).toEqual([]);
    expect(outcome.wait).toMatchObject({ disposition_state: "redecision_recorded" });
    expect(getAttention(s.control, "item-1")).toMatchObject({ state: "open" });
    // The consumed approval records that nothing was launched; it can never be consumed again.
    expect(s.mailbox.query("SELECT state,evidence FROM receipt_effect_observations").all()).toEqual([
      { state: "failed", evidence: expect.stringContaining('"executed":false') }]);
    expect(consumeDecision(s.mailbox, { consumerOwner: "orchestrator", approvalId: "ap-1", targetVersion: s.targetVersion, policyHash: "p", now: NOW,
      liveValid: () => true, policyValid: () => true })).toBeNull();
  });

  test("duplicate and replayed dispatch consume the grant once (in-process CAS)", async () => {
    const s = launched();
    // Both contenders pass revalidation on the same wait version; only one CAS claim and one mailbox consumption can win.
    const second = { control: new Database(s.mailboxPath), mailbox: openMailbox(s.mailboxPath) };
    second.control.exec("PRAGMA busy_timeout=5000");
    const settled = await Promise.allSettled([processWaitDisposition(s.deps, s.wait), processWaitDisposition({ ...s.deps, ...second }, s.wait)]);
    expect(settled.map((entry) => entry.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lost = settled.find((entry) => entry.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ControlError);
    expect((lost.reason as ControlError).code).toBe("conflict");
    expect(s.calls).toHaveLength(1);
    expect(receipts(s.mailbox)).toBe(1);
    expect(outboxCount(s.control, s.wait.wait_id, "wait.disposition_claimed")).toBe(1);
    // Replays: the stale snapshot is refused, the current row is no longer pending, the approval is spent.
    await expect(processWaitDisposition(s.deps, s.wait)).rejects.toThrow(/stale wait version/);
    const current = getConditionWait(s.control, s.wait.wait_id)!;
    expect(await processWaitDisposition(s.deps, current)).toMatchObject({ kind: "skipped", reason: "not_pending" });
    expect(s.calls).toHaveLength(1);
    second.control.close(); second.mailbox.close();
  });

  test("one consumption under concurrency: two separate processes race the same ready wait", async () => {
    const s = launched();
    const callsFile = join(s.dir, "executor-calls.log");
    const modules = { store: join(import.meta.dir, "../control/store.ts"), mailbox: join(import.meta.dir, "../decision-bot/mailbox.ts"),
      checkpoint: join(import.meta.dir, "../shared/checkpoint.ts"), recovery: join(import.meta.dir, "recovery.ts") };
    const worker = `
      import { Database } from "bun:sqlite";
      import { appendFileSync, existsSync, writeFileSync } from "node:fs";
      const cfg = JSON.parse(process.env.RECOVERY_WORKER);
      const { getConditionWait } = await import(cfg.modules.store);
      const { openMailbox } = await import(cfg.modules.mailbox);
      const { probeCheckpoint } = await import(cfg.modules.checkpoint);
      const { processWaitDisposition } = await import(cfg.modules.recovery);
      const control = new Database(cfg.mailboxPath); control.exec("PRAGMA busy_timeout=5000");
      const mailbox = openMailbox(cfg.mailboxPath);
      const ledger = new Database(cfg.ledgerPath, { readonly: true });
      const wait = getConditionWait(control, cfg.waitId);
      writeFileSync(cfg.dir + "/ready-" + cfg.id, "");
      while (!existsSync(cfg.dir + "/go")) await Bun.sleep(1);
      try {
        const outcome = await processWaitDisposition({ control, mailbox, ledger, actor: "maintenance", now: () => cfg.now, signal: new AbortController().signal,
          processAlive: () => false, checkpointProbe: (input) => probeCheckpoint(input, { sessionRoots: cfg.roots }),
          executor: async (_command, args) => { appendFileSync(cfg.callsFile, JSON.stringify(args) + "\\n"); return { ok: true }; } }, wait);
        console.log(JSON.stringify({ kind: outcome.kind, dispatch: outcome.dispatch?.state ?? null }));
      } catch (error) { console.log(JSON.stringify({ error: error.code ?? "error", message: error.message })); }
    `;
    const spawn = (id: number) => Bun.spawn(["bun", "-e", worker], { stdout: "pipe", stderr: "pipe", env: { ...process.env, RECOVERY_WORKER: JSON.stringify({
      id, modules, dir: s.dir, mailboxPath: s.mailboxPath, ledgerPath: s.ledgerPath, waitId: s.wait.wait_id, now: NOW, roots: s.roots, callsFile }) } });
    const procs = [spawn(1), spawn(2)];
    const ready = async () => { while (!(await Bun.file(join(s.dir, "ready-1")).exists() && await Bun.file(join(s.dir, "ready-2")).exists())) await Bun.sleep(2); };
    await ready();
    writeFileSync(join(s.dir, "go"), "");
    await Promise.all(procs.map((proc) => proc.exited));
    const results = await Promise.all(procs.map(async (proc) => JSON.parse((await new Response(proc.stdout).text()).trim()) as Record<string, unknown>));
    expect(results.filter((result) => result.kind === "dispatch_recorded")).toEqual([{ kind: "dispatch_recorded", dispatch: "accepted" }]);
    expect(results.filter((result) => result.error === "conflict")).toHaveLength(1);
    expect(readFileSync(callsFile, "utf8").trim().split("\n")).toHaveLength(1);
    expect(receipts(s.mailbox)).toBe(1);
    expect(outboxCount(s.control, s.wait.wait_id, "wait.disposition_claimed")).toBe(1);
    expect(getConditionWait(s.control, s.wait.wait_id)).toMatchObject({ disposition_state: "dispatched" });
  });

  test("effect succeeded only with a new session_started for the same runtime session AND growth of the granted file", async () => {
    const s = launched();
    const pinnedSize = readFileSync(s.file).byteLength;
    sessionStarted(s.ledger, T + 100, "writer-0"); // the original start, before dispatch: not new
    let wait = (await processWaitDisposition(s.deps, s.wait)).wait;
    expect(await processRecoveryEffect(effectDeps(s, NOW + 10_000), wait)).toMatchObject({ kind: "skipped", reason: "awaiting_evidence" });
    grow(s.file);
    expect(await processRecoveryEffect(effectDeps(s, NOW + 20_000), wait)).toMatchObject({ kind: "skipped", reason: "awaiting_evidence" });
    sessionStarted(s.ledger, NOW + 15_000);
    const outcome = await processRecoveryEffect(effectDeps(s, NOW + 30_000), wait);
    expect(outcome).toMatchObject({ kind: "effect_recorded", state: "succeeded" });
    wait = outcome.wait;
    expect(wait).toMatchObject({ disposition_state: "effect_succeeded", effect_observed_at: NOW + 30_000 });
    const effect = wait.disposition_detail?.effect as { evidence: Record<string, unknown> };
    expect(effect.evidence).toMatchObject({ dispatch_id: wait.dispatch_id, session: RUNTIME_SESSION, file: s.file, accepted_at: NOW,
      session_started: { writer_id: "writer-2", at: NOW + 15_000 }, byte_len_before: pinnedSize, byte_len_after: readFileSync(s.file).byteLength, last_entry_id: "resumed" });
    expect(readFileSync(s.file).byteLength).toBeGreaterThan(pinnedSize);
    // Receipt → mailbox observation → Attention projection, bound to the same dispatch.
    expect(getAttention(s.control, "item-1")).toMatchObject({ state: "resolved", effect_state: "succeeded",
      evidence: { effect_projection: { tool_call_id: `resume_checkpoint:${wait.dispatch_id}`, state: "succeeded" } } });
    expect(s.mailbox.query("SELECT outcome FROM decision_receipts WHERE approval_id='ap-1'").get()).toEqual({ outcome: "succeeded" });
    expect(outboxCount(s.control, wait.wait_id, "wait.effect_observed")).toBe(1);
    expect(listRecoveriesInFlight(s.control, 10)).toEqual([]);
    expect(await processRecoveryEffect(effectDeps(s, NOW + 40_000), wait)).toMatchObject({ kind: "skipped", reason: "not_in_flight" });
    expect(s.calls).toHaveLength(1);
  });

  test("no evidence within 120s → unknown: the Attention reopens for verification and nothing is retried", async () => {
    const s = launched();
    const wait = (await processWaitDisposition(s.deps, s.wait)).wait;
    sessionStarted(s.ledger, NOW + RECOVERY_EFFECT_WINDOW_MS + 1); // too late to count
    expect(await processRecoveryEffect(effectDeps(s, NOW + RECOVERY_EFFECT_WINDOW_MS - 1), wait)).toMatchObject({ kind: "skipped", reason: "awaiting_evidence" });
    const outcome = await processRecoveryEffect(effectDeps(s, NOW + RECOVERY_EFFECT_WINDOW_MS), wait);
    expect(outcome).toMatchObject({ kind: "effect_recorded", state: "unknown", wait: { disposition_state: "effect_unknown" } });
    expect((outcome.wait.disposition_detail?.effect as { evidence: { reason: string } }).evidence.reason)
      .toBe("no session_started in the window; the session file did not grow");
    expect(getAttention(s.control, "item-1")).toMatchObject({ state: "open", effect_state: "unknown" });
    expect(s.mailbox.query("SELECT outcome FROM decision_receipts WHERE approval_id='ap-1'").get()).toEqual({ outcome: "unknown" });
    // Late evidence cannot flip the decision; no path dispatches again.
    grow(s.file);
    expect(await processRecoveryEffect(effectDeps(s, NOW + 3 * RECOVERY_EFFECT_WINDOW_MS), outcome.wait)).toMatchObject({ kind: "skipped", reason: "not_in_flight" });
    expect(await processWaitDisposition(s.deps, outcome.wait)).toMatchObject({ kind: "skipped", reason: "not_pending" });
    expect(s.calls).toHaveLength(1);
  });

  test("a failed launch is unknown, never re-dispatched", async () => {
    const s = launched();
    const outcome = await processWaitDisposition({ ...s.deps, executor: async (_command, args) => { s.calls.push(args); return { ok: false, error: "cmux exited 1" }; } }, s.wait);
    expect(outcome).toMatchObject({ kind: "dispatch_recorded", dispatch: { state: "unknown", reason: "launch outcome unknown: cmux exited 1" }, wait: { disposition_state: "effect_unknown" } });
    expect(getAttention(s.control, "item-1")).toMatchObject({ state: "open", effect_state: "unknown" });
    expect(listRecoveriesInFlight(s.control, 10)).toEqual([]);
    expect(await processWaitDisposition(s.deps, outcome.wait)).toMatchObject({ kind: "skipped", reason: "not_pending" });
    expect(s.calls).toHaveLength(1);
  });

  test("a claim interrupted before its outcome settles only after the window, as unknown once the approval was consumed", async () => {
    const s = launched();
    // A round that died inside the executor: claimed and consumed, launch outcome never recorded.
    const hung = processWaitDisposition({ ...s.deps, executor: async (_command, args) => { s.calls.push(args); return new Promise(() => {}); } }, s.wait);
    void hung;
    await Bun.sleep(5);
    const claimed = getConditionWait(s.control, s.wait.wait_id)!;
    expect(claimed.disposition_state).toBe("dispatching");
    expect(await processRecoveryEffect(effectDeps(s, NOW + 60_000), claimed)).toMatchObject({ kind: "skipped", reason: "awaiting_evidence" });
    const settled = await processRecoveryEffect(effectDeps(s, NOW + RECOVERY_EFFECT_WINDOW_MS), claimed);
    expect(settled).toMatchObject({ kind: "dispatch_settled", dispatch: { state: "unknown" }, wait: { disposition_state: "effect_unknown" } });
    expect(getAttention(s.control, "item-1")).toMatchObject({ effect_state: "unknown" });
    expect(s.calls).toHaveLength(1);
  });

  test("the frozen wrappers refuse an unclaimed wait, a past result deadline and an unlaunched dispatch without side effects", async () => {
    const s = launched();
    const disposition = revalidateReadyWait(s.control, s.mailbox, s.ledger, s.wait, { ...SERVER, now: NOW }, probe([]), s.checkpointProbe);
    if (disposition.kind !== "resume_checkpoint") throw new Error(`expected a verified grant, got ${disposition.kind}`);
    const deps = { ledger: s.ledger, control: s.control, executor: s.executor, processProbe: probe([]), checkpointProbe: s.checkpointProbe, now: () => NOW };
    expect(await dispatchAuthorizedRecovery({ wait: s.wait, disposition, result_deadline_at: NOW + RECOVERY_EFFECT_WINDOW_MS }, deps))
      .toEqual({ state: "rejected", reason: "the wait is not claimed for dispatch" });
    const claimed = { ...s.wait, disposition_state: "dispatching" as const, dispatch_id: "d-1", disposition_at: NOW };
    expect(await dispatchAuthorizedRecovery({ wait: claimed, disposition, result_deadline_at: NOW }, deps))
      .toEqual({ state: "rejected", reason: "the result deadline is not after dispatch", dispatch_id: "d-1" });
    expect(s.calls).toEqual([]);
    await expect(observeRecoveryEffect("d-unknown", new AbortController().signal, effectDeps(s, NOW))).rejects.toThrow(/dispatch not found/);
    expect(receipts(s.mailbox)).toBe(0);
  });

  test("maintenance rounds: round 1 dispatches once, later rounds only observe until the window decides", async () => {
    const s = launched();
    let now = NOW;
    const round = () => observeDueWaits({ controlPath: s.mailboxPath, orchestratorPath: join(s.dir, "orchestrator.db"), ledgerPath: s.ledgerPath, mailboxPath: s.mailboxPath,
      adapters: unusedAdapters(), now: () => now, recovery: { executor: s.executor, processAlive: probe([]), checkpointProbe: s.checkpointProbe } });
    await round();
    expect(getConditionWait(s.control, s.wait.wait_id)).toMatchObject({ disposition_state: "dispatched" });
    now = NOW + 60_000;
    await round();
    expect(getConditionWait(s.control, s.wait.wait_id)).toMatchObject({ disposition_state: "dispatched" });
    now = NOW + RECOVERY_EFFECT_WINDOW_MS + 1;
    await round();
    expect(getConditionWait(s.control, s.wait.wait_id)).toMatchObject({ disposition_state: "effect_unknown" });
    await round();
    expect(s.calls).toHaveLength(1);
  });

  test("MAJOR-1: a Web resume racing a wait dispatch launches the checkpoint exactly once, whichever starts first", async () => {
    for (const webFirst of [true, false]) {
      const s = launched();
      const web = () => resumeSession(s.ledger, STABLE_ID, { db: s.control, now: () => NOW }, s.executor, probe([]), s.checkpointProbe);
      const [first, second] = webFirst
        ? await Promise.all([web(), processWaitDisposition(s.deps, s.wait)])
        : await Promise.all([processWaitDisposition(s.deps, s.wait), web()]);
      expect(s.calls).toHaveLength(1);
      if (webFirst) {
        expect(first).toEqual({ resumed: true });
        // The wait claimed and consumed its grant, but the lease rejected the launch before the executor.
        expect(second).toMatchObject({ kind: "dispatch_recorded", dispatch: { state: "rejected", reason: expect.stringMatching(/^checkpoint re-probe failed: launch_in_flight/) } });
      } else {
        expect(first).toMatchObject({ kind: "dispatch_recorded", dispatch: { state: "accepted" } });
        expect(second).toEqual({ resumed: false, reason: "launch_in_flight" });
      }
    }
  });
});
