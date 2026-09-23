import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlSchema } from "./store";
import { ensureContextReducerSchema } from "./context-reducer";
import { ingestContextSpool } from "./context-ingest";
import type { FactObservedPayload } from "../shared/context-contract";

function controlFixture(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  return db;
}

function makePayload(overrides: Partial<FactObservedPayload> = {}): FactObservedPayload {
  return {
    work_id: "W1",
    problem_id: null,
    object_canonical_key: "invocation:task-1",
    reference: "orchestrator:task_event:1",
    source_type: "orchestrator",
    source_id: "orchestrator",
    source_identity: "orchestrator",
    source_event_id: "invocation:task-1",
    observation_revision: 1,
    attempt: null,
    fact_subtype: "test_result",
    content_hash: "a".repeat(64),
    sensitivity: "clean",
    collected_at: new Date().toISOString(),
    expires_at: null,
    derived_from: null,
    ...overrides,
  };
}

const dirs: string[] = [];
afterEach(() => { dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })); });

describe("context-ingest", () => {
  test("1. 空目录返回全 0", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-empty-"));
    dirs.push(dir);
    const stats = ingestContextSpool(db, dir);
    expect(stats.read).toBe(0);
    db.close();
  });

  test("2. 多个 seg 文件 → 全部处理", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-multi-"));
    dirs.push(dir);

    writeFileSync(join(dir, "active-context-collector.1.ndjson"),
      JSON.stringify({ v: 1, at: 1, kind: "context.fact_observed", detail: makePayload({ source_event_id: "ev1", object_canonical_key: "obj1" }) }) + "\n");
    writeFileSync(join(dir, "active-context-collector.2.ndjson"),
      JSON.stringify({ v: 1, at: 2, kind: "context.fact_observed", detail: makePayload({ source_event_id: "ev2", object_canonical_key: "obj2" }) }) + "\n");

    const stats = ingestContextSpool(db, dir);
    expect(stats.read).toBe(2);
    expect(stats.created).toBe(2);

    // 处理完的文件被重命名
    const remaining = readdirSync(dir).filter(f => f.startsWith("active-context-collector") && f.endsWith(".ndjson") && !f.includes(".processed."));
    expect(remaining.length).toBe(0);
    db.close();
  });

  test("3. 处理完的文件被重命名，不重复处理", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-rename-"));
    dirs.push(dir);

    writeFileSync(join(dir, "active-context-collector.1.ndjson"),
      JSON.stringify({ v: 1, at: 1, kind: "context.fact_observed", detail: makePayload({ source_event_id: "ev1" }) }) + "\n");

    ingestContextSpool(db, dir);
    // 第二次调用：无待处理文件
    const stats2 = ingestContextSpool(db, dir);
    expect(stats2.read).toBe(0);
    db.close();
  });

  test("4. 排除 .processed 文件", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-skip-"));
    dirs.push(dir);

    writeFileSync(join(dir, "active-context-collector.1.ndjson.processed.123456"),
      "{}");
    writeFileSync(join(dir, "active-context-collector.1.ndjson"),
      JSON.stringify({ v: 1, at: 1, kind: "context.fact_observed", detail: makePayload({ source_event_id: "ev1" }) }) + "\n");

    const stats = ingestContextSpool(db, dir);
    expect(stats.read).toBe(1); // 只处理新文件，跳过 .processed
    db.close();
  });
});

