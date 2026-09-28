import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureControlSchema, createWork } from "../control/store";
import { ensureContextReducerSchema } from "../control/context-reducer";
import type { Contract } from "../control/types";
import { determineRecoveryOutcome, type RecoveryOutcome } from "./recovery-context";

const orchSchema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");

function controlFixture(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  return db;
}

function orchFixture(): Database {
  const db = new Database(":memory:");
  db.exec(orchSchema);
  return db;
}

function makeContract(owner = "alice"): Contract {
  return {
    objective: "refactor parseConfig",
    acceptance: [{ id: "a1", kind: "human", description: "done" }],
    non_goals: ["no public API change"],
    scope: { repo: "/tmp/repo" },
    budget: { retry_limit: 3 },
    stop_conditions: [{ id: "s1", kind: "hard", description: "tests fail" }],
    decision_owner: owner,
  };
}

function insertTask(
  db: Database,
  overrides: Record<string, unknown> = {},
): string {
  const taskId = (overrides.task_id as string) ?? "task-1";
  const now = Date.now();
  db.run(
    `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      taskId,
      overrides.title ?? "test task",
      overrides.repo ?? "/tmp/repo",
      overrides.base_ref ?? "a".repeat(40),
      overrides.state ?? "failed",
      overrides.worktree ?? "/tmp/worktrees/task-1",
      overrides.branch ?? "overload/task-1",
      overrides.attempt_id ?? "attempt-1",
      overrides.runner_pid ?? null,
      overrides.runner_boot_id ?? null,
      overrides.retry_budget ?? 2,
      overrides.stable_id ?? null,
      overrides.pr_url ?? null,
      overrides.blocked_reason ?? null,
      overrides.terminal_reason ?? null,
      overrides.work_id ?? null,
      overrides.contract_revision ?? null,
      overrides.ci_observation_failures ?? 0,
      now,
      now,
    ],
  );
  return taskId;
}

function insertEvent(
  db: Database,
  taskId: string,
  event: string,
  detail: Record<string, unknown> | null = null,
  at = Date.now(),
  fromState: string | null = null,
  toState: string = "failed",
): void {
  db.run(
    "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
    [taskId, at, fromState, toState, event, detail ? JSON.stringify(detail) : null],
  );
}

function insertApproval(db: Database, taskId: string, consumed = false): void {
  const now = Date.now();
  db.run(
    "INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
    ["approval-1", taskId, "ready", "Approve?", JSON.stringify(["approve", "reject"]), now, now + 86400000, consumed ? now : null, null],
  );
}

function insertRecovery(db: Database, taskId: string, attemptId: string, unknownTicks = 0): void {
  db.run(
    "INSERT INTO task_recovery(task_id,attempt_id,spawn_state,spawn_at,unknown_ticks) VALUES(?,?,?,?,?)",
    [taskId, attemptId, "spawned", Date.now(), unknownTicks],
  );
}

function expectBlocked(result: RecoveryOutcome, code: string) {
  expect(result.type).toBe("blocked");
  if (result.type === "blocked") expect(result.code).toBe(code);
}

describe("T7 recovery-context", () => {
  test("1. three conditions met (terminated + checkpoint + pi runtime) → recovery_package", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "failed",
      work_id: work.work_id,
      contract_revision: 1,
      stable_id: "stable-abc",
    });
    insertEvent(odb, taskId, "spawn_ok", { worktree: "/tmp/wt", branch: "br" }, 1000, "starting", "running");
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-abc", runner_pid: 1234, runner_boot_id: "boot-1" }, 2000, "running", "running");
    insertEvent(odb, taskId, "runner_exit", { evidence_complete: true }, 3000, "running", "awaiting_human");
    insertEvent(odb, taskId, "checkpoint", { checkpoint_reference: "git:/tmp/repo@abcdef123456" }, 2500, "running", "running");

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expect(result.type).toBe("recovery_package");
    if (result.type === "recovery_package") {
      expect(result.package.checkpoint_reference).toBe("git:/tmp/repo@abcdef123456");
      expect(result.package.session_reference).toBe("stable-abc");
    }
    cdb.close(); odb.close();
  });

  test("2. live + blocked_on_ask → jump, no recovery package", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "running",
      runner_pid: 9999,
      stable_id: "stable-live",
      work_id: work.work_id,
      contract_revision: 1,
    });
    insertEvent(odb, taskId, "spawn_ok", {}, 1000, "starting", "running");
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-live", runner_pid: 9999 }, 2000, "running", "running");
    insertApproval(odb, taskId, false); // unconsumed approval

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expect(result.type).toBe("jump");
    if (result.type === "jump") {
      expect(result.jump_target).toContain("stable-live");
    }
    cdb.close(); odb.close();
  });

  test("3. liveness unknown → reconcile, no spawn", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const taskId = insertTask(odb, { state: "blocked" });
    // No runner_dead, no runner_exit, no pid, no stable_id → unknown

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: "work-1",
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expect(result.type).toBe("reconcile");
    if (result.type === "reconcile") {
      expect(result.reason).toContain("liveness unknown");
    }
    cdb.close(); odb.close();
  });

  test("4. terminated but no checkpoint → blocked(no_checkpoint)", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "done",
      work_id: work.work_id,
      contract_revision: 1,
      stable_id: "stable-xyz",
    });
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-xyz" }, 2000, "running", "running");
    insertEvent(odb, taskId, "runner_exit", { evidence_complete: true }, 3000, "running", "awaiting_human");
    // No checkpoint event

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expectBlocked(result, "no_checkpoint");
    cdb.close(); odb.close();
  });

  test("5. terminated + checkpoint but runtime unsupported → blocked(runner_unsupported)", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "failed",
      work_id: work.work_id,
      contract_revision: 1,
    });
    // Has checkpoint but NO session_bound event → not pi
    insertEvent(odb, taskId, "checkpoint", { checkpoint_reference: "git:/repo@abcdef1" }, 2500, "running", "running");
    insertEvent(odb, taskId, "runner_dead", {}, 3000, "running", "starting");

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expectBlocked(result, "runner_unsupported");
    cdb.close(); odb.close();
  });

  test("6. entry reverify fails (contract version changed) → blocked(stale_or_revoked)", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    // Task has contract_revision=1 but we'll bump work revision to 2
    const taskId = insertTask(odb, {
      state: "failed",
      work_id: work.work_id,
      contract_revision: 1,
      stable_id: "stable-rev",
    });
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-rev" }, 2000, "running", "running");
    insertEvent(odb, taskId, "checkpoint", { checkpoint_reference: "git:/repo@abcdef12345" }, 2500, "running", "running");
    insertEvent(odb, taskId, "runner_exit", { evidence_complete: true }, 3000, "running", "awaiting_human");

    // Bump work revision to 2 (simulate contract revision)
    cdb.run("UPDATE control_works SET revision=2 WHERE work_id=?", [work.work_id]);

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expectBlocked(result, "stale_or_revoked");
    cdb.close(); odb.close();
  });

  test("7. recovery_budget correctly aggregated", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "failed",
      work_id: work.work_id,
      contract_revision: 1,
      stable_id: "stable-budget",
      retry_budget: 1,
    });
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-budget" }, 2000, "running", "running");
    insertEvent(odb, taskId, "checkpoint", { checkpoint_reference: "git:/repo@abcdef12345" }, 2500, "running", "running");
    insertEvent(odb, taskId, "runner_dead", {}, 3000, "running", "starting");
    insertRecovery(odb, taskId, "attempt-1", 5);

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expect(result.type).toBe("recovery_package");
    if (result.type === "recovery_package") {
      expect(result.package.recovery_budget.retry_budget_remaining).toBe(1);
      expect(result.package.recovery_budget.unknown_ticks).toBe(5);
      expect(result.package.recovery_budget.attempts).toBe(1); // one runner_dead
    }
    cdb.close(); odb.close();
  });

  test("8. recommended_action: budget exhausted → escalate_to_human", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "failed",
      work_id: work.work_id,
      contract_revision: 1,
      stable_id: "stable-escalate",
      retry_budget: 0, // exhausted
    });
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-escalate" }, 2000, "running", "running");
    insertEvent(odb, taskId, "checkpoint", { checkpoint_reference: "git:/repo@abcdef12345" }, 2500, "running", "running");
    insertEvent(odb, taskId, "runner_exit", { evidence_complete: true }, 3000, "running", "awaiting_human");

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expect(result.type).toBe("recovery_package");
    if (result.type === "recovery_package") {
      expect(result.package.recommended_action).toBe("escalate_to_human");
    }
    cdb.close(); odb.close();
  });

  test("9. confirmed_effects / incomplete_steps / unknown_items correctly classified", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "awaiting_human",
      work_id: work.work_id,
      contract_revision: 1,
      stable_id: "stable-class",
      pr_url: "https://github.com/org/repo/pull/42",
    });
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-class" }, 2000, "running", "running");
    insertEvent(odb, taskId, "checkpoint", { checkpoint_reference: "git:/repo@abcdef12345" }, 2500, "running", "running");
    insertEvent(odb, taskId, "push_pr_ok", { pr_url: "https://github.com/org/repo/pull/42" }, 2800, "submitted", "submitted");
    insertEvent(odb, taskId, "runner_exit", { evidence_complete: true }, 3000, "running", "awaiting_human");

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    expect(result.type).toBe("recovery_package");
    if (result.type === "recovery_package") {
      // confirmed_effects should include push_pr_ok and runner_exit(evidence_complete)
      expect(result.package.confirmed_effects.length).toBeGreaterThanOrEqual(1);
      // incomplete_steps should include human approval pending
      expect(result.package.incomplete_steps.length).toBeGreaterThanOrEqual(1);
      // unknown_items should be empty (no failures)
      expect(result.package.unknown_items.length).toBe(0);
    }
    cdb.close(); odb.close();
  });

  test("10. terminated failure outcome does not auto-archive (returns recovery_package or blocked, not archive)", () => {
    const cdb = controlFixture();
    const odb = orchFixture();
    const work = createWork(cdb, { title: "w", source: "test", contract: makeContract("alice") }, 1);
    const taskId = insertTask(odb, {
      state: "failed", // failure outcome, not success
      work_id: work.work_id,
      contract_revision: 1,
      stable_id: "stable-fail",
      retry_budget: 2,
    });
    insertEvent(odb, taskId, "session_bound", { stable_id: "stable-fail" }, 2000, "running", "running");
    insertEvent(odb, taskId, "checkpoint", { checkpoint_reference: "git:/repo@abcdef12345" }, 2500, "running", "running");
    insertEvent(odb, taskId, "runner_dead", {}, 3000, "running", "starting");

    const result = determineRecoveryOutcome({
      controlDb: cdb,
      orchestratorDb: odb,
      work_id: work.work_id,
      task_id: taskId,
      attempt_id: "attempt-1",
      actor: "alice",
    });

    // Should return recovery_package (not archive) — failure/unknown outcomes require human or recovery
    expect(result.type).toBe("recovery_package");
    if (result.type === "recovery_package") {
      // The package is produced but NOT auto-archived; outcome remains for human/recovery
      expect(result.package.checkpoint_reference).toBeTruthy();
    }
    cdb.close(); odb.close();
  });
});

// ========== 2d: orchestrator.attemptRecovery 入口集成测试 ==========

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openStore, addTask } from "./store";
import { SpoolWriter } from "./spool";
import { Orchestrator } from "./orchestrator";
import { openAnswersDb } from "./approval";

function orchRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "t7-entry-"));
  writeFileSync(join(root, "host"), "local\n");
  return root;
}

function setupControlFile(owner: string): { path: string; workId: string } {
  const path = join(tmpdir(), `t7-control-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = openAnswersDb(path);
  ensureControlSchema(db);
  ensureContextReducerSchema(db);
  const work = createWork(db, { title: "w", source: "test", contract: makeContract(owner) }, 1);
  db.close();
  return { path, workId: work.work_id };
}

describe("T7 orchestrator.attemptRecovery 入口", () => {
  test("entry-1: terminated + checkpoint + session_bound → recovery_package_ready event", () => {
    const { path: cPath, workId } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    const workRow = odb.query("SELECT 1 FROM tasks LIMIT 1").get(); // noop to ensure db ready
    void workRow;
    // Insert task directly as terminated with work_id
    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry1", "t", "/tmp/repo", "a".repeat(40), "failed", "/wt", "br", "attempt-1", null, null, 2, "stable-e1", null, null, "runner_dead", workId, 1, 0, 1, 1]
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry1", 2000, "running", "running", "session_bound", JSON.stringify({ stable_id: "stable-e1", runner_pid: 1234 })]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry1", 2500, "running", "running", "checkpoint", JSON.stringify({ checkpoint_reference: "git:/repo@abc123" })]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry1", 3000, "running", "starting", "runner_dead", null]);

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try {
      orch.attemptRecovery("task-entry1");
    } finally {
      if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH;
      else process.env.OVERLOAD_ANSWERS_PATH = oldEnv;
    }

    const ev = odb.query(
      "SELECT event, detail FROM task_events WHERE task_id=? AND event='recovery_package_ready'").get("task-entry1") as { event: string; detail: string } | undefined;
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev!.detail).checkpoint_reference).toBe("git:/repo@abc123");

    // Idempotent: second call does not duplicate
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry1"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }
    const count = odb.query(
      "SELECT COUNT(*) n FROM task_events WHERE task_id=? AND event='recovery_package_ready'").get("task-entry1") as { n: number };
    expect(count.n).toBe(1);

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });

  test("entry-2: live + pending approval → recovery_jump, no recovery_package", () => {
    const { path: cPath, workId: workId2 } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry2", "t", "/tmp/repo", "a".repeat(40), "running", "/wt", "br", "attempt-1", 9999, "boot1", 2, "stable-e2", null, null, null, workId2, 1, 0, 1, 1]
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry2", 2000, "running", "running", "session_bound", JSON.stringify({ stable_id: "stable-e2", runner_pid: 9999 })]);
    odb.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
      ["appr-2", "task-entry2", "ready", "?", JSON.stringify(["approve"]), 1, 2, null, null]);

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry2"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    const jump = odb.query(
      "SELECT event, detail FROM task_events WHERE task_id=? AND event='recovery_jump'").get("task-entry2") as { detail: string } | undefined;
    expect(jump).toBeTruthy();
    expect(JSON.parse(jump!.detail).jump_target).toContain("stable-e2");
    const pkg = odb.query(
      "SELECT 1 FROM task_events WHERE task_id=? AND event='recovery_package_ready'").get("task-entry2");
    expect(pkg).toBeFalsy();

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });

  test("entry-3: unknown liveness → recovery_reconcile event", () => {
    const { path: cPath, workId: workId3 } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry3", "t", "/tmp/repo", "a".repeat(40), "blocked", "/wt", "br", "attempt-3", null, null, 2, null, null, "liveness_unknown", null, workId3, 1, 0, 1, 1]
    );
    // No runner_dead, no runner_exit, no pid, no stable_id → unknown

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry3"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    const rec = odb.query(
      "SELECT event, detail FROM task_events WHERE task_id=? AND event='recovery_reconcile'").get("task-entry3") as { detail: string } | undefined;
    expect(rec).toBeTruthy();
    expect(JSON.parse(rec!.detail).reason).toContain("liveness unknown");

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });

  test("entry-4: done normal completion → no recovery noise", () => {
    const { path: cPath, workId: workId4 } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry4", "t", "/tmp/repo", "a".repeat(40), "done", "/wt", "br", "attempt-1", null, null, 2, "stable-e4", null, null, "ci_merged", workId4, 1, 0, 1, 1]
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry4", 2000, "running", "running", "session_bound", JSON.stringify({ stable_id: "stable-e4" })]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry4", 3000, "running", "awaiting_human", "runner_exit", JSON.stringify({ evidence_complete: true })]);
    // No checkpoint event

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry4"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    // done 正常完成：不产任何 recovery_* 事件。
    const rec = odb.query(
      "SELECT 1 FROM task_events WHERE task_id=? AND event LIKE 'recovery_%'").get("task-entry4");
    expect(rec).toBeFalsy();

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });
  

  test("entry-5: Fix 2: awaiting_human + runner_exit + 未消费 approval → 不 jump（runner 已终止），走 checkpoint 评估", () => {
    const { path: cPath, workId: workId5 } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry5", "t", "/tmp/repo", "a".repeat(40), "awaiting_human", "/wt", "br", "attempt-1", null, null, 2, "stable-e5", null, null, null, workId5, 1, 0, 1, 1]
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry5", 2000, "running", "running", "session_bound", JSON.stringify({ stable_id: "stable-e5" })]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry5", 3000, "running", "awaiting_human", "runner_exit", JSON.stringify({ evidence_complete: true })]);
    odb.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
      ["appr-5", "task-entry5", "ready", "?", JSON.stringify(["approve"]), 1, 2, null, null]);

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry5"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    // Fix 2: runner_exit 已存在 → runner 已终止，即使有未消费 approval 也不 jump。
    const jump = odb.query(
      "SELECT 1 FROM task_events WHERE task_id=? AND event='recovery_jump'").get("task-entry5");
    expect(jump).toBeFalsy();
    // 走 checkpoint 恢复评估路径：无 checkpoint → recovery_blocked(no_checkpoint)。
    const blocked = odb.query(
      "SELECT event, detail FROM task_events WHERE task_id=? AND event='recovery_blocked'").get("task-entry5") as { detail: string } | undefined;
    expect(blocked).toBeTruthy();
    expect(JSON.parse(blocked!.detail).code).toBe("no_checkpoint");

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });

  test("entry-5b: Fix 2: awaiting_human + 无 runner_exit + stable_id + 未消费 approval → recovery_jump（live blocked-on-ask）", () => {
    const { path: cPath, workId: workId5b } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry5b", "t", "/tmp/repo", "a".repeat(40), "awaiting_human", "/wt", "br", "attempt-1", null, null, 2, "stable-live5b", null, null, null, workId5b, 1, 0, 1, 1]
    );
    // 只有 session_bound，无 runner_exit/runner_dead → 进程仍活。
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry5b", 2000, "running", "running", "session_bound", JSON.stringify({ stable_id: "stable-live5b" })]);
    odb.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
      ["appr-5b", "task-entry5b", "ready", "?", JSON.stringify(["approve"]), 1, 2, null, null]);

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry5b"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    const jump = odb.query(
      "SELECT event, detail FROM task_events WHERE task_id=? AND event='recovery_jump'").get("task-entry5b") as { detail: string } | undefined;
    expect(jump).toBeTruthy();
    expect(JSON.parse(jump!.detail).jump_target).toContain("stable-live5b");

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });

  test("entry-6: failed 但无 runner_exit/runner_dead 事件 → 不评估恢复包", () => {
    const { path: cPath, workId: workId6 } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry6", "t", "/tmp/repo", "a".repeat(40), "failed", "/wt", "br", "attempt-1", null, null, 2, null, null, null, "tool_missing", workId6, 1, 0, 1, 1]
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-entry6", 1000, "starting", "blocked", "spawn_fail", JSON.stringify({ reason: "tool_missing" })]);

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry6"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    const rec = odb.query(
      "SELECT 1 FROM task_events WHERE task_id=? AND event LIKE 'recovery_%'").get("task-entry6");
    expect(rec).toBeFalsy();

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });

  test("entry-7: awaiting_human + 无 approval + 无 runner_exit → recovery_reconcile", () => {
    const { path: cPath, workId: workId7 } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-entry7", "t", "/tmp/repo", "a".repeat(40), "awaiting_human", "/wt", "br", "attempt-1", null, null, 2, null, null, null, null, workId7, 1, 0, 1, 1]
    );

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-entry7"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    const rec = odb.query(
      "SELECT event, detail FROM task_events WHERE task_id=? AND event='recovery_reconcile'").get("task-entry7") as { detail: string } | undefined;
    expect(rec).toBeTruthy();

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });
});

