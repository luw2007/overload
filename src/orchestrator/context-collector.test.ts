import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { mkdtempSync, readFileSync as readFile, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  collectAndSpool,
  collectCodeState,
  collectExternalState,
  collectFacts,
  collectObservationEvidence,
  collectTestResults,
  peekCollectorSeq,
  resetCollectorDedup,
  spoolContextEnvelope,
  type FactObservedEvent,
} from "./context-collector";
import { addTask, type Task } from "./store";

const BASE_REF = "a".repeat(40);

function memDb(): Database {
  const db = new Database(":memory:");
  db.exec(readFileSync(join(import.meta.dir, "schema.sql"), "utf8"));
  db.run("INSERT OR IGNORE INTO spool_seq(id,seq,segment) VALUES(1,0,0)");
  return db;
}

type Ctx = { orchestratorDb: Database; work_id: string; actor: string; runtime_id: string };
function ctx(db: Database, workId = "W1"): Ctx {
  return { orchestratorDb: db, work_id: workId, actor: "test-actor", runtime_id: "test-runtime" };
}

function seedTask(db: Database, workId = "W1"): Task {
  return addTask(db, "重构 parseConfig", "/repo", BASE_REF, 1, { workId });
}

function setBranch(db: Database, taskId: string, branch: string, attemptId = "attempt-1"): void {
  db.run("UPDATE tasks SET branch=?, attempt_id=? WHERE task_id=?", [branch, attemptId, taskId]);
}

function setPr(db: Database, taskId: string, prUrl: string): void {
  db.run("UPDATE tasks SET pr_url=? WHERE task_id=?", [prUrl, taskId]);
}

function insertEvent(
  db: Database,
  taskId: string,
  at: number,
  event: string,
  detail?: Record<string, unknown>,
): void {
  db.run(
    "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
    [taskId, at, "running", "running", event, detail ? JSON.stringify(detail) : null],
  );
}

const dbs: Database[] = [];
function freshDb(): Database {
  const db = memDb();
  dbs.push(db);
  return db;
}

beforeEach(() => resetCollectorDedup());
afterEach(() => {
  resetCollectorDedup();
  for (const db of dbs.splice(0)) db.close();
});

