import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, addTask, transition } from "./store";
import { openAnswersDb, requestApproval, expireApprovals } from "./approval";
import { SpoolWriter } from "./spool";

test("expireApprovals transitions awaiting_human task to blocked and closes target", () => {
  const root = mkdtempSync(join(tmpdir(), "expire-"));
  try {
    writeFileSync(join(root, "host"), "local\n");
    const db = openStore(join(root, "o.db"));
    const answers = openAnswersDb(join(root, "a.db"));
    const spool = new SpoolWriter(db, root);
    const task = addTask(db, "t", root, "a".repeat(40));
    db.run("UPDATE tasks SET state='running' WHERE task_id=?", task.task_id);
    transition(db, task.task_id, "runner_exit", { evidence_complete: true });
    const id = requestApproval(db, spool, task.task_id, "ready", "?", ["approve"], 1, answers);
    expect(db.query("SELECT state FROM tasks WHERE task_id=?").get(task.task_id)).toEqual({ state: "awaiting_human" });
    expireApprovals(db, spool, Date.now() + 10_000, answers);
    expect(db.query("SELECT state FROM tasks WHERE task_id=?").get(task.task_id)).toEqual({ state: "blocked" });
    expect(db.query("SELECT blocked_reason FROM tasks WHERE task_id=?").get(task.task_id)).toEqual({ blocked_reason: "gate_expired" });
    spool.close(); answers.close(); db.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
