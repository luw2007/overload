import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, controlPayloadHash, enqueueControlEvent, ensureOutbox } from "./outbox";
import { ensureMgmtSchema } from "../manage/schema";
import { ensureRootProblem, rootProblemId } from "./context-pool";
import { ensureContextReducerSchema } from "./context-reducer";
import type { EffectObservation } from "../decision-bot/mailbox";
import type {
  AffectedAttentionCard, AttentionAuditLink, AttentionCardSnapshot, AttentionDecisionInput,
  AttentionFollowUp, AttentionItem, AttentionMaterialProjection, AttentionZone, CheckBaseline, ConditionWait, Contract,
  ContractRevisionPreview, CreateWaitInput, DecisionOption, MaterialFingerprintInputs, PrBaseline,
  RecoveryDispatchResult, StaleAttentionBody, WaitBaseline, WaitBaselineSnapshot, WaitCondition, WaitConflictBody,
  WaitDispositionInput, WaitDispositionState, WaitErrorKind, WaitObservation, WaitResumeGrant, WaitState, Work,
  WorkBaseline, WorkDependencyEdge,
} from "./types";

export {
  type AffectedAttentionCard, type AttentionAuditLink, type AttentionCardSnapshot,
  type AttentionDecisionInput, type AttentionFollowUp, type AttentionItem,
  type AttentionMaterialProjection, type AttentionZone, type Contract,
  type ContractRevisionPreview, type DecisionOption, type MaterialFingerprintInputs,
  type StaleAttentionBody, type Work,
} from "./types";
export { ensureOutbox, enqueueControlEvent, publishControlEvents } from "./outbox";
export { applyControlEvent } from "./projection";
import { workDependencyEntityId } from "./projection";

export class ControlError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid" | "blocked" | "forbidden",
    message: string,
    public readonly details?: StaleAttentionBody | WaitConflictBody,
  ) { super(message); this.name = "ControlError"; }
}

export const CONTROL_SCHEMA_VERSION = 8;
export const CONTROL_SCHEMA = `
CREATE TABLE IF NOT EXISTS control_schema_meta(
  id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, migrated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS control_works(
  work_id TEXT PRIMARY KEY,title TEXT NOT NULL,source TEXT NOT NULL,source_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('candidate','active','stopped','completed')),
  revision INTEGER NOT NULL,contract TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS control_works_source ON control_works(source,source_id) WHERE source_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS control_contract_revisions(
  work_id TEXT NOT NULL,revision INTEGER NOT NULL,contract TEXT NOT NULL,reason TEXT NOT NULL,created_at INTEGER NOT NULL,
  PRIMARY KEY(work_id,revision)
);
CREATE TABLE IF NOT EXISTS control_attention(
  item_id TEXT PRIMARY KEY,work_id TEXT NOT NULL,revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','applying','resolved','superseded')),
  effect_state TEXT NOT NULL CHECK(effect_state IN ('not_started','applying','succeeded','failed','unknown')),effect_detail TEXT,
  urgency TEXT NOT NULL CHECK(urgency IN ('now','inbox')),conclusion TEXT NOT NULL,trigger TEXT NOT NULL,
  impact TEXT NOT NULL,recommendation TEXT,options TEXT NOT NULL,owner TEXT NOT NULL,expires_at INTEGER,
  defer_until INTEGER,acknowledged_at INTEGER,source_link TEXT,approval_id TEXT,consumer_owner TEXT,
  contract_revision INTEGER NOT NULL,decision_mode TEXT NOT NULL CHECK(decision_mode IN ('human_only','scoped_auto')),
  evidence TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS control_attention_work ON control_attention(work_id,state,updated_at);
CREATE TABLE IF NOT EXISTS control_attention_events(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,item_id TEXT NOT NULL,revision INTEGER NOT NULL,
  kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS control_feedback(
  item_id TEXT NOT NULL,revision INTEGER NOT NULL,useful INTEGER NOT NULL,reason TEXT,created_at INTEGER NOT NULL,
  PRIMARY KEY(item_id,revision)
);
CREATE TABLE IF NOT EXISTS control_redirects(
  work_id TEXT NOT NULL,revision INTEGER NOT NULL,reason TEXT NOT NULL,affected_work_ids TEXT NOT NULL,
  action TEXT NOT NULL,evidence TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(work_id,revision)
);`;

const CONTROL_V6_SCHEMA = `
CREATE TABLE IF NOT EXISTS control_attention_material (
  item_id TEXT PRIMARY KEY,
  material_key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation >= 1),
  inputs TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY(item_id) REFERENCES control_attention(item_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS control_attention_material_key
  ON control_attention_material(material_key);

CREATE TABLE IF NOT EXISTS control_notifications (
  notification_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  material_key TEXT NOT NULL,
  threshold TEXT NOT NULL CHECK(threshold IN ('new_now','material_change','expires_soon','expired')),
  channel TEXT NOT NULL CHECK(channel IN ('macos','feishu')),
  outcome TEXT NOT NULL CHECK(outcome IN ('shadowed','pending','sent','failed','unknown','suppressed')),
  owner_epoch TEXT NOT NULL,
  work_id TEXT,
  item_id TEXT,
  item_revision INTEGER,
  approval_id TEXT,
  receipt_id TEXT,
  outbox_event_id TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('attention','legacy_q1','legacy_hung')),
  source_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  attempted_at INTEGER,
  completed_at INTEGER,
  UNIQUE(subject, material_key, threshold, owner_epoch)
);
CREATE INDEX IF NOT EXISTS control_notifications_due
  ON control_notifications(outcome, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS control_notifications_item
  ON control_notifications(item_id, item_revision, created_at);

CREATE TABLE IF NOT EXISTS control_notification_shadow (
  comparison_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  material_key TEXT NOT NULL,
  threshold TEXT NOT NULL,
  legacy_would_send INTEGER NOT NULL CHECK(legacy_would_send IN (0,1)),
  candidate_would_send INTEGER NOT NULL CHECK(candidate_would_send IN (0,1)),
  legacy_reason TEXT NOT NULL,
  candidate_reason TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('attention','legacy_q1','legacy_hung')),
  source_id TEXT NOT NULL,
  item_id TEXT,
  item_revision INTEGER,
  compared_at INTEGER NOT NULL,
  UNIQUE(subject, material_key, threshold)
);`;

// 上下文对象池（T1）：建表顺序按外键依赖 problems → objects → versions → problem_objects → pins → shares。
// 全部 CREATE TABLE IF NOT EXISTS，不 ALTER 旧表；外键需 PRAGMA foreign_keys=ON。
export const CONTEXT_SCHEMA = `
CREATE TABLE IF NOT EXISTS control_context_problems(
  problem_id         TEXT PRIMARY KEY,
  work_id            TEXT NOT NULL,
  parent_problem_id  TEXT,
  root_problem_id    TEXT NOT NULL,
  title              TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','superseded')),
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (parent_problem_id IS NULL OR parent_problem_id != problem_id),
  FOREIGN KEY (parent_problem_id) REFERENCES control_context_problems(problem_id)
);
CREATE INDEX IF NOT EXISTS idx_context_problems_work ON control_context_problems(work_id, root_problem_id);
CREATE TABLE IF NOT EXISTS control_context_objects(
  object_id              TEXT PRIMARY KEY,
  work_id                TEXT NOT NULL,
  primary_problem_id     TEXT,
  ctype                  TEXT NOT NULL CHECK (ctype IN ('objective','constraints','fact','decision','artifact','scene')),
  fact_subtype           TEXT CHECK (fact_subtype IS NULL OR fact_subtype IN ('code_state','test_result','external_state','observation_evidence')),
  revision               INTEGER NOT NULL DEFAULT 1,
  purged_at              TEXT,
  tombstone_reason       TEXT,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (ctype != 'fact' OR fact_subtype IS NOT NULL),
  CHECK (ctype = 'fact' OR fact_subtype IS NULL),
  CHECK (purged_at IS NULL OR tombstone_reason IS NOT NULL),
  FOREIGN KEY (primary_problem_id) REFERENCES control_context_problems(problem_id)
);
CREATE TABLE IF NOT EXISTS control_context_object_versions(
  object_id              TEXT NOT NULL,
  revision               INTEGER NOT NULL,
  reference              TEXT NOT NULL,
  source_type            TEXT NOT NULL,
  sensitivity            TEXT NOT NULL DEFAULT 'unknown' CHECK (sensitivity IN ('unknown','clean','suspected','confirmed_secret')),
  shareable              INTEGER NOT NULL DEFAULT 0,
  expires_at             INTEGER,
  staleness_ms           INTEGER,
  collected_at           INTEGER,
  derived_from           TEXT,
  summary_short          TEXT,
  summary_long           TEXT,
  content_hash           TEXT NOT NULL,
  created_at             INTEGER NOT NULL,
  PRIMARY KEY (object_id, revision),
  FOREIGN KEY (object_id) REFERENCES control_context_objects(object_id)
);
CREATE TABLE IF NOT EXISTS control_context_problem_objects(
  problem_id         TEXT NOT NULL,
  object_id          TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  role               TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (problem_id, object_id, role),
  FOREIGN KEY (problem_id) REFERENCES control_context_problems(problem_id),
  FOREIGN KEY (object_id, revision) REFERENCES control_context_object_versions(object_id, revision)
);
CREATE TABLE IF NOT EXISTS control_context_pins(
  pin_id             TEXT PRIMARY KEY,
  object_id          TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  pinned_by          TEXT NOT NULL,
  purpose            TEXT NOT NULL CHECK (purpose IN ('decision_evidence','recovery_checkpoint','other')),
  expires_at         INTEGER,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (object_id, revision) REFERENCES control_context_object_versions(object_id, revision)
);
CREATE TABLE IF NOT EXISTS control_context_shares(
  share_id           TEXT PRIMARY KEY,
  object_id          TEXT NOT NULL,
  revision           INTEGER NOT NULL,
  shared_with_work   TEXT NOT NULL,
  granted_by         TEXT NOT NULL,
  granted_at         INTEGER NOT NULL,
  UNIQUE (object_id, revision, shared_with_work),
  FOREIGN KEY (object_id, revision) REFERENCES control_context_object_versions(object_id, revision)
);`;

/** v7 (Phase B §3.2): canonical wait + prerequisite-edge DDL, verbatim from the frozen contract. */
const CONTROL_V7_SCHEMA = `
CREATE TABLE IF NOT EXISTS control_waits (
  wait_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  item_id TEXT NOT NULL,

  condition_kind TEXT NOT NULL
    CHECK (condition_kind IN ('github_pr_merged','check_new_result','work_completed')),
  condition_json TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  source_identity_hash TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  baseline_established_at INTEGER NOT NULL,
  baseline_generation INTEGER NOT NULL CHECK (baseline_generation >= 0),
  source_generation INTEGER NOT NULL CHECK (source_generation >= baseline_generation),

  observed_json TEXT,
  observed_fingerprint TEXT,
  observed_generation INTEGER NOT NULL DEFAULT 0 CHECK (observed_generation >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  last_observed_at INTEGER,
  last_confirmed_at INTEGER,
  state TEXT NOT NULL DEFAULT 'watching'
    CHECK (state IN ('watching','ready','unavailable','expired','cancelled')),
  state_reason TEXT,
  ready_at INTEGER,
  ready_observation_fingerprint TEXT,

  deadline_at INTEGER NOT NULL,
  next_check_at INTEGER,
  transient_failures INTEGER NOT NULL DEFAULT 0 CHECK (transient_failures >= 0),
  transient_budget INTEGER NOT NULL DEFAULT 3 CHECK (transient_budget BETWEEN 1 AND 3),
  last_error_kind TEXT
    CHECK (last_error_kind IS NULL OR last_error_kind IN
      ('transient','rate_limited','permission_denied','unsupported_provider',
       'configuration','invalid_response','identity_mismatch','source_missing','unknown')),
  last_error_detail TEXT,
  retry_after_at INTEGER,

  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor TEXT NOT NULL,
  decision_owner TEXT NOT NULL,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('redecide','authorized_resume')),
  authorization_json TEXT,

  disposition_state TEXT
    CHECK (disposition_state IS NULL OR disposition_state IN
      ('pending','redecision_recorded','dispatching','dispatched',
       'effect_succeeded','effect_failed','effect_unknown')),
  disposition_claim_id TEXT,
  dispatch_id TEXT,
  disposition_detail TEXT,
  disposition_at INTEGER,
  effect_observed_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (work_id) REFERENCES control_works(work_id),
  FOREIGN KEY (item_id) REFERENCES control_attention(item_id),
  CHECK (json_valid(condition_json)),
  CHECK (json_valid(source_identity)),
  CHECK (json_valid(baseline_json)),
  CHECK (observed_json IS NULL OR json_valid(observed_json)),
  CHECK (deadline_at > created_at),
  CHECK (next_check_at IS NULL OR (next_check_at >= created_at AND next_check_at < deadline_at)),
  CHECK (baseline_established_at <= created_at),
  CHECK (last_observed_at IS NULL OR last_observed_at >= baseline_established_at),
  CHECK (last_confirmed_at IS NULL OR last_confirmed_at >= baseline_established_at),
  CHECK (last_confirmed_at IS NULL OR last_observed_at IS NOT NULL),
  CHECK (ready_at IS NULL OR ready_at >= created_at),
  CHECK (retry_after_at IS NULL OR retry_after_at <= deadline_at),
  CHECK (length(wait_id) > 0 AND length(work_id) > 0 AND length(item_id) > 0),
  CHECK (length(source_identity_hash) = 64),
  CHECK (length(actor) > 0 AND length(decision_owner) > 0),
  CHECK (state_reason IS NULL OR length(state_reason) <= 500),
  CHECK (last_error_detail IS NULL OR length(last_error_detail) <= 2000),
  CHECK ((disposition='redecide' AND authorization_json IS NULL) OR
         (disposition='authorized_resume' AND authorization_json IS NOT NULL)),
  CHECK (authorization_json IS NULL OR json_valid(authorization_json)),
  CHECK (disposition_detail IS NULL OR json_valid(disposition_detail)),
  CHECK ((state='ready' AND ready_at IS NOT NULL AND
          ready_observation_fingerprint IS NOT NULL AND next_check_at IS NULL) OR
         (state<>'ready' AND ready_at IS NULL AND
          ready_observation_fingerprint IS NULL)),
  CHECK ((state='watching' AND next_check_at IS NOT NULL) OR
         (state<>'watching' AND next_check_at IS NULL)),
  CHECK ((state IN ('watching','cancelled') AND disposition_state IS NULL) OR
         (state IN ('ready','unavailable','expired') AND disposition_state IS NOT NULL)),
  CHECK (state='ready' OR disposition_state NOT IN
         ('dispatching','dispatched','effect_succeeded','effect_failed','effect_unknown')),
  CHECK ((disposition_state IN ('dispatching','dispatched','effect_succeeded',
          'effect_failed','effect_unknown') AND disposition_claim_id IS NOT NULL
          AND dispatch_id IS NOT NULL) OR
         (disposition_state IS NULL OR disposition_state IN ('pending','redecision_recorded'))),
  CHECK (disposition_at IS NULL OR disposition_at >= created_at),
  CHECK (effect_observed_at IS NULL OR effect_observed_at >= created_at),
  CHECK (disposition_state <> 'redecision_recorded' OR disposition_at IS NOT NULL),
  CHECK (disposition_state NOT IN ('effect_succeeded','effect_failed','effect_unknown')
         OR effect_observed_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS control_waits_exact_unsettled
  ON control_waits(work_id, item_id, condition_kind, source_identity_hash)
  WHERE state='watching' OR disposition_state IN ('pending','dispatching','dispatched','effect_failed','effect_unknown');

CREATE INDEX IF NOT EXISTS control_waits_due
  ON control_waits(next_check_at, wait_id)
  WHERE state='watching';

CREATE INDEX IF NOT EXISTS control_waits_item
  ON control_waits(item_id, updated_at DESC, wait_id DESC);

CREATE INDEX IF NOT EXISTS control_waits_work
  ON control_waits(work_id, updated_at DESC, wait_id DESC);

CREATE TABLE IF NOT EXISTS control_work_dependencies (
  work_id TEXT NOT NULL,
  prerequisite_work_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (work_id, prerequisite_work_id),
  FOREIGN KEY (work_id) REFERENCES control_works(work_id),
  FOREIGN KEY (prerequisite_work_id) REFERENCES control_works(work_id),
  CHECK (work_id <> prerequisite_work_id)
);

CREATE INDEX IF NOT EXISTS control_work_dependencies_prerequisite
  ON control_work_dependencies(prerequisite_work_id, state, work_id);
`;

