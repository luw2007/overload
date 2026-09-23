PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS tasks(
  task_id TEXT PRIMARY KEY, title TEXT NOT NULL, repo TEXT NOT NULL, base_ref TEXT NOT NULL,
  worktree TEXT, branch TEXT, state TEXT NOT NULL,
  attempt_id TEXT,                  -- 每次 spawn 前生成并持久化（spawn-before-record 防护）
  owner_instance TEXT,              -- orchestrator 实例 id（启动时 randomUUID）
  lease_expires_at INTEGER, heartbeat_at INTEGER,
  runner_pid INTEGER, runner_boot_id TEXT,   -- 绑定后由 ledger 回填
  retry_budget INTEGER NOT NULL DEFAULT 2,
  stable_id TEXT, pr_url TEXT, blocked_reason TEXT, terminal_reason TEXT,
  work_id TEXT, contract_revision INTEGER, budget_deadline_at INTEGER,
  ci_observation_failures INTEGER NOT NULL DEFAULT 0,
  stop_state TEXT CHECK(stop_state IN ('stop_requested','stopped_confirmed','stop_unconfirmed')),
  stop_requested_at INTEGER,
  stop_deadline_at INTEGER,
  stop_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- queued 不持锁；活跃态每 repo 至多一个，由 DB 强制而非查询强制。
CREATE UNIQUE INDEX IF NOT EXISTS tasks_repo_active ON tasks(repo)
  WHERE state IN ('starting','running','awaiting_human','submitted');

CREATE TABLE IF NOT EXISTS task_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);

CREATE TABLE IF NOT EXISTS approvals(
  approval_id TEXT PRIMARY KEY,     -- 同时是 spool 事件的 request_id
  task_id TEXT NOT NULL, gate TEXT NOT NULL CHECK(gate IN ('ready','ci_anomaly','confirm_stopped','keep_held')),
  question TEXT NOT NULL, options TEXT NOT NULL,   -- JSON 白名单
  requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, actor TEXT);                -- 'ui' | 'cli'；消费即转移，不双写 answer

CREATE TABLE IF NOT EXISTS spool_seq(id INTEGER PRIMARY KEY CHECK(id=1),
  seq INTEGER NOT NULL, segment INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS task_recovery(
  task_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  spawn_state TEXT NOT NULL CHECK(spawn_state IN ('intent','spawned','failed')),
  spawn_at INTEGER NOT NULL,
  unknown_ticks INTEGER NOT NULL DEFAULT 0);

-- Receipt application is local, transactional execution fact. It is deliberately
-- separate from mailbox applied_at, which is only a rebuildable projection.
CREATE TABLE IF NOT EXISTS applied_receipts(
  receipt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, answer TEXT NOT NULL,
  applied_at INTEGER NOT NULL, result TEXT NOT NULL);

-- Local intent is written atomically with approval/state facts. A retry repairs
-- the independent mailbox/control DB and emits the durable control event.
CREATE TABLE IF NOT EXISTS approval_intents(
  approval_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, gate TEXT NOT NULL,
  question TEXT NOT NULL, options TEXT NOT NULL, expires_at INTEGER NOT NULL,
  evidence TEXT NOT NULL, created_at INTEGER NOT NULL, repaired_at INTEGER,
  control_event_id TEXT);

-- Context collector 持久化去重 cursor（替代进程重启即丢失的内存 Map）。
-- key = source_event_id；记录已发出的 observation_revision 与 content_hash。
-- 同 source_event_id + 同 content_hash → 跳过（不重复发）。
-- 同 source_event_id + 异 content_hash → revision+1。
CREATE TABLE IF NOT EXISTS context_collector_cursor(
  source_event_id TEXT PRIMARY KEY,
  observation_revision INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  last_collected_at INTEGER NOT NULL
);

-- 异常信号采样：按窗追加、只增不改
CREATE TABLE IF NOT EXISTS attempt_signal_samples(
  sample_id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  window_at INTEGER NOT NULL,
  commit_count INTEGER NOT NULL DEFAULT 0,
  diff_added INTEGER NOT NULL DEFAULT 0,
  diff_deleted INTEGER NOT NULL DEFAULT 0,
  result_set_version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_signal_samples_work ON attempt_signal_samples(work_id, window_at);
CREATE INDEX IF NOT EXISTS idx_signal_samples_attempt ON attempt_signal_samples(attempt_id, window_at);

-- 逐项检查结果：保存每次检查的可恢复事实
CREATE TABLE IF NOT EXISTS attempt_check_results(
  result_set_version INTEGER NOT NULL,
  work_id TEXT,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pass','fail','unknown','not_run')),
  fingerprint TEXT,
  check_def_version TEXT,
  evidence_ref TEXT,
  PRIMARY KEY(result_set_version, check_id)
);
CREATE INDEX IF NOT EXISTS idx_check_results_work ON attempt_check_results(work_id, observed_at);

-- work 级异常预算：新 attempt 继承，clean_restart 不重置
CREATE TABLE IF NOT EXISTS work_anomaly_budget(
  work_id TEXT PRIMARY KEY,
  budget_version INTEGER NOT NULL DEFAULT 1,
  fingerprint TEXT,
  fix_rounds_consumed INTEGER NOT NULL DEFAULT 0,
  trigger_count INTEGER NOT NULL DEFAULT 0,
  continuation_windows_remaining INTEGER NOT NULL DEFAULT 0,
  last_progress_result_version INTEGER,
  updated_at INTEGER NOT NULL
);

-- 异常决策卡 outbox：与 stop_state/events/预算在同一 orchestrator DB 事务提交。
-- 崩溃后由 repairAnomalyIntents 投影到独立的 answers/control DB，避免重复投影或丢卡。
CREATE TABLE IF NOT EXISTS anomaly_card_intents(
  item_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  work_id TEXT,
  signal_kind TEXT NOT NULL,
  fingerprint TEXT,
  stop_state TEXT NOT NULL,
  evidence TEXT NOT NULL,
  threshold_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  repaired_at INTEGER,
  control_event_id TEXT
);
