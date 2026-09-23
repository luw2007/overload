import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, addTask, transition, claim } from "./store";
import {
  openAnswersDb,
  requestApproval,
  repairApprovalIntents,
  updateAttention,
  reconcileApprovalEffects,
  replayAppliedReceipts,
} from "./approval";
import { defaultPidAlive, worktreesRoot } from "./worktree";
import { defaultRunnerExecutor, taskOrigin, artifactsDir } from "./runner";
import { events } from "./store";
import { runCli } from "./cli";
import { SpoolWriter } from "./spool";
import { getTarget } from "../decision-bot/mailbox";
import { createWork, ensureControlSchema } from "../control/store";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "audit-"));
  writeFileSync(join(root, "host"), "local\n");
  const db = openStore(join(root, "o.db"));
  const answers = openAnswersDb(join(root, "a.db"));
  ensureControlSchema(answers);
  const spool = new SpoolWriter(db, root);
  const work = createWork(answers, {
    title: "w",
    source: "test",
    source_id: "src-1",
    contract: {
      objective: "o",
      acceptance: [{ id: "c", kind: "check", description: "d" }],
      non_goals: [],
      scope: { repo: "/repo" },
      budget: {},
      stop_conditions: [],
      decision_owner: "owner",
    },
  });
  const task = addTask(db, "t", "/repo", "a".repeat(40), Date.now(), {
    workId: work.work_id,
    contractRevision: work.revision,
  });
  db.run("UPDATE tasks SET state='running' WHERE task_id=?", task.task_id);
  transition(db, task.task_id, "runner_exit", { evidence_complete: true });
  return { root, db, answers, spool, work, task };
}

