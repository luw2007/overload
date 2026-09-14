import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getWork } from "../control/store";
import type { Contract } from "../control/types";
import type { Task } from "./store";

const MAX_INSTRUCTIONS = 20;
const MAX_INSTRUCTION_CHARS = 4000;

/**
 * `runner_instructions` in ~/.overload/config.json: standing project rules every runner brief
 * repeats (string or string[]). Bounded on purpose — a pasted document would drown the contract
 * and the evidence gate it is appended to, which are what the run is actually judged on.
 */
export function loadRunnerInstructions(path = process.env.OVERLOAD_CONFIG_PATH ?? join(homedir(), ".overload", "config.json")): string[] {
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8"))?.runner_instructions; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`overload orchestrator: ignoring invalid config ${path}`);
    return [];
  }
  if (raw === undefined || raw === null) return [];
  const candidates = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw : null;
  if (!candidates) { console.error(`overload orchestrator: runner_instructions must be a string or string[], ignoring`); return []; }
  const instructions: string[] = [];
  let budget = MAX_INSTRUCTION_CHARS;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") { console.error("overload orchestrator: ignoring non-string runner_instructions entry"); continue; }
    const text = candidate.trim().replace(/\s*\n\s*/g, " ");
    if (!text) continue;
    if (text.length > budget || instructions.length >= MAX_INSTRUCTIONS) { console.error("overload orchestrator: runner_instructions truncated"); break; }
    budget -= text.length;
    instructions.push(text);
  }
  return instructions;
}

/**
 * The brief a plain (non-coordinator) runner receives. Without it a child only ever saw
 * `task.title`, so it could not know the contract it is judged against, the effects it may
 * not perform, or the evidence gate that decides whether a human is asked at all
 * (src/orchestrator/evidence.ts: commits present, worktree clean, executable
 * orchestrator.check exiting 0).
 */
export function taskRunnerPrompt(controlDb: Database, task: Task, instructions = loadRunnerInstructions()): string {
  const work = task.work_id ? getWork(controlDb, task.work_id) : null;
  // A stale binding must not silently promote another revision's contract into the brief.
  const contract: Contract | null = work && (task.contract_revision === null || work.revision === task.contract_revision) ? work.contract : null;
  const lines = [
    "You are an Overload runner working alone in a dedicated git worktree.",
    `Request: ${task.title}`,
  ];
  if (contract) {
    lines.push(
      `Work objective: ${contract.objective}`,
      `Acceptance: ${JSON.stringify(contract.acceptance.map(criterion => `${criterion.id} (${criterion.kind}): ${criterion.description}`))}`,
    );
    if (contract.non_goals.length) lines.push(`Non-goals: ${JSON.stringify(contract.non_goals)}`);
    if (contract.scope.allowed_effects?.length) lines.push(`Approved effects: ${JSON.stringify(contract.scope.allowed_effects)}`);
    if (contract.scope.human_only_effects?.length) lines.push(`Effects reserved for the operator: ${JSON.stringify(contract.scope.human_only_effects)}`);
    if (contract.budget.deadline_at) lines.push(`Budget deadline: ${new Date(contract.budget.deadline_at).toISOString()}`);
  } else if (task.work_id) {
    lines.push("No readable contract is bound to this task; stay strictly inside the request above and report what is missing.");
  }
  lines.push(
    `Worktree branch ${task.branch ?? "(pending)"} is based on ${task.base_ref} of ${task.repo}. Work only inside the worktree.`,
    "Your run is judged on evidence, not on your summary. Before you stop:",
    "- commit every change you made (`git add -A` then `git commit`), leaving `git status --porcelain` empty;",
    `- provide an executable \`orchestrator.check\` at the worktree root that verifies ${contract ? "the acceptance above" : "the request above"} and exits non-zero when it does not hold;`,
    "- do not push, open a PR, or merge: the operator decides that after reviewing your evidence.",
    "Missing commits, a dirty worktree, or a missing/failing check are reported as failed evidence, not as work in progress.",
  );
  if (instructions.length) {
    // Appended after the gate, and explicitly subordinate to it: operator config must not be a
    // back door for a child to talk itself out of committing, or into pushing.
    lines.push("Project standing rules (they never override the contract or the evidence gate above):");
    for (const instruction of instructions) lines.push(`- ${instruction}`);
  }
  if (task.retry_budget >= 0 && task.attempt_id) lines.push(`Retries left after this attempt: ${task.retry_budget}.`);
  if (task.blocked_reason) lines.push(`The previous attempt was blocked as ${task.blocked_reason}; fix that cause instead of repeating it.`);
  return lines.join("\n");
}
