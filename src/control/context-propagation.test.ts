import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ControlError, ensureControlSchema, createWork, upsertAttention, getWork, actOnAttention } from "./store";
import {
  createObject,
  createProblem,
  getObject,
  linkProblemObject,
  updateObject,
} from "./context-pool";
import {
  markObjectUpdated,
  isStale,
  getStaleObjects,
  reverifyBeforeAction,
  withReverify,
  consumeDecisionWithReverify,
} from "./context-propagation";
import type { Contract } from "./types";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  return db;
}

function makeContract(owner: string): Contract {
  return {
    objective: "test objective",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: [],
    scope: { repo: "/tmp/repo" },
    budget: {},
    stop_conditions: [],
    decision_owner: owner,
  };
}

function makeObject(db: Database, workId: string, key: string, hash: string, sensitivity: "clean" | "confirmed_secret" = "clean") {
  return createObject(db, {
    work_id: workId,
    ctype: "fact",
    fact_subtype: "code_state",
    object_canonical_key: key,
    reference: `ref:${key}`,
    source_type: "orchestrator",
    content_hash: hash,
    sensitivity,
    shareable: sensitivity === "clean" ? 1 : 0,
  }, 1);
}

describe("T8 markObjectUpdated", () => {
  test("updates updated_at on directly referencing problems and emits context.updated event", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 3);

    const oldUpdatedAt = problem.updated_at;
    // 对象出新版
    updateObject(db, { object_id: obj.object_id, expectedRevision: 1, patch: { content_hash: "h2", reference: "ref:k2" } }, 4);

    // 手动调用 markObjectUpdated（模拟 updateObject 后触发）
    markObjectUpdated(db, obj.object_id, 2, 5);

    // 问题 updated_at 被刷新
    const updatedProblem = db.query("SELECT updated_at FROM control_context_problems WHERE problem_id=?").get(problem.problem_id) as { updated_at: number };
    expect(updatedProblem.updated_at).toBeGreaterThan(oldUpdatedAt);

    // context.updated 事件已入 outbox
    const evt = db.query("SELECT * FROM control_outbox WHERE kind='context.updated' AND entity_id=?").get(obj.object_id) as Record<string, unknown> | null;
    expect(evt).toBeTruthy();
    expect(evt!.entity_version).toBe(2);
    db.close();
  });

  test("does not cascade to indirect references (only direct problem_objects links)", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const root = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    const child = createProblem(db, { work_id: work.work_id, parent_problem_id: root.problem_id, title: "child" }, 3);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    // 只把对象链接到 root，不链接到 child
    linkProblemObject(db, { problem_id: root.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 4);

    const childBefore = db.query("SELECT updated_at FROM control_context_problems WHERE problem_id=?").get(child.problem_id) as { updated_at: number };
    markObjectUpdated(db, obj.object_id, 2, 5);
    const childAfter = db.query("SELECT updated_at FROM control_context_problems WHERE problem_id=?").get(child.problem_id) as { updated_at: number };
    expect(childAfter.updated_at).toBe(childBefore.updated_at);
    db.close();
  });
});

describe("T8 isStale / getStaleObjects", () => {
  test("isStale returns true when linked object has a newer revision", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 3);

    expect(isStale(db, problem.problem_id)).toBe(false);
    updateObject(db, { object_id: obj.object_id, expectedRevision: 1, patch: { content_hash: "h2", reference: "ref:k2" } }, 4);
    expect(isStale(db, problem.problem_id)).toBe(true);
    db.close();
  });

  test("getStaleObjects returns correct version comparison", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    const obj1 = makeObject(db, work.work_id, "k1", "h1");
    const obj2 = makeObject(db, work.work_id, "k2", "h1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: obj1.object_id, revision: 1, role: "fact" }, 3);
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: obj2.object_id, revision: 1, role: "fact" }, 4);

    expect(getStaleObjects(db, problem.problem_id)).toHaveLength(0);
    updateObject(db, { object_id: obj1.object_id, expectedRevision: 1, patch: { content_hash: "h2", reference: "ref:k2" } }, 5);
    const stale = getStaleObjects(db, problem.problem_id);
    expect(stale).toHaveLength(1);
    expect(stale[0].object_id).toBe(obj1.object_id);
    expect(stale[0].linked_revision).toBe(1);
    expect(stale[0].current_revision).toBe(2);
    db.close();
  });
});

