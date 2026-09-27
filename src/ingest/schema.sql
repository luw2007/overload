PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS journal(
  ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL, emitter_id TEXT NOT NULL, seq INTEGER NOT NULL,
  at INTEGER NOT NULL, stable_id TEXT NOT NULL, writer_id TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT, spool_ref TEXT,
  UNIQUE(host, emitter_id, seq)
);
CREATE TABLE IF NOT EXISTS journal_7d(
  ingest_seq INTEGER PRIMARY KEY, host TEXT NOT NULL, emitter_id TEXT NOT NULL, seq INTEGER NOT NULL,
  at INTEGER NOT NULL, stable_id TEXT NOT NULL, writer_id TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT, spool_ref TEXT, UNIQUE(host, emitter_id, seq)
);
CREATE TABLE IF NOT EXISTS journal_30d(
  ingest_seq INTEGER PRIMARY KEY, host TEXT NOT NULL, emitter_id TEXT NOT NULL, seq INTEGER NOT NULL,
  at INTEGER NOT NULL, stable_id TEXT NOT NULL, writer_id TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT, spool_ref TEXT, UNIQUE(host, emitter_id, seq)
);
CREATE VIEW IF NOT EXISTS journal_all AS
  SELECT * FROM journal UNION ALL SELECT * FROM journal_7d UNION ALL SELECT * FROM journal_30d;
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

-- Durable business-event dedup and ledger-only attention projection. Source
-- control state stays in control DB; this projection is audit/notification data.
CREATE TABLE IF NOT EXISTS applied_control_events(
  event_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, applied_at INTEGER NOT NULL
);
-- Terminal reducer verdict for a control event that can never apply (verification failure, projection conflict,
-- deterministic data error). Keyed by event_id so republished copies are skipped and yield exactly one coverage
-- gap; the publisher reads it to stop re-leasing. payload_hash is NULL when the envelope carried none.
CREATE TABLE IF NOT EXISTS rejected_control_events(
  event_id TEXT PRIMARY KEY, payload_hash TEXT, reason TEXT NOT NULL,
  ingest_seq INTEGER NOT NULL, rejected_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS control_attention(
  item_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, revision INTEGER NOT NULL,
  state TEXT NOT NULL, effect_state TEXT NOT NULL, effect_detail TEXT, urgency TEXT NOT NULL, owner TEXT NOT NULL,
  conclusion TEXT NOT NULL, trigger TEXT NOT NULL, impact TEXT NOT NULL, recommendation TEXT,
  options TEXT NOT NULL, expires_at INTEGER, defer_until INTEGER, acknowledged_at INTEGER,
  source_link TEXT, approval_id TEXT, consumer_owner TEXT, contract_revision INTEGER NOT NULL,
  decision_mode TEXT NOT NULL, evidence TEXT NOT NULL, event_id TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS control_attention_zone ON control_attention(state,urgency,defer_until,updated_at);
CREATE INDEX IF NOT EXISTS control_attention_work ON control_attention(work_id,updated_at);
CREATE TABLE IF NOT EXISTS control_attention_feedback(
  event_id TEXT PRIMARY KEY, item_id TEXT NOT NULL, revision INTEGER NOT NULL,
  useful INTEGER NOT NULL, reason TEXT, created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS journal_stable_id_ingest_seq ON journal(stable_id, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_7d_stable_id_ingest_seq ON journal_7d(stable_id, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_30d_stable_id_ingest_seq ON journal_30d(stable_id, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_at_seq ON journal(at, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_7d_at_seq ON journal_7d(at, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_emitter_at ON journal(emitter_id, at);
CREATE INDEX IF NOT EXISTS journal_7d_emitter_at ON journal_7d(emitter_id, at);
CREATE INDEX IF NOT EXISTS journal_30d_emitter_at ON journal_30d(emitter_id, at);
CREATE INDEX IF NOT EXISTS journal_host_at ON journal(host, at);
CREATE INDEX IF NOT EXISTS journal_stable_writer_kind ON journal(stable_id, writer_id, kind);
CREATE INDEX IF NOT EXISTS journal_7d_stable_writer_kind ON journal_7d(stable_id, writer_id, kind);
CREATE INDEX IF NOT EXISTS journal_30d_stable_writer_kind ON journal_30d(stable_id, writer_id, kind);
CREATE INDEX IF NOT EXISTS journal_finding ON journal(kind, json_extract(detail, '$.emitter_id'), at);
CREATE INDEX IF NOT EXISTS journal_7d_finding ON journal_7d(kind, json_extract(detail, '$.emitter_id'), at);
CREATE INDEX IF NOT EXISTS journal_30d_finding ON journal_30d(kind, json_extract(detail, '$.emitter_id'), at);
-- Kind lookups (dashboard health/hung, recon findings, effect reconcile) seek by
-- kind instead of scanning the journal; the (stable_id, kind) index keeps per-session
-- kind lookups (latest settled, session_ended, session_started) on an exact seek so
-- the planner never trades the stable_id prefix for a kind-wide scan.
CREATE INDEX IF NOT EXISTS journal_kind_ingest_seq ON journal(kind, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_stable_id_kind_ingest_seq ON journal(stable_id, kind, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_7d_kind_ingest_seq ON journal_7d(kind, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_30d_kind_ingest_seq ON journal_30d(kind, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_7d_stable_id_kind_ingest_seq ON journal_7d(stable_id, kind, ingest_seq);
CREATE INDEX IF NOT EXISTS journal_30d_stable_id_kind_ingest_seq ON journal_30d(stable_id, kind, ingest_seq);
CREATE INDEX IF NOT EXISTS requests_stable_id_state ON requests(stable_id, state);
CREATE INDEX IF NOT EXISTS incarnations_stable_id_started_at ON session_incarnations(stable_id, started_at);

CREATE TABLE IF NOT EXISTS current(
  stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT NOT NULL,
  queue TEXT, q5_reason TEXT, origin TEXT NOT NULL DEFAULT 'unknown',
  last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER,
  -- Liveness (heartbeat) and progress (tool_activity/working/settled) are
  -- separate axes: a hung turn keeps heartbeating while progress stands still.
  last_progress_at INTEGER);
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
