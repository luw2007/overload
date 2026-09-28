import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  ControlError, claimWaitDispatch, getAttention, getConditionWait, getWork, preflightConditionWait, projectAttentionEffect,
  recordWaitDispatch, recordWaitEffect, recordWaitRedecision,
} from "../control/store";
import type { AttentionItem, ConditionWait, RecoveryDispatchResult, WaitCondition, WaitDispositionInput, WaitResumeGrant } from "../control/types";
import {
  canonical, checkpointReference, consumeDecision, getTarget, grantApproval, observeReceiptEffect, registerResumeGrant, resumeGrantScope,
  RESUME_GRANT_ANSWER, RESUME_GRANT_EFFECT, RESUME_GRANT_TOOL, type ApprovalTarget, type CheckpointPin, type EffectObservation, type ResumeGrantScope,
} from "../decision-bot/mailbox";
import { probeCheckpoint, type Checkpoint, type CheckpointResult } from "../shared/checkpoint";
import { acquireLaunchLease, LAUNCH_LEASE_TTL_MS, type LaunchLeases } from "../shared/launch-lease";
import { listDispositionWork } from "./failure-budget";
import { queryJumpTarget, requestSession } from "../shared/queries";
import {
  defaultProcessProbe, inspectResume, launchCheckpoint, type CheckpointProbe, type ProcessProbe, type ResumeCapability, type ResumeExecutor,
} from "../shared/resume";

/** §8.1 unified revalidation result. */
export type ReadyDisposition =
  | { kind: "redecide"; reason: string; item_id: string; attention_revision: number }
  | { kind: "answer_live_request"; consumer_owner: "extension"; approval_id: string; target_version: string }
  | { kind: "resume_checkpoint"; stable_id: string; runtime: "pi" | "omp"; checkpoint_reference: string; approval_id: string; target_version: string }
  | { kind: "blocked"; reason:
      | "stale_target" | "stale_contract" | "stale_evidence" | "permission_denied"
      | "budget_exhausted" | "approval_expired" | "approval_consumed" | "effect_unknown"
      | "process_alive" | "liveness_unknown" | "checkpoint_invalid"
      | "runtime_unsupported" | "execution_owner_mismatch" | "capability_unavailable" };

type BlockedReason = Extract<ReadyDisposition, { kind: "blocked" }>["reason"];
type ResumeDisposition = Extract<ReadyDisposition, { kind: "resume_checkpoint" }>;

/** §8.5 three-state recovery read model: only `available` may render Answer/Resume. */
export type WaitRecoveryCapability =
  | { state: "available"; action: "answer_live_request" | "resume_checkpoint" }
  | { state: "unsupported"; reason: string; jump_url: string | null }
  | { state: "unknown"; reason: string; jump_url: string | null };

export type WaitDispositionOutcome =
  | { kind: "redecision_recorded"; wait: ConditionWait; disposition: Extract<ReadyDisposition, { kind: "redecide" | "blocked" }> }
  | { kind: "dispatch_recorded"; wait: ConditionWait; disposition: ResumeDisposition; dispatch: RecoveryDispatchResult }
  | { kind: "skipped"; wait: ConditionWait; reason: "not_pending" | "aborted" };

/** One effect decision for a launched resume; `failed` is never observed: an unproven launch is `unknown`. */
export type RecoveryEffect = { state: "succeeded" | "unknown"; evidence: Record<string, unknown>; observed_at: number };

export type RecoveryEffectOutcome =
  | { kind: "effect_recorded"; wait: ConditionWait; state: RecoveryEffect["state"] }
  | { kind: "dispatch_settled"; wait: ConditionWait; dispatch: RecoveryDispatchResult }
  | { kind: "skipped"; wait: ConditionWait; reason: "awaiting_evidence" | "not_in_flight" | "aborted" };

/** Injectable liveness and runtime checkpoint probes; production uses the process table and the runtime session roots. */
export type RecoveryProbes = { processAlive?: ProcessProbe; checkpointProbe?: CheckpointProbe };

/**
 * Frozen effect rule (§8.4): a dispatched resume succeeded only if, within this window after dispatch, the ledger shows
 * a new `session_started` for the same runtime session and the granted session file grew; otherwise it is `unknown`.
 */
export const RECOVERY_EFFECT_WINDOW_MS = LAUNCH_LEASE_TTL_MS;
const REASON_MAX = 400;

const defaultCheckpointProbe: CheckpointProbe = (input) => probeCheckpoint(input);

/** Runtimes whose adapter handle implements `SessionHandle.answer` (`PiRuntime.capabilities.answer`, src/adapters/pi.ts). */
const ANSWER_CAPABLE_RUNTIMES: Record<string, true> = { pi: true };

type SessionRecovery = { state: "unsupported" | "unknown"; reason: string };
type LiveAsk = { live: true } | { live: false; reason: "request_not_pending" | "stale_target" | "approval_expired" | "approval_consumed" | "stale_contract" | "runtime_unsupported" | "consumer_unavailable" };

function hasReceipt(mailbox: Database, target: ApprovalTarget): boolean {
  return !!mailbox.query("SELECT 1 FROM decision_receipts WHERE consumer_owner=? AND approval_id=? AND target_version=?")
    .get(target.consumerOwner, target.approvalId, target.targetVersion);
}

/**
 * Recovery class of a ledger session: exactly the generic resume capability, the single conservative liveness and
 * runtime checkpoint gate (§12.5), so wait recovery and Sessions Resume always agree. A wait never offers a manual
 * Resume — only a grant pinned before the wait resumes, from maintenance — so a resumable session is `unsupported`
 * here and the human keeps the jump to the original session.
 */
