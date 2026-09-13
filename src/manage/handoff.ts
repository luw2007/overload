import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { ControlError } from "../control/store";
import { buildSharePackage } from "./classify";
import { all, one } from "./store";
import type { SourceHost } from "./source";

export type Precondition={ok:boolean;cause?:"source_running"|"blocked_on_ask"|"liveness_unknown"|"coverage_gap"|"inflight_handoff"|"file_only";allowed:("same_workspace"|"isolate_with_confirmation")[];evidence:Record<string,unknown>};
export type HandoffPacket=Record<string,unknown>;
export type LaunchExecutor=(cmd:{argv:string[];cwd:string;env:Record<string,string>;host:SourceHost})=>Promise<{pid?:number;receipt:string}>;
function blocked(db:Database,ledger:Database|null,e:any,now:number):Precondition|null{
  if(e.source_coverage==="file_only")return {ok:false,cause:"file_only",allowed:["isolate_with_confirmation"],evidence:{execution_id:e.execution_id,coverage:e.source_coverage}};
  if(e.source_coverage==="gapped")return {ok:false,cause:"coverage_gap",allowed:["isolate_with_confirmation"],evidence:{execution_id:e.execution_id,coverage:e.source_coverage}};
  if(["ended_ok","ended_failed"].includes(e.exec_state))return null;
  let c:any=null;try{c=ledger?.query("SELECT state,last_event_at,last_heartbeat_at FROM current WHERE stable_id=?").get(e.stable_id);}catch{}
  let ask:any=null;try{ask=ledger?.query("SELECT 1 yes FROM requests WHERE stable_id=? AND state='pending' LIMIT 1").get(e.stable_id);}catch{}
  if(ask||c?.state==="awaiting"||c?.state==="blocked")return {ok:false,cause:"blocked_on_ask",allowed:[],evidence:{execution_id:e.execution_id,state:c?.state,pending_ask:!!ask}};
  if(["running","active"].includes(c?.state)||(!c&&e.exec_state==="running"))return {ok:false,cause:"source_running",allowed:[],evidence:{execution_id:e.execution_id,state:c?.state??e.exec_state}};
  if(["done","failed","vanished","completed","ended"].includes(c?.state))return null;
  const last=Math.max(c?.last_event_at??0,c?.last_heartbeat_at??0,e.last_observed_at??0);if(!c||now-last>120_000)return {ok:false,cause:"liveness_unknown",allowed:["isolate_with_confirmation"],evidence:{execution_id:e.execution_id,last_observed_at:last}};
  return null;
}
export function checkHandoffPreconditions(db:Database,ledger:Database|null,workId:string,opts:{now?:number}={}):Precondition{
  const now=opts.now??Date.now();let profile=one<any>(db,"SELECT work_id FROM mgmt_work_profile WHERE work_id=?",workId);if(!profile){const execution=one<any>(db,"SELECT work_id FROM mgmt_executions WHERE execution_id=?",workId);if(execution){workId=execution.work_id;profile=execution;}}if(!profile)throw new ControlError("not_found","work not found");
  const inflight=one<any>(db,"SELECT handoff_id,state FROM mgmt_handoffs WHERE work_id=? AND state IN ('ready_to_launch','launching','launch_unknown','bound')",workId);if(inflight)return {ok:false,cause:"inflight_handoff",allowed:[],evidence:inflight};
  const executions=all<any>(db,"SELECT * FROM mgmt_executions WHERE work_id=?",workId);if(!executions.length)return {ok:false,cause:"liveness_unknown",allowed:["isolate_with_confirmation"],evidence:{reason:"no_executions"}};
  for(const e of executions){const result=blocked(db,ledger,e,now);if(result)return result;}
  return {ok:true,allowed:["same_workspace"],evidence:{execution_ids:executions.map(x=>x.execution_id)}};
}
export function buildHandoffPacket(db:Database,workId:string,opts:{now?:number}={}):HandoffPacket{
  const profile=one<any>(db,"SELECT w.title,p.* FROM control_works w JOIN mgmt_work_profile p USING(work_id) WHERE work_id=?",workId);if(!profile)throw new ControlError("not_found","work not found");
  const inputs=all<any>(db,"SELECT kind,excerpt,ref_uri,at FROM mgmt_inputs WHERE work_id=? ORDER BY version",workId);const versions=all<any>(db,`SELECT a.display_path path,v.content_sha256 sha256,v.snapshot_path,v.shareable,v.sensitivity FROM mgmt_artifacts a JOIN mgmt_artifact_versions v USING(artifact_id) WHERE a.work_id=?`,workId);
  const share=buildSharePackage(versions.map(v=>({path:v.path,sha256:v.sha256,snapshot_path:v.snapshot_path,shareable:v.shareable,sensitivity:v.sensitivity})) as any);
  return {schema_version:1,work_id:workId,title:profile.title,goal:inputs.find(x=>x.kind==="user_message")?.excerpt??profile.title,constraints:inputs.filter(x=>x.kind==="constraint").map(x=>x.excerpt),done:[],verified:[],undone:[],artifacts:share,inputs,created_at:opts.now??Date.now()};
}
export function createHandoff(db:Database,ledgerOrInput:Database|null|any,workIdArg?:string,inputArg?:{target_agent:"pi"|"omp"|"claude";target_host:string;isolate:boolean;override_reason?:string;now?:number}){
  const legacy=inputArg===undefined&&ledgerOrInput&&!(ledgerOrInput instanceof Database);const old=legacy?ledgerOrInput:null;const ledger:Database|null=legacy?old.ledger:ledgerOrInput;const workId=legacy?old.workId:workIdArg!;const input:any=legacy?{target_agent:old.targetAgent,target_host:old.targetHost??"local",isolate:old.isolate??false,override_reason:old.override_reason??old.overrideReason,now:old.now}:inputArg!;
  const pre=checkHandoffPreconditions(db,ledger,workId,{now:input.now});if(!pre.ok&&pre.allowed.length===0){const e:any=new ControlError("conflict",pre.cause!);e.cause=pre.cause;e.allowed=pre.allowed;e.evidence=pre.evidence;throw e;}if(!pre.ok&&!input.isolate){const e:any=new ControlError("conflict",pre.cause!);e.cause=pre.cause;e.allowed=pre.allowed;e.evidence=pre.evidence;throw e;}if(!pre.ok&&!input.override_reason)throw new ControlError("conflict","confirmation_required");
  const now=input.now??Date.now(),packet={...buildHandoffPacket(db,workId,{now}),target_agent:input.target_agent,target_host:input.target_host,gaps:pre.ok?[]:[pre.cause!]};const source=one<any>(db,"SELECT execution_id,cwd FROM mgmt_executions WHERE work_id=? ORDER BY started_at DESC LIMIT 1",workId)!;const handoff_id=randomUUID(),text=JSON.stringify(packet),sha=createHash("sha256").update(text).digest("hex");db.query(`INSERT INTO mgmt_handoffs(handoff_id,work_id,source_execution_id,target_agent,state,packet,packet_sha256,workspace_fp,isolate,override_reason,override_actor) VALUES(?,?,?,?,'ready_to_launch',?,?,?,?,?,'owner')`).run(handoff_id,workId,source.execution_id,input.target_agent,text,sha,JSON.stringify({cwd:source.cwd,host:input.target_host}),input.isolate?1:0,input.override_reason??null);return {handoff_id,packet,gaps:pre.ok?[]:[pre.cause!],state:"ready_to_launch"};
}
export function abandonHandoff(db:Database,handoffId:string,reason:string){if(!reason.trim())throw new ControlError("invalid","reason required");const r=db.query("UPDATE mgmt_handoffs SET state='abandoned',override_reason=? WHERE handoff_id=? AND state NOT IN ('ended','abandoned')").run(reason,handoffId);if(r.changes!==1)throw new ControlError("not_found","handoff not found or terminal");}
export { launchHandoff, reconcileLaunches } from "./launch";
