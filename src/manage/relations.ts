import type { Database } from "bun:sqlite";
import { ControlError } from "../control/store";
import { ensureMgmtSchema } from "./schema";
import { all, id, one } from "./store";

type AliasOptions = { actor: string; reason: string; now?: number };
type CorrectionOptions = {
 relation: string;
 object_id?: string;
 execution_id?: string;
 confidence?: "strong" | "weak" | "uncertain";
 actor: string;
 reason: string;
 now?: number;
};

const required = (value: string, name: string): string => {
 const normalized=value.trim();
 if(!normalized)throw new ControlError("invalid",`${name} required`);
 return normalized;
};
const profile = (db:Database,workId:string) => one<{work_id:string;track_state:string;archive_reason:string|null}>(db,"SELECT work_id,track_state,archive_reason FROM mgmt_work_profile WHERE work_id=?",workId);

export function canonicalWorkId(db:Database,workId:string):string{
 ensureMgmtSchema(db); required(workId,"work_id");
 if(!profile(db,workId))throw new ControlError("not_found","managed work not found");
 const alias=one<{canonical_work_id:string}>(db,"SELECT canonical_work_id FROM mgmt_work_alias WHERE alias_work_id=?",workId);
 if(!alias)return workId;
 if(one(db,"SELECT 1 FROM mgmt_work_alias WHERE alias_work_id=?",alias.canonical_work_id))throw new ControlError("conflict","alias chain detected");
 return alias.canonical_work_id;
}

export function workScope(db:Database,workId:string):string[]{
 const canonical=canonicalWorkId(db,workId);
 return [canonical,...all<{alias_work_id:string}>(db,"SELECT alias_work_id FROM mgmt_work_alias WHERE canonical_work_id=? ORDER BY alias_work_id",canonical).map(row=>row.alias_work_id)];
}

export function aliasWork(db:Database,aliasId:string,canonicalId:string,options:AliasOptions):object{
 ensureMgmtSchema(db);
 aliasId=required(aliasId,"alias_work_id"); canonicalId=required(canonicalId,"canonical_work_id");
 const actor=required(options.actor,"actor"),reason=required(options.reason,"reason"),now=options.now??Date.now();
 if(aliasId===canonicalId)throw new ControlError("invalid","work cannot alias itself");
 return db.transaction(()=>{
  const aliasProfile=profile(db,aliasId),canonicalProfile=profile(db,canonicalId);
  if(!aliasProfile||!canonicalProfile)throw new ControlError("not_found","managed work not found");
  if(one(db,"SELECT 1 FROM mgmt_work_alias WHERE alias_work_id=?",aliasId))throw new ControlError("conflict","alias mapping is immutable");
  if(one(db,"SELECT 1 FROM mgmt_work_alias WHERE alias_work_id=?",canonicalId))throw new ControlError("conflict","canonical work is already an alias");
  if(one(db,"SELECT 1 FROM mgmt_work_alias WHERE canonical_work_id=?",aliasId))throw new ControlError("conflict","alias work already owns aliases");
  const inflight=one<{handoff_id:string;state:string}>(db,"SELECT handoff_id,state FROM mgmt_handoffs WHERE work_id IN (?,?) AND state IN ('ready_to_launch','launching','launch_unknown','bound') ORDER BY handoff_id LIMIT 1",aliasId,canonicalId);
  if(inflight)throw new ControlError("conflict",`inflight_handoff:${inflight.handoff_id}:${inflight.state}`);
  db.query("INSERT INTO mgmt_work_alias(alias_work_id,canonical_work_id,reason,actor,created_at) VALUES(?,?,?,?,?)").run(aliasId,canonicalId,reason,actor,now);
  db.query("UPDATE mgmt_work_profile SET track_state='archived',archived_at=?,archive_reason='aliased',updated_at=? WHERE work_id=?").run(now,now,aliasId);
  db.query("INSERT INTO mgmt_discovery_log(at,reason,detail) VALUES(?,'work_aliased',?)").run(now,JSON.stringify({alias:aliasId,canonical:canonicalId,actor}));
  db.query("UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason='work_scope_changed' WHERE work_id=? AND verdict='accepted' AND invalidated_at IS NULL").run(now,canonicalId);
  db.query("UPDATE control_attention SET state='superseded',revision=revision+1,updated_at=? WHERE work_id=? AND item_id LIKE 'mgmt:accept:%' AND state='open'").run(now,canonicalId);
  return {alias_work_id:aliasId,canonical_work_id:canonicalId,archived:true};
 }).immediate();
}

function objectOwner(db:Database,objectId:string):string|null{
 return one<{work_id:string}>(db,`SELECT a.work_id FROM mgmt_artifacts a WHERE a.artifact_id=? UNION SELECT a.work_id FROM mgmt_artifact_versions v JOIN mgmt_artifacts a ON a.artifact_id=v.artifact_id WHERE v.version_id=?`,objectId,objectId)?.work_id??null;
}

