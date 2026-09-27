// DBT-10: reconcileEffectEvents folds ledger-applied control_event journal rows into the mailbox receipt ledger,
// advancing the ingest_seq cursor no further than the reducer. Local tmp DBs only; the real ingest reducer decides
// which rows are applied and which are quarantined.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { controlPayloadHash } from "../control/outbox";
import { initializeLedger } from "../ingest/ingest";
import { reduceJournal } from "../ingest/reducer";
import {
  openMailbox,
  registerTarget,
  writeHumanAnswer,
  consumeDecision,
  receipt,
  reconcileEffectEvents,
  type Receipt,
} from "./mailbox";

function makeLedger(path: string): Database {
  const db = new Database(path, { create: true });
  initializeLedger(db);
  return db;
}

let seq = 0;
function journal(ledger: Database, at: number, detail: Record<string, unknown>): void {
  seq += 1;
  ledger.query(`INSERT INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail)
    VALUES ('local', 'pi-1', ?, ?, 'local:pi:s', 'pi-1', 'control_event', ?)`).run(seq, at, JSON.stringify(detail));
}

function effectEvent(receiptId: string, toolCallId: string, state: string, output: string): Record<string, unknown> {
  const payload = { receipt_id: receiptId, toolCallId, effect: "push", effect_state: state, evidence: { output } };
  return { event_id: `extension:${receiptId}:${toolCallId}:effect_observed`, producer_id: "extension:pi-1", entity_id: receiptId, entity_version: 1, event_kind: "effect_observed", payload, payload_hash: controlPayloadHash(payload) };
}

function consumedReceipt(mailbox: Database, approvalId: string): Receipt {
  const target = registerTarget(mailbox, {
    consumerOwner: "extension", approvalId, question: "Q",
    options: ["approve"], effect: "push", scope: { gate: "g" },
    evidence: { command: "git push" }, expiresAt: Date.now() + 60_000,
  });
  writeHumanAnswer(mailbox, "extension", approvalId, "approve", "ui", 1);
  return consumeDecision(mailbox, {
    consumerOwner: "extension", approvalId, targetVersion: target.targetVersion,
    policyHash: "p", now: 2, liveValid: () => true, policyValid: () => true,
  })!;
}

const cursorOf = (mailbox: Database) => (mailbox.query("SELECT ingest_seq FROM effect_reconcile_cursor WHERE id=1").get() as { ingest_seq: number }).ingest_seq;

test("DBT-10 reconcileEffectEvents advances cursor and applies an effect_observed row", () => {
  const root = mkdtempSync(join(tmpdir(), "dbt-reconcile-"));
  try {
    const mailbox = openMailbox(join(root, "mail.db"));
    const ledgerPath = join(root, "ledger.db");
    const ledger = makeLedger(ledgerPath);
    const r = consumedReceipt(mailbox, "a");

    // One valid effect_observed row, one applied row with a malformed state that validation must skip.
    journal(ledger, 10, effectEvent(r.receiptId, "tool-1", "succeeded", "ok"));
    journal(ledger, 11, effectEvent(r.receiptId, "tool-2", "bogus", "no"));
    expect(reduceJournal(ledger)).toBe(2);
    ledger.close();

    reconcileEffectEvents(mailbox, ledgerPath, 12);
    expect(receipt(mailbox, "extension", "a")?.outcome).toBe("succeeded");
    expect(cursorOf(mailbox)).toBe(2);

    // A second reconcile with no new journal rows is a no-op (cursor holds).
    reconcileEffectEvents(mailbox, ledgerPath, 13);
    expect(cursorOf(mailbox)).toBe(2);
    mailbox.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("quarantined, mismatched and unreduced effect events never change receipts; the valid event reconciles", () => {
  const root = mkdtempSync(join(tmpdir(), "dbt-reconcile-"));
  try {
    const mailbox = openMailbox(join(root, "mail.db"));
    const ledgerPath = join(root, "ledger.db");
    const ledger = makeLedger(ledgerPath);
    const tampered = consumedReceipt(mailbox, "tampered");
    const valid = consumedReceipt(mailbox, "valid");
    const pending = consumedReceipt(mailbox, "pending");

    // seq 1: payload rewritten after hashing — the reducer quarantines it.
    const forged = effectEvent(tampered.receiptId, "tool-1", "failed", "forged");
    journal(ledger, 10, { ...forged, payload: { ...(forged.payload as Record<string, unknown>), effect_state: "succeeded" } });
    // seq 2: the valid event for the other receipt.
    const good = effectEvent(valid.receiptId, "tool-1", "succeeded", "ok");
    journal(ledger, 11, good);
    // seq 3: same identity, self-consistent second payload — identity mismatch, quarantined.
    journal(ledger, 12, { ...effectEvent(valid.receiptId, "tool-1", "failed", "rewritten"), event_id: good.event_id });
    expect(reduceJournal(ledger)).toBe(3);
    expect(ledger.query("SELECT from_seq, reason FROM coverage_gaps ORDER BY from_seq").all()).toEqual([
      { from_seq: 1, reason: "control_event_rejected" }, { from_seq: 3, reason: "control_event_rejected" },
    ]);
    // seq 4: valid but not yet reduced — must wait for the reducer.
    journal(ledger, 13, effectEvent(pending.receiptId, "tool-1", "succeeded", "later"));

    reconcileEffectEvents(mailbox, ledgerPath, 20);
    expect(receipt(mailbox, "extension", "tampered")).toMatchObject({ appliedAt: null, outcome: null });
    expect(receipt(mailbox, "extension", "valid")).toMatchObject({ appliedAt: 11, outcome: "succeeded" });
    expect(receipt(mailbox, "extension", "pending")).toMatchObject({ appliedAt: null, outcome: null });
    expect(cursorOf(mailbox)).toBe(3);

    // Once reduced, the pending event reconciles; replaying from zero is idempotent.
    expect(reduceJournal(ledger)).toBe(1);
    ledger.close();
    reconcileEffectEvents(mailbox, ledgerPath, 21);
    expect(receipt(mailbox, "extension", "pending")).toMatchObject({ appliedAt: 13, outcome: "succeeded" });
    expect(cursorOf(mailbox)).toBe(4);
    const effects = "SELECT receipt_id, tool_call_id, state FROM receipt_effect_observations ORDER BY receipt_id, tool_call_id";
    const settled = mailbox.query(effects).all();
    mailbox.run("UPDATE effect_reconcile_cursor SET ingest_seq=0 WHERE id=1");
    reconcileEffectEvents(mailbox, ledgerPath, 22);
    expect(mailbox.query(effects).all()).toEqual(settled);
    expect(receipt(mailbox, "extension", "tampered")).toMatchObject({ appliedAt: null, outcome: null });
    expect(receipt(mailbox, "extension", "valid")).toMatchObject({ appliedAt: 11, outcome: "succeeded" });
    expect(cursorOf(mailbox)).toBe(4);
    mailbox.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
