import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  createWork,
  ensureControlSchema,
  getWork,
  listWorks,
  listAttention,
  recordAttentionFeedback,
  redirectWork,
  upsertAttention,
} from "./store";
import { enqueueControlEvent, ensureOutbox, publishControlEvents } from "./outbox";
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

function db() {
  const d = new Database(":memory:");
  ensureControlSchema(d);
  return d;
}

test("listWorks returns works newest-updated first", () => {
  const d = db();
  const a = createWork(d, { title: "a", source: "t" }, 1);
  const b = createWork(d, { title: "b", source: "t2" }, 2);
  const titles = listWorks(d).map((w) => w.title);
  expect(titles[0]).toBe(b.title);
  expect(titles[1]).toBe(a.title);
  d.close();
});

test("listAttention zones filter open vs done and defer", () => {
  const d = db();
  const w = createWork(d, { title: "w", source: "t", contract }, 1);
  upsertAttention(d, {
    item_id: "now", work_id: w.work_id, state: "open", effect_state: "not_started",
    urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 1);
  upsertAttention(d, {
    item_id: "inbox", work_id: w.work_id, state: "open", effect_state: "not_started",
    urgency: "inbox", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 2);
  expect(listAttention(d, "now", 3).map((x) => x.item_id)).toEqual(["now"]);
  expect(listAttention(d, "inbox", 3).map((x) => x.item_id)).toEqual(["inbox"]);
  d.close();
});

test("redirectWork stops a work and records a redirect row", () => {
  const d = db();
  const w = createWork(d, { title: "w", source: "t", contract }, 1);
  const stopped = redirectWork(d, w.work_id, 1, {
    reason: "paused", affected_work_ids: [], action: "stop",
  }, 2);
  expect(stopped.state).toBe("stopped");
  expect(stopped.revision).toBe(2);
  expect(getWork(d, w.work_id)?.state).toBe("stopped");
  expect((d.query("SELECT reason FROM control_redirects WHERE work_id=?").get(w.work_id) as { reason: string }).reason).toBe("paused");
  d.close();
});

test("recordAttentionFeedback writes a feedback row and emits an outbox event", () => {
  const d = db();
  ensureOutbox(d);
  const w = createWork(d, { title: "w", source: "t", contract }, 1);
  const item = upsertAttention(d, {
    item_id: "fb", work_id: w.work_id, state: "open", effect_state: "not_started",
    urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
  }, 1);
  recordAttentionFeedback(d, item.item_id, item.revision, true, "helpful", 2);
  expect((d.query("SELECT useful,reason FROM control_feedback WHERE item_id=?").get(item.item_id) as { useful: number; reason: string }).useful).toBe(1);
  expect(() => recordAttentionFeedback(d, item.item_id, item.revision, false, undefined, 3)).toThrow();
  d.close();
});

test("publishControlEvents claims pending events once and skips lease-held retries", () => {
  const d = db();
  ensureOutbox(d);
  enqueueControlEvent(d, { entity_id: "e1", entity_version: 1, kind: "attention.created", payload: { x: 1 } }, 1);
  enqueueControlEvent(d, { entity_id: "e2", entity_version: 1, kind: "work.created", payload: { y: 2 } }, 1);
  const seen: string[] = [];
  const first = publishControlEvents(d, "/nonexistent-ledger-path/x.db", (detail) => {
    seen.push(String((detail as { event_kind: string }).event_kind));
  }, 1);
  expect(first.published).toBe(2);
  expect(seen.sort()).toEqual(["attention.created", "work.created"]);
  const second = publishControlEvents(d, "/nonexistent-ledger-path/x.db", () => {}, 2);
  expect(second.published).toBe(0);
  d.close();
});
