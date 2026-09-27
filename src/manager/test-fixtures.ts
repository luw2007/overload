import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWork, ensureControlSchema, upsertAttention } from "../control/store";
import type { Contract } from "../control/types";

export const NOW = 1_800_000_000_000;
const contract: Contract = { objective: "ship", acceptance: [{ id: "h", kind: "human", description: "owner accepts" }], non_goals: [], scope: { allowed_effects: ["write"] }, budget: {}, stop_conditions: [{ id: "r", kind: "hard", description: "risk" }], decision_owner: "owner" };

export function controlDb(): Database { const db = new Database(":memory:"); ensureControlSchema(db); return db; }
export function ledgerDb(): Database { const db = new Database(":memory:"); db.exec(readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8")); return db; }
export function work(db: Database, title = "w"): string { return createWork(db, { title, source: "test", contract }, NOW - 10_000).work_id; }
export function item(db: Database, workId: string, id: string, patch: { urgency?: "now" | "inbox"; state?: "open" | "resolved"; at?: number; evidence?: Record<string, unknown>; conclusion?: string } = {}) {
  return upsertAttention(db, { item_id: id, work_id: workId, state: patch.state ?? "open", effect_state: patch.state === "resolved" ? "succeeded" : "not_started", urgency: patch.urgency ?? "inbox", conclusion: patch.conclusion ?? `decide ${id}`, trigger: "risk", impact: "blocked", recommendation: "approve", options: ["approve"], owner: "owner", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: patch.evidence ?? {} }, patch.at ?? NOW - 1_000);
}
export function session(ledger: Database, id: string, opts: { runtime?: string; host?: string; at?: number; ended?: boolean; q5?: string | null } = {}): void {
  const at = opts.at ?? NOW - 1_000;
  ledger.run("INSERT INTO sessions(stable_id,host,runtime,session,cwd,branch,created_at,first_seen_at) VALUES(?,?,?,?,?,?,?,?)", [id, opts.host ?? "local", opts.runtime ?? "pi", id, "/repo", "main", at, at]);
  ledger.run("INSERT INTO current(stable_id,state,queue,q5_reason,last_event_at) VALUES(?,?,?,?,?)", [id, opts.ended ? "done" : "working", opts.q5 ? "q5" : "q3", opts.q5 ?? null, at]);
  if (opts.ended) ledger.run("INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind,detail) VALUES('local','e',?,?,?,'w','session_ended','{}')", [Math.floor(Math.random() * 1e9), at, id]);
}
