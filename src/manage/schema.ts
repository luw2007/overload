import { Database } from "bun:sqlite";
import { ControlError } from "../control/store";

export const MGMT_SCHEMA = `
-- 顺序即执行顺序。生产实现加 IF NOT EXISTS（此处省略以保持可读）。
-- SENS 在真实 DDL 中展开为 sensitivity TEXT NOT NULL DEFAULT 'unknown'
--                        + scanner_version INTEGER NOT NULL DEFAULT 0（§7.4）。
-- 描述性列（excerpt/actor/meta 等）保留但不逐一注释。
-- control_works 是 v1 已有表（src/control/store.ts:22-27），不重建。

-- ① 只引用 v1 既有表
CREATE TABLE IF NOT EXISTS mgmt_work_profile(work_id TEXT PRIMARY KEY REFERENCES control_works(work_id),
  origin_mode TEXT NOT NULL CHECK(origin_mode IN ('discovered','contract_governed')),
  closeout_owner TEXT NOT NULL CHECK(closeout_owner IN ('mgmt','coordinator','orchestrator')),
  track_state TEXT NOT NULL CHECK(track_state IN ('tracking','paused','archived')),
  decision_owner TEXT NOT NULL, discovered_title TEXT NOT NULL,
  input_head TEXT,               -- 无 FK：环已拆除，由 §12.2 不变式 ④ 强制
  archived_at INTEGER, archive_reason TEXT, updated_at INTEGER NOT NULL);
  -- 另有 repo_root/cwd/host/primary_agent/created_at
CREATE INDEX IF NOT EXISTS mgmt_work_profile_track ON mgmt_work_profile(track_state, updated_at);

CREATE TABLE IF NOT EXISTS mgmt_work_alias(alias_work_id TEXT PRIMARY KEY REFERENCES control_works(work_id),
  canonical_work_id TEXT NOT NULL REFERENCES control_works(work_id),
  reason TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL,
  CHECK(alias_work_id<>canonical_work_id));   -- §8.4，永不重写 artifact 身份

-- ② 只引用 profile
CREATE TABLE IF NOT EXISTS mgmt_session_binding(stable_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  role TEXT NOT NULL, evidence_ref TEXT NOT NULL, bound_at INTEGER NOT NULL);
  -- PK 保证一个 Session 最多属一个 Work。role: origin|child|resumed|successor|explicit|orch_runner

CREATE TABLE IF NOT EXISTS mgmt_inputs(input_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  kind TEXT NOT NULL, version INTEGER NOT NULL, supersedes TEXT REFERENCES mgmt_inputs(input_id),
  execution_id TEXT,             -- 无 FK：executions 尚未创建；由 §12.2 不变式 ⑤ 同样方式校验
  source TEXT, evidence_ref TEXT, excerpt TEXT, ref_uri TEXT, actor TEXT, at INTEGER NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'unknown', scanner_version INTEGER NOT NULL DEFAULT 0,
  UNIQUE(work_id,kind,version));
  -- kind ∈ user_message|reference|constraint|decision|approval|acceptance|feedback

CREATE TABLE IF NOT EXISTS mgmt_artifacts(artifact_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  kind TEXT NOT NULL, canonical_key TEXT NOT NULL, display_path TEXT, created_at INTEGER NOT NULL,
  UNIQUE(work_id,kind,canonical_key));   -- kind ∈ file|git_commit|git_dirty|external

-- ③ 引用 artifacts
CREATE TABLE IF NOT EXISTS mgmt_artifact_versions(version_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES mgmt_artifacts(artifact_id),
  content_kind TEXT NOT NULL CHECK(content_kind IN ('content','deleted','metadata_only')),
  content_sha256 TEXT NOT NULL, snapshot_path TEXT, staging_name TEXT,
  snapshot_state TEXT NOT NULL CHECK(snapshot_state IN
    ('pending','stored','lost','too_large','withheld_sensitive','pruned','reference_only','write_failed')),
  sensitivity TEXT NOT NULL DEFAULT 'unknown', scanner_version INTEGER NOT NULL DEFAULT 0, shareable INTEGER NOT NULL DEFAULT 0, producer TEXT NOT NULL,   -- <execution_id>|multiple|unknown
  history_available INTEGER NOT NULL DEFAULT 1, stale_capture INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL, evidence_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS mgmt_versions_artifact_version ON mgmt_artifact_versions(artifact_id, version_id);  -- P0-4 基础
CREATE INDEX IF NOT EXISTS mgmt_versions_artifact ON mgmt_artifact_versions(artifact_id, observed_at);

-- ④ 引用 profile + versions
CREATE TABLE IF NOT EXISTS mgmt_manifests(manifest_id TEXT PRIMARY KEY,   -- P1-7；= digest，只 INSERT
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  repo_root TEXT, git_head TEXT, git_tree_sha TEXT, base_ref TEXT, base_sha TEXT,
  verification TEXT NOT NULL, built_by TEXT NOT NULL, built_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS mgmt_manifest_entries(manifest_id TEXT NOT NULL REFERENCES mgmt_manifests(manifest_id),
  artifact_id TEXT NOT NULL, version_id TEXT NOT NULL,
  PRIMARY KEY(manifest_id, artifact_id), UNIQUE(manifest_id, version_id),
  FOREIGN KEY(artifact_id, version_id) REFERENCES mgmt_artifact_versions(artifact_id, version_id));
  -- ↑ 复合 FK 证明该 version 确属该 artifact（P0-4 核心缺口，已实测拒绝跨 artifact 引用）

-- ⑤ 引用 profile + binding + inputs + manifests（全部已创建）
CREATE TABLE IF NOT EXISTS mgmt_executions(execution_id TEXT PRIMARY KEY,   -- P1-5
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  stable_id TEXT NOT NULL REFERENCES mgmt_session_binding(stable_id),
  writer_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  exec_state TEXT NOT NULL CHECK(exec_state IN ('running','ended_ok','ended_failed','vanished','unknown')),
  source_coverage TEXT NOT NULL CHECK(source_coverage IN ('ledger_full','file_only','ledger_stale','gapped')),
  input_head_at_start TEXT REFERENCES mgmt_inputs(input_id),
  baseline_manifest_id TEXT REFERENCES mgmt_manifests(manifest_id),
  parent_handoff_id TEXT,        -- 无 FK：executions↔handoffs 环的降级端，§12.2 不变式 ⑤
  ledger_evidence TEXT NOT NULL, -- 跨库快照，§12.4
  closeout_evidence TEXT,        -- §9.8.0 派生终止证据；仅 ended_ok/ended_failed 时非空
  agent TEXT, cwd TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, last_observed_at INTEGER,
  UNIQUE(stable_id, writer_id, attempt_no));
CREATE INDEX IF NOT EXISTS mgmt_executions_work ON mgmt_executions(work_id, started_at);

-- ⑥ 引用 executions
CREATE TABLE IF NOT EXISTS mgmt_handoffs(handoff_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  source_execution_id TEXT NOT NULL REFERENCES mgmt_executions(execution_id),
  manifest_id TEXT REFERENCES mgmt_manifests(manifest_id), target_agent TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('ready_to_launch','stale','launching','launch_unknown','launch_failed','bound','ended','abandoned')),
  packet TEXT NOT NULL, packet_sha256 TEXT NOT NULL, workspace_fp TEXT NOT NULL,
  isolate INTEGER NOT NULL DEFAULT 0, override_reason TEXT, override_actor TEXT, new_stable_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS mgmt_handoffs_inflight ON mgmt_handoffs(work_id)   -- v1 漏掉 launch_unknown
  WHERE state IN ('ready_to_launch','launching','launch_unknown','bound');

CREATE TABLE IF NOT EXISTS mgmt_handoff_launch_attempts(attempt_id TEXT PRIMARY KEY,   -- P0-2 不可变尝试日志
  handoff_id TEXT NOT NULL REFERENCES mgmt_handoffs(handoff_id),
  idempotency_key TEXT NOT NULL UNIQUE, attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('requested','started','receipt_known','unknown','bound','abandoned','failed_no_effect')),
  command TEXT NOT NULL, command_args TEXT NOT NULL, target_cwd TEXT NOT NULL, target_surface TEXT,
  receipt TEXT, observed_pid INTEGER, observed_boot_id TEXT, bound_stable_id TEXT,
  reconciled_at INTEGER, reconcile_result TEXT, requested_at INTEGER NOT NULL, resolved_at INTEGER,
  UNIQUE(handoff_id, attempt_no));

CREATE TABLE IF NOT EXISTS mgmt_observations(observation_id INTEGER PRIMARY KEY AUTOINCREMENT,   -- P1-1 来源与身份解耦
  version_id TEXT NOT NULL REFERENCES mgmt_artifact_versions(version_id),
  execution_id TEXT REFERENCES mgmt_executions(execution_id), observed_source TEXT NOT NULL,
  evidence_ref TEXT NOT NULL, observed_at INTEGER NOT NULL, UNIQUE(version_id, evidence_ref));

CREATE TABLE IF NOT EXISTS mgmt_exec_records(record_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  execution_id TEXT NOT NULL REFERENCES mgmt_executions(execution_id), kind TEXT NOT NULL,
  source_ref TEXT NOT NULL UNIQUE, source_state TEXT NOT NULL DEFAULT 'available',
  tool TEXT, excerpt TEXT, is_error INTEGER, at INTEGER NOT NULL, sensitivity TEXT NOT NULL DEFAULT 'unknown', scanner_version INTEGER NOT NULL DEFAULT 0,
  shareable INTEGER NOT NULL DEFAULT 0);   -- **默认不可分享**（§7.4）

CREATE TABLE IF NOT EXISTS mgmt_external_effects(effect_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  execution_id TEXT REFERENCES mgmt_executions(execution_id), kind TEXT NOT NULL, target TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('observed','confirmed','unknown','superseded')),
  evidence_ref TEXT NOT NULL, reconcile_cmd TEXT, reconciled_at INTEGER, observed_at INTEGER NOT NULL,
  UNIQUE(work_id, kind, target, idempotency_key));

CREATE TABLE IF NOT EXISTS mgmt_links(link_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('strong','weak','uncertain')),
  evidence_ref TEXT NOT NULL, observed_at INTEGER NOT NULL,
  supersedes TEXT REFERENCES mgmt_links(link_id), superseded_at INTEGER, actor TEXT, reason TEXT,
  UNIQUE(subject,relation,object,evidence_ref));
CREATE INDEX IF NOT EXISTS mgmt_links_object ON mgmt_links(object, relation);

-- ⑦ 引用 manifests / acceptances
CREATE TABLE IF NOT EXISTS mgmt_acceptances(acceptance_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  manifest_id TEXT NOT NULL REFERENCES mgmt_manifests(manifest_id),
  verdict TEXT NOT NULL CHECK(verdict IN ('accepted','rejected')), actor TEXT NOT NULL,
  evidence TEXT NOT NULL, invalidated_at INTEGER, invalidated_reason TEXT,
  UNIQUE(manifest_id, verdict, actor));

CREATE TABLE IF NOT EXISTS mgmt_submissions(submission_id TEXT PRIMARY KEY,
  acceptance_id TEXT NOT NULL REFERENCES mgmt_acceptances(acceptance_id),
  manifest_id TEXT NOT NULL REFERENCES mgmt_manifests(manifest_id),
  target_kind TEXT NOT NULL, target TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','pushed','pr_created','merged','failed','unsupported')),
  steps TEXT NOT NULL, external_ref TEXT,
  submitted_manifest_digest TEXT NOT NULL,   -- 生效瞬间重算值，供审计
  idempotency_key TEXT UNIQUE);

CREATE TABLE IF NOT EXISTS mgmt_work_hints(work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  other_work_id TEXT NOT NULL, reason TEXT NOT NULL, score REAL, created_at INTEGER NOT NULL,
  PRIMARY KEY(work_id, other_work_id, reason));

-- ⑧ 无外键辅助表（顺序任意）
CREATE TABLE IF NOT EXISTS mgmt_corrections(evidence_ref TEXT PRIMARY KEY, decided_at INTEGER NOT NULL,
  actor TEXT NOT NULL, reason TEXT);   -- 阻止采集器自动恢复已被人纠错的关联
CREATE TABLE IF NOT EXISTS mgmt_summaries(subject_id TEXT NOT NULL, subject_version TEXT NOT NULL, generator TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(subject_id, subject_version, generator));
CREATE TABLE IF NOT EXISTS mgmt_cursors(source_key TEXT PRIMARY KEY, cursor TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0, last_status TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS mgmt_discovery_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  stable_id TEXT, reason TEXT NOT NULL, detail TEXT);
`;

export function ensureMgmtSchema(db: Database): void { db.exec(MGMT_SCHEMA); }

export function setInputHead(db: Database, workId: string, inputId: string): void {
  const result = db.query("UPDATE mgmt_work_profile SET input_head=?,updated_at=? WHERE work_id=? AND EXISTS(SELECT 1 FROM mgmt_inputs WHERE input_id=? AND work_id=?)").run(inputId, Date.now(), workId, inputId, workId);
  if (result.changes !== 1) throw new ControlError("conflict", "input_head_target_missing");
}

export function setParentHandoff(db: Database, executionId: string, handoffId: string): void {
  const result = db.query("UPDATE mgmt_executions SET parent_handoff_id=? WHERE execution_id=? AND parent_handoff_id IS NULL AND EXISTS(SELECT 1 FROM mgmt_handoffs WHERE handoff_id=? AND work_id=mgmt_executions.work_id)").run(handoffId, executionId, handoffId);
  if (result.changes !== 1) throw new ControlError("conflict", "parent_handoff_target_missing");
}
