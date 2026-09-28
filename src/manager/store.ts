import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

export type ManagerTurnStatus = "running" | "answered" | "invalid_envelope" | "failed" | "unavailable";
export type ManagerSource = "web" | "cli" | "feishu";
export type HandoffReceipt = { target_id: string; request_id: string | null; state: "delivered" | "undelivered"; reason: string | null };
export type ManagerTurn = {
  turn_id: string; source: ManagerSource; question: string; materials: unknown | null; snapshot_id: string | null;
  status: ManagerTurnStatus; answer_markdown: string | null; envelope: unknown | null; failure_reason: string | null;
  handoff_receipts: HandoffReceipt[] | null; model: string | null; started_at: number; finished_at: number | null;
};

export function ensureManagerSchema(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS manager_turns(
    turn_id TEXT PRIMARY KEY, source TEXT NOT NULL,
    question TEXT NOT NULL, materials TEXT,
    snapshot_id TEXT, status TEXT NOT NULL,
    answer_markdown TEXT, envelope TEXT, failure_reason TEXT,
    handoff_receipts TEXT,
    model TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);
  CREATE INDEX IF NOT EXISTS manager_turns_started ON manager_turns(started_at);`);
}

const parse = (value: unknown) => (typeof value === "string" ? JSON.parse(value) : null);
function turnFrom(row: Record<string, unknown>): ManagerTurn {
  return {
    turn_id: String(row.turn_id), source: row.source as ManagerSource, question: String(row.question), materials: parse(row.materials),
    snapshot_id: (row.snapshot_id as string | null) ?? null, status: row.status as ManagerTurnStatus, answer_markdown: (row.answer_markdown as string | null) ?? null,
    envelope: parse(row.envelope), failure_reason: (row.failure_reason as string | null) ?? null, handoff_receipts: parse(row.handoff_receipts),
    model: (row.model as string | null) ?? null, started_at: Number(row.started_at), finished_at: (row.finished_at as number | null) ?? null,
  };
}

export class ManagerBusyError extends Error { constructor() { super("manager_busy"); } }

/** Single-flight: a running turn younger than timeoutMs blocks new turns. Check and insert in one immediate transaction. */
export function beginManagerTurn(db: Database, input: { source: ManagerSource; question: string; materials?: unknown; model: string | null; now: number; timeoutMs: number }): ManagerTurn {
  ensureManagerSchema(db);
  const turnId = randomUUID();
  db.transaction(() => {
    const busy = db.query("SELECT 1 FROM manager_turns WHERE status='running' AND started_at>? LIMIT 1").get(input.now - input.timeoutMs);
    if (busy) throw new ManagerBusyError();
    db.run("INSERT INTO manager_turns(turn_id,source,question,materials,status,model,started_at) VALUES(?,?,?,?,?,?,?)",
      [turnId, input.source, input.question, input.materials === undefined ? null : JSON.stringify(input.materials), "running", input.model, input.now]);
  }).immediate();
  return getManagerTurn(db, turnId)!;
}

export function finishManagerTurn(db: Database, turnId: string, patch: { status: Exclude<ManagerTurnStatus, "running">; snapshot_id?: string | null; answer_markdown?: string | null; envelope?: unknown; failure_reason?: string | null; handoff_receipts?: HandoffReceipt[] | null; finished_at: number }): ManagerTurn {
  db.run("UPDATE manager_turns SET status=?,snapshot_id=COALESCE(?,snapshot_id),answer_markdown=?,envelope=?,failure_reason=?,handoff_receipts=?,finished_at=? WHERE turn_id=?", [
    patch.status, patch.snapshot_id ?? null, patch.answer_markdown ?? null, patch.envelope === undefined || patch.envelope === null ? null : JSON.stringify(patch.envelope),
    patch.failure_reason ?? null, patch.handoff_receipts ? JSON.stringify(patch.handoff_receipts) : null, patch.finished_at, turnId,
  ]);
  return getManagerTurn(db, turnId)!;
}

export function getManagerTurn(db: Database, turnId: string): ManagerTurn | null {
  ensureManagerSchema(db);
  const row = db.query("SELECT * FROM manager_turns WHERE turn_id=?").get(turnId) as Record<string, unknown> | null;
  return row ? turnFrom(row) : null;
}

/** Newest first. */
export function listManagerTurns(db: Database, limit = 20): ManagerTurn[] {
  ensureManagerSchema(db);
  const n = Math.max(1, Math.min(200, Math.floor(limit) || 20));
  return (db.query("SELECT * FROM manager_turns ORDER BY started_at DESC, rowid DESC LIMIT ?").all(n) as Record<string, unknown>[]).map(turnFrom);
}