function controlSchemaVersion(db:Database):number {
  const exists=db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='control_schema_meta'").get();
  if(!exists)return 0;
  const version=(db.query("SELECT version FROM control_schema_meta WHERE id=1").get() as {version:number}|null)?.version;
  if(version===undefined||!Number.isSafeInteger(version)||version<1)throw new ControlError("blocked","invalid control schema version");
  return version;
}
function databasePath(db:Database):string|null {
  const row=(db.query("PRAGMA database_list").all() as Array<{name:string;file:string}>).find(entry=>entry.name==="main");
  return row?.file&&row.file!==":memory:"?row.file:null;
}
function backupForDestructiveMigration(db:Database,from:number,to:number):string|null {
  const path=databasePath(db);if(!path)return null;
  const backup=`${path}.control-v${from}-to-v${to}-${Date.now()}.bak`;db.query("VACUUM INTO ?").run(backup);chmodSync(backup,0o600);return backup;
}
type ControlMigration={to:number;destructive:boolean;apply(db:Database):void};
const CONTROL_MIGRATIONS:ControlMigration[]=[
  {to:1,destructive:false,apply(db){db.exec(CONTROL_SCHEMA);ensureOutbox(db);db.query("INSERT INTO control_schema_meta(id,version,migrated_at) VALUES (1,?,?)").run(1,Date.now());}},
  {to:2,destructive:false,apply(db){ensureMgmtSchema(db);db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(2,Date.now());}},
  // v3 is the context schema; it also carries effect_detail (why an effect ended the way it did) so both
  // lineages' v3 shapes converge. Both steps are idempotent.
  {to:3,destructive:false,apply(db){db.exec(CONTEXT_SCHEMA);if(!(db.query("PRAGMA table_info(control_attention)").all() as Array<{name:string}>).some(column=>column.name==="effect_detail"))db.exec("ALTER TABLE control_attention ADD COLUMN effect_detail TEXT");db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(3,Date.now());}},
  // The coordinator lineage stamped v3 for effect_detail alone, so such a DB never ran CONTEXT_SCHEMA; replay it (idempotent).
  {to:4,destructive:false,apply(db){db.exec(CONTEXT_SCHEMA);ensureContextReducerSchema(db);db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(4,Date.now());}},
  // v5 回填：collector 无状态、redirectWork 可复活任意状态 work、orchestrator 无条件注入 rootProblemId，
  // 因此全部 work（含 candidate/stopped/completed）都必须有根 problem。这里直接执行迁移内部 SQL，
  // 不能调用公开的 ensureRootProblem：公开 helper 会再次 ensureControlSchema，并把同一连接先推进到 v6。
  {to:5,destructive:false,apply(db){
    const rows=db.query("SELECT work_id FROM control_works").all() as {work_id:string}[];const now=Date.now();
    const existing=db.query("SELECT 1 FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL");
    const insert=db.query("INSERT INTO control_context_problems(problem_id,work_id,parent_problem_id,root_problem_id,title,state,revision,created_at,updated_at) VALUES (?,?,NULL,?,?,'open',1,?,?)");
    for(const row of rows){if(existing.get(row.work_id))continue;const rootId=rootProblemId(row.work_id);insert.run(rootId,row.work_id,rootId,"root",now,now);}
    db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(5,Date.now());}},
  {to:6,destructive:false,apply(db){db.exec(CONTROL_V6_SCHEMA);backfillOpenAttentionMaterialLocked(db,Date.now());db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(6,Date.now());}},
  // v7 additive only: wait + prerequisite-edge tables; no backfill, no waits, no recovery.
  {to:7,destructive:false,apply(db){db.exec(CONTROL_V7_SCHEMA);db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(7,Date.now());}},
  // The public lineage reached v7 without effect_detail; converge both lineages on one shape.
  {to:8,destructive:false,apply(db){if(!(db.query("PRAGMA table_info(control_attention)").all() as Array<{name:string}>).some(column=>column.name==="effect_detail"))db.exec("ALTER TABLE control_attention ADD COLUMN effect_detail TEXT");db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(8,Date.now());}},
];
export function ensureControlSchema(db: Database): void {
  const version=controlSchemaVersion(db);
  if(version>CONTROL_SCHEMA_VERSION)throw new ControlError("blocked",`control schema version ${version} is newer than supported ${CONTROL_SCHEMA_VERSION}`);
  if(version===CONTROL_SCHEMA_VERSION){backfillOpenAttentionMaterial(db);return;}
  for(const migration of CONTROL_MIGRATIONS.filter(entry=>entry.to>version)){
    if(migration.destructive)backupForDestructiveMigration(db,migration.to-1,migration.to);
    const tx=db.transaction(()=>{const current=controlSchemaVersion(db);if(current!==migration.to-1)throw new ControlError("conflict",`control schema changed during migration: ${current}`);migration.apply(db);});tx.immediate();
  }
}

function backfillOpenAttentionMaterialLocked(db: Database, now: number): void {
  const select = db.query(`SELECT a.* FROM control_attention a
    LEFT JOIN control_attention_material m ON m.item_id=a.item_id
    WHERE a.state='open' AND m.item_id IS NULL ORDER BY a.created_at,a.item_id LIMIT 100`);
  while (true) {
    const rows = select.all() as Record<string, unknown>[];
    if (rows.length === 0) break;
    for (const row of rows) {
      const item = attentionFrom(row);
      projectAttentionMaterialLocked(db, item, deriveAttentionMaterialInputs(db, item, now), now);
    }
  }
}

/** Reopen repair for open attention items without projected material. Steady state has none (upsertAttention and wait
 *  re-decision project material in their own transaction; v6 backfilled history), so a cheap read-only EXISTS probe
 *  gates it: pure reads never contend for the writer lock. The locked pass re-selects, so a racing writer is harmless. */
function backfillOpenAttentionMaterial(db: Database, now = Date.now()): void {
  if (!tableExists(db, "control_attention_material")) return;
  const missing = db.query(`SELECT EXISTS(SELECT 1 FROM control_attention a
    LEFT JOIN control_attention_material m ON m.item_id=a.item_id
    WHERE a.state='open' AND m.item_id IS NULL) AS missing`).get() as { missing: number };
  if (!missing.missing) return;
  const tx = db.transaction(() => backfillOpenAttentionMaterialLocked(db, now));
  tx.immediate();
}

export function openControl(path?: string | null): Database {
  // fail-fast：显式传入 null/空串/字面量 "undefined" 一律拒绝，不落到 new Database
  // （Bun 会据此在 CWD 创建名为 "undefined" 的文件）。仅当参数为 undefined（无参调用）
  // 时才在函数内部显式解析 env/默认路径，不依赖 Bun 对 undefined 路径的隐式行为。
  if (path === null || path === "" || path === "undefined" || path === "null") throw new Error("openControl: path is required");
  let resolved = path ?? process.env.OVERLOAD_ANSWERS_PATH ?? "";
  if (!resolved || resolved.trim() === "" || resolved === "undefined" || resolved === "null") resolved = join(homedir(), ".overload", "orchestrator-answers.db");
  if (!resolved.trim()) throw new Error("openControl: path is required");
  mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
  const db = new Database(resolved, { create: true });
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  try { chmodSync(resolved, 0o600); } catch { db.close(); throw new ControlError("blocked", `cannot secure control database: ${resolved}`); }
  return db;
}

function parseObject<T>(value: string): T { return JSON.parse(value) as T; }
function validateStringArray(value:unknown,name:string):asserts value is string[]{if(!Array.isArray(value)||value.some(entry=>typeof entry!=="string"||!entry.trim()))throw new ControlError("invalid",`invalid ${name}`);}
function validateContract(contract: Contract): void {
  if (!contract || typeof contract!=="object" || Array.isArray(contract) || typeof contract.objective !== "string" || !contract.objective.trim() || !Array.isArray(contract.acceptance) || contract.acceptance.length===0
    || !Array.isArray(contract.non_goals) || !contract.scope || typeof contract.scope!=="object" || Array.isArray(contract.scope) || !contract.budget || typeof contract.budget!=="object" || Array.isArray(contract.budget) || !Array.isArray(contract.stop_conditions)
    || typeof contract.decision_owner !== "string" || !contract.decision_owner.trim()) throw new ControlError("invalid", "invalid contract");
  validateStringArray(contract.non_goals,"non_goals");if(contract.beneficiary!==undefined&&(typeof contract.beneficiary!=="string"||!contract.beneficiary.trim()))throw new ControlError("invalid","invalid beneficiary");
  const scope=contract.scope;if(scope.repo!==undefined&&(typeof scope.repo!=="string"||!scope.repo.trim()))throw new ControlError("invalid","invalid scope.repo");if(scope.cwd!==undefined&&(typeof scope.cwd!=="string"||!scope.cwd.trim()))throw new ControlError("invalid","invalid scope.cwd");if(scope.allowed_effects!==undefined)validateStringArray(scope.allowed_effects,"scope.allowed_effects");if(scope.human_only_effects!==undefined)validateStringArray(scope.human_only_effects,"scope.human_only_effects");if(scope.repo===undefined&&scope.cwd===undefined&&scope.allowed_effects===undefined&&scope.human_only_effects===undefined)throw new ControlError("invalid","scope must declare a boundary");
  const budget=contract.budget;if(budget.retry_limit!==undefined&&(!Number.isSafeInteger(budget.retry_limit)||budget.retry_limit<0))throw new ControlError("invalid","invalid budget.retry_limit");if(budget.deadline_at!==undefined&&(!Number.isSafeInteger(budget.deadline_at)||budget.deadline_at<=0))throw new ControlError("invalid","invalid budget.deadline_at");if(budget.cost_limit!==undefined&&(!Number.isFinite(budget.cost_limit)||budget.cost_limit<0))throw new ControlError("invalid","invalid budget.cost_limit");if(budget.cost_mode!==undefined&&!['hard','soft','unknown'].includes(budget.cost_mode))throw new ControlError("invalid","invalid budget.cost_mode");if(budget.cost_limit!==undefined&&budget.cost_mode===undefined)throw new ControlError("invalid","cost_limit requires explicit cost_mode");if(budget.cost_mode==='hard'&&budget.cost_limit===undefined)throw new ControlError("invalid","hard cost_mode requires cost_limit");
  const ids = new Set<string>();
  for (const criterion of contract.acceptance) {
    if (!criterion || typeof criterion!=="object" || typeof criterion.id!=="string" || !criterion.id.trim() || ids.has(criterion.id) || !["check", "artifact", "human"].includes(criterion.kind) || typeof criterion.description!=="string" || !criterion.description.trim() || criterion.evidence!==undefined&&typeof criterion.evidence!=="string") throw new ControlError("invalid", "invalid acceptance criterion");
    ids.add(criterion.id);
  }
  ids.clear();
  for (const condition of contract.stop_conditions) {
    if (!condition || typeof condition!=="object" || typeof condition.id!=="string" || !condition.id.trim() || ids.has(condition.id) || !["hard", "judgment"].includes(condition.kind) || typeof condition.description!=="string" || !condition.description.trim()) throw new ControlError("invalid", "invalid stop condition");
    ids.add(condition.id);
  }
}
function workFrom(row: Record<string, unknown>): Work {
  return { work_id: row.work_id as string,title: row.title as string,source: row.source as string,source_id: row.source_id as string|null,
    state: row.state as Work["state"],revision: row.revision as number,contract: row.contract ? parseObject<Contract>(row.contract as string) : null,
    created_at: row.created_at as number,updated_at: row.updated_at as number };
}
function attentionFrom(row: Record<string, unknown>): AttentionItem {
  return { item_id:row.item_id as string,work_id:row.work_id as string,revision:row.revision as number,state:row.state as AttentionItem["state"],
    effect_state:row.effect_state as AttentionItem["effect_state"],effect_detail:(row.effect_detail??null) as string|null,urgency:row.urgency as AttentionItem["urgency"],conclusion:row.conclusion as string,
    trigger:row.trigger as string,impact:row.impact as string,recommendation:row.recommendation as string|null,options:parseObject<string[]>(row.options as string),
    owner:row.owner as string,expires_at:row.expires_at as number|null,defer_until:row.defer_until as number|null,acknowledged_at:row.acknowledged_at as number|null,
    source_link:row.source_link as string|null,approval_id:row.approval_id as string|null,consumer_owner:row.consumer_owner as AttentionItem["consumer_owner"],
    contract_revision:row.contract_revision as number,decision_mode:row.decision_mode as AttentionItem["decision_mode"],evidence:parseObject<Record<string,unknown>>(row.evidence as string),
    created_at:row.created_at as number,updated_at:row.updated_at as number };
}
function emitWork(db: Database, work: Work, kind: string): void { enqueueControlEvent(db,{entity_id:work.work_id,entity_version:work.revision,kind,work_id:work.work_id,payload:{work}} ,work.updated_at); }
function emitAttention(db: Database, item: AttentionItem, kind: string): void { enqueueControlEvent(db,{entity_id:item.item_id,entity_version:item.revision,kind,work_id:item.work_id,item_id:item.item_id,payload:{attention:item}},item.updated_at); }

// 必须在已有事务内调用：work 进入 active 时同事务建立根 problem（不另开外层事务）。
function ensureRootProblemLocked(db: Database, workId: string, now: number): void {
  ensureRootProblem(db, workId, now);
}

export function createWork(db: Database,input:{title:string;source:string;source_id?:string;contract?:Contract;candidate?:boolean},now=Date.now()):Work {
  ensureControlSchema(db);
  if (typeof input.title!=="string"||!input.title.trim()||typeof input.source!=="string"||!input.source.trim()||input.source_id!==undefined&&(typeof input.source_id!=="string"||!input.source_id.trim())||input.candidate!==undefined&&typeof input.candidate!=="boolean") throw new ControlError("invalid", "invalid work input");
  if (input.contract) validateContract(input.contract);
  const tx=db.transaction(()=>{
    if (input.source_id) {
      const existing=db.query("SELECT * FROM control_works WHERE source=? AND source_id=?").get(input.source,input.source_id) as Record<string,unknown>|null;
      if (existing) {
        const work=workFrom(existing);const requestedState=input.candidate?"candidate":"active";const requestedContract=input.contract??null;
        if(work.title!==input.title||work.state!==requestedState||JSON.stringify(work.contract)!==JSON.stringify(requestedContract))throw new ControlError("conflict","source identity already bound to different work");
        // 幂等命中已存在 active work：补根 problem（升级前存量 work 可能缺根 problem）。
        // candidate 不在此补，promoteWork 转正时再建（与新建 candidate 路径一致）。
        if(work.state==="active") ensureRootProblemLocked(db,work.work_id,now);
        return work;
      }
    }
    const work:Work={work_id:randomUUID(),title:input.title,source:input.source,source_id:input.source_id??null,state:input.candidate?"candidate":"active",revision:1,contract:input.contract??null,created_at:now,updated_at:now};
    db.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run(work.work_id,work.title,work.source,work.source_id,work.state,work.revision,work.contract?JSON.stringify(work.contract):null,now,now);
    if(work.contract) db.query("INSERT INTO control_contract_revisions VALUES (?,?,?,?,?)").run(work.work_id,1,JSON.stringify(work.contract),"created",now);
    if(work.state==="active") ensureRootProblemLocked(db, work.work_id, now);
    emitWork(db,work,"work.created"); return work;
  }); return tx.immediate() as Work;
}
export function getWork(db:Database,workId:string):Work|null { ensureControlSchema(db); const row=db.query("SELECT * FROM control_works WHERE work_id=?").get(workId) as Record<string,unknown>|null; return row?workFrom(row):null; }
export function listWorks(db:Database):Work[] { ensureControlSchema(db); return (db.query("SELECT * FROM control_works ORDER BY updated_at DESC,work_id").all() as Record<string,unknown>[]).map(workFrom); }

export function reviseContract(db: Database, workId: string, expectedRevision: number, contract: Contract, reason: string, now = Date.now()): Work {
  ensureControlSchema(db);
  validateContract(contract);
  if (typeof reason !== "string" || !reason.trim()) throw new ControlError("invalid", "reason is required");
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ControlError("invalid", "expected revision must be a positive integer");
  const tx = db.transaction(() => {
    const old = getWork(db, workId);
    if (!old) throw new ControlError("not_found", "work not found");
    if (old.revision !== expectedRevision) throw new ControlError("conflict", "stale work revision");
    const revision = old.revision + 1;
    assertNoInFlightAttention(db, workId, revision);
    if (!db.query("UPDATE control_works SET revision=?,contract=?,updated_at=? WHERE work_id=? AND revision=?").run(revision, JSON.stringify(contract), now, workId, expectedRevision).changes) throw new ControlError("conflict", "stale work revision");
    db.query("INSERT INTO control_contract_revisions VALUES (?,?,?,?,?)").run(workId, revision, JSON.stringify(contract), reason, now);
    const stale = affectedAttention(db, workId, revision);
    for (const item of stale) supersedeAttention(db, item, revision, { superseded_reason: reason }, now);
    const work = { ...old, revision, contract, updated_at: now };
    emitWork(db, work, "contract.revised");
    return work;
  });
  return tx.immediate() as Work;
}

