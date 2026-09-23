import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureControlSchema, createWork, upsertAttention } from "./store";
import type { Contract } from "./types";
import {
  createObject,
  createProblem,
  linkProblemObject,
  updateObject,
  type ContextObject,
} from "./context-pool";
import { shareObject } from "./context-pin";
import { ensureContextReducerSchema, ingestFactObserved } from "./context-reducer";
import {
  getContextPackage,
  estimatePackageSize,
  type AssemblyResult,
} from "./context-assembler";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  return db;
}

function makeContract(owner = "alice"): Contract {
  return {
    objective: "refactor parseConfig to pure function and add tests",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: ["do not change public API signature"],
    scope: { repo: "/tmp/repo" },
    budget: { retry_limit: 3 },
    stop_conditions: [{ id: "s1", kind: "hard", description: "tests fail" }],
    decision_owner: owner,
  };
}

function makeFact(
  db: Database,
  workId: string,
  key: string,
  over: Partial<Parameters<typeof createObject>[1]> = {},
): ContextObject {
  return createObject(db, {
    work_id: workId,
    ctype: "fact",
    fact_subtype: "test_result",
    object_canonical_key: key,
    reference: `orchestrator:submit_result:${key}`,
    source_type: "orchestrator",
    content_hash: `hash-${key}`,
    sensitivity: "clean",
    summary_short: `short evidence ${key}`,
    ...over,
  });
}

function makeAttention(db: Database, workId: string, itemId = "item-1", over: Record<string, unknown> = {}) {
  return upsertAttention(db, {
    item_id: itemId,
    work_id: workId,
    state: "open",
    effect_state: "not_started",
    urgency: "now",
    conclusion: "accept the public API change?",
    trigger: "exported function signature changed",
    impact: "existing callers will break",
    recommendation: "accept",
    options: ["accept", "revert"],
    owner: "alice",
    expires_at: null,
    source_link: "session://jump/1",
    approval_id: null,
    consumer_owner: null,
    contract_revision: 1,
    decision_mode: "human_only",
    evidence: {},
    ...over,
  } as Parameters<typeof upsertAttention>[1]);
}

