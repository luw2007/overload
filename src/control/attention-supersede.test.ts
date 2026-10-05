import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  ControlError,
  createWork,
  ensureControlSchema,
  getAttention,
  recordAttentionResolution,
  supersedeAttentionById,
  supersedeOpenAttentionByWork,
  resolveAttentionByExternalSuccess,
  upsertAttention,
} from "./store";
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

function openCard(d: Database, workId: string, itemId: string, overrides: Partial<Parameters<typeof upsertAttention>[1]> = {}, now = 1) {
  return upsertAttention(d, {
    item_id: itemId,
    work_id: workId,
    state: "open",
    effect_state: "not_started",
    urgency: "inbox",
    conclusion: "c",
    trigger: "t",
    impact: "i",
    recommendation: null,
    options: ["accept", "reject"],
    owner: "owner",
    expires_at: null,
    source_link: null,
    approval_id: null,
    consumer_owner: null,
    contract_revision: 1,
    decision_mode: "human_only",
    evidence: {},
    ...(overrides as object),
  } as Parameters<typeof upsertAttention>[1], now);
}

const eventCount = (d: Database, itemId: string) =>
  (d.query("SELECT count(*) n FROM control_attention_events WHERE item_id=?").get(itemId) as { n: number }).n;
const outboxCount = (d: Database, itemId: string) =>
  (d.query("SELECT count(*) n FROM control_outbox WHERE item_id=?").get(itemId) as { n: number }).n;

describe("supersedeAttentionById", () => {
  test("wrong expectedRevision → conflict, state unchanged", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "a");
    expect(() =>
      supersedeAttentionById(d, card.item_id, 999, { reason: "drift", actor: "collector" }, 2),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    const after = getAttention(d, card.item_id)!;
    expect(after.state).toBe("open");
    expect(after.revision).toBe(card.revision);
    d.close();
  });

  test("correct revision → superseded, revision+1, events + outbox written", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "a", {}, 1);
    const beforeEvents = eventCount(d, card.item_id);
    const beforeOutbox = outboxCount(d, card.item_id);
    const superseded = supersedeAttentionById(d, card.item_id, card.revision, { reason: "drift", actor: "collector", evidence: { k: 1 } }, 2);
    expect(superseded.state).toBe("superseded");
    expect(superseded.revision).toBe(card.revision + 1);
    expect(superseded.effect_state).toBe("not_started"); // 不改变 effect_state
    const row = d.query("SELECT kind,detail FROM control_attention_events WHERE item_id=? ORDER BY revision DESC").get(card.item_id) as { kind: string; detail: string };
    expect(row.kind).toBe("superseded");
    expect(JSON.parse(row.detail)).toMatchObject({ reason: "drift", actor: "collector" });
    expect(eventCount(d, card.item_id)).toBe(beforeEvents + 1);
    expect(outboxCount(d, card.item_id)).toBe(beforeOutbox + 1);
    d.close();
  });

  test("idempotent: same reason repeat supersede → no new event, no new revision", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "a", {}, 1);
    const first = supersedeAttentionById(d, card.item_id, card.revision, { reason: "drift", actor: "collector" }, 2);
    const eventsAfterFirst = eventCount(d, card.item_id);
    const outboxAfterFirst = outboxCount(d, card.item_id);
    const second = supersedeAttentionById(d, card.item_id, first.revision, { reason: "drift", actor: "collector" }, 3);
    expect(second.revision).toBe(first.revision);
    expect(second.updated_at).toBe(first.updated_at);
    expect(eventCount(d, card.item_id)).toBe(eventsAfterFirst);
    expect(outboxCount(d, card.item_id)).toBe(outboxAfterFirst);
    d.close();
  });

  test("not found → ControlError not_found", () => {
    const d = db();
    expect(() => supersedeAttentionById(d, "nope", 1, { reason: "r", actor: "a" }, 1)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    d.close();
  });
});

