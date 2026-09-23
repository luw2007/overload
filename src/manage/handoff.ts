import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { ControlError } from "../control/store";
import { buildSharePackage } from "./classify";
import { all, one } from "./store";
import { canonicalWorkId, workScope } from "./relations";

export type Precondition={ok:boolean;cause?:"source_running"|"blocked_on_ask"|"liveness_unknown"|"coverage_gap"|"inflight_handoff"|"contention";allowed:("same_workspace"|"isolate_with_confirmation")[];evidence:Record<string,unknown>};
export type HandoffPacket=Record<string,unknown>;

function blocked(ledger:Database|null,e:any,now:number):Precondition|null{
  let c:any=null;try{c=ledger?.query("SELECT state,last_event_at,last_heartbeat_at FROM current WHERE stable_id=?").get(e.stable_id);}catch{}
  let ask:any=null;try{ask=ledger?.query("SELECT 1 yes FROM requests WHERE stable_id=? AND state='pending' LIMIT 1").get(e.stable_id);}catch{}
  if(ask||c?.state==="awaiting"||c?.state==="blocked")return {ok:false,cause:"blocked_on_ask",allowed:[],evidence:{execution_id:e.execution_id,state:c?.state,pending_ask:!!ask}};
  if(["running","active","working"].includes(c?.state))return {ok:false,cause:"source_running",allowed:[],evidence:{execution_id:e.execution_id,state:c.state}};
  if(["file_only","ledger_stale","gapped"].includes(e.source_coverage))return {ok:false,cause:"liveness_unknown",allowed:["isolate_with_confirmation"],evidence:{execution_id:e.execution_id,cause:e.source_coverage==="gapped"?"telemetry_gap":e.source_coverage,coverage:e.source_coverage}};
  if(!["ended_ok","ended_failed"].includes(e.exec_state)){
    if(!c&&e.exec_state==="running")return {ok:false,cause:"source_running",allowed:[],evidence:{execution_id:e.execution_id,state:e.exec_state}};
    const last=Math.max(c?.last_event_at??0,c?.last_heartbeat_at??0,e.last_observed_at??0);if(!c||now-last>120_000)return {ok:false,cause:"liveness_unknown",allowed:["isolate_with_confirmation"],evidence:{execution_id:e.execution_id,cause:"stale",last_observed_at:last}};
  }
  return null;
}

function contention(db:Database,workId:string){
  const rows=all<any>(db,`SELECT a.display_path path,v.version_id,v.producer,l.subject execution_id,l.relation,l.confidence
    FROM mgmt_artifacts a JOIN mgmt_artifact_versions v USING(artifact_id)
    LEFT JOIN mgmt_links l ON l.object=v.version_id AND l.superseded_at IS NULL
    WHERE a.work_id=? AND (v.producer='multiple' OR (l.confidence='uncertain' AND l.relation IN ('modified','created')))`,workId);
  if(!rows.length)return null;
  return {paths:[...new Set(rows.map(r=>r.path).filter(Boolean))],executions:[...new Set(rows.flatMap(r=>r.execution_id?[r.execution_id]:r.producer==="multiple"?["multiple"]:[]))],links:rows.map(r=>({version_id:r.version_id,relation:r.relation,confidence:r.confidence,producer:r.producer}))};
}

export function checkHandoffPreconditions(db:Database,ledger:Database|null,workId:string,opts:{now?:number}={}):Precondition{
  const now=opts.now??Date.now();const execution=one<any>(db,"SELECT work_id FROM mgmt_executions WHERE execution_id=?",workId);if(execution)workId=execution.work_id;workId=canonicalWorkId(db,workId);const scope=workScope(db,workId),marks=scope.map(()=>"?").join(","),profile=one<any>(db,"SELECT work_id,track_state FROM mgmt_work_profile WHERE work_id=?",workId);
  if(profile.track_state!=="tracking")return {ok:false,cause:"liveness_unknown",allowed:[],evidence:{reason:"work_not_tracking",track_state:profile.track_state}};
  const inflight=one<any>(db,`SELECT handoff_id,state FROM mgmt_handoffs WHERE work_id IN (${marks}) AND state IN ('ready_to_launch','launching','launch_unknown','bound')`,...scope);if(inflight)return {ok:false,cause:"inflight_handoff",allowed:[],evidence:inflight};
  const executions=all<any>(db,`SELECT * FROM mgmt_executions WHERE work_id IN (${marks})`,...scope);if(!executions.length)return {ok:false,cause:"liveness_unknown",allowed:["isolate_with_confirmation"],evidence:{reason:"no_executions"}};
  for(const e of executions){const result=blocked(ledger,e,now);if(result)return result;}
  const contended=scope.map(id=>contention(db,id)).find(Boolean);if(contended)return {ok:false,cause:"contention",allowed:["isolate_with_confirmation"],evidence:contended};
  return {ok:true,allowed:["same_workspace"],evidence:{execution_ids:executions.map(x=>x.execution_id)}};
}

