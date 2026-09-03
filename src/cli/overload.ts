#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { ackRequest, queryHealth, queryHung, queryJumpTarget, queryQ1, querySession, querySessions, queryZombie, requestSession } from "../shared/queries";
import { performJump, type JumpResult } from "../shared/jump";
import { runDoctor, defaultDoctorDeps } from "./doctor";
import { audit, parseSince, printAudit } from "./audit";
import { runCli as runOrchestratorCli } from "../orchestrator/cli";

const path = process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
type Output = (line: string) => void;

/** Row streams belong on stdout so a selection can be piped straight back into `ack`;
 *  headings and empty-state notes are chrome and belong on stderr. */
const note: Output = (line) => console.error(line);

function time(value: number | null): string { return value == null ? "-" : new Date(value).toISOString(); }
function detail(value: Record<string, unknown> | null): string { if (!value || !Object.keys(value).length) return ""; return ` ${JSON.stringify(value)}`; }
function usage(): never { console.error("usage: overload sessions | show <stable_id> | q1 | q4 | hung | zombie | health | doctor | audit [--sample N] [--since 7d|24h|<ms>] | ack <request_uid>... | jump <stable_id|request_uid> | orch ..."); process.exit(2); }

function listSessions(db: Database): void {
  const rows = querySessions(db);
  if (!rows.length) { note("No known sessions."); return; }
  for (const row of rows) console.log(`${row.stable_id}\t${row.runtime ?? "-"}\t${row.origin ?? "unknown"}\t${row.state ?? "-"}\t${row.queue ?? "-"}\t${time(row.last_event_at)}`);
}
function showSession(db: Database, stableId: string): void {
  const result = querySession(db, stableId);
  if (!result) { console.error(`Session not found: ${stableId}`); process.exitCode = 1; return; }
  const { session, incarnations, pending_requests: requests, events } = result;
  console.log(`Session: ${session.stable_id}\nOrigin: ${session.origin ?? "unknown"}\nRuntime: ${session.runtime ?? "-"}\nState: ${session.state ?? "-"}${session.queue ? ` (${session.queue}${session.q5_reason ? `/${session.q5_reason}` : ""})` : ""}\nCreated: ${time(session.created_at)}\nWorkspace: ${session.cwd ?? "-"}${session.branch ? ` (${session.branch})` : ""}\nLast event: ${time(session.last_event_at)}\nLast progress: ${time(session.last_progress_at)}\nLast heartbeat: ${time(session.last_heartbeat_at)}\nJump: ${session.binding ?? "-"}`);
  console.log("\nIncarnations:");
  if (!incarnations.length) console.log("  (none)");
  for (const row of incarnations) console.log(`  ${row.writer_id} [${row.liveness_domain}] pid=${row.pid ?? "-"} started=${time(row.started_at)} last_seen=${time(row.last_seen_at)}`);
  console.log("\nPending requests:");
  if (!requests.length) console.log("  (none)");
  for (const row of requests) console.log(`  ${row.request_uid} [${row.kind}] ${time(row.created_at)}${detail(row.detail)}`);
  console.log("\nRecent events (newest first, heartbeats omitted):");
  if (!events.length) console.log("  (none)");
  for (const row of events) console.log(`  #${row.ingest_seq} ${time(row.at)} ${row.kind} emitter=${row.emitter_id} writer=${row.writer_id}${detail(row.detail)}`);
}
function q1(db: Database): void {
  const rows = queryQ1(db);
  if (!rows.length) { note("Q1: no pending requests."); return; }
  note("Q1 pending requests:");
  for (const row of rows) {
    const jump = row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");
    console.log(`${row.request_uid}\t${row.kind}\t${time(row.created_at)}\tjump=${jump}${detail(row.detail)}`);
  }
}
export function printQ4(db: Database, output: Output = console.log, heading: Output = note): void {
  const rows = db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q4' ORDER BY last_event_at DESC, stable_id DESC").all() as Array<{ stable_id: string; origin: string; last_event_at: number }>;
  if (!rows.length) { heading("Q4: no auto-verified read-only sessions."); return; }
  heading("Q4 auto-verified read-only sessions:"); for (const row of rows) output(`${row.stable_id}\t${row.origin}\t${time(row.last_event_at)}`);
}
function zombie(db: Database): void {
  const { groups, orphaned_requests: orphaned } = queryZombie(db);
  if (!groups.length && !orphaned.length) { note("Q5: no zombie sessions."); return; }
  // The reason belongs on the row, not in a heading: a grouped row loses its
  // classification the moment it is filtered or piped.
  for (const group of groups) for (const row of group.rows) console.log(`${row.stable_id}\t${group.q5_reason}\t${time(row.last_event_at)}${row.handoff ? `\thandoff=${JSON.stringify(row.handoff)}` : ""}`);
  for (const row of orphaned) console.log(`${row.request_uid}\torphaned_request\t${row.stable_id}\t${time(row.resolved_at)}`);
}
function hung(db: Database): void {
  const rows = queryHung(db);
  if (!rows.length) { note("Hung: no stuck turns."); return; }
  note("Hung turns (heartbeat alive, progress frozen):");
  for (const row of rows) console.log(`${row.stable_id}\t${row.q5_reason}\t${Math.round(row.hung_ms / 60_000)}min\tsince ${time(row.since)}${detail(row.detail)}`);
}
function health(db: Database): void {
  const view = queryHealth(db);
  console.log(`Health: open_incidents=${view.open_incidents.length} coverage_gaps=${view.coverage_gaps} telemetry_gaps=${view.telemetry_gaps}`);
  for (const row of view.open_incidents) console.log(`  incident ${row.source} since ${time(row.opened_at)}${detail(row.detail)}`);
}
/** Accepts either id because the two things worth reaching are addressed differently:
 *  a pending decision is a request, a hung turn has no request to jump from. */
