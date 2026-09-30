import { Database } from "bun:sqlite";

const DAY_MS = 86_400_000;
export const ARCHIVE_BATCH_SIZE = 1_000;

const JOURNAL_TABLES = ["journal", "journal_7d", "journal_30d"] as const;

/** The one kind safe to discard preferentially: heartbeat is the bulk of the log
 * and the only kind nothing reads back. Do NOT "optimise" this to control_event —
 * those rows have consumers with their own cursors outside this database
 * (`effect_reconcile_cursor` in the decision-bot mailbox, reconciled by
 * `reconcileEffectEvents`) and are the target of `journal:<seq>` evidence
 * references resolved by the on-demand fetcher. Deleting them first silently
 * strands both. */
const NOISE_KIND = "heartbeat";

/** Keep the durable event log bounded after projection. Noise is discarded
 * first; only when that is insufficient are the globally oldest other events
 * removed. Unprojected rows are never deleted.
 *
 * One bounded batch per call, for the same reason `archiveJournal` is bounded:
 * the unbounded form deleted 2.3M rows in a single 34s transaction on the 3.3M-row
 * ledger this exists for, and every other writer fails on the schema's 5s
 * busy_timeout long before it commits. Callers re-arm while a batch comes back
 * full, exactly as they do for the archiver. */
export function pruneJournalCapacity(db: Database, maxRows: number, batchSize = ARCHIVE_BATCH_SIZE): number {
  const total = (db.query(`SELECT SUM(n) AS n FROM (${JOURNAL_TABLES
    .map((table) => `SELECT COUNT(*) AS n FROM ${table}`).join(" UNION ALL ")})`)
    .get() as { n: number }).n;
  let excess = Math.min(total - maxRows, batchSize);
  if (excess <= 0) return 0;
  const cursor = (db.query("SELECT journal_seq FROM reducer_cursor WHERE id=1").get() as { journal_seq: number } | null)?.journal_seq ?? 0;

  return db.transaction(() => {
    let removed = 0;
    const noise = (db.query(`SELECT COUNT(*) AS n FROM (${JOURNAL_TABLES
      .map((table) => `SELECT ingest_seq FROM ${table} WHERE kind=? AND ingest_seq <= ?`).join(" UNION ALL ")})`)
      .get(...JOURNAL_TABLES.flatMap(() => [NOISE_KIND, cursor])) as { n: number }).n;
    const noiseToRemove = Math.min(excess, noise);
    if (noiseToRemove > 0) {
      const cutoff = (db.query(`SELECT ingest_seq FROM (${JOURNAL_TABLES
        .map((table) => `SELECT ingest_seq FROM ${table} WHERE kind=? AND ingest_seq <= ?`).join(" UNION ALL ")})
        ORDER BY ingest_seq LIMIT 1 OFFSET ?`)
        .get(...JOURNAL_TABLES.flatMap(() => [NOISE_KIND, cursor]), noiseToRemove - 1) as { ingest_seq: number }).ingest_seq;
      for (const table of JOURNAL_TABLES) {
        removed += Number(db.query(`DELETE FROM ${table} WHERE kind=? AND ingest_seq <= ?`).run(NOISE_KIND, cutoff).changes);
      }
      excess -= noiseToRemove;
    }
    if (excess > 0) {
      const eligible = (db.query(`SELECT COUNT(*) AS n FROM (${JOURNAL_TABLES
        .map((table) => `SELECT ingest_seq FROM ${table} WHERE ingest_seq <= ?`).join(" UNION ALL ")})`)
        .get(...JOURNAL_TABLES.map(() => cursor)) as { n: number }).n;
      const oldToRemove = Math.min(excess, eligible);
      if (oldToRemove > 0) {
        const cutoff = (db.query(`SELECT ingest_seq FROM (${JOURNAL_TABLES
          .map((table) => `SELECT ingest_seq FROM ${table} WHERE ingest_seq <= ?`).join(" UNION ALL ")})
          ORDER BY ingest_seq LIMIT 1 OFFSET ?`)
          .get(...JOURNAL_TABLES.map(() => cursor), oldToRemove - 1) as { ingest_seq: number }).ingest_seq;
        for (const table of JOURNAL_TABLES) {
          removed += Number(db.query(`DELETE FROM ${table} WHERE ingest_seq <= ?`).run(cutoff).changes);
        }
      }
    }
    return removed;
  }).immediate();
}

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
