import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CONTROL_SCHEMA_VERSION, ControlError, ensureControlSchema } from "./store";
import {
  createObject,
  createProblem,
  getLatestVersion,
  getObject,
  getObjectVersion,
  getProblem,
  getProblemTree,
  linkProblemObject,
  listObjectsByProblem,
  objectId,
  problemId,
  resolveProblem,
  unlinkProblemObject,
  updateObject,
} from "./context-pool";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  return db;
}

const TABLES = [
  "control_context_problems",
  "control_context_objects",
  "control_context_object_versions",
  "control_context_problem_objects",
  "control_context_pins",
  "control_context_shares",
];

describe("T1 schema migration", () => {
  test("migration creates six context tables and leaves legacy tables intact", () => {
    const db = fixture();
    expect(CONTROL_SCHEMA_VERSION).toBe(8);
    for (const table of TABLES) {
      const row = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      expect(row).toBeTruthy();
    }
    // 旧表 schema 不变
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_works'").get()).toBeTruthy();
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_attention'").get()).toBeTruthy();
    // content_hash 存在，summary_hash 不存在
    const versionCols = (db.query("PRAGMA table_info(control_context_object_versions)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(versionCols).toContain("content_hash");
    expect(versionCols).not.toContain("summary_hash");
    const objectCols = (db.query("PRAGMA table_info(control_context_objects)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(objectCols).toContain("purged_at");
    expect(objectCols).toContain("tombstone_reason");
    db.close();
  });

  test("CHECK constraint rejects invalid ctype", () => {
    const db = fixture();
    expect(() =>
      db.query("INSERT INTO control_context_objects(object_id,work_id,ctype,revision,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run("o", "w", "test_result", 1, 1, 1),
    ).toThrow();
    db.close();
  });

  test("composite foreign key rejects unknown object_id+revision in problem_objects", () => {
    const db = fixture();
    expect(() =>
      db.query("INSERT INTO control_context_problem_objects(problem_id,object_id,revision,role,created_at) VALUES (?,?,?,?,?)")
        .run("p", "ghost", 99, "fact", 1),
    ).toThrow();
    db.close();
  });

  test("self-referencing foreign key accepts a legal parent-child edge", () => {
    const db = fixture();
    db.query("INSERT INTO control_context_problems(problem_id,work_id,parent_problem_id,root_problem_id,title,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("P0", "w", null, "P0", "root", "open", 1, 1, 1);
    db.query("INSERT INTO control_context_problems(problem_id,work_id,parent_problem_id,root_problem_id,title,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("P1", "w", "P0", "P0", "child", "open", 1, 2, 2);
    expect(getProblem(db, "P1")?.parent_problem_id).toBe("P0");
    db.close();
  });
});

describe("T2 problem tree", () => {
  test("createProblem builds root and child inherits root_problem_id", () => {
    const db = fixture();
    const root = createProblem(db, { work_id: "w", title: "root task" }, 1);
    expect(root.parent_problem_id).toBeNull();
    expect(root.root_problem_id).toBe(root.problem_id);
    const child = createProblem(db, { work_id: "w", parent_problem_id: root.problem_id, title: "sub task" }, 2);
    expect(child.root_problem_id).toBe(root.problem_id);
    expect(child.parent_problem_id).toBe(root.problem_id);
    expect(getProblemTree(db, "w")).toHaveLength(2);
    db.close();
  });

  test("cross-work parent is rejected", () => {
    const db = fixture();
    const root = createProblem(db, { work_id: "w1", title: "root" }, 1);
    expect(() => createProblem(db, { work_id: "w2", parent_problem_id: root.problem_id, title: "cross" }, 2)).toThrow(ControlError);
    try {
      createProblem(db, { work_id: "w2", parent_problem_id: root.problem_id, title: "cross" }, 2);
    } catch (e) {
      expect((e as ControlError).code).toBe("conflict");
    }
    db.close();
  });

  test("cycle detection rejects A->B->A", () => {
    const db = fixture();
    const a = createProblem(db, { work_id: "w", title: "A" }, 1);
    const b = createProblem(db, { work_id: "w", parent_problem_id: a.problem_id, title: "B" }, 2);
    // 直接在存储层把 A 的 parent 改成 B，形成 A->B->A 环。
    db.query("UPDATE control_context_problems SET parent_problem_id=? WHERE problem_id=?").run(b.problem_id, a.problem_id);
    // 再在环下创建新节点，向上遍历会检测到重复节点。
    expect(() => createProblem(db, { work_id: "w", parent_problem_id: b.problem_id, title: "C" }, 3)).toThrow(ControlError);
    db.close();
  });

  test("parent_problem_id is immutable: no update API exists and resolveProblem does not touch it", () => {
    const db = fixture();
    const root = createProblem(db, { work_id: "w", title: "root" }, 1);
    const child = createProblem(db, { work_id: "w", parent_problem_id: root.problem_id, title: "child" }, 2);
    const resolved = resolveProblem(db, child.problem_id, child.revision, 3);
    expect(resolved.state).toBe("resolved");
    expect(resolved.parent_problem_id).toBe(root.problem_id);
    // 代码路径中不存在更新 parent_problem_id 的导出函数（本模块未导出任何 updateParent）。
    db.close();
  });

  test("resolveProblem uses CAS", () => {
    const db = fixture();
    const p = createProblem(db, { work_id: "w", title: "root" }, 1);
    expect(() => resolveProblem(db, p.problem_id, 99)).toThrow(ControlError);
    const resolved = resolveProblem(db, p.problem_id, 1, 2);
    expect(resolved.state).toBe("resolved");
    expect(() => resolveProblem(db, p.problem_id, 1)).toThrow(ControlError);
    db.close();
  });
});

describe("T2 object CRUD and CAS", () => {
  test("createObject requires fact_subtype for facts and forbids it otherwise", () => {
    const db = fixture();
    expect(() =>
      createObject(db, { work_id: "w", ctype: "fact", object_canonical_key: "k1", reference: "r", source_type: "orchestrator", content_hash: "h" }, 1),
    ).toThrow(ControlError);
    const fact = createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "test_result", object_canonical_key: "k1", reference: "r", source_type: "orchestrator", content_hash: "h" }, 1);
    expect(fact.fact_subtype).toBe("test_result");
    expect(() =>
      createObject(db, { work_id: "w", ctype: "objective", fact_subtype: "code_state", object_canonical_key: "k2", reference: "r", source_type: "contract", content_hash: "h" }, 1),
    ).toThrow(ControlError);
    db.close();
  });

  test("confirmed_secret cannot be shareable", () => {
    const db = fixture();
    expect(() =>
      createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "external_state", object_canonical_key: "k", reference: "r", source_type: "orchestrator", content_hash: "h", sensitivity: "confirmed_secret", shareable: 1 }, 1),
    ).toThrow(ControlError);
    const obj = createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "external_state", object_canonical_key: "k", reference: "r", source_type: "orchestrator", content_hash: "h", sensitivity: "confirmed_secret", shareable: 0 }, 1);
    expect(obj.revision).toBe(1);
    db.close();
  });

  test("updateObject CAS conflicts on stale revision and keeps old version", () => {
    const db = fixture();
    const obj = createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "code_state", object_canonical_key: "k", reference: "r1", source_type: "orchestrator", content_hash: "h1" }, 1);
    // 第一个写成功
    const v2 = updateObject(db, { object_id: obj.object_id, expectedRevision: 1, patch: { content_hash: "h2", reference: "r2" } }, 2);
    expect(v2.revision).toBe(2);
    // 第二个基于旧 revision=1 的写冲突
    expect(() => updateObject(db, { object_id: obj.object_id, expectedRevision: 1, patch: { content_hash: "h3" } }, 3)).toThrow(ControlError);
    // 旧版本仍可查，不被覆盖
    expect(getObjectVersion(db, obj.object_id, 1)?.content_hash).toBe("h1");
    expect(getLatestVersion(db, obj.object_id)?.content_hash).toBe("h2");
    expect(getObject(db, obj.object_id)?.revision).toBe(2);
    db.close();
  });

  test("deterministic object_id from work+ctype+canonical_key", () => {
    expect(objectId("w", "fact", "k")).toBe(objectId("w", "fact", "k"));
    expect(objectId("w", "fact", "k")).not.toBe(objectId("w", "fact", "k2"));
    expect(problemId("w", null, "t")).toBe(problemId("w", "", "t"));
  });
});