function expectOk(result: AssemblyResult) {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.reason}`);
  return result;
}

describe("T5 context-assembler", () => {
  test("1. 决策视图包：完整装配，必需字段非空", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    makeAttention(db, work.work_id, "item-1");

    const fact = makeFact(db, work.work_id, "fact-1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: fact.object_id, revision: 1, role: "fact" }, 3);

    const decision = createObject(db, {
      work_id: work.work_id, ctype: "decision", object_canonical_key: "dec-1",
      reference: `attention:item-1@1`, source_type: "attention", content_hash: "h-dec",
      sensitivity: "clean", summary_short: "previously decided to keep internal API",
    });
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: decision.object_id, revision: 1, role: "decision" }, 4);

    const artifact = createObject(db, {
      work_id: work.work_id, ctype: "artifact", object_canonical_key: "art-1",
      reference: "artifact:art-1@1", source_type: "artifact", content_hash: "h-art",
      sensitivity: "clean", summary_short: "PR #42 diff",
    });
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: artifact.object_id, revision: 1, role: "artifact" }, 5);

    const scene = createObject(db, {
      work_id: work.work_id, ctype: "scene", object_canonical_key: "scn-1",
      reference: "git:repo@abcdef1", source_type: "orchestrator", content_hash: "h-scn",
      sensitivity: "clean", summary_short: "session at turn 42",
    });
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: scene.object_id, revision: 1, role: "scene" }, 6);

    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    const ok = expectOk(result);
    expect(ok.package.package_type).toBe("decision_view");
    if (ok.package.package_type !== "decision_view") throw new Error("type");
    expect(ok.package.conclusion).toBeTruthy();
    expect(ok.package.trigger).toBeTruthy();
    expect(ok.package.impact).toBeTruthy();
    expect(ok.package.options.length).toBeGreaterThan(0);
    expect(ok.package.owner).toBe("alice");
    expect(ok.package.trigger_evidence.length).toBe(1);
    expect(ok.package.trigger_evidence[0].object_id).toBe(fact.object_id);
    expect(ok.package.prior_decisions.length).toBe(1);
    expect(ok.package.artifacts.length).toBe(1);
    expect(ok.package.artifacts[0].content_hash).toBe("h-art");
    expect(ok.package.scene_entry).not.toBeNull();
    expect(ok.package.scene_entry!.jump_target).toBe("session://jump/1");
    db.close();
  });

  test("2. 决策视图包：attention item 不存在 → needs_context", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "nope", work_id: work.work_id,
      package_type: "decision_view", actor: "alice", db,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("needs_context");
    db.close();
  });

  test("3. 决策视图包：actor 非 owner 且无 share → forbidden", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    makeAttention(db, work.work_id, "item-1");
    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      package_type: "decision_view", actor: "mallory", db,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("forbidden");
    db.close();
  });

  test("4. 决策视图包：facts 从 pool 捞出非空", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    makeAttention(db, work.work_id, "item-1");
    const f1 = makeFact(db, work.work_id, "fact-a");
    const f2 = makeFact(db, work.work_id, "fact-b");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: f1.object_id, revision: 1, role: "fact" }, 3);
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: f2.object_id, revision: 1, role: "fact" }, 4);

    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    const ok = expectOk(result);
    if (ok.package.package_type !== "decision_view") throw new Error("type");
    expect(ok.package.trigger_evidence.length).toBe(2);
    expect(ok.package.trigger_evidence.every((e) => typeof e.summary === "string" && e.reference)).toBe(true);
    db.close();
  });

  test("5. Agent 任务包：objective + constraints + facts，constraints 结构化正确", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);

    const objective = createObject(db, {
      work_id: work.work_id, ctype: "objective", object_canonical_key: "obj-1",
      reference: `contract:${work.work_id}@1`, source_type: "contract", content_hash: "h-obj",
      sensitivity: "clean", summary_long: "refactor parseConfig to a pure function",
    });
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: objective.object_id, revision: 1, role: "objective" }, 3);

    const constraints = createObject(db, {
      work_id: work.work_id, ctype: "constraints", object_canonical_key: "con-1",
      reference: `contract:${work.work_id}@1`, source_type: "contract", content_hash: "h-con",
      sensitivity: "clean",
      summary_long: JSON.stringify({
        non_goals: ["do not change public API signature"],
        scope: { repo: "/tmp/repo" },
        budget: { retry_limit: 3 },
        stop_conditions: [{ id: "s1", kind: "hard", description: "tests fail" }],
      }),
    });
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: constraints.object_id, revision: 1, role: "constraints" }, 4);

    const fact = makeFact(db, work.work_id, "fact-1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: fact.object_id, revision: 1, role: "fact" }, 5);

    const result = getContextPackage({
      consumer_type: "agent_task", consumer_id: "task-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "agent_task", actor: "alice", db,
    });
    const ok = expectOk(result);
    expect(ok.package.package_type).toBe("agent_task");
    if (ok.package.package_type !== "agent_task") throw new Error("type");
    expect(ok.package.objective.summary).toContain("refactor parseConfig");
    expect(ok.package.constraints.non_goals).toEqual(["do not change public API signature"]);
    expect(ok.package.constraints.budget).toEqual({ retry_limit: 3 });
    expect(ok.package.constraints.stop_conditions[0].id).toBe("s1");
    expect(ok.package.relevant_facts.length).toBe(1);
    db.close();
  });

  test("6. Agent 任务包：pool 无 objective/constraints，从 contract 回退构造", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    createProblem(db, { work_id: work.work_id, title: "root" }, 2);

    const result = getContextPackage({
      consumer_type: "agent_task", consumer_id: "task-1", work_id: work.work_id,
      package_type: "agent_task", actor: "alice", db,
    });
    const ok = expectOk(result);
    if (ok.package.package_type !== "agent_task") throw new Error("type");
    expect(ok.package.objective.summary).toBe("refactor parseConfig to pure function and add tests");
    expect(ok.package.objective.reference).toBe(`contract:${work.work_id}@1`);
    expect(ok.package.constraints.non_goals).toEqual(["do not change public API signature"]);
    expect(ok.package.constraints.reference).toBe(`contract:${work.work_id}@1`);
    db.close();
  });

  test("7. Agent 任务包：无 objective 且无 contract → needs_context", () => {
    const db = fixture();
    // work 有 decision_owner=alice（actor 通过入口预检），但 contract 无 objective → 装配缺 objective
    db.query(
      `INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("w7", "t", "test", null, "active", 1, JSON.stringify({ decision_owner: "alice" }), 1, 1);

    const result = getContextPackage({
      consumer_type: "agent_task", consumer_id: "task-1", work_id: "w7",
      package_type: "agent_task", actor: "alice", db,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("needs_context");
    db.close();
  });

  test("8. 恢复包：聚合数据 + 复验通过 → 返回 RecoveryPackage", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const result = getContextPackage({
      consumer_type: "recovery", consumer_id: "attempt-1", work_id: work.work_id,
      package_type: "recovery", actor: "alice", db,
      recovery_aggregated: {
        checkpoint_reference: "orchestrator:checkpoint:step5",
        session_reference: "sess-stable-123",
        binding: { cwd: "/tmp/repo" },
        confirmed_effects: [{ description: "wrote file parseConfig.ts", ledger_reference: "journal:42" }],
        incomplete_steps: [{ description: "run tests" }],
        unknown_items: [],
        recovery_budget: { attempts: 1, unknown_ticks: 0, retry_budget_remaining: 2 },
        recommended_action: "resume_from_checkpoint",
        contract_revision: work.revision,
      },
    });
    const ok = expectOk(result);
    expect(ok.package.package_type).toBe("recovery");
    if (ok.package.package_type !== "recovery") throw new Error("type");
    expect(ok.package.checkpoint_reference).toBe("orchestrator:checkpoint:step5");
    expect(ok.package.recommended_action).toBe("resume_from_checkpoint");
    expect(ok.package.all_long).toBe(true);
    expect(ok.package.confirmed_effects.length).toBe(1);
    db.close();
  });

  test("9. 恢复包：contract 版本不匹配 → stale_or_revoked", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const result = getContextPackage({
      consumer_type: "recovery", consumer_id: "attempt-1", work_id: work.work_id,
      package_type: "recovery", actor: "alice", db,
      recovery_aggregated: {
        checkpoint_reference: "orchestrator:checkpoint:step5",
        session_reference: "sess-1",
        binding: {},
        confirmed_effects: [],
        incomplete_steps: [],
        unknown_items: [],
        recovery_budget: { attempts: 1, unknown_ticks: 0, retry_budget_remaining: 2 },
        recommended_action: "resume_from_checkpoint",
        contract_revision: 99,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("stale_or_revoked");
    db.close();
  });

  test("10. 恢复包：缺 checkpoint_reference → needs_context", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const result = getContextPackage({
      consumer_type: "recovery", consumer_id: "attempt-1", work_id: work.work_id,
      package_type: "recovery", actor: "alice", db,
      recovery_aggregated: {
        checkpoint_reference: "",
        session_reference: "sess-1",
        binding: {},
        confirmed_effects: [],
        incomplete_steps: [],
        unknown_items: [],
        recovery_budget: { attempts: 1, unknown_ticks: 0, retry_budget_remaining: 2 },
        recommended_action: "escalate_to_human",
        contract_revision: work.revision,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("needs_context");
    db.close();
  });

  test("11. 预算超限：大量 facts → budget_limited，必需字段不降级", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    makeAttention(db, work.work_id, "item-1");
    for (let i = 0; i < 30; i++) {
      const f = makeFact(db, work.work_id, `fact-${i}`, {
        summary_short: `x`.repeat(200),
      });
      linkProblemObject(db, { problem_id: problem.problem_id, object_id: f.object_id, revision: 1, role: "fact" }, 100 + i);
    }
    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
      budget: { max_bytes: 2048 },
    });
    const ok = expectOk(result);
    if (ok.package.package_type !== "decision_view") throw new Error("type");
    expect(ok.package.budget_limited).toBe(true);
    // 必需字段不降级
    expect(ok.package.conclusion).toBeTruthy();
    expect(ok.package.trigger).toBeTruthy();
    expect(ok.package.impact).toBeTruthy();
    expect(ok.package.options.length).toBeGreaterThan(0);
    expect(ok.package.owner).toBe("alice");
    db.close();
  });

  test("12. stale 标记：对象出新版后对应 evidence 标 stale", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    makeAttention(db, work.work_id, "item-1");
    const fact = makeFact(db, work.work_id, "fact-1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: fact.object_id, revision: 1, role: "fact" }, 3);

    const before = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    const b = expectOk(before);
    if (b.package.package_type !== "decision_view") throw new Error("type");
    expect(b.package.trigger_evidence[0].stale).toBeUndefined();

    // 对象出新版（head revision → 2），problem_objects 仍锁定 rev 1
    updateObject(db, { object_id: fact.object_id, expectedRevision: 1, patch: { content_hash: "hash-v2", summary_short: "updated" } }, 4);

    const after = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    const a = expectOk(after);
    if (a.package.package_type !== "decision_view") throw new Error("type");
    expect(a.package.trigger_evidence[0].stale).toBe(true);
    expect(a.package.stale_objects.length).toBe(1);
    expect(a.package.stale_objects[0].current_revision).toBe(2);
    expect(a.package.stale_objects[0].linked_revision).toBe(1);
    db.close();
  });

  test("13. visibility 投影：confirmed_secret 无 grant → 不出现在包中", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    makeAttention(db, work.work_id, "item-1");

    const clean = makeFact(db, work.work_id, "clean-fact");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: clean.object_id, revision: 1, role: "fact" }, 3);

    const secret = makeFact(db, work.work_id, "secret-fact", {
      sensitivity: "confirmed_secret",
      summary_short: "SHOULD NOT LEAK",
    });
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: secret.object_id, revision: 1, role: "fact" }, 4);

    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    const ok = expectOk(result);
    if (ok.package.package_type !== "decision_view") throw new Error("type");
    expect(ok.package.trigger_evidence.length).toBe(1);
    expect(ok.package.trigger_evidence[0].object_id).toBe(clean.object_id);
    db.close();
  });

  test("14. sensitivity=unknown fact → 不出现在包中", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    makeAttention(db, work.work_id, "item-1");

    const clean = makeFact(db, work.work_id, "clean-fact");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: clean.object_id, revision: 1, role: "fact" }, 3);

    const unknown = makeFact(db, work.work_id, "unknown-fact", { sensitivity: "unknown" });
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: unknown.object_id, revision: 1, role: "fact" }, 4);

    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    const ok = expectOk(result);
    if (ok.package.package_type !== "decision_view") throw new Error("type");
    expect(ok.package.trigger_evidence.length).toBe(1);
    expect(ok.package.trigger_evidence[0].object_id).toBe(clean.object_id);
    db.close();
  });

  test("15. 端到端 collector→reducer→assembler：ingestFactObserved 投影后 assembler 能捞出", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    makeAttention(db, work.work_id, "item-1");

    const ingested = ingestFactObserved(db, {
      work_id: work.work_id,
      problem_id: problem.problem_id,
      object_canonical_key: "test-parse",
      reference: "orchestrator:submit_result:attempt-9",
      source_type: "orchestrator",
      source_id: "runner-1",
      source_identity: "alice",
      source_event_id: "evt-9",
      observation_revision: 1,
      attempt: "attempt-9",
      fact_subtype: "test_result",
      content_hash: "hash-evt-9",
      sensitivity: "clean",
      collected_at: "2026-09-22T10:00:00.000Z",
      expires_at: null,
      derived_from: null,
    });
    expect(ingested.status).toBe("created");

    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      problem_id: problem.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    const ok = expectOk(result);
    if (ok.package.package_type !== "decision_view") throw new Error("type");
    expect(ok.package.trigger_evidence.length).toBe(1);
    expect(ok.package.trigger_evidence[0].fact_subtype).toBe("test_result");
    expect(ok.package.trigger_evidence[0].reference).toBe("orchestrator:submit_result:attempt-9");
    db.close();
  });
});

