/**
 * Frozen P2 ledger DDL — transcribed verbatim from docs/contracts/p2-freeze.md
 * "Schema 增量" (field names + CHECK/UNIQUE constraints frozen; N5 must append
 * identical DDL to src/ingest/schema.sql).
 *
 * The P1 DDL (test/lib/schema.ts) already ships requests.next_reminder_at, so
 * the freeze's `ALTER TABLE requests ADD COLUMN next_reminder_at` is skipped
 * ("已在 P1 DDL 者跳过").
 *
 * P2 acceptance tests (N8) assert against THIS shape — the contract — not
 * against N5/N6/N7 code. Real-implementation sections additionally verify the
 * merged src entries satisfy the same observable behavior (schema-drift check
 * in test/p2-classifier.test.ts).
 */
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../schema";

export const P2_DDL_SQL = `
-- ── P2 frozen schema increment (p2-freeze.md, verbatim) ──
CREATE TABLE IF NOT EXISTS current(
  stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT NOT NULL,
  queue TEXT, q5_reason TEXT, origin TEXT NOT NULL DEFAULT 'unknown',
  last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER, frozen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS queue_transitions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, queue TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN('entered','left')), at INTEGER NOT NULL,
  source_seq INTEGER NOT NULL, classifier_version INTEGER NOT NULL,
  UNIQUE(subject, queue, direction, source_seq, classifier_version));
CREATE TABLE IF NOT EXISTS classifier_activations(
  version INTEGER PRIMARY KEY, activated_at_journal_seq INTEGER NOT NULL, activated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS attachments(
  stable_id TEXT NOT NULL, platform TEXT NOT NULL, binding TEXT NOT NULL,
  observed_at INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(stable_id, platform));
CREATE TABLE IF NOT EXISTS incidents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, opened_at INTEGER NOT NULL,
  closed_at INTEGER, detail TEXT, UNIQUE(source, opened_at));
CREATE TABLE IF NOT EXISTS coverage_gaps(
  id INTEGER PRIMARY KEY AUTOINCREMENT, stable_id TEXT, emitter_id TEXT NOT NULL,
  from_seq INTEGER, from_at INTEGER, to_at INTEGER NOT NULL, reason TEXT NOT NULL);
`;

/** Full P1+P2 frozen DDL. */
export const SCHEMA_SQL_P2 = SCHEMA_SQL + "\n" + P2_DDL_SQL;

/** Open (or create) a ledger with the complete frozen P1+P2 schema. */
export function openLedgerP2(path: string): Database {
  const db = new Database(path);
  db.exec(SCHEMA_SQL_P2);
  return db;
}

/** Frozen column lists per P2 table (drift assertions; p2-freeze.md order).
 *  The notification outbox was removed after P4: it had no delivery daemon and
 *  no reader, so the baseline is re-frozen without it. */
export const FROZEN_P2_TABLES: Record<string, string[]> = {
  current: [
    "stable_id", "writer_id", "state", "queue", "q5_reason", "origin",
    "last_ingest_seq", "last_event_at", "last_heartbeat_at", "frozen",
  ],
  queue_transitions: [
    "id", "subject", "queue", "direction", "at", "source_seq", "classifier_version",
  ],
  classifier_activations: ["version", "activated_at_journal_seq", "activated_at"],
  attachments: ["stable_id", "platform", "binding", "observed_at", "valid"],
  incidents: ["id", "source", "opened_at", "closed_at", "detail"],
  coverage_gaps: ["id", "stable_id", "emitter_id", "from_seq", "from_at", "to_at", "reason"],
};

/** Frozen UNIQUE keys per P2 table (as column tuples). */
export const FROZEN_P2_UNIQUES: Record<string, string[][]> = {
  queue_transitions: [["subject", "queue", "direction", "source_seq", "classifier_version"]],
  attachments: [], // PRIMARY KEY(stable_id, platform) composite
  incidents: [["source", "opened_at"]],
};
