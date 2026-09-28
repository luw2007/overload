import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  consumeDecision,
  observeReceiptEffect,
  openMailbox,
  receipt,
  registerTarget,
  writeHumanAnswer,
} from "./mailbox";
import {
  createWork,
  listAttentionFollowUps,
  projectAttentionEffect,
  upsertAttention,
} from "../control/store";

function register(db: Database) {
  return registerTarget(db, {
    consumerOwner: "extension",
    approvalId: "approval-1",
    question: "Proceed?",
    options: ["approve", "reject"],
    effect: "run",
    scope: { work_id: "work-1" },
    evidence: { toolCallId: "tool-1" },
    expiresAt: 10_000,
    toolCallId: "tool-1",
    attemptId: "attempt-1",
  });
}

function consume(db: Database, targetVersion: string, now: number) {
  return consumeDecision(db, {
    consumerOwner: "extension",
    approvalId: "approval-1",
    targetVersion,
    policyHash: "human",
    now,
    liveValid: () => true,
    contractValid: () => true,
    policyValid: () => true,
  });
}

test("A09 two connections share one target credential and exactly one consumption", async () => {
  const root = mkdtempSync(join(tmpdir(), "mailbox-race-"));
  const path = join(root, "answers.db");
  const first = openMailbox(path);
  const second = openMailbox(path);
  try {
    const target = register(first);
    expect(writeHumanAnswer(first, "extension", "approval-1", "approve", "web", 1)).toEqual({ ok: true });

    const settled = await Promise.allSettled([
      Promise.resolve().then(() => consume(first, target.targetVersion, 2)),
      Promise.resolve().then(() => consume(second, target.targetVersion, 2)),
    ]);
    const values = settled.map((result) => result.status === "fulfilled" ? result.value : null);
    expect(values.filter(Boolean)).toHaveLength(1);
    expect(receipt(first, "extension", "approval-1")?.targetVersion).toBe(target.targetVersion);
    expect(writeHumanAnswer(second, "extension", "approval-1", "reject", "feishu", 3))
      .toEqual({ ok: false, reason: "already_consumed" });
  } finally {
    first.close();
    second.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A15 consumption credential and effect receipt survive restart and replay", () => {
  const root = mkdtempSync(join(tmpdir(), "mailbox-restart-"));
  const path = join(root, "answers.db");
  let db = openMailbox(path);
  try {
    const target = register(db);
    expect(writeHumanAnswer(db, "extension", "approval-1", "approve", "terminal", 1)).toEqual({ ok: true });
    const consumed = consume(db, target.targetVersion, 2);
    expect(consumed).not.toBeNull();
    db.close();

    db = openMailbox(path);
    expect(consume(db, target.targetVersion, 3)).toBeNull();
    expect(receipt(db, "extension", "approval-1")?.receiptId).toBe(consumed?.receiptId);
    const observation = {
      receiptId: consumed!.receiptId,
      toolCallId: "tool-1",
      attemptId: "attempt-1",
      state: "unknown" as const,
      evidence: { diagnostic: "executor restarted before confirmation" },
      observedAt: 4,
    };
    expect(observeReceiptEffect(db, observation)).toBe(true);
    db.close();

    db = openMailbox(path);
    expect(observeReceiptEffect(db, observation)).toBe(true);
    expect(receipt(db, "extension", "approval-1")).toMatchObject({
      appliedAt: 4,
      outcome: "unknown",
    });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A12 distinct effect steps retain partial evidence without claiming aggregate success", () => {
  const root = mkdtempSync(join(tmpdir(), "mailbox-partial-"));
  const db = openMailbox(join(root, "answers.db"));
  try {
    const target = register(db);
    writeHumanAnswer(db, "extension", "approval-1", "approve", "web", 1);
    const consumed = consume(db, target.targetVersion, 2)!;
    expect(observeReceiptEffect(db, {
      receiptId: consumed.receiptId,
      toolCallId: "tool-1",
      attemptId: "attempt-1",
      state: "succeeded",
      evidence: { effect: "pr_created", pr: 42 },
      observedAt: 3,
    })).toBe(true);
    expect(observeReceiptEffect(db, {
      receiptId: consumed.receiptId,
      toolCallId: "tool-1:review-requested",
      attemptId: "attempt-1",
      state: "failed",
      evidence: { effect: "review_requested", error: "permission denied" },
      observedAt: 4,
    })).toBe(true);

    const rows = db.query("SELECT tool_call_id,state,evidence FROM receipt_effect_observations WHERE receipt_id=? ORDER BY observed_at")
      .all(consumed.receiptId) as Array<{ tool_call_id: string; state: string; evidence: string }>;
    expect(rows.map(({ tool_call_id, state }) => ({ tool_call_id, state }))).toEqual([
      { tool_call_id: "tool-1", state: "succeeded" },
      { tool_call_id: "tool-1:review-requested", state: "failed" },
    ]);
    expect(JSON.parse(rows[0]!.evidence)).toEqual({ effect: "pr_created", pr: 42 });
    expect(receipt(db, "extension", "approval-1")?.outcome).toBe("failed");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("A12 multi-observation follow-up separates occurred effects from remaining responsibility", () => {
  const root = mkdtempSync(join(tmpdir(), "mailbox-followup-"));
  const db = openMailbox(join(root, "answers.db"));
  try {
    // A verified check plus a still-unevidenced human acceptance: remaining responsibility must come
    // from the human criterion, so neither effect outcome can author or clear it.
    const work = createWork(db, {
      title: "ship",
      source: "test",
      contract: {
        objective: "ship the change",
        acceptance: [
          { id: "checks", kind: "check", description: "CI is green", evidence: "passed" },
          { id: "owner", kind: "human", description: "Operator accepts the deployed behaviour" },
        ],
        non_goals: [],
        scope: { cwd: root },
        budget: {},
        stop_conditions: [],
        decision_owner: "owner",
      },
    }, 1);
    const target = register(db);
    const item = upsertAttention(db, {
      item_id: "approval-1", work_id: work.work_id, state: "applying", effect_state: "applying",
      urgency: "now", conclusion: "Proceed?", trigger: "risk", impact: "impact", recommendation: null,
      options: ["approve", "reject"], owner: "owner", expires_at: null, source_link: null,
      approval_id: "approval-1", consumer_owner: "extension", contract_revision: work.revision,
      decision_mode: "human_only", evidence: {},
    }, 1);
    writeHumanAnswer(db, "extension", "approval-1", "approve", "web", 1);
    const consumed = consume(db, target.targetVersion, 2)!;

    const observe = (tool: string, state: "succeeded" | "failed", at: number, evidence: Record<string, unknown>) => {
      const observation = { receiptId: consumed.receiptId, toolCallId: tool, attemptId: "attempt-1", state, evidence, observedAt: at };
      expect(observeReceiptEffect(db, observation)).toBe(true);
      return observation;
    };
    const link = {
      work_id: work.work_id, item_id: item.item_id, approval_id: "approval-1",
      receipt_id: consumed.receiptId, outbox_event_id: "source-event",
    };
    const first = projectAttentionEffect(db, { ...link, item_revision: item.revision },
      observe("tool-1", "succeeded", 3, { effect: "pr_created", pr: 42 }), 3);
    const second = projectAttentionEffect(db, { ...link, item_revision: first.revision },
      observe("tool-1:next-step", "failed", 4, { effect: "review_requested", error: "permission denied" }), 4);
    expect(second.effect_state).toBe("failed");

    const followUp = listAttentionFollowUps(db, 10).find((entry) => entry.item.item_id === item.item_id);
    if (!followUp) throw new Error("follow-up entry missing");
    // Both steps survive in observed_at order, each keeping its own state: the succeeded step is not
    // erased by the later failure, and the item is not presented as if it never executed.
    expect(followUp.occurred_effects).toEqual([
      { kind: "tool-1", evidence: { effect: "pr_created", pr: 42, state: "succeeded", observed_at: 3 } },
      { kind: "tool-1:next-step", evidence: { effect: "review_requested", error: "permission denied", state: "failed", observed_at: 4 } },
    ]);
    // Independent of both outcomes: derived from the pending human acceptance criterion.
    expect(followUp.remaining_responsibility).toBe("Operator accepts the deployed behaviour");
    expect(followUp.stage).toBe("failed");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
