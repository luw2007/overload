import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  consumeContinuationWindow,
  getAnomalyBudget,
  getCheckResults,
  getLatestCheckResults,
  getNextResultSetVersion,
  getResultSetVersions,
  getSignalSamples,
  getSignalSamplesByAttempt,
  incrementTriggerCount,
  insertCheckResults,
  insertSignalSample,
  pruneSignalHistory,
  upsertAnomalyBudget,
} from "./anomaly-store";
import { getTask, openStore } from "./store";

const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");

function mem(): Database {
  const db = new Database(":memory:");
  db.exec(schema);
  return db;
}

describe("anomaly-store schema", () => {
  test("three tables created and constraints enforced", () => {
    const db = mem();
    // 表存在
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(["attempt_signal_samples", "attempt_check_results", "work_anomaly_budget"]),
    );
    // status CHECK 生效
    expect(() =>
      insertCheckResults(db, 1, "t", "a", 1, [{ check_id: "c1", status: "bogus" }], "w"),
    ).toThrow(/CHECK/);
    // 主键 (work_id, result_set_version, check_id) 生效：同 Work 同 version/check 仍冲突
    insertCheckResults(db, 2, "t", "a", 1, [{ check_id: "c1", status: "pass" }], "w");
    expect(() =>
      insertCheckResults(db, 2, "t", "a", 1, [{ check_id: "c1", status: "fail" }], "w"),
    ).toThrow(/UNIQUE constraint failed/);
    db.close();
  });
});

describe("anomaly-store signal samples", () => {
  test("insert and getSignalSamples round-trip ordered by window_at", () => {
    const db = mem();
    const id1 = insertSignalSample(db, "task-1", "att-1", 1000, 1, 10, 2, 3, "work-1");
    const id2 = insertSignalSample(db, "task-1", "att-1", 2000, 2, 20, 3, 3, "work-1");
    expect(id2).toBeGreaterThan(id1);
    const rows = getSignalSamples(db, "work-1");
    expect(rows).toHaveLength(2);
    expect(rows[0].window_at).toBe(1000);
    expect(rows[0].commit_count).toBe(1);
    expect(rows[0].diff_added).toBe(10);
    expect(rows[0].diff_deleted).toBe(2);
    expect(rows[0].result_set_version).toBe(3);
    expect(rows[1].window_at).toBe(2000);
    // 按 attempt 查询
    const byAttempt = getSignalSamplesByAttempt(db, "att-1");
    expect(byAttempt.map((r) => r.window_at)).toEqual([1000, 2000]);
    db.close();
  });
});

