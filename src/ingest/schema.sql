PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;

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
  created_at INTEGER, resolved_at INTEGER, next_reminder_at INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS reducer_cursor(id INTEGER PRIMARY KEY CHECK(id=1), journal_seq INTEGER NOT NULL);

CREATE INDEX IF NOT EXISTS journal_stable_id_ingest_seq ON journal(stable_id, ingest_seq);
CREATE INDEX IF NOT EXISTS requests_stable_id_state ON requests(stable_id, state);
CREATE INDEX IF NOT EXISTS incarnations_stable_id_started_at ON session_incarnations(stable_id, started_at);
