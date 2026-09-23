// DBT-10: reconcileEffectEvents ingests control_event journal rows into the
// mailbox receipt ledger, advancing the ingest_seq cursor. Local tmp DBs only.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openMailbox,
  registerTarget,
  writeHumanAnswer,
  consumeDecision,
  receipt,
  reconcileEffectEvents,
} from "./mailbox";

function makeLedger(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec(`CREATE TABLE journal(
    ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL
  );`);
  return db;
}

test("DBT-10 reconcileEffectEvents advances cursor and applies an effect_observed row", () => {
  const root = mkdtempSync(join(tmpdir(), "dbt-reconcile-"));
  try {
    const mailbox = openMailbox(join(root, "mail.db"));
    const ledgerPath = join(root, "ledger.db");
    const ledger = makeLedger(ledgerPath);

    // Seed a target + human answer + consumed receipt so the effect can land.
    const target = registerTarget(mailbox, {
      consumerOwner: "extension", approvalId: "a", question: "Q",
      options: ["approve"], effect: "push", scope: { gate: "g" },
      evidence: { command: "git push" }, expiresAt: Date.now() + 60_000,
    });
    writeHumanAnswer(mailbox, "extension", "a", "approve", "ui", 1);
    const r = consumeDecision(mailbox, {
      consumerOwner: "extension", approvalId: "a", targetVersion: target.targetVersion,
      policyHash: "p", now: 2, liveValid: () => true, policyValid: () => true,
    })!;

    // Journal two control_event rows: one effect_observed (valid), one invalid
    // (malformed state) that must be skipped by validation.
    const good = JSON.stringify({
      event_kind: "effect_observed",
      payload: { receipt_id: r.receiptId, toolCallId: "tool-1", effect_state: "succeeded", evidence: { ok: true } },
    });
    const bad = JSON.stringify({
      event_kind: "effect_observed",
      payload: { receipt_id: r.receiptId, toolCallId: "tool-2", effect_state: "bogus", evidence: {} },
    });
    ledger.run("INSERT INTO journal(at,kind,detail) VALUES(?,?,?)", [10, "control_event", good]);
    ledger.run("INSERT INTO journal(at,kind,detail) VALUES(?,?,?)", [11, "control_event", bad]);
    ledger.close();

    reconcileEffectEvents(mailbox, ledgerPath, 12);

    // The good row applied: receipt outcome became succeeded.
    expect(receipt(mailbox, "extension", "a")?.outcome).toBe("succeeded");
    // Cursor advanced to the high-water mark (2) even though row 2 was invalid.
    expect((mailbox.query("SELECT ingest_seq FROM effect_reconcile_cursor WHERE id=1").get() as any).ingest_seq).toBe(2);

    // A second reconcile with no new journal rows is a no-op (cursor continues).
    reconcileEffectEvents(mailbox, ledgerPath, 13);
    expect((mailbox.query("SELECT ingest_seq FROM effect_reconcile_cursor WHERE id=1").get() as any).ingest_seq).toBe(2);

    mailbox.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
