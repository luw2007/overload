#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { runDigestOnce } from "../digest/digest";
import { generateAttribReport } from "../attrib/report";
import { ackRequest, queryHealth, queryQ1, queryQ2, querySession, querySessions, queryZombie } from "../shared/queries";

const path = process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
type Output = (line: string) => void;

function time(value: number | null): string { return value == null ? "-" : new Date(value).toISOString(); }
function detail(value: Record<string, unknown> | null): string { if (!value || !Object.keys(value).length) return ""; return ` ${JSON.stringify(value)}`; }
function usage(): never { console.error("usage: overload sessions | show <stable_id> | q1 | q2 | q4 | zombie | health | ack <request_uid> | digest [--llm pi] | attrib [--since <Nh|Nd>]"); process.exit(2); }

function listSessions(db: Database): void {
  const rows = querySessions(db);
  if (!rows.length) { console.log("No known sessions."); return; }
  for (const row of rows) console.log(`${row.stable_id}\t${row.runtime ?? "-"}\t${row.origin ?? "unknown"}\t${time(row.created_at)}`);
}
function showSession(db: Database, stableId: string): void {
  const result = querySession(db, stableId);
  if (!result) { console.error(`Session not found: ${stableId}`); process.exitCode = 1; return; }
  const { session, incarnations, pending_requests: requests, events } = result;
  console.log(`Session: ${session.stable_id}\nOrigin: ${session.origin ?? "unknown"}\nRuntime: ${session.runtime ?? "-"}\nCreated: ${time(session.created_at)}\nWorkspace: ${session.cwd ?? "-"}${session.branch ? ` (${session.branch})` : ""}`);
  console.log("\nIncarnations:");
  if (!incarnations.length) console.log("  (none)");
  for (const row of incarnations) console.log(`  ${row.writer_id} [${row.liveness_domain}] pid=${row.pid ?? "-"} started=${time(row.started_at)} last_seen=${time(row.last_seen_at)}`);
  console.log("\nPending requests:");
  if (!requests.length) console.log("  (none)");
  for (const row of requests) console.log(`  ${row.request_uid} [${row.kind}] ${time(row.created_at)}${detail(row.detail)}`);
  console.log("\nEvent history (ingest order):");
  for (const row of events) console.log(`  #${row.ingest_seq} ${time(row.at)} ${row.kind} emitter=${row.emitter_id} writer=${row.writer_id}${detail(row.detail)}`);
}
function q1(db: Database): void {
  const rows = queryQ1(db);
  if (!rows.length) { console.log("Q1: no pending requests."); return; }
  console.log("Q1 pending requests:");
  for (const row of rows) {
    const jump = row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");
    console.log(`${row.failed ? "[DELIVERY FAILED] " : ""}${row.request_uid}\t${row.kind}\t${time(row.created_at)}\tjump=${jump}${detail(row.detail)}`);
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
function health(db: Database): void {
  const view = queryHealth(db);
  console.log(`Health: open_incidents=${view.open_incidents.length} coverage_gaps=${view.coverage_gaps} telemetry_gaps=${view.telemetry_gaps}`);
  for (const row of view.open_incidents) console.log(`  incident ${row.source} since ${time(row.opened_at)}${detail(row.detail)}`);
}
function sinceMs(value: string): number | undefined {
  const match = /^(\d+)(h|d)$/.exec(value); if (!match) return undefined;
  return Number(match[1]) * (match[2] === "d" ? 86_400_000 : 3_600_000);
}
async function attrib(db: Database, value?: string): Promise<void> {
  if (value && sinceMs(value) == null) usage();
  const report = await generateAttribReport(db, { ...(value ? { sinceMs: sinceMs(value)! } : {}) });
  console.log(`Attribution universe: ${report.universe.join(", ") || "(empty)"}`);
  for (const row of report.rows) console.log(`${row.sha}\t${row.grade}\t${row.stable_id ?? "-"}\t${row.repo}\t${time(row.at)}`);
}

export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const [command, argument, ...extra] = argv;
  const simple = new Set(["sessions", "q1", "q2", "q4", "zombie", "health"]);
  const validDigest = command === "digest" && ((argument == null && !extra.length) || (argument === "--llm" && extra.length === 1 && extra[0] === "pi"));
  const validAttrib = command === "attrib" && ((argument == null && !extra.length) || (argument === "--since" && extra.length === 1));
  const validAck = command === "ack" && argument != null && !extra.length;
  if (!command || (simple.has(command) && (argument || extra.length)) || (command === "show" && (!argument || extra.length)) || (!simple.has(command) && command !== "show" && !validDigest && !validAttrib && !validAck)) usage();
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
  let db: Database; try { db = new Database(path, { readonly: true }); } catch (error) { console.error(`Unable to open ledger ${path}: ${(error as Error).message}`); process.exit(1); }
  try {
    if (command === "sessions") listSessions(db); else if (command === "show") showSession(db, argument!); else if (command === "q1") q1(db); else if (command === "q2") q2(db);
    else if (command === "q4") printQ4(db); else if (command === "zombie") zombie(db); else if (command === "health") health(db);
    else if (command === "digest") console.log(await runDigestOnce(db, argument === "--llm" ? "pi" : undefined)); else await attrib(db, argument === "--since" ? extra[0] : undefined);
  } finally { db.close(); }
}
if (import.meta.main) await main();