describe("anomaly-store check results", () => {
  test("batch insert, latest result set, version list descending", () => {
    const db = mem();
    insertCheckResults(db, 1, "task-1", "att-1", 1000, [
      { check_id: "ci", status: "pass", fingerprint: "f1" },
      { check_id: "diff", status: "fail", evidence_ref: "ev-1" },
    ], "work-1");
    insertCheckResults(db, 2, "task-1", "att-2", 2000, [
      { check_id: "ci", status: "fail" },
      { check_id: "diff", status: "unknown", check_def_version: "v9" },
    ], "work-1");
    // 指定结果集
    const set1 = getCheckResults(db, "work-1", 1);
    expect(set1.map((r) => [r.check_id, r.status])).toEqual([
      ["ci", "pass"],
      ["diff", "fail"],
    ]);
    expect(set1[0].fingerprint).toBe("f1");
    // 最新结果集
    const latest = getLatestCheckResults(db, "work-1");
    expect(latest).not.toBeNull();
    expect(latest!.map((r) => [r.check_id, r.status])).toEqual([
      ["ci", "fail"],
      ["diff", "unknown"],
    ]);
    expect(latest![1].check_def_version).toBe("v9");
    // 无数据 work 返回 null
    expect(getLatestCheckResults(db, "nope")).toBeNull();
    // 版本降序
    expect(getResultSetVersions(db, "work-1")).toEqual([2, 1]);
    db.close();
  });

  test("two Works persist the same (result_set_version, check_id) and every reader stays in its Work", () => {
    const db = mem();
    insertSignalSample(db, "task-a", "att-a", 1000, 1, 1, 0, 1, "work-a");
    insertCheckResults(db, 1, "task-a", "att-a", 1000, [{ check_id: "ci", status: "fail", fingerprint: "fp-a" }], "work-a");
    insertCheckResults(db, 1, "task-b", "att-b", 1000, [{ check_id: "ci", status: "pass", fingerprint: "fp-b" }], "work-b");
    insertCheckResults(db, 2, "task-b", "att-b", 2000, [{ check_id: "ci", status: "unknown" }], "work-b");

    expect(getCheckResults(db, "work-a", 1).map((r) => [r.work_id, r.task_id, r.status, r.fingerprint])).toEqual([
      ["work-a", "task-a", "fail", "fp-a"],
    ]);
    expect(getCheckResults(db, "work-b", 1).map((r) => [r.work_id, r.task_id, r.status, r.fingerprint])).toEqual([
      ["work-b", "task-b", "pass", "fp-b"],
    ]);
    expect(getCheckResults(db, "work-a", 2)).toEqual([]);
    expect(getLatestCheckResults(db, "work-a")!.map((r) => [r.result_set_version, r.status])).toEqual([[1, "fail"]]);
    expect(getLatestCheckResults(db, "work-b")!.map((r) => [r.result_set_version, r.status])).toEqual([[2, "unknown"]]);
    expect(getResultSetVersions(db, "work-a")).toEqual([1]);
    expect(getResultSetVersions(db, "work-b")).toEqual([2, 1]);
    expect(getNextResultSetVersion(db, "work-a")).toBe(2);
    expect(getNextResultSetVersion(db, "work-b")).toBe(3);
    // Pruning work-a (whose only sample references v1) must not touch work-b's unreferenced v1/v2 rows.
    pruneSignalHistory(db, "work-a");
    expect(getResultSetVersions(db, "work-a")).toEqual([1]);
    expect(getResultSetVersions(db, "work-b")).toEqual([2, 1]);
    db.close();
  });

  test("a check result without a non-empty Work ID is rejected by the producer and the table", () => {
    const db = mem();
    expect(() => insertCheckResults(db, 1, "t", "a", 1, [{ check_id: "ci", status: "pass" }], "")).toThrow(/work_id is required/);
    const raw = "INSERT INTO attempt_check_results(result_set_version,work_id,task_id,attempt_id,observed_at,check_id,status) VALUES(1,?,'t','a',1,'ci','pass')";
    expect(() => db.run(raw, [null])).toThrow(/NOT NULL constraint failed/);
    expect(() => db.run(raw, [""])).toThrow(/CHECK constraint failed/);
    expect(db.query("SELECT COUNT(*) AS n FROM attempt_check_results").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe("anomaly-store budget", () => {
  test("upsert creates then updates with budget_version increment", () => {
    const db = mem();
    expect(getAnomalyBudget(db, "work-1")).toBeNull();
    upsertAnomalyBudget(db, "work-1", { continuation_windows_remaining: 2, fingerprint: "fp-1" });
    let b = getAnomalyBudget(db, "work-1")!;
    expect(b.budget_version).toBe(1);
    expect(b.continuation_windows_remaining).toBe(2);
    expect(b.fingerprint).toBe("fp-1");
    expect(b.fix_rounds_consumed).toBe(0);
    upsertAnomalyBudget(db, "work-1", { fix_rounds_consumed: 1 });
    b = getAnomalyBudget(db, "work-1")!;
    expect(b.budget_version).toBe(2);
    expect(b.fix_rounds_consumed).toBe(1);
    // 未 patch 的列保留
    expect(b.continuation_windows_remaining).toBe(2);
    expect(b.fingerprint).toBe("fp-1");
    db.close();
  });

  test("incrementTriggerCount and consumeContinuationWindow", () => {
    const db = mem();
    upsertAnomalyBudget(db, "work-1", { continuation_windows_remaining: 2 });
    incrementTriggerCount(db, "work-1");
    incrementTriggerCount(db, "work-1");
    expect(getAnomalyBudget(db, "work-1")!.trigger_count).toBe(2);
    expect(consumeContinuationWindow(db, "work-1")).toBe(1);
    expect(consumeContinuationWindow(db, "work-1")).toBe(0);
    // 不为负数
    expect(consumeContinuationWindow(db, "work-1")).toBe(0);
    // 不存在的 work 返回 0
    expect(consumeContinuationWindow(db, "ghost")).toBe(0);
    db.close();
  });
});

describe("anomaly-store legacy migration", () => {
  test("old tasks table gains four stop columns as NULL", () => {
    const dir = mkdtempSync(join(tmpdir(), "anomaly-mig-"));
    try {
      const p = join(dir, "old.db");
      const old = new Database(p);
      // 模拟迁移前的旧库：没有 stop_* 列，也没有异常表
      old.exec(
        "CREATE TABLE tasks(task_id TEXT PRIMARY KEY, title TEXT NOT NULL, repo TEXT NOT NULL, base_ref TEXT NOT NULL, state TEXT NOT NULL, retry_budget INTEGER NOT NULL DEFAULT 2, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
      );
      old.run(
        "INSERT INTO tasks(task_id,title,repo,base_ref,state,created_at,updated_at) VALUES('t1','old','/r','x','queued',1,1)",
      );
      old.close();

      const db = openStore(p);
      const cols = db.query("PRAGMA table_info(tasks)").all() as { name: string }[];
      for (const c of ["stop_state", "stop_requested_at", "stop_deadline_at", "stop_reason"]) {
        expect(cols.some((x) => x.name === c)).toBe(true);
      }
      const t = getTask(db, "t1")!;
      expect(t.stop_state).toBeNull();
      expect(t.stop_requested_at).toBeNull();
      expect(t.stop_deadline_at).toBeNull();
      expect(t.stop_reason).toBeNull();
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("new stop columns writable and readable; CHECK enforced", () => {
    const db = mem();
    db.run("INSERT INTO tasks(task_id,title,repo,base_ref,state,created_at,updated_at) VALUES('t2','a','/r','x','queued',1,1)");
    db.run(
      "UPDATE tasks SET stop_state=?, stop_requested_at=?, stop_deadline_at=?, stop_reason=? WHERE task_id=?",
      ["stop_requested", 1000, 2000, "user asked", "t2"],
    );
    const t = getTask(db, "t2")!;
    expect(t.stop_state).toBe("stop_requested");
    expect(t.stop_requested_at).toBe(1000);
    expect(t.stop_deadline_at).toBe(2000);
    expect(t.stop_reason).toBe("user asked");
    // CHECK 约束：非法状态值被拒绝
    expect(() => db.run("UPDATE tasks SET stop_state=? WHERE task_id=?", ["bogus", "t2"])).toThrow(/CHECK/);
    db.close();
  });
});

// String fixtures must never silently no-op: every replacement has to hit its target text.
function variant(ddl: string, from: string, to: string): string {
  if (!ddl.includes(from)) throw new Error(`fixture text not found: ${from}`);
  return ddl.replace(from, to);
}

// Exact attempt_check_results DDL shipped by 17d8916: nullable work_id, global (version, check_id) key.
const LEGACY_SCHEMA = variant(
  variant(schema, "work_id TEXT NOT NULL CHECK(work_id <> ''),", "work_id TEXT,"),
  "PRIMARY KEY(work_id, result_set_version, check_id)",
  "PRIMARY KEY(result_set_version, check_id)",
);

type LegacyCheckRow = {
  result_set_version: number;
  work_id: string | null;
  task_id: string;
  attempt_id: string;
  observed_at: number;
  check_id: string;
  status: string;
  fingerprint: string | null;
  check_def_version: string | null;
  evidence_ref: string | null;
};

function legacyRow(
  result_set_version: number,
  work_id: string | null,
  task_id: string,
  check_id: string,
  extra: Partial<LegacyCheckRow> = {},
): LegacyCheckRow {
  return {
    result_set_version,
    work_id,
    task_id,
    attempt_id: `att-${task_id}`,
    observed_at: result_set_version * 1000,
    check_id,
    status: "fail",
    fingerprint: `fp-${task_id}-${result_set_version}`,
    check_def_version: "v1",
    evidence_ref: null,
    ...extra,
  };
}

function writeLegacyStore(path: string, ddl: string, tasks: [string, string | null][], rows: LegacyCheckRow[]): void {
  const db = new Database(path);
  db.exec(ddl);
  for (const [taskId, workId] of tasks) {
    db.run(
      "INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,created_at,updated_at) VALUES(?,?,?,?,'done',?,1,1)",
      [taskId, taskId, `/repo/${taskId}`, "x", workId],
    );
  }
  for (const r of rows) {
    db.run(
      "INSERT INTO attempt_check_results(result_set_version,work_id,task_id,attempt_id,observed_at,check_id,status,fingerprint,check_def_version,evidence_ref) VALUES(?,?,?,?,?,?,?,?,?,?)",
      [r.result_set_version, r.work_id, r.task_id, r.attempt_id, r.observed_at, r.check_id, r.status, r.fingerprint, r.check_def_version, r.evidence_ref],
    );
  }
  db.close();
}

function storeSnapshot(path: string): { objects: unknown[]; rows: unknown[] } {
  const db = new Database(path, { readonly: true });
  const objects = db.query("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const rows = db.query("SELECT * FROM attempt_check_results ORDER BY result_set_version,check_id,task_id").all();
  db.close();
  return { objects, rows };
}

function checkResultsKey(db: Database): { key: string[]; workIdNotNull: number } {
  const columns = db.query("PRAGMA table_xinfo(attempt_check_results)").all() as { name: string; notnull: number; pk: number }[];
  return {
    key: columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
    workIdNotNull: columns.find((c) => c.name === "work_id")!.notnull,
  };
}

describe("attempt_check_results (work_id, result_set_version, check_id) migration", () => {
  test("legacy fixture really carries the old global key", () => {
    const db = new Database(":memory:");
    db.exec(LEGACY_SCHEMA);
    expect(checkResultsKey(db)).toEqual({ key: ["result_set_version", "check_id"], workIdNotNull: 0 });
    db.close();
  });

  test("fresh store gets the Work-scoped key directly", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-pk-fresh-"));
    try {
      const db = openStore(join(dir, "fresh.db"));
      expect(checkResultsKey(db)).toEqual({ key: ["work_id", "result_set_version", "check_id"], workIdNotNull: 1 });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy store keeps every row, backfills provable Works, rebuilds the index, and then admits cross-Work keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-pk-legacy-"));
    try {
      const p = join(dir, "legacy.db");
      const rows = [
        legacyRow(1, "w1", "t1", "ci"),
        legacyRow(2, null, "t1", "ci"),
        legacyRow(3, "", "t2", "ci", { status: "pass", fingerprint: null, evidence_ref: "ev-3" }),
        legacyRow(4, null, "t2", "lint", { status: "unknown", check_def_version: null }),
        // An explicit legacy Work ID is a recorded fact; it is kept even when no task row exists any more.
        legacyRow(5, "w-orphan", "t-gone", "ci", { status: "not_run" }),
      ];
      writeLegacyStore(p, LEGACY_SCHEMA, [["t1", "w1"], ["t2", "w2"], ["t3", "w1"]], rows);

      const db = openStore(p);
      expect(checkResultsKey(db)).toEqual({ key: ["work_id", "result_set_version", "check_id"], workIdNotNull: 1 });
      // Migrated and fresh stores carry byte-identical table DDL.
      const fresh = mem();
      const tableSql = (d: Database) => d.query("SELECT sql FROM sqlite_master WHERE type='table' AND name='attempt_check_results'").get();
      expect(tableSql(db)).toEqual(tableSql(fresh));
      fresh.close();
      const backfilled = ["w1", "w1", "w2", "w2", "w-orphan"];
      expect(db.query("SELECT * FROM attempt_check_results ORDER BY result_set_version,check_id").all()).toEqual(
        rows.map((r, i) => ({ ...r, work_id: backfilled[i] })),
      );
      const objects = db.query("SELECT type,name,tbl_name FROM sqlite_master WHERE tbl_name LIKE 'attempt_check_results%' ORDER BY type,name").all();
      expect(objects).toEqual([
        { type: "index", name: "idx_check_results_work", tbl_name: "attempt_check_results" },
        { type: "index", name: "sqlite_autoindex_attempt_check_results_1", tbl_name: "attempt_check_results" },
        { type: "table", name: "attempt_check_results", tbl_name: "attempt_check_results" },
      ]);

      // Collision fixed: another Work may now use version 1 / check "ci" ...
      insertCheckResults(db, 1, "t2", "att-t2", 9000, [{ check_id: "ci", status: "pass" }], "w2");
      expect(getCheckResults(db, "w1", 1).map((r) => [r.task_id, r.status])).toEqual([["t1", "fail"]]);
      expect(getCheckResults(db, "w2", 1).map((r) => [r.task_id, r.status])).toEqual([["t2", "pass"]]);
      // ... while the same Work still owns its (version, check_id) exclusively.
      expect(() => insertCheckResults(db, 1, "t3", "att-t3", 9000, [{ check_id: "ci", status: "pass" }], "w1")).toThrow(
        /UNIQUE constraint failed/,
      );
      db.close();

      // Re-opening a migrated store is a no-op.
      const before = storeSnapshot(p);
      openStore(p).close();
      expect(storeSnapshot(p)).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const NO_TASK_PK = variant(LEGACY_SCHEMA, "task_id TEXT PRIMARY KEY, title", "task_id TEXT NOT NULL, title");
  const WIDER_LEGACY_PK = variant(
    LEGACY_SCHEMA,
    "PRIMARY KEY(result_set_version, check_id)",
    "PRIMARY KEY(result_set_version, check_id, task_id)",
  );
  const EXTRA_COLUMN = variant(LEGACY_SCHEMA, "  evidence_ref TEXT,\n  PRIMARY KEY", "  evidence_ref TEXT,\n  extra TEXT,\n  PRIMARY KEY");
  test.each([
    { name: "NULL Work ID whose task row is absent", ddl: LEGACY_SCHEMA, tasks: [], rows: [legacyRow(1, null, "t-gone", "ci")], error: /no provable Work ID/ },
    { name: "NULL Work ID whose task has no Work", ddl: LEGACY_SCHEMA, tasks: [["t1", null]], rows: [legacyRow(1, null, "t1", "ci")], error: /no provable Work ID/ },
    { name: "empty Work ID whose task Work is empty", ddl: LEGACY_SCHEMA, tasks: [["t1", ""]], rows: [legacyRow(1, "", "t1", "ci")], error: /no provable Work ID/ },
    {
      name: "task_id maps to two Works",
      ddl: NO_TASK_PK,
      tasks: [["t1", "w1"], ["t1", "w2"]],
      rows: [legacyRow(1, "w1", "t0", "ci"), legacyRow(2, null, "t1", "ci")],
      error: /no provable Work ID/,
    },
    {
      name: "backfill collides on the new key",
      ddl: WIDER_LEGACY_PK,
      tasks: [["t1", "w1"], ["t2", "w1"]],
      rows: [legacyRow(1, "w1", "t1", "ci"), legacyRow(1, null, "t2", "ci")],
      error: /key\(s\) would be duplicated, first work_id=w1 result_set_version=1 check_id=ci/,
    },
    { name: "legacy table has unknown columns", ddl: EXTRA_COLUMN, tasks: [["t1", "w1"]], rows: [legacyRow(1, "w1", "t1", "ci")], error: /do not match/ },
  ] as { name: string; ddl: string; tasks: [string, string | null][]; rows: LegacyCheckRow[]; error: RegExp }[])(
    "fails closed and leaves the legacy store untouched: $name",
    ({ ddl, tasks, rows, error }) => {
      const dir = mkdtempSync(join(tmpdir(), "check-pk-closed-"));
      try {
        const p = join(dir, "legacy.db");
        writeLegacyStore(p, ddl, tasks, rows);
        const before = storeSnapshot(p);
        expect(before.rows).toHaveLength(rows.length);
        let thrown: unknown;
        try {
          openStore(p).close();
        } catch (e) {
          thrown = e;
        }
        expect(thrown).toBeInstanceOf(Error);
        expect(String(thrown)).toMatch(/migration to \(work_id,result_set_version,check_id\) failed closed; legacy table left unchanged/);
        expect(String(thrown)).toMatch(error);
        // Nothing was written: not the rebuild, not schema.sql, not the tasks ALTERs.
        expect(storeSnapshot(p)).toEqual(before);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("anomaly-store versioning & pruning", () => {
  test("getNextResultSetVersion counts empty signal-only windows (no version reuse/collision)", () => {
    const db = mem();
    // window1: sample v1 + checks v1
    insertSignalSample(db, "t", "a", 1, 1, 5, 1, 1, "w");
    insertCheckResults(db, 1, "t", "a", 1, [{ check_id: "c", status: "fail", fingerprint: "f" }], "w");
    // window2: sample occupies v2, but emits no check results
    insertSignalSample(db, "t", "a", 2, 1, 5, 1, 2, "w");
    // next version must be 3 (the empty sample already consumed v2)
    expect(getNextResultSetVersion(db, "w")).toBe(3);
    // a follow-up window with checks uses v3, leaving the empty v2 sample without inherited checks
    insertCheckResults(db, 3, "t", "a", 3, [{ check_id: "c", status: "fail", fingerprint: "f" }], "w");
    expect(getCheckResults(db, "w", 2)).toHaveLength(0); // empty window stays empty
    expect(getCheckResults(db, "w", 3)).toHaveLength(1);
    db.close();
  });

  test("pruneSignalHistory keeps last N windows and drops orphaned check results", () => {
    const db = mem();
    for (let i = 0; i < 10; i++) {
      insertSignalSample(db, "t", "a", i, 1, i, 1, i + 1, "w");
      insertCheckResults(db, i + 1, "t", "a", i, [{ check_id: "c", status: "fail", fingerprint: "f" }], "w");
    }
    pruneSignalHistory(db, "w", 3);
    const samples = getSignalSamples(db, "w");
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => s.window_at)).toEqual([7, 8, 9]);
    const versions = getResultSetVersions(db, "w").sort((a, b) => a - b);
    expect(versions).toEqual([8, 9, 10]);
    db.close();
  });
});
