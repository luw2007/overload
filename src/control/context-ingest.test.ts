import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

describe("external observation envelopes", () => {
  test("matched live envelope uses the existing Work, Attention, and context evidence chain", () => {
    const db = controlFixture();
    db.query(`INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run("W1", "t", "test", null, "active", 1, JSON.stringify({ decision_owner: "owner" }), 1, 1);
    const dir = mkdtempSync(join(tmpdir(), "ingest-external-observation-"));
    dirs.push(dir);
    const summary = "external observer found an unresolved runtime change";
    const hash = createHash("sha256").update(summary).digest("hex");
    writeFileSync(join(dir, "active-context-collector.1.ndjson"), JSON.stringify({
      v: 1, at: 1, kind: "context.external_observation",
      detail: { source_id: "shadow", source_event_id: "e1", observation_revision: 1, work_id: "W1", kind: "live", subject: "runtime changed", summary, content_hash: hash, observed_at: "2026-09-28T00:00:00.000Z", urgency: "inbox" },
    }) + "\n");
    const stats = ingestContextSpool(db, dir);
    expect(stats).toMatchObject({ read: 1, created: 1, failed: 0 });
    const observation = db.query("SELECT attention_item_id,state FROM control_external_observations").get() as { attention_item_id: string; state: string };
    expect(observation.state).toBe("attention_open");
    const card = db.query("SELECT work_id,owner FROM control_attention WHERE item_id=?").get(observation.attention_item_id) as { work_id: string; owner: string };
    expect(card).toEqual({ work_id: "W1", owner: "owner" });
    db.close();
  });
});

describe("bounded context spool ingestion", () => {
  test("file budget advances oldest sealed segments fairly over successive passes", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-bounded-files-"));
    dirs.push(dir);
    for (const seq of [1, 2, 3]) writeFileSync(join(dir, `active-context-collector.${seq}.ndjson`), JSON.stringify({ v: 1, at: seq, kind: "context.fact_observed", detail: makePayload({ source_event_id: `bounded-${seq}`, object_canonical_key: `bounded-${seq}` }) }) + "\n");
    const first = ingestContextSpool(db, dir, { max_files: 1, max_lines: 10, max_bytes: 100_000 });
    expect(first).toMatchObject({ backlog_files: 3, processed_files: 1, deferred: 2, created: 1 });
    const second = ingestContextSpool(db, dir, { max_files: 1, max_lines: 10, max_bytes: 100_000 });
    const third = ingestContextSpool(db, dir, { max_files: 1, max_lines: 10, max_bytes: 100_000 });
    expect(second).toMatchObject({ processed_files: 1, created: 1 });
    expect(third).toMatchObject({ processed_files: 1, created: 1, deferred: 0 });
    expect(db.query("SELECT COUNT(*) n FROM control_context_objects").get()).toMatchObject({ n: 3 });
    db.close();
  });

  test("line and byte exhaustion retain whole next segment for retry", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-bounded-budget-"));
    dirs.push(dir);
    const line = JSON.stringify({ v: 1, at: 1, kind: "context.fact_observed", detail: makePayload({ source_event_id: "budget-1", object_canonical_key: "budget-1" }) }) + "\n";
    writeFileSync(join(dir, "active-context-collector.1.ndjson"), line);
    writeFileSync(join(dir, "active-context-collector.2.ndjson"), line.replaceAll("budget-1", "budget-2"));
    const lineLimited = ingestContextSpool(db, dir, { max_files: 4, max_lines: 1, max_bytes: 100_000 });
    expect(lineLimited).toMatchObject({ processed_files: 1, deferred: 1, created: 1 });
    const byteLimited = ingestContextSpool(db, dir, { max_files: 4, max_lines: 10, max_bytes: 1 });
    expect(byteLimited).toMatchObject({ processed_files: 0, blocked_files: 1, deferred: 1, read: 0 });
    expect(readdirSync(dir)).toContain("active-context-collector.2.ndjson");
    const retried = ingestContextSpool(db, dir, { max_files: 4, max_lines: 10, max_bytes: 100_000 });
    expect(retried).toMatchObject({ processed_files: 1, created: 1 });
    db.close();
  });

  test("quarantine remains isolated and next pass has no duplicated projection", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-bounded-quarantine-"));
    dirs.push(dir);
    const good = JSON.stringify({ v: 1, at: 1, kind: "context.fact_observed", detail: makePayload({ source_event_id: "isolation", object_canonical_key: "isolation" }) });
    writeFileSync(join(dir, "active-context-collector.1.ndjson"), `{invalid}\n${good}\n`);
    const first = ingestContextSpool(db, dir, { max_files: 1, max_lines: 10, max_bytes: 100_000 });
    expect(first).toMatchObject({ created: 1, failed: 1, processed_files: 1 });
    expect(ingestContextSpool(db, dir, { max_files: 1, max_lines: 10, max_bytes: 100_000 })).toMatchObject({ read: 0, created: 0 });
    expect(db.query("SELECT COUNT(*) n FROM control_context_objects").get()).toMatchObject({ n: 1 });
    db.close();
  });

  test("a segment exceeding the line limit is deferred without persisting any prefix", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-bounded-atomic-lines-"));
    dirs.push(dir);
    const first = JSON.stringify({ v: 1, at: 1, kind: "context.fact_observed", detail: makePayload({ source_event_id: "atomic-line-1", object_canonical_key: "atomic-line-1" }) });
    const second = JSON.stringify({ v: 1, at: 2, kind: "context.fact_observed", detail: makePayload({ source_event_id: "atomic-line-2", object_canonical_key: "atomic-line-2" }) });
    writeFileSync(join(dir, "active-context-collector.1.ndjson"), `${first}\n${second}\n`);
    expect(ingestContextSpool(db, dir, { max_files: 1, max_lines: 1, max_bytes: 100_000 })).toMatchObject({ read: 0, created: 0, deferred: 1 });
    expect(db.query("SELECT COUNT(*) n FROM control_context_objects").get()).toMatchObject({ n: 0 });
    expect(ingestContextSpool(db, dir, { max_files: 1, max_lines: 10, max_bytes: 100_000 })).toMatchObject({ read: 2, created: 2, processed_files: 1 });
    db.close();
  });
});
describe("context spool lease", () => {
  test("active durable lease makes concurrent pass busy without consuming files", () => {
    const db = controlFixture();
    const dir = mkdtempSync(join(tmpdir(), "ingest-lease-"));
    dirs.push(dir);
    writeFileSync(join(dir, "active-context-collector.1.ndjson"), JSON.stringify({ v: 1, at: 1, kind: "context.fact_observed", detail: makePayload({ source_event_id: "lease", object_canonical_key: "lease" }) }) + "\n");
    const spoolKey = createHash("sha256").update(resolve(dir)).digest("hex");
    db.query("INSERT INTO control_context_ingest_leases(spool_key,owner_token,lease_until,updated_at) VALUES(?,?,?,?)").run(spoolKey, "other", Date.now() + 60_000, Date.now());
    const blocked = ingestContextSpool(db, dir);
    expect(blocked).toMatchObject({ busy: true, read: 0, processed_files: 0 });
    expect(readdirSync(dir)).toContain("active-context-collector.1.ndjson");
    db.query("DELETE FROM control_context_ingest_leases").run();
    expect(ingestContextSpool(db, dir)).toMatchObject({ busy: false, created: 1, processed_files: 1 });
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