describe("T5 estimatePackageSize", () => {
  test("returns positive byte length", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    makeAttention(db, work.work_id, "item-1");
    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-1", work_id: work.work_id,
      package_type: "decision_view", actor: "alice", db,
    });
    const ok = expectOk(result);
    expect(estimatePackageSize(ok.package)).toBeGreaterThan(0);
    db.close();
  });
});

describe("Fix4b assertWorkAccess work 级 share 不授权任意 actor", () => {
  test("A share 对象给 B；actor=mallory（非 B owner、无个人 grant）→ forbidden，不返回摘要", () => {
    const db = fixture();
    // A 把对象共享给 B
    const workA = createWork(db, { title: "A", source: "test", contract: makeContract("alice") }, 1);
    const workB = createWork(db, { title: "B", source: "test", contract: makeContract("bob") }, 2);
    const problemB = createProblem(db, { work_id: workB.work_id, title: "B root" }, 3);
    makeAttention(db, workB.work_id, "item-b");
    // B 自己的 fact（内部摘要）
    const bFact = makeFact(db, workB.work_id, "b-fact", { summary_short: "B 内部秘密摘要" });
    linkProblemObject(db, { problem_id: problemB.problem_id, object_id: bFact.object_id, revision: 1, role: "fact" }, 4);
    // A 的对象共享给 B
    const aObj = makeFact(db, workA.work_id, "a-obj", { summary_short: "A shared content" });
    shareObject(db, { object_id: aObj.object_id, revision: 1, shared_with_work: workB.work_id, granted_by: "alice" }, 5);

    // mallory 不是 B 的 owner，也无个人 grant → 即使 B 名下存在 A→B 的 share，也必须 forbidden
    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-b", work_id: workB.work_id,
      problem_id: problemB.problem_id, package_type: "decision_view", actor: "mallory", db,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("forbidden");
      expect(JSON.stringify(result)).not.toContain("B 内部秘密摘要");
    }
    db.close();
  });

  test("正例：actor=B 的 decision_owner(bob) → 可装配 B 的决策视图", () => {
    const db = fixture();
    const workA = createWork(db, { title: "A", source: "test", contract: makeContract("alice") }, 1);
    const workB = createWork(db, { title: "B", source: "test", contract: makeContract("bob") }, 2);
    const problemB = createProblem(db, { work_id: workB.work_id, title: "B root" }, 3);
    makeAttention(db, workB.work_id, "item-b");
    const bFact = makeFact(db, workB.work_id, "b-fact");
    linkProblemObject(db, { problem_id: problemB.problem_id, object_id: bFact.object_id, revision: 1, role: "fact" }, 4);
    const aObj = makeFact(db, workA.work_id, "a-obj");
    shareObject(db, { object_id: aObj.object_id, revision: 1, shared_with_work: workB.work_id, granted_by: "alice" }, 5);

    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-b", work_id: workB.work_id,
      problem_id: problemB.problem_id, package_type: "decision_view", actor: "bob", db,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.package.work_id).toBe(workB.work_id);
    db.close();
  });

  test("actor=A 的 decision_owner(alice，share 授予方) 请求 B → forbidden（不持有 B 的入口权）", () => {
    const db = fixture();
    const workA = createWork(db, { title: "A", source: "test", contract: makeContract("alice") }, 1);
    const workB = createWork(db, { title: "B", source: "test", contract: makeContract("bob") }, 2);
    const problemB = createProblem(db, { work_id: workB.work_id, title: "B root" }, 3);
    makeAttention(db, workB.work_id, "item-b");
    const bFact = makeFact(db, workB.work_id, "b-fact");
    linkProblemObject(db, { problem_id: problemB.problem_id, object_id: bFact.object_id, revision: 1, role: "fact" }, 4);
    const aObj = makeFact(db, workA.work_id, "a-obj");
    shareObject(db, { object_id: aObj.object_id, revision: 1, shared_with_work: workB.work_id, granted_by: "alice" }, 5);

    const result = getContextPackage({
      consumer_type: "decision_ui", consumer_id: "item-b", work_id: workB.work_id,
      problem_id: problemB.problem_id, package_type: "decision_view", actor: "alice", db,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("forbidden");
    db.close();
  });
});
