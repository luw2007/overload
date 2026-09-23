/**
 * test/context-integration.test.ts — Surface 层真实链路集成测试（问题 9 修复 + 端到端验收）。
 *
 * 全部使用真实 SQLite 文件 + 真实文件系统 spool + 真实 HTTP server，不 mock 内部函数。
 *
 * 场景 A：collector→spool→ingest→control context→HTTP decision-package/fetch-full
 * 场景 B：live blocked-on-ask → attemptRecovery 记录 recovery_jump + spool envelope → ingest 出决策卡
 * 场景 C：exited + 未消费 approval → 不 jump（反例）
 * 场景 D：跨 work task_event 引用 → fetchOnDemand forbidden，不返回正文
 * 场景 E：.tmp 半行文件不摄入；rename 为 .ndjson 后摄入一次；再摄入幂等不重复
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openControl, createWork, upsertAttention, type Work } from "../src/control/store";
import { ensureContextReducerSchema } from "../src/control/context-reducer";
import { createProblem, createObject } from "../src/control/context-pool";
import { ingestContextSpool } from "../src/control/context-ingest";
import { fetchOnDemand, clearFetchCache } from "../src/control/on-demand-fetcher";
import type { Contract } from "../src/control/types";
import { openStore } from "../src/orchestrator/store";
import { SpoolWriter } from "../src/orchestrator/spool";
import { collectAndSpool, resetCollectorDedup } from "../src/orchestrator/context-collector";
import { Orchestrator } from "../src/orchestrator/orchestrator";
import { startWebServer } from "../src/web/server";

const LEDGER_SCHEMA = readFileSync(join(import.meta.dir, "..", "src", "ingest", "schema.sql"), "utf8");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function makeContract(owner = "alice"): Contract {
  return {
    objective: "refactor parseConfig to a pure function",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: ["do not change public API"],
    scope: { repo: "/tmp/repo" },
    budget: { retry_limit: 3 },
    stop_conditions: [],
    decision_owner: owner,
  };
}

interface Env {
  root: string;
  controlPath: string;
  orchPath: string;
  /** collector/ingest 共用的 spool 目录：<spoolRoot>/spool/<host>/orchestrator */
  spoolDir: string;
}

const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void; port: number }> = [];
const savedEnv: Array<[string, string | undefined]> = [];

function setEnv(key: string, value: string): void {
  savedEnv.push([key, process.env[key]]);
  process.env[key] = value;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const [key, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  resetCollectorDedup();
  clearFetchCache();
});

/** 建临时 spoolRoot：写 host=local，返回 control/orchestrator DB 路径与 collector spool 目录。 */
function setupEnv(): Env {
  const root = mkdtempSync(join(tmpdir(), "ovl-integ-"));
  roots.push(root);
  writeFileSync(join(root, "host"), "local\n");
  const controlPath = join(root, "control.db");
  const orchPath = join(root, "orch.db");
  // SpoolWriter.dir = <root>/spool/local/orchestrator —— collector 写、ingest 读必须是同一目录。
  const spoolDir = join(root, "spool", "local", "orchestrator");
  return { root, controlPath, orchPath, spoolDir };
}

/** 在 control DB 建 work（含 contract owner=alice）+ 根问题，返回 work 与 problem。 */
function seedControl(controlPath: string): { work: Work; problemId: string } {
  const db = openControl(controlPath);
  ensureContextReducerSchema(db);
  const work = createWork(db, { title: "w", source: "integ", contract: makeContract("alice") }, 1);
  const problem = createProblem(db, { work_id: work.work_id, title: "root" }, 2);
  db.close();
  return { work, problemId: problem.problem_id };
}

