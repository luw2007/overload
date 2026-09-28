// Gap-fill: redirectWork activate/pause branches + listAttention done zone.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWork, ensureControlSchema, listAttention, redirectWork, upsertAttention } from "./store";
import type { Contract } from "./types";

const contract: Contract = {
  objective: "ship",
  acceptance: [{ id: "human", kind: "human", description: "owner accepts" }],
  non_goals: [],
  scope: { allowed_effects: ["write"] },
  budget: { retry_limit: 1 },
  stop_conditions: [{ id: "risk", kind: "hard", description: "d" }],
  decision_owner: "owner",
};
function db() {
  const d = new Database(":memory:");
  ensureControlSchema(d);
  return d;
}

test("CTRL-10 redirectWork activate reopens a stopped work", () => {
  const d = db();
  const w = createWork(d, { title: "w", source: "t", contract }, 1);
  redirectWork(d, w.work_id, 1, { reason: "paused", affected_work_ids: [], action: "stop" }, 2);
  const activated = redirectWork(d, w.work_id, 2, { reason: "resumed", affected_work_ids: [], action: "activate" }, 3);
  expect(activated.state).toBe("active");
  d.close();
});

test("CTRL-13 listAttention done zone returns resolved/superseded only", () => {
  const d = db();
  const w = createWork(d, { title: "w", source: "t", contract }, 1);
  upsertAttention(d, {
    item_id: "done-1", work_id: w.work_id, state: "resolved", effect_state: "succeeded",
    urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 2);
  upsertAttention(d, {
    item_id: "open-1", work_id: w.work_id, state: "open", effect_state: "not_started",
    urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 3);
  expect(listAttention(d, "done", 4).map((x) => x.item_id)).toEqual(["done-1"]);
  expect(listAttention(d, "now", 4).map((x) => x.item_id)).toEqual(["open-1"]);
  d.close();
});
