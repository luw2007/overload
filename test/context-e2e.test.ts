/**
 * test/context-e2e.test.ts — T12 端到端集成测试：上下文管理专项
 *
 * 覆盖方案 docs/architecture/context-management-plan.md §7 完整用户旅程：
 *   "帮我把 parseConfig 重构为纯函数并加测试"
 *
 * 场景 1：完整重构场景 §7 步骤 1–7，含两条分支
 *   - 6a 活会话 live + blocked-on-ask → jump 原现场，不产恢复包
 *   - 6b 死会话 terminated + checkpoint → 装配恢复包，从 checkpoint 续跑（不重写源文件）
 * 场景 2：权限拒绝端到端（非 owner 无 share → forbidden，连 short 摘要都不给）
 * 场景 3：stale 拒绝消费端到端（contract 版本漂移 → stale_or_revoked）
 * 场景 4：collector→reducer 幂等端到端（idempotent / 新版本 / quarantine）
 * 场景 5：Agent 任务包装配端到端（system prompt 注入 + scope 过滤）
 *
 * 不依赖外部服务；control 与 orchestrator 各用一个内存 SQLite。
 * 真实调用各模块 API，不 mock 内部函数。
 */
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---- control 层 ----
import {
  ControlError,
  createWork,
  upsertAttention,
  getAttention,
  ensureControlSchema,
} from "../src/control/store";
import type { Contract } from "../src/control/types";
import {
  createProblem,
  createObject,
  linkProblemObject,
  updateObject,
  getObject,
} from "../src/control/context-pool";
import {
  ingestFactObserved,
  ensureContextReducerSchema,
  type FactObservedPayload,
} from "../src/control/context-reducer";
import {
  getContextPackage,
  type DecisionViewPackage,
} from "../src/control/context-assembler";
import {
  pinContext,
  getPinnedVersion,
  readPinnedContent,
  shareObject,
} from "../src/control/context-pin";
import {
  markObjectUpdated,
  isStale,
  consumeDecisionWithReverify,
} from "../src/control/context-propagation";

// ---- orchestrator 层 ----
import {
  collectFacts,
  resetCollectorDedup,
} from "../src/orchestrator/context-collector";
import { buildAgentTaskContext } from "../src/orchestrator/agent-task-context";
import { determineRecoveryOutcome } from "../src/orchestrator/recovery-context";

// ========== 工具 ==========

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

const ORCH_SCHEMA = readFileSync(
  join(import.meta.dir, "..", "src", "orchestrator", "schema.sql"),
  "utf8",
);

/** 内存 control DB（含 context pool + reducer + outbox + mgmt schema）。 */
function newControlDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  return db;
}

/** 内存 orchestrator DB（tasks / task_events / approvals / task_recovery）。 */
function newOrchestratorDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ORCH_SCHEMA);
  db.run("INSERT OR IGNORE INTO spool_seq(id,seq,segment) VALUES(1,0,0)");
  return db;
}

/** 与 §7 例子一致的 contract：把 parseConfig 重构为纯函数并加测试。 */
function sampleContract(): Contract {
  return {
    objective: "把 parseConfig 重构为纯函数并加测试",
    acceptance: [
      { id: "a1", kind: "check", description: "parseConfig 是纯函数，无副作用" },
      { id: "a2", kind: "human", description: "公共 API 兼容" },
    ],
    non_goals: ["不改公共 API 签名"],
    scope: { repo: "myrepo", cwd: "/repo/myrepo", allowed_effects: ["write"] },
    budget: { retry_limit: 3 },
    stop_conditions: [{ id: "s1", kind: "hard", description: "不得改动 export 签名" }],
    decision_owner: "alice",
  };
}

function factPayload(over: Partial<FactObservedPayload>): FactObservedPayload {
  return {
    work_id: "",
    problem_id: null,
    object_canonical_key: "k",
    reference: "journal:1",
    source_type: "orchestrator",
    source_id: "orch-1",
    source_identity: "orchestrator",
    source_event_id: "ev-1",
    observation_revision: 1,
    attempt: null,
    fact_subtype: "test_result",
    content_hash: sha256("x"),
    sensitivity: "clean",
    collected_at: new Date().toISOString(),
    expires_at: null,
    derived_from: null,
    ...over,
  };
}

