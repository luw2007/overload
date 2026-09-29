import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  CONTEXT_SCHEMA,
  CONTROL_SCHEMA,
  CONTROL_SCHEMA_VERSION,
  createWork,
  ensureControlSchema,
  redirectWork,
} from "./store";
import { ensureOutbox } from "./outbox";
import { ensureMgmtSchema } from "../manage/schema";
import { getProblem, problemId, rootProblemId } from "./context-pool";
import { ingestFactObserved, type FactObservedPayload } from "./context-reducer";

// 重建一个停在 v3 的库：回放 v1..v3 的 DDL，再把 meta 版本钉死在 3。
// v4（reducer DDL）、v5（根 problem 回填）与 v6（Phase A 表）由 ensureControlSchema 真正执行。
function makeV3Db(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(CONTROL_SCHEMA);
  ensureOutbox(db);
  ensureMgmtSchema(db);
  db.exec(CONTEXT_SCHEMA);
  db.query("INSERT INTO control_schema_meta(id,version,migrated_at) VALUES (1,?,?)").run(3, 1);
  return db;
}

function makeVersionDb(version: 0 | 1 | 2 | 3 | 4 | 5): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  if (version === 0) return db;
  db.exec(CONTROL_SCHEMA);
  ensureOutbox(db);
  db.query("INSERT INTO control_schema_meta(id,version,migrated_at) VALUES (1,?,?)").run(version, 1);
  if (version >= 2) ensureMgmtSchema(db);
  if (version >= 3) db.exec(CONTEXT_SCHEMA);
  if (version >= 4) {
    db.exec(`CREATE TABLE control_context_fact_dedup(
      idempotency_key TEXT PRIMARY KEY, object_id TEXT NOT NULL, revision INTEGER NOT NULL,
      content_hash TEXT NOT NULL, created_at INTEGER NOT NULL
    ); CREATE TABLE control_context_fact_quarantine(
      idempotency_key TEXT NOT NULL, content_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (idempotency_key, content_hash)
    );`);
  }
  return db;
}