export async function jumpTo(db: Database, id: string, jump = performJump): Promise<void> {
  const stableId = requestSession(db, id) ?? id;
  const target = queryJumpTarget(db, stableId);
  if (!target) { console.error(`Session not found: ${stableId}`); process.exitCode = 1; return; }
  if (!target.binding) { console.error(`No jump target recorded for ${stableId}`); process.exitCode = 1; return; }
  const result: JumpResult = await jump(target);
  if (result.opened) { console.log(`opened ${target.platform ?? "terminal"} ${target.binding}`); return; }
  console.error(`jump failed: ${result.error ?? "target did not respond"}`);
  process.exitCode = 1;
}
/** Acknowledgement is a source terminal (the operator IS the decision authority here):
 *  it cancels the request and thereby stops reminders. Web acks a multi-selection, so
 *  this takes many; a uid that matched nothing must not exit 0 and read as done. */
export function ackAll(db: Database, uids: string[]): void {
  let missed = 0;
  for (const uid of uids) {
    if (ackRequest(db, uid).changes === 1) console.log(`acked ${uid}`);
    else { console.error(`no pending request matches ${uid}`); missed += 1; }
  }
  if (missed) process.exitCode = 1;
}
function runAudit(db: Database, args: string[]): void {
  let sample = 5;
  let sinceMs = 7 * 24 * 60 * 60_000;
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    if (!value || (option !== "--sample" && option !== "--since")) usage();
    if (option === "--sample") {
      sample = Number(value);
      if (!Number.isSafeInteger(sample) || sample < 0) usage();
    } else {
      try { sinceMs = parseSince(value); } catch { usage(); }
    }
  }
  printAudit(audit(db, { sample, sinceMs, now: Date.now() }));
}
export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  const simple = new Set(["sessions", "q1", "q4", "hung", "zombie", "health"]);
  const arity: Record<string, (count: number) => boolean> = {
    show: (count) => count === 1, jump: (count) => count === 1, ack: (count) => count >= 1,
    doctor: (count) => count === 0, audit: (count) => count <= 4 && count % 2 === 0,
  };
  if (!command) usage();
  if (command === "orch") { await runOrchestratorCli(rest); return; }
  if (simple.has(command)) { if (rest.length) usage(); } else if (!arity[command]?.(rest.length)) usage();
  if (command === "ack") {
    const rw = new Database(path);
    try { ackAll(rw, rest); } finally { rw.close(); }
    return;
  }
  if (command === "doctor") {
    const { checks, exitCode } = await runDoctor(defaultDoctorDeps());
    for (const check of checks) console.log(`[${check.status}] ${check.label}: ${check.detail}`);
    process.exitCode = exitCode;
    return;
  }
  let db: Database; try { db = new Database(path, { readonly: true }); } catch (error) { console.error(`Unable to open ledger ${path}: ${(error as Error).message}`); process.exit(1); }
  try {
    if (command === "jump") await jumpTo(db, rest[0]!);
    else if (command === "sessions") listSessions(db); else if (command === "show") showSession(db, rest[0]!); else if (command === "q1") q1(db);
    else if (command === "q4") printQ4(db); else if (command === "hung") hung(db); else if (command === "zombie") zombie(db); else if (command === "health") health(db); else runAudit(db, rest);
  } finally { db.close(); }
}
if (import.meta.main) await main();