interface Scenario {
  controlDb: Database;
  orchestratorDb: Database;
  work: ReturnType<typeof createWork>;
  P0: ReturnType<typeof createProblem>;
  P1: ReturnType<typeof createProblem>;
  P2: ReturnType<typeof createProblem>;
  P3: ReturnType<typeof createProblem>;
  objObjective: ReturnType<typeof createObject>;
  objConstraints: ReturnType<typeof createObject>;
  objScene: ReturnType<typeof createObject>;
  factCode: { object_id: string; revision: number };
  factTest: { object_id: string; revision: number };
  factObs: { object_id: string; revision: number };
  item: ReturnType<typeof upsertAttention>;
}

/**
 * 搭建 §7 步骤 1–4 的前置现场：
 * 建 work → 根问题 P0 + 子问题 P1/P2/P3 → objective/constraints 对象 → facts → 决策点 attention item。
 * 不消费决策（留待主测试步骤 5）。
 */
function buildScenario(): Scenario {
  const controlDb = newControlDb();
  const orchestratorDb = newOrchestratorDb();

  // ---- 步骤 1：用户提问，建根问题 P0 ----
  const work = createWork(controlDb, {
    title: "重构 parseConfig",
    source: "e2e-test",
    contract: sampleContract(),
  });
  const work_id = work.work_id;

  const P0 = createProblem(controlDb, {
    work_id,
    parent_problem_id: null,
    title: "重构 parseConfig 并加测试",
  });

  const objectiveText = "把 parseConfig 重构为纯函数并加测试";
  const constraintsJson = JSON.stringify({
    non_goals: ["不改公共 API 签名"],
    scope: { repo: "myrepo" },
    budget: { retry_limit: 3 },
    stop_conditions: [{ id: "s1", kind: "hard", description: "不得改动 export 签名" }],
  });

  const objObjective = createObject(controlDb, {
    work_id,
    ctype: "objective",
    object_canonical_key: "objective",
    reference: `contract:${work_id}@1`,
    source_type: "contract",
    sensitivity: "clean",
    content_hash: sha256(objectiveText),
    summary_long: objectiveText,
  });
  const objConstraints = createObject(controlDb, {
    work_id,
    ctype: "constraints",
    object_canonical_key: "constraints",
    reference: `contract:${work_id}@1`,
    source_type: "contract",
    sensitivity: "clean",
    content_hash: sha256(constraintsJson),
    summary_long: constraintsJson,
  });
  linkProblemObject(controlDb, { problem_id: P0.problem_id, object_id: objObjective.object_id, revision: 1, role: "objective" });
  linkProblemObject(controlDb, { problem_id: P0.problem_id, object_id: objConstraints.object_id, revision: 1, role: "constraints" });

  // ---- 步骤 2：分解为子问题 P1/P2/P3，继承 P0 的 objective + constraints（rev=1 锁定）----
  const P1 = createProblem(controlDb, { work_id, parent_problem_id: P0.problem_id, title: "重构 parseConfig 为纯函数" });
  const P2 = createProblem(controlDb, { work_id, parent_problem_id: P0.problem_id, title: "为新 parseConfig 补单测" });
  const P3 = createProblem(controlDb, { work_id, parent_problem_id: P0.problem_id, title: "确认重构不破坏公共 API" });
  for (const p of [P1, P2, P3]) {
    linkProblemObject(controlDb, { problem_id: p.problem_id, object_id: objObjective.object_id, revision: 1, role: "objective" });
    linkProblemObject(controlDb, { problem_id: p.problem_id, object_id: objConstraints.object_id, revision: 1, role: "constraints" });
  }

  // ---- 步骤 3：Agent 执行，collector 采 facts（真实 reducer 投影）----
  // P1 代码变更 → code_state
  const factCode = ingestFactObserved(controlDb, factPayload({
    work_id, problem_id: P1.problem_id, object_canonical_key: "code:parseConfig",
    reference: "git:myrepo@abc123456", fact_subtype: "code_state",
    source_event_id: "ev-code-1", content_hash: sha256("HEAD=abc1234"),
  }));
  // P2 跑测试 → test_result
  const factTest = ingestFactObserved(controlDb, factPayload({
    work_id, problem_id: P2.problem_id, object_canonical_key: "test:p2",
    reference: "orchestrator:submit_result:p2-1", fact_subtype: "test_result",
    source_event_id: "ev-test-1", content_hash: sha256("exit_code=0"),
  }));
  // P3 检查公共 API → observation_evidence
  const factObs = ingestFactObserved(controlDb, factPayload({
    work_id, problem_id: P3.problem_id, object_canonical_key: "obs:p3",
    reference: "orchestrator:submit_result:p3-1", fact_subtype: "observation_evidence",
    source_event_id: "ev-obs-1", content_hash: sha256("export signature changed"),
  }));
  expect(factCode.status).toBe("created");
  expect(factTest.status).toBe("created");
  expect(factObs.status).toBe("created");

  // scene 对象（现场入口），挂到 P3
  const objScene = createObject(controlDb, {
    work_id,
    ctype: "scene",
    object_canonical_key: "scene:p3",
    reference: "artifact:p3@1",
    source_type: "orchestrator",
    sensitivity: "clean",
    content_hash: sha256("scene-p3"),
    summary_short: "pi session stable_id=abc turn=42",
  });
  linkProblemObject(controlDb, { problem_id: P3.problem_id, object_id: objScene.object_id, revision: 1, role: "scene" });

  // ---- 步骤 4：遇到决策点，建 attention item ----
  const item = upsertAttention(controlDb, {
    item_id: "att:p3:api-signature",
    work_id,
    state: "open",
    effect_state: "not_started",
    urgency: "now",
    conclusion: "公共 API 签名变更，是否接受？",
    trigger: "P3 检查发现 export 签名变更",
    impact: "违反 non_goals: 不改公共 API 签名",
    recommendation: "continue",
    options: ["continue", "stop"],
    owner: "alice",
    expires_at: null,
    source_link: "task://live-task-1",
    approval_id: null,
    consumer_owner: null,
    contract_revision: work.revision,
    decision_mode: "human_only",
    evidence: {},
  });

  // 注意：此处不创建 share。agent_task（actor=orchestrator）需要 share 的场景自行创建。
  return {
    controlDb, orchestratorDb, work, P0, P1, P2, P3,
    objObjective, objConstraints, objScene,
    factCode, factTest, factObs, item,
  };
}