function sessionRecovery(ledger: Database, stableId: string, probes: Required<RecoveryProbes>): SessionRecovery {
  const capability = inspectResume(ledger, stableId, probes.processAlive, probes.checkpointProbe);
  if (!capability) return { state: "unknown", reason: "session_not_found" };
  return capability.resumable ? { state: "unsupported", reason: "resume_requires_prior_grant" } : { state: capability.state, reason: capability.reason };
}

/** The generic resume gate plus the checkpoint its probe proved: the one place wait recovery reads session facts. */
function probeResume(
  ledger: Database, stableId: string, processAlive: ProcessProbe, checkpointProbe: CheckpointProbe, leases?: LaunchLeases,
): { capability: ResumeCapability | null; checkpoint: Checkpoint | null } {
  const seen: { result?: CheckpointResult } = {};
  const capability = inspectResume(ledger, stableId, processAlive, (input) => (seen.result = checkpointProbe(input)), leases);
  return { capability, checkpoint: capability?.resumable && seen.result?.valid ? seen.result.checkpoint : null };
}

const pinOf = (stable_id: string, cp: Checkpoint): CheckpointPin =>
  ({ stable_id, runtime: cp.runtime, session: cp.session, cwd: cp.cwd, file: cp.file, last_entry_id: cp.last_entry_id, byte_len: cp.byte_len });

const unresumableReason = (capability: ResumeCapability | null): string => (capability && !capability.resumable ? capability.reason : "session_not_found");

/** Existing Web jump routes only (`/api/jump/:request_uid`, `/api/jump-session/:stable_id`), resolved the same way the server resolves them. */
function jumpUrl(ledger: Database | null, target: ApprovalTarget | null): string | null {
  if (!ledger || !target) return null;
  if (target.requestUid) {
    const stableId = requestSession(ledger, target.requestUid);
    if (stableId && queryJumpTarget(ledger, stableId)) return `/api/jump/${encodeURIComponent(target.requestUid)}`;
  }
  if (target.stableId && queryJumpTarget(ledger, target.stableId)) return `/api/jump-session/${encodeURIComponent(target.stableId)}`;
  return null;
}

/**
 * Adapter-owned blocked ask (§8.3). A human answer reaches the runtime only through the existing consumer:
 * `writeHumanAnswer` → `AdapterService.consumeAnswers` → `SessionHandle.answer`. Everything is re-read from the
 * explicit mailbox DB (the adapter daemon's store). Returns null when the approval has no adapter runtime decision.
 * The live handle is in-process state of the owning AdapterService; its unexpired ownership lease is the durable proof.
 */
