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
CREATE TABLE IF NOT EXISTS notifications(
  notification_uid INTEGER PRIMARY KEY AUTOINCREMENT, request_uid TEXT NOT NULL,
  sink TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('initial','reminder')),
  reminder_seq INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN('pending','attempting','sent','failed_permanent')),
  attempt_at INTEGER, sent_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(request_uid, sink, kind, reminder_seq));
CREATE TABLE IF NOT EXISTS attachments(
  stable_id TEXT NOT NULL, platform TEXT NOT NULL, binding TEXT NOT NULL,
  observed_at INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(stable_id, platform));
CREATE TABLE IF NOT EXISTS session_hosts(
  stable_id TEXT PRIMARY KEY, app TEXT NOT NULL, session_id TEXT, tty TEXT,
  observed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS incidents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, opened_at INTEGER NOT NULL,
  closed_at INTEGER, detail TEXT, UNIQUE(source, opened_at));
CREATE TABLE IF NOT EXISTS coverage_gaps(
  id INTEGER PRIMARY KEY AUTOINCREMENT, stable_id TEXT, emitter_id TEXT NOT NULL,
  from_seq INTEGER, from_at INTEGER, to_at INTEGER NOT NULL, reason TEXT NOT NULL);
-- requests.next_reminder_at is part of the P1 base DDL above, so the frozen
-- `ALTER TABLE requests ADD COLUMN next_reminder_at INTEGER` migration is skipped.

-- P4 (owner-frozen): cmux workstream source generations (tech-solution §2.9)
CREATE TABLE IF NOT EXISTS source_generations(
  path TEXT NOT NULL,
  generation_uuid TEXT PRIMARY KEY,
  dev_inode TEXT,
  head_fp TEXT, fp_len INTEGER,
  cursor_bytes INTEGER NOT NULL DEFAULT 0,
  cursor_tail_fp TEXT,
  first_seen INTEGER NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0);