test("ORC-01 repairApprovalIntents projects a human_only target and stamps repaired_at", () => {
  const { root, db, answers, spool, task } = setup();
  try {
    const id = requestApproval(db, spool, task.task_id, "confirm_stopped", "Stopped?", ["approve"], 1000, answers);
    const row = db.query("SELECT repaired_at, control_event_id FROM approval_intents WHERE approval_id=?").get(id) as any;
    expect(row.repaired_at).not.toBeNull();
    expect(row.control_event_id).not.toBeNull();
    const target = getTarget(answers, "orchestrator", id);
    expect(target).not.toBeNull();
    expect(target?.decisionMode).toBe("human_only");
    expect(target?.state).toBe("active");
  } finally {
    spool.close(); answers.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("ORC-02 requestApproval throws on unknown task and reuses an unconsumed approval", () => {
  const { root, db, answers, spool, task } = setup();
  try {
    expect(() => requestApproval(db, spool, "does-not-exist", "ready", "q", ["a"], 1, answers)).toThrow("Task not found");
    const first = requestApproval(db, spool, task.task_id, "ready", "q", ["a"], 1000, answers);
    const second = requestApproval(db, spool, task.task_id, "ready", "q", 1000, answers);
    expect(second).toBe(first);
    const count = (db.query("SELECT count(*) n FROM approvals WHERE task_id=?").get(task.task_id) as any).n;
    expect(count).toBe(1);
  } finally {
    spool.close(); answers.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("ORC-03 updateAttention no-ops on matching state and upserts with revision", () => {
  const { root, db, answers, spool, task } = setup();
  try {
    const id = requestApproval(db, spool, task.task_id, "ready", "q", ["a"], 1000, answers);
    const itemId = `orchestrator:${id}`;
    const before = answers.query("SELECT state, effect_state, revision FROM control_attention WHERE item_id=?").get(itemId) as any;
    expect(before.state).toBe("open");
    updateAttention(answers, task, id, "open", "not_started", Date.now());
    const afterNoop = answers.query("SELECT revision FROM control_attention WHERE item_id=?").get(itemId) as any;
    expect(afterNoop.revision).toBe(before.revision);
    updateAttention(answers, task, id, "applying", "applying", Date.now());
    const afterChange = answers.query("SELECT state, effect_state FROM control_attention WHERE item_id=?").get(itemId) as any;
    expect(afterChange).toEqual({ state: "applying", effect_state: "applying" });
  } finally {
    spool.close(); answers.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("ORC-04 reconcileApprovalEffects maps done to resolved/succeeded and blocked to open/failed", () => {
  const { root, db, answers, spool, task } = setup();
  try {
    const id = requestApproval(db, spool, task.task_id, "ready", "q", ["a"], 1000, answers);
    answers.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,answer,actor,consumed_at) VALUES(?,?,?,?,?,?,?)",
      ["r1", "orchestrator", id, "v", "approve", "cli", 1]);
    db.run("INSERT INTO applied_receipts VALUES(?,?,?,?,?)", ["r1", task.task_id, "approve", 1, "transitioned"]);
    db.run("UPDATE approvals SET consumed_at=1 WHERE approval_id=?", id);
    db.run("UPDATE tasks SET state='done' WHERE task_id=?", task.task_id);
    reconcileApprovalEffects(db, answers, 2);
    let att = answers.query("SELECT state, effect_state FROM control_attention WHERE item_id=?").get(`orchestrator:${id}`) as any;
    expect(att).toEqual({ state: "resolved", effect_state: "succeeded" });
    let receipt = answers.query("SELECT outcome FROM decision_receipts WHERE receipt_id='r1'").get() as any;
    expect(receipt.outcome).toBe("succeeded");
    db.run("UPDATE tasks SET state='blocked' WHERE task_id=?", task.task_id);
    reconcileApprovalEffects(db, answers, 3);
    att = answers.query("SELECT state, effect_state FROM control_attention WHERE item_id=?").get(`orchestrator:${id}`) as any;
    expect(att).toEqual({ state: "open", effect_state: "failed" });
  } finally {
    spool.close(); answers.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("ORC-05 replayAppliedReceipts marks a null outcome as unknown", () => {
  const { root, db, answers, spool } = setup();
  try {
    answers.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,answer,actor,consumed_at) VALUES(?,?,?,?,?,?,?)",
      ["r-null", "orchestrator", "a", "v", "approve", "ui", 1]);
    db.run("INSERT INTO applied_receipts VALUES(?,?,?,?,?)", ["r-null", "t", "approve", 1, "transitioned"]);
    replayAppliedReceipts(db, answers, 2);
    const row = answers.query("SELECT outcome FROM decision_receipts WHERE receipt_id='r-null'").get() as any;
    expect(row.outcome).toBe("unknown");
  } finally {
    spool.close(); answers.close(); db.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("ORC-38 defaultPidAlive reports the live process and rejects a non-existent pid", () => {
  expect(defaultPidAlive(process.pid)).toBe(true);
  expect(defaultPidAlive(2147483600)).toBe(false);
});

test("ORC-11 defaultRunnerExecutor returns ok on exit 0 and error on a missing binary", async () => {
  expect(await defaultRunnerExecutor("/bin/echo", ["hi"])).toEqual({ ok: true });
  const bad = await defaultRunnerExecutor("definitely-not-a-real-binary-xyz", []);
  expect(bad.ok).toBe(false);
  expect(bad.error).toBeTruthy();
});

test("ORC-12 taskOrigin composes the expected string", () => {
  expect(taskOrigin("task-1", "attempt-2")).toBe("orch:task:task-1:attempt-2");
});

test("ORC-13 artifactsDir joins root with task id", () => {
  expect(artifactsDir("task-1", "/tmp/root")).toBe("/tmp/root/task-1");
});

test("ORC-27 events returns chronological task_events rows", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-events-"));
  try {
    const db = openStore(join(root, "o.db"));
    const task = addTask(db, "t", "/repo", "a".repeat(40));
    claim(db, "owner");
    transition(db, task.task_id, "worktree_ok");
    transition(db, task.task_id, "runner_exit", { evidence_complete: true });
    const rows = events(db, task.task_id) as any[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].event).toBe("add");
    expect(rows[rows.length - 1].event).toBe("runner_exit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ORC-35 worktreesRoot defaults and respects an override", () => {
  expect(worktreesRoot("/tmp/override")).toBe("/tmp/override");
  expect(worktreesRoot()).toContain(".overload/worktrees");
});

test("ORC-43 runCli answer inserts an answer row and prints confirmation", async () => {
  const root = mkdtempSync(join(tmpdir(), "audit-answer-"));
  try {
    process.env.OVERLOAD_ANSWERS_PATH = join(root, "a.db");
    openAnswersDb(join(root, "a.db")).close();
    const out: string[] = [];
    await runCli(["orch", "answer", "new-approval", "approve"], (s) => out.push(s));
    const parsed = JSON.parse(out[0]!);
    expect(parsed).toMatchObject({ approval_id: "new-approval", answer: "approve", actor: "cli" });
    const reopen = openAnswersDb(join(root, "a.db"));
    const rows = reopen.query("SELECT approval_id, answer, actor FROM answers").all() as any[];
    expect(rows).toEqual([{ approval_id: "new-approval", answer: "approve", actor: "cli" }]);
    reopen.close();
  } finally {
    delete process.env.OVERLOAD_ANSWERS_PATH;
    rmSync(root, { recursive: true, force: true });
  }
});
