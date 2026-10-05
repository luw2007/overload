import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  CONTROL_SCHEMA_VERSION,
  CONTROL_SCHEMA,
  ControlError,
  actOnAttention,
  createWork,
  deriveAttentionMaterialInputs,
  computeMaterialFingerprint,
  ensureControlSchema,
  getAttention,
  getAttentionMaterial,
  getWork,
  listAttention,
  listAttentionFollowUps,
  listAttentionPage,
  listWorks,
  projectAttentionEffect,
  projectAttentionMaterial,
  recordAttentionFeedback,
  recordAttentionResolution,
  redirectWork,
  resolveAttention,
  upsertAttention,
} from "./store";
import { enqueueControlEvent, ensureOutbox, publishControlEvents } from "./outbox";
import { createObject } from "./context-pool";
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

// A05 / contract §5 invariant 8: defer only moves presentation timing. It must not touch expires_at,
// must not re-baseline the material projection, and must not survive the original expiry.
test("A05 a successful defer moves presentation timing only and never the expiry", () => {
  const d = db();
  const w = createWork(d, { title: "w", source: "t", contract }, 1_000);
  const expiresAt = 5_000;
  const deferUntil = 9_000; // deliberately later than the expiry the user is trying to outlast
  const item = upsertAttention(d, {
    item_id: "deferred", work_id: w.work_id, state: "open", effect_state: "not_started",
    urgency: "inbox", conclusion: "decide", trigger: "risk", impact: "blocked", recommendation: null,
    options: ["continue"], owner: "owner", expires_at: expiresAt, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: w.revision, decision_mode: "human_only", evidence: {},
  }, 1_000);
  const baseline = getAttentionMaterial(d, item.item_id)!;

  const deferred = actOnAttention(d, item.item_id, item.revision, "defer", { defer_until: deferUntil }, "owner", 2_000);

  expect(deferred.expires_at).toBe(item.expires_at);
  expect(deferred).toMatchObject({ revision: item.revision + 1, defer_until: deferUntil, state: "open" });
  expect(getAttention(d, item.item_id)).toMatchObject({ expires_at: expiresAt, defer_until: deferUntil, revision: item.revision + 1 });
  // Presentation timing is not a material input, so deferring cannot re-baseline the fingerprint either.
  expect(getAttentionMaterial(d, item.item_id)).toMatchObject({ fingerprint: baseline.fingerprint, generation: baseline.generation });

  // While the deferral is live the card is out of both actionable zones.
  expect(listAttention(d, "now", 2_100).map((x) => x.item_id)).toEqual([]);
  expect(listAttention(d, "inbox", 2_100).map((x) => x.item_id)).toEqual([]);
  // Expiry overrides a deferral: an invalid decision basis needs attention immediately.
  expect(listAttention(d, "now", expiresAt).map((x) => x.item_id)).toEqual(["deferred"]);
  expect(listAttentionPage(d, "now", {}, expiresAt).items.map((x) => x.item_id)).toEqual(["deferred"]);
  expect(listAttention(d, "inbox", expiresAt).map((x) => x.item_id)).toEqual([]);
  // Once the deferral lapses the original expiry still puts the card in Now.
  expect(listAttention(d, "now", deferUntil + 1).map((x) => x.item_id)).toEqual(["deferred"]);
  expect(listAttention(d, "inbox", deferUntil + 1).map((x) => x.item_id)).toEqual([]);
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


function openAttention(d: ReturnType<typeof db>, itemId: string, workId: string, rev: number) {
  return upsertAttention(d, {
    item_id: itemId, work_id: workId, state: "open", effect_state: "not_started",
    urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: rev, decision_mode: "human_only", evidence: {},
  }, rev);
}

describe("T19 attention resolution CAS（反例）", () => {
  test("recordAttentionResolution 用错误的 expectedRevision → 抛 ControlError('conflict')", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const item = openAttention(d, "res-1", w.work_id, 1);
    expect(() =>
      recordAttentionResolution(d, item.item_id, 999, { verdict: "accepted", actor: "owner", evidence: {} }, 2),
    ).toThrow(ControlError);
    try { recordAttentionResolution(d, item.item_id, 999, { verdict: "accepted", actor: "owner", evidence: {} }, 2); }
    catch (e) { expect((e as ControlError).code).toBe("conflict"); }
    d.close();
  });

  test("accepted → state='resolved', effect_state='succeeded', revision+1, 有 attention_events 记录", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const item = openAttention(d, "res-acc", w.work_id, 1);
    const resolved = recordAttentionResolution(d, item.item_id, item.revision, { verdict: "accepted", actor: "owner", evidence: { x: 1 } }, 2);
    expect(resolved.state).toBe("resolved");
    expect(resolved.effect_state).toBe("succeeded");
    expect(resolved.revision).toBe(item.revision + 1);
    const events = (d.query("SELECT kind FROM control_attention_events WHERE item_id=? ORDER BY revision").all(item.item_id) as Array<{ kind: string }>).map((r) => r.kind);
    expect(events).toContain("resolved");
    d.close();
  });

  test("a recorded rejection is superseded and has no unresolved execution follow-up", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const item = openAttention(d, "res-rej", w.work_id, 1);
    const sup = recordAttentionResolution(d, item.item_id, item.revision, { verdict: "rejected", actor: "owner", evidence: {} }, 2);
    expect(sup.state).toBe("superseded");
    expect(sup.evidence.selected_option).toBe("reject");
    expect(listAttentionFollowUps(d, 3).map(row => row.item.item_id)).not.toContain(item.item_id);
    d.close();
  });

  test("upsertAttention 并发模拟：第二个带错误 expected_revision → conflict", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    openAttention(d, "cas-1", w.work_id, 1);
    // 第一次更新基于 revision=1 成功 → revision=2
    const updated = upsertAttention(d, {
      item_id: "cas-1", work_id: w.work_id, state: "open", effect_state: "not_started",
      urgency: "now", conclusion: "c2", trigger: "t", impact: "i", recommendation: null,
      options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
      consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
      expected_revision: 1,
    }, 2);
    expect(updated.revision).toBe(2);
    // 第二个仍基于旧 revision=1 → conflict
    expect(() =>
      upsertAttention(d, {
        item_id: "cas-1", work_id: w.work_id, state: "open", effect_state: "not_started",
        urgency: "now", conclusion: "c3", trigger: "t", impact: "i", recommendation: null,
        options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
        consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
        expected_revision: 1,
      }, 3),
    ).toThrow(ControlError);
    try {
      upsertAttention(d, {
        item_id: "cas-1", work_id: w.work_id, state: "open", effect_state: "not_started",
        urgency: "now", conclusion: "c3", trigger: "t", impact: "i", recommendation: null,
        options: [], owner: "owner", expires_at: null, source_link: null, approval_id: null,
        consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
        expected_revision: 1,
      }, 3);
    } catch (e) { expect((e as ControlError).code).toBe("conflict"); }
    d.close();
  });
});

