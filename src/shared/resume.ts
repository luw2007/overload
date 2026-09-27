import type { Database } from "bun:sqlite";
import { probeCheckpoint, resumeArgv, type Checkpoint, type CheckpointResult } from "./checkpoint";
import { acquireLaunchLease, launchInFlight, type LaunchLeases } from "./launch-lease";

/**
 * Generic resume read model, three-state (Phase B §8.5, §12.4–12.5). `unsupported`: this path can never resume the
 * session. `unknown`: the facts that would make a launch safe are unproven, so the human checks the original session.
 * Only `resumable: true` renders Resume or reaches the executor. Wait recovery reads the same function.
 */
export type ResumeCapability =
  | { resumable: true; runtime: "pi" | "omp" }
  | { resumable: false; state: "unsupported"; reason: "process_alive" | "runtime_unsupported" | "missing_session_id" | "missing_cwd" | "remote_host_unsupported" | "orchestrator_owned" }
  | { resumable: false; state: "unknown"; reason: "liveness_unknown" | "launch_in_flight" | Exclude<Extract<CheckpointResult, { valid: false }>["reason"], "unsupported_runtime"> };

export type ResumeResult = { resumed: true } | { resumed: false; reason: string };
export type ResumeExecutor = (command: string, args: string[]) => Promise<{ ok: boolean; error?: string }>;
export type ProcessProbe = (pid: number) => boolean;
/** Runtime-specific proof that `session` names a checkpoint `runtime` can resume in `cwd` (§8.4.4); a non-empty string is not proof. */
export type CheckpointProbe = (checkpoint: { runtime: "pi" | "omp"; session: string; cwd: string }) => CheckpointResult;
const defaultCheckpointProbe: CheckpointProbe = (input) => probeCheckpoint(input);

type SessionRow = { host: string | null; runtime: string | null; session: string | null; cwd: string | null; origin: string | null };

const supportedRuntime = (runtime: string | null): runtime is "pi" | "omp" => runtime === "pi" || runtime === "omp";

function sessionRow(db: Database, stableId: string): SessionRow | null {
  return db.query("SELECT host, runtime, session, cwd, origin FROM sessions WHERE stable_id=?").get(stableId) as SessionRow | null;
}

/**
 * Conservative three-state liveness (§12.5). `terminated` needs an explicit `session_ended` for every recorded
 * incarnation and no probe-visible pid; no incarnation, a lifecycle-only lease or a dead pid alone never proves termination.
 */
function sessionLiveness(db: Database, stableId: string, processAlive: ProcessProbe): "live" | "terminated" | "unknown" {
  const incarnations = db.query(`SELECT i.liveness_domain domain, i.pid,
      EXISTS (SELECT 1 FROM journal_all j WHERE j.stable_id=i.stable_id AND j.writer_id=i.writer_id AND j.kind='session_ended') ended
    FROM session_incarnations i WHERE i.stable_id=?`).all(stableId) as Array<{ domain: string | null; pid: number | null; ended: number }>;
  const probed = incarnations.map((row) => ({ ended: row.ended === 1, alive: row.domain === "process" && row.pid !== null && processAlive(row.pid) }));
  if (probed.some((row) => !row.ended && row.alive)) return "live";
  return probed.length > 0 && probed.every((row) => row.ended && !row.alive) ? "terminated" : "unknown";
}

type ResumeGate =
  | { capability: Extract<ResumeCapability, { resumable: false }>; checkpoint?: undefined }
  | { capability: Extract<ResumeCapability, { resumable: true }>; checkpoint: Checkpoint };

/**
 * Resumable only when the session is proven terminated, is a local non-orchestrator pi/omp session with a recorded
 * runtime session and cwd, and the runtime checkpoint probe finds exactly one intact session file for that id and cwd.
 * The recorded session may be the extension's random fallback id with no file behind it; that stays `unknown`. With
 * `leases`, a checkpoint whose launch is still in flight (see launch-lease.ts) is `unknown`/`launch_in_flight`.
 */
