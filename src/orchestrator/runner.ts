import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Task } from "./store";

export type RunnerExecutor = (command: string, args: string[]) => Promise<{ ok: boolean; error?: string }>;

/** Same shape/behavior as src/shared/resume.ts's defaultResumeExecutor. */
export const defaultRunnerExecutor: RunnerExecutor = async (command, args) => {
  try {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    const rc = await proc.exited;
    return rc === 0 ? { ok: true } : { ok: false, error: (await stderr).trim().split("\n", 1)[0] || "launch_failed" };
  } catch {
    return { ok: false, error: "cmux_unavailable" };
  }
};

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export function taskOrigin(taskId: string, attemptId: string): string { return `orch:task:${taskId}:${attemptId}`; }

export function artifactsDir(taskId: string, root = join(homedir(), ".overload", "artifacts")): string { return join(root, taskId); }

/**
 * §3.7 spawn. Chosen invocation shape: `pi -p @<prompt-file>` — `--print, -p` is pi's
 * documented non-interactive mode (process prompt and exit, verified via `pi --help`,
 * R1), and `@<file>` is pi's documented file-content-as-message syntax, so the prompt
 * never has to be shell-embedded inline (fragile per the task brief). The prompt file
 * is written to the artifacts dir, not the worktree, so it never shows up in
 * `git status --porcelain` (the worktree's cleanliness gate, plan §3.6/§3.8).
 */
export async function spawnRunner(task: Task, worktreeDir: string, attemptId: string, promptText: string, executor: RunnerExecutor = defaultRunnerExecutor, artifactsRoot = join(homedir(), ".overload", "artifacts")): Promise<{ ok: boolean; error?: string }> {
  const dir = artifactsDir(task.task_id, artifactsRoot);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const promptFile = join(dir, `prompt-${attemptId}.txt`);
  writeFileSync(promptFile, promptText, { mode: 0o600 });
  const origin = taskOrigin(task.task_id, attemptId);
  const command = `OVERLOAD_PARENT=${shellQuote(origin)} OVERLOAD_ORCH_TASK=${shellQuote(task.task_id)} pi -p ${shellQuote(`@${promptFile}`)}`;
  return executor("cmux", ["new-workspace", "--cwd", worktreeDir, "--command", command, "--focus", "false"]);
}

type SessionRow = { stable_id: string };
type IncarnationRow = { pid: number | null; proc_boot_id: string | null };

/**
 * §3.7 会话绑定 / §4.2 boundary: opens ledger.db `{readonly:true}` exactly like
 * src/web/server.ts:61, reads only sessions/session_incarnations, never writes.
 */
export function bindRunnerSession(ledgerPath: string, task: Task, attemptId: string): { stable_id: string; pid: number | null; boot_id: string | null } | null {
  let db: Database;
  try { db = new Database(ledgerPath, { readonly: true }); } catch { return null; }
  try {
    const origin = taskOrigin(task.task_id, attemptId);
    const session = db.query("SELECT stable_id FROM sessions WHERE origin=? ORDER BY created_at DESC LIMIT 1").get(origin) as SessionRow | null;
    if (!session) return null;
    const incarnation = db.query(`SELECT pid, proc_boot_id FROM session_incarnations WHERE stable_id=? AND liveness_domain='process'
      ORDER BY last_seen_at DESC LIMIT 1`).get(session.stable_id) as IncarnationRow | null;
    return { stable_id: session.stable_id, pid: incarnation?.pid ?? null, boot_id: incarnation?.proc_boot_id ?? null };
  } finally { db.close(); }
}
