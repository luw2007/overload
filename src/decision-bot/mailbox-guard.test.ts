// Gap-fill: guard branches not covered by the happy-path mailbox tests.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMailbox, registerTarget, writeHumanAnswer, consumeDecision,
  observeReceiptEffect, reconcileOutstandingReceipts,
} from "./mailbox";

function make(expiresAtOffset = 60_000) {
  const root = mkdtempSync(join(tmpdir(), "mailbox-guard-"));
  const db = openMailbox(join(root, "m.db"));
  const t = registerTarget(db, {
    consumerOwner: "extension", approvalId: "a", question: "Q",
    options: ["approve", "deny"], effect: "push", scope: { gate: "g" },
    evidence: { command: "git push" }, expiresAt: Date.now() + expiresAtOffset,
  });
  return { root, db, t, close() { db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("DBT-05 writeHumanAnswer rejects expired target and invalid option", () => {
  const f = make(-1); // already expired
  try {
    expect(writeHumanAnswer(f.db, "extension", "a", "approve").ok).toBe(false);
  } finally { f.close(); }

  const g = make();
  try {
    expect(writeHumanAnswer(g.db, "extension", "a", "banana").ok).toBe(false);
  } finally { g.close(); }
});

test("DBT-08 observeReceiptEffect rejects conflicting state on same toolCallId", () => {
  const f = make();
  try {
    writeHumanAnswer(f.db, "extension", "a", "approve", "ui", 1);
    const r = consumeDecision(f.db, {
      consumerOwner: "extension", approvalId: "a", targetVersion: f.t.targetVersion,
      policyHash: "p", now: 2, liveValid: () => true, policyValid: () => true,
    })!;
    expect(observeReceiptEffect(f.db, { receiptId: r.receiptId, toolCallId: "t", state: "succeeded", evidence: { ok: true }, observedAt: 3 })).toBe(true);
    expect(() => observeReceiptEffect(f.db, { receiptId: r.receiptId, toolCallId: "t", state: "failed", evidence: { ok: true }, observedAt: 4 })).toThrow("conflicting_effect_observation");
  } finally { f.close(); }
});

test("DBT-09 reconcileOutstandingReceipts marks overdue unknown receipts", () => {
  const f = make();
  try {
    writeHumanAnswer(f.db, "extension", "a", "approve", "ui", 1);
    const r = consumeDecision(f.db, {
      consumerOwner: "extension", approvalId: "a", targetVersion: f.t.targetVersion,
      policyHash: "p", now: 10, liveValid: () => true, policyValid: () => true,
    })!;
    // No effect observed yet; consumed_at=10. Deadline 100 -> now 200 marks unknown.
    expect(reconcileOutstandingReceipts(f.db, 100, 200)).toBe(1);
    expect((f.db.query("SELECT outcome FROM decision_receipts WHERE receipt_id=?").get(r.receiptId) as any).outcome).toBe("unknown");
  } finally { f.close(); }
});