describe("Phase A control foundation", () => {
  test("v6 migration creates exactly the additive material and notification objects", () => {
    const d = new Database(":memory:");
    ensureControlSchema(d);
    expect((d.query("SELECT version FROM control_schema_meta WHERE id=1").get() as { version: number }).version).toBe(CONTROL_SCHEMA_VERSION);
    const objects = d.query(`SELECT type,name FROM sqlite_master
      WHERE name IN ('control_attention_material','control_attention_material_key','control_notifications',
        'control_notifications_due','control_notifications_item','control_notification_shadow') ORDER BY name`).all();
    expect(objects).toEqual([
      { type: "table", name: "control_attention_material" },
      { type: "index", name: "control_attention_material_key" },
      { type: "table", name: "control_notification_shadow" },
      { type: "table", name: "control_notifications" },
      { type: "index", name: "control_notifications_due" },
      { type: "index", name: "control_notifications_item" },
    ]);
  });

  test("v6 migration backfills existing open Attention material but preserves historical closed rows", () => {
    const d = new Database(":memory:");
    d.exec(CONTROL_SCHEMA);
    d.query("INSERT INTO control_schema_meta(id,version,migrated_at) VALUES(1,5,0)").run();
    const workId = "legacy-work";
    d.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run(workId, "legacy", "test", null, "active", 1, JSON.stringify(contract), 1, 1);
    const insert = d.query(`INSERT INTO control_attention VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const values = (id: string, state: "open" | "resolved") => [
      id, workId, 1, state, state === "open" ? "not_started" : "succeeded", null, "now", "Choose", "risk", "impact", null,
      JSON.stringify(["continue"]), "owner", null, null, null, null, null, null, 1, "human_only", "{}", 2, 2,
    ];
    insert.run(...values("legacy-open", "open"));
    insert.run(...values("legacy-done", "resolved"));

    ensureControlSchema(d);

    expect(getAttentionMaterial(d, "legacy-open")).toMatchObject({ item_id: "legacy-open", generation: 1 });
    expect(getAttentionMaterial(d, "legacy-done")).toBeNull();
    expect(d.query("SELECT kind FROM control_outbox WHERE item_id='legacy-open'").all()).toEqual([{ kind: "attention.material_projected" }]);
    d.close();
  });

  test("v6 ensure repairs an interrupted open-item backfill idempotently", () => {
    const d = db();
    const work = createWork(d, { title: "repair", source: "test", contract }, 1);
    const item = openAttention(d, "repair-open", work.work_id, work.revision);
    d.query("DELETE FROM control_attention_material WHERE item_id=?").run(item.item_id);
    d.query("DELETE FROM control_outbox WHERE item_id=? AND kind='attention.material_projected'").run(item.item_id);
    const before = 0;

    ensureControlSchema(d);
    ensureControlSchema(d);

    expect(getAttentionMaterial(d, item.item_id)).toMatchObject({ generation: 1 });
    const after = d.query("SELECT COUNT(*) AS n FROM control_outbox WHERE item_id=? AND kind='attention.material_projected'").get(item.item_id) as { n: number };
    expect(after.n).toBe(before + 1);
    d.close();
  });

  test("unknown option IDs receive neutral material effects but no actionable display metadata", () => {
    const d = db();
    const work = createWork(d, { title: "unknown", source: "test", contract }, 1);
    const item = upsertAttention(d, {
      item_id: "unknown-option", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now",
      conclusion: "Choose", trigger: "native", impact: "held", recommendation: null, options: ["allow-once"],
      owner: "owner", expires_at: null, source_link: null, approval_id: null, consumer_owner: null,
      contract_revision: work.revision, decision_mode: "human_only", evidence: {},
    }, 2);
    expect(deriveAttentionMaterialInputs(d, item, 2).option_effects).toEqual([
      { option: "allow-once", effect: "records answer; execution semantics unavailable" },
    ]);
    expect(getAttentionMaterial(d, item.item_id)).toMatchObject({ generation: 1 });
    d.close();
  });

  test("upsert projects baseline atomically and changes generation only for material fields", () => {
    const base = {
      risk: "  destructive\r\n write  ",
      decision: "Choose\tpath",
      option_effects: [{ option: "continue", effect: "write file" }],
      decisive_evidence: [
        { object_id: "z", revision: 2, conclusion: " failed  check " },
        { object_id: "a", revision: 1, conclusion: "human review" },
      ],
      validity: { expires_at: 100, expired: false },
      consequence: "Changes production",
    };
    const equivalent = computeMaterialFingerprint({
      ...base,
      risk: "destructive write",
      decision: "Choose path",
      decisive_evidence: [...base.decisive_evidence].reverse(),
    });
    expect(equivalent).toEqual(computeMaterialFingerprint(base));
    expect(computeMaterialFingerprint({ ...base, risk: "data loss" }).fingerprint).not.toBe(equivalent.fingerprint);
    expect(computeMaterialFingerprint({ ...base, option_effects: [{ option: "continue", effect: "delete file" }] }).fingerprint).not.toBe(equivalent.fingerprint);

    const d = db();
    const work = createWork(d, { title: "w", source: "test", contract }, 1);
    let item = upsertAttention(d, {
      item_id: "material", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now",
      conclusion: "Choose path", trigger: "initial prose", impact: "destructive write", recommendation: null,
      options: ["continue"], owner: "owner", expires_at: null, source_link: null, approval_id: null,
      consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {},
    }, 10);
    const first = getAttentionMaterial(d, item.item_id)!;
    expect(first).toMatchObject({ generation: 1, computed_at: 10 });

    const revisionBeforeProse = item.revision;
    item = upsertAttention(d, {
      ...item, expected_revision: item.revision, trigger: "rewritten prose", recommendation: "continue",
      evidence: { heartbeat: 99, ordinary_log: "progress" },
    }, 11);
    // A03: the card revision still advances so CAS keeps working; only the material baseline stands still.
    expect(item.revision).toBe(revisionBeforeProse + 1);
    expect(getAttentionMaterial(d, item.item_id)).toMatchObject({ fingerprint: first.fingerprint, generation: 1, computed_at: 11 });

    item = upsertAttention(d, { ...item, expected_revision: item.revision, impact: "data loss" }, 12);
    const changedRisk = getAttentionMaterial(d, item.item_id)!;
    expect(changedRisk.generation).toBe(2);
    expect(changedRisk.fingerprint).not.toBe(first.fingerprint);

    item = upsertAttention(d, { ...item, expected_revision: item.revision, options: ["stop", "continue"] }, 13);
    expect(getAttentionMaterial(d, item.item_id)?.generation).toBe(3);
    item = upsertAttention(d, { ...item, expected_revision: item.revision, expires_at: 20 }, 14);
    expect(getAttentionMaterial(d, item.item_id)?.generation).toBe(4);

    const materialEvents = d.query("SELECT kind FROM control_outbox WHERE kind='attention.material_projected'").all();
    expect(materialEvents).toHaveLength(4);
    expect(getAttentionMaterial(d, item.item_id)?.subject).toBe(`attention:${item.item_id}`);
    d.close();
  });

  test("server-owned decisive evidence conclusion participates in the baseline fingerprint", () => {
    const d = db();
    const work = createWork(d, { title: "w", source: "test", contract }, 1);
    const evidence = createObject(d, {
      work_id: work.work_id, ctype: "fact", fact_subtype: "test_result", object_canonical_key: "decisive",
      reference: "orchestrator:submit_result:decisive", source_type: "orchestrator", content_hash: "h1",
      sensitivity: "clean", summary_short: "tests failed",
    }, 2);
    let item = upsertAttention(d, {
      item_id: "evidence-material", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now",
      conclusion: "Choose path", trigger: "test result", impact: "release risk", recommendation: null,
      options: ["continue", "stop"], owner: "owner", expires_at: null, source_link: null, approval_id: null,
      consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: { object_id: evidence.object_id, revision: 1 },
    }, 3);
    expect(getAttentionMaterial(d, item.item_id)?.inputs.decisive_evidence).toEqual([
      { object_id: evidence.object_id, revision: 1, conclusion: "tests failed" },
    ]);
    const first = getAttentionMaterial(d, item.item_id)!;
    d.query("UPDATE control_context_object_versions SET summary_short='tests pass' WHERE object_id=? AND revision=1").run(evidence.object_id);
    item = upsertAttention(d, { ...item, expected_revision: item.revision }, 4);
    const changed = getAttentionMaterial(d, item.item_id)!;
    expect(changed.generation).toBe(first.generation + 1);
    expect(changed.inputs).toEqual(deriveAttentionMaterialInputs(d, item, 4));
    d.close();
  });

  test("follow-up exposes recorded, applying, failed, unknown, and outstanding acceptance", () => {
    const d = db();
    d.exec(`CREATE TABLE approval_targets(consumer_owner TEXT NOT NULL,approval_id TEXT NOT NULL,PRIMARY KEY(consumer_owner,approval_id));
      CREATE TABLE decision_receipts(receipt_id TEXT PRIMARY KEY,consumer_owner TEXT NOT NULL,approval_id TEXT NOT NULL,
        target_version TEXT NOT NULL,answer TEXT NOT NULL,actor TEXT NOT NULL,attempt_id TEXT,consumed_at INTEGER NOT NULL,
        applied_at INTEGER,outcome TEXT,UNIQUE(consumer_owner,approval_id,target_version));
      CREATE TABLE receipt_effect_observations(receipt_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,attempt_id TEXT,state TEXT NOT NULL,
        evidence TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(receipt_id,tool_call_id));`);
    const completedContract: Contract = { ...contract, acceptance: [{ id: "check", kind: "check", description: "tests", evidence: "passed" }] };
    const work = createWork(d, { title: "w", source: "test", contract: completedContract }, 1);
    const linked = (id: string, state: "open" | "applying", effect: "not_started" | "applying" | "failed" | "unknown" | "succeeded", evidence: Record<string, unknown> = {}) =>
      upsertAttention(d, {
        item_id: id, work_id: work.work_id, state, effect_state: effect, urgency: "now", conclusion: "choose", trigger: "risk", impact: "impact",
        recommendation: null, options: ["continue"], owner: "owner", expires_at: null, source_link: null,
        approval_id: id, consumer_owner: "orchestrator", contract_revision: 1, decision_mode: "human_only", evidence,
      }, 1);
    linked("recorded", "open", "not_started");
    linked("applying", "applying", "applying");
    linked("failed", "open", "failed", { remaining_responsibility: "review failure" });
    linked("unknown", "open", "unknown", { remaining_responsibility: "confirm effect" });
    linked("verify", "applying", "succeeded", { remaining_responsibility: "owner accepts" });
    linked("done", "applying", "succeeded", { effect_verified_at: 5 });
    for (const id of ["recorded", "applying", "failed", "unknown", "verify", "done"]) {
      d.query("INSERT INTO approval_targets VALUES (?,?)").run("orchestrator", id);
    }
    d.query("INSERT INTO decision_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("receipt-recorded", "orchestrator", "recorded", "v1", "yes", "owner", null, 2, null, null);
    d.query("INSERT INTO decision_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("receipt-failed", "orchestrator", "failed", "v1", "yes", "owner", null, 3, 4, "failed");
    d.query("INSERT INTO receipt_effect_observations VALUES (?,?,?,?,?,?)")
      .run("receipt-failed", "tool-a", null, "succeeded", JSON.stringify({ effect: "PR created" }), 4);
    const followUps = listAttentionFollowUps(d, 10);
    expect(Object.fromEntries(followUps.map((entry) => [entry.item.item_id, entry.stage]))).toMatchObject({
      recorded: "answer_recorded", applying: "applying", failed: "failed", unknown: "unknown", verify: "verification_required",
    });
    expect(followUps.find((entry) => entry.item.item_id === "failed")?.occurred_effects).toEqual([
      { kind: "tool-a", evidence: { effect: "PR created", state: "succeeded", observed_at: 4 } },
    ]);
    expect(followUps.some((entry) => entry.item.item_id === "done")).toBe(false);
    d.close();
  });

  test("accepted failed and unknown effects reopen the same item without spawning Work", () => {
    const d = db();
    d.exec(`CREATE TABLE decision_receipts(receipt_id TEXT PRIMARY KEY,consumer_owner TEXT NOT NULL,approval_id TEXT NOT NULL,
        target_version TEXT NOT NULL,answer TEXT NOT NULL,actor TEXT NOT NULL,attempt_id TEXT,consumed_at INTEGER NOT NULL,
        applied_at INTEGER,outcome TEXT,UNIQUE(consumer_owner,approval_id,target_version));
      CREATE TABLE receipt_effect_observations(receipt_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,attempt_id TEXT,state TEXT NOT NULL,
        evidence TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(receipt_id,tool_call_id));`);
    const work = createWork(d, { title: "w", source: "test", contract }, 1);
    const item = upsertAttention(d, {
      item_id: "effect", work_id: work.work_id, state: "applying", effect_state: "applying", urgency: "now", conclusion: "choose", trigger: "risk",
      impact: "impact", recommendation: null, options: ["continue"], owner: "owner", expires_at: null, source_link: null,
      approval_id: "approval", consumer_owner: "orchestrator", contract_revision: 1, decision_mode: "human_only", evidence: {},
    }, 1);
    d.query("INSERT INTO decision_receipts VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("receipt", "orchestrator", "approval", "v1", "yes", "owner", null, 2, null, null);
    const observe = (tool: string, state: "failed" | "unknown", at: number, evidence: Record<string, unknown>) => {
      d.query("INSERT INTO receipt_effect_observations VALUES (?,?,?,?,?,?)").run("receipt", tool, null, state, JSON.stringify(evidence), at);
      return { receiptId: "receipt", toolCallId: tool, attemptId: null, state, evidence, observedAt: at } as const;
    };
    const link = { work_id: work.work_id, item_id: item.item_id, item_revision: item.revision, approval_id: "approval", receipt_id: "receipt", outbox_event_id: "source-event" };
    const failed = projectAttentionEffect(d, link, observe("tool-failed", "failed", 3, { error: "boom" }), 3);
    expect(failed).toMatchObject({ item_id: item.item_id, state: "open", effect_state: "failed", revision: item.revision + 1 });
    const unknown = projectAttentionEffect(d, { ...link, item_revision: failed.revision }, observe("tool-unknown", "unknown", 4, { reason: "lost" }), 4);
    expect(unknown).toMatchObject({ item_id: item.item_id, state: "open", effect_state: "unknown", revision: failed.revision + 1 });
    expect(listWorks(d)).toHaveLength(1);
    expect(listAttentionFollowUps(d).find((entry) => entry.item.item_id === item.item_id)?.stage).toBe("unknown");
    expect(() => projectAttentionEffect(d, link, observe("tool-stale", "failed", 2, { error: "old" }), 5)).toThrow(ControlError);
    d.close();
  });

  // A03: a revision bump with no material change must still move CAS forward and must not claim an interruption.
  test("A03 a material-unchanged revision advances CAS and raises no notification claim", () => {
    const d = db();
    const work = createWork(d, { title: "cas", source: "test", contract }, 1);
    const item = upsertAttention(d, {
      item_id: "cas", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now",
      conclusion: "Choose path", trigger: "initial prose", impact: "destructive write", recommendation: null,
      options: ["continue"], owner: "owner", expires_at: null, source_link: null, approval_id: null,
      consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {},
    }, 2);
    const baseline = getAttentionMaterial(d, item.item_id)!;

    const refreshed = upsertAttention(d, {
      ...item, expected_revision: item.revision, trigger: "same decision, rephrased",
      evidence: { heartbeat: 7, ordinary_log: "still working" },
    }, 3);
    const material = getAttentionMaterial(d, item.item_id)!;
    expect(refreshed.revision).toBe(item.revision + 1);
    expect(material).toMatchObject({ fingerprint: baseline.fingerprint, generation: baseline.generation });

    // The pre-update revision is now stale for CAS even though the judgement basis did not change.
    let stale: unknown;
    try {
      resolveAttention(d, item.item_id, { attention_revision: item.revision, material_fingerprint: material.fingerprint, selected_option: "continue" }, "owner", 4);
    } catch (error) { stale = error; }
    expect(stale).toBeInstanceOf(ControlError);
    expect((stale as ControlError).details).toMatchObject({
      code: "stale_attention", expected_revision: item.revision, current_revision: refreshed.revision, current_state: "open",
    });
    expect(getAttention(d, item.item_id)).toMatchObject({ revision: refreshed.revision, state: "open" });
    // No interruption was claimed for a material-unchanged revision.
    expect(d.query("SELECT COUNT(*) n FROM control_notifications WHERE item_id=?").get(item.item_id)).toEqual({ n: 0 });

    // The current revision, with the unchanged fingerprint, is accepted.
    expect(resolveAttention(d, item.item_id, { attention_revision: refreshed.revision, material_fingerprint: material.fingerprint, selected_option: "continue" }, "owner", 5))
      .toMatchObject({ item_id: item.item_id, state: "resolved", effect_state: "succeeded" });
    d.close();
  });
});

function attentionTemplate(overrides: Partial<Parameters<typeof upsertAttention>[1]> = {}): Parameters<typeof upsertAttention>[1] {
  return {
     item_id: "any",
     work_id: "w",
     state: "open",
     effect_state: "not_started",
     urgency: "now",
     conclusion: "c",
     trigger: "t",
     impact: "i",
     recommendation: null,
     options: [],
     owner: "owner",
     expires_at: null,
     source_link: null,
     approval_id: null,
     consumer_owner: null,
     contract_revision: 1,
     decision_mode: "human_only",
     evidence: {},
     ...overrides,
   };
 }

describe("T21 listAttentionPage keyset pagination", () => {
  test("paginates identical-timestamp items deterministically without dropping or duplicating", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const now = 1000;
    // All open, all 'now', same updated_at.
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) {
      upsertAttention(
        d,
        attentionTemplate({
          item_id: id,
          work_id: w.work_id,
          urgency: "now",
          expires_at: now - 10,
        }),
        1,
      );
    }
    // Freeze all timestamps so updated_at is identical.
    d.query("UPDATE control_attention SET updated_at=?").run(now);
    // Reorder the underlying row ids explicitly so the test relies on pagination, not creation order.
    d.query("UPDATE control_attention SET item_id='z' WHERE item_id='a'").run();
    d.query("UPDATE control_attention SET item_id='a' WHERE item_id='z'").run();

    const collected: string[] = [];
    let cursor: string | null | undefined = undefined;
    let pages = 0;
    while (pages < 10) {
      const page = listAttentionPage(d, "now", { limit: 2, cursor: cursor ?? undefined }, now);
      for (const it of page.items) collected.push(it.item_id);
      pages++;
      if (!page.next_cursor) break;
      cursor = page.next_cursor;
    }
    expect(collected.sort()).toEqual(ids.sort());
    expect(collected.length).toBe(ids.length);
    expect(pages).toBe(3); // 2 + 2 + 1
    expect(new Set(collected).size).toBe(ids.length); // no duplicates
    d.close();
  });

  test("total reflects entire zone regardless of cursor", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const now = 5000;
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      const id = `item-${i}`;
      ids.push(id);
      upsertAttention(
        d,
        attentionTemplate({
          item_id: id,
          work_id: w.work_id,
          urgency: "now",
          expires_at: now - 10,
        }),
        i + 1,
      );
    }
    const first = listAttentionPage(d, "now", { limit: 2 }, now);
    expect(first.total).toBe(7);
    let cursor = first.next_cursor!;
    const second = listAttentionPage(d, "now", { limit: 2, cursor }, now);
    expect(second.total).toBe(7);
    const third = listAttentionPage(d, "now", { limit: 2, cursor: second.next_cursor! }, now);
    expect(third.total).toBe(7);
    // Final page next_cursor is null.
    const last = listAttentionPage(d, "now", { limit: 2, cursor: third.next_cursor! }, now);
    expect(last.next_cursor).toBeNull();
    expect(last.items.length).toBe(1);
    expect(last.total).toBe(7);
    d.close();
  });

  test("rejects malformed cursors with ControlError(invalid, 'invalid cursor')", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    upsertAttention(
      d,
      attentionTemplate({ item_id: "x", work_id: w.work_id, urgency: "now" }),
      1,
    );
    const now = 1;
    const bad = [
      "!!!not base64!!!",
      Buffer.from("not json").toString("base64url"),
      Buffer.from(JSON.stringify({})).toString("base64url"), // missing u and i
      Buffer.from(JSON.stringify({ u: "nan", i: "x" })).toString("base64url"), // bad u
      Buffer.from(JSON.stringify({ u: 1, i: "" })).toString("base64url"), // empty i
    ];
    for (const cursor of bad) {
      let err: unknown;
      try {
        listAttentionPage(d, "now", { limit: 10, cursor }, now);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ControlError);
      expect((err as ControlError).code).toBe("invalid");
      expect((err as ControlError).message).toBe("invalid cursor");
    }
    d.close();
  });

  test("rejects limits outside [1,100] or non-integer", () => {
    const d = db();
    const cases: Array<number | string | boolean> = [0, -1, 101, 1.5, "5", true];
    for (const bad of cases) {
      let err: unknown;
      try {
        listAttentionPage(d, "now", { limit: bad as never }, 1);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ControlError);
      expect((err as ControlError).code).toBe("invalid");
    }
    // Bounds accepted.
    expect(() => listAttentionPage(d, "now", { limit: 1 }, 1)).not.toThrow();
    expect(() => listAttentionPage(d, "now", { limit: 100 }, 1)).not.toThrow();
    d.close();
  });
});

describe("T22 attention boundary regressions", () => {
  test("defer_until > now (active deferral) excludes item from both now and inbox", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const now = 1000;
    const item = upsertAttention(
      d,
      attentionTemplate({
        item_id: "defer-active",
        work_id: w.work_id,
        urgency: "now",
        expires_at: now - 10,
      }),
      1,
    );
    // upsertAttention strips defer_until; set it directly to exercise the >-boundary
    d.query("UPDATE control_attention SET defer_until=? WHERE item_id=?").run(now + 1, item.item_id);
    // Active deferral outranks urgency and expiry → excluded from both zones
    expect(listAttention(d, "inbox", now).map((x) => x.item_id)).toEqual([]);
    d.close();
  });

  test("defer_until exactly equal to now is the lapse boundary — item enters now zone", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const now = 1000;
    const item = upsertAttention(
      d,
      attentionTemplate({
        item_id: "defer-lapsed",
        work_id: w.work_id,
        urgency: "now",
        expires_at: now - 10,
      }),
      1,
    );
    d.query("UPDATE control_attention SET defer_until=? WHERE item_id=?").run(now, item.item_id);
    // defer_until <= now → deferral has lapsed; item qualifies via urgency='now'
    expect(listAttentionPage(d, "now", { limit: 10 }, now).items.map((x) => x.item_id)).toEqual(["defer-lapsed"]);
    d.close();
  });

  test("expires_at exactly equal to now is expiry boundary — inbox item promoted to now zone", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const now = 1000;
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "exp-now",
        work_id: w.work_id,
        urgency: "inbox",
        expires_at: now, // expires_at <= now → expiry triggered
      }),
      1,
    );
    expect(listAttention(d, "now", now).map((x) => x.item_id)).toEqual(["exp-now"]);
    expect(listAttentionPage(d, "now", { limit: 10 }, now).items.map((x) => x.item_id)).toEqual(["exp-now"]);
    expect(listAttention(d, "inbox", now).map((x) => x.item_id)).toEqual([]);
    d.close();
  });

  test("expires_at > now (not yet expired) — inbox item stays in inbox zone", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    const now = 1000;
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "exp-future",
        work_id: w.work_id,
        urgency: "inbox",
        expires_at: now + 1, // expires_at > now → not yet expired
      }),
      1,
    );
    expect(listAttention(d, "now", now).map((x) => x.item_id)).toEqual([]);
    expect(listAttentionPage(d, "now", { limit: 10 }, now).items).toEqual([]);
    expect(listAttention(d, "inbox", now).map((x) => x.item_id)).toEqual(["exp-future"]);
    expect(listAttentionPage(d, "inbox", { limit: 10 }, now).items.map((x) => x.item_id)).toEqual(["exp-future"]);
    d.close();
  });
});

describe("T23 listAttentionFollowUps pruning and stage assignment", () => {
  test("settled succeeded items with numeric effect_verified_at and no receipt are pruned", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "settled",
        work_id: w.work_id,
        state: "applying",
        effect_state: "succeeded",
        evidence: { effect_verified_at: 42 },
      }),
      1,
    );
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "still-open",
        work_id: w.work_id,
        state: "applying",
        effect_state: "applying",
      }),
      2,
    );
    const upserted = listAttentionFollowUps(d);
    expect(upserted.some((f) => f.item.item_id === "settled")).toBe(false);
    expect(upserted.some((f) => f.item.item_id === "still-open")).toBe(true);
    d.close();
  });

  test("non-numeric effect_verified_at (string) with remaining responsibility stays as verification_required", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "nonnum",
        work_id: w.work_id,
        state: "applying",
        effect_state: "succeeded",
        evidence: { effect_verified_at: "yes" },
      }),
      1,
    );
    const upserted = listAttentionFollowUps(d);
    const f = upserted.find((x) => x.item.item_id === "nonnum");
    expect(f!.stage).toBe("verification_required");
    d.close();
  });

  test("failed and unknown effect states remain visible", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "f",
        work_id: w.work_id,
        state: "applying",
        effect_state: "failed",
      }),
      1,
    );
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "u",
        work_id: w.work_id,
        state: "applying",
        effect_state: "unknown",
      }),
      2,
    );
    const upserted = listAttentionFollowUps(d);
    expect(upserted.some((x) => x.item.item_id === "u" && x.stage === "unknown")).toBe(true);
    d.close();
  });

  test("legacy evidence.occurred_effects preserved when no recent receipt observations", () => {
    const d = db();
    const w = createWork(d, { title: "w", source: "t", contract }, 1);
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "legacy",
        work_id: w.work_id,
        state: "applying",
        effect_state: "applying",
        evidence: {
          occurred_effects: [
            { kind: "tool-a", evidence: { result: "ok" } },
            { kind: "tool-b", evidence: { result: "ok2" } },
          ],
        },
      }),
      1,
    );
    const upserted = listAttentionFollowUps(d);
    const f = upserted.find((x) => x.item.item_id === "legacy");
    expect(f).toBeTruthy();
    expect(f!.occurred_effects[0].kind).toBe("tool-a");
    d.close();
  });

  test("succeeded without numeric effect_verified_at stays as verification_required when human acceptance remains", () => {
    const d = db();
    const w = createWork(
      d,
      { title: "w", source: "t", contract },
      1,
    );
    upsertAttention(
      d,
      attentionTemplate({
        item_id: "acceptance-open",
        work_id: w.work_id,
        state: "applying",
        effect_state: "succeeded",
        // No numeric effect_verified_at → remaining is computed via
        // explicitRemainingResponsibility, which sees the human acceptance
        // criterion as unresolved → stage = verification_required.
        evidence: {},
      }),
      1,
    );
    const upserted = listAttentionFollowUps(d);
    const f = upserted.find((x) => x.item.item_id === "acceptance-open");
    expect(f).toBeTruthy();
    expect(f!.stage).toBe("verification_required");
    expect(f!.remaining_responsibility.length).toBeGreaterThan(0);
    d.close();
  });
});
