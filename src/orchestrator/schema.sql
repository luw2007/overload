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
