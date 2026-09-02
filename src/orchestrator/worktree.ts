import { homedir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { getTask, listTasks, type Task } from "./store";

export type CommandExecutor = (cmd: string, args: string[], opts?: { cwd?: string }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

export const defaultCommandExecutor: CommandExecutor = async (cmd, args, opts) => {
  try {
    const proc = Bun.spawn([cmd, ...args], { cwd: opts?.cwd, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, rc] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { ok: rc === 0, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: "", stderr: String((error as Error).message ?? error) };
  }
};

export function worktreesRoot(root = join(homedir(), ".overload", "worktrees")): string { return root; }

/** §3.6: idempotent worktree create/detect. Safe to call twice with identical results. */
export async function ensureWorktree(repo: string, taskId: string, branch: string, baseRef: string, root = worktreesRoot(), exec: CommandExecutor = defaultCommandExecutor): Promise<{ dir: string; created: boolean }> {
  const dir = join(root, taskId);
  const listed = await exec("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  if (listed.ok && porcelainHasWorktree(listed.stdout, dir)) return { dir, created: false };
  const branchExists = await exec("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
  const add = branchExists.ok
    ? await exec("git", ["-C", repo, "worktree", "add", dir, branch])
    : await exec("git", ["-C", repo, "worktree", "add", dir, "-b", branch, baseRef]);
  if (!add.ok) throw new Error(`worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  return { dir, created: true };
}

function porcelainHasWorktree(output: string, dir: string): boolean {
  return output.split("\n\n").some((block) => block.split("\n")[0] === `worktree ${dir}`);
}

export type PidAlive = (pid: number) => boolean;

/** §3.6: only delete clean + terminal + no-live-pid worktrees; dirty ones are only reported (AGENTS.md 原则 6). */
export async function gcWorktree(db: Database, taskId: string, dryRun: boolean, root = worktreesRoot(), exec: CommandExecutor = defaultCommandExecutor, pidAlive: PidAlive = defaultPidAlive): Promise<{ deleted: boolean; reason?: string }> {
  const task = getTask(db, taskId);
  if (!task) return { deleted: false, reason: "task_not_found" };
  if (!isTerminal(task.state)) return { deleted: false, reason: "not_terminal" };
  const dir = task.worktree ?? join(root, taskId);
  if (task.runner_pid != null && pidAlive(task.runner_pid)) return { deleted: false, reason: "live_process" };
  const status = await exec("git", ["-C", dir, "status", "--porcelain"]);
  if (!status.ok) return { deleted: false, reason: "worktree_missing" };
  if (status.stdout.trim().length > 0) return { deleted: false, reason: "dirty" };
  if (dryRun) return { deleted: false, reason: "dry_run" };
  const removed = await exec("git", ["-C", task.repo, "worktree", "remove", dir]);
  if (!removed.ok) return { deleted: false, reason: `remove_failed: ${removed.stderr.trim()}` };
  return { deleted: true };
}

function isTerminal(state: Task["state"]): boolean { return state === "done" || state === "failed" || state === "abandoned"; }

export function defaultPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function gcCandidates(db: Database, dryRun: boolean, root = worktreesRoot(), exec: CommandExecutor = defaultCommandExecutor, pidAlive: PidAlive = defaultPidAlive): Promise<Array<{ task_id: string; deleted: boolean; reason?: string }>> {
  const results: Array<{ task_id: string; deleted: boolean; reason?: string }> = [];
  for (const task of listTasks(db)) {
    if (!isTerminal(task.state)) continue;
    results.push({ task_id: task.task_id, ...(await gcWorktree(db, task.task_id, dryRun, root, exec, pidAlive)) });
  }
  return results;
}
