/**
 * test/context-ingest.test.ts — collector→reducer 生产链路接通验证（问题 3，阻塞项）。
 *
 * 用真实文件路径 + 真实 control DB + 真实 reducer，不 mock。
 * 覆盖：
 *  1. collectAndSpool 写真实 NDJSON → ingestContextSpool 摄入 → control_context_objects 出现行
 *  2. 重复摄入同一文件 → idempotent
 *  3. 同 idempotency_key 异 content_hash → quarantined，既有对象 content_hash 不变
 *  4. 坏 JSON 行 → failed，不影响其他行
 *  5. 处理完的文件被重命名为 .processed.*
 *  6. spool 文件不存在 → 全 0
 */
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync as readSchema } from "node:fs";

import { ensureControlSchema, createWork } from "../src/control/store";
import { ensureContextReducerSchema } from "../src/control/context-reducer";
import { ingestContextSpool } from "../src/control/context-ingest";
import type { Contract } from "../src/control/types";
import { collectAndSpool, resetCollectorDedup } from "../src/orchestrator/context-collector";
import { addTask } from "../src/orchestrator/store";

const ORCH_SCHEMA = readSchema(join(import.meta.dir, "..", "src", "orchestrator", "schema.sql"), "utf8");

function controlDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  return db;
}

function orchDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ORCH_SCHEMA);
  db.run("INSERT OR IGNORE INTO spool_seq(id,seq,segment) VALUES(1,0,0)");
  return db;
}

function makeContract(owner = "alice"): Contract {
  return {
    objective: "refactor parseConfig",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: [],
    scope: { repo: "/tmp/repo" },
    budget: { retry_limit: 3 },
    stop_conditions: [],
    decision_owner: owner,
  };
}

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ctx-ingest-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  resetCollectorDedup();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
beforeEach(() => resetCollectorDedup());

