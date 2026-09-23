import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { addTask, getTask, type Task } from "./store";
import { SpoolWriter } from "./spool";
import { AnomalyMonitor, repairAnomalyIntents } from "./anomaly-monitor";
import {
  getAnomalyBudget,
  getCheckResults,
  getSignalSamples,
  insertCheckResults,
  insertSignalSample,
} from "./anomaly-store";
import { DEFAULT_THRESHOLDS, type AnomalyResult } from "./anomaly";
import { openMailbox, writeHumanAnswer } from "../decision-bot/mailbox";
import { getAttention, getWork } from "../control/store";
import { Orchestrator } from "./orchestrator";
import type { CommandExecutor } from "./worktree";

const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
const BASE_REF = "a".repeat(40);
const WORK_ID = "work-1";

type Harness = {
  root: string;
  db: Database;
  spool: SpoolWriter;
  monitor: AnomalyMonitor;
  worktree: string;
  answersPath: string;
  cleanup: () => void;
};

function newOrchestratorDb(): Database {
  const db = new Database(":memory:");
  db.exec(schema);
  db.run("INSERT OR IGNORE INTO spool_seq(id,seq,segment) VALUES(1,0,0)");
  return db;
}

function seedWork(answersPath: string): void {
  const answers = openMailbox(answersPath);
  answers.run(
    "INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    [WORK_ID, "w", "test", null, "active", 1, JSON.stringify({
      objective: "fix things",
      acceptance: [{ id: "a1", kind: "check", description: "tests pass" }],
      non_goals: [],
      scope: { repo: "/repo" },
      budget: {},
      stop_conditions: [],
      decision_owner: "alice",
    }), 1, 1],
  );
  answers.close();
}

function makeTask(db: Database, over: Partial<Record<string, unknown>> = {}): Task {
  const t = addTask(db, "t", "/repo", BASE_REF, 1);
  db.run(
    "UPDATE tasks SET state='running', work_id=?, worktree=?, attempt_id=?, contract_revision=1, runner_pid=?, runner_boot_id=? WHERE task_id=?",
    [over.work_id ?? WORK_ID, over.worktree ?? "/wt", over.attempt_id ?? "att-1", over.runner_pid ?? null, over.runner_boot_id ?? null, t.task_id],
  );
  return getTask(db, t.task_id)!;
}