/** 建一个 orchestrator task + 一条 runner_exit 事件（detail 为 JSON 字符串）。返回 event id。 */
function seedRunnerExit(orchPath: string, workId: string, detail: string): number {
  const odb = openStore(orchPath);
  odb.run(
    `INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,contract_revision,ci_observation_failures,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ["task-a", "refactor", "/tmp/repo", "a".repeat(40), "awaiting_human", workId, "att-a", null, null, 2, null, null, null, null, 1, 0, 1, 1],
  );
  odb.run(
    "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
    ["task-a", 1000, "running", "awaiting_human", "runner_exit", detail],
  );
  const id = (odb.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  odb.close();
  return id;
}

// ========== 场景 A：collector→spool→ingest→control→HTTP ==========

describe("场景 A：collector→spool→ingest→control→HTTP 全链路", () => {
  test("A. collectAndSpool → ingestContextSpool → decision-package 含 fact → fetch-full 原文 hash 匹配", () => {
    const env = setupEnv();
    const { work, problemId } = seedControl(env.controlPath);

    // 1-2. orchestrator DB：task + runner_exit，detail 为 JSON 字符串。
    const detail = JSON.stringify({ exit_code: 0, tests_passed: 7, file: "parseConfig.test.ts" });
    const eventId = seedRunnerExit(env.orchPath, work.work_id, detail);

    // 3. 真实 collector 写 seg 文件到 spoolDir。
    const odb = openStore(env.orchPath);
    const collected = collectAndSpool(
      { orchestratorDb: odb, work_id: work.work_id, problem_id: problemId, actor: "alice" },
      env.spoolDir,
    );
    odb.close();
    expect(collected.spooled).toBeGreaterThan(0);
    // seg 文件以 .ndjson 落盘（tmp 已 rename）。
    const segFiles = readdirSync(env.spoolDir).filter((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson") && !f.includes(".processed."));
    expect(segFiles.length).toBe(1);

    // 4. 真实 ingest 读 seg 文件，投影到 control DB。
    const cdb = openControl(env.controlPath);
    const stats = ingestContextSpool(cdb, env.spoolDir);
    expect(stats.failed).toBe(0);
    expect(stats.quarantined).toBe(0);
    expect(stats.created).toBeGreaterThan(0);

    // 5. control DB 有 fact 对象，content_hash = sha256(task_events.detail 原文)。
    const ref = `orchestrator:task_event:${eventId}`;
    const ver = cdb.query(
      "SELECT o.object_id, v.revision, v.content_hash, v.reference FROM control_context_objects o JOIN control_context_object_versions v ON v.object_id=o.object_id WHERE v.reference=?",
    ).get(ref) as { object_id: string; revision: number; content_hash: string; reference: string } | undefined;
    expect(ver).toBeTruthy();
    expect(ver!.content_hash).toBe(sha256(detail));

    // 建决策卡，供 decision-package 装配。
    upsertAttention(cdb, {
      item_id: "item-a", work_id: work.work_id, state: "open", effect_state: "not_started",
      urgency: "now", conclusion: "accept the refactor?", trigger: "tests green",
      impact: "merge", recommendation: "continue", options: ["continue", "stop"],
      owner: "alice", expires_at: null, source_link: null, approval_id: null,
      consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {},
    }, 3);
    cdb.close();

    // 6. 启动真实 web server（随机端口，注入 actor=alice + 同一 spoolRoot）。
    setEnv("OVERLOAD_ORCHESTRATOR_PATH", env.orchPath);
    // publish loop 会读 ledger（reconcileEffectEvents），先建好带 schema 的 ledger DB。
    const ledgerPath = join(env.root, "ledger.db");
    const ldb = new Database(ledgerPath);
    ldb.exec(LEDGER_SCHEMA);
    ldb.close();
    const server = startWebServer({
      controlPath: env.controlPath, orchestratorPath: env.orchPath, spoolRoot: env.root,
      ledgerPath, publishIntervalMs: 60_000, port: 0, actor: "alice",
    });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    // 7. decision-package → trigger_evidence 含该 fact。
    return (async () => {
      const pkgRes = await fetch(`${base}/api/context/decision-package?item_id=item-a&work_id=${encodeURIComponent(work.work_id)}`);
      expect(pkgRes.status).toBe(200);
      const pkg = await pkgRes.json() as Record<string, any>;
      const ev = (pkg.trigger_evidence as Array<{ reference: string; object_id: string }>)
        .find((e) => e.reference === ref);
      expect(ev).toBeTruthy();
      expect(ev!.object_id).toBe(ver!.object_id);

      // 8. fetch-full → 返回原文 payload，content_hash 匹配。
      const ff = await fetch(`${base}/api/context/fetch-full?object_id=${encodeURIComponent(ver!.object_id)}&revision=${ver!.revision}&work_id=${encodeURIComponent(work.work_id)}&visibility=full`);
      expect(ff.status).toBe(200);
      const body = await ff.json() as Record<string, any>;
      expect(body.payload).toBe(detail);
      expect(body.content_hash).toBe(sha256(detail));
      expect(body.visibility).toBe("full");
    })();
  });
});

// ========== 场景 B：live blocked-on-ask jump ==========

describe("场景 B：live blocked-on-ask → recovery_jump + 决策卡", () => {
  test("B. awaiting_human + 未消费 approval + live(pid/stable_id) + 无 runner_exit → recovery_jump envelope → ingest 出卡", () => {
    const env = setupEnv();
    const { work } = seedControl(env.controlPath);

    const odb = openStore(env.orchPath);
    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-b", "live", "/tmp/repo", "a".repeat(40), "awaiting_human", work.work_id, "att-b", 99999, "boot-b", 2, "stable-live-b", null, null, null, 1, 0, 1, 1],
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-b", 1000, "running", "awaiting_human", "session_bound", JSON.stringify({ stable_id: "stable-live-b", runner_pid: 99999 })]);
    odb.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
      ["appr-b", "task-b", "ready", "approve?", JSON.stringify(["approve", "reject"]), 1, 2, null, null]);

    const spool = new SpoolWriter(odb, env.root);
    const orch = new Orchestrator(odb, spool, 1);
    setEnv("OVERLOAD_ANSWERS_PATH", env.controlPath);

    orch.attemptRecovery("task-b");

    // 3a. 记录 recovery_jump task_event。
    const jumpEv = odb.query(
      "SELECT event FROM task_events WHERE task_id=? AND event='recovery_jump'").get("task-b") as { event: string } | undefined;
    expect(jumpEv).toBeTruthy();
    // 3b. spool 中有 context.recovery_jump envelope（collector 同名目录）。
    const collectorFiles = readdirSync(env.spoolDir)
      .filter((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson") && !f.includes(".processed."));
    expect(collectorFiles.length).toBe(1);
    const envelopes = readFileSync(join(env.spoolDir, collectorFiles[0]), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const jumpEnv = envelopes.find((e) => e.kind === "context.recovery_jump");
    expect(jumpEnv).toBeTruthy();
    expect(jumpEnv.detail.jump_target).toContain("stable-live-b");

    // 4. ingest 后 control_attention 有对应卡片。
    const cdb = openControl(env.controlPath);
    const stats = ingestContextSpool(cdb, env.spoolDir);
    expect(stats.created).toBe(1);
    const card = cdb.query("SELECT item_id, conclusion, urgency FROM control_attention WHERE item_id=?")
      .get(`ctx:context.recovery_jump:${work.work_id}:task-b`) as { item_id: string; conclusion: string; urgency: string } | undefined;
    expect(card).toBeTruthy();
    expect(card!.urgency).toBe("now");
    cdb.close();

    spool.close(); odb.close();
  });
});

// ========== 场景 C：exited + pending approval 不 jump（反例）==========

describe("场景 C：exited + 未消费 approval → 不 jump", () => {
  test("C. awaiting_human + runner_exit（terminated）→ 不记录 recovery_jump", () => {
    const env = setupEnv();
    const { work } = seedControl(env.controlPath);

    const odb = openStore(env.orchPath);
    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-c", "exited", "/tmp/repo", "a".repeat(40), "awaiting_human", work.work_id, "att-c", 99998, "boot-c", 2, "stable-exited-c", null, null, null, 1, 0, 1, 1],
    );
    // 关键：有 runner_exit 事件 → runner 已终止，即便有未消费 approval 也不得 jump。
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-c", 1000, "running", "awaiting_human", "runner_exit", JSON.stringify({ evidence_complete: false, reason: "timeout" })]);
    odb.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
      ["appr-c", "task-c", "ready", "approve?", JSON.stringify(["approve", "reject"]), 1, 2, null, null]);

    const spool = new SpoolWriter(odb, env.root);
    const orch = new Orchestrator(odb, spool, 1);
    setEnv("OVERLOAD_ANSWERS_PATH", env.controlPath);

    orch.attemptRecovery("task-c");

    // 反例：绝不记录 recovery_jump。
    const jumpCount = (odb.query("SELECT COUNT(*) n FROM task_events WHERE task_id=? AND event='recovery_jump'").get("task-c") as { n: number }).n;
    expect(jumpCount).toBe(0);
    // 走 terminated 路径：要么 recovery_blocked（无 checkpoint），要么 recovery_package_ready，绝不 jump。
    const anyRecovery = odb.query("SELECT event FROM task_events WHERE task_id=? AND event LIKE 'recovery_%'").get("task-c") as { event: string } | undefined;
    expect(anyRecovery).toBeTruthy();
    expect(anyRecovery!.event).not.toBe("recovery_jump");

    // spool 中也不应有 recovery_jump envelope。
    const collectorFiles = readdirSync(env.spoolDir)
      .filter((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson") && !f.includes(".processed."));
    for (const f of collectorFiles) {
      for (const line of readFileSync(join(env.spoolDir, f), "utf8").trim().split("\n")) {
        if (!line) continue;
        expect(JSON.parse(line).kind).not.toBe("context.recovery_jump");
      }
    }

    spool.close(); odb.close();
  });
});

// ========== 场景 D：跨 work task_event 拒绝 ==========

describe("场景 D：跨 work task_event 引用 → forbidden", () => {
  test("D. work B 引用 work A 的 task_event:1 → fetchOnDemand forbidden，不返回正文", () => {
    const env = setupEnv();
    const cdb = openControl(env.controlPath);
    ensureContextReducerSchema(cdb);
    // work A 与 work B 都归 alice。
    const workA = createWork(cdb, { title: "A", source: "integ", contract: makeContract("alice") }, 1);
    const workB = createWork(cdb, { title: "B", source: "integ", contract: makeContract("alice") }, 1);

    // 在 work B 的对象池里注册一个 reference 指向 task_event:1（跨 work 引用）。
    createObject(cdb, {
      work_id: workB.work_id, ctype: "fact", fact_subtype: "observation_evidence",
      object_canonical_key: "cross-b", reference: "orchestrator:task_event:1",
      source_type: "orchestrator", sensitivity: "clean",
      content_hash: "hash-cross", summary_short: "cross",
    });

    // orchestrator DB：task_event id=1 属于 work A 的 task，work B 没有任何 task。
    const odb = openStore(env.orchPath);
    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,attempt_id,retry_budget,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-a-owner", "t", "/tmp/repo", "a".repeat(40), "running", workA.work_id, "att", 2, 0, 1, 1],
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-a-owner", 1000, "running", "awaiting_human", "runner_exit", JSON.stringify({ secret: "for-a-only" })]);
    odb.close();

    setEnv("OVERLOAD_ORCHESTRATOR_PATH", env.orchPath);

    const result = fetchOnDemand({
      reference: "orchestrator:task_event:1",
      visibility: "full",
      actor: "alice",
      work_id: workB.work_id,
      purpose: "decision_view",
      db: cdb,
    });

    expect("blocked" in result).toBe(true);
    if ("blocked" in result) {
      expect(result.code).toBe("forbidden");
      expect(result.reason).toContain("cross-work");
    }
    cdb.close();
  });
});

// ========== 场景 E：半行 .tmp 补全不丢事件、幂等 ==========

describe("场景 E：.tmp 半行文件补全 + 幂等", () => {
  test("E. .tmp 不摄入；rename 为 .ndjson 后摄入一次；再摄入幂等不重复", () => {
    const env = setupEnv();
    const cdb = openControl(env.controlPath);
    ensureContextReducerSchema(cdb);
    const work = createWork(cdb, { title: "w", source: "integ", contract: makeContract("alice") }, 1);

    const envelope = {
      v: 1, at: 12345, kind: "context.fact_observed",
      detail: {
        work_id: work.work_id, problem_id: null, object_canonical_key: "ev-e",
        reference: "orchestrator:task_event:999", source_type: "orchestrator",
        source_id: "orch-e", source_identity: "alice", source_event_id: "ev-e",
        observation_revision: 1, attempt: null, fact_subtype: "test_result",
        content_hash: sha256("scenario-e-payload"), sensitivity: "clean",
        collected_at: new Date().toISOString(), expires_at: null, derived_from: null,
      },
    };

    // 1. .tmp 半成品文件 → ingest 不处理。
    mkdirSync(env.spoolDir, { recursive: true, mode: 0o700 });
    const tmpFile = join(env.spoolDir, "active-context-collector.7.ndjson.tmp");
    writeFileSync(tmpFile, `${JSON.stringify(envelope)}`); // 故意未写完（无换行、可能截断）
    const s0 = ingestContextSpool(cdb, env.spoolDir);
    expect(s0.read).toBe(0);
    const afterTmp = (cdb.query("SELECT COUNT(*) n FROM control_context_objects").get() as { n: number }).n;
    expect(afterTmp).toBe(0);

    // 2. rename .tmp → .ndjson（写入完整一行）→ 摄入一次。
    writeFileSync(tmpFile, `${JSON.stringify(envelope)}\n`);
    const finalFile = join(env.spoolDir, "active-context-collector.7.ndjson");
    renameSync(tmpFile, finalFile);
    const s1 = ingestContextSpool(cdb, env.spoolDir);
    expect(s1.read).toBe(1);
    expect(s1.created).toBe(1);
    const afterFirst = (cdb.query("SELECT COUNT(*) n FROM control_context_objects").get() as { n: number }).n;
    expect(afterFirst).toBe(1);

    // 3. 再次 ingest → 文件已 .processed，无新增，对象数不变（幂等）。
    const s2 = ingestContextSpool(cdb, env.spoolDir);
    expect(s2.read).toBe(0);
    const afterSecond = (cdb.query("SELECT COUNT(*) n FROM control_context_objects").get() as { n: number }).n;
    expect(afterSecond).toBe(1);

    cdb.close();
  });
});