export function redirectWork(db:Database,workId:string,expectedRevision:number,input:{reason:string;affected_work_ids:string[];action:"activate"|"pause"|"stop";evidence?:Record<string,unknown>},now=Date.now()):Work {
  ensureControlSchema(db); if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1||!input||typeof input!=="object"||typeof input.reason!=="string"||!input.reason.trim()||!Array.isArray(input.affected_work_ids)||input.affected_work_ids.some(id=>typeof id!=="string"||!id.trim())||!["activate","pause","stop"].includes(input.action)||input.evidence!==undefined&&(!input.evidence||typeof input.evidence!=="object"||Array.isArray(input.evidence))) throw new ControlError("invalid","invalid redirect input");
  const tx=db.transaction(()=>{const old=getWork(db,workId);if(!old)throw new ControlError("not_found","work not found");if(old.revision!==expectedRevision)throw new ControlError("conflict","stale work revision");
    const revision=old.revision+1; const state=input.action==="activate"?"active":input.action==="stop"?"stopped":old.state;
    if(!db.query("UPDATE control_works SET revision=?,state=?,updated_at=? WHERE work_id=? AND revision=?").run(revision,state,now,workId,expectedRevision).changes)throw new ControlError("conflict","stale work revision");
    // activate 可把 candidate/stopped/completed 翻成 active，激活瞬间必须有根 problem，否则 orchestrator 注入后 fact 断流。
    if(state==="active") ensureRootProblemLocked(db,workId,now);
    db.query("INSERT INTO control_redirects VALUES (?,?,?,?,?,?,?)").run(workId,revision,input.reason,JSON.stringify(input.affected_work_ids),input.action,JSON.stringify(input.evidence??{}),now);
    const work={...old,revision,state,updated_at:now};emitWork(db,work,"work.redirected");return work;});return tx.immediate() as Work;
}

export function recordStopCondition(db:Database,workId:string,conditionId:string,evidence:Record<string,unknown>,now=Date.now(),expectedRevision?:number):AttentionItem {
  ensureControlSchema(db);if(expectedRevision!==undefined&&(!Number.isSafeInteger(expectedRevision)||expectedRevision<1))throw new ControlError("invalid","expected revision must be a positive integer");if(!evidence||typeof evidence!=="object"||Array.isArray(evidence))throw new ControlError("invalid","invalid stop evidence");
  const tx=db.transaction(()=>{const work=getWork(db,workId);if(!work||!work.contract)throw new ControlError("not_found","work contract not found");if(expectedRevision!==undefined&&work.revision!==expectedRevision)throw new ControlError("conflict","stale work revision");const condition=work.contract.stop_conditions.find(x=>x.id===conditionId);if(!condition)throw new ControlError("invalid","unknown stop condition");
    const itemId=`stop:${workId}:${conditionId}`;const existing=getAttention(db,itemId);
    return upsertAttention(db,{item_id:itemId,work_id:workId,state:"open",effect_state:"not_started",urgency:condition.kind==="hard"?"now":"inbox",conclusion:`Stop condition triggered: ${condition.description}`,trigger:condition.description,impact:condition.kind==="hard"?"New controlled effects must stop until resolved.":"Continuation requires owner judgment.",recommendation:condition.kind==="hard"?"stop":"review",options:["continue","narrow","stop"],owner:work.contract.decision_owner,expires_at:null,source_link:null,approval_id:null,consumer_owner:null,contract_revision:work.revision,decision_mode:"human_only",evidence,...(existing?{expected_revision:existing.revision}:{})},now);
  });return tx.immediate() as AttentionItem;
}