function makeHarness(exec: CommandExecutor, monitorCtor?: (db: Database, spool: SpoolWriter, ledger: string) => AnomalyMonitor): Harness {
  const root = mkdtempSync(join(tmpdir(), "anom-mon-"));
  writeFileSync(join(root, "host"), "local\n");
  const db = newOrchestratorDb();
  const spool = new SpoolWriter(db, root);
  const answersPath = join(root, "answers.db");
  process.env.OVERLOAD_ANSWERS_PATH = answersPath;
  seedWork(answersPath);
  const ledger = join(root, "ledger.db");
  const monitor = monitorCtor
    ? monitorCtor(db, spool, ledger)
    : new AnomalyMonitor(db, spool, ledger, exec, join(root, "worktrees"), join(root, "artifacts"));
  return {
    root,
    db,
    spool,
    monitor,
    worktree: join(root, "wt"),
    answersPath,
    cleanup: () => {
      spool.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function seedFixLoop(db: Database, taskId: string, attemptId: string, rounds = 5): void {
  for (let i = 0; i < rounds; i++) {
    const v = i + 1;
    insertSignalSample(db, taskId, attemptId, i * 60000, i + 1, 5, 1, v, WORK_ID);
    insertCheckResults(db, v, taskId, attemptId, i * 60000, [
      { check_id: "ci", status: "fail", fingerprint: "fp-same", check_def_version: "v1" },
    ], WORK_ID);
  }
}

function seedWeak(db: Database, taskId: string, attemptId: string, rounds = 3): void {
  for (let i = 0; i < rounds; i++) {
    const v = i + 1;
    insertSignalSample(db, taskId, attemptId, i * 60000, i + 1, 5, 1, v, WORK_ID);
  }
}

// §9 helper: write a runner log whose error lines normalize to the same fingerprint `repeats` times.
function writeWeakErrorLog(root: string, taskId: string, attemptId: string, repeats: number): void {
  const dir = join(root, "artifacts", taskId);
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < repeats; i++) {
    lines.push(`[2024-01-01T00:00:0${i}:00Z] ERROR: build failed TypeError cannot read property of undefined at /tmp/foo.ts:10:2`);
  }
  writeFileSync(join(dir, `runner-${attemptId}.log`), lines.join("\n") + "\n");
}

function seedWeakWindow(db: Database, taskId: string, attemptId: string, at: number, v: number): void {
  insertSignalSample(db, taskId, attemptId, at, v, 5, 1, v, WORK_ID);
}

function seedDivergence(db: Database, taskId: string, attemptId: string): void {
  // 窗1/窗2 churn=10（median=10），窗3 churn=100（>=3*median），全程 ci fail 无进展。
  const rows = [
    { at: 0, churn: 10, added: 8, deleted: 2 },
    { at: 60000, churn: 10, added: 8, deleted: 2 },
    { at: 120000, churn: 100, added: 80, deleted: 20 },
  ];
  rows.forEach((r, i) => {
    const v = i + 1;
    insertSignalSample(db, taskId, attemptId, r.at, i + 1, r.added, r.deleted, v, WORK_ID);
    insertCheckResults(db, v, taskId, attemptId, r.at, [
      { check_id: "ci", status: "fail", fingerprint: "fp-x", check_def_version: "v1" },
    ], WORK_ID);
  });
}

afterEach(() => {
  delete process.env.OVERLOAD_ANSWERS_PATH;
});

describe("anomaly-monitor sampleTask", () => {
  test("writes git churn + structured check results", async () => {
    const root = mkdtempSync(join(tmpdir(), "anom-samp-"));
    writeFileSync(join(root, "host"), "local\n");
    const db = newOrchestratorDb();
    const spool = new SpoolWriter(db, root);
    const worktree = join(root, "wt");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "orchestrator.check"), "exit 0", { flag: "w" });
    const answersPath = join(root, "answers.db");
    process.env.OVERLOAD_ANSWERS_PATH = answersPath;
    seedWork(answersPath);
    const checkPath = join(worktree, "orchestrator.check");
    const exec: CommandExecutor = async (cmd, args) => {
      if (cmd === "git" && args.includes("rev-list")) return { ok: true, stdout: "3\n", stderr: "" };
      if (cmd === "git" && args.includes("--numstat")) return { ok: true, stdout: "10\t2\ta.ts\n-\t0\tbin\n", stderr: "" };
      if (cmd === checkPath) return { ok: true, stdout: JSON.stringify([{ id: "ci", status: "fail", fingerprint: "fp1", check_def_version: "v1" }]), stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const monitor = new AnomalyMonitor(db, spool, join(root, "ledger.db"), exec, join(root, "wt"), join(root, "artifacts"));
    const task = makeTask(db, { worktree });
    await monitor.sampleTask(task, 1000);
    const samples = getSignalSamples(db, WORK_ID);
    expect(samples).toHaveLength(1);
    expect(samples[0].commit_count).toBe(3);
    expect(samples[0].diff_added).toBe(10);
    expect(samples[0].diff_deleted).toBe(2);
    expect(samples[0].result_set_version).toBe(1);
    const checks = getCheckResults(db, 1);
    expect(checks).toHaveLength(1);
    expect(checks[0].check_id).toBe("ci");
    expect(checks[0].fingerprint).toBe("fp1");
    spool.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("throttles within signal_sample_window_ms", async () => {
    const calls: string[] = [];
    const exec: CommandExecutor = async (cmd) => {
      calls.push(cmd);
      return { ok: true, stdout: "0\n", stderr: "" };
    };
    const h = makeHarness(exec);
    const task = makeTask(h.db, { worktree: h.worktree });
    await h.monitor.sampleTask(task, 1000);
    await h.monitor.sampleTask(task, 1000 + 30000);
    expect(getSignalSamples(h.db, WORK_ID)).toHaveLength(1);
    await h.monitor.sampleTask(task, 1000 + 60000);
    expect(getSignalSamples(h.db, WORK_ID)).toHaveLength(2);
    h.cleanup();
  });
});

describe("anomaly-monitor evaluateAndFence", () => {
  test("fix_loop_exhausted fences with stop_unconfirmed (unavailable runner) and updates budget", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db); // runner_pid=null → requestRunnerStop unavailable
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    const after = getTask(h.db, task.task_id)!;
    // §6.1：无法确认停止（无 pid）即视为 stop_unconfirmed，卡片进 Now。
    expect(after.stop_state).toBe("stop_unconfirmed");
    expect(after.stop_reason).toBe("fix_loop_exhausted");
    expect(after.stop_deadline_at).toBeGreaterThan(1000);
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_triggered'").get(task.task_id);
    expect(ev).toBeTruthy();
    const budget = getAnomalyBudget(h.db, WORK_ID)!;
    expect(budget.fingerprint).toBe("fp-same");
    expect(budget.fix_rounds_consumed).toBe(5);
    expect(budget.trigger_count).toBe(1);
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    expect(card!.urgency).toBe("now");
    h.cleanup();
  });

  test("divergence_detected triggers on high churn + flat invariant", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedDivergence(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBe("stop_unconfirmed");
    expect(after.stop_reason).toBe("divergence_detected");
    h.cleanup();
  });

  test("weak signal projects Inbox card only after error-fp heuristic repeats 3 windows; no fence", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    // runner log: same normalized error fingerprint repeats 3x
    writeWeakErrorLog(h.root, task.task_id, task.attempt_id!, 3);
    const itemId = `anomaly:${WORK_ID}:weak:divergence`;
    // window 1: streak=1 -> no card
    seedWeakWindow(h.db, task.task_id, task.attempt_id!, 0, 1);
    await h.monitor.evaluateAndFence(task, 1000);
    let answers = openMailbox(h.answersPath);
    expect(getAttention(answers, itemId)).toBeNull();
    answers.close();
    // window 2: streak=2 -> no card
    seedWeakWindow(h.db, task.task_id, task.attempt_id!, 60000, 2);
    await h.monitor.evaluateAndFence(task, 2000);
    answers = openMailbox(h.answersPath);
    expect(getAttention(answers, itemId)).toBeNull();
    answers.close();
    // window 3: streak=3 -> card projected
    seedWeakWindow(h.db, task.task_id, task.attempt_id!, 120000, 3);
    await h.monitor.evaluateAndFence(task, 3000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBeNull();
    answers = openMailbox(h.answersPath);
    const item = getAttention(answers, itemId);
    answers.close();
    expect(item).not.toBeNull();
    expect(item!.urgency).toBe("inbox");
    expect(item!.conclusion).toContain("无机器可验结论");
    expect(item!.options).toEqual(["stop"]);
    h.cleanup();
  });

  test("weak signal: error fingerprint below 3 repeats does not project a card", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    // only 2 repeated error lines -> heuristic never fires
    writeWeakErrorLog(h.root, task.task_id, task.attempt_id!, 2);
    for (let i = 0; i < 3; i++) {
      seedWeakWindow(h.db, task.task_id, task.attempt_id!, i * 60000, i + 1);
      await h.monitor.evaluateAndFence(task, 1000 + i * 60000);
    }
    const answers = openMailbox(h.answersPath);
    const item = getAttention(answers, `anomaly:${WORK_ID}:weak:divergence`);
    answers.close();
    expect(item).toBeNull();
    expect(getTask(h.db, task.task_id)!.stop_state).toBeNull();
    h.cleanup();
  });

  test("card dedup: second trigger updates same attention row", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    await h.monitor.evaluateAndFence(getTask(h.db, task.task_id)!, 2000);
    const answers = openMailbox(h.answersPath);
    const count = answers.query("SELECT COUNT(*) AS n FROM control_attention WHERE work_id=? AND item_id LIKE 'anomaly:%'").get(WORK_ID) as { n: number };
    expect(count.n).toBe(1);
    const item = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    expect(item!.revision).toBe(2);
    h.cleanup();
  });
});

