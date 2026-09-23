import type { Database } from "bun:sqlite";

export type ResumeCapability =
  | { resumable: true; runtime: "pi" | "omp" }
  | { resumable: false; reason: "process_alive" | "runtime_unsupported" | "missing_session_id" | "missing_cwd" | "remote_host_unsupported" | "orchestrator_owned" };

export type ResumeResult = { resumed: true } | { resumed: false; reason: string };
export type ResumeExecutor = (command: string, args: string[]) => Promise<{ ok: boolean; error?: string }>;
export type ProcessProbe = (pid: number) => boolean;

type ResumeRow = { host: string | null; runtime: string | null; session: string | null; cwd: string | null; pid: number | null; origin: string | null };

const supportedRuntime = (runtime: string | null): runtime is "pi" | "omp" => runtime === "pi" || runtime === "omp";

function resumeRow(db: Database, stableId: string): ResumeRow | null {
  return db.query(`SELECT s.host, s.runtime, s.session, s.cwd, s.origin,
    (SELECT i.pid FROM session_incarnations i WHERE i.stable_id=s.stable_id AND i.liveness_domain='process'
      AND NOT EXISTS (SELECT 1 FROM journal j WHERE j.stable_id=i.stable_id AND j.writer_id=i.writer_id AND j.kind='session_ended')
      ORDER BY i.last_seen_at DESC LIMIT 1) pid
    FROM sessions s WHERE s.stable_id=?`).get(stableId) as ResumeRow | null;
}

export function inspectResume(db: Database, stableId: string, processAlive: ProcessProbe = defaultProcessProbe): ResumeCapability | null {
  const row = resumeRow(db, stableId);
  if (!row) return null;
  if (row.pid && processAlive(row.pid)) return { resumable: false, reason: "process_alive" };
  // Plan §3.10: orchestrator-launched runners must never be resumed through the generic
  // path — a human clicking Resume would start a parallel process against the same worktree.
  if (row.origin?.startsWith("orch:")) return { resumable: false, reason: "orchestrator_owned" };
  if (row.host !== "local") return { resumable: false, reason: "remote_host_unsupported" };
  if (!supportedRuntime(row.runtime)) return { resumable: false, reason: "runtime_unsupported" };
  if (!row.session) return { resumable: false, reason: "missing_session_id" };
  if (!row.cwd) return { resumable: false, reason: "missing_cwd" };
  return { resumable: true, runtime: row.runtime };
}

export async function resumeSession(db: Database, stableId: string, executor: ResumeExecutor = defaultResumeExecutor, processAlive: ProcessProbe = defaultProcessProbe): Promise<ResumeResult | null> {
  const capability = inspectResume(db, stableId, processAlive);
  if (!capability) return null;
  if (!capability.resumable) return { resumed: false, reason: capability.reason };
  const row = resumeRow(db, stableId)!;
  const command = `${capability.runtime} --resume=${shellQuote(row.session!)}`;
  const result = await executor("cmux", ["new-workspace", "--cwd", row.cwd!, "--command", command, "--focus", "true"]);
  return result.ok ? { resumed: true } : { resumed: false, reason: result.error ?? "launch_failed" };
}

function defaultProcessProbe(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const defaultResumeExecutor: ResumeExecutor = async (command, args) => {
  try {
    const proc = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" });
    const stderr = new Response(proc.stderr).text();
    const rc = await proc.exited;
    return rc === 0 ? { ok: true } : { ok: false, error: (await stderr).trim().split("\n", 1)[0] || "launch_failed" };
  } catch {
    return { ok: false, error: "cmux_unavailable" };
  }
};
