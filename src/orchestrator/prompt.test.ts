import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, openStore, transition } from "./store";
import { openAnswersDb } from "./approval";
import { coordinatorChildPrompt } from "./coordinator";
import { loadRunnerInstructions, taskRunnerPrompt } from "./prompt";
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

test("runner_instructions from config reach the brief, under the evidence gate", () => {
  const { root, db, answers } = fixture();
  try {
    const config = join(root, "config.json");
    writeFileSync(config, JSON.stringify({ web_port: 4870, runner_instructions: ["run `bun test` before you commit", "never edit files under vendor/"] }));
    const task = addTask(db, "do it", root, "a".repeat(40));
    const prompt = taskRunnerPrompt(answers, task, loadRunnerInstructions(config));
    expect(prompt).toContain("- run `bun test` before you commit");
    expect(prompt).toContain("- never edit files under vendor/");
    expect(prompt.indexOf("do not push")).toBeLessThan(prompt.indexOf("run `bun test`"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("runner_instructions accepts a bare string and is absent when unset", () => {
  const { root, db, answers } = fixture();
  try {
    const withOne = join(root, "one.json"), without = join(root, "none.json");
    writeFileSync(withOne, JSON.stringify({ runner_instructions: "  keep diffs minimal  " }));
    writeFileSync(without, JSON.stringify({ web_port: 4870 }));
    const task = addTask(db, "do it", root, "a".repeat(40));
    expect(taskRunnerPrompt(answers, task, loadRunnerInstructions(withOne))).toContain("- keep diffs minimal");
    const bare = taskRunnerPrompt(answers, task, loadRunnerInstructions(without));
    expect(bare).not.toContain("Project standing rules");
    expect(loadRunnerInstructions(join(root, "missing.json"))).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a malformed or oversized runner_instructions never breaks or floods a brief", () => {
  const { root } = fixture();
  try {
    const bad = join(root, "bad.json"), mixed = join(root, "mixed.json"), huge = join(root, "huge.json"), broken = join(root, "broken.json");
    writeFileSync(bad, JSON.stringify({ runner_instructions: { rule: "no" } }));
    writeFileSync(mixed, JSON.stringify({ runner_instructions: ["keep it", 7, "", "   ", null, "and this"] }));
    writeFileSync(huge, JSON.stringify({ runner_instructions: Array.from({ length: 40 }, (_, index) => `rule ${index}`) }));
    writeFileSync(broken, "{not json");
    expect(loadRunnerInstructions(bad)).toEqual([]);
    expect(loadRunnerInstructions(mixed)).toEqual(["keep it", "and this"]);
    expect(loadRunnerInstructions(huge).length).toBe(20);
    expect(loadRunnerInstructions(broken)).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