describe("T2 problem-object links", () => {
  test("linkProblemObject requires explicit revision", () => {
    const db = fixture();
    const p = createProblem(db, { work_id: "w", title: "root" }, 1);
    const obj = createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "code_state", object_canonical_key: "k", reference: "r", source_type: "orchestrator", content_hash: "h" }, 1);
    expect(() => linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, role: "fact" } as never)).toThrow(ControlError);
    try {
      linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, role: "fact" } as never);
    } catch (e) {
      expect((e as ControlError).code).toBe("invalid");
    }
    db.close();
  });

  test("link locks revision; object upgrade does not drift the association", () => {
    const db = fixture();
    const p = createProblem(db, { work_id: "w", title: "root" }, 1);
    const obj = createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "code_state", object_canonical_key: "k", reference: "r1", source_type: "orchestrator", content_hash: "h1" }, 1);
    linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 2);
    // 对象出新版
    updateObject(db, { object_id: obj.object_id, expectedRevision: 1, patch: { content_hash: "h2", reference: "r2" } }, 3);
    const linked = listObjectsByProblem(db, p.problem_id);
    expect(linked).toHaveLength(1);
    expect(linked[0].version.revision).toBe(1);
    expect(linked[0].version.content_hash).toBe("h1");
    expect(linked[0].role).toBe("fact");
    // unlink
    unlinkProblemObject(db, p.problem_id, obj.object_id, "fact");
    expect(listObjectsByProblem(db, p.problem_id)).toHaveLength(0);
    db.close();
  });

  test("cross-work link without share is rejected", () => {
    const db = fixture();
    const p = createProblem(db, { work_id: "w1", title: "root" }, 1);
    const obj = createObject(db, { work_id: "w2", ctype: "fact", fact_subtype: "code_state", object_canonical_key: "k", reference: "r", source_type: "orchestrator", content_hash: "h" }, 1);
    expect(() => linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, revision: 1, role: "fact" })).toThrow(ControlError);
    // 插入 share 记录后允许关联
    db.query("INSERT INTO control_context_shares(share_id,object_id,revision,shared_with_work,granted_by,granted_at) VALUES (?,?,?,?,?,?)")
      .run("s1", obj.object_id, 1, "w1", "owner", 1);
    expect(() => linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, revision: 1, role: "fact" })).not.toThrow();
    db.close();
  });
});

