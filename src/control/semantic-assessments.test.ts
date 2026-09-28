import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createWork, ensureControlSchema, getAttention, upsertAttention } from "./store";
import {
  claimSemanticAssessments,
  ensureSemanticAssessmentSchema,
  listSemanticAssessments,
  scheduleSemanticAssessment,
  settleSemanticAssessment,
} from "./semantic-assessments";
import type { Contract } from "./types";

const previousEnabled = process.env.OVERLOAD_SEMANTIC_ASSESSMENTS;
afterEach(() => {
  if (previousEnabled === undefined) delete process.env.OVERLOAD_SEMANTIC_ASSESSMENTS;
  else process.env.OVERLOAD_SEMANTIC_ASSESSMENTS = previousEnabled;
});

function contract(): Contract {
  return {
    objective: "judge only after durable evidence exists",
    acceptance: [{ id: "check", kind: "check", description: "tests pass", evidence: "test" }],
    non_goals: [], scope: { repo: "/repo" }, budget: {}, stop_conditions: [], decision_owner: "alice",
  };
}

function fixture(): { db: Database; itemId: string } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  const work = createWork(db, { title: "w", source: "test", contract: contract() }, 1);
  const itemId = "semantic-card";
  upsertAttention(db, {
    item_id: itemId, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: "Review a material change", trigger: "changed evidence", impact: "Owner decision required.",
    recommendation: "Review the material evidence.", options: ["continue", "stop"], owner: "alice", expires_at: null,
    source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision,
    decision_mode: "human_only", evidence: { source: "test" },
  }, 10);
  return { db, itemId };
}

describe("semantic assessments", () => {
  test("disabled creates neither assessment table nor job", () => {
    delete process.env.OVERLOAD_SEMANTIC_ASSESSMENTS;
    const { db, itemId } = fixture();
    expect(scheduleSemanticAssessment(db, itemId, "jev-fast", 20)).toBeNull();
    expect(db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='control_semantic_assessments'").get()).toMatchObject({ n: 0 });
    db.close();
  });

  test("same frozen material schedules exactly one job and claims it once", () => {
    process.env.OVERLOAD_SEMANTIC_ASSESSMENTS = "1";
    const { db, itemId } = fixture();
    const first = scheduleSemanticAssessment(db, itemId, "jev-fast", 20)!;
    const replay = scheduleSemanticAssessment(db, itemId, "jev-fast", 21)!;
    expect(replay.assessment_id).toBe(first.assessment_id);
    const claims = claimSemanticAssessments(db, { model: "jev-fast", limit: 2, lease_ms: 5_000 }, 30);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.assessment).toMatchObject({ assessment_id: first.assessment_id, assessment_version: "semantic_assessment_v1" });
    expect(claimSemanticAssessments(db, { model: "jev-fast" }, 31)).toHaveLength(0);
    db.close();
  });

  test("completed judgment remains advisory and cannot mutate the Attention card", () => {
    process.env.OVERLOAD_SEMANTIC_ASSESSMENTS = "1";
    const { db, itemId } = fixture();
    const scheduled = scheduleSemanticAssessment(db, itemId, "jev-fast", 20)!;
    const claim = claimSemanticAssessments(db, { model: "jev-fast" }, 30)[0]!;
    const before = getAttention(db, itemId)!;
    const settled = settleSemanticAssessment(db, {
      assessment_id: scheduled.assessment_id, lease_token: claim.assessment.lease_token!,
      result: { verdict: "needs_attention", rationale: "independent shadow concern", confidence: 0.7 },
    }, 40);
    expect(settled).toMatchObject({ state: "completed", verdict: "needs_attention", confidence: 0.7 });
    expect(getAttention(db, itemId)).toEqual(before);
    db.close();
  });

  test("changed material fences an in-flight result as stale", () => {
    process.env.OVERLOAD_SEMANTIC_ASSESSMENTS = "1";
    const { db, itemId } = fixture();
    const scheduled = scheduleSemanticAssessment(db, itemId, "jev-fast", 20)!;
    const claim = claimSemanticAssessments(db, { model: "jev-fast" }, 30)[0]!;
    const old = getAttention(db, itemId)!;
    upsertAttention(db, { ...old, trigger: "new material", evidence: { source: "changed" }, expected_revision: old.revision }, 35);
    const settled = settleSemanticAssessment(db, {
      assessment_id: scheduled.assessment_id, lease_token: claim.assessment.lease_token!,
      result: { verdict: "ordinary", rationale: "would be stale", confidence: 0.9 },
    }, 40);
    expect(settled).toMatchObject({ state: "stale", error: "attention_or_material_changed" });
    db.close();
  });

  test("unavailable model outcome is explicit and never retried as a decision", () => {
    process.env.OVERLOAD_SEMANTIC_ASSESSMENTS = "1";
    const { db, itemId } = fixture();
    const scheduled = scheduleSemanticAssessment(db, itemId, "jev-fast", 20)!;
    const claim = claimSemanticAssessments(db, { model: "jev-fast" }, 30)[0]!;
    const settled = settleSemanticAssessment(db, { assessment_id: scheduled.assessment_id, lease_token: claim.assessment.lease_token!, unavailable: "model unavailable" }, 40);
    expect(settled).toMatchObject({ state: "unavailable", error: "model unavailable" });
    expect(getAttention(db, itemId)).toMatchObject({ state: "open", effect_state: "not_started" });
    db.close();
  });

  test("expired worker lease is reclaimed once, then bounded as failed", () => {
    process.env.OVERLOAD_SEMANTIC_ASSESSMENTS = "1";
    const { db, itemId } = fixture();
    scheduleSemanticAssessment(db, itemId, "jev-fast", 20);
    const first = claimSemanticAssessments(db, { model: "jev-fast", lease_ms: 1_000 }, 30)[0]!;
    const reclaimed = claimSemanticAssessments(db, { model: "jev-fast", lease_ms: 1_000 }, 1_031)[0]!;
    expect(reclaimed.assessment.attempts).toBe(2);
    expect(reclaimed.assessment.assessment_id).toBe(first.assessment.assessment_id);
    expect(claimSemanticAssessments(db, { model: "jev-fast" }, 2_032)).toHaveLength(0);
    expect(listSemanticAssessments(db, itemId)[0]).toMatchObject({ state: "failed", error: "attempt_budget_exhausted" });
    db.close();
  });

  test("assessment schema can be inspected independently after completion", () => {
    const { db } = fixture();
    ensureSemanticAssessmentSchema(db);
    expect(db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='control_semantic_assessments'").get()).toMatchObject({ n: 1 });
    db.close();
  });
});
