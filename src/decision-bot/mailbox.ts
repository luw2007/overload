import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureControlSchema, getAttention } from "../control/store";
import type { AttentionItem } from "../control/types";
import { controlPayloadHash } from "../control/outbox";

export const defaultMailboxPath = join(homedir(), ".overload", "orchestrator-answers.db");
export type ConsumerOwner = "extension" | "orchestrator";
export type ApprovalTarget = { consumerOwner:ConsumerOwner; approvalId:string; stableId?:string; requestUid?:string; targetVersion:string; question:string; options:string[]; effect:string; scope:Record<string,unknown>; evidence:Record<string,unknown>; evidenceHash:string; expiresAt:number; state:"active"|"consumed"|"closed"; workId?:string; contractRevision?:number; decisionMode?:"human_only"|"scoped_auto"; toolCallId?:string; attemptId?:string; };
export type Receipt = { receiptId:string; consumerOwner:ConsumerOwner; approvalId:string; targetVersion:string; answer:string; actor:string; attemptId:string|null; consumedAt:number; appliedAt:number|null; outcome:string|null };
export type EffectObservation={receiptId:string;toolCallId:string;attemptId?:string;state:"succeeded"|"failed"|"unknown";evidence:Record<string,unknown>;observedAt:number};

export function canonical(value:unknown):string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value as object).sort().map(k=>`${JSON.stringify(k)}:${canonical((value as any)[k])}`).join(",")}}`;
}
export function digest(value:unknown):string { return createHash("sha256").update(canonical(value)).digest("hex"); }
function columns(db:Database, table:string):Set<string>{return new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{name:string}>).map(x=>x.name));}
export function openMailbox(path?: string | null):Database {
  // fail-fast：显式 null/空串/字面量 "undefined" 拒绝；仅 undefined（无参）才内部解析默认。
  if (path === null || path === "" || path === "undefined" || path === "null") throw new Error("openMailbox: path is required");
  let resolved = path ?? process.env.OVERLOAD_ANSWERS_PATH ?? "";
  if (!resolved || resolved.trim() === "" || resolved === "undefined" || resolved === "null") resolved = defaultMailboxPath;
  if (!resolved.trim()) throw new Error("openMailbox: path is required");
  mkdirSync(dirname(resolved),{recursive:true,mode:0o700}); const db=new Database(resolved,{create:true}); db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
  db.exec(`CREATE TABLE IF NOT EXISTS answers(approval_id TEXT PRIMARY KEY, answer TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS approval_targets(consumer_owner TEXT NOT NULL, approval_id TEXT NOT NULL, stable_id TEXT, request_uid TEXT, target_version TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, effect TEXT NOT NULL, scope TEXT NOT NULL, evidence TEXT NOT NULL, evidence_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'active', consumed_at INTEGER, outcome TEXT, PRIMARY KEY(consumer_owner,approval_id));
CREATE TABLE IF NOT EXISTS answer_metadata(approval_id TEXT PRIMARY KEY, consumer_owner TEXT, provenance TEXT);
CREATE TABLE IF NOT EXISTS bot_identity(id INTEGER PRIMARY KEY CHECK(id=1), bot_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bot_control(id INTEGER PRIMARY KEY CHECK(id=1), disabled INTEGER NOT NULL DEFAULT 0, changed_at INTEGER NOT NULL, reason TEXT);
CREATE TABLE IF NOT EXISTS bot_attempts(attempt_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, consumer_owner TEXT NOT NULL, approval_id TEXT NOT NULL, target_version TEXT NOT NULL, owner_token TEXT NOT NULL, lease_expires_at INTEGER NOT NULL, policy_hash TEXT NOT NULL, evidence_hash TEXT NOT NULL, state TEXT NOT NULL, reason TEXT, started_at INTEGER NOT NULL, finished_at INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS bot_attempt_once ON bot_attempts(consumer_owner,approval_id,target_version);
CREATE TABLE IF NOT EXISTS bot_proposals(attempt_id TEXT PRIMARY KEY, consumer_owner TEXT NOT NULL, approval_id TEXT NOT NULL, target_version TEXT NOT NULL, action TEXT NOT NULL, answer TEXT, reason TEXT NOT NULL, evidence_refs TEXT NOT NULL, policy_hash TEXT NOT NULL, created_at INTEGER NOT NULL, invalidated_at INTEGER);
CREATE TABLE IF NOT EXISTS decision_receipts(receipt_id TEXT PRIMARY KEY, consumer_owner TEXT NOT NULL, approval_id TEXT NOT NULL, target_version TEXT NOT NULL, answer TEXT NOT NULL, actor TEXT NOT NULL, attempt_id TEXT, consumed_at INTEGER NOT NULL, applied_at INTEGER, outcome TEXT, UNIQUE(consumer_owner,approval_id,target_version));
CREATE TABLE IF NOT EXISTS receipt_effect_observations(receipt_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,attempt_id TEXT,state TEXT NOT NULL,evidence TEXT NOT NULL,observed_at INTEGER NOT NULL,PRIMARY KEY(receipt_id,tool_call_id),FOREIGN KEY(receipt_id) REFERENCES decision_receipts(receipt_id));
CREATE TABLE IF NOT EXISTS policy_candidates(candidate_id TEXT PRIMARY KEY,rule_json TEXT NOT NULL,scope_hash TEXT NOT NULL,sample_count INTEGER NOT NULL DEFAULT 0,approved_by TEXT,approved_at INTEGER,observation_until INTEGER,enabled_at INTEGER,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS policy_candidate_samples(candidate_id TEXT NOT NULL,receipt_id TEXT NOT NULL,evaluated_at INTEGER,matched INTEGER,PRIMARY KEY(candidate_id,receipt_id),FOREIGN KEY(candidate_id) REFERENCES policy_candidates(candidate_id),FOREIGN KEY(receipt_id) REFERENCES decision_receipts(receipt_id));
CREATE TABLE IF NOT EXISTS policy_rule_state(operation_id TEXT PRIMARY KEY,source TEXT NOT NULL,rule_id TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0,disabled_by TEXT,disabled_reason TEXT,disabled_at INTEGER,changed_by TEXT,changed_at INTEGER);
CREATE TABLE IF NOT EXISTS policy_rule_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT,operation_id TEXT NOT NULL,source TEXT NOT NULL,rule_id TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,reason TEXT,at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS effect_reconcile_cursor(id INTEGER PRIMARY KEY CHECK(id=1),ingest_seq INTEGER NOT NULL);`);
  for(const [name,definition] of [["work_id","TEXT"],["contract_revision","INTEGER"],["decision_mode","TEXT"],["tool_call_id","TEXT"],["attempt_id","TEXT"]] as const)if(!columns(db,"approval_targets").has(name))db.exec(`ALTER TABLE approval_targets ADD COLUMN ${name} ${definition}`);
  for(const [name,definition] of [["operation_id","TEXT"],["rule_id","TEXT"]] as const)if(!columns(db,"bot_proposals").has(name))db.exec(`ALTER TABLE bot_proposals ADD COLUMN ${name} ${definition}`);
  const c=columns(db,"answers");if(c.has("consumer_owner")){db.exec("INSERT OR IGNORE INTO answer_metadata(approval_id,consumer_owner,provenance) SELECT approval_id,consumer_owner,provenance FROM answers");}
  ensureControlSchema(db);
  chmodSync(resolved,0o600); return db;
}
export function registerTarget(db:Database,input:Omit<ApprovalTarget,"targetVersion"|"evidenceHash"|"state"> & {targetVersion?:string,evidenceHash?:string}):ApprovalTarget {
  const targetVersion=input.targetVersion ?? digest({owner:input.consumerOwner,id:input.approvalId,question:input.question,options:input.options,effect:input.effect,scope:input.scope,evidence:input.evidence,expiresAt:input.expiresAt});
  const evidenceHash=input.evidenceHash ?? digest(input.evidence);
  db.run(`INSERT INTO approval_targets(consumer_owner,approval_id,stable_id,request_uid,target_version,question,options,effect,scope,evidence,evidence_hash,expires_at,state,work_id,contract_revision,decision_mode,tool_call_id,attempt_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'active',?,?,?,?,?) ON CONFLICT(consumer_owner,approval_id) DO UPDATE SET stable_id=excluded.stable_id,request_uid=excluded.request_uid,target_version=excluded.target_version,question=excluded.question,options=excluded.options,effect=excluded.effect,scope=excluded.scope,evidence=excluded.evidence,evidence_hash=excluded.evidence_hash,expires_at=excluded.expires_at,work_id=excluded.work_id,contract_revision=excluded.contract_revision,decision_mode=excluded.decision_mode,tool_call_id=excluded.tool_call_id,attempt_id=excluded.attempt_id,state=CASE WHEN approval_targets.state='consumed' THEN approval_targets.state ELSE 'active' END`,[input.consumerOwner,input.approvalId,input.stableId??null,input.requestUid??null,targetVersion,input.question,JSON.stringify(input.options),input.effect,canonical(input.scope),canonical(input.evidence),evidenceHash,input.expiresAt,input.workId??null,input.contractRevision??null,input.decisionMode??"scoped_auto",input.toolCallId??null,input.attemptId??null]);
  return {...input,targetVersion,evidenceHash,state:"active"};
}
export function getTarget(db:Database,owner:ConsumerOwner,id:string):ApprovalTarget|null { const r=db.query("SELECT * FROM approval_targets WHERE consumer_owner=? AND approval_id=?").get(owner,id) as any; if(!r)return null; return {consumerOwner:r.consumer_owner,approvalId:r.approval_id,stableId:r.stable_id??undefined,requestUid:r.request_uid??undefined,targetVersion:r.target_version,question:r.question,options:JSON.parse(r.options),effect:r.effect,scope:JSON.parse(r.scope),evidence:JSON.parse(r.evidence),evidenceHash:r.evidence_hash,expiresAt:r.expires_at,state:r.state,workId:r.work_id??undefined,contractRevision:r.contract_revision??undefined,decisionMode:r.decision_mode??undefined,toolCallId:r.tool_call_id??undefined,attemptId:r.attempt_id??undefined}; }
export function cancelTarget(db: Database, owner: ConsumerOwner, id: string, version: string): boolean {
  return db.transaction(() => {
    const target = getTarget(db, owner, id);
    if (!target || target.targetVersion !== version) return false;
    if (target.state === "consumed") return false;
    db.query("UPDATE approval_targets SET state='closed',outcome='cancelled' WHERE consumer_owner=? AND approval_id=? AND target_version=? AND state='active'").run(owner, id, version);
    return true;
  })();
}
export function writeHumanAnswer(db:Database, owner:ConsumerOwner,id:string,answer:string,actor="ui",now=Date.now()):{ok:true}|{ok:false;reason:string}{
  return db.transaction(()=>{const target=getTarget(db,owner,id);if(!target||target.state!=="active")return {ok:false,reason:target?.state==="consumed"?"already_consumed":"unknown_target"} as const;if(now>=target.expiresAt){closeTarget(db,owner,id,"expired");return {ok:false,reason:"expired"} as const;}if(!target.options.includes(answer))return {ok:false,reason:"invalid_option"} as const;const prior=db.query("SELECT consumer_owner FROM answer_metadata WHERE approval_id=?").get(id) as any;if(prior&&prior.consumer_owner&&prior.consumer_owner!==owner)return {ok:false,reason:"owner_conflict"} as const;db.run("INSERT INTO answers(approval_id,answer,actor,at) VALUES(?,?,?,?) ON CONFLICT(approval_id) DO UPDATE SET answer=excluded.answer,actor=excluded.actor,at=excluded.at",[id,answer,actor,now]);db.run("INSERT INTO answer_metadata(approval_id,consumer_owner,provenance) VALUES(?,?,'human') ON CONFLICT(approval_id) DO UPDATE SET consumer_owner=excluded.consumer_owner,provenance='human'",[id,owner]);db.run("UPDATE bot_proposals SET invalidated_at=? WHERE consumer_owner=? AND approval_id=? AND invalidated_at IS NULL",[now,owner,id]);return {ok:true} as const;}).immediate();
}
export type ConsumeInput={consumerOwner:ConsumerOwner;approvalId:string;targetVersion:string;policyHash:string;now?:number;liveValid:()=>boolean;contractValid?:(target:ApprovalTarget)=>boolean;policyValid:(target:ApprovalTarget,proposal:{answer:string;policyHash:string}|null)=>boolean};
/** Why a consume attempt produced no receipt. `not_ready` is the only retryable reason: the answer is
 *  simply not consumable yet. Every other reason is terminal for this submission — the credential can
 *  never consume this target again, so an entry that sees one must refresh state instead of retrying. */
export type ConsumeRejection="unknown_target"|"already_consumed"|"target_closed"|"target_version_mismatch"|"expired"|"not_live"|"contract_invalid"|"not_ready";
export type ConsumeOutcome={ok:true;receipt:Receipt}|{ok:false;reason:ConsumeRejection};
export function consumeDecisionResult(db:Database,input:ConsumeInput):ConsumeOutcome { const now=input.now??Date.now(); const reject=(reason:ConsumeRejection):ConsumeOutcome=>({ok:false,reason}); return db.transaction(()=>{
  const target=getTarget(db,input.consumerOwner,input.approvalId);
  if(!target)return reject("unknown_target");
  if(target.state==="consumed")return reject("already_consumed");
  if(target.state!=="active")return reject("target_closed");
  if(target.targetVersion!==input.targetVersion)return reject("target_version_mismatch");
  if(now>=target.expiresAt)return reject("expired");
  if(!input.liveValid())return reject("not_live");
  if(input.contractValid?.(target)===false)return reject("contract_invalid");
  if(target.workId&&target.contractRevision!==undefined){const work=db.query("SELECT revision,contract FROM control_works WHERE work_id=?").get(target.workId) as any;if(!work||work.revision!==target.contractRevision)return reject("contract_invalid");const contract=JSON.parse(work.contract??"null");if(contract?.scope?.human_only_effects?.includes(target.effect))target.decisionMode="human_only";}
  const human=db.query("SELECT a.answer,a.actor FROM answers a LEFT JOIN answer_metadata m ON m.approval_id=a.approval_id WHERE a.approval_id=? AND (m.consumer_owner=? OR m.consumer_owner IS NULL) LIMIT 1").get(input.approvalId,input.consumerOwner) as any;
  const p=db.query("SELECT p.answer,p.policy_hash,p.attempt_id FROM bot_proposals p JOIN bot_attempts a ON a.attempt_id=p.attempt_id LEFT JOIN bot_control c ON c.id=1 WHERE p.consumer_owner=? AND p.approval_id=? AND p.target_version=? AND p.action='answer' AND p.invalidated_at IS NULL AND a.state='proposed' AND COALESCE(c.disabled,0)=0 AND NOT EXISTS (SELECT 1 FROM policy_rule_state s WHERE s.disabled=1 AND (s.operation_id=COALESCE(p.operation_id,p.rule_id) OR (s.source IN ('config','candidate') AND s.rule_id=p.rule_id))) ORDER BY p.created_at LIMIT 1").get(input.consumerOwner,input.approvalId,input.targetVersion) as any;
  const proposal=p?{answer:p.answer,policyHash:p.policy_hash}:null; const answer=human?.answer ?? proposal?.answer; const actor=human?.actor ?? (p?"decision-bot":null); if(!answer||!target.options.includes(answer)||(!human&&(target.decisionMode==="human_only"||!input.policyValid(target,proposal))))return reject("not_ready");
  const receiptId=randomUUID(); db.run("INSERT INTO decision_receipts(receipt_id,consumer_owner,approval_id,target_version,answer,actor,attempt_id,consumed_at) VALUES(?,?,?,?,?,?,?,?)",[receiptId,input.consumerOwner,input.approvalId,input.targetVersion,answer,actor,p?.attempt_id??null,now]); db.run("UPDATE approval_targets SET state='consumed',consumed_at=? WHERE consumer_owner=? AND approval_id=? AND state='active'",[now,input.consumerOwner,input.approvalId]); db.run("UPDATE bot_proposals SET invalidated_at=? WHERE consumer_owner=? AND approval_id=? AND invalidated_at IS NULL",[now,input.consumerOwner,input.approvalId]); if(human){db.run("DELETE FROM answers WHERE approval_id=?",input.approvalId);db.run("DELETE FROM answer_metadata WHERE approval_id=?",input.approvalId);} return {ok:true,receipt:{receiptId,consumerOwner:input.consumerOwner,approvalId:input.approvalId,targetVersion:input.targetVersion,answer,actor,attemptId:p?.attempt_id??null,consumedAt:now,appliedAt:null,outcome:null}};
  }).immediate(); }
/** Frozen contract §4.3 seam; signature unchanged. Callers that must tell a lost race from
 *  "not answered yet" use consumeDecisionResult instead. */
export function consumeDecision(db:Database,input:ConsumeInput):Receipt|null { const outcome=consumeDecisionResult(db,input); return outcome.ok?outcome.receipt:null; }

/** Terminal consume rejections: the submission can never be applied, so an entry that sees one
 *  refreshes state rather than retrying the answer (plan §4.5). `not_ready` is excluded — it is the
 *  only "come back later" case. */
export type ConsumeConflictCode=Exclude<ConsumeRejection,"not_ready"|"unknown_target"|"not_live">;
export const consumeConflictCodes:readonly ConsumeConflictCode[]=["already_consumed","target_closed","target_version_mismatch","expired","contract_invalid"];
export function isConsumeConflict(reason:ConsumeRejection):reason is ConsumeConflictCode { return (consumeConflictCodes as readonly string[]).includes(reason); }
const consumeConflictMessage:Record<ConsumeConflictCode,string>={
  already_consumed:"decision already consumed by another entry",
  target_closed:"decision target is closed",
  target_version_mismatch:"stale decision target version",
  expired:"decision target expired",
  contract_invalid:"work contract moved under this decision",
};
/** The mailbox/adapter conflict contract of plan §4.5. Deliberately *not* the Attention-CAS
 *  `stale_attention` body — a target-version conflict keeps its own code — but it carries the same
 *  kind of current state so the losing entry can show where the decision actually stands. */
export type ConsumeConflictBody={
  error:"conflict"; message:string; code:ConsumeConflictCode; retry:false;
  approval_id:string; consumer_owner:ConsumerOwner;
  expected_target_version:string; current_target_version:string|null;
  current_target_state:ApprovalTarget["state"]|null;
  current_state:AttentionItem["state"]|null;
  current_effect_state:AttentionItem["effect_state"]|null;
  current_revision:number|null; receipt_id:string|null;
  decision_package_url:string|null;
};
/** Builds the §4.5 conflict body from whatever current state exists: the mailbox target always, the
 *  consuming receipt and the Attention row when the approval is linked to one. */
export function consumeConflictBody(db:Database,owner:ConsumerOwner,approvalId:string,expectedTargetVersion:string,code:ConsumeConflictCode):ConsumeConflictBody {
  const target=getTarget(db,owner,approvalId);
  const consumed=receipt(db,owner,approvalId);
  let item:AttentionItem|null=null;
  // The mailbox and control share one database, but an approval need not have an Attention row.
  try { item=getAttention(db,approvalId); } catch { item=null; }
  return {
    error:"conflict", message:consumeConflictMessage[code], code, retry:false,
    approval_id:approvalId, consumer_owner:owner,
    expected_target_version:expectedTargetVersion,
    current_target_version:target?.targetVersion??null,
    current_target_state:target?.state??null,
    current_state:item?.state??null,
    current_effect_state:item?.effect_state??null,
    current_revision:item?.revision??null,
    receipt_id:consumed?.receiptId??null,
    decision_package_url:item?`/api/context/decision-package?item_id=${encodeURIComponent(item.item_id)}&work_id=${encodeURIComponent(item.work_id)}`:null,
  };
}
export function receipt(db:Database,owner:ConsumerOwner,id:string):Receipt|null { const r=db.query("SELECT * FROM decision_receipts WHERE consumer_owner=? AND approval_id=?").get(owner,id) as any; return r?{receiptId:r.receipt_id,consumerOwner:r.consumer_owner,approvalId:r.approval_id,targetVersion:r.target_version,answer:r.answer,actor:r.actor,attemptId:r.attempt_id,consumedAt:r.consumed_at,appliedAt:r.applied_at,outcome:r.outcome}:null; }
export function observeReceiptEffect(db: Database, observation: EffectObservation): boolean {
  return db.transaction(() => {
    type EffectReceiptRow = { receipt_id: string; attempt_id: string | null; tool_call_id: string | null; target_attempt: string | null; evidence: string };
    const receiptRow = db.query(`SELECT r.receipt_id,r.attempt_id,t.tool_call_id,t.attempt_id target_attempt,t.evidence
      FROM decision_receipts r JOIN approval_targets t
      ON t.consumer_owner=r.consumer_owner AND t.approval_id=r.approval_id
      WHERE r.receipt_id=? AND t.target_version=r.target_version`).get(observation.receiptId) as EffectReceiptRow | null;
    if (!receiptRow) return false;
    const expectedTool = receiptRow.tool_call_id ?? JSON.parse(receiptRow.evidence).toolCallId;
    // A receipt may report multiple effect steps; later steps must carry its attempt credential.
    if (expectedTool && expectedTool !== observation.toolCallId && !observation.toolCallId.startsWith(`${expectedTool}:`)) return false;
    const expectedAttempt = receiptRow.target_attempt ?? receiptRow.attempt_id;
    if (expectedAttempt && expectedAttempt !== observation.attemptId) return false;
    const evidence = canonical(observation.evidence);
    const prior = db.query("SELECT state,evidence FROM receipt_effect_observations WHERE receipt_id=? AND tool_call_id=?")
      .get(observation.receiptId, observation.toolCallId) as { state: string; evidence: string } | null;
    if (prior) {
      if (prior.state !== observation.state || prior.evidence !== evidence) throw new Error("conflicting_effect_observation");
      return true;
    }
    db.run("INSERT INTO receipt_effect_observations VALUES(?,?,?,?,?,?)", [
      observation.receiptId, observation.toolCallId, observation.attemptId ?? null,
      observation.state, evidence, observation.observedAt,
    ]);
    db.run("UPDATE decision_receipts SET applied_at=?,outcome=? WHERE receipt_id=?", [
      observation.observedAt, observation.state, observation.receiptId,
    ]);
    return true;
  })();
}
export function reconcileOutstandingReceipts(db:Database,deadline:number,now=Date.now()):number{return db.run("UPDATE decision_receipts SET applied_at=?,outcome='unknown' WHERE applied_at IS NULL AND consumed_at<=?",[now,deadline]).changes;}
/**
 * Folds ledger-applied `effect_observed` control events into receipts. A journal row is consumed only once the
 * reducer has passed it (ingest_seq <= reducer_cursor) and `applied_control_events` confirms the exact event_id and
 * payload_hash it carries, recomputed from the payload. Rows the reducer quarantined, or that disagree with the
 * applied identity, never touch receipts. The mailbox cursor never overtakes the reducer, so rows not yet reduced
 * are revisited on the next pass.
 */
export function reconcileEffectEvents(mailbox:Database,ledgerPath:string,now=Date.now()):void{
  const ledger=new Database(ledgerPath,{readonly:true});
  try{
    const cursor=(mailbox.query("SELECT ingest_seq FROM effect_reconcile_cursor WHERE id=1").get() as {ingest_seq:number}|null)?.ingest_seq??0;
    const tables=new Set((ledger.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{name:string}>).map(row=>row.name));
    const reduced=tables.has("reducer_cursor")&&tables.has("applied_control_events")
      ?(ledger.query("SELECT journal_seq FROM reducer_cursor WHERE id=1").get() as {journal_seq:number}|null)?.journal_seq??0
      :0;
    const rows=reduced>cursor
      ?ledger.query("SELECT ingest_seq,detail,at FROM journal_all WHERE kind='control_event' AND ingest_seq>? AND ingest_seq<=? ORDER BY ingest_seq").all(cursor,reduced) as Array<{ingest_seq:number;detail:string;at:number}>
      :[];
    const applied=rows.length?ledger.query("SELECT payload_hash FROM applied_control_events WHERE event_id=?"):null;
    mailbox.transaction(()=>{
      for(const row of rows){
        let envelope:any;
        try{envelope=JSON.parse(row.detail);}catch{continue;}
        if(envelope?.event_kind!=="effect_observed")continue;
        const d=envelope.payload;
        if(typeof envelope.event_id!=="string"||typeof envelope.payload_hash!=="string"||!d||typeof d!=="object"||Array.isArray(d))continue;
        const confirmed=applied!.get(envelope.event_id) as {payload_hash:string}|null;
        if(!confirmed||confirmed.payload_hash!==envelope.payload_hash||controlPayloadHash(d)!==envelope.payload_hash)continue;
        if(typeof d.receipt_id!=="string"||typeof d.toolCallId!=="string"||!["succeeded","failed","unknown"].includes(d.effect_state)||!d.evidence||typeof d.evidence!=="object")continue;
        try{
          observeReceiptEffect(mailbox,{receiptId:d.receipt_id,toolCallId:d.toolCallId,attemptId:typeof d.attempt_id==="string"?d.attempt_id:undefined,state:d.effect_state,evidence:d.evidence,observedAt:Number.isSafeInteger(row.at)?row.at:now});
        }catch(error){
          // A second applied event contradicting a recorded observation keeps the first; it must not wedge the cursor.
          if(!(error instanceof Error)||error.message!=="conflicting_effect_observation")throw error;
        }
      }
      const high=Math.max(cursor,reduced);
      mailbox.run("INSERT INTO effect_reconcile_cursor(id,ingest_seq) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET ingest_seq=excluded.ingest_seq",[high]);
      mailbox.run("UPDATE decision_receipts SET applied_at=?,outcome='unknown' WHERE applied_at IS NULL AND EXISTS(SELECT 1 FROM approval_targets t WHERE t.consumer_owner=decision_receipts.consumer_owner AND t.approval_id=decision_receipts.approval_id AND t.expires_at<=?)",[now,now]);
    })();
  }finally{ledger.close();}
}
export function markReceipt(db:Database,id:string,outcome:string,now=Date.now()):void{if(outcome==="applied")outcome="unknown";if(!["succeeded","failed","unknown"].includes(outcome))throw new Error("invalid receipt outcome");db.run("UPDATE decision_receipts SET applied_at=COALESCE(applied_at,?),outcome=? WHERE receipt_id=?",[now,outcome,id]);}
export function closeTarget(db:Database,owner:ConsumerOwner,id:string,outcome:string):void{db.run("UPDATE approval_targets SET state=CASE WHEN state='consumed' THEN state ELSE 'closed' END,outcome=? WHERE consumer_owner=? AND approval_id=?",[outcome,owner,id]);}
// 扫所有 owner（extension + orchestrator）已过期的 active target，幂等关闭为 expired。
// orchestrator tick 不常驻 web server，web 启动/定时清扫也靠它兜底 extension target。
export function expireActiveTargets(db:Database,now:number):number{return db.run("UPDATE approval_targets SET state='closed',outcome='expired' WHERE state='active' AND expires_at<=?",[now]).changes;}
export function setBotDisabled(db:Database,disabled:boolean,reason:string,now=Date.now()):void{db.transaction(()=>{db.run("INSERT INTO bot_control(id,disabled,changed_at,reason) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET disabled=excluded.disabled,changed_at=excluded.changed_at,reason=excluded.reason",[disabled?1:0,now,reason]);if(disabled)db.run("UPDATE bot_proposals SET invalidated_at=? WHERE invalidated_at IS NULL",now);})();}
export function botDisabled(db:Database):boolean{return !!(db.query("SELECT disabled FROM bot_control WHERE id=1").get() as any)?.disabled;}

/**
 * Frozen resume grant (Phase B §4.2 rule 5, §8.4): the exact runtime checkpoint, Attention revision, post-condition
 * and execution owner a decision owner approved. Stored as `scope.resume_grant` on a `resume_checkpoint` target;
 * `checkpointReference(scope)` is the wait authorization's `checkpoint_reference`.
 */
export type ResumeGrantScope = {
  stable_id: string; runtime: "pi" | "omp"; session: string; cwd: string; file: string; last_entry_id: string | null; byte_len: number;
  attention_revision: number; expires_at: number; item_id: string; execution_owner: string; condition: unknown;
};
export type CheckpointPin = Pick<ResumeGrantScope, "stable_id" | "runtime" | "session" | "cwd" | "file" | "last_entry_id" | "byte_len">;
export const RESUME_GRANT_EFFECT = "resume_checkpoint";
export const RESUME_GRANT_ANSWER = "approve";
/** Grant effect steps are `resume_checkpoint:<dispatch_id>`, bound to the target by observeReceiptEffect's tool-call prefix rule. */
export const RESUME_GRANT_TOOL = "resume_checkpoint";

/** Content identity of a pinned checkpoint: any append, rewrite, move or re-home yields a different reference. */
export function checkpointReference(pin: CheckpointPin): string {
  const { stable_id, runtime, session, cwd, file, last_entry_id, byte_len } = pin;
  return `checkpoint:${digest({ stable_id, runtime, session, cwd, file, last_entry_id, byte_len })}`;
}

/** Strictly parsed `scope.resume_grant`; null when the target does not pin a complete grant. */
export function resumeGrantScope(target: ApprovalTarget): ResumeGrantScope | null {
  const scope = (target.scope as { resume_grant?: unknown } | null)?.resume_grant;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  const fields = scope as Record<string, unknown>;
  const text = (key: string) => typeof fields[key] === "string" && fields[key] !== "";
  const integer = (key: string) => Number.isSafeInteger(fields[key]) && (fields[key] as number) >= 0;
  if (!["stable_id", "session", "cwd", "file", "item_id", "execution_owner"].every(text)) return null;
  if (fields.runtime !== "pi" && fields.runtime !== "omp") return null;
  if (fields.last_entry_id !== null && !text("last_entry_id")) return null;
  if (!["byte_len", "attention_revision", "expires_at"].every(integer) || fields.condition === undefined) return null;
  return fields as ResumeGrantScope;
}

/** The human answer pending on a target — the same row `consumeDecision` would consume; bot proposals never count. */
export function grantApproval(db: Database, owner: ConsumerOwner, id: string): { answer: string; actor: string } | null {
  return db.query(`SELECT a.answer,a.actor FROM answers a LEFT JOIN answer_metadata m ON m.approval_id=a.approval_id
    WHERE a.approval_id=? AND (m.consumer_owner=? OR m.consumer_owner IS NULL) LIMIT 1`).get(id, owner) as { answer: string; actor: string } | null;
}

/**
 * Registers a resume grant and records the decision owner's approval in one immediate transaction. The approval
 * stays pending until the single authorized dispatch consumes it through `consumeDecision`. A slot already bound to
 * another effect, or already consumed, is never repurposed.
 */
export function registerResumeGrant(db: Database, input: {
  consumerOwner: ConsumerOwner; approvalId: string; workId: string; contractRevision: number; attemptId: string;
  question: string; scope: ResumeGrantScope; actor: string; now: number;
}): ApprovalTarget {
  return db.transaction(() => {
    const prior = getTarget(db, input.consumerOwner, input.approvalId);
    if (prior && (prior.effect !== RESUME_GRANT_EFFECT || prior.state === "consumed")) {
      throw new Error(`approval ${input.approvalId} is not an open resume grant slot`);
    }
    const target = registerTarget(db, {
      consumerOwner: input.consumerOwner, approvalId: input.approvalId, stableId: input.scope.stable_id, question: input.question,
      options: [RESUME_GRANT_ANSWER], effect: RESUME_GRANT_EFFECT, scope: { resume_grant: input.scope },
      evidence: { checkpoint_reference: checkpointReference(input.scope) }, expiresAt: input.scope.expires_at,
      workId: input.workId, contractRevision: input.contractRevision, toolCallId: RESUME_GRANT_TOOL, attemptId: input.attemptId,
    });
    const answered = writeHumanAnswer(db, input.consumerOwner, input.approvalId, RESUME_GRANT_ANSWER, input.actor, input.now);
    if (!answered.ok) throw new Error(`resume grant approval not recorded: ${answered.reason}`);
    return target;
  }).immediate();
}