// ===== 反例测试：根 problem 幂等 + problem object 不冲突（P0-MVP 冻结契约） =====
import { createWork, promoteWork } from "./store";
import { ensureRootProblem, rootProblemId } from "./context-pool";
import type { Contract } from "./types";

const minimalContract: Contract = {
  objective: "do thing",
  acceptance: [{ id: "a1", kind: "human", description: "done" }],
  non_goals: [],
  scope: { cwd: "/tmp" },
  budget: {},
  stop_conditions: [],
  decision_owner: "owner",
};

describe("T16 根 problem 幂等（createWork/promoteWork 自动建根）", () => {
  test("ensureRootProblem 连续两次返回同一 problem（id 相同、不抛 conflict）", () => {
    const db = fixture();
    db.query("INSERT INTO control_works(work_id,title,source,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run("w", "w", "test", "active", 1, 1, 1);
    const p1 = ensureRootProblem(db, "w", 1);
    let p2: { problem_id: string } | null = null;
    expect(() => { p2 = ensureRootProblem(db, "w", 2); }).not.toThrow();
    expect(p2!.problem_id).toBe(p1.problem_id);
    expect(p1.title).toBe("root");
    const count = (db.query("SELECT COUNT(*) n FROM control_context_problems WHERE work_id=?").get("w") as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });

  test("createWork(active) 后 control_context_problems 有该 work 的根 problem（parent_problem_id IS NULL）", () => {
    const db = fixture();
    const work = createWork(db, { title: "w", source: "test", contract: minimalContract }, 1);
    const rows = db.query("SELECT problem_id, parent_problem_id, title FROM control_context_problems WHERE work_id=?").all(work.work_id) as Array<{ problem_id: string; parent_problem_id: string | null; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].parent_problem_id).toBeNull();
    expect(rows[0].title).toBe("root");
    db.close();
  });

  test("promoteWork(candidate→active) 后根 problem 存在", () => {
    const db = fixture();
    const cand = createWork(db, { title: "idea", source: "operator", candidate: true }, 1);
    // candidate 阶段不应有根 problem
    expect((db.query("SELECT COUNT(*) n FROM control_context_problems WHERE work_id=?").get(cand.work_id) as { n: number }).n).toBe(0);
    promoteWork(db, cand.work_id, 1, minimalContract, "promoted", 2);
    const rows = db.query("SELECT problem_id, parent_problem_id, title FROM control_context_problems WHERE work_id=?").all(cand.work_id) as Array<{ problem_id: string; parent_problem_id: string | null; title: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].parent_problem_id).toBeNull();
    expect(rows[0].title).toBe("root");
    db.close();
  });

  test("rootProblemId(work_id) 是确定性的：同 work_id 两次返回相同字符串", () => {
    expect(rootProblemId("w")).toBe(rootProblemId("w"));
    expect(rootProblemId("w")).not.toBe(rootProblemId("w2"));
  });

  test("重复 promoteWork 不产生重复根 problem", () => {
    const db = fixture();
    const cand = createWork(db, { title: "idea", source: "operator", candidate: true }, 1);
    promoteWork(db, cand.work_id, 1, minimalContract, "promoted", 2);
    // promoteWork 已使 work 变 active；再手动 ensureRootProblem 不应新增行
    ensureRootProblem(db, cand.work_id, 3);
    const count = (db.query("SELECT COUNT(*) n FROM control_context_problems WHERE work_id=?").get(cand.work_id) as { n: number }).n;
    expect(count).toBe(1);
    db.close();
  });
});

