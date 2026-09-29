import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createWork, ensureControlSchema, getAttention } from "./store";
import {
  getExternalObservation,
  ingestExternalObservation,
  listExternalObservations,
} from "./external-observations";
import type { Contract } from "./types";
import type { ExternalObservationInput } from "../shared/external-observation-contract";

function contract(): Contract {
  return {
    objective: "keep the attention loop accurate",
    acceptance: [{ id: "a", kind: "check", description: "tests", evidence: "test" }],
    non_goals: [], scope: { repo: "/repo" }, budget: {}, stop_conditions: [], decision_owner: "alice",
  };
}

function fixture(): { db: Database; workId: string } {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  const work = createWork(db, { title: "w", source: "test", contract: contract() }, 1);
  return { db, workId: work.work_id };
}

function observation(overrides: Partial<ExternalObservationInput> = {}): ExternalObservationInput {
  const summary = overrides.summary ?? "observer found a material state change";
  return {
    source_id: "loopx-shadow",
    source_event_id: "run-1:event-1",
    observation_revision: 1,
    work_id: "WILL_BE_REPLACED",
    kind: "live",
    subject: "material state changed",
    summary,
    content_hash: createHash("sha256").update(summary).digest("hex"),
    observed_at: "2026-09-28T00:00:00.000Z",
    urgency: "inbox",
    deep_link: "overload://session/s-1",
    ...overrides,
  };
}

describe("external observations", () => {
  test("live matched observation becomes one evidence-backed existing Attention card", () => {
    const { db, workId } = fixture();
    const result = ingestExternalObservation(db, observation({ work_id: workId }), 10);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.observation.state).toBe("attention_open");
    const card = getAttention(db, result.observation.attention_item_id!);
    expect(card).toMatchObject({ work_id: workId, owner: "alice", state: "open", effect_state: "not_started" });
    expect(card!.evidence).toMatchObject({ external_observation_id: result.observation.observation_id, summary: "observer found a material state change" });
    const fact = db.query("SELECT summary_short,content_hash FROM control_context_object_versions WHERE reference=?")
      .get(`external-observation:${result.observation.observation_id}`) as { summary_short: string; content_hash: string } | null;
    expect(fact).toMatchObject({ summary_short: "observer found a material state change" });
    db.close();
  });

  test("historical observation remains durable evidence without a new interruption", () => {
    const { db, workId } = fixture();
    const result = ingestExternalObservation(db, observation({ work_id: workId, kind: "historical" }), 10);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.observation.state).toBe("historical");
    expect(result.observation.attention_item_id).toBeNull();
    expect(db.query("SELECT COUNT(*) n FROM control_attention").get()).toMatchObject({ n: 0 });
    db.close();
  });

  test("unmatched input is durable but has no inferred Work or human card", () => {
    const { db } = fixture();
    const result = ingestExternalObservation(db, observation({ work_id: null }), 10);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("expected created");
    expect(result.observation.state).toBe("unmatched");
    expect(listExternalObservations(db, { state: "unmatched" })).toHaveLength(1);
    expect(db.query("SELECT COUNT(*) n FROM control_attention").get()).toMatchObject({ n: 0 });
    db.close();
  });

  test("exact replay is idempotent; identity collision is quarantined", () => {
    const { db, workId } = fixture();
    const input = observation({ work_id: workId });
    const first = ingestExternalObservation(db, input, 10);
    expect(first.status).toBe("created");
    const replay = ingestExternalObservation(db, input, 11);
    expect(replay.status).toBe("idempotent");
    const collision = observation({ work_id: workId, summary: "different content" });
    const quarantined = ingestExternalObservation(db, collision, 12);
    expect(quarantined).toMatchObject({ status: "quarantined" });
    expect(db.query("SELECT COUNT(*) n FROM control_external_observation_quarantine").get()).toMatchObject({ n: 1 });
    db.close();
  });

  test("recovery records provenance and opens the existing Attention path", () => {
    const { db, workId } = fixture();
    const original = observation({ work_id: workId });
    const first = ingestExternalObservation(db, original, 10);
    expect(first.status).toBe("created");
    const recovery = observation({
      work_id: workId, kind: "recovery", source_event_id: "run-1:recovered", summary: "observer recovered after source outage",
      recovery_of: { source_id: original.source_id, source_event_id: original.source_event_id, observation_revision: 1 },
    });
    const result = ingestExternalObservation(db, recovery, 20);
    expect(result.status).toBe("created");
    if (result.status !== "created" || first.status !== "created") throw new Error("expected created");
    expect(result.observation.recovered_by).toBe(first.observation.observation_id);
    expect(getExternalObservation(db, result.observation.observation_id)?.state).toBe("attention_open");
    db.close();
  });

  test("recovery without its original observation is rejected rather than opening an unproven card", () => {
    const { db, workId } = fixture();
    const recovery = observation({
      work_id: workId, kind: "recovery", source_event_id: "run-1:orphan-recovery", summary: "unproven recovery",
      recovery_of: { source_id: "loopx-shadow", source_event_id: "missing", observation_revision: 1 },
    });
    expect(() => ingestExternalObservation(db, recovery, 20)).toThrow("recovery observation source not found");
    expect(db.query("SELECT COUNT(*) n FROM control_external_observations").get()).toMatchObject({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM control_attention").get()).toMatchObject({ n: 0 });
    db.close();
  });

  test("invalid source hash is rejected before any persistence", () => {
    const { db, workId } = fixture();
    expect(() => ingestExternalObservation(db, observation({ work_id: workId, content_hash: "a".repeat(64) }), 10)).toThrow("content_hash does not match summary");
    expect(db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='control_external_observations'").get()).toMatchObject({ n: 1 });
    expect(db.query("SELECT COUNT(*) n FROM control_external_observations").get()).toMatchObject({ n: 0 });
    db.close();
  });
});