describe("anomaly-monitor consumeDecisions", () => {
  const fakeResult: AnomalyResult = {
    kind: "fix_loop_exhausted",
    confidence: "machine",
    fingerprint: "fp-same",
    snapshot: {
      sampled_windows: 5,
      commit_count: 5,
      churn_rate: 1,
      checks_passed: 0,
      checks_failed: 1,
      passed_delta_last_windows: 0,
      fix_rounds_same_fingerprint: 5,
      first_seen_at: 0,
      triggered_at: 1000,
    },
    blocked_invariant: null,
  };

  function setupFenced(h: Harness, stopState: string): Task {
    const task = makeTask(h.db);
    h.db.run("UPDATE tasks SET stop_state=?, stop_requested_at=?, updated_at=? WHERE task_id=?", [stopState, 1000, 1000, task.task_id]);
    h.monitor.projectCard(getTask(h.db, task.task_id)!, fakeResult, stopState, 1000);
    return getTask(h.db, task.task_id)!;
  }

  function answer(h: Harness, itemId: string, answer: string, at: number): void {
    const answers = openMailbox(h.answersPath);
    writeHumanAnswer(answers, "orchestrator", itemId, answer, "ui", at);
    answers.close();
  }

  test("clean_restart accepted when stopped_confirmed: rotates attempt, clears stop, keeps budget", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    // seed a budget row that must survive
    h.db.run("INSERT INTO work_anomaly_budget(work_id,budget_version,fix_rounds_consumed,updated_at) VALUES(?,1,5,1)", [WORK_ID]);
    const task = setupFenced(h, "stopped_confirmed");
    const beforeAttempt = task.attempt_id!;
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "clean_restart", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.state).toBe("starting");
    expect(after.stop_state).toBeNull();
    expect(after.attempt_id).not.toBe(beforeAttempt);
    expect(getAnomalyBudget(h.db, WORK_ID)).not.toBeNull();
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_clean_restart'").get(task.task_id);
    expect(ev).toBeTruthy();
    h.cleanup();
  });

  test("clean_restart rejected when stop_unconfirmed", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = setupFenced(h, "stop_unconfirmed");
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "clean_restart", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBe("stop_unconfirmed");
    expect(after.state).toBe("running");
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_decision_rejected'").get(task.task_id);
    expect(ev).toBeTruthy();
    h.cleanup();
  });

  test("continue_with_budget sets continuation windows and clears stop_state", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = setupFenced(h, "stopped_confirmed");
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "continue_with_budget", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBeNull();
    const budget = getAnomalyBudget(h.db, WORK_ID)!;
    expect(budget.continuation_windows_remaining).toBe(DEFAULT_THRESHOLDS.continue_budget_windows);
    h.cleanup();
  });

  test("stop transitions task to abandoned", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = setupFenced(h, "stopped_confirmed");
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "stop", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.state).toBe("abandoned");
    h.cleanup();
  });

  test("stop_unconfirmed timeout: exited → stopped_confirmed; alive → creates confirm_stopped approval", async () => {
    // (a) no pid → treat as exited
    {
      const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
      const task = setupFenced(h, "stop_unconfirmed");
      h.db.run("UPDATE tasks SET stop_deadline_at=? WHERE task_id=?", [1000, task.task_id]);
      await h.monitor.consumeDecisions(2000);
      const after = getTask(h.db, task.task_id)!;
      expect(after.stop_state).toBe("stopped_confirmed");
      h.cleanup();
    }
    // (b) live pid (test process) → 不无限顺延，而是生成唯一 human_only confirm_stopped 占用处理决定
    {
      const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
      const task = makeTask(h.db, { runner_pid: process.pid, runner_boot_id: "boot-x" });
      h.db.run("UPDATE tasks SET stop_state='stop_unconfirmed', stop_deadline_at=? WHERE task_id=?", [1000, task.task_id]);
      h.monitor.projectCard(task, fakeResult, "stop_unconfirmed", 1000);
      await h.monitor.consumeDecisions(2000);
      const after = getTask(h.db, task.task_id)!;
      expect(after.stop_state).toBe("stop_unconfirmed");
      const appr = h.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='confirm_stopped' AND consumed_at IS NULL").get(task.task_id) as { approval_id: string } | undefined;
      expect(appr).toBeTruthy();
      // 再跑一次 tick：requestApproval 去重，不重复创建
      await h.monitor.consumeDecisions(3000);
      const count = h.db.query("SELECT COUNT(*) AS n FROM approvals WHERE task_id=? AND gate='confirm_stopped'").get(task.task_id) as { n: number };
      expect(count.n).toBe(1);
      h.cleanup();
    }
  });
});