export function upsertAttention(db:Database,input:Omit<AttentionItem,"revision"|"created_at"|"updated_at"|"defer_until"|"acknowledged_at"|"effect_detail">&{effect_detail?:string|null;expected_revision?:number},now=Date.now()):AttentionItem {
  ensureControlSchema(db); const {expected_revision,...rest}=input;const values={...rest,effect_detail:rest.effect_detail??null};const work=getWork(db,values.work_id);if(!work)throw new ControlError("not_found","work not found");if(values.contract_revision!==work.revision)throw new ControlError("conflict","stale contract revision");
  if(typeof values.item_id!=="string"||!values.item_id.trim()||typeof values.conclusion!=="string"||!values.conclusion.trim()||typeof values.trigger!=="string"||!values.trigger.trim()||typeof values.impact!=="string"||!values.impact.trim()||typeof values.owner!=="string"||!values.owner.trim()||!["open","applying","resolved","superseded"].includes(values.state)||!["not_started","applying","succeeded","failed","unknown"].includes(values.effect_state)||(values.effect_detail!==null&&(typeof values.effect_detail!=="string"||!values.effect_detail.trim()))||!["now","inbox"].includes(values.urgency)||!["human_only","scoped_auto"].includes(values.decision_mode)||!Array.isArray(values.options)||values.options.some(option=>typeof option!=="string"||!option.trim())||!values.evidence||typeof values.evidence!=="object"||Array.isArray(values.evidence)||values.recommendation!==null&&typeof values.recommendation!=="string"||values.expires_at!==null&&!Number.isSafeInteger(values.expires_at)||values.source_link!==null&&typeof values.source_link!=="string"||values.approval_id!==null&&typeof values.approval_id!=="string"||values.consumer_owner!==null&&!['extension','orchestrator'].includes(values.consumer_owner)||!Number.isSafeInteger(values.contract_revision)||values.contract_revision<1)throw new ControlError("invalid","invalid attention item");
  const tx=db.transaction(()=>{const row=db.query("SELECT * FROM control_attention WHERE item_id=?").get(values.item_id) as Record<string,unknown>|null;let item:AttentionItem;
    if(row){const old=attentionFrom(row);if(expected_revision===undefined||old.revision!==expected_revision)throw new ControlError("conflict","stale attention revision");item={...values,revision:old.revision+1,defer_until:old.defer_until,acknowledged_at:old.acknowledged_at,created_at:old.created_at,updated_at:now};
      const changed=db.query(`UPDATE control_attention SET work_id=?,revision=?,state=?,effect_state=?,effect_detail=?,urgency=?,conclusion=?,trigger=?,impact=?,recommendation=?,options=?,owner=?,expires_at=?,source_link=?,approval_id=?,consumer_owner=?,contract_revision=?,decision_mode=?,evidence=?,updated_at=? WHERE item_id=? AND revision=?`).run(item.work_id,item.revision,item.state,item.effect_state,item.effect_detail,item.urgency,item.conclusion,item.trigger,item.impact,item.recommendation,JSON.stringify(item.options),item.owner,item.expires_at,item.source_link,item.approval_id,item.consumer_owner,item.contract_revision,item.decision_mode,JSON.stringify(item.evidence),now,item.item_id,old.revision);if(!changed.changes)throw new ControlError("conflict","stale attention revision");
    }else{if(expected_revision!==undefined)throw new ControlError("conflict","attention item does not exist");item={...values,revision:1,defer_until:null,acknowledged_at:null,created_at:now,updated_at:now};db.query(`INSERT INTO control_attention(item_id,work_id,revision,state,effect_state,effect_detail,urgency,conclusion,trigger,impact,recommendation,options,owner,expires_at,defer_until,acknowledged_at,source_link,approval_id,consumer_owner,contract_revision,decision_mode,evidence,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.item_id,item.work_id,item.revision,item.state,item.effect_state,item.effect_detail,item.urgency,item.conclusion,item.trigger,item.impact,item.recommendation,JSON.stringify(item.options),item.owner,item.expires_at,item.defer_until,item.acknowledged_at,item.source_link,item.approval_id,item.consumer_owner,item.contract_revision,item.decision_mode,JSON.stringify(item.evidence),now,now);}
    db.query("INSERT INTO control_attention_events(item_id,revision,kind,detail,created_at) VALUES (?,?,?,?,?)").run(item.item_id,item.revision,"upsert",JSON.stringify(item.evidence),now);
    projectAttentionMaterialLocked(db,item,deriveAttentionMaterialInputs(db,item,now),now);
    emitAttention(db,item,row?"attention.updated":"attention.created");return item;});return tx.immediate() as AttentionItem;
}
export function getAttention(db:Database,itemId:string):AttentionItem|null {ensureControlSchema(db);const row=db.query("SELECT * FROM control_attention WHERE item_id=?").get(itemId) as Record<string,unknown>|null;return row?attentionFrom(row):null;}
export function listAttention(db:Database,zone?:AttentionZone,now=Date.now()):AttentionItem[]{ensureControlSchema(db);const rows=(db.query("SELECT * FROM control_attention ORDER BY updated_at DESC,item_id").all() as Record<string,unknown>[]).map(attentionFrom);return rows.filter(item=>{if(!zone)return true;if(zone==="done")return item.state==="resolved"||item.state==="superseded";if(item.state!=="open"||item.defer_until!==null&&item.defer_until>now)return false;return zone==="now"?item.urgency==="now"||item.expires_at!==null&&item.expires_at<=now:item.urgency==="inbox"&&!(item.expires_at!==null&&item.expires_at<=now);});}

const GENERIC_DECISION_OPTIONS: Record<string, Omit<DecisionOption, "id">> = {
  stop: {
    label: "Stop work",
    effect: "stops the work and releases its controlled resources",
    consequence: "Work moves to stopped and its remaining scope is not executed.",
    requires_reason: false,
    requires_contract: false,
  },
  continue: {
    label: "Continue work",
    effect: "records acceptance of the remaining risk and continues the work",
    consequence: "Work continues under the current contract and budget.",
    requires_reason: false,
    requires_contract: false,
  },
  narrow: {
    label: "Narrow scope",
    effect: "replaces the work contract with a reviewed narrower contract",
    consequence: "Other open cards for the previous contract are superseded.",
    requires_reason: true,
    requires_contract: true,
  },
};

function attentionTargetEffect(db: Database, item: AttentionItem): string | null {
  if (!item.approval_id || !item.consumer_owner || !tableExists(db, "approval_targets")) return null;
  const columns = db.query("PRAGMA table_info(approval_targets)").all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === "effect") || !columns.some(({ name }) => name === "state")) return null;
  const row = db.query("SELECT effect FROM approval_targets WHERE consumer_owner=? AND approval_id=? AND state='active'")
    .get(item.consumer_owner, item.approval_id) as { effect: string } | null;
  return row?.effect ?? null;
}

export function deriveAttentionDecisionOptions(db: Database, item: AttentionItem): DecisionOption[] | null {
  const targetEffect = attentionTargetEffect(db, item);
  const options: DecisionOption[] = [];
  for (const id of item.options) {
    const generic = GENERIC_DECISION_OPTIONS[id];
    if (generic) {
      options.push({ id, ...generic });
      continue;
    }
    if (!targetEffect) return null;
    options.push({
      id,
      label: id,
      effect: `records answer; execution pending: ${targetEffect}`,
      consequence: `Records “${id}” for the registered ${targetEffect} target; success is not yet verified.`,
      requires_reason: false,
      requires_contract: false,
    });
  }
  return options;
}

function decisiveEvidenceFromItem(db: Database, item: AttentionItem): MaterialFingerprintInputs["decisive_evidence"] {
  const objectId = typeof item.evidence.object_id === "string" ? item.evidence.object_id : null;
  const revision = typeof item.evidence.revision === "number" && Number.isSafeInteger(item.evidence.revision) && item.evidence.revision >= 1
    ? item.evidence.revision
    : null;
  if (!objectId || revision === null || !tableExists(db, "control_context_object_versions")) return [];
  const row = db.query("SELECT summary_short FROM control_context_object_versions WHERE object_id=? AND revision=?")
    .get(objectId, revision) as { summary_short: string | null } | null;
  return row?.summary_short ? [{ object_id: objectId, revision, conclusion: row.summary_short }] : [];
}

export function deriveAttentionMaterialInputs(db: Database, item: AttentionItem, now = Date.now()): MaterialFingerprintInputs {
  const displayOptions = deriveAttentionDecisionOptions(db, item);
  const optionEffects = displayOptions
    ? displayOptions.map(({ id, effect }) => ({ option: id, effect }))
    : item.options.map((option) => ({ option, effect: "records answer; execution semantics unavailable" }));
  return {
    risk: item.impact,
    decision: item.conclusion,
    option_effects: optionEffects,
    decisive_evidence: decisiveEvidenceFromItem(db, item),
    validity: { expires_at: item.expires_at, expired: item.expires_at !== null && item.expires_at <= now },
    consequence: item.impact,
  };
}

function normalizeMaterialString(value: string): string {
  return value.replace(/\r\n?/g, "\n").trim().replace(/\s+/gu, " ").normalize("NFC");
}

export function canonicalizeMaterialFingerprintInputs(input: MaterialFingerprintInputs): MaterialFingerprintInputs {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || typeof input.risk !== "string" || typeof input.decision !== "string"
    || typeof input.consequence !== "string" || !Array.isArray(input.option_effects)
    || !Array.isArray(input.decisive_evidence) || !input.validity || typeof input.validity !== "object"
    || (input.validity.expires_at !== null && (!Number.isSafeInteger(input.validity.expires_at) || input.validity.expires_at < 0))
    || typeof input.validity.expired !== "boolean") throw new ControlError("invalid", "invalid material fingerprint inputs");
  const optionEffects = input.option_effects.map((entry) => {
    if (!entry || typeof entry.option !== "string" || typeof entry.effect !== "string") throw new ControlError("invalid", "invalid material option effect");
    return { option: normalizeMaterialString(entry.option), effect: normalizeMaterialString(entry.effect) };
  });
  const decisiveEvidence = input.decisive_evidence.map((entry) => {
    if (!entry || typeof entry.object_id !== "string" || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || typeof entry.conclusion !== "string") {
      throw new ControlError("invalid", "invalid decisive material evidence");
    }
    return { object_id: normalizeMaterialString(entry.object_id), revision: entry.revision, conclusion: normalizeMaterialString(entry.conclusion) };
  }).sort((a, b) => a.object_id.localeCompare(b.object_id) || a.revision - b.revision || a.conclusion.localeCompare(b.conclusion));
  return {
    risk: normalizeMaterialString(input.risk),
    decision: normalizeMaterialString(input.decision),
    option_effects: optionEffects,
    decisive_evidence: decisiveEvidence,
    validity: { expires_at: input.validity.expires_at, expired: input.validity.expired },
    consequence: normalizeMaterialString(input.consequence),
  };
}

export function computeMaterialFingerprint(input: MaterialFingerprintInputs): { inputs: MaterialFingerprintInputs; fingerprint: string } {
  const inputs = canonicalizeMaterialFingerprintInputs(input);
  return { inputs, fingerprint: createHash("sha256").update(canonicalJson(inputs)).digest("hex") };
}

function materialFrom(row: Record<string, unknown>): AttentionMaterialProjection {
  const itemId = row.item_id as string;
  return {
    item_id: itemId,
    subject: `attention:${itemId}`,
    material_key: row.material_key as string,
    fingerprint: row.fingerprint as string,
    generation: row.generation as number,
    inputs: parseObject<MaterialFingerprintInputs>(row.inputs as string),
    computed_at: row.computed_at as number,
  };
}

export function getAttentionMaterial(db: Database, itemId: string): AttentionMaterialProjection | null {
  ensureControlSchema(db);
  const row = db.query("SELECT * FROM control_attention_material WHERE item_id=?").get(itemId) as Record<string, unknown> | null;
  return row ? materialFrom(row) : null;
}

function projectAttentionMaterialLocked(
  db: Database,
  item: AttentionItem,
  input: MaterialFingerprintInputs,
  now: number,
): AttentionMaterialProjection {
  const computed = computeMaterialFingerprint(input);
  const existingRow = db.query("SELECT * FROM control_attention_material WHERE item_id=?").get(item.item_id) as Record<string, unknown> | null;
  const existing = existingRow ? materialFrom(existingRow) : null;
  const subject = `attention:${item.item_id}`;
  const materialKey = `${subject}:${computed.fingerprint}`;
  let changed = false;
  if (!existing) {
    db.query("INSERT INTO control_attention_material(item_id,material_key,fingerprint,generation,inputs,computed_at) VALUES(?,?,?,?,?,?)")
      .run(item.item_id, materialKey, computed.fingerprint, 1, canonicalJson(computed.inputs), now);
    changed = true;
  } else if (existing.fingerprint === computed.fingerprint) {
    db.query("UPDATE control_attention_material SET computed_at=? WHERE item_id=?").run(now, item.item_id);
  } else {
    db.query("UPDATE control_attention_material SET material_key=?,fingerprint=?,generation=generation+1,inputs=?,computed_at=? WHERE item_id=?")
      .run(materialKey, computed.fingerprint, canonicalJson(computed.inputs), now, item.item_id);
    changed = true;
  }
  const projection = materialFrom(db.query("SELECT * FROM control_attention_material WHERE item_id=?").get(item.item_id) as Record<string, unknown>);
  if (changed) {
    enqueueControlEvent(db, {
      entity_id: projection.material_key,
      entity_version: projection.generation,
      kind: "attention.material_projected",
      work_id: item.work_id,
      item_id: item.item_id,
      payload: { attention: item, material: projection },
    }, now);
  }
  return projection;
}

export function projectAttentionMaterial(db: Database, itemId: string, input: MaterialFingerprintInputs, now = Date.now()): AttentionMaterialProjection {
  ensureControlSchema(db);
  const tx = db.transaction(() => {
    const row = db.query("SELECT * FROM control_attention WHERE item_id=?").get(itemId) as Record<string, unknown> | null;
    if (!row) throw new ControlError("not_found", "attention item not found");
    return projectAttentionMaterialLocked(db, attentionFrom(row), input, now);
  });
  return tx.immediate() as AttentionMaterialProjection;
}

function tableExists(db: Database, name: string): boolean {
  return !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

export function listAttentionFollowUps(db: Database, _now = Date.now()): AttentionFollowUp[] {
  ensureControlSchema(db);
  const items = listAttention(db);
  const hasReceipts = tableExists(db, "decision_receipts") && tableExists(db, "approval_targets");
  const hasObservations = tableExists(db, "receipt_effect_observations");
  const followUps: AttentionFollowUp[] = [];
  for (const item of items) {
    const receipt = hasReceipts && item.approval_id && item.consumer_owner
      ? db.query(`SELECT r.receipt_id,r.consumed_at,r.applied_at,r.outcome FROM decision_receipts r
          WHERE r.consumer_owner=? AND r.approval_id=? ORDER BY r.consumed_at DESC LIMIT 1`)
        .get(item.consumer_owner, item.approval_id) as { receipt_id: string; consumed_at: number; applied_at: number | null; outcome: string | null } | null
      : null;
    const observations = hasObservations && receipt
      ? db.query("SELECT tool_call_id,state,evidence,observed_at FROM receipt_effect_observations WHERE receipt_id=? ORDER BY observed_at,tool_call_id")
        .all(receipt.receipt_id) as Array<{ tool_call_id: string; state: string; evidence: string; observed_at: number }>
      : [];
    const occurredEffects = observations.map((observation) => ({
      kind: observation.tool_call_id,
      evidence: { ...parseObject<Record<string, unknown>>(observation.evidence), state: observation.state, observed_at: observation.observed_at },
    }));
    if (!occurredEffects.length && Array.isArray(item.evidence.occurred_effects)) {
      for (const effect of item.evidence.occurred_effects as Array<Record<string, unknown>>) {
        if (typeof effect.kind === "string" && effect.evidence && typeof effect.evidence === "object" && !Array.isArray(effect.evidence)) {
          occurredEffects.push({ kind: effect.kind, evidence: effect.evidence as Record<string, unknown> });
        }
      }
    }
    const remaining = item.effect_state === "succeeded" && typeof item.evidence.effect_verified_at === "number"
      ? ""
      : explicitRemainingResponsibility(db, item, {});
    const recorded = !!receipt && receipt.applied_at === null;
    const visible = recorded || item.effect_state !== "succeeded" && item.state === "applying" || item.effect_state === "applying"
      || item.effect_state === "failed" || item.effect_state === "unknown"
      || (item.effect_state === "succeeded" && !!remaining);
    if (!visible) continue;
    const outcome = receipt?.outcome === "succeeded" || receipt?.outcome === "failed" || receipt?.outcome === "unknown"
      ? receipt.outcome : item.effect_state === "succeeded" || item.effect_state === "failed" || item.effect_state === "unknown" ? item.effect_state : null;
    const stage = recorded ? "answer_recorded"
      : item.effect_state === "failed" ? "failed"
      : item.effect_state === "unknown" ? "unknown"
      : item.effect_state === "succeeded" && remaining ? "verification_required"
      : "applying";
    followUps.push({
      item, stage, receipt_id: receipt?.receipt_id ?? null, consumed_at: receipt?.consumed_at ?? null,
      applied_at: receipt?.applied_at ?? null, outcome, occurred_effects: occurredEffects,
      remaining_responsibility: remaining || (stage === "failed" ? "Review failure and choose the next action." : stage === "unknown" ? "Confirm the external effect before retrying." : "Verify the recorded effect."),
      next_action: stage === "answer_recorded" ? "Wait for the registered consumer to apply the answer."
        : stage === "failed" ? "Review the failure without creating replacement Work."
        : stage === "unknown" ? "Confirm the result; do not replay blindly."
        : stage === "verification_required" ? "Complete the outstanding acceptance responsibility."
        : "Wait for effect verification.",
    });
  }
  return followUps;
}

function affectedAttention(db: Database, workId: string, nextRevision: number, excludeItemId?: string): AttentionItem[] {
  const rows = excludeItemId === undefined
    ? db.query("SELECT * FROM control_attention WHERE work_id=? AND state='open' AND effect_state='not_started' AND contract_revision<? ORDER BY item_id").all(workId, nextRevision)
    : db.query("SELECT * FROM control_attention WHERE work_id=? AND item_id<>? AND state='open' AND effect_state='not_started' AND contract_revision<? ORDER BY item_id").all(workId, excludeItemId, nextRevision);
  return (rows as Record<string, unknown>[]).map(attentionFrom);
}

function validateCardSnapshot(value: unknown): AttentionCardSnapshot[] {
  if (!Array.isArray(value)) throw new ControlError("invalid", "affected_cards must be an array");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new ControlError("invalid", "invalid affected card");
    const card = entry as Record<string, unknown>;
    if (typeof card.item_id !== "string" || !card.item_id.trim() || seen.has(card.item_id)
      || !Number.isSafeInteger(card.revision) || (card.revision as number) < 1) throw new ControlError("invalid", "invalid affected card");
    seen.add(card.item_id);
    return { item_id: card.item_id, revision: card.revision as number };
  });
}

function assertNoInFlightAttention(db: Database, workId: string, nextRevision: number): void {
  const row = db.query("SELECT item_id FROM control_attention WHERE work_id=? AND contract_revision<? AND (state='applying' OR effect_state IN ('applying','unknown')) LIMIT 1").get(workId, nextRevision) as { item_id: string } | null;
  if (row) throw new ControlError("blocked", `attention effect is still in flight: ${row.item_id}`);
}

function supersedeAttention(db: Database, prior: AttentionItem, workRevision: number, detail: Record<string, unknown>, now: number): void {
  const superseded: AttentionItem = {
    ...prior,
    revision: prior.revision + 1,
    state: "superseded",
    updated_at: now,
    evidence: { ...prior.evidence, superseded_by_work_revision: workRevision, ...detail },
  };
  persistAttention(db, prior, superseded, "superseded", detail, now);
}

export function previewContractRevision(db: Database, workId: string, expectedRevision: number, replacementContract: Contract): ContractRevisionPreview {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ControlError("invalid", "expected revision must be a positive integer");
  validateContract(replacementContract);
  const work = getWork(db, workId);
  if (!work) throw new ControlError("not_found", "work not found");
  if (work.revision !== expectedRevision) throw new ControlError("conflict", "stale work revision");
  assertNoInFlightAttention(db, workId, expectedRevision + 1);
  return {
    current_contract: work.contract,
    current_revision: work.revision,
    affected_cards: affectedAttention(db, workId, expectedRevision + 1).map(({ item_id, conclusion, revision }) => ({ item_id, conclusion, revision })),
  };
}

function verifyAffectedSnapshot(snapshot: AttentionCardSnapshot[] | undefined, selectedItem: AttentionItem, applicable: AttentionItem[]): void {
  if (snapshot === undefined) return;
  const selected = snapshot.find((card) => card.item_id === selectedItem.item_id);
  if (!selected || selected.revision !== selectedItem.revision) throw new ControlError("conflict", "selected attention card changed");
  if (snapshot.length !== applicable.length + 1) throw new ControlError("conflict", "affected attention cards changed");
  const expected = new Map(applicable.map((item) => [item.item_id, item.revision]));
  for (const card of snapshot) {
    if (card.item_id === selectedItem.item_id) continue;
    if (expected.get(card.item_id) !== card.revision) throw new ControlError("conflict", "affected attention cards changed");
  }
}

function persistAttention(db: Database, old: AttentionItem, item: AttentionItem, kind: string, detail: Record<string, unknown>, now: number): void {
  if (!db.query("UPDATE control_attention SET revision=?,state=?,effect_state=?,contract_revision=?,evidence=?,defer_until=?,acknowledged_at=?,updated_at=? WHERE item_id=? AND revision=?").run(item.revision, item.state, item.effect_state, item.contract_revision, JSON.stringify(item.evidence), item.defer_until, item.acknowledged_at, now, item.item_id, old.revision).changes) throw new ControlError("conflict", "stale attention revision");
  db.query("INSERT INTO control_attention_events(item_id,revision,kind,detail,created_at) VALUES (?,?,?,?,?)").run(item.item_id, item.revision, kind, JSON.stringify(detail), now); emitAttention(db, item, `attention.${kind}`);
}
function staleAttentionError(item: AttentionItem, expectedRevision: number): ControlError {
  const body: StaleAttentionBody = {
    error: "conflict",
    message: "stale attention revision",
    code: "stale_attention",
    item_id: item.item_id,
    expected_revision: expectedRevision,
    current_revision: item.revision,
    current_state: item.state,
    current_effect_state: item.effect_state,
    decision_package_url: `/api/context/decision-package?item_id=${encodeURIComponent(item.item_id)}&work_id=${encodeURIComponent(item.work_id)}`,
  };
  return new ControlError("conflict", body.message, body);
}

function explicitRemainingResponsibility(db: Database, item: AttentionItem, evidence: Record<string, unknown>): string {
  const observed = evidence.remaining_responsibility;
  if (typeof observed === "string" && observed.trim()) return observed.trim();
  const recorded = item.evidence.remaining_responsibility;
  if (typeof recorded === "string" && recorded.trim()) return recorded.trim();
  const work = getWork(db, item.work_id);
  const pendingHuman = work?.contract?.acceptance.filter((criterion) => criterion.kind === "human" && !criterion.evidence) ?? [];
  return pendingHuman.map((criterion) => criterion.description.trim()).filter(Boolean).join("; ");
}

/**
 * Projects a mailbox-accepted effect observation into Attention truth. The
 * supplied outbox_event_id is the source effect event correlation; this
 * projection enqueues its own deterministic `attention.effect_projected`
 * event in the same immediate transaction.
 */
export function projectAttentionEffect(
  db: Database,
  link: AttentionAuditLink,
  observation: EffectObservation,
  now = Date.now(),
): AttentionItem {
  ensureControlSchema(db);
  if (!link || typeof link !== "object" || !link.work_id?.trim() || !link.item_id?.trim()
    || !Number.isSafeInteger(link.item_revision) || link.item_revision < 1
    || !link.outbox_event_id?.trim()) throw new ControlError("invalid", "invalid attention audit link");
  if (!observation || typeof observation !== "object" || !observation.receiptId?.trim()
    || !observation.toolCallId?.trim() || !["succeeded", "failed", "unknown"].includes(observation.state)
    || !Number.isSafeInteger(observation.observedAt) || observation.observedAt < 0
    || !observation.evidence || typeof observation.evidence !== "object" || Array.isArray(observation.evidence)) {
    throw new ControlError("invalid", "invalid effect observation");
  }
  if (link.receipt_id !== observation.receiptId) throw new ControlError("invalid", "effect receipt does not match audit link");

  return db.transaction(() => {
    const accepted = db.query(`SELECT state,evidence,observed_at FROM receipt_effect_observations
      WHERE receipt_id=? AND tool_call_id=?`).get(observation.receiptId, observation.toolCallId) as
      { state: string; evidence: string; observed_at: number } | null;
    if (!accepted || accepted.state !== observation.state || accepted.observed_at !== observation.observedAt
      || accepted.evidence !== canonicalJson(observation.evidence)) {
      throw new ControlError("blocked", "effect observation was not accepted by mailbox");
    }
    const old = getAttention(db, link.item_id);
    if (!old) throw new ControlError("not_found", "attention item not found");
    if (old.work_id !== link.work_id || old.approval_id !== link.approval_id) throw new ControlError("invalid", "attention audit link does not match item");

    const prior = old.evidence.effect_projection as Record<string, unknown> | undefined;
    const sameObservation = prior?.receipt_id === observation.receiptId
      && prior?.tool_call_id === observation.toolCallId
      && prior?.observed_at === observation.observedAt
      && prior?.state === observation.state;
    if (sameObservation) return old;
    if (old.revision !== link.item_revision) throw staleAttentionError(old, link.item_revision);
    const priorObservedAt = typeof prior?.observed_at === "number" ? prior.observed_at : -1;
    if (observation.observedAt < priorObservedAt) return old;
    if (observation.observedAt === priorObservedAt) {
      throw new ControlError("conflict", "effect observations at the same time disagree");
    }

    const remaining = explicitRemainingResponsibility(db, old, observation.evidence);
    const succeeded = observation.state === "succeeded";
    const nextState: AttentionItem["state"] = succeeded ? (remaining ? "applying" : "resolved") : "open";
    const effectRecord = {
      kind: observation.toolCallId,
      evidence: observation.evidence,
      state: observation.state,
      observed_at: observation.observedAt,
    };
    const priorEffects = Array.isArray(old.evidence.occurred_effects) ? old.evidence.occurred_effects : [];
    const auditLink = { ...link };
    const item: AttentionItem = {
      ...old,
      revision: old.revision + 1,
      state: nextState,
      effect_state: observation.state,
      effect_detail: typeof observation.evidence.reason === "string" ? observation.evidence.reason : null,
      evidence: {
        ...old.evidence,
        occurred_effects: [...priorEffects, effectRecord],
        remaining_responsibility: remaining || undefined,
        effect_projection: {
          receipt_id: observation.receiptId,
          tool_call_id: observation.toolCallId,
          observed_at: observation.observedAt,
          state: observation.state,
          audit_link: auditLink,
        },
        ...(succeeded && !remaining ? { effect_verified_at: observation.observedAt } : {}),
      },
      updated_at: now,
    };
    if (!db.query(`UPDATE control_attention SET revision=?,state=?,effect_state=?,effect_detail=?,evidence=?,updated_at=?
      WHERE item_id=? AND revision=?`).run(item.revision, item.state, item.effect_state, item.effect_detail, JSON.stringify(item.evidence), now, item.item_id, old.revision).changes) {
      throw staleAttentionError(getAttention(db, item.item_id) ?? old, link.item_revision);
    }
    const detail = { audit_link: auditLink, observation: effectRecord, remaining_responsibility: remaining };
    db.query("INSERT INTO control_attention_events(item_id,revision,kind,detail,created_at) VALUES (?,?,?,?,?)")
      .run(item.item_id, item.revision, "effect_projected", JSON.stringify(detail), now);
    enqueueControlEvent(db, {
      entity_id: item.item_id,
      entity_version: item.revision,
      kind: "attention.effect_projected",
      work_id: item.work_id,
      item_id: item.item_id,
      payload: { attention: item, audit_link: auditLink, observation: effectRecord },
    }, now);
    return item;
  }).immediate() as AttentionItem;
}

// 权威收口：对一张 attention 卡做一次带 revision CAS 的结论落地。
// accepted → resolved/succeeded（记录 acknowledged_at）；rejected → superseded/unknown。
// 写 control_attention_events + enqueue outbox(attention.resolved)，替代 manage 层裸写。
export function recordAttentionResolution(
  db: Database,
  itemId: string,
  expectedRevision: number,
  input: { verdict: "accepted" | "rejected"; actor: string; evidence: Record<string, unknown> },
  now = Date.now(),
): AttentionItem {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ControlError("invalid", "expected revision must be a positive integer");
  if (input.verdict !== "accepted" && input.verdict !== "rejected") throw new ControlError("invalid", "verdict must be accepted or rejected");
  if (typeof input.actor !== "string" || !input.actor.trim()) throw new ControlError("invalid", "actor is required");
  if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence)) throw new ControlError("invalid", "invalid evidence");
  const accepted = input.verdict === "accepted";
  const tx = db.transaction(() => {
    const old = getAttention(db, itemId);
    if (!old) throw new ControlError("not_found", "attention item not found");
    if (old.revision !== expectedRevision) throw new ControlError("conflict", "stale attention revision");
    const item: AttentionItem = {
      ...old,
      revision: old.revision + 1,
      state: accepted ? "resolved" : "superseded",
      effect_state: accepted ? "succeeded" : "unknown",
      acknowledged_at: accepted ? now : old.acknowledged_at,
      evidence: { ...old.evidence, ...input.evidence, resolution: { verdict: input.verdict, actor: input.actor, resolved_at: now } },
      updated_at: now,
    };
    persistAttention(db, old, item, "resolved", { verdict: input.verdict, actor: input.actor, evidence: input.evidence }, now);
    return item;
  });
  return tx.immediate() as AttentionItem;
}

type SupersedeInput = { reason: string; actor: string; evidence?: Record<string, unknown> };

function validateSupersedeInput(input: SupersedeInput): void {
  if (typeof input.reason !== "string" || !input.reason.trim()) throw new ControlError("invalid", "reason is required");
  if (typeof input.actor !== "string" || !input.actor.trim()) throw new ControlError("invalid", "actor is required");
  if (input.evidence !== undefined && (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence))) throw new ControlError("invalid", "invalid evidence");
}

// 单卡权威 supersede：open/applying → superseded，带 revision CAS + events(attention.superseded) + outbox。
// 与合同修订触发的 private supersedeAttention 不同：manage 层触发（work alias、manifest 漂移）没有 work revision 语义，
// 因此不写 superseded_by_work_revision，改写 superseded_reason / superseded_by_actor。
// 幂等：同 reason 重复 supersede 已 superseded 的卡，直接返回旧卡，不 bump revision、不重复发事件。
export function supersedeAttentionById(
  db: Database,
  itemId: string,
  expectedRevision: number,
  input: SupersedeInput,
  now = Date.now(),
): AttentionItem {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ControlError("invalid", "expected revision must be a positive integer");
  validateSupersedeInput(input);
  const tx = db.transaction(() => {
    const old = getAttention(db, itemId);
    if (!old) throw new ControlError("not_found", "attention item not found");
    const existingReason = (old.evidence as Record<string, unknown>)?.superseded_reason;
    if (old.state === "superseded" && existingReason === input.reason) return old;
    if (old.revision !== expectedRevision) throw new ControlError("conflict", "stale attention revision");
    if (old.state === "superseded") throw new ControlError("conflict", "attention card already superseded");
    const detail: Record<string, unknown> = { reason: input.reason, actor: input.actor, ...(input.evidence ?? {}) };
    const item: AttentionItem = {
      ...old,
      revision: old.revision + 1,
      state: "superseded",
      updated_at: now,
      evidence: { ...old.evidence, ...(input.evidence ?? {}), superseded_reason: input.reason, superseded_by_actor: input.actor },
    };
    persistAttention(db, old, item, "superseded", detail, now);
    return item;
  });
  return tx.immediate() as AttentionItem;
}

// 批量 supersede：把某 work 下所有 open/applying 的卡逐张 CAS supersede。
// 用于 aliasWork/redirect：旧 work 的 attention 被新 work 取代。resolved/superseded 卡不动。
// 返回实际 supersede 的张数。逐张调 supersedeAttentionById，保留 per-card 事件与 outbox。
export function supersedeOpenAttentionByWork(
  db: Database,
  workId: string,
  input: SupersedeInput,
  now = Date.now(),
): number {
  ensureControlSchema(db);
  if (typeof workId !== "string" || !workId.trim()) throw new ControlError("invalid", "work_id is required");
  validateSupersedeInput(input);
  const rows = db.query("SELECT item_id FROM control_attention WHERE work_id=? AND state IN ('open','applying') ORDER BY item_id").all(workId) as { item_id: string }[];
  let count = 0;
  for (const row of rows) {
    const old = getAttention(db, row.item_id);
    if (!old) continue;
    supersedeAttentionById(db, row.item_id, old.revision, input, now);
    count++;
  }
  return count;
}

// 外部效果确认式 resolve：open/applying → resolved/succeeded，带 CAS + events(attention.resolved) + outbox。
// 语义守卫：effect_state=failed 的卡不得写成 succeeded；rejected（superseded/unknown）不得被外部成功复活。
// 幂等：已 resolved/succeeded 且 revision 匹配 → 返回旧卡；已 superseded → 返回旧卡（不覆盖）。
// 调用方先用 getAttention 读 expectedRevision；卡缺失由调用方自行 no-op（与原裸 UPDATE 0 行等价）。
export function resolveAttentionByExternalSuccess(
  db: Database,
  itemId: string,
  expectedRevision: number,
  input: { actor: string; evidence?: Record<string, unknown> },
  now = Date.now(),
): AttentionItem {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ControlError("invalid", "expected revision must be a positive integer");
  if (typeof input.actor !== "string" || !input.actor.trim()) throw new ControlError("invalid", "actor is required");
  if (input.evidence !== undefined && (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence))) throw new ControlError("invalid", "invalid evidence");
  const tx = db.transaction(() => {
    const old = getAttention(db, itemId);
    if (!old) throw new ControlError("not_found", "attention item not found");
    if (old.effect_state === "failed") throw new ControlError("invalid", "cannot resolve a failed effect as succeeded");
    if (old.state === "superseded") return old;
    if (old.state === "resolved" && old.effect_state === "succeeded") {
      if (old.revision !== expectedRevision) throw new ControlError("conflict", "stale attention revision");
      return old;
    }
    if (old.state !== "open" && old.state !== "applying") throw new ControlError("invalid", "attention card is not resolvable");
    if (old.revision !== expectedRevision) throw new ControlError("conflict", "stale attention revision");
    const detail: Record<string, unknown> = { actor: input.actor, ...(input.evidence ?? {}), external_success: true };
    const item: AttentionItem = {
      ...old,
      revision: old.revision + 1,
      state: "resolved",
      effect_state: "succeeded",
      updated_at: now,
      evidence: { ...old.evidence, ...(input.evidence ?? {}), resolved_externally_by: input.actor, resolved_at: now },
    };
    persistAttention(db, old, item, "resolved", detail, now);
    return item;
  });
  return tx.immediate() as AttentionItem;
}

export function resolveAttentionDecision(db: Database, itemId: string, expectedRevision: number, input: AttentionDecisionInput, now = Date.now(), actor?: string): AttentionItem {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !input || typeof input !== "object" || typeof input.selected_option !== "string" || !input.selected_option.trim()) throw new ControlError("invalid", "selected_option is required");
  if (input.expected_contract_revision !== undefined && (!Number.isSafeInteger(input.expected_contract_revision) || input.expected_contract_revision < 1)) throw new ControlError("invalid", "expected contract revision must be a positive integer");
  const snapshot = input.affected_cards === undefined ? undefined : validateCardSnapshot(input.affected_cards);
  const tx = db.transaction(() => {
    const old = getAttention(db, itemId);
    if (!old) throw new ControlError("not_found", "attention item not found");
    if (old.revision !== expectedRevision) throw new ControlError("conflict", "stale attention revision");
    if (old.state !== "open" || old.effect_state !== "not_started") throw new ControlError("blocked", "attention decision is not open");
    if (old.approval_id) throw new ControlError("blocked", "approval-linked attention must use answer consumer");
    if (!old.options.includes(input.selected_option)) throw new ControlError("invalid", "selected_option is not an available option");
    if (!["stop", "continue", "narrow"].includes(input.selected_option)) throw new ControlError("invalid", "unsupported generic decision option");
    if (input.selected_option === "narrow") {
      if (!input.replacement_contract || typeof input.reason !== "string" || !input.reason.trim()) throw new ControlError("invalid", "narrow requires replacement_contract and reason");
      validateContract(input.replacement_contract);
    } else if (input.replacement_contract !== undefined || snapshot !== undefined) {
      throw new ControlError("invalid", "contract revision fields are only valid for narrow");
    }
    const work = getWork(db, old.work_id);
    if (!work) throw new ControlError("not_found", "work not found");
    if (work.revision !== old.contract_revision) throw new ControlError("conflict", "attention contract revision is stale");
    // 三入口同步复验（内联，避免循环导入 context-propagation.ts）。
    // 读-检查-消费绑定在同一 immediate 事务内，避免"检查后变化"竞态。
    // context 域判定：attention 带 context 证据对象，或 work 在 context-pool 中登记了问题。
    // 纯 legacy（无 contract/decision_owner 且无 context 对象）保持兼容；其余一律 fail-closed。
    const evidenceObjId = typeof old.evidence.object_id === "string" ? (old.evidence.object_id as string) : null;
    const evidenceRev = typeof old.evidence.revision === "number" ? old.evidence.revision : null;
    const workHasContext = !!db.query("SELECT 1 FROM control_context_problems WHERE work_id=? LIMIT 1").get(old.work_id);
    const isContextDecision = !!evidenceObjId || workHasContext;
    const decisionOwner = work.contract?.decision_owner;

    // 3a. 权限复验 fail-closed。
    if (actor !== undefined && actor !== null && actor.trim()) {
      // actor 已提供。仅当 work 有 decision_owner 或涉及 context 时才强制授权；
      // 纯 legacy（无 contract/decision_owner 且无 context）保持兼容。
      const needsAuth = !!decisionOwner || isContextDecision;
      if (needsAuth) {
        const trimmedActor = actor.trim();
        // shares 是对象级跨 work 引用授权（无 actor 列），不能充当 work 级决策入口授权。
        // 决策 resolve 仅 decision_owner 本人可执行，与 context-assembler.assertWorkAccess 一致；非 owner 一律 fail-closed。
        if (!(decisionOwner && decisionOwner === trimmedActor)) {
          throw new ControlError("blocked", "permission_denied: actor not authorized for this work");
        }
      }
    } else if (isContextDecision) {
      // actor 为空却消费 context 决策 → 拒绝（不得 fail-open 静默放行）。
      throw new ControlError("blocked", "permission_denied: actor identity required");
    }
    // context 决策必须有 decision_owner；无 owner 却访问 context 对象 → 拒绝。
    if (isContextDecision && !decisionOwner) {
      throw new ControlError("blocked", "permission_denied: work has no decision_owner but context access required");
    }

    // 3b. contract 版本复验 fail-closed。
    // staleness 已由上方无条件的 work.revision === old.contract_revision 绑定兜底
    // （attention 创建时即记录 contract_revision，漂移即拒）。客户端如额外携带
    // expected_contract_revision，必须与当前 work.revision 一致，否则拒绝。
    if (input.expected_contract_revision !== undefined && input.expected_contract_revision !== work.revision) {
      throw new ControlError("blocked", "stale_or_revoked: contract revision mismatch");
    }

    // 3c. 证据复验：context 证据对象未被 purged。
    if (evidenceObjId && typeof evidenceRev === "number") {
      const purgedRow = db.query("SELECT purged_at FROM control_context_objects WHERE object_id=? AND purged_at IS NOT NULL").get(evidenceObjId) as { purged_at: string } | null;
      if (purgedRow) throw new ControlError("blocked", "evidence_mismatch: evidence has been purged");
    }
    if (work.state !== "active") throw new ControlError("blocked", "work is not active");
    const workRevision = work.revision + 1;
    assertNoInFlightAttention(db, work.work_id, workRevision);
    const applicable = affectedAttention(db, work.work_id, workRevision, itemId);
    verifyAffectedSnapshot(snapshot, old, applicable);
    const applying: AttentionItem = { ...old, revision: old.revision + 1, state: "applying", effect_state: "applying", updated_at: now, evidence: { ...old.evidence, selected_option: input.selected_option, decision_reason: input.reason ?? null, decided_at: now } };
    persistAttention(db, old, applying, "applying", { selected_option: input.selected_option }, now);
    let contract = work.contract;
    let state: Work["state"] = work.state;
    let workKind = "work.continued";
    if (input.selected_option === "stop") { state = "stopped"; workKind = "work.stopped"; }
    if (input.selected_option === "narrow") { contract = input.replacement_contract!; workKind = "contract.revised"; db.query("INSERT INTO control_contract_revisions VALUES (?,?,?,?,?)").run(work.work_id, workRevision, JSON.stringify(contract), input.reason, now); }
    if (!db.query("UPDATE control_works SET revision=?,state=?,contract=?,updated_at=? WHERE work_id=? AND revision=? AND state='active'").run(workRevision, state, contract ? JSON.stringify(contract) : null, now, work.work_id, work.revision).changes) throw new ControlError("conflict", "stale work revision");
    for (const prior of applicable) supersedeAttention(db, prior, workRevision, { superseded_by_item_id: itemId, superseded_reason: input.reason ?? null }, now);
    const changedWork: Work = { ...work, revision: workRevision, state, contract, updated_at: now };
    emitWork(db, changedWork, workKind);
    const resolved: AttentionItem = { ...applying, revision: applying.revision + 1, state: "resolved", effect_state: "succeeded", contract_revision: workRevision, updated_at: now, evidence: { ...applying.evidence, effect_verified_at: now } };
    persistAttention(db, applying, resolved, "resolved", { selected_option: input.selected_option, work_revision: workRevision }, now);
    return resolved;
  });
  return tx.immediate() as AttentionItem;
}

export function resolveAttention(
  db: Database,
  itemId: string,
  input: AttentionDecisionInput,
  actor: string,
  now = Date.now(),
): AttentionItem {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(input?.attention_revision) || input.attention_revision! < 1) {
    throw new ControlError("invalid", "attention_revision is required");
  }
  const current = getAttention(db, itemId);
  if (!current) throw new ControlError("not_found", "attention item not found");
  if (current.revision !== input.attention_revision) throw staleAttentionError(current, input.attention_revision!);
  const material = getAttentionMaterial(db, itemId);
  if (!input.material_fingerprint || !material || material.fingerprint !== input.material_fingerprint) {
    throw staleAttentionError(current, input.attention_revision!);
  }
  return resolveAttentionDecision(db, itemId, input.attention_revision!, input, now, actor);
}

export function actOnAttention(db: Database, itemId: string, expectedRevision: number, action: "ack" | "defer" | "resolve", input: { defer_until?: number; reason?: string; selected_option?: string; replacement_contract?: Contract; expected_contract_revision?: number; affected_cards?: AttentionCardSnapshot[] } = {}, actor?: string, now = Date.now()): AttentionItem {
  if (action === "resolve" && input.selected_option !== undefined) return resolveAttentionDecision(db, itemId, expectedRevision, input as AttentionDecisionInput, now, actor);
  ensureControlSchema(db);
  const tx = db.transaction(() => {
    const old = getAttention(db, itemId);
    if (!old) throw new ControlError("not_found", "attention item not found");
    if (old.revision !== expectedRevision) throw new ControlError("conflict", "stale attention revision");
    if (action === "defer" && (!input.defer_until || input.defer_until <= now)) throw new ControlError("invalid", "defer_until must be in future");
    if (action === "resolve" && old.approval_id && (old.effect_state === "not_started" || old.effect_state === "applying" || old.effect_state === "unknown")) throw new ControlError("blocked", "external effect is not confirmed");
    const item = { ...old, revision: old.revision + 1, updated_at: now };
    if (action === "ack") item.acknowledged_at = now;
    else if (action === "defer") item.defer_until = input.defer_until!;
    else item.state = "resolved";
    persistAttention(db, old, item, action, input as Record<string, unknown>, now);
    return item;
  });
  return tx.immediate() as AttentionItem;
}
export function recordAttentionFeedback(db:Database,itemId:string,expectedRevision:number,useful:boolean,reason?:string,now=Date.now()):void {ensureControlSchema(db);const tx=db.transaction(()=>{const item=getAttention(db,itemId);if(!item)throw new ControlError("not_found","attention item not found");if(item.revision!==expectedRevision)throw new ControlError("conflict","stale attention revision");try{db.query("INSERT INTO control_feedback VALUES (?,?,?,?,?)").run(itemId,expectedRevision,useful?1:0,reason??null,now);}catch{throw new ControlError("conflict","feedback already recorded");}enqueueControlEvent(db,{entity_id:itemId,entity_version:expectedRevision,kind:"attention.feedback",work_id:item.work_id,item_id:itemId,payload:{item_id:itemId,revision:expectedRevision,useful,reason:reason??null}},now);});tx.immediate();}

/** Atomically activate a candidate and publish the same audited revision as contract edits. */
export function promoteWork(db: Database, workId: string, expectedRevision: number, contract: Contract, reason: string, now = Date.now()): Work {
  return db.transaction(() => {
    const work = getWork(db, workId);
    if (!work) throw new ControlError("not_found", "work not found");
    if (work.state !== "candidate") throw new ControlError("conflict", "work is not a candidate");
    if (work.revision !== expectedRevision) throw new ControlError("conflict", "work revision changed");
    validateContract(contract);
    reviseContract(db, workId, expectedRevision, contract, reason, now);
    db.run("UPDATE control_works SET state='active',updated_at=? WHERE work_id=? AND state='candidate'", [now,workId]);
    const promoted = getWork(db, workId)!;
    ensureRootProblemLocked(db, workId, now);
    emitWork(db, promoted, "work.promoted", {reason});
    return getWork(db, workId)!;
  }).immediate();
}

// ── Phase B: condition waits, prerequisite edges and Work completion (phaseB contract §§3–7) ──

const WAIT_POLL_INTERVAL_MS = 5 * 60_000;
const WAIT_BACKOFF_CAP_MS = 30 * 60_000;
const WAIT_JITTER_MS = 30_000;
const WAIT_LIST_DEFAULT_LIMIT = 100;
const WAIT_LIST_MAX_LIMIT = 200;
const WAIT_TEXT_MAX = 500;
const WAIT_ERROR_DETAIL_MAX = 2000;
const WAIT_STATES: readonly WaitState[] = ["watching", "ready", "unavailable", "expired", "cancelled"];
// §7.2: permanent errors settle to unavailable; transient/rate-limit/unknown consume the persisted budget.
const WAIT_ERROR_CLASS: Record<WaitErrorKind, "permanent" | "transient"> = {
  permission_denied: "permanent", unsupported_provider: "permanent", configuration: "permanent",
  invalid_response: "permanent", identity_mismatch: "permanent", source_missing: "permanent",
  transient: "transient", rate_limited: "transient", unknown: "transient",
};
// Same predicate as the partial unique index control_waits_exact_unsettled.
const UNSETTLED_WAIT = "(state='watching' OR disposition_state IN ('pending','dispatching','dispatched','effect_failed','effect_unknown'))";
const GITHUB_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?$/;
const GITHUB_NAME = /^[a-z0-9._-]+$/;
const STALE_WAIT = "stale wait version";

function plainFields(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlError("invalid", `invalid ${name}`);
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra !== undefined) throw new ControlError("invalid", `unexpected ${name}.${extra}`);
  return value as Record<string, unknown>;
}
function exactId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()) throw new ControlError("invalid", `invalid ${name}`);
  return value;
}
function safeInteger(value: unknown, name: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) throw new ControlError("invalid", `invalid ${name}`);
  return value;
}
function boundedText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > WAIT_TEXT_MAX) throw new ControlError("invalid", `invalid ${name}`);
  return value.trim();
}
function githubName(value: unknown, name: string, pattern: RegExp): string {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!pattern.test(normalized) || normalized === "." || normalized === "..") throw new ControlError("invalid", `invalid ${name}`);
  return normalized;
}

function normalizeWaitCondition(value: unknown): WaitCondition {
  const condition = plainFields(value, ["kind", "source"], "condition");
  if (condition.kind === "github_pr_merged") {
    const source = plainFields(condition.source, ["provider", "host", "owner", "repo", "number"], "condition.source");
    if (source.provider !== "github") throw new ControlError("invalid", "invalid condition.source.provider");
    return { kind: "github_pr_merged", source: {
      provider: "github",
      host: githubName(source.host, "condition.source.host", GITHUB_HOST),
      owner: githubName(source.owner, "condition.source.owner", GITHUB_NAME),
      repo: githubName(source.repo, "condition.source.repo", GITHUB_NAME),
      number: safeInteger(source.number, "condition.source.number", 1),
    } };
  }
  if (condition.kind === "check_new_result") {
    const source = plainFields(condition.source, ["orchestrator_db", "work_id", "task_id", "attempt_id", "check_id", "check_def_version"], "condition.source");
    if (source.orchestrator_db !== "local") throw new ControlError("invalid", "invalid condition.source.orchestrator_db");
    const checkDefVersion = exactId(source.check_def_version, "condition.source.check_def_version");
    if (checkDefVersion === "unknown") throw new ControlError("invalid", "check_def_version must identify an exact check definition");
    return { kind: "check_new_result", source: {
      orchestrator_db: "local",
      work_id: exactId(source.work_id, "condition.source.work_id"),
      task_id: exactId(source.task_id, "condition.source.task_id"),
      attempt_id: exactId(source.attempt_id, "condition.source.attempt_id"),
      check_id: exactId(source.check_id, "condition.source.check_id"),
      check_def_version: checkDefVersion,
    } };
  }
  if (condition.kind === "work_completed") {
    const source = plainFields(condition.source, ["prerequisite_work_id", "dependency_revision"], "condition.source");
    return { kind: "work_completed", source: {
      prerequisite_work_id: exactId(source.prerequisite_work_id, "condition.source.prerequisite_work_id"),
      dependency_revision: safeInteger(source.dependency_revision, "condition.source.dependency_revision", 1),
    } };
  }
  throw new ControlError("invalid", "unsupported condition kind");
}

function normalizeWaitDisposition(value: unknown): WaitDispositionInput {
  if (value === undefined) return { kind: "redecide" };
  const disposition = plainFields(value, ["kind", "authorization"], "disposition");
  if (disposition.kind === "redecide" && disposition.authorization === undefined) return { kind: "redecide" };
  if (disposition.kind !== "authorized_resume") throw new ControlError("invalid", "invalid disposition");
  const grant = plainFields(disposition.authorization, ["consumer_owner", "approval_id", "target_version", "approved_effect", "work_revision",
    "attention_revision", "attempt_id", "checkpoint_reference", "execution_owner", "expires_at"], "disposition.authorization");
  if (grant.consumer_owner !== "extension" && grant.consumer_owner !== "orchestrator") throw new ControlError("invalid", "invalid authorization.consumer_owner");
  if (grant.approved_effect !== "answer_blocked_request" && grant.approved_effect !== "resume_checkpoint") throw new ControlError("invalid", "invalid authorization.approved_effect");
  return { kind: "authorized_resume", authorization: {
    consumer_owner: grant.consumer_owner,
    approval_id: exactId(grant.approval_id, "authorization.approval_id"),
    target_version: exactId(grant.target_version, "authorization.target_version"),
    approved_effect: grant.approved_effect,
    work_revision: safeInteger(grant.work_revision, "authorization.work_revision", 1),
    attention_revision: safeInteger(grant.attention_revision, "authorization.attention_revision", 1),
    attempt_id: exactId(grant.attempt_id, "authorization.attempt_id"),
    checkpoint_reference: exactId(grant.checkpoint_reference, "authorization.checkpoint_reference"),
    execution_owner: exactId(grant.execution_owner, "authorization.execution_owner"),
    expires_at: safeInteger(grant.expires_at, "authorization.expires_at", 1),
  } };
}

/** Closed-union validation; rejects client-supplied actor/owner/identity fields by construction. */
function normalizeCreateWaitInput(value: unknown): Required<CreateWaitInput> {
  const input = plainFields(value, ["work_id", "item_id", "condition", "deadline_at", "disposition", "transient_budget"], "wait input");
  const budget = input.transient_budget === undefined ? 3 : safeInteger(input.transient_budget, "transient_budget", 1);
  if (budget > 3) throw new ControlError("invalid", "invalid transient_budget");
  return {
    work_id: exactId(input.work_id, "work_id"),
    item_id: exactId(input.item_id, "item_id"),
    condition: normalizeWaitCondition(input.condition),
    deadline_at: safeInteger(input.deadline_at, "deadline_at", 1),
    disposition: normalizeWaitDisposition(input.disposition),
    transient_budget: budget,
  };
}

function assertCreatableAt(input: Required<CreateWaitInput>, now: number): void {
  if (input.deadline_at <= now) throw new ControlError("invalid", "deadline_at must be in the future");
  if (input.disposition.kind === "authorized_resume" && input.disposition.authorization.expires_at <= now) throw new ControlError("blocked", "authorization has expired");
}

function assertDecisionOwner(work: Work, actor: string): void {
  const owner = work.contract?.decision_owner;
  if (!owner) throw new ControlError("blocked", "work has no decision owner");
  if (actor !== owner) throw new ControlError("forbidden", "actor is not the work decision owner");
}

function validateBaselineSnapshot(condition: WaitCondition, value: unknown): WaitBaselineSnapshot {
  const snapshot = plainFields(value, ["baseline", "baseline_generation", "fingerprint", "established_at"], "baseline snapshot");
  const generation = safeInteger(snapshot.baseline_generation, "baseline_generation", 0);
  if (typeof snapshot.fingerprint !== "string" || !snapshot.fingerprint) throw new ControlError("invalid", "invalid baseline fingerprint");
  const establishedAt = safeInteger(snapshot.established_at, "established_at", 0);
  const mismatch = new ControlError("invalid", "baseline does not match the condition identity");
  if (condition.kind === "github_pr_merged") {
    const baseline = plainFields(snapshot.baseline, ["provider", "host", "owner", "repo", "number", "state", "merged_at", "updated_at", "observed_at"], "baseline");
    const source = condition.source;
    if (baseline.provider !== source.provider || baseline.host !== source.host || baseline.owner !== source.owner
      || baseline.repo !== source.repo || baseline.number !== source.number) throw mismatch;
    const merged = baseline.state === "MERGED";
    if (!["OPEN", "CLOSED", "MERGED"].includes(baseline.state as string) || merged !== (typeof baseline.merged_at === "string")
      || (merged ? Number.isNaN(Date.parse(baseline.merged_at as string)) : baseline.merged_at !== null)
      || typeof baseline.updated_at !== "string" || Number.isNaN(Date.parse(baseline.updated_at))) throw new ControlError("invalid", "invalid PR baseline");
    safeInteger(baseline.observed_at, "baseline.observed_at", 0);
    return { baseline: baseline as PrBaseline, baseline_generation: generation, fingerprint: snapshot.fingerprint, established_at: establishedAt };
  }
  if (condition.kind === "check_new_result") {
    const baseline = plainFields(snapshot.baseline, ["attempt_id", "check_id", "check_def_version", "result_set_version", "observed_at"], "baseline");
    const source = condition.source;
    if (baseline.attempt_id !== source.attempt_id || baseline.check_id !== source.check_id || baseline.check_def_version !== source.check_def_version) throw mismatch;
    if (safeInteger(baseline.result_set_version, "baseline.result_set_version", 0) !== generation) throw new ControlError("invalid", "check baseline generation must equal result_set_version");
    if (baseline.observed_at !== null) safeInteger(baseline.observed_at, "baseline.observed_at", 0);
    return { baseline: baseline as CheckBaseline, baseline_generation: generation, fingerprint: snapshot.fingerprint, established_at: establishedAt };
  }
  const baseline = plainFields(snapshot.baseline, ["prerequisite_work_id", "dependency_revision", "work_revision", "state", "observed_at"], "baseline");
  if (baseline.prerequisite_work_id !== condition.source.prerequisite_work_id || baseline.dependency_revision !== condition.source.dependency_revision) throw mismatch;
  if (safeInteger(baseline.work_revision, "baseline.work_revision", 1) !== generation) throw new ControlError("invalid", "work baseline generation must equal work_revision");
  if (!["candidate", "active", "stopped", "completed"].includes(baseline.state as string)) throw new ControlError("invalid", "invalid work baseline state");
  safeInteger(baseline.observed_at, "baseline.observed_at", 0);
  return { baseline: baseline as WorkBaseline, baseline_generation: generation, fingerprint: snapshot.fingerprint, established_at: establishedAt };
}

function waitFrom(row: Record<string, unknown>): ConditionWait {
  const object = (value: unknown) => value === null ? null : parseObject<Record<string, unknown>>(value as string);
  return {
    wait_id: row.wait_id as string, work_id: row.work_id as string, item_id: row.item_id as string,
    condition: parseObject<WaitCondition>(row.condition_json as string),
    source_identity: parseObject<Record<string, unknown>>(row.source_identity as string),
    baseline_established_at: row.baseline_established_at as number,
    baseline: parseObject<WaitBaseline>(row.baseline_json as string),
    baseline_generation: row.baseline_generation as number, source_generation: row.source_generation as number,
    observed: object(row.observed_json), observed_fingerprint: row.observed_fingerprint as string | null,
    observed_generation: row.observed_generation as number, unchanged_count: row.unchanged_count as number,
    last_observed_at: row.last_observed_at as number | null, last_confirmed_at: row.last_confirmed_at as number | null,
    state: row.state as WaitState, state_reason: row.state_reason as string | null,
    ready_at: row.ready_at as number | null, ready_observation_fingerprint: row.ready_observation_fingerprint as string | null,
    deadline_at: row.deadline_at as number, next_check_at: row.next_check_at as number | null,
    transient_failures: row.transient_failures as number, transient_budget: row.transient_budget as number,
    last_error_kind: row.last_error_kind as WaitErrorKind | null, last_error_detail: row.last_error_detail as string | null,
    retry_after_at: row.retry_after_at as number | null,
    version: row.version as number, actor: row.actor as string, decision_owner: row.decision_owner as string,
    disposition: row.disposition as ConditionWait["disposition"],
    resume_grant: object(row.authorization_json) as WaitResumeGrant | null,
    disposition_state: row.disposition_state as WaitDispositionState | null,
    disposition_claim_id: row.disposition_claim_id as string | null, dispatch_id: row.dispatch_id as string | null,
    disposition_detail: object(row.disposition_detail),
    disposition_at: row.disposition_at as number | null, effect_observed_at: row.effect_observed_at as number | null,
    created_at: row.created_at as number, updated_at: row.updated_at as number,
  };
}

function waitConflict(code: WaitConflictBody["code"], wait: ConditionWait): WaitConflictBody {
  return { error: "conflict", code, message: code === "active_wait_exists" ? "active wait exists" : "wait is not cancellable",
    wait_id: wait.wait_id, version: wait.version, state: wait.state, disposition_state: wait.disposition_state };
}

/** Locked create checks shared by preflight and insert: Work/owner/item/edge/uniqueness (§3.3, §4.2). */
function assertWaitTargetLocked(db: Database, input: Required<CreateWaitInput>, actor: string): Work {
  const work = getWork(db, input.work_id);
  if (!work) throw new ControlError("not_found", "work not found");
  if (work.state !== "active") throw new ControlError("conflict", "work is not active");
  assertDecisionOwner(work, actor);
  const item = getAttention(db, input.item_id);
  if (!item) throw new ControlError("not_found", "attention item not found");
  if (item.work_id !== work.work_id) throw new ControlError("invalid", "attention item belongs to another work");
  if (item.state !== "open" && item.state !== "applying") throw new ControlError("conflict", "attention item is not an open responsibility");
  if (item.contract_revision !== work.revision) throw new ControlError("conflict", "stale contract revision");
  const condition = input.condition;
  if (condition.kind === "work_completed") {
    if (condition.source.prerequisite_work_id === work.work_id) throw new ControlError("invalid", "work cannot wait on its own completion");
    const edge = getActiveDependencyEdge(db, work.work_id, condition.source.prerequisite_work_id);
    if (!edge) throw new ControlError("blocked", "no active dependency edge for this prerequisite");
    if (edge.revision !== condition.source.dependency_revision) throw new ControlError("conflict", "stale dependency revision");
  }
  if (condition.kind === "check_new_result" && !getWork(db, condition.source.work_id)) throw new ControlError("not_found", "check source work not found");
  if (input.disposition.kind === "authorized_resume") {
    const grant = input.disposition.authorization;
    if (grant.work_revision !== work.revision || grant.attention_revision !== item.revision
      || item.approval_id !== grant.approval_id || item.consumer_owner !== grant.consumer_owner) {
      throw new ControlError("blocked", "authorization scope does not match the current work and attention");
    }
  }
  const identityJson = canonicalJson(condition.source);
  const identityHash = controlPayloadHash(condition.source);
  if (db.query("SELECT 1 FROM control_waits WHERE source_identity_hash=? AND source_identity<>? LIMIT 1").get(identityHash, identityJson)) {
    throw new ControlError("blocked", "wait source identity hash collision");
  }
  const existing = db.query(`SELECT * FROM control_waits WHERE work_id=? AND item_id=? AND condition_kind=? AND source_identity_hash=? AND ${UNSETTLED_WAIT}`)
    .get(work.work_id, item.item_id, condition.kind, identityHash) as Record<string, unknown> | null;
  if (existing) throw new ControlError("conflict", "active_wait_exists", waitConflict("active_wait_exists", waitFrom(existing)));
  return work;
}

/**
 * Non-mutating create checks run before any source IO (`createWait`), so an unauthorized or
 * duplicate request never reaches an external provider. Returns the canonical input.
 */
export function preflightConditionWait(db: Database, input: CreateWaitInput, context: { actor: string; now?: number }): Required<CreateWaitInput> {
  ensureControlSchema(db);
  const normalized = normalizeCreateWaitInput(input);
  const actor = exactId(context?.actor, "actor");
  assertCreatableAt(normalized, context.now === undefined ? Date.now() : safeInteger(context.now, "now", 0));
  assertWaitTargetLocked(db, normalized, actor);
  return normalized;
}

export function createConditionWait(
  db: Database,
  input: CreateWaitInput,
  context: { actor: string; baseline: WaitBaselineSnapshot; now?: number },
): ConditionWait {
  ensureControlSchema(db);
  const normalized = normalizeCreateWaitInput(input);
  const actor = exactId(context?.actor, "actor");
  const snapshot = validateBaselineSnapshot(normalized.condition, context.baseline);
  // created_at is taken after the baseline sample; a regressed clock rejects instead of rewriting the sample time.
  const now = context.now === undefined ? Date.now() : safeInteger(context.now, "now", 0);
  if (snapshot.established_at > now) throw new ControlError("invalid", "baseline sample is later than wait creation (clock regression)");
  assertCreatableAt(normalized, now);
  return db.transaction(() => {
    const work = assertWaitTargetLocked(db, normalized, actor);
    const waitId = randomUUID();
    const grant = normalized.disposition.kind === "authorized_resume" ? normalized.disposition.authorization : null;
    // DDL requires next_check_at < deadline_at: the first check is the earlier of one interval or the last pre-deadline instant.
    const nextCheckAt = Math.min(now + WAIT_POLL_INTERVAL_MS, normalized.deadline_at - 1);
    db.query(`INSERT INTO control_waits(wait_id,work_id,item_id,condition_kind,condition_json,source_identity,source_identity_hash,
      baseline_json,baseline_established_at,baseline_generation,source_generation,observed_json,observed_fingerprint,observed_generation,
      unchanged_count,last_observed_at,last_confirmed_at,state,deadline_at,next_check_at,transient_failures,transient_budget,version,
      actor,decision_owner,disposition,authorization_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,0,?,?,'watching',?,?,0,?,1,?,?,?,?,?,?)`).run(
      waitId, work.work_id, normalized.item_id, normalized.condition.kind, canonicalJson(normalized.condition),
      canonicalJson(normalized.condition.source), controlPayloadHash(normalized.condition.source),
      canonicalJson(snapshot.baseline), snapshot.established_at, snapshot.baseline_generation, snapshot.baseline_generation,
      canonicalJson(snapshot.baseline), snapshot.fingerprint, snapshot.established_at, snapshot.established_at,
      normalized.deadline_at, nextCheckAt, normalized.transient_budget, actor, work.contract!.decision_owner,
      normalized.disposition.kind, grant ? canonicalJson(grant) : null, now, now,
    );
    const wait = waitFrom(db.query("SELECT * FROM control_waits WHERE wait_id=?").get(waitId) as Record<string, unknown>);
    enqueueControlEvent(db, { entity_id: wait.wait_id, entity_version: wait.version, kind: "wait.created", work_id: wait.work_id, item_id: wait.item_id, payload: { wait } }, now);
    return wait;
  }).immediate() as ConditionWait;
}

function loadWait(db: Database, waitId: string, now: number): ConditionWait {
  const row = db.query("SELECT * FROM control_waits WHERE wait_id=?").get(waitId) as Record<string, unknown> | null;
  if (!row) throw new ControlError("not_found", "wait not found");
  const wait = waitFrom(row);
  if (now < wait.created_at) throw new ControlError("invalid", "mutation time precedes wait creation");
  return wait;
}

/** CAS-writes the next version and publishes it in the same transaction; one version may carry several event kinds. */
function writeWait(db: Database, before: ConditionWait, after: ConditionWait, ...kinds: string[]): ConditionWait {
  const changed = db.query(`UPDATE control_waits SET source_generation=?,observed_json=?,observed_fingerprint=?,observed_generation=?,
    unchanged_count=?,last_observed_at=?,last_confirmed_at=?,state=?,state_reason=?,ready_at=?,ready_observation_fingerprint=?,
    next_check_at=?,transient_failures=?,last_error_kind=?,last_error_detail=?,retry_after_at=?,version=?,disposition_state=?,
    disposition_claim_id=?,dispatch_id=?,disposition_detail=?,disposition_at=?,effect_observed_at=?,updated_at=?
    WHERE wait_id=? AND version=?`).run(
    after.source_generation, after.observed ? canonicalJson(after.observed) : null, after.observed_fingerprint, after.observed_generation,
    after.unchanged_count, after.last_observed_at, after.last_confirmed_at, after.state, after.state_reason, after.ready_at,
    after.ready_observation_fingerprint, after.next_check_at, after.transient_failures, after.last_error_kind, after.last_error_detail,
    after.retry_after_at, before.version + 1, after.disposition_state, after.disposition_claim_id, after.dispatch_id,
    after.disposition_detail ? canonicalJson(after.disposition_detail) : null, after.disposition_at, after.effect_observed_at,
    after.updated_at, before.wait_id, before.version,
  );
  if (!changed.changes) throw new ControlError("conflict", STALE_WAIT);
  const wait = waitFrom(db.query("SELECT * FROM control_waits WHERE wait_id=?").get(before.wait_id) as Record<string, unknown>);
  for (const kind of kinds) {
    enqueueControlEvent(db, { entity_id: wait.wait_id, entity_version: wait.version, kind, work_id: wait.work_id, item_id: wait.item_id, payload: { wait } }, wait.updated_at);
  }
  return wait;
}

export function getConditionWait(db: Database, waitId: string): ConditionWait | null {
  ensureControlSchema(db);
  const row = db.query("SELECT * FROM control_waits WHERE wait_id=?").get(waitId) as Record<string, unknown> | null;
  return row ? waitFrom(row) : null;
}

export function listConditionWaits(
  db: Database,
  filter: { work_id?: string; item_id?: string; state?: WaitState; limit?: number } = {},
): ConditionWait[] {
  ensureControlSchema(db);
  const fields = plainFields(filter, ["work_id", "item_id", "state", "limit"], "wait filter");
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (fields.work_id !== undefined) { clauses.push("work_id=?"); params.push(exactId(fields.work_id, "work_id")); }
  if (fields.item_id !== undefined) { clauses.push("item_id=?"); params.push(exactId(fields.item_id, "item_id")); }
  if (fields.state !== undefined) {
    if (!WAIT_STATES.includes(fields.state as WaitState)) throw new ControlError("invalid", "invalid wait state filter");
    clauses.push("state=?"); params.push(fields.state as WaitState);
  }
  const limit = fields.limit === undefined ? WAIT_LIST_DEFAULT_LIMIT : Math.min(safeInteger(fields.limit, "limit", 1), WAIT_LIST_MAX_LIMIT);
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return (db.query(`SELECT * FROM control_waits ${where} ORDER BY updated_at DESC, wait_id DESC LIMIT ?`).all(...params, limit) as Record<string, unknown>[]).map(waitFrom);
}

export function listDueConditionWaits(db: Database, now: number, limit: number): ConditionWait[] {
  ensureControlSchema(db);
  safeInteger(now, "now", 0);
  const bounded = Math.min(safeInteger(limit, "limit", 1), WAIT_LIST_MAX_LIMIT);
  return (db.query("SELECT * FROM control_waits WHERE state='watching' AND next_check_at<=? ORDER BY next_check_at, wait_id LIMIT ?")
    .all(now, bounded) as Record<string, unknown>[]).map(waitFrom);
}

/** Oldest-first settled waits whose disposition was never recorded (e.g. a crash between the settle CAS and redecision). */
export function listPendingWaitDispositions(db: Database, limit: number): ConditionWait[] {
  ensureControlSchema(db);
  const bounded = Math.min(safeInteger(limit, "limit", 1), WAIT_LIST_MAX_LIMIT);
  return (db.query("SELECT * FROM control_waits WHERE disposition_state='pending' ORDER BY updated_at, wait_id LIMIT ?")
    .all(bounded) as Record<string, unknown>[]).map(waitFrom);
}

export function cancelConditionWait(
  db: Database,
  waitId: string,
  expectedVersion: number,
  context: { actor: string; reason: string; now?: number },
): ConditionWait {
  ensureControlSchema(db);
  exactId(waitId, "wait_id");
  safeInteger(expectedVersion, "expected version", 1);
  const actor = exactId(context?.actor, "actor");
  const reason = boundedText(context.reason, "reason");
  const now = context.now === undefined ? Date.now() : safeInteger(context.now, "now", 0);
  return db.transaction(() => {
    const before = loadWait(db, waitId, now);
    assertDecisionOwner(getWork(db, before.work_id)!, actor);
    if (before.state !== "watching") throw new ControlError("conflict", "wait is not cancellable", waitConflict("wait_not_cancellable", before));
    if (before.version !== expectedVersion) throw new ControlError("conflict", STALE_WAIT);
    return writeWait(db, before, { ...before, state: "cancelled", state_reason: reason, next_check_at: null, retry_after_at: null, updated_at: now }, "wait.cancelled");
  }).immediate() as ConditionWait;
}

function validateWaitObservation(value: unknown): WaitObservation {
  const kind = (value as { kind?: unknown } | null)?.kind;
  if (kind === "error") {
    const observation = plainFields(value, ["kind", "error_kind", "detail", "observed_at", "retry_after_at"], "observation");
    const errorKind = observation.error_kind as WaitErrorKind;
    if (typeof errorKind !== "string" || !Object.hasOwn(WAIT_ERROR_CLASS, errorKind)) throw new ControlError("invalid", "invalid observation.error_kind");
    if (typeof observation.detail !== "string" || !observation.detail.trim()) throw new ControlError("invalid", "invalid observation.detail");
    return {
      kind: "error", error_kind: errorKind, detail: observation.detail, observed_at: safeInteger(observation.observed_at, "observation.observed_at", 0),
      ...(observation.retry_after_at === undefined ? {} : { retry_after_at: safeInteger(observation.retry_after_at, "observation.retry_after_at", 0) }),
    };
  }
  if (kind !== "same" && kind !== "changed_not_ready" && kind !== "ready") throw new ControlError("invalid", "invalid observation kind");
  const observation = plainFields(value, ["kind", "observed", "fingerprint", "source_generation", "observed_at"], "observation");
  const observed = observation.observed;
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) throw new ControlError("invalid", "invalid observation.observed");
  if (typeof observation.fingerprint !== "string" || !observation.fingerprint) throw new ControlError("invalid", "invalid observation.fingerprint");
  return {
    kind, observed: observed as Record<string, unknown>, fingerprint: observation.fingerprint,
    source_generation: safeInteger(observation.source_generation, "observation.source_generation", 0),
    observed_at: safeInteger(observation.observed_at, "observation.observed_at", 0),
  };
}

function recordWaitFailure(db: Database, before: ConditionWait, observation: Extract<WaitObservation, { kind: "error" }>, now: number): ConditionWait {
  // Errors never touch observed/last_observed/last_confirmed: the last verified snapshot is retained (§3.3).
  const failed: ConditionWait = { ...before, last_error_kind: observation.error_kind, last_error_detail: observation.detail.slice(0, WAIT_ERROR_DETAIL_MAX), updated_at: now };
  const settle = (state: "unavailable" | "expired", reason: string, transientFailures: number, kind: string) => writeWait(db, before,
    { ...failed, state, state_reason: reason, transient_failures: transientFailures, next_check_at: null, retry_after_at: null, disposition_state: "pending" }, kind);
  if (WAIT_ERROR_CLASS[observation.error_kind] === "permanent") return settle("unavailable", observation.error_kind, before.transient_failures, "wait.unavailable");
  const failures = before.transient_failures + 1;
  if (failures >= before.transient_budget) return settle("expired", "transient_budget_exhausted", failures, "wait.expired");
  const hint = observation.retry_after_at !== undefined && observation.retry_after_at > now ? Math.min(observation.retry_after_at, before.deadline_at) : null;
  const jitter = Number.parseInt(createHash("sha256").update(before.wait_id).digest("hex").slice(0, 8), 16) % WAIT_JITTER_MS;
  const retryAt = hint ?? now + Math.min(WAIT_POLL_INTERVAL_MS * 2 ** (failures - 1), WAIT_BACKOFF_CAP_MS) + jitter;
  if (retryAt >= before.deadline_at) return settle("expired", "deadline", failures, "wait.expired");
  return writeWait(db, before, { ...failed, transient_failures: failures, retry_after_at: retryAt, next_check_at: retryAt }, "wait.observation_failed");
}

export function observeConditionWait(
  db: Database,
  waitId: string,
  expectedVersion: number,
  observation: WaitObservation,
  schedule: { next_check_at: number | null },
  now = Date.now(),
): { wait: ConditionWait; became_ready: boolean } {
  ensureControlSchema(db);
  exactId(waitId, "wait_id");
  safeInteger(expectedVersion, "expected version", 1);
  safeInteger(now, "now", 0);
  const incoming = validateWaitObservation(observation);
  const requested = plainFields(schedule, ["next_check_at"], "schedule").next_check_at;
  const nextCheckAt = requested === null ? null : safeInteger(requested, "schedule.next_check_at", 0);
  return db.transaction(() => {
    const before = loadWait(db, waitId, now);
    if (before.version !== expectedVersion) throw new ControlError("conflict", STALE_WAIT);
    if (before.state !== "watching") throw new ControlError("conflict", `wait is ${before.state}`);
    if (now >= before.deadline_at) throw new ControlError("conflict", "wait deadline reached; expire it without observing");
    const floor = incoming.kind === "error" ? before.baseline_established_at : before.last_observed_at ?? before.baseline_established_at;
    if (incoming.observed_at < floor || incoming.observed_at > now) throw new ControlError("invalid", "observation time is outside the wait chronology");
    if (incoming.kind === "error") return { wait: recordWaitFailure(db, before, incoming, now), became_ready: false };
    const fingerprintChanged = incoming.fingerprint !== before.observed_fingerprint;
    const confirmed: ConditionWait = {
      ...before, observed: incoming.observed, observed_fingerprint: incoming.fingerprint, source_generation: incoming.source_generation,
      observed_generation: before.observed_generation + (fingerprintChanged ? 1 : 0), last_observed_at: incoming.observed_at,
      last_confirmed_at: incoming.observed_at, transient_failures: 0, last_error_kind: null, last_error_detail: null, retry_after_at: null, updated_at: now,
    };
    if (incoming.kind === "ready") {
      if (incoming.source_generation <= before.baseline_generation || incoming.source_generation <= before.source_generation) {
        throw new ControlError("invalid", "ready observation must advance past the baseline and persisted source generation");
      }
      return { wait: writeWait(db, before, { ...confirmed, unchanged_count: 0, state: "ready", ready_at: now, ready_observation_fingerprint: incoming.fingerprint,
        next_check_at: null, disposition_state: "pending" }, "wait.ready"), became_ready: true };
    }
    if (incoming.source_generation < before.source_generation) throw new ControlError("invalid", "observation regresses the source generation");
    // Same fingerprint and same generation is `same` regardless of poll time; a grown generation is never `same`.
    const unchanged = !fingerprintChanged && incoming.source_generation === before.source_generation;
    if (incoming.kind === "same" && !unchanged) throw new ControlError("invalid", "same observation must repeat the persisted fingerprint and source generation");
    const observed: ConditionWait = { ...confirmed, unchanged_count: unchanged ? before.unchanged_count + 1 : 0 };
    if (nextCheckAt === null || nextCheckAt >= before.deadline_at) {
      return { wait: writeWait(db, before, { ...observed, state: "expired", state_reason: "deadline", next_check_at: null, disposition_state: "pending" }, "wait.expired"), became_ready: false };
    }
    if (nextCheckAt < now) throw new ControlError("invalid", "next check must not precede the observation");
    return { wait: writeWait(db, before, { ...observed, next_check_at: nextCheckAt }, "wait.observed"), became_ready: false };
  }).immediate() as { wait: ConditionWait; became_ready: boolean };
}

export function expireConditionWait(
  db: Database,
  waitId: string,
  expectedVersion: number,
  reason: "deadline" | "transient_budget_exhausted",
  now = Date.now(),
): ConditionWait {
  ensureControlSchema(db);
  exactId(waitId, "wait_id");
  safeInteger(expectedVersion, "expected version", 1);
  safeInteger(now, "now", 0);
  if (reason !== "deadline" && reason !== "transient_budget_exhausted") throw new ControlError("invalid", "invalid expiry reason");
  return db.transaction(() => {
    const before = loadWait(db, waitId, now);
    if (before.version !== expectedVersion) throw new ControlError("conflict", STALE_WAIT);
    if (before.state !== "watching") throw new ControlError("conflict", `wait is ${before.state}`);
    const reached = reason === "deadline" ? now >= before.deadline_at : before.transient_failures >= before.transient_budget;
    if (!reached) throw new ControlError("conflict", `wait has not reached its ${reason}`);
    return writeWait(db, before, { ...before, state: "expired", state_reason: reason, next_check_at: null, retry_after_at: null, disposition_state: "pending", updated_at: now }, "wait.expired");
  }).immediate() as ConditionWait;
}

/** Effect state of a re-landed responsibility: failed/unknown outcomes stay visible; in-flight or unverified effects are never erased. */
function redecisionEffectState(item: AttentionItem, from: WaitDispositionState | null): AttentionItem["effect_state"] {
  if (from === "effect_failed") return "failed";
  if (from === "effect_unknown") return "unknown";
  return item.effect_state === "applying" || item.effect_state === "unknown" ? item.effect_state : "not_started";
}

/** Lands the wait outcome on the original Attention (the single responsibility chain, §8.2) in the caller's transaction. */
function landWaitResponsibility(db: Database, wait: ConditionWait, item: AttentionItem, reason: string, now: number, effectState: AttentionItem["effect_state"]): void {
  const work = getWork(db, wait.work_id)!;
  const landed: AttentionItem = {
    ...item, revision: item.revision + 1, state: "open", effect_state: effectState, contract_revision: work.revision,
    defer_until: null, acknowledged_at: null, updated_at: now,
    evidence: { ...item.evidence, wait_redecision: {
      wait_id: wait.wait_id, wait_version: wait.version, condition_kind: wait.condition.kind, wait_state: wait.state,
      state_reason: wait.state_reason, ready_at: wait.ready_at, last_confirmed_at: wait.last_confirmed_at,
      last_error_kind: wait.last_error_kind, observed: wait.observed, reason, recorded_at: now,
    } },
  };
  persistAttention(db, item, landed, "wait_redecision", { wait_id: wait.wait_id, wait_version: wait.version, reason }, now);
  projectAttentionMaterialLocked(db, landed, deriveAttentionMaterialInputs(db, landed, now), now);
}

function waitAttention(db: Database, wait: ConditionWait): AttentionItem {
  const item = getAttention(db, wait.item_id);
  if (!item) throw new ControlError("not_found", "attention item not found");
  if (item.work_id !== wait.work_id) throw new ControlError("conflict", "attention item moved to another work");
  return item;
}

export function recordWaitRedecision(
  db: Database,
  waitId: string,
  expectedVersion: number,
  input: { attention_revision: number; reason: string; now?: number },
): ConditionWait {
  ensureControlSchema(db);
  exactId(waitId, "wait_id");
  safeInteger(expectedVersion, "expected version", 1);
  const fields = plainFields(input, ["attention_revision", "reason", "now"], "redecision input");
  const attentionRevision = safeInteger(fields.attention_revision, "attention_revision", 1);
  const reason = boundedText(fields.reason, "reason");
  const now = fields.now === undefined ? Date.now() : safeInteger(fields.now, "now", 0);
  return db.transaction(() => {
    const before = loadWait(db, waitId, now);
    if (before.version !== expectedVersion) throw new ControlError("conflict", STALE_WAIT);
    const from = before.disposition_state;
    if (from !== "pending" && from !== "effect_failed" && from !== "effect_unknown") throw new ControlError("conflict", `wait disposition is ${from ?? "not started"}`);
    const item = waitAttention(db, before);
    if (item.revision !== attentionRevision) throw staleAttentionError(item, attentionRevision);
    // An authorized wait that returns to a human before any claim is a blocked auto disposition (§8.1).
    const blocked = before.state === "ready" && before.disposition === "authorized_resume" && from === "pending";
    const after: ConditionWait = {
      ...before, disposition_state: "redecision_recorded", disposition_at: now, updated_at: now, version: before.version + 1,
      disposition_detail: { ...(before.disposition_detail ?? {}), ...(blocked ? { blocked_reason: reason } : {}),
        redecision: { reason, from, attention_item_id: item.item_id, attention_revision: item.revision + 1 } },
    };
    landWaitResponsibility(db, after, item, reason, now, redecisionEffectState(item, from));
    return writeWait(db, before, after, ...(blocked ? ["wait.disposition_blocked", "wait.disposition_redecision"] : ["wait.disposition_redecision"]));
  }).immediate() as ConditionWait;
}

export function claimWaitDispatch(
  db: Database,
  waitId: string,
  expectedVersion: number,
  claimId: string,
  dispatchId: string,
  now = Date.now(),
): ConditionWait {
  ensureControlSchema(db);
  exactId(waitId, "wait_id");
  safeInteger(expectedVersion, "expected version", 1);
  exactId(claimId, "claim_id");
  exactId(dispatchId, "dispatch_id");
  safeInteger(now, "now", 0);
  return db.transaction(() => {
    const before = loadWait(db, waitId, now);
    if (before.version !== expectedVersion) throw new ControlError("conflict", STALE_WAIT);
    if (before.state !== "ready" || before.disposition !== "authorized_resume" || before.disposition_state !== "pending") {
      throw new ControlError("conflict", "only a pending authorized ready wait can be claimed for dispatch");
    }
    return writeWait(db, before, { ...before, disposition_state: "dispatching", disposition_claim_id: claimId, dispatch_id: dispatchId, disposition_at: now, updated_at: now }, "wait.disposition_claimed");
  }).immediate() as ConditionWait;
}

function validateDispatchResult(value: unknown): RecoveryDispatchResult {
  const state = (value as { state?: unknown } | null)?.state;
  if (state === "accepted") {
    const result = plainFields(value, ["state", "dispatch_id", "accepted_at"], "dispatch result");
    return { state, dispatch_id: exactId(result.dispatch_id, "dispatch_id"), accepted_at: safeInteger(result.accepted_at, "accepted_at", 0) };
  }
  if (state !== "rejected" && state !== "unknown") throw new ControlError("invalid", "invalid dispatch result");
  const result = plainFields(value, ["state", "reason", "dispatch_id"], "dispatch result");
  return { state, reason: boundedText(result.reason, "dispatch reason"), ...(result.dispatch_id === undefined ? {} : { dispatch_id: exactId(result.dispatch_id, "dispatch_id") }) };
}

export function recordWaitDispatch(
  db: Database,
  waitId: string,
  expectedVersion: number,
  claimId: string,
  result: RecoveryDispatchResult,
  now = Date.now(),
): ConditionWait {
  ensureControlSchema(db);
  exactId(waitId, "wait_id");
  safeInteger(expectedVersion, "expected version", 1);
  exactId(claimId, "claim_id");
  safeInteger(now, "now", 0);
  const outcome = validateDispatchResult(result);
  return db.transaction(() => {
    const before = loadWait(db, waitId, now);
    if (before.version !== expectedVersion) throw new ControlError("conflict", STALE_WAIT);
    if (before.disposition_state !== "dispatching") throw new ControlError("conflict", "wait is not dispatching");
    if (before.disposition_claim_id !== claimId) throw new ControlError("conflict", "dispatch claim mismatch");
    if (outcome.dispatch_id !== undefined && outcome.dispatch_id !== before.dispatch_id) throw new ControlError("conflict", "dispatch id mismatch");
    const item = waitAttention(db, before);
    const base: ConditionWait = { ...before, disposition_at: now, updated_at: now, version: before.version + 1,
      disposition_detail: { ...(before.disposition_detail ?? {}), dispatch: outcome } };
    if (outcome.state === "accepted") {
      if (outcome.accepted_at < before.disposition_at!) throw new ControlError("invalid", "dispatch acceptance precedes its claim");
      // Launch acceptance only moves the original responsibility to applying; success needs a bound effect (§8.4).
      persistAttention(db, item, { ...item, revision: item.revision + 1, state: "applying", effect_state: "applying", updated_at: now,
        evidence: { ...item.evidence, wait_dispatch: { wait_id: before.wait_id, wait_version: base.version, dispatch_id: before.dispatch_id, accepted_at: outcome.accepted_at } } },
      "wait_dispatch_accepted", { wait_id: before.wait_id, dispatch_id: before.dispatch_id }, now);
      return writeWait(db, before, { ...base, disposition_state: "dispatched" }, "wait.disposition_dispatched");
    }
    const reason = `dispatch ${outcome.state}: ${outcome.reason}`;
    if (outcome.state === "rejected") {
      const after: ConditionWait = { ...base, disposition_state: "redecision_recorded", disposition_detail: { ...base.disposition_detail, blocked_reason: reason,
        redecision: { reason, from: "dispatching", attention_item_id: item.item_id, attention_revision: item.revision + 1 } } };
      landWaitResponsibility(db, after, item, reason, now, redecisionEffectState(item, "dispatching"));
      return writeWait(db, before, after, "wait.disposition_blocked", "wait.disposition_redecision");
    }
    // Unknown acceptance may already have an external effect: keep the slot occupied (no replay) and hand verification to a human.
    const after: ConditionWait = { ...base, disposition_state: "effect_unknown", effect_observed_at: now, disposition_detail: { ...base.disposition_detail, blocked_reason: reason } };
    landWaitResponsibility(db, after, item, reason, now, "unknown");
    return writeWait(db, before, after, "wait.disposition_blocked");
  }).immediate() as ConditionWait;
}

export function recordWaitEffect(
  db: Database,
  waitId: string,
  expectedVersion: number,
  claimId: string,
  effect: { state: "succeeded" | "failed" | "unknown"; evidence: Record<string, unknown>; observed_at: number },
): ConditionWait {
  ensureControlSchema(db);
  exactId(waitId, "wait_id");
  safeInteger(expectedVersion, "expected version", 1);
  exactId(claimId, "claim_id");
  const fields = plainFields(effect, ["state", "evidence", "observed_at"], "effect");
  if (fields.state !== "succeeded" && fields.state !== "failed" && fields.state !== "unknown") throw new ControlError("invalid", "invalid effect state");
  const evidence = fields.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new ControlError("invalid", "invalid effect evidence");
  const record: { state: "succeeded" | "failed" | "unknown"; evidence: Record<string, unknown>; observed_at: number } = {
    state: fields.state, evidence: evidence as Record<string, unknown>, observed_at: safeInteger(fields.observed_at, "effect.observed_at", 0) };
  return db.transaction(() => {
    const before = loadWait(db, waitId, Math.max(Date.now(), record.observed_at));
    const now = Math.max(Date.now(), record.observed_at, before.updated_at);
    if (before.disposition_claim_id !== claimId) throw new ControlError("conflict", "dispatch claim mismatch");
    const recorded = before.disposition_detail?.effect;
    if (recorded !== undefined) {
      if (canonicalJson(recorded) === canonicalJson(record)) return before;
      throw new ControlError("conflict", "conflicting effect evidence");
    }
    if (before.version !== expectedVersion) throw new ControlError("conflict", STALE_WAIT);
    // effect_unknown without a recorded effect comes from an unknown dispatch result and reconciles by the same dispatch.
    if (before.disposition_state !== "dispatched" && before.disposition_state !== "effect_unknown") throw new ControlError("conflict", "wait has no dispatched effect to record");
    if (record.observed_at < before.created_at) throw new ControlError("invalid", "effect observation precedes wait creation");
    return writeWait(db, before, { ...before, disposition_state: `effect_${record.state}`, effect_observed_at: record.observed_at, updated_at: now,
      disposition_detail: { ...(before.disposition_detail ?? {}), effect: record } }, "wait.effect_observed");
  }).immediate() as ConditionWait;
}

function edgeFrom(row: Record<string, unknown>): WorkDependencyEdge {
  return { work_id: row.work_id as string, prerequisite_work_id: row.prerequisite_work_id as string, revision: row.revision as number,
    state: row.state as WorkDependencyEdge["state"], created_by: row.created_by as string, created_at: row.created_at as number };
}

export function getActiveDependencyEdge(db: Database, workId: string, prerequisiteWorkId: string): WorkDependencyEdge | null {
  ensureControlSchema(db);
  const row = db.query("SELECT * FROM control_work_dependencies WHERE work_id=? AND prerequisite_work_id=? AND state='active'").get(workId, prerequisiteWorkId) as Record<string, unknown> | null;
  return row ? edgeFrom(row) : null;
}

export function createWorkDependency(
  db: Database,
  input: { work_id: string; prerequisite_work_id: string; actor: string; now?: number },
): WorkDependencyEdge {
  ensureControlSchema(db);
  const fields = plainFields(input, ["work_id", "prerequisite_work_id", "actor", "now"], "dependency input");
  const workId = exactId(fields.work_id, "work_id");
  const prerequisiteWorkId = exactId(fields.prerequisite_work_id, "prerequisite_work_id");
  const actor = exactId(fields.actor, "actor");
  const now = fields.now === undefined ? Date.now() : safeInteger(fields.now, "now", 0);
  if (workId === prerequisiteWorkId) throw new ControlError("invalid", "work cannot depend on itself");
  return db.transaction(() => {
    const work = getWork(db, workId);
    if (!work) throw new ControlError("not_found", "work not found");
    if (!getWork(db, prerequisiteWorkId)) throw new ControlError("not_found", "prerequisite work not found");
    assertDecisionOwner(work, actor);
    const select = db.query("SELECT * FROM control_work_dependencies WHERE work_id=? AND prerequisite_work_id=?");
    const row = select.get(workId, prerequisiteWorkId) as Record<string, unknown> | null;
    if (!row) {
      db.query("INSERT INTO control_work_dependencies(work_id,prerequisite_work_id,revision,state,created_by,created_at,updated_at) VALUES (?,?,1,'active',?,?,?)")
        .run(workId, prerequisiteWorkId, actor, now, now);
    } else {
      const prior = edgeFrom(row);
      if (prior.state === "active") throw new ControlError("conflict", "dependency is already active");
      // Re-activation is a new active relation: new revision, so waits bound to an older revision stay unavailable.
      if (!db.query("UPDATE control_work_dependencies SET revision=?,state='active',created_by=?,created_at=?,updated_at=? WHERE work_id=? AND prerequisite_work_id=? AND revision=? AND state='revoked'")
        .run(prior.revision + 1, actor, now, now, workId, prerequisiteWorkId, prior.revision).changes) throw new ControlError("conflict", "stale dependency revision");
    }
    const edge = edgeFrom(select.get(workId, prerequisiteWorkId) as Record<string, unknown>);
    enqueueControlEvent(db, { entity_id: workDependencyEntityId(workId, prerequisiteWorkId), entity_version: edge.revision, kind: "work.dependency_created", work_id: workId, payload: { edge, actor } }, now);
    return edge;
  }).immediate() as WorkDependencyEdge;
}

export function revokeWorkDependency(
  db: Database,
  workId: string,
  prerequisiteWorkId: string,
  expectedRevision: number,
  input: { actor: string; reason: string; now?: number },
): WorkDependencyEdge {
  ensureControlSchema(db);
  exactId(workId, "work_id");
  exactId(prerequisiteWorkId, "prerequisite_work_id");
  safeInteger(expectedRevision, "expected revision", 1);
  const fields = plainFields(input, ["actor", "reason", "now"], "dependency revoke input");
  const actor = exactId(fields.actor, "actor");
  const reason = boundedText(fields.reason, "reason");
  const now = fields.now === undefined ? Date.now() : safeInteger(fields.now, "now", 0);
  return db.transaction(() => {
    const select = db.query("SELECT * FROM control_work_dependencies WHERE work_id=? AND prerequisite_work_id=?");
    const row = select.get(workId, prerequisiteWorkId) as Record<string, unknown> | null;
    if (!row) throw new ControlError("not_found", "dependency not found");
    assertDecisionOwner(getWork(db, workId)!, actor);
    const prior = edgeFrom(row);
    if (prior.state !== "active") throw new ControlError("conflict", "dependency is already revoked");
    if (prior.revision !== expectedRevision) throw new ControlError("conflict", "stale dependency revision");
    if (!db.query("UPDATE control_work_dependencies SET revision=?,state='revoked',updated_at=? WHERE work_id=? AND prerequisite_work_id=? AND revision=? AND state='active'")
      .run(prior.revision + 1, now, workId, prerequisiteWorkId, prior.revision).changes) throw new ControlError("conflict", "stale dependency revision");
    const edge = edgeFrom(select.get(workId, prerequisiteWorkId) as Record<string, unknown>);
    enqueueControlEvent(db, { entity_id: workDependencyEntityId(workId, prerequisiteWorkId), entity_version: edge.revision, kind: "work.dependency_revoked", work_id: workId, payload: { edge, actor, reason } }, now);
    return edge;
  }).immediate() as WorkDependencyEdge;
}

/**
 * The only control-owned `active -> completed` writer (§6.3, §12.1): owner-authorized, CAS on revision,
 * all human acceptance and remaining Attention/effect/wait responsibility closed, `work.completed` in the same transaction.
 */
export function completeWork(
  db: Database,
  workId: string,
  expectedRevision: number,
  input: { actor: string; evidence: Record<string, unknown>; now?: number },
): Work {
  ensureControlSchema(db);
  exactId(workId, "work_id");
  safeInteger(expectedRevision, "expected revision", 1);
  const fields = plainFields(input, ["actor", "evidence", "now"], "completion input");
  const actor = exactId(fields.actor, "actor");
  const now = fields.now === undefined ? Date.now() : safeInteger(fields.now, "now", 0);
  if (!fields.evidence || typeof fields.evidence !== "object" || Array.isArray(fields.evidence) || !Object.keys(fields.evidence).length) {
    throw new ControlError("invalid", "completion evidence must be a non-empty object");
  }
  let evidence: Record<string, unknown>;
  try { evidence = JSON.parse(canonicalJson(fields.evidence)); } catch { throw new ControlError("invalid", "completion evidence must be JSON"); }
  return db.transaction(() => {
    const work = getWork(db, workId);
    if (!work) throw new ControlError("not_found", "work not found");
    if (work.revision !== expectedRevision) throw new ControlError("conflict", "stale work revision");
    if (work.state !== "active") throw new ControlError("conflict", "work is not active");
    assertDecisionOwner(work, actor);
    const pendingHuman = work.contract!.acceptance.filter((criterion) => criterion.kind === "human" && !criterion.evidence?.trim()).map((criterion) => criterion.id);
    if (pendingHuman.length) throw new ControlError("blocked", `human acceptance is not closed: ${pendingHuman.join(",")}`);
    const open = db.query("SELECT item_id FROM control_attention WHERE work_id=? AND (state IN ('open','applying') OR effect_state IN ('applying','unknown')) ORDER BY item_id LIMIT 1")
      .get(workId) as { item_id: string } | null;
    if (open) throw new ControlError("blocked", `attention responsibility is still open: ${open.item_id}`);
    const wait = db.query(`SELECT wait_id FROM control_waits WHERE work_id=? AND ${UNSETTLED_WAIT} ORDER BY wait_id LIMIT 1`).get(workId) as { wait_id: string } | null;
    if (wait) throw new ControlError("blocked", `condition wait is unsettled: ${wait.wait_id}`);
    if (!db.query("UPDATE control_works SET revision=?,state='completed',updated_at=? WHERE work_id=? AND revision=? AND state='active'")
      .run(work.revision + 1, now, workId, expectedRevision).changes) throw new ControlError("conflict", "stale work revision");
    const completed: Work = { ...work, revision: work.revision + 1, state: "completed", updated_at: now };
    enqueueControlEvent(db, { entity_id: workId, entity_version: completed.revision, kind: "work.completed", work_id: workId, payload: { work: completed, actor, evidence } }, now);
    return completed;
  }).immediate() as Work;
}