// ========== 场景 1：完整重构场景 §7 步骤 1–7 ==========

describe("T12 场景 1：完整重构场景（§7 步骤 1–7，两条分支）", () => {
  test("步骤 1-3：建根问题/分解/collector 采 facts 入池", () => {
    const s = buildScenario();
    // pool 中三类 fact 都在
    for (const f of [s.factCode, s.factTest, s.factObs]) {
      const obj = getObject(s.controlDb, f.object_id);
      expect(obj).not.toBeNull();
    }
    expect(getObject(s.controlDb, s.factCode.object_id)?.fact_subtype).toBe("code_state");
    expect(getObject(s.controlDb, s.factTest.object_id)?.fact_subtype).toBe("test_result");
    expect(getObject(s.controlDb, s.factObs.object_id)?.fact_subtype).toBe("observation_evidence");
    // 子问题继承了 P0 的 objective + constraints
    expect(isStale(s.controlDb, s.P1.problem_id)).toBe(false);
    s.controlDb.close();
    s.orchestratorDb.close();
  });

  test("步骤 4：装配决策视图包（decision_view）必需字段齐全", () => {
    const s = buildScenario();
    const pkg = getContextPackage({
      consumer_type: "decision_ui",
      consumer_id: s.item.item_id,
      work_id: s.work.work_id,
      problem_id: s.P3.problem_id,
      package_type: "decision_view",
      actor: "alice",
      db: s.controlDb,
    });
    expect(pkg.ok).toBe(true);
    if (!pkg.ok) return;
    const dp = pkg.package as DecisionViewPackage;
    // 必需字段全部非空
    expect(dp.conclusion.length).toBeGreaterThan(0);
    expect(dp.trigger.length).toBeGreaterThan(0);
    expect(dp.impact.length).toBeGreaterThan(0);
    expect(dp.options.length).toBeGreaterThan(0);
    expect(dp.owner).toBe("alice");
    // trigger_evidence 含 P3 的 observation_evidence fact
    const obsEv = dp.trigger_evidence.find((e) => e.fact_subtype === "observation_evidence");
    expect(obsEv).toBeDefined();
    expect(obsEv?.reference).toBe("orchestrator:submit_result:p3-1");
    // 现场入口带 jump_target
    expect(dp.scene_entry?.jump_target).toBe("task://live-task-1");
    s.controlDb.close();
    s.orchestratorDb.close();
  });

  test("步骤 5：人决策消费 + pin 住旧证据版本", () => {
    const s = buildScenario();
    const resolved = consumeDecisionWithReverify(s.controlDb, {
      work_id: s.work.work_id,
      actor: "alice",
      item_id: s.item.item_id,
      expected_revision: s.item.revision,
      decision: { selected_option: "continue", reason: "接受公共 API 变更" },
      contract_revision: s.work.revision,
    });
    expect(resolved.state).toBe("resolved");
    expect(resolved.effect_state).toBe("succeeded");

    // decision 对象写入
    const objDecision = createObject(s.controlDb, {
      work_id: s.work.work_id,
      ctype: "decision",
      object_canonical_key: "decision:p3",
      reference: `attention:${s.item.item_id}@1`,
      source_type: "attention",
      sensitivity: "clean",
      content_hash: sha256("alice 接受 API 变更"),
      summary_short: "alice 接受公共 API 变更",
    });
    linkProblemObject(s.controlDb, { problem_id: s.P3.problem_id, object_id: objDecision.object_id, revision: 1, role: "decision" });

    // pin 住 fact rev1 + constraints rev1
    const pinFact = pinContext(s.controlDb, {
      object_id: s.factObs.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence",
    });
    const pinConstraints = pinContext(s.controlDb, {
      object_id: s.objConstraints.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence",
    });
    expect(pinFact.revision).toBe(1);
    expect(pinConstraints.revision).toBe(1);

    // pin 当前仍指向 rev1
    expect(getPinnedVersion(s.controlDb, pinFact.pin_id)?.version.revision).toBe(1);
    expect(getPinnedVersion(s.controlDb, pinConstraints.pin_id)?.version.revision).toBe(1);
    s.controlDb.close();
    s.orchestratorDb.close();
  });

  test("步骤 6a：活会话 live + blocked-on-ask → jump，不产恢复包", () => {
    const s = buildScenario();
    // orchestrator: live task + 未消费 approval
    s.orchestratorDb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,runner_pid,stable_id,created_at,updated_at,ci_observation_failures,retry_budget)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["live-task-1", "live", "myrepo", "main", "running", s.work.work_id, 99999, "pi-sess-abc", Date.now(), Date.now(), 0, 2],
    );
    s.orchestratorDb.run(
      `INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      ["appr-1", "live-task-1", "ready", "approve?", JSON.stringify(["yes", "no"]), Date.now(), Date.now() + 3600_000, null, null],
    );

    const outcome = determineRecoveryOutcome({
      controlDb: s.controlDb,
      orchestratorDb: s.orchestratorDb,
      work_id: s.work.work_id,
      task_id: "live-task-1",
      attempt_id: "att-live-1",
      actor: "alice",
    });
    expect(outcome.type).toBe("jump");
    if (outcome.type === "jump") {
      expect(outcome.jump_target).toBe("cmux://workspace/pi-sess-abc");
    }
    // 不产 recovery_package
    expect((outcome as { package?: unknown }).package).toBeUndefined();
    s.controlDb.close();
    s.orchestratorDb.close();
  });

  test("步骤 6b：死会话 terminated + checkpoint → 恢复包，不重写源文件", () => {
    const s = buildScenario();
    // 先消费决策使 work.revision=2（与 task.contract_revision 对齐，入口复验才通过）
    consumeDecisionWithReverify(s.controlDb, {
      work_id: s.work.work_id, actor: "alice", item_id: s.item.item_id,
      expected_revision: s.item.revision,
      decision: { selected_option: "continue", reason: "接受 API 变更" },
      contract_revision: s.work.revision,
    });

    // orchestrator: terminated task + session_bound（runner 支持恢复）+ checkpoint
    s.orchestratorDb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,stable_id,created_at,updated_at,ci_observation_failures,retry_budget,contract_revision)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["dead-task-1", "dead", "myrepo", "main", "done", s.work.work_id, "pi-sess-xyz", Date.now(), Date.now(), 0, 2, 2],
    );
    s.orchestratorDb.run(
      `INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)`,
      ["dead-task-1", Date.now(), "starting", "running", "session_bound", JSON.stringify({ stable_id: "pi-sess-xyz" })],
    );
    s.orchestratorDb.run(
      `INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)`,
      ["dead-task-1", Date.now(), "running", "awaiting_human", "runner_exit",
        JSON.stringify({ exit_code: 0, evidence_complete: true, checkpoint_reference: "ckpt://pi-sess-xyz/turn-42" })],
    );
    s.orchestratorDb.run(
      `INSERT INTO task_recovery(task_id,attempt_id,spawn_state,spawn_at,unknown_ticks) VALUES(?,?,?,?,?)`,
      ["dead-task-1", "att-dead-1", "spawned", Date.now(), 0],
    );

    const outcome = determineRecoveryOutcome({
      controlDb: s.controlDb,
      orchestratorDb: s.orchestratorDb,
      work_id: s.work.work_id,
      task_id: "dead-task-1",
      attempt_id: "att-dead-1",
      actor: "alice",
      problem_id: s.P3.problem_id,
    });
    expect(outcome.type).toBe("recovery_package");
    if (outcome.type !== "recovery_package") return;
    const pkg = outcome.package;
    expect(pkg.checkpoint_reference).toBe("ckpt://pi-sess-xyz/turn-42");
    expect(pkg.session_reference).toContain("pi-sess-xyz");
    // 已确认效果（runner_exit evidence_complete）
    expect(pkg.confirmed_effects.length).toBeGreaterThan(0);
    // 未完成步骤列表存在（不直接修改任何源文件）
    expect(Array.isArray(pkg.incomplete_steps)).toBe(true);
    // 恢复预算状态
    expect(pkg.recovery_budget.retry_budget_remaining).toBe(2);
    expect(pkg.recovery_budget.attempts).toBe(0);
    // 入口复验通过 → 合理建议
    expect(pkg.recommended_action).toBe("resume_from_checkpoint");
    expect(pkg.all_long).toBe(true);
    s.controlDb.close();
    s.orchestratorDb.close();
  });

  test("步骤 7：完成回流（约束更新 → 子问题 stale；pin 仍见旧版；决策卡 scene_entry）", () => {
    const s = buildScenario();
    // 先消费决策
    consumeDecisionWithReverify(s.controlDb, {
      work_id: s.work.work_id, actor: "alice", item_id: s.item.item_id,
      expected_revision: s.item.revision,
      decision: { selected_option: "continue", reason: "接受 API 变更" },
      contract_revision: s.work.revision,
    });

    // pin 住 constraints rev1 和 fact rev1
    const pinConstraints = pinContext(s.controlDb, {
      object_id: s.objConstraints.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence",
    });
    const pinFact = pinContext(s.controlDb, {
      object_id: s.factObs.object_id, revision: 1, pinned_by: "alice", purpose: "decision_evidence",
    });
    const oldConstraintsHash = getPinnedVersion(s.controlDb, pinConstraints.pin_id)!.version.content_hash;
    const oldFactHash = getPinnedVersion(s.controlDb, pinFact.pin_id)!.version.content_hash;

    // 更新 constraints 到 rev2（non_goals 放宽为允许 API 变更）
    const v2 = updateObject(s.controlDb, {
      object_id: s.objConstraints.object_id,
      expectedRevision: 1,
      patch: {
        content_hash: sha256("constraints v2 allows API change"),
        summary_long: JSON.stringify({
          non_goals: [], scope: { repo: "myrepo" }, budget: { retry_limit: 3 }, stop_conditions: [],
        }),
      },
    });
    expect(v2.revision).toBe(2);
    markObjectUpdated(s.controlDb, s.objConstraints.object_id, 2);

    // P1/P2/P3 都引用 constraints@1，现已出 rev2 → stale
    expect(isStale(s.controlDb, s.P1.problem_id)).toBe(true);
    expect(isStale(s.controlDb, s.P2.problem_id)).toBe(true);
    expect(isStale(s.controlDb, s.P3.problem_id)).toBe(true);

    // pin 持有者仍读到旧版 hash（pin 不屏蔽内容，alice 仍是 owner）
    expect(getPinnedVersion(s.controlDb, pinConstraints.pin_id)?.version.revision).toBe(1);
    expect(getPinnedVersion(s.controlDb, pinConstraints.pin_id)?.version.content_hash).toBe(oldConstraintsHash);
    expect(getPinnedVersion(s.controlDb, pinFact.pin_id)?.version.revision).toBe(1);
    const read = readPinnedContent(s.controlDb, pinFact.pin_id, "alice");
    expect(read.status).toBe("available");
    if (read.status === "available") expect(read.content_hash).toBe(oldFactHash);

    // attention effect_state=succeeded
    const itemAfter = getAttention(s.controlDb, s.item.item_id);
    expect(itemAfter?.state).toBe("resolved");
    expect(itemAfter?.effect_state).toBe("succeeded");

    // 决策卡 scene_entry 仍有 jump_target
    const pkg = getContextPackage({
      consumer_type: "decision_ui", consumer_id: s.item.item_id, work_id: s.work.work_id,
      problem_id: s.P3.problem_id, package_type: "decision_view", actor: "alice", db: s.controlDb,
    });
    expect(pkg.ok).toBe(true);
    if (pkg.ok) {
      const dp = pkg.package as DecisionViewPackage;
      expect(dp.scene_entry?.jump_target).toBe("task://live-task-1");
    }
    s.controlDb.close();
    s.orchestratorDb.close();
  });
});

// ========== 场景 2：权限拒绝端到端 ==========

describe("T12 场景 2：权限拒绝（非 owner 无 share → forbidden）", () => {
  test("actor=bob 不是 decision_owner 且无 share → forbidden，不给 short 摘要", () => {
    const s = buildScenario();
    const pkg = getContextPackage({
      consumer_type: "decision_ui", consumer_id: s.item.item_id, work_id: s.work.work_id,
      problem_id: s.P3.problem_id, package_type: "decision_view", actor: "bob", db: s.controlDb,
    });
    expect(pkg.ok).toBe(false);
    if (!pkg.ok) {
      expect(pkg.code).toBe("forbidden");
      // 连 short 摘要都不给：package 不应返回
      expect((pkg as { package?: unknown }).package).toBeUndefined();
    }
    s.controlDb.close();
    s.orchestratorDb.close();
  });
});

// ========== 场景 3：stale 拒绝消费端到端 ==========

describe("T12 场景 3：stale 拒绝消费（contract 版本漂移）", () => {
  test("消费前 contract 从 rev1 漂移到 rev2 → consumeDecisionWithReverify 拒绝 stale_or_revoked", () => {
    const db = newControlDb();
    const work = createWork(db, { title: "w", source: "stale-test", contract: sampleContract() });
    const item = upsertAttention(db, {
      item_id: "att-stale", work_id: work.work_id, state: "open", effect_state: "not_started",
      urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: "continue",
      options: ["continue", "stop"], owner: "alice", expires_at: null, source_link: null,
      approval_id: null, consumer_owner: null, contract_revision: work.revision,
      decision_mode: "human_only", evidence: {},
    });
    // 模拟 contract 已修订到 rev2（直接推进 work revision，不经过 reviseContract 以避免 supersede）
    db.run("UPDATE control_works SET revision=2 WHERE work_id=?", work.work_id);

    // 决策依据的 contract_revision=1 已过期 → 复验失败抛 ControlError(blocked)
    let threw = false;
    try {
      consumeDecisionWithReverify(db, {
        work_id: work.work_id, actor: "alice", item_id: item.item_id,
        expected_revision: item.revision,
        decision: { selected_option: "continue", reason: "x" },
        contract_revision: 1, // 期望旧版
      });
    } catch (e) {
      threw = true;
      expect(e).toBeInstanceOf(ControlError);
      expect((e as ControlError).code).toBe("blocked");
      expect((e as Error).message).toContain("stale_or_revoked");
    }
    expect(threw).toBe(true);
    db.close();
  });
});

// ========== 场景 4：collector→reducer 幂等端到端 ==========

describe("T12 场景 4：collector→reducer 幂等 / 新版本 / quarantine", () => {
  test("同一 fact 两次 ingest → idempotent；新观测 → 新版本；同键异内容 → quarantined", () => {
    const controlDb = newControlDb();
    const orchDb = newOrchestratorDb();
    const work = createWork(controlDb, { title: "w", source: "idem-test", contract: sampleContract() });

    // orchestrator: 一个 done task + runner_exit 事件
    orchDb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,created_at,updated_at,ci_observation_failures,retry_budget)
       VALUES(?,?,?,?,?,?,?,?,?,?)`,
      ["t-idem", "t", "myrepo", "main", "done", work.work_id, Date.now(), Date.now(), 0, 2],
    );
    orchDb.run(
      `INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)`,
      ["t-idem", Date.now(), "running", "awaiting_human", "runner_exit", JSON.stringify({ exit_code: 0 })],
    );

    resetCollectorDedup();
    const events = collectFacts({ orchestratorDb: orchDb, work_id: work.work_id, actor: "orchestrator" });
    expect(events.length).toBeGreaterThan(0);
    const first = events[0];

    // 第一次 ingest → created
    const r1 = ingestFactObserved(controlDb, first);
    expect(r1.status).toBe("created");

    const countBefore = (controlDb.query("SELECT COUNT(*) AS c FROM control_context_objects").get() as { c: number }).c;

    // 同一事件再 ingest → idempotent，对象数不变
    const r2 = ingestFactObserved(controlDb, first);
    expect(r2.status).toBe("idempotent");
    const countAfter = (controlDb.query("SELECT COUNT(*) AS c FROM control_context_objects").get() as { c: number }).c;
    expect(countAfter).toBe(countBefore);

    // 同一 source_event_id、observation_revision=2（内容变化）→ 创建新版本（同 object，rev+1）
    const evRev2: FactObservedPayload = { ...first, observation_revision: 2, content_hash: sha256("rerun exit_code=1") };
    const r3 = ingestFactObserved(controlDb, evRev2);
    expect(r3.status).toBe("created");
    if (r3.status === "created") {
      expect(getObject(controlDb, r3.object_id)?.revision).toBe(2);
    }

    // 同 idempotency_key（obs_revision=1）不同 content_hash → quarantined
    const evTamper: FactObservedPayload = { ...first, content_hash: sha256("tampered content") };
    const r4 = ingestFactObserved(controlDb, evTamper);
    expect(r4.status).toBe("quarantined");

    controlDb.close();
    orchDb.close();
  });
});