describe("context-ingest: collector→reducer production pipeline", () => {
  test("1. collectAndSpool 写真实 NDJSON → ingest → control_context_objects 有行", () => {
    const cdb = controlDb();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const odb = orchDb();
    const task = addTask(odb, "refactor", "/tmp/repo", "a".repeat(40), 1, { workId: work.work_id });
    odb.run("UPDATE tasks SET branch=?, attempt_id=? WHERE task_id=?", ["overload/t1", "attempt-1", task.task_id]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [task.task_id, 1000, "running", "awaiting_human", "runner_exit", JSON.stringify({ evidence_complete: true })]);

    const spoolDir = tempDir();
    collectAndSpool({ orchestratorDb: odb, work_id: work.work_id, actor: "alice" }, spoolDir);

    const stats = ingestContextSpool(cdb, spoolDir);
    expect(stats.read).toBeGreaterThan(0);
    expect(stats.created).toBeGreaterThan(0);
    expect(stats.idempotent).toBe(0);
    expect(stats.quarantined).toBe(0);
    expect(stats.failed).toBe(0);

    const rows = cdb.query("SELECT COUNT(*) n FROM control_context_objects").get() as { n: number };
    expect(rows.n).toBeGreaterThan(0);

    cdb.close(); odb.close();
  });

  test("2. 重复摄入同一文件 → idempotent（但文件已重命名，需手动重建）", () => {
    const cdb = controlDb();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const odb = orchDb();
    const task = addTask(odb, "refactor", "/tmp/repo", "a".repeat(40), 1, { workId: work.work_id });
    odb.run("UPDATE tasks SET branch=?, attempt_id=? WHERE task_id=?", ["overload/t2", "attempt-1", task.task_id]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [task.task_id, 1000, "running", "awaiting_human", "runner_exit", JSON.stringify({ evidence_complete: true })]);

    const spoolDir = tempDir();
    collectAndSpool({ orchestratorDb: odb, work_id: work.work_id, actor: "alice" }, spoolDir);

    const s1 = ingestContextSpool(cdb, spoolDir);
    expect(s1.created).toBeGreaterThan(0);

    // 文件已被重命名；重新 collectAndSpool 写出同样的事实（collector 端去重会跳过，
    // 所以手动把第一次的 envelope 重写回 active 文件来模拟重复投递）。
    const processed = readdirSync(spoolDir).find((f) => f.includes(".processed."));
    expect(processed).toBeTruthy();
    const content = readFileSync(join(spoolDir, processed!), "utf8");
    writeFileSync(join(spoolDir, "active-context-collector.ndjson"), content);

    resetCollectorDedup();
    const s2 = ingestContextSpool(cdb, spoolDir);
    expect(s2.read).toBe(s1.read);
    expect(s2.idempotent).toBeGreaterThan(0);
    expect(s2.created).toBe(0);

    cdb.close(); odb.close();
  });

  test("3. 同 idempotency_key 异 content_hash → quarantined，既有对象 content_hash 不变", () => {
    const cdb = controlDb();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const odb = orchDb();
    const task = addTask(odb, "refactor", "/tmp/repo", "a".repeat(40), 1, { workId: work.work_id });
    odb.run("UPDATE tasks SET branch=?, attempt_id=? WHERE task_id=?", ["overload/t3", "attempt-1", task.task_id]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [task.task_id, 1000, "running", "awaiting_human", "runner_exit", JSON.stringify({ evidence_complete: true })]);

    const spoolDir = tempDir();
    collectAndSpool({ orchestratorDb: odb, work_id: work.work_id, actor: "alice" }, spoolDir);
    const s1 = ingestContextSpool(cdb, spoolDir);
    expect(s1.created).toBeGreaterThan(0);

    // 取第一行的 envelope，篡改 content_hash（同 idempotency_key）
    const processed = readdirSync(spoolDir).find((f) => f.includes(".processed."))!;
    const lines = readFileSync(join(spoolDir, processed), "utf8").trim().split("\n");
    const env = JSON.parse(lines[0]);
    env.detail.content_hash = "different-hash-xyz";
    writeFileSync(join(spoolDir, "active-context-collector.ndjson"), JSON.stringify(env) + "\n");

    const s2 = ingestContextSpool(cdb, spoolDir);
    expect(s2.quarantined).toBe(1);
    expect(s2.failed).toBe(0);

    // 既有对象 content_hash 不变
    const v = cdb.query("SELECT content_hash FROM control_context_object_versions ORDER BY revision DESC LIMIT 1").get() as { content_hash: string };
    expect(v.content_hash).not.toBe("different-hash-xyz");

    cdb.close(); odb.close();
  });

  test("4. 坏 JSON 行 → failed，不影响其他行", () => {
    const cdb = controlDb();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const odb = orchDb();
    const task = addTask(odb, "refactor", "/tmp/repo", "a".repeat(40), 1, { workId: work.work_id });
    odb.run("UPDATE tasks SET branch=?, attempt_id=? WHERE task_id=?", ["overload/t4", "attempt-1", task.task_id]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [task.task_id, 1000, "running", "awaiting_human", "runner_exit", JSON.stringify({ evidence_complete: true })]);

    const spoolDir = tempDir();
    collectAndSpool({ orchestratorDb: odb, work_id: work.work_id, actor: "alice" }, spoolDir);
    // 追加一行坏 JSON
    const segFile = readdirSync(spoolDir).find((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson") && !f.includes(".processed."))!;
    const file = join(spoolDir, segFile);
    const good = readFileSync(file, "utf8");
    writeFileSync(file, good + "{not valid json\n");

    const stats = ingestContextSpool(cdb, spoolDir);
    expect(stats.failed).toBe(1);
    expect(stats.created).toBeGreaterThan(0); // 好行仍然摄入

    cdb.close(); odb.close();
  });

  test("5. 处理完的文件被重命名为 .processed.*", () => {
    const cdb = controlDb();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const odb = orchDb();
    const task = addTask(odb, "refactor", "/tmp/repo", "a".repeat(40), 1, { workId: work.work_id });
    odb.run("UPDATE tasks SET branch=? WHERE task_id=?", ["overload/t5", task.task_id]);

    const spoolDir = tempDir();
    collectAndSpool({ orchestratorDb: odb, work_id: work.work_id, actor: "alice" }, spoolDir);
    const before = readdirSync(spoolDir).filter((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson") && !f.includes(".processed."));
    expect(before.length).toBeGreaterThan(0);

    ingestContextSpool(cdb, spoolDir);
    const after = readdirSync(spoolDir).filter((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson") && !f.includes(".processed."));
    expect(after.length).toBe(0);
    const processed = readdirSync(spoolDir).filter((f) => f.includes(".processed."));
    expect(processed.length).toBe(1);

    cdb.close(); odb.close();
  });

  test("6. spool 文件不存在 → 全 0", () => {
    const cdb = controlDb();
    const spoolDir = tempDir();
    const stats = ingestContextSpool(cdb, spoolDir);
    expect(stats.read).toBe(0);
    expect(stats.created).toBe(0);
    expect(stats.failed).toBe(0);
    cdb.close();
  });
});