export function correctLink(db:Database,linkId:string,options:CorrectionOptions):object{
 ensureMgmtSchema(db); linkId=required(linkId,"link_id");
 const relation=required(options.relation,"relation"),actor=required(options.actor,"actor"),reason=required(options.reason,"reason"),now=options.now??Date.now();
 const relations=["created","modified","read","attempted_modify","present_in_workspace","committed","submitted_external","pushed"];
 if(!relations.includes(relation))throw new ControlError("invalid","invalid relation");
 const confidence=options.confidence??(relation==="present_in_workspace"?"uncertain":"strong");
 if(!["strong","weak","uncertain"].includes(confidence))throw new ControlError("invalid","invalid confidence");
 if(relation==="present_in_workspace"&&confidence!=="uncertain")throw new ControlError("invalid","present_in_workspace must be uncertain");
 return db.transaction(()=>{
  const old=one<{link_id:string;work_id:string;subject:string;relation:string;object:string;confidence:"strong"|"weak"|"uncertain";evidence_ref:string;superseded_at:number|null}>(db,"SELECT link_id,work_id,subject,relation,object,confidence,evidence_ref,superseded_at FROM mgmt_links WHERE link_id=?",linkId);
  if(!old)throw new ControlError("not_found","link not found");
  if(old.superseded_at!==null)throw new ControlError("conflict","link already superseded");
  if(one(db,"SELECT 1 FROM mgmt_corrections WHERE evidence_ref=?",old.evidence_ref))throw new ControlError("conflict","evidence already corrected");
  const canonical=canonicalWorkId(db,old.work_id),scope=workScope(db,canonical);
  if(relation==="present_in_workspace"&&options.execution_id!==undefined)throw new ControlError("invalid","present_in_workspace cannot have execution_id");
  const subject=relation==="present_in_workspace"?canonical:options.execution_id??old.subject,object=options.object_id??old.object;
  const executionOwner=relation==="present_in_workspace"?canonical:one<{work_id:string}>(db,"SELECT work_id FROM mgmt_executions WHERE execution_id=?",subject)?.work_id??null;
  if(!executionOwner)throw new ControlError("invalid","execution not found");
  if(!scope.includes(executionOwner))throw new ControlError("invalid","execution does not belong to work scope");
  const owner=objectOwner(db,object);
  if(!owner)throw new ControlError("invalid","artifact or version not found");
  if(!scope.includes(owner))throw new ControlError("invalid","object does not belong to work scope");
  if(subject===old.subject&&relation===old.relation&&object===old.object&&confidence===old.confidence)throw new ControlError("invalid","correction does not change link");
  const evidenceRef=`user:${actor}@${now}`,newId=id("link-correction",linkId,subject,relation,object,confidence,actor,now);
  db.query("INSERT INTO mgmt_links(link_id,work_id,subject,relation,object,confidence,evidence_ref,observed_at,supersedes,actor,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(newId,canonical,subject,relation,object,confidence,evidenceRef,now,linkId,actor,reason);
  if(db.query("UPDATE mgmt_links SET superseded_at=? WHERE link_id=? AND superseded_at IS NULL").run(now,linkId).changes!==1)throw new ControlError("conflict","link already superseded");
  db.query("INSERT INTO mgmt_corrections(evidence_ref,decided_at,actor,reason) VALUES(?,?,?,?)").run(old.evidence_ref,now,actor,reason);
  return {link_id:newId,supersedes:linkId,work_id:canonical,subject,relation,object,confidence,evidence_ref:evidenceRef};
 }).immediate();
}

function executionRepo(raw:string|null,cwd:string|null):string|null{
 if(raw)try{const evidence=JSON.parse(raw);if(evidence&&typeof evidence.repo_root==="string"&&evidence.repo_root)return evidence.repo_root;}catch{}
 return cwd;
}
const executionHost=(stableId:string,raw:string|null):string=>{
 if(raw)try{const evidence=JSON.parse(raw);if(evidence&&typeof evidence.host==="string"&&evidence.host)return evidence.host;}catch{}
 return stableId.split(":",1)[0]??"";
};

export function refreshWorkHints(db:Database,workId:string,now:number):void{
 ensureMgmtSchema(db); const canonical=canonicalWorkId(db,workId),scope=workScope(db,canonical);
 const latest=one<{stable_id:string;ledger_evidence:string|null;cwd:string|null}>(db,`SELECT stable_id,ledger_evidence,cwd FROM mgmt_executions WHERE work_id IN (${scope.map(()=>"?").join(",")}) ORDER BY last_observed_at DESC,started_at DESC,execution_id DESC LIMIT 1`,...scope);
 const repo=latest?executionRepo(latest.ledger_evidence,latest.cwd):null,host=latest?executionHost(latest.stable_id,latest.ledger_evidence):null;
 db.transaction(()=>{
  db.query("DELETE FROM mgmt_work_hints WHERE work_id=? AND reason='same_repo'").run(canonical);
  if(!repo)return;
  const candidates=all<{work_id:string;stable_id:string;ledger_evidence:string|null;cwd:string|null}>(db,`SELECT p.work_id,e.stable_id,e.ledger_evidence,e.cwd FROM mgmt_work_profile p JOIN mgmt_executions e ON e.execution_id=(SELECT e2.execution_id FROM mgmt_executions e2 WHERE e2.work_id=p.work_id ORDER BY e2.last_observed_at DESC,e2.started_at DESC,e2.execution_id DESC LIMIT 1) WHERE p.track_state<>'archived' AND p.work_id<>? AND NOT EXISTS(SELECT 1 FROM mgmt_work_alias a WHERE a.alias_work_id=p.work_id) ORDER BY p.work_id`,canonical);
  for(const candidate of candidates)if(executionHost(candidate.stable_id,candidate.ledger_evidence)===host&&executionRepo(candidate.ledger_evidence,candidate.cwd)===repo)db.query("INSERT INTO mgmt_work_hints(work_id,other_work_id,reason,score,created_at) VALUES(?,?,'same_repo',0.5,?) ON CONFLICT(work_id,other_work_id,reason) DO UPDATE SET score=excluded.score,created_at=excluded.created_at").run(canonical,candidate.work_id,now);
 }).immediate();
}