// ========== 场景 5：Agent 任务包装配端到端 ==========

describe("T12 场景 5：Agent 任务输入包装配", () => {
  test("system_prompt_injection 含 OVERLOAD CONTEXT 头 + objective/constraints/facts；scope 过滤生效", () => {
    const s = buildScenario();
    // orchestrator 不是 decision_owner，需显式 share 才能通过权限预检
    shareObject(s.controlDb, {
      object_id: s.objObjective.object_id, revision: 1,
      shared_with_work: s.work.work_id, granted_by: "alice",
    });
    const res = buildAgentTaskContext({
      db: s.controlDb,
      orchestratorDb: s.orchestratorDb,
      work_id: s.work.work_id,
      task_id: "task-agt-1",
      problem_id: s.P1.problem_id,
      actor: "orchestrator",
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // 系统提示注入头
    expect(res.system_prompt_injection).toContain("=== OVERLOAD CONTEXT ===");
    expect(res.system_prompt_injection).toContain("=== END OVERLOAD CONTEXT ===");
    // objective
    expect(res.system_prompt_injection).toContain("把 parseConfig 重构为纯函数并加测试");
    // constraints（non_goals / scope / budget / stop_conditions）
    expect(res.system_prompt_injection).toContain("不改公共 API 签名");
    // 相关 facts
    expect(res.system_prompt_injection).toContain("code_state");

    // scope 过滤：repo=myrepo → 只保留 reference/summary 含 myrepo 的 fact
    const scoped = buildAgentTaskContext({
      db: s.controlDb,
      orchestratorDb: s.orchestratorDb,
      work_id: s.work.work_id,
      task_id: "task-agt-2",
      problem_id: s.P1.problem_id,
      actor: "orchestrator",
      scope_filter: { repo: "myrepo" },
    });
    expect(scoped.ok).toBe(true);
    if (scoped.ok) {
      for (const f of scoped.package.relevant_facts) {
        expect(`${f.reference} ${f.summary}`.toLowerCase()).toContain("myrepo");
      }
    }
    s.controlDb.close();
    s.orchestratorDb.close();
  });
});