describe("Fix5 用户可见 attention 摄入", () => {
  function seedWork(db: Database, workId = "W1"): void {
    db.query(
      `INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run(workId, "t", "test", null, "active", 1, JSON.stringify({ decision_owner: "owner" }), 1, 1);
  }

  test("context.pending → 创建 control_attention 卡，字段映射正确", () => {
    const db = controlFixture();
    seedWork(db);
    const dir = mkdtempSync(join(tmpdir(), "ingest-attn-"));
    dirs.push(dir);
    writeFileSync(join(dir, "active-context-collector.1.ndjson"),
      JSON.stringify({
        v: 1, at: 1, kind: "context.pending",
        detail: { work_id: "W1", task_id: "task-1", reason: "needs context", required_context: "repo access", owner: "owner", deep_link: "overload://task-1" },
      }) + "\n");
    const stats = ingestContextSpool(db, dir);
    expect(stats.read).toBe(1);
    expect(stats.created).toBe(1);
    const row = db.query("SELECT * FROM control_attention WHERE item_id=?").get("ctx:context.pending:W1:task-1") as Record<string, unknown>;
    expect(row).toBeTruthy();
    expect(row.state).toBe("open");
    expect(row.effect_state).toBe("not_started");
    expect(row.trigger).toBe("needs context");
    expect(row.impact).toBe("task-1");
    expect(row.owner).toBe("owner");
    expect(row.source_link).toBe("overload://task-1");
    expect(JSON.parse(row.options as string)).toEqual([]);
    db.close();
  });

  test("同一 (work_id,task_id,kind) 重复到达 → 更新不重复创建", () => {
    const db = controlFixture();
    seedWork(db);
    const dir = mkdtempSync(join(tmpdir(), "ingest-attn-idem-"));
    dirs.push(dir);
    const line = JSON.stringify({
      v: 1, at: 1, kind: "context.recovery_jump",
      detail: { work_id: "W1", task_id: "task-2", jump_target: "session-abc", owner: "owner", deep_link: "overload://task-2" },
    }) + "\n";
    writeFileSync(join(dir, "active-context-collector.1.ndjson"), line);
    ingestContextSpool(db, dir);
    // 第二个文件携带更新后的 owner
    const dir2 = mkdtempSync(join(tmpdir(), "ingest-attn-idem2-"));
    dirs.push(dir2);
    writeFileSync(join(dir2, "active-context-collector.1.ndjson"),
      JSON.stringify({
        v: 1, at: 2, kind: "context.recovery_jump",
        detail: { work_id: "W1", task_id: "task-2", jump_target: "session-abc", owner: "owner2", deep_link: "overload://task-2" },
      }) + "\n");
    const stats2 = ingestContextSpool(db, dir2);
    expect(stats2.read).toBe(1);
    const rows = db.query("SELECT COUNT(*) AS n FROM control_attention WHERE item_id=?").get("ctx:context.recovery_jump:W1:task-2") as { n: number };
    expect(rows.n).toBe(1);
    const row = db.query("SELECT revision, owner FROM control_attention WHERE item_id=?").get("ctx:context.recovery_jump:W1:task-2") as { revision: number; owner: string };
    expect(row.revision).toBe(2);
    expect(row.owner).toBe("owner2");
    db.close();
  });

  test("四种 recovery/pending kind 都建卡", () => {
    const db = controlFixture();
    seedWork(db);
    const dir = mkdtempSync(join(tmpdir(), "ingest-attn-kinds-"));
    dirs.push(dir);
    const kinds: Array<[string, Record<string, unknown>]> = [
      ["context.pending", { work_id: "W1", task_id: "t1", reason: "r", owner: "owner", deep_link: "l" }],
      ["context.recovery_jump", { work_id: "W1", task_id: "t2", jump_target: "s", owner: "owner", deep_link: "l" }],
      ["context.recovery_package", { work_id: "W1", task_id: "t3", checkpoint_reference: "cp", incomplete_steps: [], owner: "owner", deep_link: "l" }],
      ["context.recovery_reconcile", { work_id: "W1", task_id: "t4", reason: "r", owner: "owner", deep_link: "l" }],
    ];
    writeFileSync(join(dir, "active-context-collector.1.ndjson"),
      kinds.map(([kind, detail]) => JSON.stringify({ v: 1, at: 1, kind, detail })).join("\n") + "\n");
    const stats = ingestContextSpool(db, dir);
    expect(stats.read).toBe(4);
    expect(stats.created).toBe(4);
    const n = db.query("SELECT COUNT(*) AS n FROM control_attention").get() as { n: number };
    expect(n.n).toBe(4);
    db.close();
  });

  test("缺 owner → failed，不建卡（fail-closed）", () => {
    const db = controlFixture();
    seedWork(db);
    const dir = mkdtempSync(join(tmpdir(), "ingest-attn-bad-"));
    dirs.push(dir);
    writeFileSync(join(dir, "active-context-collector.1.ndjson"),
      JSON.stringify({ v: 1, at: 1, kind: "context.pending", detail: { work_id: "W1", task_id: "t9", reason: "r" } }) + "\n");
    const stats = ingestContextSpool(db, dir);
    expect(stats.failed).toBe(1);
    const n = db.query("SELECT COUNT(*) AS n FROM control_attention").get() as { n: number };
    expect(n.n).toBe(0);
    db.close();
  });

  test("未知 kind → failed", () => {
    const db = controlFixture();
    seedWork(db);
    const dir = mkdtempSync(join(tmpdir(), "ingest-attn-unknown-"));
    dirs.push(dir);
    writeFileSync(join(dir, "active-context-collector.1.ndjson"),
      JSON.stringify({ v: 1, at: 1, kind: "context.weird", detail: {} }) + "\n");
    const stats = ingestContextSpool(db, dir);
    expect(stats.failed).toBe(1);
    db.close();
  });
});

describe("失败行隔离（不静默丢失事件）", () => {
  test("坏 JSON 行 + 有效行：有效行入库，坏行落 quarantine sidecar 可恢复", () => {
    const db = controlFixture();
    db.query(
      `INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    ).run("W1", "t", "test", null, "active", 1, JSON.stringify({ decision_owner: "owner" }), 1, 1);
    const dir = mkdtempSync(join(tmpdir(), "ingest-quarantine-"));
    dirs.push(dir);

    const badLine = "{ this is not valid json !!! }";
    const goodLine = JSON.stringify({
      v: 1, at: 1, kind: "context.pending",
      detail: { work_id: "W1", task_id: "t-recover", reason: "r", owner: "owner", deep_link: "l" },
    });
    writeFileSync(join(dir, "active-context-collector.1.ndjson"), badLine + "\n" + goodLine + "\n");

    const stats = ingestContextSpool(db, dir);
    expect(stats.read).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.created).toBe(1);

    // (a) 有效事件被处理：attention 卡已建。
    const row = db.query("SELECT item_id FROM control_attention WHERE item_id=?")
      .get("ctx:context.pending:W1:t-recover") as { item_id: string } | undefined;
    expect(row).toBeTruthy();

    // (c) 原 pending 文件不再残留待处理（已改名审计，不整体丢弃）。
    const pending = readdirSync(dir).filter(
      (f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson")
        && !f.includes(".processed.") && !f.includes(".quarantine."),
    );
    expect(pending.length).toBe(0);
    const processed = readdirSync(dir).filter((f) => f.includes(".processed."));
    expect(processed.length).toBe(1);

    // (b) 坏行被隔离到 quarantine sidecar，保留原始行可恢复。
    const quarantine = readdirSync(dir).filter((f) => f.includes(".quarantine."));
    expect(quarantine.length).toBe(1);
    const qentry = JSON.parse(readFileSync(join(dir, quarantine[0]), "utf8").trim()) as { line: number; reason: string; raw: string };
    expect(qentry.line).toBe(1);
    expect(qentry.raw).toBe(badLine);
    expect(qentry.reason).toContain("invalid JSON");
    db.close();
  });
});
