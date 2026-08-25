/**
 * Frozen ledger DDL — transcribed verbatim from docs/contracts/p1-freeze.md.
 * Field names and UNIQUE constraints are frozen; N2 must implement an identical
 * schema. N3 tests assert against THIS shape (the contract), not against N2 code.
 *
 * WAL pragmas + indexes follow §2.7 ("WAL; ingest 批 + cursor 同事务").
 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS journal(
  ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL, emitter_id TEXT NOT NULL, seq INTEGER NOT NULL,
  at INTEGER NOT NULL, stable_id TEXT NOT NULL, writer_id TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT, spool_ref TEXT,
  UNIQUE(host, emitter_id, seq)
);
CREATE TABLE IF NOT EXISTS cursors(file_name TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT,
  session TEXT, origin TEXT DEFAULT 'unknown', cwd TEXT, branch TEXT,
  created_at INTEGER, first_seen_at INTEGER);
CREATE TABLE IF NOT EXISTS session_incarnations(stable_id TEXT, writer_id TEXT,
  liveness_domain TEXT CHECK(liveness_domain IN ('process','lifecycle')),
  pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER,
  PRIMARY KEY(stable_id, writer_id));
CREATE TABLE IF NOT EXISTS requests(request_uid TEXT PRIMARY KEY, stable_id TEXT, writer_id TEXT,
  origin_emitter_id TEXT, request_id TEXT, kind TEXT, state TEXT,
  created_at INTEGER, resolved_at INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS reducer_cursor(id INTEGER PRIMARY KEY CHECK(id=1), journal_seq INTEGER NOT NULL);

-- Support indexes (frozen names come from the UNIQUE/PK; these are auxiliary).
CREATE INDEX IF NOT EXISTS idx_journal_kind     ON journal(kind);
CREATE INDEX IF NOT EXISTS idx_journal_stable    ON journal(stable_id);
CREATE INDEX IF NOT EXISTS idx_requests_stable   ON requests(stable_id);
CREATE INDEX IF NOT EXISTS idx_requests_state    ON requests(state);

-- reducer_cursor seed row (id=1 is the only legal row).
INSERT OR IGNORE INTO reducer_cursor(id, journal_seq) VALUES (1, 0);
`;
