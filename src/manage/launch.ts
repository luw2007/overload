import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { ControlError } from "../control/store";
import { setParentHandoff } from "./schema";

export type LaunchResult = { pid?: number; receipt?: string };
export type LaunchExecutor = (request: { handoffId: string; agent: string; cwd: string; host: string; argv: string[]; env: Record<string,string>; idempotencyKey: string }) => Promise<LaunchResult>;
export type LaunchError = Error & { no_effect?: boolean; noEffect?: boolean };

const row = <T>(db: Database, sql: string, ...args: unknown[]) => db.query(sql).get(...args as any[]) as T | null;
const commandFor = (agent: string, cwd: string) => agent === "pi" ? ["pi", "--session-dir", cwd] : agent === "omp" ? ["omp", "--cwd", cwd] : ["claude", "--cwd", cwd];

export const localLaunchExecutor: LaunchExecutor = async request => {
  try {
    const proc = Bun.spawn(request.argv, { cwd: request.cwd, env: { ...process.env, ...request.env }, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    proc.unref();
    return { pid: proc.pid, receipt: `pid:${proc.pid}` };
  } catch (error) {
    if (["ENOENT", "EACCES", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) (error as LaunchError).no_effect = true;
    throw error;
  }
};

export const sshLaunchExecutor: LaunchExecutor = async request => {
  const remote = request.host.replace(/^ssh:/, "");
  const quoted = request.argv.map(v => `'${v.replaceAll("'", `'\\''`)}'`).join(" ");
  const env = `OVERLOAD_PARENT='${request.env.OVERLOAD_PARENT}'`;
  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "--", remote, `cd '${request.cwd.replaceAll("'", `'\\''`)}' && ${env} nohup ${quoted} >/dev/null 2>&1 &`], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) { const error = new Error(await new Response(proc.stderr).text()) as LaunchError; error.no_effect = true; throw error; }
  return { receipt: `ssh:${remote}` };
};

async function isolatedCwd(handoff: any, packet: any) {
  const source = packet.workspace?.cwd;
  if (!packet.isolate || !source) return source;
  const target = join(source, ".overload-worktrees", handoff.handoff_id);
  await mkdir(join(source, ".overload-worktrees"), { recursive: true });
  const proc = Bun.spawn(["git", "worktree", "add", "--detach", target], { cwd: source, stdout: "pipe", stderr: "pipe" });
  if (await proc.exited !== 0) { const error = new Error(await new Response(proc.stderr).text()) as LaunchError; error.no_effect = true; throw error; }
  return target;
}

function unknownAttention(db: Database, handoff: any, now: number) {
  const id = `mgmt:handoff:${handoff.handoff_id}:unknown`, options = JSON.stringify(["jump", "attach", "abandon"]);
  db.query(`INSERT INTO control_attention(item_id,work_id,revision,state,effect_state,urgency,conclusion,trigger,impact,recommendation,options,owner,contract_revision,decision_mode,evidence,created_at,updated_at)
    VALUES (?,?,1,'open','unknown','now','交接启动结果未知','handoff_launch_unknown','不得自动重试','检查并绑定或放弃',?,? ,0,'human_only',?, ?,?)
    ON CONFLICT(item_id) DO UPDATE SET updated_at=excluded.updated_at`).run(id, handoff.work_id, options, "decision_owner", JSON.stringify({ handoff_id: handoff.handoff_id }), now, now);
}

export async function launchHandoff(db: Database, handoffId: string, opts: { confirmed?: boolean; executor?: LaunchExecutor; timeoutMs?: number } = {}) {
  if (opts.confirmed !== true) throw new ControlError("invalid", "launch confirmation required");
  const handoff = row<any>(db, "SELECT * FROM mgmt_handoffs WHERE handoff_id=?", handoffId);
  if (!handoff) throw new ControlError("not_found", "handoff not found");
  if (handoff.state === "launch_unknown") throw new ControlError("conflict", "launch outcome unknown");
  if (handoff.state !== "ready_to_launch") throw new ControlError("conflict", "handoff is not ready");
  const attemptNo = (row<any>(db, "SELECT COALESCE(MAX(attempt_no),0)+1 n FROM mgmt_handoff_launch_attempts WHERE handoff_id=?", handoffId)?.n ?? 1);
  const now = Date.now(), key = `${handoffId}:${attemptNo}`;
  const packet = JSON.parse(handoff.packet || "{}");
  const initialCwd = packet.workspace?.cwd ?? ".";
  const initialCommand = commandFor(handoff.target_agent, initialCwd);
  db.transaction(() => db.query("INSERT INTO mgmt_handoff_launch_attempts(attempt_id,handoff_id,idempotency_key,attempt_no,state,command,command_args,target_cwd,requested_at) VALUES (?,?,?,?, 'requested',?,?,?,?)").run(key, handoffId, key, attemptNo, initialCommand[0], JSON.stringify(initialCommand.slice(1)), initialCwd, now)).immediate();
  let cwd: string;
  try { cwd = await isolatedCwd(handoff, packet); } catch (error) { return failNoEffect(db, handoff, attemptNo, error); }
  const host = packet.target_host ?? packet.workspace?.host ?? "local";
  const executor = opts.executor ?? (host === "local" ? localLaunchExecutor : sshLaunchExecutor);
  const request = { handoffId, agent: handoff.target_agent, cwd, host, argv: commandFor(handoff.target_agent, cwd), env: { OVERLOAD_PARENT: `mgmt:handoff:${handoffId}` }, idempotencyKey: key };
  try {
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("launch timeout")), opts.timeoutMs ?? 10_000));
    const result = await Promise.race([executor(request), timeout]);
    db.transaction(() => { db.query("UPDATE mgmt_handoff_launch_attempts SET state='started',receipt=?,observed_pid=?,resolved_at=? WHERE handoff_id=? AND attempt_no=?").run(result.receipt ?? (result.pid ? `pid:${result.pid}` : "started"), result.pid ?? null, Date.now(), handoffId, attemptNo); db.query("UPDATE mgmt_handoffs SET state='launching' WHERE handoff_id=?").run(handoffId); }).immediate();
    return { attempt_no: attemptNo, state: "launching", ...result };
  } catch (error) {
    if ((error as LaunchError).no_effect || (error as LaunchError).noEffect) return failNoEffect(db, handoff, attemptNo, error);
    db.transaction(() => { db.query("UPDATE mgmt_handoff_launch_attempts SET state='unknown',reconcile_result=?,resolved_at=? WHERE handoff_id=? AND attempt_no=?").run(String(error), Date.now(), handoffId, attemptNo); db.query("UPDATE mgmt_handoffs SET state='launch_unknown' WHERE handoff_id=?").run(handoffId); unknownAttention(db, handoff, Date.now()); }).immediate();
    return { attempt_no: attemptNo, state: "launch_unknown" };
  }
}

function failNoEffect(db: Database, handoff: any, attemptNo: number, error: unknown) {
  db.transaction(() => { db.query("UPDATE mgmt_handoff_launch_attempts SET state='failed_no_effect',reconcile_result=?,resolved_at=? WHERE handoff_id=? AND attempt_no=?").run(String(error), Date.now(), handoff.handoff_id, attemptNo); db.query("UPDATE mgmt_handoffs SET state='ready_to_launch' WHERE handoff_id=?").run(handoff.handoff_id); }).immediate();
  return { attempt_no: attemptNo, state: "ready_to_launch", outcome: "failed_no_effect" };
}

export function reconcileLaunches(db: Database, ledger: Database) {
  const handoffs = db.query("SELECT * FROM mgmt_handoffs WHERE state IN ('launching','launch_unknown')").all() as any[];
  let bound = 0;
  for (const handoff of handoffs) {
    const session = row<any>(ledger, "SELECT stable_id,runtime,cwd FROM sessions WHERE origin=? ORDER BY first_seen_at DESC LIMIT 1", `mgmt:handoff:${handoff.handoff_id}`);
    if (!session) continue;
    const now = Date.now(), executionId = `${handoff.handoff_id}:${session.stable_id}`;
    db.transaction(() => {
      db.query("INSERT OR IGNORE INTO mgmt_session_binding(stable_id,work_id,role,evidence_ref,bound_at) VALUES (?,?, 'successor',?,?)").run(session.stable_id, handoff.work_id, `origin:mgmt:handoff:${handoff.handoff_id}`, now);
      const attempt = row<any>(db, "SELECT COALESCE(MAX(attempt_no),0) n FROM mgmt_executions WHERE work_id=?", handoff.work_id)?.n ?? 0;
      const packet = JSON.parse(handoff.packet || "{}");
      db.query(`INSERT OR IGNORE INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,input_head_at_start,ledger_evidence,agent,cwd,started_at,last_observed_at) VALUES (?,?,?,'successor',?,'running','ledger_full',?,?,?, ?,?,?)`).run(executionId, handoff.work_id, session.stable_id, attempt + 1, packet.input_head ?? null, JSON.stringify({ origin: `mgmt:handoff:${handoff.handoff_id}` }), session.runtime, session.cwd, now, now);
      setParentHandoff(db, executionId, handoff.handoff_id);
      db.query("UPDATE mgmt_handoffs SET state='bound',new_stable_id=? WHERE handoff_id=?").run(session.stable_id, handoff.handoff_id);
      db.query("UPDATE mgmt_handoff_launch_attempts SET state='bound',bound_stable_id=?,resolved_at=? WHERE handoff_id=? AND attempt_no=(SELECT MAX(attempt_no) FROM mgmt_handoff_launch_attempts WHERE handoff_id=?)").run(session.stable_id, now, handoff.handoff_id, handoff.handoff_id);
      db.query("UPDATE control_attention SET state='resolved',effect_state='succeeded',updated_at=? WHERE item_id=?").run(now, `mgmt:handoff:${handoff.handoff_id}:unknown`);
    }).immediate();
    bound++;
  }
  return { bound };
}
