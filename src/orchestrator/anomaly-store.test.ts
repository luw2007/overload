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
    // 主键 (result_set_version, check_id) 生效
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
    const set1 = getCheckResults(db, 1);
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
    expect(getCheckResults(db, 2)).toHaveLength(0); // empty window stays empty
    expect(getCheckResults(db, 3)).toHaveLength(1);
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