function resumeGate(db: Database, stableId: string, processAlive: ProcessProbe, probe: CheckpointProbe, leases?: LaunchLeases | null): ResumeGate | null {
  const row = sessionRow(db, stableId);
  if (!row) return null;
  const liveness = sessionLiveness(db, stableId, processAlive);
  const refuse = (capability: Extract<ResumeCapability, { resumable: false }>) => ({ capability });
  if (liveness === "live") return refuse({ resumable: false, state: "unsupported", reason: "process_alive" });
  // Plan §3.10: orchestrator-launched runners must never be resumed through the generic
  // path — a human clicking Resume would start a parallel process against the same worktree.
  if (row.origin?.startsWith("orch:")) return refuse({ resumable: false, state: "unsupported", reason: "orchestrator_owned" });
  if (row.host !== "local") return refuse({ resumable: false, state: "unsupported", reason: "remote_host_unsupported" });
  if (!supportedRuntime(row.runtime)) return refuse({ resumable: false, state: "unsupported", reason: "runtime_unsupported" });
  if (!row.session) return refuse({ resumable: false, state: "unsupported", reason: "missing_session_id" });
  if (!row.cwd) return refuse({ resumable: false, state: "unsupported", reason: "missing_cwd" });
  if (liveness === "unknown") return refuse({ resumable: false, state: "unknown", reason: "liveness_unknown" });
  const probed = probe({ runtime: row.runtime, session: row.session, cwd: row.cwd });
  if (!probed.valid) {
    return refuse(probed.reason === "unsupported_runtime"
      ? { resumable: false, state: "unsupported", reason: "runtime_unsupported" }
      : { resumable: false, state: "unknown", reason: probed.reason });
  }
  if (leases && launchInFlight(db, leases, probed.checkpoint)) return refuse({ resumable: false, state: "unknown", reason: "launch_in_flight" });
  return { capability: { resumable: true, runtime: row.runtime }, checkpoint: probed.checkpoint };
}

export function inspectResume(
  db: Database, stableId: string, processAlive: ProcessProbe = defaultProcessProbe, probe: CheckpointProbe = defaultCheckpointProbe, leases?: LaunchLeases | null,
): ResumeCapability | null {
  return resumeGate(db, stableId, processAlive, probe, leases)?.capability ?? null;
}

/** Launches the probed checkpoint's own argv (both runtimes by the proven file) in a new cmux workspace at the recorded cwd. */
export async function launchCheckpoint(cp: Checkpoint, executor: ResumeExecutor = defaultResumeExecutor, focus = true): Promise<{ ok: boolean; error?: string }> {
  const command = resumeArgv(cp).map(shellQuote).join(" ");
  return executor("cmux", ["new-workspace", "--cwd", cp.cwd, "--command", command, "--focus", String(focus)]);
}

/**
 * Web resume. The executor runs only after this call takes the checkpoint's launch lease, so concurrent clicks, tabs
 * and wait dispatches launch it at most once. The lease is kept whatever the launch outcome: a failed cmux call may
 * still have started the runtime, so a retry waits for `session_started` or the lease TTL.
 */
export async function resumeSession(
  db: Database, stableId: string, leases: LaunchLeases,
  executor: ResumeExecutor = defaultResumeExecutor, processAlive: ProcessProbe = defaultProcessProbe, probe: CheckpointProbe = defaultCheckpointProbe,
): Promise<ResumeResult | null> {
  const gate = resumeGate(db, stableId, processAlive, probe, leases);
  if (!gate) return null;
  if (!gate.checkpoint) return { resumed: false, reason: gate.capability.reason };
  if (!acquireLaunchLease(db, leases, gate.checkpoint, stableId, "web")) return { resumed: false, reason: "launch_in_flight" };
  const result = await launchCheckpoint(gate.checkpoint, executor);
  return result.ok ? { resumed: true } : { resumed: false, reason: result.error ?? "launch_failed" };
}

export function defaultProcessProbe(pid: number): boolean {
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
