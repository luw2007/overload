import { Database } from "bun:sqlite";

const DAY_MS = 86_400_000;
export const ARCHIVE_BATCH_SIZE = 1_000;

/** One bounded batch per ingest cycle. Keep unprojected events in journal even when old.
 * Transactions move each row atomically; ingest_seq stays globally monotone. */
export function archiveJournal(db: Database, now = Date.now()): number {
  const cursor = (db.query("SELECT journal_seq FROM reducer_cursor WHERE id=1").get() as { journal_seq: number } | null)?.journal_seq ?? 0;
  const sevenDays = now - 7 * DAY_MS;
  const thirtyDays = now - 30 * DAY_MS;
  let archived = 0;
  let remaining = ARCHIVE_BATCH_SIZE;
  for (const [source, target, cutoff] of [
    ["journal_7d", "journal_30d", thirtyDays],
    ["journal", "journal_30d", thirtyDays],
    ["journal", "journal_7d", sevenDays],
  ] as const) {
    while (true) {
      const count = db.transaction(() => {
        const rows = db.query(`SELECT * FROM ${source} WHERE at <= ? AND ingest_seq <= ? ORDER BY at, ingest_seq LIMIT ?`)
          .all(cutoff, cursor, remaining) as Array<{ ingest_seq: number; host: string; emitter_id: string; seq: number; at: number; stable_id: string; writer_id: string; kind: string; detail: string | null; spool_ref: string | null }>;
        if (!rows.length) return 0;
        const insert = db.query(`INSERT INTO ${target} VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        const remove = db.query(`DELETE FROM ${source} WHERE ingest_seq=?`);
        for (const row of rows) {
          insert.run(row.ingest_seq, row.host, row.emitter_id, row.seq, row.at, row.stable_id, row.writer_id, row.kind, row.detail, row.spool_ref);
          remove.run(row.ingest_seq);
        }
        return rows.length;
      }).immediate();
      archived += count;
      remaining -= count;
      if (remaining === 0) return archived;
      if (!count) break;
    }
  }
  return archived;
}
