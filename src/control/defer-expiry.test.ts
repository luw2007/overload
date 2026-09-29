// A05 end-to-end: deferring presentation cannot widen authority.
// Contract §5 invariant 8 — "Expiry is independent of defer. Deferring presentation cannot extend approval
// expiry, consume an expired answer, or reset retry/notification budgets." The store half (expires_at is not
// touched) lives in store-extra.test.ts; here the deferred Attention card is linked to its real mailbox
// approval target, because that is the only place the "cannot widen authority" claim is observable.
//
// openMailbox installs the mailbox schema and then calls ensureControlSchema, so one file carries both — the
// same arrangement production uses (OVERLOAD_ANSWERS_PATH). Mailbox functions are imported read-only; this
// file does not modify src/decision-bot/**.
import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeDecision,
  expireActiveTargets,
  getTarget,
  openMailbox,
  receipt,
  registerTarget,
  writeHumanAnswer,
} from "../decision-bot/mailbox";
import { actOnAttention, createWork, getAttention, upsertAttention } from "./store";
import type { Contract } from "./types";

const contract: Contract = {
  objective: "ship",
  acceptance: [{ id: "human", kind: "human", description: "owner accepts" }],
  non_goals: [],
  scope: { allowed_effects: ["write"] },
  budget: { retry_limit: 1 },
  stop_conditions: [{ id: "risk", kind: "hard", description: "destructive" }],
  decision_owner: "owner",
};

const T = 1_700_000_000_000;
const EXPIRES_AT = T + 5_000;
const DEFER_UNTIL = T + 50_000; // deliberately far beyond the approval's own expiry

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** One database holding both the mailbox and the control schema, with a deferred approval-linked card. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overload-defer-expiry-")); roots.push(root);
  const db = openMailbox(join(root, "answers.db"));
  const work = createWork(db, { title: "release", source: "test", contract }, T);
  const target = registerTarget(db, {
    consumerOwner: "extension", approvalId: "approval-defer", question: "Proceed?",
    options: ["approve", "reject"], effect: "run", scope: { work_id: work.work_id },
    evidence: { toolCallId: "tool-1" }, expiresAt: EXPIRES_AT, workId: work.work_id,
    contractRevision: work.revision, decisionMode: "human_only", toolCallId: "tool-1", attemptId: "attempt-1",
  });
  const item = upsertAttention(db, {
    item_id: "deferred-approval", work_id: work.work_id, state: "open", effect_state: "not_started",
    urgency: "now", conclusion: "Approve the push", trigger: "risk", impact: "release waits",
    recommendation: "approve", options: ["approve", "reject"], owner: "owner", expires_at: EXPIRES_AT,
    source_link: null, approval_id: "approval-defer", consumer_owner: "extension",
    contract_revision: work.revision, decision_mode: "human_only", evidence: {},
  }, T);
  const deferred = actOnAttention(db, item.item_id, item.revision, "defer", { defer_until: DEFER_UNTIL }, "owner", T + 1_000);
  // The card the user pushed out still carries the approval's original expiry.
  expect(deferred).toMatchObject({ defer_until: DEFER_UNTIL, expires_at: EXPIRES_AT, revision: item.revision + 1 });
  return { db, item, target };
}

function consume(db: Database, targetVersion: string, now: number) {
  return consumeDecision(db, {
    consumerOwner: "extension", approvalId: "approval-defer", targetVersion, policyHash: "human", now,
    liveValid: () => true, contractValid: () => true, policyValid: () => true,
  });
}

test("A05 an answer recorded before a defer is never consumed after the original expiry", () => {
  const { db, item, target } = fixture();

  // A valid human answer is recorded while the approval is still live.
  expect(writeHumanAnswer(db, "extension", "approval-defer", "approve", "web", T + 2_000)).toEqual({ ok: true });

  // Past the approval's own expiry, but well inside the deferral the user chose.
  const afterExpiry = EXPIRES_AT + 1;
  expect(getAttention(db, item.item_id)?.defer_until).toBeGreaterThan(afterExpiry);

  expect(consume(db, target.targetVersion, afterExpiry)).toBeNull();
  expect(receipt(db, "extension", "approval-defer")).toBeNull();
  // The stale answer is still parked, and it is still not authority: re-consuming cannot resurrect it.
  expect(db.query("SELECT answer FROM answers WHERE approval_id=?").get("approval-defer")).toEqual({ answer: "approve" });
  expect(consume(db, target.targetVersion, DEFER_UNTIL + 1)).toBeNull();
  expect(receipt(db, "extension", "approval-defer")).toBeNull();

  // The approval closes on its own schedule; the deferral bought it no extra life.
  expect(expireActiveTargets(db, afterExpiry)).toBe(1);
  expect(getTarget(db, "extension", "approval-defer")).toMatchObject({ state: "closed", expiresAt: EXPIRES_AT });
  expect(db.query("SELECT state,outcome FROM approval_targets WHERE approval_id=?").get("approval-defer"))
    .toEqual({ state: "closed", outcome: "expired" });
  db.close();
});

test("A05 after the original expiry a deferred card refuses a new answer as expired", () => {
  const { db, item, target } = fixture();
  const afterExpiry = EXPIRES_AT + 1;
  expect(getAttention(db, item.item_id)?.defer_until).toBeGreaterThan(afterExpiry);

  expect(writeHumanAnswer(db, "extension", "approval-defer", "approve", "web", afterExpiry))
    .toEqual({ ok: false, reason: "expired" });
  // The refusal is durable: the target is closed as expired, not left active for a later attempt.
  expect(db.query("SELECT state,outcome FROM approval_targets WHERE approval_id=?").get("approval-defer"))
    .toEqual({ state: "closed", outcome: "expired" });
  expect(db.query("SELECT COUNT(*) n FROM answers WHERE approval_id=?").get("approval-defer")).toEqual({ n: 0 });
  expect(consume(db, target.targetVersion, afterExpiry)).toBeNull();
  expect(receipt(db, "extension", "approval-defer")).toBeNull();

  // The card itself is untouched by the lapsed approval: still open, still at its deferred revision.
  expect(getAttention(db, item.item_id)).toMatchObject({
    state: "open", effect_state: "not_started", expires_at: EXPIRES_AT, defer_until: DEFER_UNTIL,
  });
  db.close();
});
