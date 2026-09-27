import type { Database } from "bun:sqlite";
import { ControlError, createConditionWait, getWork, preflightConditionWait } from "../control/store";
import type { ConditionWait, CreateWaitInput, WaitBaselineSnapshot, WaitCondition, WaitResumeGrant, WaitSourceAdapter, WaitSourceAdapters } from "../control/types";
import { getTarget } from "../decision-bot/mailbox";
import { resumeGrantMismatch } from "./recovery";

type MailboxTarget = {
  consumer_owner: string; approval_id: string; target_version: string; effect: string; expires_at: number;
  state: string; consumed_at: number | null; work_id: string | null; contract_revision: number | null; attempt_id: string | null;
};

/**
 * Verifies a pre-existing resume grant against the explicit mailbox DB (§4.2 rule 5). Every mailbox fact must match
 * exactly, and a `resume_checkpoint` target must pin the frozen grant scope — this post-condition, Attention
 * revision, checkpoint reference, expiry and execution owner — with the decision owner's approval pending
 * (`resumeGrantMismatch`, the same binding every dispatch revalidates). A pre-authorized answer carries no answer
 * value, so `answer_blocked_request` stays unverifiable. `authorization_json` is never treated as the authority.
 */
function verifyResumeGrant(db: Database, mailbox: Database, input: { work_id: string; item_id: string; condition: WaitCondition }, grant: WaitResumeGrant, now: number): void {
  const workId = input.work_id;
  const reject = (reason: string): never => { throw new ControlError("conflict", `invalid authorization: ${reason}`); };
  const hasTable = (name: string) => !!mailbox.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  if (!hasTable("approval_targets") || !hasTable("decision_receipts")) reject("mailbox has no approval targets");
  const target = mailbox.query(`SELECT consumer_owner,approval_id,target_version,effect,expires_at,state,consumed_at,work_id,contract_revision,attempt_id
    FROM approval_targets WHERE consumer_owner=? AND approval_id=?`).get(grant.consumer_owner, grant.approval_id) as MailboxTarget | null;
  if (!target) return reject("approval target not found");
  if (target.state !== "active" || target.consumed_at !== null) reject(`approval target is ${target.state}`);
  if (target.target_version !== grant.target_version) reject("stale target version");
  if (target.expires_at !== grant.expires_at || now >= target.expires_at) reject("approval expired or expiry mismatch");
  if (mailbox.query("SELECT 1 FROM decision_receipts WHERE consumer_owner=? AND approval_id=? AND target_version=?").get(grant.consumer_owner, grant.approval_id, grant.target_version)) {
    reject("approval already consumed");
  }
  if (target.work_id !== workId || target.contract_revision !== grant.work_revision) reject("work scope mismatch");
  if (target.attempt_id !== grant.attempt_id) reject("attempt mismatch");
  if (target.effect !== grant.approved_effect) reject("approved effect mismatch");
  if (grant.approved_effect !== "resume_checkpoint") {
    throw new ControlError("blocked", "authorization_post_condition_unverifiable: a pre-authorized answer has no mailbox representation");
  }
  const mismatch = resumeGrantMismatch(mailbox, getTarget(mailbox, grant.consumer_owner, grant.approval_id)!, grant, {
    item_id: input.item_id, decision_owner: getWork(db, workId)?.contract?.decision_owner, condition: input.condition,
  });
  if (mismatch) reject(mismatch.detail);
}

/**
 * Creates a condition wait: local preflight (no IO) → live source baseline via the injected adapter →
 * explicit mailbox verification for `authorized_resume` → synchronous `createConditionWait`.
 * External IO never runs inside a SQLite transaction; the store re-validates Work/item/owner on insert.
 */
export async function createWait(
  db: Database,
  input: CreateWaitInput,
  deps: { actor: string; adapters: WaitSourceAdapters; mailbox: Database; now?: () => number; signal: AbortSignal },
): Promise<ConditionWait> {
  const clock = deps.now ?? Date.now;
  const normalized = preflightConditionWait(db, input, { actor: deps.actor, now: clock() });
  const adapter = deps.adapters?.[normalized.condition.kind] as WaitSourceAdapter | undefined;
  if (!adapter || adapter.kind !== normalized.condition.kind) throw new ControlError("invalid", `no source adapter for ${normalized.condition.kind}`);
  deps.signal.throwIfAborted();
  const baseline: WaitBaselineSnapshot = await adapter.establishBaseline(normalized.condition, { now: clock(), signal: deps.signal });
  deps.signal.throwIfAborted();
  if (normalized.disposition.kind === "authorized_resume") verifyResumeGrant(db, deps.mailbox, normalized, normalized.disposition.authorization, clock());
  return createConditionWait(db, normalized, { actor: deps.actor, baseline, now: clock() });
}