export function buildHandoffPacket(db:Database,workId:string,opts:{now?:number}={}):HandoffPacket{
  workId=canonicalWorkId(db,workId);const scope=workScope(db,workId),marks=scope.map(()=>"?").join(",");const profile=one<any>(db,"SELECT w.title,p.* FROM control_works w JOIN mgmt_work_profile p USING(work_id) WHERE work_id=?",workId);if(!profile)throw new ControlError("not_found","work not found");
  const inputs=all<any>(db,`SELECT input_id,kind,excerpt,ref_uri,at FROM mgmt_inputs WHERE work_id IN (${marks}) ORDER BY at,version`,...scope),versions=all<any>(db,`SELECT a.display_path path,v.content_sha256 sha256,v.snapshot_path,v.shareable,v.sensitivity FROM mgmt_artifacts a JOIN mgmt_artifact_versions v USING(artifact_id) WHERE a.work_id IN (${marks})`,...scope);
  const share=buildSharePackage(versions.map(v=>({path:v.path,sha256:v.sha256,snapshot_path:v.snapshot_path,shareable:v.shareable,sensitivity:v.sensitivity})) as any),source=one<any>(db,`SELECT execution_id,stable_id,agent,cwd,exec_state,source_coverage,last_observed_at FROM mgmt_executions WHERE work_id IN (${marks}) ORDER BY started_at DESC LIMIT 1`,...scope);
  return {schema_version:1,work_id:workId,title:profile.title,goal:inputs.find(x=>x.kind==="user_message")?.excerpt??profile.title,constraints:inputs.filter(x=>x.kind==="constraint").map(x=>x.excerpt),done:[],verified:[],undone:[],artifacts:share,inputs,source,created_at:opts.now??Date.now()};
}

type HandoffInput={target_agent:"pi"|"omp"|"claude";target_host:string;isolate:boolean;override_reason?:string;override_actor?:string;now?:number};
export function createHandoff(db:Database,ledgerOrInput:Database|null|any,workIdArg?:string,inputArg?:HandoffInput){
  const legacy=inputArg===undefined&&ledgerOrInput&&!(ledgerOrInput instanceof Database),old=legacy?ledgerOrInput:null,ledger:Database|null=legacy?old.ledger:ledgerOrInput;let workId=legacy?old.workId:workIdArg!;const input:any=legacy?{target_agent:old.targetAgent,target_host:old.targetHost??"local",isolate:old.isolate??false,override_reason:old.override_reason??old.overrideReason,override_actor:old.override_actor??old.overrideActor,now:old.now}:inputArg!;
  if(!input||!["pi","omp","claude"].includes(input.target_agent)||!input.target_host)throw new ControlError("invalid","invalid handoff target");
  workId=canonicalWorkId(db,workId);const pre=checkHandoffPreconditions(db,ledger,workId,{now:input.now});
  if(!pre.ok&&pre.allowed.length===0)throw conflict(pre);
  if(!pre.ok&&!input.isolate)throw conflict(pre);
  const owner=one<any>(db,"SELECT decision_owner FROM mgmt_work_profile WHERE work_id=?",workId)?.decision_owner;
  if(!pre.ok&&(!input.override_reason?.trim()||(!legacy&&!input.override_actor?.trim())))throw new ControlError("conflict","confirmation_required");
  const actor=input.override_actor??(legacy?owner:null);if(!pre.ok&&actor!==owner)throw new ControlError("conflict","confirmation_required");
  const now=input.now??Date.now(),source=one<any>(db,"SELECT execution_id,cwd,stable_id FROM mgmt_executions WHERE work_id=? ORDER BY started_at DESC LIMIT 1",workId)!;
  const gap=pre.ok?[]:[{kind:pre.cause==="contention"?"contention":"liveness_unknown",cause:(pre.evidence.cause as string)??pre.cause,paths:pre.evidence.paths??[],executions:pre.evidence.executions??(pre.evidence.execution_id?[pre.evidence.execution_id]:[])}];
  const handoff_id=randomUUID(),packet={...buildHandoffPacket(db,workId,{now}),handoff_id,target_agent:input.target_agent,target_host:input.target_host,isolate:!!input.isolate,workspace:{cwd:source.cwd,host:source.stable_id?.split(":")[0]??input.target_host},gaps:gap,risk:pre.ok?null:"原执行可能仍在原目录运行"};
  const text=JSON.stringify(packet),sha=createHash("sha256").update(text).digest("hex"),workspaceFp=JSON.stringify(packet.workspace);
  db.query(`INSERT INTO mgmt_handoffs(handoff_id,work_id,source_execution_id,target_agent,state,packet,packet_sha256,workspace_fp,isolate,override_reason,override_actor) VALUES(?,?,?,?,'ready_to_launch',?,?,?,?,?,?)`).run(handoff_id,workId,source.execution_id,input.target_agent,text,sha,workspaceFp,input.isolate?1:0,input.override_reason??null,actor??null);
  return {handoff_id,packet,gaps:gap,precondition:pre,state:"ready_to_launch"};
}
function conflict(pre:Precondition){const e:any=new ControlError("conflict",pre.cause!);e.cause=pre.cause;e.allowed=pre.allowed;e.evidence=pre.evidence;return e;}
export function abandonHandoff(db:Database,handoffId:string,reason:string){if(!reason.trim())throw new ControlError("invalid","reason required");const r=db.query("UPDATE mgmt_handoffs SET state='abandoned',override_reason=? WHERE handoff_id=? AND state NOT IN ('ended','abandoned')").run(reason,handoffId);if(r.changes!==1)throw new ControlError("not_found","handoff not found or terminal");}
export { launchHandoff, prepareHandoffWorkspace, reconcileLaunches } from "./launch";
