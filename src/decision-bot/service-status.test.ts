// DBT-30: DecisionBotService.status is a pure read of targets + attempts sorted
// expires_at / started_at DESC. Instantiate on a tmp mailbox and assert shape.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailbox, registerTarget } from "./mailbox";
import { DecisionBotService } from "./service";

test("DBT-30 DecisionBotService.status returns identity, targets and recent attempts", () => {
  const root = mkdtempSync(join(tmpdir(), "dbt-status-"));
  try {
    const db = openMailbox(join(root, "m.db"));
    const service = new DecisionBotService(db);
    const t1 = registerTarget(db, {
      consumerOwner: "extension", approvalId: "older", question: "Q1",
      options: ["ok"], effect: "push", scope: { gate: "g" }, evidence: {},
      expiresAt: 100,
    });
    const t2 = registerTarget(db, {
      consumerOwner: "extension", approvalId: "newer", question: "Q2",
      options: ["ok"], effect: "push", scope: { gate: "g" }, evidence: {},
      expiresAt: 300,
    });
    // Seed two attempts with distinct started_at; status sorts attempts DESC.
    db.run("INSERT INTO bot_attempts(attempt_id,bot_id,consumer_owner,approval_id,target_version,owner_token,lease_expires_at,policy_hash,evidence_hash,state,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ["a1", service.owner, "extension", "older", t1.targetVersion, "tok", 500, "h", t1.evidenceHash, "proposed", 10, null]);
    db.run("INSERT INTO bot_attempts(attempt_id,bot_id,consumer_owner,approval_id,target_version,owner_token,lease_expires_at,policy_hash,evidence_hash,state,started_at,finished_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      ["a2", service.owner, "extension", "newer", t2.targetVersion, "tok", 600, "h", t2.evidenceHash, "escalated", 20, null]);

    const status = service.status() as { identity: string; targets: any[]; attempts: any[] };
    expect(status.identity).toBe(service.identity());
    expect(status.identity).toMatch(/^[0-9a-f-]{36}$/);
    expect(status.targets.map((t) => t.approval_id).sort()).toEqual(["newer", "older"].sort());
    // attempts ordered by started_at DESC -> newest (a2) first.
    expect(status.attempts[0].attempt_id).toBe("a2");
    expect(status.attempts[1].attempt_id).toBe("a1");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