describe("anomaly-monitor regression fixes", () => {
  const fakeResult: AnomalyResult = {
    kind: "fix_loop_exhausted",
    confidence: "machine",
    fingerprint: "fp-same",
    snapshot: {
      sampled_windows: 5,
      commit_count: 5,
      churn_rate: 1,
      checks_passed: 0,
      checks_failed: 1,
      passed_delta_last_windows: 0,
      fix_rounds_same_fingerprint: 5,
      first_seen_at: 0,
      triggered_at: 1000,
    },
    blocked_invariant: null,
  };

  function setupFenced(h: Harness, stopState: string): Task {
    const task = makeTask(h.db);
    h.db.run("UPDATE tasks SET stop_state=?, stop_requested_at=?, updated_at=? WHERE task_id=?", [stopState, 1000, 1000, task.task_id]);
    h.monitor.projectCard(getTask(h.db, task.task_id)!, fakeResult, stopState, 1000);
    return getTask(h.db, task.task_id)!;
  }

  function answer(h: Harness, itemId: string, answer: string, at: number): void {
    const answers = openMailbox(h.answersPath);
    writeHumanAnswer(answers, "orchestrator", itemId, answer, "ui", at);
    answers.close();
  }

  test("fix1: clean_restart runs git reset --hard base_ref and git clean -fdx", async () => {
    const calls: { cmd: string; args: string[] }[] = [];
    const h = makeHarness(async (cmd, args) => {
      calls.push({ cmd, args });
      return { ok: true, stdout: "", stderr: "" };
    });
    const task = setupFenced(h, "stopped_confirmed");
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "clean_restart", 2000);
    await h.monitor.consumeDecisions(2000);
    const resetCall = calls.find((c) => c.cmd === "git" && c.args.includes("reset"));
    expect(resetCall).toBeTruthy();
    expect(resetCall!.args).toEqual(["-C", task.worktree, "reset", "--hard", BASE_REF]);
    const cleanCall = calls.find((c) => c.cmd === "git" && c.args.includes("clean"));
    expect(cleanCall).toBeTruthy();
    expect(cleanCall!.args).toEqual(["-C", task.worktree, "clean", "-fdx"]);
    h.cleanup();
  });

  test("fix6: clean_restart does not consume retry_budget", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    h.db.run("UPDATE tasks SET retry_budget=2");
    const task = setupFenced(h, "stopped_confirmed");
    const before = getTask(h.db, task.task_id)!.retry_budget;
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "clean_restart", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.retry_budget).toBe(before);
    expect(after.retry_budget).toBe(2);
    // task_recovery cleared for the fresh attempt
    const rec = h.db.query("SELECT 1 FROM task_recovery WHERE task_id=?").get(task.task_id);
    expect(rec).toBeNull();
    h.cleanup();
  });

  test("fix1: worktree reset failure logs anomaly_clean_restart_warn but does not block rotation", async () => {
    const h = makeHarness(async () => ({ ok: false, stdout: "", stderr: "boom" }));
    const task = setupFenced(h, "stopped_confirmed");
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "clean_restart", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.state).toBe("starting");
    expect(after.stop_state).toBeNull();
    const warn = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_clean_restart_warn'").get(task.task_id);
    expect(warn).toBeTruthy();
    h.cleanup();
  });

  test("fix2: continuation exhausted does not fence and preserves budget fingerprint", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db); // running, no stop_state
    h.db.run(
      "INSERT INTO work_anomaly_budget(work_id,budget_version,fingerprint,fix_rounds_consumed,continuation_windows_remaining,updated_at) VALUES(?,1,?,?,?,1)",
      [WORK_ID, "fp-old", 3, 1],
    );
    // weak sample (no checks) → kind=null
    insertSignalSample(h.db, task.task_id, task.attempt_id!, 0, 1, 5, 1, 1, WORK_ID);
    // prime lastSampleAt so justSampled(now=1000) is true
    await h.monitor.sampleTask(task, 1000);
    await h.monitor.evaluateAndFence(task, 1000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBeNull();
    const budget = getAnomalyBudget(h.db, WORK_ID)!;
    expect(budget.fingerprint).toBe("fp-old");
    expect(budget.fix_rounds_consumed).toBe(3);
    expect(budget.continuation_windows_remaining).toBe(0);
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_continuation_expired'").get(task.task_id);
    expect(ev).toBeTruthy();
    const triggered = h.db.query("SELECT 1 FROM task_events WHERE task_id=? AND event='anomaly_triggered'").get(task.task_id);
    expect(triggered).toBeNull();
    h.cleanup();
  });

  test("fix4/fix5: card evidence has budget_consumed object and resume_state", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    expect(card).not.toBeNull();
    const bc = card!.evidence.budget_consumed as Record<string, unknown>;
    expect(typeof bc).toBe("object");
    expect(Array.isArray(bc)).toBe(false);
    expect(bc.fix_rounds).toBe(5);
    expect(bc.trigger_count).toBe(1);
    expect(typeof bc.duration_ms).toBe("number");
    expect(card!.evidence.resume_state).toBe("stopped");
    h.cleanup();
  });

  test("fix5: continue_with_budget creates contract revision and supersedes the card", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = setupFenced(h, "stopped_confirmed");
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "continue_with_budget", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBeNull();
    // §3：契约版本 +1，任务随新版本续跑
    expect(after.contract_revision).toBe(2);
    const answers = openMailbox(h.answersPath);
    const work = getWork(answers, WORK_ID);
    const card = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    expect(work!.revision).toBe(2);
    // reviseContract 自动 supersede 进行中的 anomaly 卡
    expect(card!.state).toBe("superseded");
    h.cleanup();
  });
});

