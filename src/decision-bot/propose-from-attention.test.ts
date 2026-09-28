// DBT-24: proposeRuleFromAttention derives a bot rule candidate from an open,
// non-human-only attention card bound to an active, unexpired target.
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailbox, registerTarget } from "./mailbox";
import { createWork, upsertAttention, type Contract } from "../control/store";
import { proposeRuleFromAttention } from "./policy";

const contract: Contract = {
  objective: "ship",
  acceptance: [{ id: "human", kind: "human", description: "owner accepts" }],
  non_goals: [],
  scope: { allowed_effects: ["write"] },
  budget: { retry_limit: 1 },
  stop_conditions: [{ id: "risk", kind: "hard", description: "destructive" }],
  decision_owner: "owner",
};

test("DBT-24 proposeRuleFromAttention derives a rule candidate for an eligible card", () => {
  const root = mkdtempSync(join(tmpdir(), "dbt-propose-"));
  try {
    const db = openMailbox(join(root, "mail.db"));
    const work = createWork(db, { title: "w", source: "t", contract }, 1);
    const target = registerTarget(db, {
      consumerOwner: "extension", approvalId: "a", question: "push?",
      options: ["approve", "deny"], effect: "push",
      scope: { gate: "action", cwd: "/repo" },
      evidence: { command: "git push" }, expiresAt: Date.now() + 60_000,
      workId: work.work_id, contractRevision: 1, decisionMode: "scoped_auto",
    } as any);
    upsertAttention(db, {
      item_id: "attn-1", work_id: work.work_id, state: "open",
      effect_state: "not_started", urgency: "now", conclusion: "push?",
      trigger: "risk", impact: "blocked", recommendation: "approve",
      options: ["approve", "deny"], owner: "owner", expires_at: null,
      source_link: null, approval_id: "a", consumer_owner: "extension",
      contract_revision: 1, decision_mode: "scoped_auto", evidence: {},
    }, 2);

    const result = proposeRuleFromAttention(db, "attn-1", "approve", "operator", 1000);
    expect(result.ok).toBe(true);
    expect(result.candidate?.rule.id.startsWith("attention-")).toBe(true);
    expect(result.candidate?.rule.answers).toEqual(["approve"]);
    expect(result.candidate?.rule.cwd).toBe("/repo");
    expect(result.candidate?.rule.command).toBe("git push");
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DBT-24 proposeRuleFromAttention rejects human-only and expired cards", () => {
  const root = mkdtempSync(join(tmpdir(), "dbt-propose-rej-"));
  try {
    const db = openMailbox(join(root, "mail.db"));
    const work = createWork(db, { title: "w", source: "t", contract }, 1);
    registerTarget(db, {
      consumerOwner: "extension", approvalId: "a", question: "push?",
      options: ["approve"], effect: "push", scope: { gate: "action", cwd: "/repo" },
      evidence: { command: "git push" }, expiresAt: Date.now() + 60_000,
      workId: work.work_id, contractRevision: 1, decisionMode: "scoped_auto",
    } as any);
    // human_only attention -> ineligible
    upsertAttention(db, {
      item_id: "h", work_id: work.work_id, state: "open", effect_state: "not_started",
      urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
      options: ["approve"], owner: "owner", expires_at: null, source_link: null,
      approval_id: "a", consumer_owner: "extension", contract_revision: 1,
      decision_mode: "human_only", evidence: {},
    }, 2);
    expect(proposeRuleFromAttention(db, "h", "approve", "op", 1000).ok).toBe(false);

    // expired target -> stale_or_human_only_target
    upsertAttention(db, {
      item_id: "e", work_id: work.work_id, state: "open", effect_state: "not_started",
      urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
      options: ["approve"], owner: "owner", expires_at: null, source_link: null,
      approval_id: "a", consumer_owner: "extension", contract_revision: 1,
      decision_mode: "scoped_auto", evidence: {},
    }, 3);
    const future = Date.now() + 100_000; // call far in the future -> target expired
    expect(proposeRuleFromAttention(db, "e", "approve", "op", future).ok).toBe(false);

    // invalid answer not in options
    expect(proposeRuleFromAttention(db, "e", "deny", "op", 1000).ok).toBe(false);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
