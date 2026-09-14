import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, openStore, transition } from "./store";
import { openAnswersDb } from "./approval";
import { coordinatorChildPrompt } from "./coordinator";
import { createWork } from "../control/store";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-prompt-"));
  writeFileSync(join(root, "host"), "local\n");
  return { root, db: openStore(join(root, "o.db")), answers: openAnswersDb(join(root, "a.db")) };
}

test("a plain runner is told the contract it is judged against", () => {
  const { root, db, answers } = fixture();
  try {
    const work = createWork(answers, { title: "w", source: "test", contract: { objective: "greet by name", acceptance: [{ id: "check", kind: "check", description: "greet.sh NAME prints hello NAME" }], non_goals: ["no new dependency"], scope: { repo: root, allowed_effects: ["edit", "commit"], human_only_effects: ["push"] }, budget: {}, stop_conditions: [], decision_owner: "operator" } }, 1);
    const task = addTask(db, "support a name argument", root, "a".repeat(40), 1, { workId: work.work_id, contractRevision: work.revision });
    const prompt = coordinatorChildPrompt(db, answers, task);
    expect(prompt).toContain("support a name argument");
    expect(prompt).toContain("greet by name");
    expect(prompt).toContain("greet.sh NAME prints hello NAME");
    expect(prompt).toContain("no new dependency");
    expect(prompt).toContain("push");
    expect(prompt).toContain("orchestrator.check");
    expect(prompt).toContain("git status --porcelain");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a contract-less runner still gets the evidence gate, never a bare title", () => {
  const { root, db, answers } = fixture();
  try {
    const task = addTask(db, "investigate the flake", root, "a".repeat(40));
    const prompt = coordinatorChildPrompt(db, answers, task);
    expect(prompt).toContain("investigate the flake");
    expect(prompt).toContain("orchestrator.check");
    expect(prompt).toContain("do not push");
    expect(prompt.split("\n").length).toBeGreaterThan(3);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a retried runner is told why the previous attempt failed", () => {
  const { root, db, answers } = fixture();
  try {
    const task = addTask(db, "ship it", root, "a".repeat(40));
    db.run("UPDATE tasks SET state='running' WHERE task_id=?", task.task_id);
    transition(db, task.task_id, "check_absent", {}, 2);
    const prompt = coordinatorChildPrompt(db, answers, { ...task, state: "starting", blocked_reason: "no_check" });
    expect(prompt).toContain("no_check");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a stale contract revision is not passed off as the current contract", () => {
  const { root, db, answers } = fixture();
  try {
    const work = createWork(answers, { title: "w", source: "test", contract: { objective: "superseded objective", acceptance: [{ id: "check", kind: "check", description: "d" }], non_goals: [], scope: { repo: root }, budget: {}, stop_conditions: [], decision_owner: "operator" } }, 1);
    const task = addTask(db, "do it", root, "a".repeat(40), 1, { workId: work.work_id, contractRevision: work.revision + 1 });
    const prompt = coordinatorChildPrompt(db, answers, task);
    expect(prompt).not.toContain("superseded objective");
    expect(prompt).toContain("No readable contract");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