describe("context-collector", () => {
  test("1. collectTestResults 从 runner_exit 采集 test_result 事实", () => {
    const db = freshDb();
    const t = seedTask(db);
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    const facts = collectTestResults(ctx(db));
    expect(facts).toHaveLength(1);
    expect(facts[0].fact_subtype).toBe("test_result");
    expect(facts[0].object_canonical_key).toBe(`invocation:${t.task_id}`);
    expect(facts[0].reference).toContain("orchestrator:task_event:");
    expect(facts[0].source_type).toBe("orchestrator");
  });

  test("2. collectCodeState 从 task.branch 采集 code_state 事实", () => {
    const db = freshDb();
    const t = seedTask(db);
    setBranch(db, t.task_id, "overload/parseconfig");
    const facts = collectCodeState(ctx(db));
    expect(facts).toHaveLength(1);
    expect(facts[0].fact_subtype).toBe("code_state");
    expect(facts[0].object_canonical_key).toBe("git:/repo:overload/parseconfig");
  });

  test("3. 去重：同一 source_event_id 采集两次，第二次不重复产生", () => {
    const db = freshDb();
    const t = seedTask(db);
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    expect(collectTestResults(ctx(db))).toHaveLength(1);
    expect(collectTestResults(ctx(db))).toHaveLength(0);
  });

  test("4. observation_revision 递增：同源新观测（结果变化）→ revision=2", () => {
    const db = freshDb();
    const t = seedTask(db);
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    const first = collectTestResults(ctx(db));
    expect(first).toHaveLength(1);
    expect(first[0].observation_revision).toBe(1);

    // 重跑：同 task 出现新的 runner_exit，结论不同 → 新观测。
    insertEvent(db, t.task_id, 20, "runner_exit", { evidence_complete: false, reason: "checks_failed" });
    const second = collectTestResults(ctx(db));
    expect(second).toHaveLength(1);
    expect(second[0].observation_revision).toBe(2);
    expect(second[0].source_event_id).toBe(first[0].source_event_id);
  });

  test("5. collectFacts 聚合多种类型事实", () => {
    const db = freshDb();
    const t = seedTask(db);
    setBranch(db, t.task_id, "overload/x");
    setPr(db, t.task_id, "https://github.com/o/r/pull/9");
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    insertEvent(db, t.task_id, 5, "check_absent", { reason: "no_check" });
    const facts = collectFacts(ctx(db));
    const subtypes = new Set(facts.map((f) => f.fact_subtype));
    expect(subtypes.has("test_result")).toBe(true);
    expect(subtypes.has("code_state")).toBe(true);
    expect(subtypes.has("external_state")).toBe(true);
    expect(subtypes.has("observation_evidence")).toBe(true);
    expect(facts.length).toBeGreaterThanOrEqual(4);
  });

  test("6/7. 事件 16 必填字段齐全且 content_hash 是合法 sha256 hex", () => {
    const db = freshDb();
    const t = seedTask(db);
    setBranch(db, t.task_id, "overload/x");
    setPr(db, t.task_id, "https://github.com/o/r/pull/9");
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    insertEvent(db, t.task_id, 5, "check_absent");
    for (const f of collectFacts(ctx(db))) {
      expect(f.work_id).toBe("W1");
      expect(f.object_canonical_key).toBeTruthy();
      expect(f.reference).toBeTruthy();
      expect(f.source_type).toBeTruthy();
      expect(f.source_id).toBe("test-runtime");
      expect(f.source_identity).toBe("test-actor");
      expect(f.source_event_id).toBeTruthy();
      expect(f.observation_revision).toBeGreaterThanOrEqual(1);
      expect(f.fact_subtype).toBeTruthy();
      expect(f.content_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(f.sensitivity).toBeTruthy();
      expect(f.collected_at).toBeTruthy();
      // ISO8601 可解析
      expect(Number.isNaN(Date.parse(f.collected_at))).toBe(false);
      // 严格 16 字段
      expect(Object.keys(f).sort()).toEqual(
        [
          "work_id",
          "problem_id",
          "object_canonical_key",
          "reference",
          "source_type",
          "source_id",
          "source_identity",
          "source_event_id",
          "observation_revision",
          "attempt",
          "fact_subtype",
          "content_hash",
          "sensitivity",
          "collected_at",
          "expires_at",
          "derived_from",
        ].sort(),
      );
    }
  });

  test("8. sensitivity 默认值正确", () => {
    const db = freshDb();
    const t = seedTask(db);
    setBranch(db, t.task_id, "overload/x");
    setPr(db, t.task_id, "https://github.com/o/r/pull/9");
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    insertEvent(db, t.task_id, 5, "check_absent");
    const facts = collectFacts(ctx(db));
    const bySubtype = (s: string) => facts.find((f) => f.fact_subtype === s)!;
    expect(bySubtype("test_result").sensitivity).toBe("clean");
    expect(bySubtype("code_state").sensitivity).toBe("clean");
    expect(bySubtype("external_state").sensitivity).toBe("clean");
    expect(bySubtype("observation_evidence").sensitivity).toBe("clean");
  });

  test("9. collectAndSpool 写出可解析的 NDJSON", () => {
    const db = freshDb();
    const t = seedTask(db);
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    const dir = mkdtempSync(join(tmpdir(), "orch-spool-"));
    try {
      const result = collectAndSpool(ctx(db), dir);
      expect(result.events).toBe(1);
      expect(result.spooled).toBe(1);
      // collectAndSpool 写带序号的 seg 文件
      const segFiles = readdirSync(dir).filter(f => f.startsWith("active-context-collector") && f.endsWith(".ndjson"));
      expect(segFiles.length).toBe(1);
      const file = join(dir, segFiles[0]);
      const lines = readFile(file, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
      expect(lines.length).toBe(1);
      const envelope = JSON.parse(lines[0]) as { kind: string; detail: FactObservedEvent };
      expect(envelope.kind).toBe("context.fact_observed");
      expect(envelope.detail.fact_subtype).toBe("test_result");
      expect(envelope.detail.work_id).toBe("W1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("10. 不直写 control DB：模块不 import src/control/*，函数签名不含 control DB", () => {
    const src = readFile(join(import.meta.dir, "context-collector.ts"), "utf8");
    // 只检查真正的 import-from 子句；注释里提到 control 不算。
    expect(src).not.toMatch(/import\s+[^;]*from\s+["'][^"']*\/control\//);
    expect(src).not.toMatch(/import\s+[^;]*from\s+["']\.\.\/control/);
    // CollectorContext 只接受 orchestratorDb（bun:sqlite Database），无 control store 参数。
    const ctxSrc = src.match(/export interface CollectorContext \{([\s\S]*?)\}/)![1];
    expect(ctxSrc).not.toMatch(/control/i);
  });

  test("跨 work 隔离：只采集 ctx.work_id 下的任务", () => {
    const db = freshDb();
    const mine = seedTask(db, "W1");
    const other = seedTask(db, "W2");
    insertEvent(db, mine.task_id, 10, "runner_exit", { evidence_complete: true });
    insertEvent(db, other.task_id, 10, "runner_exit", { evidence_complete: true });
    const facts = collectTestResults(ctx(db, "W1"));
    expect(facts).toHaveLength(1);
    expect(facts[0].work_id).toBe("W1");
  });

  test("11. 重启幂等：清空内存缓存后 DB cursor 仍去重", () => {
    const db = freshDb();
    const t = seedTask(db);
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    const first = collectTestResults(ctx(db));
    expect(first).toHaveLength(1);
    expect(first[0].observation_revision).toBe(1);

    resetCollectorDedup(); // 模拟进程重启：清空内存 Map，DB cursor 保留

    const second = collectTestResults(ctx(db));
    expect(second).toHaveLength(0);
  });

  test("12. 重启后内容变化 → revision 递增", () => {
    const db = freshDb();
    const t = seedTask(db);
    insertEvent(db, t.task_id, 10, "runner_exit", { evidence_complete: true });
    const first = collectTestResults(ctx(db));
    expect(first[0].observation_revision).toBe(1);

    resetCollectorDedup();

    insertEvent(db, t.task_id, 20, "runner_exit", { evidence_complete: false, reason: "checks_failed" });
    const second = collectTestResults(ctx(db));
    expect(second).toHaveLength(1);
    expect(second[0].observation_revision).toBe(2);
    expect(second[0].source_event_id).toBe(first[0].source_event_id);
  });
describe("Fix 1: content_hash = source bytes", () => {
  test("F1-positive: test_result content_hash = sha256(task_events.detail 原文)", () => {
    const db = freshDb();
    const t = seedTask(db);
    const rawDetail = JSON.stringify({ evidence_complete: true, extra: "保留原样" });
    db.run(
      "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [t.task_id, 10, "running", "running", "runner_exit", rawDetail],
    );
    const facts = collectTestResults(ctx(db));
    expect(facts).toHaveLength(1);
    const expected = createHash("sha256").update(rawDetail).digest("hex");
    expect(facts[0].content_hash).toBe(expected);
  });

  test("F1-negative: detail 变化 → content_hash 变化（与 fetcher 源字节一致）", () => {
    const db = freshDb();
    const t = seedTask(db);
    db.run(
      "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [t.task_id, 10, "running", "running", "runner_exit", JSON.stringify({ evidence_complete: true })],
    );
    const first = collectTestResults(ctx(db));
    expect(first[0].content_hash).toBe(createHash("sha256").update(JSON.stringify({ evidence_complete: true })).digest("hex"));

    resetCollectorDedup();
    const newDetail = JSON.stringify({ evidence_complete: false, reason: "checks_failed" });
    db.run(
      "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [t.task_id, 20, "running", "awaiting_human", "runner_exit", newDetail],
    );
    const second = collectTestResults(ctx(db));
    expect(second).toHaveLength(1);
    expect(second[0].content_hash).toBe(createHash("sha256").update(newDetail).digest("hex"));
    expect(second[0].content_hash).not.toBe(first[0].content_hash);
  });

  test("F1-observation: observation_evidence content_hash = sha256(detail 原文)", () => {
    const db = freshDb();
    const t = seedTask(db);
    const rawDetail = JSON.stringify({ reason: "no_check" });
    db.run(
      "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [t.task_id, 5, "running", "blocked", "check_absent", rawDetail],
    );
    const facts = collectObservationEvidence(ctx(db));
    expect(facts).toHaveLength(1);
    expect(facts[0].content_hash).toBe(createHash("sha256").update(rawDetail).digest("hex"));
  });
});

describe("Fix 4: collected_at = 源事件时间", () => {
  test("F4-positive: 旧 task_events.at → fact.collected_at 等于旧时间（不是 Date.now）", () => {
    const db = freshDb();
    const t = seedTask(db);
    const oldAt = 1_700_000_000_000; // 2023-11-14，远早于当前
    db.run(
      "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [t.task_id, oldAt, "running", "running", "runner_exit", JSON.stringify({ evidence_complete: true })],
    );
    const facts = collectTestResults(ctx(db));
    expect(facts).toHaveLength(1);
    expect(facts[0].collected_at).toBe(new Date(oldAt).toISOString());
  });

  test("F4-code_state: code_state.collected_at = tasks.updated_at", () => {
    const db = freshDb();
    const t = seedTask(db);
    const oldUpdated = 1_700_000_100_000;
    db.run("UPDATE tasks SET branch=?, updated_at=? WHERE task_id=?", ["overload/x", oldUpdated, t.task_id]);
    const facts = collectCodeState(ctx(db));
    expect(facts).toHaveLength(1);
    expect(facts[0].collected_at).toBe(new Date(oldUpdated).toISOString());
  });
});

describe("Fix 3: 持久序号 + 原子写入", () => {
  test("F3-positive: collectAndSpool 写 .ndjson，seq 持久递增；第二次序号 = 第一次+1", () => {
    const db = freshDb();
    const t = seedTask(db);
    db.run(
      "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      [t.task_id, 10, "running", "running", "runner_exit", JSON.stringify({ evidence_complete: true })],
    );
    const dir = mkdtempSync(join(tmpdir(), "orch-spool-"));
    try {
      expect(peekCollectorSeq(db)).toBe(0);
      collectAndSpool(ctx(db), dir);
      const after1 = peekCollectorSeq(db);
      expect(after1).toBe(1);
      // 第二次采集：无新事实，不写文件，但序号也不分配（events.length=0 提前返回）。
      // 触发新事实：再插入一条 diagnostic 事件。
      db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [t.task_id, 15, "running", "blocked", "check_absent", JSON.stringify({ reason: "no_check" })],
      );
      collectAndSpool(ctx(db), dir);
      const after2 = peekCollectorSeq(db);
      expect(after2).toBe(2);
      // 两个独立 .ndjson 文件，序号连续。
      const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
      expect(files.sort()).toEqual(["active-context-collector.1.ndjson", "active-context-collector.2.ndjson"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F3-atomic: .tmp 文件不可见，rename 后才摄入；重启后序号不碰撞", () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "orch-spool-"));
    try {
      // 手工模拟写一半的 .tmp 文件（脏数据，未 rename）。
      const tmp = join(dir, "active-context-collector.9.ndjson.tmp");
      writeFileSync(tmp, '{"v":1,"at":1,"kind":"context.fact_observed","detail":{"incomplete":true}}\n', { mode: 0o600 });
      // collectAndSpool 不应复用 .9 序号；它从 DB 分配新序号（=1）。
      const t = seedTask(db);
      db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [t.task_id, 10, "running", "running", "runner_exit", JSON.stringify({ evidence_complete: true })],
      );
      collectAndSpool(ctx(db), dir);
      expect(peekCollectorSeq(db)).toBe(1);
      // .tmp 仍在（未被 ingest 处理），.ndjson 是新写的完整文件。
      expect(existsSync(tmp)).toBe(true);
      const ndjson = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
      expect(ndjson).toEqual(["active-context-collector.1.ndjson"]);
      // 内容完整可解析。
      const lines = readFile(join(dir, ndjson[0]), "utf8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      const env = JSON.parse(lines[0]);
      expect(env.kind).toBe("context.fact_observed");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("F3-spoolContextEnvelope: 通用 envelope 写入与 fact_observed 共用序号", () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), "orch-spool-"));
    try {
      spoolContextEnvelope(db, dir, "context.pending", { work_id: "W1", task_id: "t1", reason: "x", required_context: "rc", owner: "alice", deep_link: "cmux://work/W1/task/t1" }, 1234);
      expect(peekCollectorSeq(db)).toBe(1);
      const files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
      expect(files).toEqual(["active-context-collector.1.ndjson"]);
      const env = JSON.parse(readFile(join(dir, files[0]), "utf8").trim());
      expect(env.v).toBe(1);
      expect(env.at).toBe(1234);
      expect(env.kind).toBe("context.pending");
      expect(env.detail.owner).toBe("alice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

});
