import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { canonicalJson, enqueueControlEvent, ensureOutbox } from "./outbox";
import { ensureMgmtSchema } from "../manage/schema";
import { ensureRootProblem, rootProblemId } from "./context-pool";
import { ensureContextReducerSchema } from "./context-reducer";
import type { EffectObservation } from "../decision-bot/mailbox";
import type {
  AffectedAttentionCard, AttentionAuditLink, AttentionCardSnapshot, AttentionDecisionInput,
  AttentionFollowUp, AttentionItem, AttentionMaterialProjection, AttentionZone, Contract,
  ContractRevisionPreview, MaterialFingerprintInputs, StaleAttentionBody, Work,
} from "./types";

export {
  type AffectedAttentionCard, type AttentionAuditLink, type AttentionCardSnapshot,
  type AttentionDecisionInput, type AttentionFollowUp, type AttentionItem,
  type AttentionMaterialProjection, type AttentionZone, type Contract,
  type ContractRevisionPreview, type MaterialFingerprintInputs, type StaleAttentionBody,
  type Work,
} from "./types";
export { ensureOutbox, enqueueControlEvent, publishControlEvents } from "./outbox";
export { applyControlEvent } from "./projection";

export class ControlError extends Error {
  constructor(
    public readonly code: "not_found" | "conflict" | "invalid" | "blocked",
    message: string,
    public readonly details?: StaleAttentionBody,
  ) { super(message); this.name = "ControlError"; }
}

export const CONTROL_SCHEMA_VERSION = 6;
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
  {to:4,destructive:false,apply(db){ensureContextReducerSchema(db);db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(4,Date.now());}},
  // v5 回填：collector 无状态、redirectWork 可复活任意状态 work、orchestrator 无条件注入 rootProblemId，
  // 因此全部 work（含 candidate/stopped/completed）都必须有根 problem。这里直接执行迁移内部 SQL，
  // 不能调用公开的 ensureRootProblem：公开 helper 会再次 ensureControlSchema，并把同一连接先推进到 v6。
  {to:5,destructive:false,apply(db){
    const rows=db.query("SELECT work_id FROM control_works").all() as {work_id:string}[];const now=Date.now();
    const existing=db.query("SELECT 1 FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL");
    const insert=db.query("INSERT INTO control_context_problems(problem_id,work_id,parent_problem_id,root_problem_id,title,state,revision,created_at,updated_at) VALUES (?,?,NULL,?,?,'open',1,?,?)");
    for(const row of rows){if(existing.get(row.work_id))continue;const rootId=rootProblemId(row.work_id);insert.run(rootId,row.work_id,rootId,"root",now,now);}
    db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(5,Date.now());}},
  {to:6,destructive:false,apply(db){db.exec(CONTROL_V6_SCHEMA);db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(6,Date.now());}},
];
export function ensureControlSchema(db: Database): void {
  const version=controlSchemaVersion(db);
  if(version>CONTROL_SCHEMA_VERSION)throw new ControlError("blocked",`control schema version ${version} is newer than supported ${CONTROL_SCHEMA_VERSION}`);
  if(version===CONTROL_SCHEMA_VERSION)return;
  for(const migration of CONTROL_MIGRATIONS.filter(entry=>entry.to>version)){
    if(migration.destructive)backupForDestructiveMigration(db,migration.to-1,migration.to);
    const tx=db.transaction(()=>{const current=controlSchemaVersion(db);if(current!==migration.to-1)throw new ControlError("conflict",`control schema changed during migration: ${current}`);migration.apply(db);});tx.immediate();
  }
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
    db.query("INSERT INTO control_attention_events(item_id,revision,kind,detail,created_at) VALUES (?,?,?,?,?)").run(item.item_id,item.revision,"upsert",JSON.stringify(item.evidence),now);emitAttention(db,item,row?"attention.updated":"attention.created");return item;});return tx.immediate() as AttentionItem;
}
export function getAttention(db:Database,itemId:string):AttentionItem|null {ensureControlSchema(db);const row=db.query("SELECT * FROM control_attention WHERE item_id=?").get(itemId) as Record<string,unknown>|null;return row?attentionFrom(row):null;}
export function listAttention(db:Database,zone?:AttentionZone,now=Date.now()):AttentionItem[]{ensureControlSchema(db);const rows=(db.query("SELECT * FROM control_attention ORDER BY updated_at DESC,item_id").all() as Record<string,unknown>[]).map(attentionFrom);return rows.filter(item=>{if(!zone)return true;if(zone==="done")return item.state==="resolved"||item.state==="superseded";if(item.state!=="open"||item.defer_until!==null&&item.defer_until>now)return false;return zone==="now"?item.urgency==="now"||item.expires_at!==null&&item.expires_at<=now:item.urgency==="inbox"&&!(item.expires_at!==null&&item.expires_at<=now);});}

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

export function projectAttentionMaterial(db: Database, itemId: string, input: MaterialFingerprintInputs, now = Date.now()): AttentionMaterialProjection {
  ensureControlSchema(db);
  const computed = computeMaterialFingerprint(input);
  return db.transaction(() => {
    const item = getAttention(db, itemId);
    if (!item) throw new ControlError("not_found", "attention item not found");
    const existing = getAttentionMaterial(db, itemId);
    const subject = `attention:${itemId}`;
    const materialKey = `${subject}:${computed.fingerprint}`;
    let changed = false;
    if (!existing) {
      db.query("INSERT INTO control_attention_material(item_id,material_key,fingerprint,generation,inputs,computed_at) VALUES(?,?,?,?,?,?)")
        .run(itemId, materialKey, computed.fingerprint, 1, canonicalJson(computed.inputs), now);
      changed = true;
    } else if (existing.fingerprint === computed.fingerprint) {
      db.query("UPDATE control_attention_material SET computed_at=? WHERE item_id=?").run(now, itemId);
    } else {
      db.query("UPDATE control_attention_material SET material_key=?,fingerprint=?,generation=generation+1,inputs=?,computed_at=? WHERE item_id=?")
        .run(materialKey, computed.fingerprint, canonicalJson(computed.inputs), now, itemId);
      changed = true;
    }
    const projection = getAttentionMaterial(db, itemId)!;
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
  }).immediate() as AttentionMaterialProjection;
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