function adapterAsk(control: Database, mailbox: Database, item: AttentionItem, target: ApprovalTarget, now: number): LiveAsk | null {
  const tables = mailbox.query(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table'
    AND name IN ('runtime_decisions','conversations','conversation_turns','runtime_ownership')`).get() as { n: number };
  if (tables.n !== 4) return null;
  const decision = mailbox.query(`SELECT d.request_id, d.dispatch_state, d.receipt_id, c.session_reference, t.state turn_state
    FROM runtime_decisions d JOIN conversations c ON c.id=d.conversation_id LEFT JOIN conversation_turns t ON t.id=d.turn_id
    WHERE d.item_id=?`).get(target.approvalId) as { request_id: string; dispatch_state: string; receipt_id: string | null; session_reference: string | null; turn_state: string | null } | null;
  if (!decision) return null;
  if (decision.dispatch_state !== "pending" || decision.receipt_id !== null || decision.turn_state !== "blocked" || item.state !== "open") return { live: false, reason: "request_not_pending" };
  if (target.state !== "active" || target.toolCallId !== decision.request_id) return { live: false, reason: "stale_target" };
  if (now >= target.expiresAt || (item.expires_at !== null && now >= item.expires_at)) return { live: false, reason: "approval_expired" };
  if (hasReceipt(mailbox, target)) return { live: false, reason: "approval_consumed" };
  const work = getWork(control, item.work_id);
  if (!work || target.workId !== work.work_id || target.contractRevision !== work.revision) return { live: false, reason: "stale_contract" };
  const reference = JSON.parse(decision.session_reference ?? "null") as { runtimeKind?: unknown; sessionId?: unknown } | null;
  if (typeof reference?.runtimeKind !== "string" || !Object.hasOwn(ANSWER_CAPABLE_RUNTIMES, reference.runtimeKind)) return { live: false, reason: "runtime_unsupported" };
  const lease = mailbox.query("SELECT 1 FROM runtime_ownership WHERE session_id=? AND expires_at>?").get(String(reference.sessionId), now);
  return lease ? { live: true } : { live: false, reason: "consumer_unavailable" };
}

/**
 * Read model for one wait (§8.5, §10.1). `available` only for a verified live adapter ask answered by the existing
 * consumer; ledger Q1 and sessions get jump only (an authorized resume runs from maintenance, never from a click).
 */
export function inspectWaitRecovery(
  control: Database,
  mailbox: Database,
  ledger: Database | null,
  wait: Pick<ConditionWait, "work_id" | "item_id">,
  context: { now: number } & RecoveryProbes,
): WaitRecoveryCapability {
  const item = getAttention(control, wait.item_id);
  if (!item || item.work_id !== wait.work_id) return { state: "unknown", reason: "attention_unbound", jump_url: null };
  const target = item.approval_id && item.consumer_owner ? getTarget(mailbox, item.consumer_owner, item.approval_id) : null;
  const jump_url = jumpUrl(ledger, target);
  if (target?.consumerOwner === "extension") {
    const ask = adapterAsk(control, mailbox, item, target, context.now);
    if (ask?.live) return { state: "available", action: "answer_live_request" };
    if (ask) return { state: "unknown", reason: ask.reason, jump_url };
    // An ordinary ledger Q1 is answered in place: its consumer is not provably live, so only the jump is offered.
    if (target.requestUid && ledger?.query("SELECT 1 FROM requests WHERE request_uid=? AND state='pending'").get(target.requestUid)) {
      return { state: "unknown", reason: "answer_consumer_unverified", jump_url };
    }
  }
  if (!target?.stableId) return { state: "unsupported", reason: "no_session_link", jump_url };
  if (!ledger) return { state: "unknown", reason: "ledger_unavailable", jump_url };
  const session = sessionRecovery(ledger, target.stableId, {
    processAlive: context.processAlive ?? defaultProcessProbe, checkpointProbe: context.checkpointProbe ?? defaultCheckpointProbe,
  });
  return { ...session, jump_url };
}

/**
 * Pins a resume grant (§4.2 rule 5, §8.4) for the decision owner's explicit consent: "after `condition` is met,
 * resume exactly this checkpoint of `stable_id`, executed by `execution_owner`". Runs wait creation's non-mutating
 * Work/owner/item checks, probes the checkpoint now, and records target plus approval atomically in the explicit
 * mailbox DB. Returns the authorization for `createWait`; nothing here claims, consumes or launches.
 */
export function createResumeGrant(
  control: Database,
  mailbox: Database,
  ledger: Database | null,
  input: {
    work_id: string; item_id: string; condition: WaitCondition; stable_id: string; attempt_id: string;
    execution_owner: string; expires_at: number; question?: string;
  },
  context: { actor: string; actor_source: "server"; now: number } & RecoveryProbes,
): Extract<WaitDispositionInput, { kind: "authorized_resume" }> {
  if (context?.actor_source !== "server" || typeof context.actor !== "string" || !context.actor.trim()) {
    throw new ControlError("forbidden", "a resume grant requires the server-bound actor");
  }
  for (const key of ["stable_id", "attempt_id", "execution_owner"] as const) {
    const value = input[key];
    if (typeof value !== "string" || !value || value !== value.trim()) throw new ControlError("invalid", `invalid ${key}`);
  }
  // Same checks as creating the wait itself; also yields the normalized condition the wait will store.
  const normalized = preflightConditionWait(control, {
    work_id: input.work_id, item_id: input.item_id, condition: input.condition, deadline_at: input.expires_at,
  }, { actor: context.actor, now: context.now });
  const work = getWork(control, normalized.work_id)!;
  const item = getAttention(control, normalized.item_id)!;
  const scopeRules = work.contract!.scope;
  if (!item.approval_id || !item.consumer_owner) throw new ControlError("blocked", "attention item has no approval slot to bind a grant");
  if (scopeRules.human_only_effects?.includes(RESUME_GRANT_EFFECT)
    || (scopeRules.allowed_effects !== undefined && !scopeRules.allowed_effects.includes(RESUME_GRANT_EFFECT))) {
    throw new ControlError("forbidden", "resume_checkpoint is not an allowed automatic effect of this Work");
  }
  if (!ledger) throw new ControlError("blocked", "checkpoint_unavailable: ledger unavailable");
  const session = probeResume(ledger, input.stable_id, context.processAlive ?? defaultProcessProbe, context.checkpointProbe ?? defaultCheckpointProbe);
  if (!session.checkpoint) throw new ControlError("blocked", `checkpoint_unavailable: ${unresumableReason(session.capability)}`);
  const scope: ResumeGrantScope = {
    ...pinOf(input.stable_id, session.checkpoint), attention_revision: item.revision, expires_at: input.expires_at,
    item_id: item.item_id, execution_owner: input.execution_owner, condition: normalized.condition,
  };
  let target: ApprovalTarget;
  try {
    target = registerResumeGrant(mailbox, {
      consumerOwner: item.consumer_owner, approvalId: item.approval_id, workId: work.work_id, contractRevision: work.revision,
      attemptId: input.attempt_id, actor: context.actor, now: context.now, scope,
      question: input.question ?? `Resume ${input.stable_id} from its checkpoint after the ${normalized.condition.kind} condition is met?`,
    });
  } catch (error) {
    throw new ControlError("conflict", (error as Error).message);
  }
  return { kind: "authorized_resume", authorization: {
    consumer_owner: target.consumerOwner, approval_id: target.approvalId, target_version: target.targetVersion,
    approved_effect: "resume_checkpoint", work_revision: work.revision, attention_revision: item.revision,
    attempt_id: input.attempt_id, checkpoint_reference: checkpointReference(scope), execution_owner: input.execution_owner,
    expires_at: input.expires_at,
  } };
}

export type ResumeGrantMismatch = { reason: "stale_target" | "permission_denied"; detail: string };

/**
 * Frozen grant binding shared by wait creation and every revalidation: the mailbox target must pin a complete
 * `resume_grant` scope for exactly this post-condition, Attention revision, checkpoint reference, expiry and execution
 * owner, with the decision owner's approval still pending. `authorization_json` is compared, never trusted.
 */
export function resumeGrantMismatch(
  mailbox: Database,
  target: ApprovalTarget,
  grant: WaitResumeGrant,
  binding: { item_id: string; decision_owner: string | undefined; condition: WaitCondition },
): ResumeGrantMismatch | null {
  const denied = (detail: string): ResumeGrantMismatch => ({ reason: "permission_denied", detail });
  const stale = (detail: string): ResumeGrantMismatch => ({ reason: "stale_target", detail });
  const scope = resumeGrantScope(target);
  if (target.effect !== RESUME_GRANT_EFFECT || !scope) return denied("the approval does not pin a resume checkpoint");
  if (canonical(scope.condition) !== canonical(binding.condition)) return denied("the approval does not cover this post-condition");
  if (scope.execution_owner !== grant.execution_owner) return denied("the execution owner differs from the approval");
  const approval = grantApproval(mailbox, target.consumerOwner, target.approvalId);
  if (approval?.answer !== RESUME_GRANT_ANSWER || !binding.decision_owner || approval.actor !== binding.decision_owner) {
    return denied("no decision-owner approval is pending for this grant");
  }
  if (scope.item_id !== binding.item_id || scope.attention_revision !== grant.attention_revision) return stale("the Attention binding differs from the approval");
  if (scope.stable_id !== target.stableId || checkpointReference(scope) !== grant.checkpoint_reference) return stale("the checkpoint reference differs from the approval");
  if (scope.expires_at !== grant.expires_at) return stale("the expiry differs from the approval");
  return null;
}

/**
 * The effect observer lands mailbox-accepted observations through control (`projectAttentionEffect` reads them from
 * the control DB), so it is registered only when control and mailbox are one store — production's answers DB.
 */
function effectObserverReady(control: Database, target: ApprovalTarget): boolean {
  const tables = control.query(`SELECT COUNT(*) n FROM sqlite_master WHERE type='table'
    AND name IN ('approval_targets','decision_receipts','receipt_effect_observations')`).get() as { n: number };
  return tables.n === 3 && !!control.query("SELECT 1 FROM approval_targets WHERE consumer_owner=? AND approval_id=? AND target_version=?")
    .get(target.consumerOwner, target.approvalId, target.targetVersion);
}

/**
 * §8.1 checks for a pre-authorized ready wait, in contract order, against freshly re-read control, mailbox and ledger
 * facts; the first failing fact is the exact blocked reason. A `resume_checkpoint` grant passes only when its frozen
 * binding still holds, the session is proven terminated, and a fresh runtime probe finds the byte-identical pinned
 * checkpoint. `answer_blocked_request` stays `capability_unavailable`: a pre-authorization carries no answer value.
 * Retry/cost consumption lives in the orchestrator task store, which this path does not receive, so a declared retry
 * or cost budget is unmeasured here and fails closed as `capability_unavailable`.
 */
function checkGrant(
  control: Database, mailbox: Database, ledger: Database | null, wait: ConditionWait, item: AttentionItem,
  context: { actor: string; now: number }, probes: Required<RecoveryProbes>,
): { blocked: BlockedReason } | { resume: ResumeDisposition } {
  const blocked = (reason: BlockedReason) => ({ blocked: reason });
  const grant = wait.resume_grant;
  if (!grant) return blocked("stale_target");
  const work = getWork(control, wait.work_id);
  const contract = work?.contract;
  if (!work || !contract || work.state !== "active" || grant.work_revision !== work.revision || item.contract_revision !== work.revision) return blocked("stale_contract");
  if (wait.decision_owner !== contract.decision_owner) return blocked("permission_denied");
  if (grant.attention_revision !== item.revision || item.approval_id !== grant.approval_id || item.consumer_owner !== grant.consumer_owner
    || (item.state !== "open" && item.state !== "applying")) return blocked("stale_target");
  if (!wait.ready_observation_fingerprint || wait.ready_observation_fingerprint !== wait.observed_fingerprint) return blocked("stale_evidence");
  if (contract.budget.deadline_at !== undefined && context.now >= contract.budget.deadline_at) return blocked("budget_exhausted");
  if (contract.scope.human_only_effects?.includes(grant.approved_effect)
    || (contract.scope.allowed_effects !== undefined && !contract.scope.allowed_effects.includes(grant.approved_effect))) return blocked("permission_denied");
  if (context.now >= grant.expires_at) return blocked("approval_expired");
  const target = getTarget(mailbox, grant.consumer_owner, grant.approval_id);
  if (!target) return blocked("stale_target");
  if (target.state === "consumed" || hasReceipt(mailbox, target)) return blocked("approval_consumed");
  if (target.state !== "active" || target.targetVersion !== grant.target_version || (target.attemptId ?? null) !== grant.attempt_id) return blocked("stale_target");
  if (target.expiresAt !== grant.expires_at || context.now >= target.expiresAt) return blocked("approval_expired");
  if (target.workId !== wait.work_id || target.contractRevision !== work.revision) return blocked("stale_contract");
  if (target.effect !== grant.approved_effect || target.decisionMode === "human_only") return blocked("permission_denied");
  const unknownEffect = mailbox.query(`SELECT 1 FROM receipt_effect_observations o JOIN decision_receipts r ON r.receipt_id=o.receipt_id
    WHERE r.consumer_owner=? AND r.approval_id=? AND o.state='unknown' LIMIT 1`).get(target.consumerOwner, target.approvalId);
  if (item.effect_state === "applying" || item.effect_state === "unknown" || unknownEffect) return blocked("effect_unknown");
  if (context.actor !== grant.execution_owner) return blocked("execution_owner_mismatch");
  if (grant.approved_effect !== "resume_checkpoint") {
    const ask = adapterAsk(control, mailbox, item, target, context.now);
    if (ask && !ask.live) return blocked(ask.reason === "consumer_unavailable" ? "liveness_unknown" : ask.reason === "runtime_unsupported" ? "runtime_unsupported" : "stale_target");
    return blocked("capability_unavailable");
  }
  const mismatch = resumeGrantMismatch(mailbox, target, grant, { item_id: item.item_id, decision_owner: contract.decision_owner, condition: wait.condition });
  if (mismatch) return blocked(mismatch.reason);
  const scope = resumeGrantScope(target)!;
  if (!ledger) return blocked("liveness_unknown");
  const session = probeResume(ledger, scope.stable_id, probes.processAlive, probes.checkpointProbe);
  const capability = session.capability;
  if (!capability) return blocked("liveness_unknown");
  if (!capability.resumable) {
    if (capability.reason === "process_alive") return blocked("process_alive");
    if (capability.state === "unsupported") return blocked("runtime_unsupported");
    return blocked(capability.reason === "liveness_unknown" ? "liveness_unknown" : "checkpoint_invalid");
  }
  if (!session.checkpoint || checkpointReference(pinOf(scope.stable_id, session.checkpoint)) !== grant.checkpoint_reference) return blocked("checkpoint_invalid");
  if (contract.budget.retry_limit !== undefined || contract.budget.cost_limit !== undefined) return blocked("capability_unavailable");
  if (!effectObserverReady(control, target)) return blocked("capability_unavailable");
  return { resume: {
    kind: "resume_checkpoint", stable_id: scope.stable_id, runtime: session.checkpoint.runtime,
    checkpoint_reference: grant.checkpoint_reference, approval_id: grant.approval_id, target_version: grant.target_version,
  } };
}

/**
 * §8.1 unified revalidation. Re-reads the wait, its Attention and Work from control, the approval target/receipt
 * from the explicit mailbox DB — never from `authorization_json`, the caller's object or a cache — and the session
 * checkpoint from the runtime. Default and every failed auto check returns the original responsibility to a human;
 * nothing here consumes a target or starts a process.
 */
export function revalidateReadyWait(
  control: Database,
  mailbox: Database,
  ledger: Database | null,
  wait: ConditionWait,
  context: { actor: string; actor_source: "server"; now: number },
  processAlive: ProcessProbe = defaultProcessProbe,
  checkpointProbe: CheckpointProbe = defaultCheckpointProbe,
): ReadyDisposition {
  if (context?.actor_source !== "server" || typeof context.actor !== "string" || !context.actor.trim()) {
    throw new ControlError("forbidden", "revalidation requires the server-bound actor");
  }
  const current = getConditionWait(control, wait.wait_id);
  if (!current) throw new ControlError("not_found", "wait not found");
  if (current.version !== wait.version) throw new ControlError("conflict", "stale wait version");
  if (current.disposition_state !== "pending") throw new ControlError("conflict", `wait disposition is ${current.disposition_state ?? "not started"}`);
  const item = getAttention(control, current.item_id);
  if (!item) throw new ControlError("not_found", "attention item not found");
  // Persistent, not a lost race: retrying cannot fix it, so it is a budgeted failure rather than silent contention.
  if (item.work_id !== current.work_id) throw new ControlError("blocked", "invariant: attention item moved to another work");
  const redecide = (reason: string): ReadyDisposition => ({ kind: "redecide", reason, item_id: item.item_id, attention_revision: item.revision });
  if (current.state !== "ready") return redecide(`wait ${current.state}: ${current.state_reason ?? "unspecified"}`);
  if (current.disposition === "redecide") return redecide("condition ready: the original decision returns to its owner");
  const check = checkGrant(control, mailbox, ledger, current, item, context, { processAlive, checkpointProbe });
  return "blocked" in check ? { kind: "blocked", reason: check.blocked } : check.resume;
}

/**
 * Recovery coordinator for one wait whose `disposition_state` is `pending` (ready/unavailable/expired), called by the
 * maintenance runner before its hard deadline. Revalidates; a verified resume grant is dispatched once, everything
 * else lands on the original Attention through `recordWaitRedecision` in one control transaction. CAS loss surfaces
 * as `ControlError('conflict')`.
 */
export async function processWaitDisposition(
  deps: {
    control: Database; mailbox: Database; ledger: Database | null; actor: string; now: () => number; signal: AbortSignal;
    executor?: ResumeExecutor;
  } & RecoveryProbes,
  wait: ConditionWait,
): Promise<WaitDispositionOutcome> {
  if (deps.signal.aborted) return { kind: "skipped", wait, reason: "aborted" };
  const current = getConditionWait(deps.control, wait.wait_id);
  if (!current) throw new ControlError("not_found", "wait not found");
  if (current.version !== wait.version) throw new ControlError("conflict", "stale wait version");
  if (current.disposition_state !== "pending") return { kind: "skipped", wait: current, reason: "not_pending" };
  const now = deps.now();
  const disposition = revalidateReadyWait(deps.control, deps.mailbox, deps.ledger, current, { actor: deps.actor, actor_source: "server", now },
    deps.processAlive, deps.checkpointProbe);
  // Revalidation never yields an automatic answer (see checkGrant); that kind here is an invariant breach, never executed.
  if (disposition.kind === "answer_live_request") throw new ControlError("blocked", "capability_unavailable: automatic answer_live_request is not enabled");
  if (deps.signal.aborted) return { kind: "skipped", wait: current, reason: "aborted" };
  if (disposition.kind === "resume_checkpoint") return dispatchResume(deps, current, disposition, now);
  const attentionRevision = disposition.kind === "redecide" ? disposition.attention_revision : getAttention(deps.control, current.item_id)?.revision;
  if (attentionRevision === undefined) throw new ControlError("not_found", "attention item not found");
  const landed = recordWaitRedecision(deps.control, current.wait_id, current.version, {
    attention_revision: attentionRevision, reason: disposition.reason, now,
  });
  return { kind: "redecision_recorded", wait: landed, disposition };
}

/**
 * The single authorized execution (§8.4), synchronous from revalidation up to the executor: claim the wait (control
 * CAS pending → dispatching), consume the approval (mailbox CAS active → consumed + receipt), then
 * `dispatchAuthorizedRecovery` re-probes and launches once. Losing either CAS never reaches the executor; a replay
 * finds the wait no longer pending and the approval consumed. Nothing is retried: a rejected or unknown launch is
 * recorded against the consumed receipt and handed back to a human.
 */
async function dispatchResume(
  deps: Parameters<typeof processWaitDisposition>[0], wait: ConditionWait, disposition: ResumeDisposition, now: number,
): Promise<WaitDispositionOutcome> {
  const grant = wait.resume_grant;
  if (!grant || !deps.ledger) throw new ControlError("blocked", "capability_unavailable: resume dispatch without grant or ledger");
  const claimId = randomUUID();
  const claimed = claimWaitDispatch(deps.control, wait.wait_id, wait.version, claimId, randomUUID(), now);
  const dispatchId = claimed.dispatch_id!;
  const receipt = consumeDecision(deps.mailbox, {
    consumerOwner: grant.consumer_owner, approvalId: grant.approval_id, targetVersion: grant.target_version, policyHash: RESUME_GRANT_EFFECT, now,
    liveValid: () => true, contractValid: (target) => target.effect === RESUME_GRANT_EFFECT, policyValid: () => false,
  });
  let result: RecoveryDispatchResult;
  if (!receipt) {
    result = { state: "rejected", reason: "approval_consumed: the grant could not be consumed at dispatch", dispatch_id: dispatchId };
  } else {
    try {
      result = await dispatchAuthorizedRecovery({ wait: claimed, disposition, result_deadline_at: now + RECOVERY_EFFECT_WINDOW_MS }, {
        ledger: deps.ledger, control: deps.control, executor: deps.executor, processProbe: deps.processAlive ?? defaultProcessProbe,
        checkpointProbe: deps.checkpointProbe, now: deps.now,
      });
    } catch (error) {
      result = { state: "unknown", reason: `launch outcome unknown: ${String((error as Error)?.message ?? error)}`.slice(0, REASON_MAX), dispatch_id: dispatchId };
    }
    if (result.state !== "accepted") {
      // The executor runs only after consumption, so a rejection here launched nothing; an unknown launch may have.
      observeGrantReceipt(deps.mailbox, grant, receipt.receiptId, dispatchId, result.state === "rejected" ? "failed" : "unknown",
        { dispatch_id: dispatchId, executed: result.state === "rejected" ? false : "unknown", reason: result.reason }, Math.max(deps.now(), now));
    }
  }
  const recorded = recordWaitDispatch(deps.control, wait.wait_id, claimed.version, claimId, result, Math.max(deps.now(), now));
  return { kind: "dispatch_recorded", wait: recorded, disposition, dispatch: result };
}

/**
 * Work-aware launch wrapper (§8.4). Requires a wait claimed for this dispatch, re-probes liveness and the runtime
 * checkpoint at dispatch — any difference from the granted reference rejects without calling the executor — then takes
 * the checkpoint's launch lease (shared with Web resume, src/shared/launch-lease.ts) and launches that exact checkpoint
 * once in a background cmux workspace. A launch already in flight rejects without calling the executor. `accepted_at`
 * is the dispatch instant that opens the effect window. A failed or throwing launch may still have started the
 * runtime, so it is `unknown`.
 */
export async function dispatchAuthorizedRecovery(
  input: { wait: ConditionWait; disposition: ResumeDisposition; result_deadline_at: number },
  deps: { ledger: Database; control: Database; executor?: ResumeExecutor; processProbe: ProcessProbe; checkpointProbe?: CheckpointProbe; now?: () => number },
): Promise<RecoveryDispatchResult> {
  const { wait, disposition } = input;
  const dispatchId = wait.dispatch_id;
  if (wait.disposition_state !== "dispatching" || !dispatchId) return { state: "rejected", reason: "the wait is not claimed for dispatch" };
  const clock = deps.now ?? Date.now;
  const dispatchedAt = Math.max(clock(), wait.disposition_at ?? 0);
  if (!(input.result_deadline_at > dispatchedAt)) return { state: "rejected", reason: "the result deadline is not after dispatch", dispatch_id: dispatchId };
  const leases: LaunchLeases = { db: deps.control, now: clock };
  const session = probeResume(deps.ledger, disposition.stable_id, deps.processProbe, deps.checkpointProbe ?? defaultCheckpointProbe, leases);
  if (!session.checkpoint) return { state: "rejected", reason: `checkpoint re-probe failed: ${unresumableReason(session.capability)}`, dispatch_id: dispatchId };
  if (session.checkpoint.runtime !== disposition.runtime
    || checkpointReference(pinOf(disposition.stable_id, session.checkpoint)) !== disposition.checkpoint_reference) {
    return { state: "rejected", reason: "checkpoint_invalid: the checkpoint changed since the grant", dispatch_id: dispatchId };
  }
  if (!acquireLaunchLease(deps.ledger, leases, session.checkpoint, disposition.stable_id, `wait:${dispatchId}`)) {
    return { state: "rejected", reason: "launch_in_flight: another launch of this checkpoint is in flight", dispatch_id: dispatchId };
  }
  let launched: { ok: boolean; error?: string };
  try {
    launched = await launchCheckpoint(session.checkpoint, deps.executor, false);
  } catch (error) {
    return { state: "unknown", reason: `launch outcome unknown: ${String((error as Error)?.message ?? error)}`.slice(0, REASON_MAX), dispatch_id: dispatchId };
  }
  return launched.ok
    ? { state: "accepted", dispatch_id: dispatchId, accepted_at: dispatchedAt }
    : { state: "unknown", reason: `launch outcome unknown: ${launched.error ?? "launch_failed"}`.slice(0, REASON_MAX), dispatch_id: dispatchId };
}

/** Receipt that consumed this grant's exact target version, if the dispatch got that far. */
function grantReceiptId(mailbox: Database, grant: WaitResumeGrant): string | null {
  const row = mailbox.query("SELECT receipt_id FROM decision_receipts WHERE consumer_owner=? AND approval_id=? AND target_version=?")
    .get(grant.consumer_owner, grant.approval_id, grant.target_version) as { receipt_id: string } | null;
  return row?.receipt_id ?? null;
}

/**
 * Records one effect step of a consumed grant in the mailbox (`resume_checkpoint:<dispatch_id>`). An observation the
 * mailbox already accepted for this step is returned as-is, so a retried recording after a crash replays exactly it.
 */
function observeGrantReceipt(
  mailbox: Database, grant: WaitResumeGrant, receiptId: string, dispatchId: string,
  state: EffectObservation["state"], evidence: Record<string, unknown>, observedAt: number,
): EffectObservation {
  const toolCallId = `${RESUME_GRANT_TOOL}:${dispatchId}`;
  const prior = mailbox.query("SELECT state,evidence,observed_at FROM receipt_effect_observations WHERE receipt_id=? AND tool_call_id=?")
    .get(receiptId, toolCallId) as { state: EffectObservation["state"]; evidence: string; observed_at: number } | null;
  if (prior) return { receiptId, toolCallId, attemptId: grant.attempt_id, state: prior.state, evidence: JSON.parse(prior.evidence), observedAt: prior.observed_at };
  const observation: EffectObservation = { receiptId, toolCallId, attemptId: grant.attempt_id, state, evidence, observedAt };
  if (!observeReceiptEffect(mailbox, observation)) throw new ControlError("conflict", "the mailbox rejected the recovery effect observation");
  return observation;
}

/**
 * Authorized recoveries claimed or launched without a recorded effect, oldest first, skipping rows that are backed
 * off or parked by the disposition failure budget (src/waits/failure-budget.ts).
 */
export function listRecoveriesInFlight(control: Database, limit: number, now: number = Date.now()): ConditionWait[] {
  return listDispositionWork(control, ["dispatching", "dispatched"], now, limit);
}

/**
 * One observation of a launched resume under the frozen rule: `succeeded` only when the ledger holds a
 * `session_started` of the same local runtime session within RECOVERY_EFFECT_WINDOW_MS after dispatch AND the granted
 * session file grew past its pinned length; `unknown` once the window has passed without both. Returns null while the
 * window is open and evidence is incomplete (or the signal is aborted). Launch acceptance alone is never success.
 */
export async function observeRecoveryEffect(
  dispatchId: string,
  signal: AbortSignal,
  deps: { control: Database; mailbox: Database; ledger: Database | null; now?: () => number; checkpointProbe?: CheckpointProbe },
): Promise<RecoveryEffect | null> {
  if (signal.aborted) return null;
  const row = deps.control.query("SELECT wait_id FROM control_waits WHERE dispatch_id=?").get(dispatchId) as { wait_id: string } | null;
  const wait = row ? getConditionWait(deps.control, row.wait_id) : null;
  if (!wait) throw new ControlError("not_found", "dispatch not found");
  const dispatch = wait.disposition_detail?.dispatch as { state?: unknown; accepted_at?: unknown } | undefined;
  if (wait.disposition_state !== "dispatched" || dispatch?.state !== "accepted" || typeof dispatch.accepted_at !== "number") {
    throw new ControlError("conflict", "the dispatch has no accepted launch to observe");
  }
  const acceptedAt = dispatch.accepted_at;
  const deadline = acceptedAt + RECOVERY_EFFECT_WINDOW_MS;
  const observedAt = Math.max((deps.now ?? Date.now)(), wait.updated_at);
  const grant = wait.resume_grant;
  const target = grant ? getTarget(deps.mailbox, grant.consumer_owner, grant.approval_id) : null;
  const scope = target && target.targetVersion === grant?.target_version ? resumeGrantScope(target) : null;
  if (!scope) return { state: "unknown", evidence: { dispatch_id: dispatchId, reason: "the grant scope is no longer readable" }, observed_at: observedAt };
  const started = (deps.ledger?.query(`SELECT j.stable_id, j.writer_id, j.ingest_seq, j.at FROM journal_all j JOIN sessions s ON s.stable_id=j.stable_id
    WHERE j.kind='session_started' AND s.host='local' AND s.runtime=? AND s.session=? AND j.at>=? AND j.at<=?
    ORDER BY j.at, j.ingest_seq LIMIT 1`).get(scope.runtime, scope.session, acceptedAt, deadline) ?? null) as
    { stable_id: string; writer_id: string; ingest_seq: number; at: number } | null;
  const probed = (deps.checkpointProbe ?? defaultCheckpointProbe)({ runtime: scope.runtime, session: scope.session, cwd: scope.cwd });
  const current = probed.valid && probed.checkpoint.file === scope.file ? probed.checkpoint : null;
  const grew = current !== null && current.byte_len > scope.byte_len;
  const evidence = {
    dispatch_id: dispatchId, stable_id: scope.stable_id, runtime: scope.runtime, session: scope.session, file: scope.file,
    accepted_at: acceptedAt, window_ms: RECOVERY_EFFECT_WINDOW_MS, session_started: started,
    byte_len_before: scope.byte_len, byte_len_after: current?.byte_len ?? null,
  };
  if (started && grew) return { state: "succeeded", evidence: { ...evidence, last_entry_id: current.last_entry_id }, observed_at: observedAt };
  if (observedAt < deadline) return null;
  const missing = [...(started ? [] : ["no session_started in the window"]), ...(grew ? [] : ["the session file did not grow"])];
  return { state: "unknown", evidence: { ...evidence, reason: missing.join("; ") }, observed_at: observedAt };
}

/**
 * Maintenance entry for an in-flight authorized recovery. `dispatched`: observe once and, when decided, record the
 * effect in the mailbox (receipt observation), on the wait (`wait.effect_observed`) and on the original Attention via
 * `projectAttentionEffect` — `unknown` reopens it for verification; nothing is ever re-dispatched. A `dispatching`
 * claim whose launch outcome was never recorded (a crashed or killed round) is settled after the effect window:
 * `unknown` once its approval was consumed, otherwise `rejected` because nothing could have been launched.
 */
export async function processRecoveryEffect(
  deps: { control: Database; mailbox: Database; ledger: Database | null; now: () => number; signal: AbortSignal; checkpointProbe?: CheckpointProbe },
  wait: ConditionWait,
): Promise<RecoveryEffectOutcome> {
  if (deps.signal.aborted) return { kind: "skipped", wait, reason: "aborted" };
  const current = getConditionWait(deps.control, wait.wait_id);
  if (!current) throw new ControlError("not_found", "wait not found");
  if (current.version !== wait.version) throw new ControlError("conflict", "stale wait version");
  const grant = current.resume_grant;
  const dispatchId = current.dispatch_id;
  const claimId = current.disposition_claim_id;
  if (!grant || !dispatchId || !claimId || (current.disposition_state !== "dispatching" && current.disposition_state !== "dispatched")) {
    return { kind: "skipped", wait: current, reason: "not_in_flight" };
  }
  if (current.disposition_state === "dispatching") {
    const now = Math.max(deps.now(), current.updated_at);
    if (now < (current.disposition_at ?? current.updated_at) + RECOVERY_EFFECT_WINDOW_MS) return { kind: "skipped", wait: current, reason: "awaiting_evidence" };
    const receiptId = grantReceiptId(deps.mailbox, grant);
    const dispatch: RecoveryDispatchResult = receiptId
      ? { state: "unknown", reason: "the dispatch was interrupted after its approval was consumed", dispatch_id: dispatchId }
      : { state: "rejected", reason: "the dispatch was interrupted before its approval was consumed", dispatch_id: dispatchId };
    if (receiptId) observeGrantReceipt(deps.mailbox, grant, receiptId, dispatchId, "unknown", { dispatch_id: dispatchId, reason: dispatch.reason }, now);
    return { kind: "dispatch_settled", wait: recordWaitDispatch(deps.control, current.wait_id, current.version, claimId, dispatch, now), dispatch };
  }
  const effect = await observeRecoveryEffect(dispatchId, deps.signal, deps);
  if (!effect) return { kind: "skipped", wait: current, reason: "awaiting_evidence" };
  if (deps.signal.aborted) return { kind: "skipped", wait: current, reason: "aborted" };
  const receiptId = grantReceiptId(deps.mailbox, grant);
  // Invariant breach, not contention: a dispatched grant always has its consuming receipt. It counts against the row's failure budget.
  if (!receiptId) throw new ControlError("blocked", "invariant: the recovery dispatch has no consumed approval receipt");
  const observation = observeGrantReceipt(deps.mailbox, grant, receiptId, dispatchId, effect.state, effect.evidence, effect.observed_at);
  // Wait effect and Attention projection commit together; the mailbox observation above is replayed if this fails.
  const recorded = deps.control.transaction(() => {
    const landed = recordWaitEffect(deps.control, current.wait_id, current.version, claimId,
      { state: observation.state, evidence: observation.evidence, observed_at: observation.observedAt });
    const source = deps.control.query("SELECT event_id FROM control_outbox WHERE entity_id=? AND entity_version=? AND kind='wait.effect_observed'")
      .get(landed.wait_id, landed.version) as { event_id: string } | null;
    if (!source) throw new ControlError("blocked", "invariant: wait.effect_observed event missing");
    const item = getAttention(deps.control, landed.item_id);
    if (!item) throw new ControlError("not_found", "attention item not found");
    projectAttentionEffect(deps.control, {
      work_id: item.work_id, item_id: item.item_id, item_revision: item.revision, approval_id: grant.approval_id,
      receipt_id: receiptId, outbox_event_id: source.event_id,
    }, observation, observation.observedAt);
    return landed;
  }).immediate() as ConditionWait;
  return { kind: "effect_recorded", wait: recorded, state: observation.state === "succeeded" ? "succeeded" : "unknown" };
}