describe("Fix 5: recovery 事件写入 collector spool", () => {
  test("F5-package: recovery_package_ready 同时 spool 出 context.recovery_package envelope", () => {
    const { path: cPath, workId } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-f5pkg", "t", "/tmp/repo", "a".repeat(40), "failed", "/wt", "br", "attempt-1", null, null, 2, "stable-f5", null, null, "runner_dead", workId, 1, 0, 1, 1]
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-f5pkg", 2000, "running", "running", "session_bound", JSON.stringify({ stable_id: "stable-f5", runner_pid: 1234 })]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-f5pkg", 2500, "running", "running", "checkpoint", JSON.stringify({ checkpoint_reference: "git:/repo@abc123" })]);
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-f5pkg", 3000, "running", "starting", "runner_dead", null]);

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-f5pkg"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    // task_events 有 recovery_package_ready。
    const ev = odb.query("SELECT 1 FROM task_events WHERE task_id=? AND event='recovery_package_ready'").get("task-f5pkg");
    expect(ev).toBeTruthy();

    // spool 目录有 context.recovery_package envelope。
    const files = readdirSync(spool.dir).filter((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson"));
    expect(files.length).toBeGreaterThanOrEqual(1);
    let found = false;
    for (const f of files) {
      const lines = readFileSync(join(spool.dir, f), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const env = JSON.parse(line);
        if (env.kind === "context.recovery_package") {
          found = true;
          expect(env.detail.work_id).toBe(workId);
          expect(env.detail.task_id).toBe("task-f5pkg");
          expect(env.detail.checkpoint_reference).toBe("git:/repo@abc123");
          expect(env.detail.owner).toBe("alice");
          expect(env.detail.deep_link).toBe(`cmux://work/${workId}/task/task-f5pkg`);
        }
      }
    }
    expect(found).toBe(true);

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });

  test("F5-jump: recovery_jump 同时 spool 出 context.recovery_jump envelope", () => {
    const { path: cPath, workId } = setupControlFile("alice");
    const root = orchRoot();
    const odb = openStore(join(root, "orch.db"));
    const spool = new SpoolWriter(odb, root);
    const orch = new Orchestrator(odb, spool, 1);

    odb.run(
      `INSERT INTO tasks(task_id,title,repo,base_ref,state,worktree,branch,attempt_id,runner_pid,runner_boot_id,retry_budget,stable_id,pr_url,blocked_reason,terminal_reason,work_id,contract_revision,ci_observation_failures,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ["task-f5jump", "t", "/tmp/repo", "a".repeat(40), "running", "/wt", "br", "attempt-1", 9999, "boot1", 2, "stable-f5j", null, null, null, workId, 1, 0, 1, 1]
    );
    odb.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
      ["task-f5jump", 2000, "running", "running", "session_bound", JSON.stringify({ stable_id: "stable-f5j", runner_pid: 9999 })]);
    odb.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at,consumed_at,actor) VALUES(?,?,?,?,?,?,?,?,?)",
      ["appr-f5", "task-f5jump", "ready", "?", JSON.stringify(["approve"]), 1, 2, null, null]);

    const oldEnv = process.env.OVERLOAD_ANSWERS_PATH;
    process.env.OVERLOAD_ANSWERS_PATH = cPath;
    try { orch.attemptRecovery("task-f5jump"); } finally { if (oldEnv === undefined) delete process.env.OVERLOAD_ANSWERS_PATH; else process.env.OVERLOAD_ANSWERS_PATH = oldEnv; }

    const ev = odb.query("SELECT 1 FROM task_events WHERE task_id=? AND event='recovery_jump'").get("task-f5jump");
    expect(ev).toBeTruthy();

    const files = readdirSync(spool.dir).filter((f) => f.startsWith("active-context-collector") && f.endsWith(".ndjson"));
    let found = false;
    for (const f of files) {
      const lines = readFileSync(join(spool.dir, f), "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        const env = JSON.parse(line);
        if (env.kind === "context.recovery_jump") {
          found = true;
          expect(env.detail.task_id).toBe("task-f5jump");
          expect(env.detail.owner).toBe("alice");
          expect(env.detail.jump_target).toContain("stable-f5j");
          expect(env.detail.deep_link).toBe(`cmux://work/${workId}/task/task-f5jump`);
        }
      }
    }
    expect(found).toBe(true);

    spool.close(); odb.close(); rmSync(root, { recursive: true, force: true }); rmSync(cPath, { force: true });
  });
});