describe("anomaly-monitor gap fixes", () => {
  const fakeResult: AnomalyResult = {
    kind: "fix_loop_exhausted",
    confidence: "machine",
    fingerprint: "fp-same",
    snapshot: {
      sampled_windows: 5,
      commit_count: 5,
      churn_rate: 1,
      checks_passed: 0,
      checks_failed: 1,
      passed_delta_last_windows: 0,
      fix_rounds_same_fingerprint: 5,
      first_seen_at: 0,
      triggered_at: 1000,
    },
    blocked_invariant: null,
  };

  function answer(h: Harness, itemId: string, answer: string, at: number): void {
    const answers = openMailbox(h.answersPath);
    writeHumanAnswer(answers, "orchestrator", itemId, answer, "ui", at);
    answers.close();
  }

  test("gap1: fence writes anomaly_card_intents row in the same transaction", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    const row = h.db.query("SELECT * FROM anomaly_card_intents WHERE item_id=?").get(`anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`) as { item_id: string; repaired_at: number | null; stop_state: string };
    expect(row).toBeTruthy();
    expect(row!.repaired_at).not.toBeNull();
    expect(["stop_requested", "stopped_confirmed", "stop_unconfirmed"]).toContain(row!.stop_state);
    h.cleanup();
  });

  test("gap1: repairAnomalyIntents is idempotent — two calls do not duplicate cards", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    const answers = openMailbox(h.answersPath);
    repairAnomalyIntents(h.db, answers, 2000);
    repairAnomalyIntents(h.db, answers, 2000);
    const count = answers.query("SELECT COUNT(*) AS n FROM control_attention WHERE work_id=? AND item_id LIKE 'anomaly:%'").get(WORK_ID) as { n: number };
    expect(count.n).toBe(1);
    answers.close();
    h.cleanup();
  });

  test("gap2: narrow_or_redirect keeps the card open and task fenced", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    h.db.run("UPDATE tasks SET stop_state='stop_unconfirmed', stop_requested_at=?, updated_at=? WHERE task_id=?", [1000, 1000, task.task_id]);
    h.monitor.projectCard(getTask(h.db, task.task_id)!, fakeResult, "stop_unconfirmed", 1000);
    answer(h, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`, "narrow_or_redirect", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBe("stop_unconfirmed");
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    expect(card!.state).toBe("open");
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_narrow_or_redirect'").get(task.task_id);
    expect(ev).toBeTruthy();
    h.cleanup();
  });

  test("gap3: confirm-stopped is rejected when runner is still alive", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db, { runner_pid: process.pid, runner_boot_id: "boot-x" });
    h.db.run("UPDATE tasks SET stop_state='stop_unconfirmed', stop_deadline_at=? WHERE task_id=?", [1000, task.task_id]);
    h.monitor.projectCard(task, fakeResult, "stop_unconfirmed", 1000);
    await h.monitor.consumeDecisions(2000);
    const appr = h.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='confirm_stopped' AND consumed_at IS NULL").get(task.task_id) as { approval_id: string };
    expect(appr).toBeTruthy();
    answer(h, appr.approval_id, "confirm-stopped", 3000);
    await h.monitor.consumeDecisions(3000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBe("stop_unconfirmed");
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_confirm_rejected'").get(task.task_id);
    expect(ev).toBeTruthy();
    h.cleanup();
  });

  test("gap3: keep-held refreshes the stop deadline", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db, { runner_pid: process.pid, runner_boot_id: "boot-x" });
    h.db.run("UPDATE tasks SET stop_state='stop_unconfirmed', stop_deadline_at=? WHERE task_id=?", [1000, task.task_id]);
    h.monitor.projectCard(task, fakeResult, "stop_unconfirmed", 1000);
    await h.monitor.consumeDecisions(2000);
    const appr = h.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='confirm_stopped' AND consumed_at IS NULL").get(task.task_id) as { approval_id: string };
    answer(h, appr.approval_id, "keep-held", 3000);
    await h.monitor.consumeDecisions(3000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBe("stop_unconfirmed");
    expect(after.stop_deadline_at).toBeGreaterThan(3000);
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_keep_held'").get(task.task_id);
    expect(ev).toBeTruthy();
    h.cleanup();
  });

  test("gap4: weak card stop option is consumable and abandons the task", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    writeWeakErrorLog(h.root, task.task_id, task.attempt_id!, 3);
    const itemId = `anomaly:${WORK_ID}:weak:divergence`;
    for (let i = 0; i < 3; i++) {
      seedWeakWindow(h.db, task.task_id, task.attempt_id!, i * 60000, i + 1);
      await h.monitor.evaluateAndFence(task, 1000 + i * 60000);
    }
    const answers0 = openMailbox(h.answersPath);
    const card0 = getAttention(answers0, itemId);
    answers0.close();
    expect(card0).not.toBeNull();
    expect(card0!.options).toEqual(["stop"]);
    answer(h, itemId, "stop", 2000);
    await h.monitor.consumeDecisions(2000);
    const after = getTask(h.db, task.task_id)!;
    expect(after.state).toBe("abandoned");
    h.cleanup();
  });

  test("gap5: threshold_version present in event detail and card evidence", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    const ev = h.db.query("SELECT detail FROM task_events WHERE task_id=? AND event='anomaly_triggered'").get(task.task_id) as { detail: string };
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev.detail).threshold_version).toMatch(/^thr_[0-9a-f]{12}$/);
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    expect(card!.evidence.threshold_version).toMatch(/^thr_[0-9a-f]{12}$/);
    h.cleanup();
  });

  test("gap6: churn_total is sum of added+deleted across samples, not commit_count", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!, 5);
    await h.monitor.evaluateAndFence(task, 1000);
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    const bc = card!.evidence.budget_consumed as { churn_total: number };
    // 5 窗 × (added 5 + deleted 1) = 30；commit_count 每窗 i+1 累计 = 15，必须不等于它
    expect(bc.churn_total).toBe(30);
    h.cleanup();
  });
});

describe("anomaly-monitor §7 auto-resolve", () => {
  const fakeResult: AnomalyResult = {
    kind: "fix_loop_exhausted",
    confidence: "machine",
    fingerprint: "fp-same",
    snapshot: {
      sampled_windows: 5, commit_count: 5, churn_rate: 1, checks_passed: 0, checks_failed: 1,
      passed_delta_last_windows: 0, fix_rounds_same_fingerprint: 5, first_seen_at: 0, triggered_at: 1000,
    },
    blocked_invariant: null,
  };

  test("fail→pass with zero remaining failures auto-resolves the open machine card and clears stop_state", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    // open a machine card while stopped_confirmed
    h.db.run("UPDATE tasks SET stop_state='stopped_confirmed', stop_requested_at=?, updated_at=? WHERE task_id=?", [1000, 1000, task.task_id]);
    h.monitor.projectCard(getTask(h.db, task.task_id)!, fakeResult, "stopped_confirmed", 1000);
    const itemId = `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`;
    // seed recovery: v1 ci fail, v2 ci pass
    insertSignalSample(h.db, task.task_id, task.attempt_id!, 0, 1, 5, 1, 1, WORK_ID);
    insertCheckResults(h.db, 1, task.task_id, task.attempt_id!, 0, [
      { check_id: "ci", status: "fail", fingerprint: "fp-same", check_def_version: "v1" },
    ], WORK_ID);
    insertSignalSample(h.db, task.task_id, task.attempt_id!, 60000, 1, 0, 0, 2, WORK_ID);
    insertCheckResults(h.db, 2, task.task_id, task.attempt_id!, 60000, [
      { check_id: "ci", status: "pass", fingerprint: null, check_def_version: "v1" },
    ], WORK_ID);
    await h.monitor.evaluateAndFence(getTask(h.db, task.task_id)!, 2000);
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, itemId);
    answers.close();
    expect(card!.state).toBe("resolved");
    expect(card!.effect_state).toBe("succeeded");
    const after = getTask(h.db, task.task_id)!;
    expect(after.stop_state).toBeNull();
    const ev = h.db.query("SELECT event FROM task_events WHERE task_id=? AND event='anomaly_resolved'").get(task.task_id);
    expect(ev).toBeTruthy();
    h.cleanup();
  });

  test("auto-resolve leaves weak cards open for human judgment", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    // project a weak card manually
    const weakResult: AnomalyResult = { ...fakeResult, kind: null, confidence: "weak", fingerprint: null };
    h.monitor.projectCard(getTask(h.db, task.task_id)!, weakResult, "inbox", 1000);
    const weakItem = `anomaly:${WORK_ID}:weak:divergence`;
    // seed recovery samples (machine-readable checks now passing)
    insertSignalSample(h.db, task.task_id, task.attempt_id!, 0, 1, 5, 1, 1, WORK_ID);
    insertCheckResults(h.db, 1, task.task_id, task.attempt_id!, 0, [
      { check_id: "ci", status: "fail", fingerprint: "fp-x", check_def_version: "v1" },
    ], WORK_ID);
    insertSignalSample(h.db, task.task_id, task.attempt_id!, 60000, 1, 0, 0, 2, WORK_ID);
    insertCheckResults(h.db, 2, task.task_id, task.attempt_id!, 60000, [
      { check_id: "ci", status: "pass", fingerprint: null, check_def_version: "v1" },
    ], WORK_ID);
    await h.monitor.evaluateAndFence(getTask(h.db, task.task_id)!, 2000);
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, weakItem);
    answers.close();
    expect(card!.state).toBe("open"); // weak card not auto-resolved
    h.cleanup();
  });
});

describe("anomaly-monitor §9 weak probes: probeNoGrowth / probeRepeatedTool", () => {
  // Flat window: commit_count stays at 1, churn stays at 5+1=6 → probeNoGrowth true.
  function seedFlatWindow(db: Database, taskId: string, attemptId: string, at: number, v: number): void {
    insertSignalSample(db, taskId, attemptId, at, 1, 5, 1, v, WORK_ID);
  }
  // Growth window: commit_count climbs each window → probeNoGrowth false.
  function seedGrowthWindow(db: Database, taskId: string, attemptId: string, at: number, v: number): void {
    insertSignalSample(db, taskId, attemptId, at, v, 5, 1, v, WORK_ID);
  }
  // Growth-diff window: commit flat but churn jumps (80+20=100 vs 6) → probeNoGrowth false.
  function seedDiffJumpWindow(db: Database, taskId: string, attemptId: string, at: number, v: number): void {
    insertSignalSample(db, taskId, attemptId, at, 1, 80, 20, v, WORK_ID);
  }
  // Seed a minimal ledger DB with sessions + journal and repeated tool_activity rows.
  function seedLedgerToolActivity(ledgerPath: string, taskId: string, attemptId: string, tools: { tool?: string; change?: boolean }[]): void {
    const db = new Database(ledgerPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, origin TEXT DEFAULT 'unknown', cwd TEXT, branch TEXT, created_at INTEGER, first_seen_at INTEGER);
      CREATE TABLE IF NOT EXISTS journal(ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, emitter_id TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL, stable_id TEXT NOT NULL, writer_id TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT, spool_ref TEXT);
    `);
    const origin = `orch:task:${taskId}:${attemptId}`;
    db.run("INSERT OR REPLACE INTO sessions(stable_id, origin, created_at) VALUES(?,?,?)", ["sess-rep", origin, 1]);
    tools.forEach((t, i) => {
      db.run(
        "INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind,detail) VALUES(?,?,?,?,?,?,?,?)",
        ["h", "e", i, i * 1000, "sess-rep", "w", "tool_activity", JSON.stringify(t)],
      );
    });
    db.close();
  }

  test("probeNoGrowth: fires a weak Inbox card only after 3 consecutive flat windows", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    const itemId = `anomaly:${WORK_ID}:weak:divergence`;
    const card = () => {
      const answers = openMailbox(h.answersPath);
      const it = getAttention(answers, itemId);
      answers.close();
      return it;
    };
    // w1,w2: <3 samples → probeNoGrowth false, streak 0.
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 0, 1);
    await h.monitor.evaluateAndFence(task, 1000);
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 60000, 2);
    await h.monitor.evaluateAndFence(task, 2000);
    expect(card()).toBeNull();
    // w3: last3 flat → streak 1, not enough.
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 120000, 3);
    await h.monitor.evaluateAndFence(task, 3000);
    expect(card()).toBeNull();
    // w4: streak 2, still not enough.
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 180000, 4);
    await h.monitor.evaluateAndFence(task, 4000);
    expect(card()).toBeNull();
    // w5: streak 3 → weak Inbox card projected, no fence.
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 240000, 5);
    await h.monitor.evaluateAndFence(task, 5000);
    expect(getTask(h.db, task.task_id)!.stop_state).toBeNull();
    const item = card();
    expect(item).not.toBeNull();
    expect(item!.urgency).toBe("inbox");
    expect(item!.options).toEqual(["stop"]);
    h.cleanup();
  });

  test("probeNoGrowth: growing commit_count across windows never projects a card", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    const itemId = `anomaly:${WORK_ID}:weak:divergence`;
    for (let i = 0; i < 5; i++) {
      seedGrowthWindow(h.db, task.task_id, task.attempt_id!, i * 60000, i + 1);
      await h.monitor.evaluateAndFence(task, 1000 + i * 60000);
    }
    const answers = openMailbox(h.answersPath);
    expect(getAttention(answers, itemId)).toBeNull();
    answers.close();
    expect(getTask(h.db, task.task_id)!.stop_state).toBeNull();
    h.cleanup();
  });

  test("probeNoGrowth: streak resets after an interruption, needs 3 fresh hits", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    const itemId = `anomaly:${WORK_ID}:weak:divergence`;
    const card = () => {
      const answers = openMailbox(h.answersPath);
      const it = getAttention(answers, itemId);
      answers.close();
      return it;
    };
    // w1,w2,w3 flat → streak 1 (no card yet).
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 0, 1);
    await h.monitor.evaluateAndFence(task, 1000);
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 60000, 2);
    await h.monitor.evaluateAndFence(task, 2000);
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 120000, 3);
    await h.monitor.evaluateAndFence(task, 3000);
    expect(card()).toBeNull();
    // w4: diff jumps → probeNoGrowth false, streak resets to 0.
    seedDiffJumpWindow(h.db, task.task_id, task.attempt_id!, 180000, 4);
    await h.monitor.evaluateAndFence(task, 4000);
    expect(card()).toBeNull();
    // w5,w6 flat → streak rebuilds to 1,2 (still no card).
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 240000, 5);
    await h.monitor.evaluateAndFence(task, 5000);
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 300000, 6);
    await h.monitor.evaluateAndFence(task, 6000);
    expect(card()).toBeNull();
    // w7 flat → streak 3 → card.
    seedFlatWindow(h.db, task.task_id, task.attempt_id!, 360000, 7);
    await h.monitor.evaluateAndFence(task, 7000);
    const item = card();
    expect(item).not.toBeNull();
    expect(item!.urgency).toBe("inbox");
    h.cleanup();
  });

  test("probeRepeatedTool: fires a weak Inbox card after 3 windows of the same tool in ledger", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    // ledger: 3 consecutive bash tool_activity rows.
    seedLedgerToolActivity(h.root.replace(/\/$/, "") + "/ledger.db", task.task_id, task.attempt_id!, [
      { tool: "bash" },
      { tool: "bash" },
      { tool: "bash" },
    ]);
    const itemId = `anomaly:${WORK_ID}:weak:divergence`;
    const card = () => {
      const answers = openMailbox(h.answersPath);
      const it = getAttention(answers, itemId);
      answers.close();
      return it;
    };
    // Growing windows so probeNoGrowth stays false; no runner log so errorFp false.
    // w1: streak 1; w2: streak 2 → no card.
    seedGrowthWindow(h.db, task.task_id, task.attempt_id!, 0, 1);
    await h.monitor.evaluateAndFence(task, 1000);
    seedGrowthWindow(h.db, task.task_id, task.attempt_id!, 60000, 2);
    await h.monitor.evaluateAndFence(task, 2000);
    expect(card()).toBeNull();
    // w3: streak 3 → card.
    seedGrowthWindow(h.db, task.task_id, task.attempt_id!, 120000, 3);
    await h.monitor.evaluateAndFence(task, 3000);
    expect(getTask(h.db, task.task_id)!.stop_state).toBeNull();
    const item = card();
    expect(item).not.toBeNull();
    expect(item!.urgency).toBe("inbox");
    h.cleanup();
  });

  test("probeRepeatedTool: fewer than 3 repeated tool rows never projects a card", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedLedgerToolActivity(h.root.replace(/\/$/, "") + "/ledger.db", task.task_id, task.attempt_id!, [
      { tool: "bash" },
      { tool: "bash" },
    ]);
    const itemId = `anomaly:${WORK_ID}:weak:divergence`;
    for (let i = 0; i < 4; i++) {
      seedGrowthWindow(h.db, task.task_id, task.attempt_id!, i * 60000, i + 1);
      await h.monitor.evaluateAndFence(task, 1000 + i * 60000);
    }
    const answers = openMailbox(h.answersPath);
    expect(getAttention(answers, itemId)).toBeNull();
    answers.close();
    h.cleanup();
  });

  test("source_link projects a cmux deep link back to the task", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    const answers = openMailbox(h.answersPath);
    const card = getAttention(answers, `anomaly:${WORK_ID}:fix_loop_exhausted:fp-same`);
    answers.close();
    expect(card).not.toBeNull();
    expect(card!.source_link).toBe(`cmux://work/${WORK_ID}/task/${task.task_id}`);
    h.cleanup();
  });
});