describe("T8 reverifyBeforeAction", () => {
  test("permission denied when actor is not decision_owner and no share exists", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const result = reverifyBeforeAction(db, {
      entry: "consume_decision",
      work_id: work.work_id,
      actor: "bob",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("permission_denied");
    db.close();
  });

  test("contract revision mismatch → stale_or_revoked", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const result = reverifyBeforeAction(db, {
      entry: "consume_decision",
      work_id: work.work_id,
      actor: "alice",
      contract_revision: 99,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("stale_or_revoked");
    db.close();
  });

  test("evidence purged → evidence_mismatch", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 3);
    // purge the object
    db.query("UPDATE control_context_objects SET purged_at=?, tombstone_reason=? WHERE object_id=?").run(new Date().toISOString(), "expired", obj.object_id);

    const result = reverifyBeforeAction(db, {
      entry: "consume_decision",
      work_id: work.work_id,
      actor: "alice",
      problem_id: problem.problem_id,
      required_evidence_version: 1,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("evidence_mismatch");
    db.close();
  });

  test("all checks pass → allowed", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    const obj = makeObject(db, work.work_id, "k1", "h1");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 3);

    const result = reverifyBeforeAction(db, {
      entry: "consume_decision",
      work_id: work.work_id,
      actor: "alice",
      contract_revision: work.revision,
      problem_id: problem.problem_id,
      required_evidence_version: 1,
    });
    expect(result.allowed).toBe(true);
    db.close();
  });
});

describe("T8 withReverify", () => {
  test("throws ControlError on reverify failure and rolls back", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    let actionRan = false;
    expect(() =>
      withReverify(db, {
        entry: "consume_decision",
        work_id: work.work_id,
        actor: "bob", // wrong actor → permission denied
      }, () => {
        actionRan = true;
        return "done";
      }),
    ).toThrow(ControlError);
    expect(actionRan).toBe(false);
    db.close();
  });

  test("runs action when reverify passes", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const result = withReverify(db, {
      entry: "start_controlled_action",
      work_id: work.work_id,
      actor: "alice",
    }, () => "ok");
    expect(result).toBe("ok");
    db.close();
  });
});

describe("T8 consumeDecisionWithReverify", () => {
  test("rejects consumption when reverify fails", () => {
    const db = fixture();
    const contract = makeContract("alice");
    const work = createWork(db, { title: "w", source: "test", contract }, 1);
    const item = upsertAttention(db, {
      item_id: "item1",
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: "test decision",
      trigger: "trigger",
      impact: "impact",
      recommendation: null,
      options: ["continue", "stop"],
      owner: "alice",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: {},
    }, 2);

    // bob has no permission → should throw
    expect(() =>
      consumeDecisionWithReverify(db, {
        work_id: work.work_id,
        actor: "bob",
        item_id: item.item_id,
        expected_revision: item.revision,
        decision: { selected_option: "continue" },
      }),
    ).toThrow(ControlError);

    // item should still be open (not consumed)
    const stillOpen = db.query("SELECT state FROM control_attention WHERE item_id=?").get(item.item_id) as { state: string };
    expect(stillOpen.state).toBe("open");
    db.close();
  });
});