describe("supersedeOpenAttentionByWork", () => {
  test("only supersedes open/applying cards; resolved/other cards untouched", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const openCard1 = openCard(d, w.work_id, "open-1", {}, 1);
    const applyingCard = openCard(d, w.work_id, "applying-1", { state: "applying", effect_state: "applying" }, 1);
    const resolvedCard = openCard(d, w.work_id, "resolved-1", {}, 1);
    recordAttentionResolution(d, resolvedCard.item_id, resolvedCard.revision, { verdict: "accepted", actor: "owner", evidence: {} }, 2);

    const count = supersedeOpenAttentionByWork(d, w.work_id, { reason: "aliased", actor: "owner", evidence: { alias: "x" } }, 3);
    expect(count).toBe(2);
    expect(getAttention(d, openCard1.item_id)!.state).toBe("superseded");
    expect(getAttention(d, applyingCard.item_id)!.state).toBe("superseded");
    expect(getAttention(d, resolvedCard.item_id)!.state).toBe("resolved");
    expect(getAttention(d, resolvedCard.item_id)!.effect_state).toBe("succeeded");
    d.close();
  });

  test("empty work → 0", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    expect(supersedeOpenAttentionByWork(d, w.work_id, { reason: "r", actor: "a" }, 1)).toBe(0);
    d.close();
  });
});

describe("resolveAttentionByExternalSuccess", () => {
  test("open card → resolved/succeeded, revision+1, events + outbox", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "handoff-unknown", { effect_state: "unknown" }, 1);
    const beforeEvents = eventCount(d, card.item_id);
    const beforeOutbox = outboxCount(d, card.item_id);
    const resolved = resolveAttentionByExternalSuccess(d, card.item_id, card.revision, { actor: "reconcile", evidence: { stable: "s" } }, 2);
    expect(resolved.state).toBe("resolved");
    expect(resolved.effect_state).toBe("succeeded");
    expect(resolved.revision).toBe(card.revision + 1);
    expect(eventCount(d, card.item_id)).toBe(beforeEvents + 1);
    expect(outboxCount(d, card.item_id)).toBe(beforeOutbox + 1);
    d.close();
  });

  test("failed effect_state → invalid, state unchanged", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "bad", { effect_state: "failed" }, 1);
    expect(() =>
      resolveAttentionByExternalSuccess(d, card.item_id, card.revision, { actor: "reconcile" }, 2),
    ).toThrowError(expect.objectContaining({ code: "invalid" }));
    const after = getAttention(d, card.item_id)!;
    expect(after.state).toBe("open");
    expect(after.effect_state).toBe("failed");
    expect(after.revision).toBe(card.revision);
    d.close();
  });

  test("a rejected card cannot be overwritten to resolved by an external success", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "rejected", {}, 1);
    recordAttentionResolution(d, card.item_id, card.revision, { verdict: "rejected", actor: "owner", evidence: {} }, 2);
    const rejected = getAttention(d, card.item_id)!;
    expect(rejected.state).toBe("superseded");
    const back = resolveAttentionByExternalSuccess(d, card.item_id, rejected.revision, { actor: "reconcile" }, 3);
    expect(back.state).toBe("superseded");
    expect(back.evidence.selected_option).toBe("reject");
    expect(back.revision).toBe(rejected.revision);
    d.close();
  });

  test("already resolved/succeeded with fresh revision → idempotent no-op", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "h", { effect_state: "unknown" }, 1);
    const first = resolveAttentionByExternalSuccess(d, card.item_id, card.revision, { actor: "reconcile" }, 2);
    const eventsAfterFirst = eventCount(d, card.item_id);
    const again = resolveAttentionByExternalSuccess(d, card.item_id, first.revision, { actor: "reconcile" }, 3);
    expect(again.revision).toBe(first.revision);
    expect(eventCount(d, card.item_id)).toBe(eventsAfterFirst);
    d.close();
  });

  test("CAS: two resolves with same expectedRevision → second conflicts", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const card = openCard(d, w.work_id, "h", { effect_state: "unknown" }, 1);
    resolveAttentionByExternalSuccess(d, card.item_id, card.revision, { actor: "reconcile" }, 2);
    expect(() =>
      resolveAttentionByExternalSuccess(d, card.item_id, card.revision, { actor: "reconcile" }, 3),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    d.close();
  });

  test("not found → not_found", () => {
    const d = db();
    expect(() => resolveAttentionByExternalSuccess(d, "nope", 1, { actor: "a" }, 1)).toThrowError(
      expect.objectContaining({ code: "not_found" }),
    );
    d.close();
  });
});
