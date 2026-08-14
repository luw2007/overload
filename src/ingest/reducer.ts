import { Database } from "bun:sqlite";

const SOURCE_TERMINALS = new Set(["resolved", "cancelled", "timed_out"]);

type JournalRow = {
  ingest_seq: number;
  at: number;
  stable_id: string;
  writer_id: string;
  emitter_id: string;
  kind: string;
  detail: string | null;
};

type RequestRow = { state: string };

function objectDetail(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function requestId(detail: Record<string, unknown>): string | undefined {
  return typeof detail.request_id === "string" && detail.request_id.length > 0
    ? detail.request_id
    : undefined;
}

function terminalState(detail: Record<string, unknown>): string {
  const candidate = detail.state ?? detail.outcome;
  return typeof candidate === "string" && SOURCE_TERMINALS.has(candidate)
    ? candidate
    : "resolved";
}

/**
 * Reduces one journal batch atomically. Queues and notifications deliberately
 * remain outside P1; later phases can extend applyEvent inside this boundary.
 */
export function reduceJournal(db: Database, batchSize = 500): number {
  let processed = 0;
  const transaction = db.transaction(() => {
    db.query("INSERT OR IGNORE INTO reducer_cursor(id, journal_seq) VALUES (1, 0)").run();
    const cursor = (db.query("SELECT journal_seq FROM reducer_cursor WHERE id=1").get() as { journal_seq: number }).journal_seq;
    const rows = db.query(`SELECT ingest_seq, at, stable_id, writer_id, emitter_id, kind, detail
      FROM journal WHERE ingest_seq > ? ORDER BY ingest_seq LIMIT ?`).all(cursor, batchSize) as JournalRow[];

    for (const row of rows) applyRequestEvent(db, row);
    if (rows.length > 0) {
      db.query("UPDATE reducer_cursor SET journal_seq=? WHERE id=1").run(rows[rows.length - 1]!.ingest_seq);
    }
    processed = rows.length;
  });
  transaction.immediate();
  return processed;
}

function applyRequestEvent(db: Database, row: JournalRow): void {
  if (row.kind !== "decision_requested" && row.kind !== "decision_resolved") return;
  const detail = objectDetail(row.detail);
  const id = requestId(detail);
  if (!id) return;

  const uid = `${row.stable_id}#${row.writer_id}#${id}`;
  const existing = db.query("SELECT state FROM requests WHERE request_uid=?").get(uid) as RequestRow | null;
  const kind = typeof detail.request_kind === "string"
    ? detail.request_kind
    : typeof detail.kind === "string" ? detail.kind : "decision";

  if (row.kind === "decision_requested") {
    if (!existing) {
      db.query(`INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id,
        request_id, kind, state, created_at, detail) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(uid, row.stable_id, row.writer_id, row.emitter_id, id, kind, row.at, row.detail);
    }
    return;
  }

  const state = terminalState(detail);
  if (!existing) {
    db.query(`INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id,
      request_id, kind, state, created_at, resolved_at, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uid, row.stable_id, row.writer_id, row.emitter_id, id, kind, state, row.at, row.at, row.detail);
    return;
  }

  if (existing.state === "pending" || existing.state === "orphaned") {
    db.query("UPDATE requests SET state=?, resolved_at=?, detail=? WHERE request_uid=?")
      .run(state, row.at, row.detail, uid);
  }
}