describe("actOnAttention 复验失败拒绝消费（真实路径内联复验）", () => {
  test("错误 actor 调 actOnAttention resolve → 抛 ControlError，attention 状态不变", () => {
    const db = fixture();
    const contract = makeContract("alice");
    const work = createWork(db, { title: "w", source: "test", contract }, 1);
    const item = upsertAttention(db, {
      item_id: "item-perm",
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: "test decision",
      trigger: "trigger",
      impact: "impact",
      recommendation: null,
      options: ["continue", "stop"],
      owner: "alice",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: {},
    }, 2);

    // bob 不是 decision_owner，也没有 share → 拒绝
    expect(() =>
      actOnAttention(db, item.item_id, item.revision, "resolve", { selected_option: "continue" }, "bob"),
    ).toThrow(ControlError);

    // attention 仍 open
    const still = getAttentionRaw(db, item.item_id);
    expect(still.state).toBe("open");
    expect(still.effect_state).toBe("not_started");
    db.close();
  });

  test("非 owner actor + 入站 share → resolve 仍被拒绝（share 不授予决策入口）", () => {
    const db = fixture();
    const contract = makeContract("alice");
    const work = createWork(db, { title: "w", source: "test", contract }, 1);
    // work 带 context（problem + object），触发 needsAuth。
    const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
    const obj = makeObject(db, work.work_id, "k-share", "h-share");
    linkProblemObject(db, { problem_id: problem.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 3);

    // 入站 share：某对象被共享给本 work（shared_with_work = 本 work）。
    // 旧实现仅凭此放行任意非 owner actor；正确模型下 share 是对象级引用授权，不授予决策入口。
    db.query(
      "INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES (?,?,?,?,?,?)",
    ).run("s1", obj.object_id, 1, work.work_id, "alice", 4);

    const item = upsertAttention(db, {
      item_id: "item-share",
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: "test decision",
      trigger: "trigger",
      impact: "impact",
      recommendation: null,
      options: ["continue"],
      owner: "alice",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: { object_id: obj.object_id, revision: 1 },
    }, 5);

    // bob 非 decision_owner：即使存在入站 share 也必须 fail-closed。
    expect(() =>
      actOnAttention(db, item.item_id, item.revision, "resolve", { selected_option: "continue" }, "bob"),
    ).toThrow(ControlError);

    const still = getAttentionRaw(db, item.item_id);
    expect(still.state).toBe("open");
    expect(still.effect_state).toBe("not_started");

    // 对照：owner 本人仍可 resolve。
    const ok = actOnAttention(db, item.item_id, item.revision, "resolve", { selected_option: "continue" }, "alice");
    expect(ok.state).toBe("resolved");
    db.close();
  });

  test("正确 actor (decision_owner) 调 actOnAttention resolve → 成功消费", () => {
    const db = fixture();
    const contract = makeContract("alice");
    const work = createWork(db, { title: "w", source: "test", contract }, 1);
    const item = upsertAttention(db, {
      item_id: "item-ok",
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: "test decision",
      trigger: "trigger",
      impact: "impact",
      recommendation: null,
      options: ["continue", "stop"],
      owner: "alice",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: {},
    }, 2);

    const result = actOnAttention(db, item.item_id, item.revision, "resolve", { selected_option: "continue" }, "alice");
    expect(result.state).toBe("resolved");
    db.close();
  });

  test("contract 版本变更后用旧版本消费 → 拒绝", () => {
    const db = fixture();
    const contract = makeContract("alice");
    const work = createWork(db, { title: "w", source: "test", contract }, 1);
    const item = upsertAttention(db, {
      item_id: "item-stale",
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: "test decision",
      trigger: "trigger",
      impact: "impact",
      recommendation: null,
      options: ["continue", "stop", "narrow"],
      owner: "alice",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: {},
    }, 2);

    // Directly bump work.revision in DB to simulate a concurrent contract revision
    // (without going through reviseContract which would supersede the attention item).
    db.query("UPDATE control_works SET revision=? WHERE work_id=?").run(2, work.work_id);

    // Now old attention item has contract_revision=1 but work.revision=2.
    // The existing check (work.revision !== old.contract_revision) should reject.
    expect(() =>
      actOnAttention(db, item.item_id, item.revision, "resolve", { selected_option: "continue" }, "alice"),
    ).toThrow(ControlError);

    const still = getAttentionRaw(db, item.item_id);
    expect(still.state).toBe("open");
    db.close();
  });

  test("evidence 被 purged → 拒绝消费", () => {
    const db = fixture();
    const contract = makeContract("alice");
    const work = createWork(db, { title: "w", source: "test", contract }, 1);
    const obj = makeObject(db, work.work_id, "k-evidence", "h1");

    const item = upsertAttention(db, {
      item_id: "item-evidence",
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: "test decision",
      trigger: "trigger",
      impact: "impact",
      recommendation: null,
      options: ["continue", "stop"],
      owner: "alice",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: { object_id: obj.object_id, revision: 1 },
    }, 2);

    // purge the evidence object
    db.query("UPDATE control_context_objects SET purged_at=?, tombstone_reason=? WHERE object_id=?")
      .run(new Date().toISOString(), "expired", obj.object_id);

    expect(() =>
      actOnAttention(db, item.item_id, item.revision, "resolve", { selected_option: "continue" }, "alice"),
    ).toThrow(ControlError);

    const still = getAttentionRaw(db, item.item_id);
    expect(still.state).toBe("open");
    db.close();
  });
});

function getAttentionRaw(db: Database, itemId: string): { state: string; effect_state: string } {
  return db.query("SELECT state, effect_state FROM control_attention WHERE item_id=?").get(itemId) as { state: string; effect_state: string };
}

describe("Fix4 reverifyBeforeAction share 精确绑定", () => {
  test("A work 的 share 不授权 B work 的其他对象（旧 bug：任意 share 即放行）", () => {
    const db = fixture();
    const workA = createWork(db, { title: "A", source: "test", contract: makeContract("alice") }, 1);
    const workB = createWork(db, { title: "B", source: "test", contract: makeContract("bob") }, 2);
    // A 拥有对象 Oa，共享给 B。
    const objA = makeObject(db, workA.work_id, "shared-key", "h1");
    // B 自己的对象 Ob。
    const objB = makeObject(db, workB.work_id, "own-key", "h2");
    db.query("INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES(?,?,?,?,?,?)")
      .run("s1", objA.object_id, 1, workB.work_id, "alice", 3);

    // mallory 不是 B 的 decision_owner，试图对 B 的自有对象 Ob 复验。
    // 旧实现：WHERE shared_with_work=B LIMIT 1 命中 Oa→B 的 share → 误放行。
    const result = reverifyBeforeAction(db, {
      entry: "consume_decision",
      work_id: workB.work_id,
      actor: "mallory",
      object_id: objB.object_id,
      revision: 1,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("permission_denied");
    db.close();
  });

  test("正例：share 精确绑定 (object_id+revision+shared_with_work) → 授权", () => {
    const db = fixture();
    const workA = createWork(db, { title: "A", source: "test", contract: makeContract("alice") }, 1);
    const workB = createWork(db, { title: "B", source: "test", contract: makeContract("bob") }, 2);
    const objA = makeObject(db, workA.work_id, "shared-key", "h1");
    db.query("INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES(?,?,?,?,?,?)")
      .run("s1", objA.object_id, 1, workB.work_id, "alice", 3);

    // actor 非 B 的 owner，但针对被精确共享的对象 Oa@rev1 → 授权
    const result = reverifyBeforeAction(db, {
      entry: "consume_decision",
      work_id: workB.work_id,
      actor: "mallory",
      object_id: objA.object_id,
      revision: 1,
    });
    expect(result.allowed).toBe(true);
    db.close();
  });

  test("无 object_id 的 share 复验 fail-closed（不凭任意 share 放行）", () => {
    const db = fixture();
    const workA = createWork(db, { title: "A", source: "test", contract: makeContract("alice") }, 1);
    const workB = createWork(db, { title: "B", source: "test", contract: makeContract("bob") }, 2);
    const objA = makeObject(db, workA.work_id, "shared-key", "h1");
    db.query("INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES(?,?,?,?,?,?)")
      .run("s1", objA.object_id, 1, workB.work_id, "alice", 3);
    // 旧实现会凭存在的 share 放行；新实现 fail-closed 拒绝。
    const result = reverifyBeforeAction(db, {
      entry: "consume_decision",
      work_id: workB.work_id,
      actor: "mallory",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.code).toBe("permission_denied");
    db.close();
  });
});
