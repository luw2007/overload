import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWork, ensureControlSchema, getAttention, projectAttentionEffect, upsertAttention } from "./store";
import type { Contract } from "./types";

/** Check-only acceptance: a succeeded effect leaves no outstanding human responsibility. */
const verifiedContract: Contract = {
  objective: "ship",
  acceptance: [{ id: "check", kind: "check", description: "tests", evidence: "passed" }],
  non_goals: [],
  scope: { allowed_effects: ["write"] },
  budget: {},
  stop_conditions: [],
  decision_owner: "owner",
};
/** The same work with an unmet human criterion: success alone must not close it. */
const acceptanceContract: Contract = {
  ...verifiedContract,
  acceptance: [{ id: "human", kind: "human", description: "owner accepts" }],
};

function fixture(contract: Contract) {
  const d = new Database(":memory:");
  ensureControlSchema(d);
  // projectAttentionEffect only trusts observations the mailbox already accepted; this is the
  // mailbox-owned table it re-reads, declared here exactly as the mailbox declares it.
  d.exec(`CREATE TABLE receipt_effect_observations(receipt_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,attempt_id TEXT,
    state TEXT NOT NULL,evidence TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(receipt_id,tool_call_id));`);
  const work = createWork(d, { title: "effect", source: "test", contract }, 1);
  const item = upsertAttention(d, {
    item_id: "effect", work_id: work.work_id, state: "applying", effect_state: "applying", urgency: "now",
    conclusion: "choose", trigger: "risk", impact: "impact", recommendation: null, options: ["continue"],
    owner: "owner", expires_at: null, source_link: null, approval_id: "approval", consumer_owner: "orchestrator",
    contract_revision: work.revision, decision_mode: "human_only", evidence: {},
  }, 1);
  const link = {
    work_id: work.work_id, item_id: item.item_id, item_revision: item.revision,
    approval_id: "approval", receipt_id: "receipt", outbox_event_id: "source-event",
  };
  return { d, work, item, link };
}

function succeeded(d: Database, at: number) {
  const evidence = { effect: "pr created" };
  d.query("INSERT OR IGNORE INTO receipt_effect_observations VALUES (?,?,?,?,?,?)")
    .run("receipt", "tool-ok", null, "succeeded", JSON.stringify(evidence), at);
  return { receiptId: "receipt", toolCallId: "tool-ok", attemptId: null, state: "succeeded", evidence, observedAt: at } as const;
}

function projectionRows(d: Database, itemId: string) {
  const count = (sql: string) => (d.query(sql).get(itemId) as { n: number }).n;
  return {
    outbox: count("SELECT COUNT(*) n FROM control_outbox WHERE item_id=? AND kind='attention.effect_projected'"),
    events: count("SELECT COUNT(*) n FROM control_attention_events WHERE item_id=? AND kind='effect_projected'"),
  };
}

describe("A14 verified effect closure", () => {
  test("succeeded with no remaining responsibility resolves the item and records verification", () => {
    const { d, item, link } = fixture(verifiedContract);
    const resolved = projectAttentionEffect(d, link, succeeded(d, 3), 4);

    expect(resolved).toMatchObject({
      item_id: item.item_id, state: "resolved", effect_state: "succeeded", revision: item.revision + 1,
    });
    expect(resolved.evidence.effect_verified_at).toBe(3);
    expect(resolved.evidence.remaining_responsibility).toBeUndefined();
    expect(resolved.evidence.occurred_effects).toEqual([
      { kind: "tool-ok", evidence: { effect: "pr created" }, state: "succeeded", observed_at: 3 },
    ]);
    expect(getAttention(d, item.item_id)).toMatchObject({
      state: "resolved", effect_state: "succeeded", revision: item.revision + 1,
    });
    expect(projectionRows(d, item.item_id)).toEqual({ outbox: 1, events: 1 });
    d.close();
  });

  test("replaying the identical succeeded observation resolves once and enqueues no second projection", () => {
    const { d, item, link } = fixture(verifiedContract);
    const resolved = projectAttentionEffect(d, link, succeeded(d, 3), 4);

    // The link still carries the pre-projection revision: a duplicate delivery must be absorbed
    // as the same observation, not rejected as a stale CAS and not applied twice.
    const replay = projectAttentionEffect(d, link, succeeded(d, 3), 5);

    expect(replay).toMatchObject({ revision: resolved.revision, state: "resolved", effect_state: "succeeded" });
    expect(replay.evidence.effect_verified_at).toBe(3);
    expect(replay.updated_at).toBe(resolved.updated_at);
    expect(replay.evidence.occurred_effects).toEqual(resolved.evidence.occurred_effects);
    expect(getAttention(d, item.item_id)).toMatchObject({ revision: resolved.revision, state: "resolved" });
    expect(projectionRows(d, item.item_id)).toEqual({ outbox: 1, events: 1 });
    d.close();
  });

  test("succeeded with outstanding human acceptance stays applying instead of resolving", () => {
    const { d, item, link } = fixture(acceptanceContract);
    const applying = projectAttentionEffect(d, link, succeeded(d, 3), 4);

    expect(applying).toMatchObject({ state: "applying", effect_state: "succeeded", revision: item.revision + 1 });
    expect(applying.evidence.remaining_responsibility).toBe("owner accepts");
    expect(applying.evidence.effect_verified_at).toBeUndefined();
    d.close();
  });
});