describe("T17 problem object 不冲突（重复 link 更新 revision）", () => {
  test("linkProblemObject 同一 (problem_id,object_id,role) 两次：第二次更新 revision，不抛 UNIQUE", () => {
    const db = fixture();
    const p = createProblem(db, { work_id: "w", title: "root" }, 1);
    db.query("INSERT INTO control_works(work_id,title,source,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("w", "w", "test", "active", 1, 1, 1);
    const obj = createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "code_state", object_canonical_key: "k", reference: "r", source_type: "orchestrator", content_hash: "h1" }, 1);
    linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 2);
    updateObject(db, { object_id: obj.object_id, expectedRevision: 1, patch: { content_hash: "h2" } }, 2);
    expect(() => linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, revision: 2, role: "fact" }, 3)).not.toThrow();
    const links = db.query("SELECT revision, role FROM control_context_problem_objects WHERE problem_id=? AND object_id=?").all(p.problem_id, obj.object_id) as Array<{ revision: number; role: string }>;
    expect(links).toHaveLength(1);
    expect(links[0].revision).toBe(2);
    db.close();
  });

  test("listObjectsByProblem 不重复枚举同一 object（即使经过多次 link）", () => {
    const db = fixture();
    db.query("INSERT INTO control_works(work_id,title,source,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run("w", "w", "test", "active", 1, 1, 1);
    const p = createProblem(db, { work_id: "w", title: "root" }, 1);
    const obj = createObject(db, { work_id: "w", ctype: "fact", fact_subtype: "code_state", object_canonical_key: "k", reference: "r", source_type: "orchestrator", content_hash: "h1" }, 1);
    updateObject(db, { object_id: obj.object_id, expectedRevision: 1, patch: { content_hash: "h2" } }, 2);
    linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, revision: 1, role: "fact" }, 3);
    linkProblemObject(db, { problem_id: p.problem_id, object_id: obj.object_id, revision: 2, role: "fact" }, 4);
    const listed = listObjectsByProblem(db, p.problem_id);
    expect(listed).toHaveLength(1);
    expect(listed[0].version.revision).toBe(2);
    db.close();
  });
});
