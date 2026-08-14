#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const path = process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");

type SessionRow = { stable_id: string; host: string | null; runtime: string | null; session: string | null; origin: string | null; cwd: string | null; branch: string | null; created_at: number | null };
type IncarnationRow = { writer_id: string; liveness_domain: string; pid: number | null; proc_boot_id: string | null; started_at: number | null; last_seen_at: number | null };
type RequestRow = { request_uid: string; kind: string; created_at: number; detail: string | null };
type EventRow = { ingest_seq: number; at: number; emitter_id: string; writer_id: string; kind: string; detail: string | null };

function time(value: number | null): string { return value == null ? "-" : new Date(value).toISOString(); }
function detail(value: string | null): string {
  if (!value || value === "{}") return "";
  try { return ` ${JSON.stringify(JSON.parse(value))}`; } catch { return ` ${value}`; }
}

function usage(): never {
  console.error("usage: overload sessions | overload show <stable_id>");
  process.exit(2);
}

function listSessions(db: Database): void {
  const rows = db.query(`SELECT stable_id, runtime, origin, created_at FROM sessions
    ORDER BY first_seen_at, stable_id`).all() as Array<Pick<SessionRow, "stable_id" | "runtime" | "origin" | "created_at">>;
  if (rows.length === 0) { console.log("No known sessions."); return; }
  for (const row of rows) console.log(`${row.stable_id}\t${row.runtime ?? "-"}\t${row.origin ?? "unknown"}\t${time(row.created_at)}`);
}

function showSession(db: Database, stableId: string): void {
  const session = db.query("SELECT * FROM sessions WHERE stable_id=?").get(stableId) as SessionRow | null;
  if (!session) {
    console.error(`Session not found: ${stableId}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Session: ${session.stable_id}`);
  console.log(`Origin: ${session.origin ?? "unknown"}`);
  console.log(`Runtime: ${session.runtime ?? "-"}`);
  console.log(`Created: ${time(session.created_at)}`);
  console.log(`Workspace: ${session.cwd ?? "-"}${session.branch ? ` (${session.branch})` : ""}`);

  console.log("\nIncarnations:");
  const incarnations = db.query(`SELECT writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at
    FROM session_incarnations WHERE stable_id=? ORDER BY started_at, writer_id`).all(stableId) as IncarnationRow[];
  if (incarnations.length === 0) console.log("  (none)");
  for (const row of incarnations) {
    console.log(`  ${row.writer_id} [${row.liveness_domain}] pid=${row.pid ?? "-"} started=${time(row.started_at)} last_seen=${time(row.last_seen_at)}`);
  }

  console.log("\nPending requests:");
  const requests = db.query(`SELECT request_uid, kind, created_at, detail FROM requests
    WHERE stable_id=? AND state='pending' ORDER BY created_at, request_uid`).all(stableId) as RequestRow[];
  if (requests.length === 0) console.log("  (none)");
  for (const row of requests) console.log(`  ${row.request_uid} [${row.kind}] ${time(row.created_at)}${detail(row.detail)}`);

  console.log("\nEvent history (ingest order):");
  const events = db.query(`SELECT ingest_seq, at, emitter_id, writer_id, kind, detail FROM journal
    WHERE stable_id=? ORDER BY ingest_seq`).all(stableId) as EventRow[];
  for (const row of events) {
    console.log(`  #${row.ingest_seq} ${time(row.at)} ${row.kind} emitter=${row.emitter_id} writer=${row.writer_id}${detail(row.detail)}`);
  }
}

function main(): void {
  const [command, argument, ...extra] = Bun.argv.slice(2);
  if (extra.length || (command !== "sessions" && command !== "show") || (command === "show" && !argument) || (command === "sessions" && argument)) usage();
  let db: Database;
  try { db = new Database(path, { readonly: true }); }
  catch (error) {
    console.error(`Unable to open ledger ${path}: ${(error as Error).message}`);
    process.exit(1);
  }
  try {
    if (command === "sessions") listSessions(db);
    else showSession(db, argument!);
  } finally { db.close(); }
}

if (import.meta.main) main();