describe("anomaly-monitor orchestrator integration", () => {
  test("tick samples a running task with a live pid", async () => {
    const root = mkdtempSync(join(tmpdir(), "anom-int-"));
    writeFileSync(join(root, "host"), "local\n");
    const db = newOrchestratorDb();
    const spool = new SpoolWriter(db, root);
    const worktree = join(root, "wt");
    mkdirSync(worktree, { recursive: true });
    const answersPath = join(root, "answers.db");
    process.env.OVERLOAD_ANSWERS_PATH = answersPath;
    seedWork(answersPath);
    const exec: CommandExecutor = async (cmd, args) => {
      if (cmd === "git" && args.includes("rev-list")) return { ok: true, stdout: "2\n", stderr: "" };
      if (cmd === "git" && args.includes("--numstat")) return { ok: true, stdout: "3\t1\tf.ts\n", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const orch = new Orchestrator(db, spool, 2, join(root, "ledger.db"), exec, undefined, join(root, "worktrees"), join(root, "artifacts"));
    const task = addTask(db, "t", "/repo", BASE_REF, 1);
    db.run(
      "UPDATE tasks SET state='running', work_id=?, worktree=?, attempt_id=?, contract_revision=1, runner_pid=?, runner_boot_id='boot-x', owner_instance=? WHERE task_id=?",
      [WORK_ID, worktree, "att-int", process.pid, orch.owner, task.task_id],
    );
    await orch.tick(1000);
    const samples = getSignalSamples(db, WORK_ID);
    expect(samples.length).toBeGreaterThanOrEqual(1);
    expect(samples[0].commit_count).toBe(2);
    spool.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
});

describe("anomaly-monitor defect-fix regressions", () => {
  function seedStillFailingWindow(db: Database, taskId: string, attemptId: string, at: number, v: number): void {
    insertSignalSample(db, taskId, attemptId, at, v, 5, 1, v, WORK_ID);
    insertCheckResults(db, v, taskId, attemptId, at, [
      { check_id: "ci", status: "fail", fingerprint: "fp-same", check_def_version: "v1" },
    ], WORK_ID);
  }

  test("P0: machine trigger held by continuation budget; consumes one window per sample, fences only after budget exhausted", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    seedFixLoop(h.db, task.task_id, task.attempt_id!);
    h.db.run(
      "INSERT INTO work_anomaly_budget(work_id,budget_version,fingerprint,fix_rounds_consumed,continuation_windows_remaining,updated_at) VALUES(?,1,?,5,?,1)",
      [WORK_ID, "fp-same", DEFAULT_THRESHOLDS.continue_budget_windows],
    );
    seedStillFailingWindow(h.db, task.task_id, task.attempt_id!, 5 * 60000, 6);
    await h.monitor.evaluateAndFence(getTask(h.db, task.task_id)!, 6000);
    expect(getTask(h.db, task.task_id)!.stop_state).toBeNull();
    expect(getAnomalyBudget(h.db, WORK_ID)!.continuation_windows_remaining).toBe(1);
    await h.monitor.evaluateAndFence(getTask(h.db, task.task_id)!, 6001);
    expect(getAnomalyBudget(h.db, WORK_ID)!.continuation_windows_remaining).toBe(1);
    seedStillFailingWindow(h.db, task.task_id, task.attempt_id!, 6 * 60000, 7);
    await h.monitor.evaluateAndFence(getTask(h.db, task.task_id)!, 7000);
    expect(getTask(h.db, task.task_id)!.stop_state).not.toBeNull();
    expect(getAnomalyBudget(h.db, WORK_ID)!.continuation_windows_remaining).toBe(0);
    h.cleanup();
  });

  test("P1: divergence trigger does not wipe an existing fix_loop budget fingerprint", async () => {
    const h = makeHarness(async () => ({ ok: true, stdout: "", stderr: "" }));
    const task = makeTask(h.db);
    h.db.run(
      "INSERT INTO work_anomaly_budget(work_id,budget_version,fingerprint,fix_rounds_consumed,updated_at) VALUES(?,1,?,5,1)",
      [WORK_ID, "fp-old"],
    );
    seedDivergence(h.db, task.task_id, task.attempt_id!);
    await h.monitor.evaluateAndFence(task, 1000);
    expect(getTask(h.db, task.task_id)!.stop_state).toBe("stop_unconfirmed");
    const budget = getAnomalyBudget(h.db, WORK_ID)!;
    expect(budget.fingerprint).toBe("fp-old");
    h.cleanup();
  });
});
