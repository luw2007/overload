#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { ackRequest, queryHealth, queryHung, queryQ1, queryQ2, querySession, querySessions, queryZombie } from "../shared/queries";
import { runDoctor, defaultDoctorDeps } from "./doctor";

const path = process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
type Output = (line: string) => void;

function time(value: number | null): string { return value == null ? "-" : new Date(value).toISOString(); }
function detail(value: Record<string, unknown> | null): string { if (!value || !Object.keys(value).length) return ""; return ` ${JSON.stringify(value)}`; }
function usage(): never { console.error("usage: overload sessions | show <stable_id> | q1 | q2 | q4 | hung | zombie | health | doctor | ack <request_uid>"); process.exit(2); }

function listSessions(db: Database): void {
  const rows = querySessions(db);
  if (!rows.length) { console.log("No known sessions."); return; }
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
  if (!rows.length) { console.log("Q1: no pending requests."); return; }
  console.log("Q1 pending requests:");
  for (const row of rows) {
    const jump = row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");
    console.log(`${row.request_uid}\t${row.kind}\t${time(row.created_at)}\tjump=${jump}${detail(row.detail)}`);
  }
}
function q2(db: Database): void {
  const rows = queryQ2(db);
  if (!rows.length) { console.log("Q2: no completed agent sessions."); return; }
  console.log("Q2 completed sessions:"); for (const row of rows) console.log(`${row.stable_id}\t${row.origin}\t${time(row.last_event_at)}`);
}
export function printQ4(db: Database, output: Output = console.log): void {
  const rows = db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q4' ORDER BY last_event_at, stable_id").all() as Array<{ stable_id: string; origin: string; last_event_at: number }>;
  if (!rows.length) { output("Q4: no auto-verified read-only sessions."); return; }
  output("Q4 auto-verified read-only sessions:"); for (const row of rows) output(`${row.stable_id}\t${row.origin}\t${time(row.last_event_at)}`);
}
function zombie(db: Database): void {
  const { groups, orphaned_requests: orphaned } = queryZombie(db);
  if (!groups.length && !orphaned.length) { console.log("Q5: no zombie sessions."); return; }
  for (const group of groups) { console.log(`${group.q5_reason}:`); for (const row of group.rows) console.log(`  ${row.stable_id}\t${time(row.last_event_at)}`); }
  if (orphaned.length) { console.log("orphaned_request:"); for (const row of orphaned) console.log(`  ${row.request_uid}\t${row.stable_id}\t${time(row.resolved_at)}`); }
}
function hung(db: Database): void {
  const rows = queryHung(db);
  if (!rows.length) { console.log("Hung: no stuck turns."); return; }
  console.log("Hung turns (heartbeat alive, progress frozen):");
  for (const row of rows) console.log(`${row.stable_id}\t${row.q5_reason}\t${Math.round(row.hung_ms / 60_000)}min\tsince ${time(row.since)}${detail(row.detail)}`);
}
function health(db: Database): void {
  const view = queryHealth(db);
  console.log(`Health: open_incidents=${view.open_incidents.length} coverage_gaps=${view.coverage_gaps} telemetry_gaps=${view.telemetry_gaps}`);
  for (const row of view.open_incidents) console.log(`  incident ${row.source} since ${time(row.opened_at)}${detail(row.detail)}`);
}
export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const [command, argument, ...extra] = argv;
  const simple = new Set(["sessions", "q1", "q2", "q4", "hung", "zombie", "health"]);
  const validAck = command === "ack" && argument != null && !extra.length;
  const validDoctor = command === "doctor" && argument == null && !extra.length;
  if (!command || (simple.has(command) && (argument || extra.length)) || (command === "show" && (!argument || extra.length)) || (!simple.has(command) && command !== "show" && !validAck && !validDoctor)) usage();
  if (validAck) {
    // Human acknowledgement is a source terminal (the operator IS the decision
    // authority here): cancels the request and thereby stops reminders.
    const rw = new Database(path);
    try {
      const result = ackRequest(rw, argument!);
      console.log(result.changes === 1 ? `acked ${argument}` : `no pending request matches ${argument}`);
    } finally { rw.close(); }
    return;
  }
  if (validDoctor) {
    const { checks, exitCode } = await runDoctor(defaultDoctorDeps());
    for (const check of checks) console.log(`[${check.status}] ${check.label}: ${check.detail}`);
    process.exitCode = exitCode;
    return;
  }
  let db: Database; try { db = new Database(path, { readonly: true }); } catch (error) { console.error(`Unable to open ledger ${path}: ${(error as Error).message}`); process.exit(1); }
  try {
    if (command === "sessions") listSessions(db); else if (command === "show") showSession(db, argument!); else if (command === "q1") q1(db); else if (command === "q2") q2(db);
    else if (command === "q4") printQ4(db); else if (command === "hung") hung(db); else if (command === "zombie") zombie(db); else health(db);
  } finally { db.close(); }
}
if (import.meta.main) await main();
