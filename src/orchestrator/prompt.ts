import { Database } from "bun:sqlite";
import { getWork } from "../control/store";
import type { Contract } from "../control/types";
import type { Task } from "./store";

/**
 * The brief a plain (non-coordinator) runner receives. Without it a child only ever saw
 * `task.title`, so it could not know the contract it is judged against, the effects it may
 * not perform, or the evidence gate that decides whether a human is asked at all
 * (src/orchestrator/evidence.ts: commits present, worktree clean, executable
 * orchestrator.check exiting 0).
 */
export function taskRunnerPrompt(controlDb: Database, task: Task): string {
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
  if (task.retry_budget >= 0 && task.attempt_id) lines.push(`Retries left after this attempt: ${task.retry_budget}.`);
  if (task.blocked_reason) lines.push(`The previous attempt was blocked as ${task.blocked_reason}; fix that cause instead of repeating it.`);
  return lines.join("\n");
}