function insertWork(db: Database, workId: string, state: string): void {
  db.query(
    "INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(workId, "t", "test", `sid-${workId}`, state, 1, null, 1, 1);
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  return db;
}

function metaVersion(db: Database): number {
  return (db.query("SELECT version FROM control_schema_meta WHERE id=1").get() as { version: number }).version;
}

describe("存量 work 根 problem 回填 hotfix", () => {
  test("schema 常量版本为 9", () => {
    expect(CONTROL_SCHEMA_VERSION).toBe(9);
  });

  test("every supported v0-v5 schema upgrades exactly through the current version", () => {
    for (const version of [0, 1, 2, 3, 4, 5] as const) {
      const db = makeVersionDb(version);
      if (version >= 3 && version <= 4) insertWork(db, `w-v${version}`, "active");
      ensureControlSchema(db);
      expect(metaVersion(db)).toBe(CONTROL_SCHEMA_VERSION);
      for (const table of ["control_attention_material", "control_notifications", "control_notification_shadow"]) {
        expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeTruthy();
      }
      if (version >= 3 && version <= 4) {
        const roots = db.query("SELECT COUNT(*) AS n FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL")
          .get(`w-v${version}`) as { n: number };
        expect(roots.n).toBe(1);
      }
      expect(() => ensureControlSchema(db)).not.toThrow();
      expect(metaVersion(db)).toBe(CONTROL_SCHEMA_VERSION);
      db.close();
    }
  });

  test("v5→v6 preserves the completed v5 root backfill while creating Phase A tables", () => {
    const db = makeVersionDb(5);
    insertWork(db, "w-v5", "completed");
    const rootId = rootProblemId("w-v5");
    db.query("INSERT INTO control_context_problems(problem_id,work_id,parent_problem_id,root_problem_id,title,state,revision,created_at,updated_at) VALUES (?,?,NULL,?,?,'open',1,?,?)")
      .run(rootId, "w-v5", rootId, "root", 1, 1);
    ensureControlSchema(db);
    expect(metaVersion(db)).toBe(CONTROL_SCHEMA_VERSION);
    const roots = db.query("SELECT COUNT(*) AS n FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL")
      .get("w-v5") as { n: number };
    expect(roots.n).toBe(1);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_notifications'").get()).toBeTruthy();
    db.close();
  });

  test("1. v3→v6 升级执行 v5 根 problem 回填，id 与 rootProblemId 一致", () => {
    const db = makeV3Db();
    insertWork(db, "w-old", "active");
    // 升级前无根 problem（用裸 SQL，避免 getProblem 内部 ensureControlSchema 提前触发迁移）
    const before = db
      .query("SELECT 1 FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL")
      .get("w-old");
    expect(before).toBeNull();
    ensureControlSchema(db);
    expect(metaVersion(db)).toBe(CONTROL_SCHEMA_VERSION);
    const root = getProblem(db, rootProblemId("w-old"));
    expect(root).not.toBeNull();
    expect(root!.problem_id).toBe(rootProblemId("w-old"));
    expect(root!.parent_problem_id).toBeNull();
    expect(root!.work_id).toBe("w-old");
    db.close();
  });

  test("2. 升级后 fact 可投递：orchestrator 注入 rootProblemId，reducer 链接成功，不进 quarantine", () => {
    const db = makeV3Db();
    insertWork(db, "w-fact", "active");
    ensureControlSchema(db);
    const payload: FactObservedPayload = {
      work_id: "w-fact",
      problem_id: rootProblemId("w-fact"),
      object_canonical_key: "k1",
      reference: "orchestrator:submit_result:attempt-1",
      source_type: "orchestrator",
      source_id: "runner-1",
      source_identity: "alice",
      source_event_id: "evt-1",
      observation_revision: 1,
      attempt: "attempt-1",
      fact_subtype: "test_result",
      content_hash: "h-1",
      sensitivity: "clean",
      collected_at: "2026-09-24T10:00:00.000Z",
      expires_at: null,
      derived_from: null,
    };
    const r = ingestFactObserved(db, payload);
    expect(r.status).toBe("created");
    // problem 已被链接
    const link = db
      .query("SELECT role FROM control_context_problem_objects WHERE problem_id=? AND role='fact'")
      .get(rootProblemId("w-fact"));
    expect(link).not.toBeNull();
    db.close();
  });

  test("3. 同 source 重复 createWork 幂等，根 problem 不重复建行，id 稳定", () => {
    const db = freshDb();
    const w1 = createWork(db, { title: "t", source: "s", source_id: "x1" }, 1);
    createWork(db, { title: "t", source: "s", source_id: "x1" }, 2);
    createWork(db, { title: "t", source: "s", source_id: "x1" }, 3);
    const n = db
      .query("SELECT COUNT(*) AS n FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL")
      .get(w1.work_id) as { n: number };
    expect(n.n).toBe(1);
    expect(getProblem(db, rootProblemId(w1.work_id))).not.toBeNull();
    db.close();
  });

  test("4. createWork 幂等返回分支补建根 problem", () => {
    const db = freshDb();
    // 绕过 createWork 直接插入一个 active 但无根 problem 的存量 work
    insertWork(db, "w-man", "active");
    expect(getProblem(db, rootProblemId("w-man"))).toBeNull();
    // 同 (source, source_id) 重复创建 → 命中幂等返回
    createWork(db, { title: "t", source: "test", source_id: "sid-w-man" }, 2);
    const root = getProblem(db, rootProblemId("w-man"));
    expect(root).not.toBeNull();
    expect(root!.problem_id).toBe(rootProblemId("w-man"));
    db.close();
  });

  test("5. redirectWork activate 分支补建根 problem", () => {
    const db = freshDb();
    insertWork(db, "w-stop", "stopped");
    expect(getProblem(db, rootProblemId("w-stop"))).toBeNull();
    redirectWork(db, "w-stop", 1, { reason: "reactivate", affected_work_ids: [], action: "activate" }, 2);
    const root = getProblem(db, rootProblemId("w-stop"));
    expect(root).not.toBeNull();
    expect(root!.work_id).toBe("w-stop");
    db.close();
  });

  test("6. 迁移重入幂等：已升级库再 ensureControlSchema 不报错、版本仍为当前版本、无重复 problem", () => {
    const db = makeV3Db();
    insertWork(db, "w-re", "active");
    ensureControlSchema(db);
    const before = db
      .query("SELECT COUNT(*) AS n FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL")
      .get("w-re") as { n: number };
    expect(before.n).toBe(1);
    expect(() => ensureControlSchema(db)).not.toThrow();
    expect(metaVersion(db)).toBe(CONTROL_SCHEMA_VERSION);
    const after = db
      .query("SELECT COUNT(*) AS n FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL")
      .get("w-re") as { n: number };
    expect(after.n).toBe(1);
    db.close();
  });

  test("7. 全状态 work 都被回填（active/candidate/stopped/completed）", () => {
    const db = makeV3Db();
    const states = ["active", "candidate", "stopped", "completed"] as const;
    for (const s of states) insertWork(db, `w-${s}`, s);
    ensureControlSchema(db);
    for (const s of states) {
      expect(getProblem(db, rootProblemId(`w-${s}`))).not.toBeNull();
    }
    // 根 problem 总数 == work 数（每 work 一个根）
    const works = db.query("SELECT COUNT(*) AS n FROM control_works").get() as { n: number };
    const roots = db
      .query("SELECT COUNT(*) AS n FROM control_context_problems WHERE parent_problem_id IS NULL")
      .get() as { n: number };
    expect(roots.n).toBe(works.n);
    db.close();
  });

  test("8. rootProblemId 与 orchestrator 注入公式一致", () => {
    expect(rootProblemId("w-any")).toBe(problemId("w-any", null, "root"));
  });
});
