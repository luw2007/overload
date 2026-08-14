#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { runDigestOnce } from "../digest/digest";
import { generateAttribReport } from "../attrib/report";

const path = process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
type SessionRow = { stable_id: string; host: string | null; runtime: string | null; session: string | null; origin: string | null; cwd: string | null; branch: string | null; created_at: number | null };
type IncarnationRow = { writer_id: string; liveness_domain: string; pid: number | null; proc_boot_id: string | null; started_at: number | null; last_seen_at: number | null };
type RequestRow = { request_uid: string; stable_id: string; host: string | null; kind: string; created_at: number; detail: string | null; failed: number; binding: string | null };
type EventRow = { ingest_seq: number; at: number; emitter_id: string; writer_id: string; kind: string; detail: string | null };
type Output = (line: string) => void;

function time(value: number | null): string { return value == null ? "-" : new Date(value).toISOString(); }
function detail(value: string | null): string { if (!value || value === "{}") return ""; try { return ` ${JSON.stringify(JSON.parse(value))}`; } catch { return ` ${value}`; } }
function usage(): never { console.error("usage: overload sessions | show <stable_id> | q1 | q2 | q4 | zombie | health | digest [--llm pi] | attrib [--since <Nh|Nd>]"); process.exit(2); }

function listSessions(db: Database): void {
  const rows = db.query(`SELECT stable_id, runtime, origin, created_at FROM sessions ORDER BY first_seen_at, stable_id`).all() as Array<Pick<SessionRow, "stable_id" | "runtime" | "origin" | "created_at">>;
  if (!rows.length) { console.log("No known sessions."); return; }
  for (const row of rows) console.log(`${row.stable_id}\t${row.runtime ?? "-"}\t${row.origin ?? "unknown"}\t${time(row.created_at)}`);
}
function showSession(db: Database, stableId: string): void {
  const session = db.query("SELECT * FROM sessions WHERE stable_id=?").get(stableId) as SessionRow | null;
  if (!session) { console.error(`Session not found: ${stableId}`); process.exitCode = 1; return; }
  console.log(`Session: ${session.stable_id}\nOrigin: ${session.origin ?? "unknown"}\nRuntime: ${session.runtime ?? "-"}\nCreated: ${time(session.created_at)}\nWorkspace: ${session.cwd ?? "-"}${session.branch ? ` (${session.branch})` : ""}`);
  console.log("\nIncarnations:");
  const incarnations = db.query(`SELECT writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at FROM session_incarnations WHERE stable_id=? ORDER BY started_at, writer_id`).all(stableId) as IncarnationRow[];
  if (!incarnations.length) console.log("  (none)");
  for (const row of incarnations) console.log(`  ${row.writer_id} [${row.liveness_domain}] pid=${row.pid ?? "-"} started=${time(row.started_at)} last_seen=${time(row.last_seen_at)}`);
  console.log("\nPending requests:");
  const requests = db.query(`SELECT request_uid, stable_id, kind, created_at, detail, 0 failed, NULL binding, NULL host FROM requests WHERE stable_id=? AND state='pending' ORDER BY created_at, request_uid`).all(stableId) as RequestRow[];
  if (!requests.length) console.log("  (none)");
  for (const row of requests) console.log(`  ${row.request_uid} [${row.kind}] ${time(row.created_at)}${detail(row.detail)}`);
  console.log("\nEvent history (ingest order):");
  const events = db.query(`SELECT ingest_seq, at, emitter_id, writer_id, kind, detail FROM journal WHERE stable_id=? ORDER BY ingest_seq`).all(stableId) as EventRow[];
  for (const row of events) console.log(`  #${row.ingest_seq} ${time(row.at)} ${row.kind} emitter=${row.emitter_id} writer=${row.writer_id}${detail(row.detail)}`);
}
function q1(db: Database): void {
  const rows = db.query(`SELECT r.request_uid, r.stable_id, s.host, r.kind, r.created_at, r.detail,
    EXISTS(SELECT 1 FROM notifications n WHERE n.request_uid=r.request_uid AND n.state='failed_permanent') failed,
    (SELECT binding FROM attachments a WHERE a.stable_id=r.stable_id AND a.valid=1 ORDER BY observed_at DESC LIMIT 1) binding
    FROM requests r LEFT JOIN sessions s ON s.stable_id=r.stable_id
    WHERE r.state='pending' ORDER BY failed DESC, r.created_at, r.request_uid`).all() as RequestRow[];
  if (!rows.length) { console.log("Q1: no pending requests."); return; }
  console.log("Q1 pending requests:");
  for (const row of rows) {
    const jump = row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");
    console.log(`${row.failed ? "[DELIVERY FAILED] " : ""}${row.request_uid}\t${row.kind}\t${time(row.created_at)}\tjump=${jump}${detail(row.detail)}`);
  }
}
function q2(db: Database): void {
  const rows = db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q2' ORDER BY last_event_at, stable_id").all() as Array<{ stable_id: string; origin: string; last_event_at: number }>;
  if (!rows.length) { console.log("Q2: no completed agent sessions."); return; }
  console.log("Q2 completed sessions:"); for (const row of rows) console.log(`${row.stable_id}\t${row.origin}\t${time(row.last_event_at)}`);
}
export function printQ4(db: Database, output: Output = console.log): void {
  const rows = db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q4' ORDER BY last_event_at, stable_id").all() as Array<{ stable_id: string; origin: string; last_event_at: number }>;
  if (!rows.length) { output("Q4: no auto-verified read-only sessions."); return; }
  output("Q4 auto-verified read-only sessions:"); for (const row of rows) output(`${row.stable_id}\t${row.origin}\t${time(row.last_event_at)}`);
}
function zombie(db: Database): void {
  const rows = db.query("SELECT stable_id, q5_reason, last_event_at FROM current WHERE queue='q5' ORDER BY q5_reason, last_event_at, stable_id").all() as Array<{ stable_id: string; q5_reason: string; last_event_at: number }>;
  const orphaned = db.query(`SELECT request_uid, stable_id, resolved_at FROM requests WHERE state='orphaned' ORDER BY resolved_at, request_uid`).all() as Array<{ request_uid: string; stable_id: string; resolved_at: number | null }>;
  if (!rows.length && !orphaned.length) { console.log("Q5: no zombie sessions."); return; }
  let group = "";
  for (const row of rows.filter((row) => row.q5_reason !== "orphaned_request")) { if (row.q5_reason !== group) { group = row.q5_reason; console.log(`${group}:`); } console.log(`  ${row.stable_id}\t${time(row.last_event_at)}`); }
  if (orphaned.length) { console.log("orphaned_request:"); for (const row of orphaned) console.log(`  ${row.request_uid}\t${row.stable_id}\t${time(row.resolved_at)}`); }
}
function health(db: Database): void {
  const incidents = db.query("SELECT source, opened_at, detail FROM incidents WHERE closed_at IS NULL ORDER BY opened_at").all() as Array<{ source: string; opened_at: number; detail: string | null }>;
  const gaps = (db.query("SELECT count(*) n FROM coverage_gaps").get() as { n: number }).n;
  const telemetry = (db.query("SELECT count(*) n FROM journal WHERE kind='telemetry_gap'").get() as { n: number }).n;
  console.log(`Health: open_incidents=${incidents.length} coverage_gaps=${gaps} telemetry_gaps=${telemetry}`);
  for (const row of incidents) console.log(`  incident ${row.source} since ${time(row.opened_at)}${detail(row.detail)}`);
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
  if (!command || (simple.has(command) && (argument || extra.length)) || (command === "show" && (!argument || extra.length)) || (!simple.has(command) && command !== "show" && !validDigest && !validAttrib)) usage();
  let db: Database; try { db = new Database(path, { readonly: true }); } catch (error) { console.error(`Unable to open ledger ${path}: ${(error as Error).message}`); process.exit(1); }
  try {
    if (command === "sessions") listSessions(db); else if (command === "show") showSession(db, argument!); else if (command === "q1") q1(db); else if (command === "q2") q2(db);
    else if (command === "q4") printQ4(db); else if (command === "zombie") zombie(db); else if (command === "health") health(db);
    else if (command === "digest") console.log(await runDigestOnce(db, argument === "--llm" ? "pi" : undefined)); else await attrib(db, argument === "--since" ? extra[0] : undefined);
  } finally { db.close(); }
}
if (import.meta.main) await main();
