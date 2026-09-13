import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ControlError, ensureControlSchema } from "../control/store";
import { ensureMgmtSchema } from "./schema";
import { localSourceFs, sshSourceFs, type SourceFs, type SourceHost } from "./source";
import { detectRuntimeFromPath, parseClaudeSession, parseOmpSession, parsePiSession, sessionDirs, type SessionRecord } from "./readers/types";
import { stableId } from "./identity";
import { all, bindExecution, createDiscoveredWork, one, updateCursor } from "./store";
import { collectExecution } from "./collect";
import { deriveCloseoutAndArchive } from "./archive";

export type ManageConfig={enabled:boolean;agents:("pi"|"omp"|"claude")[];hosts:SourceHost[];lookback_ms:number;follow_new:boolean;snapshot:{file_max_bytes:number;work_max_bytes:number;retain_ms:number};archive_grace_ms:number;snapshot_root:string};
export type ScanReport={hosts:{host:string;state:"ok"|"unavailable";error?:string}[];discovered:number;executions:number;versions:number;links:number;archived:number;skipped:number;inputs?:number;artifacts?:number};
export type WorkSummary=Record<string,unknown>;
export type WorkDetail=Record<string,unknown>;
const DAY=86_400_000;
export function loadManageConfig(overloadHome=join(homedir(),".overload")):ManageConfig{
  let raw:any={};try{raw=JSON.parse(readFileSync(join(overloadHome,"config.json"),"utf8")).manage??{};}catch{}
  let host="local";try{host=readFileSync(join(overloadHome,"host"),"utf8").trim()||"local";}catch{}
  return {enabled:raw.enabled??false,agents:raw.agents??["pi","omp","claude"],hosts:raw.hosts??[{host,kind:"local"}],lookback_ms:raw.lookback_ms??7*DAY,follow_new:raw.follow_new??true,snapshot:{file_max_bytes:raw.snapshot?.file_max_bytes??2*1024*1024,work_max_bytes:raw.snapshot?.work_max_bytes??64*1024*1024,retain_ms:raw.snapshot?.retain_ms??30*DAY},archive_grace_ms:raw.archive_grace_ms??30*60_000,snapshot_root:raw.snapshot_root??join(overloadHome,"artifacts/mgmt")};
}
function parser(runtime:string,text:string):SessionRecord|null{const lines=text.split(/\r?\n/);return runtime==="pi"?parsePiSession(lines):runtime==="omp"?parseOmpSession(lines):parseClaudeSession(lines);}
function generationKey(g:string){return g.includes(":")?g.slice(0,g.lastIndexOf(":")):g;}
function ledgerEvidence(ledger:Database|null,sid:string){try{return ledger?.query(`SELECT s.*,c.writer_id,c.state,c.last_event_at,c.last_heartbeat_at FROM sessions s LEFT JOIN current c ON c.stable_id=s.stable_id WHERE s.stable_id=?`).get(sid) as any;}catch{return null;}}
function strongWork(db:Database,ledger:Database|null,sid:string):string|null{
  const bound=one<any>(db,"SELECT work_id FROM mgmt_session_binding WHERE stable_id=?",sid);if(bound)return bound.work_id;
  const l=ledgerEvidence(ledger,sid);const refs=[l?.origin,l?.parent_stable_id].filter(Boolean) as string[];
  for(const ref of refs){
    const handoff=/^(?:mgmt:handoff:)(.+)$/.exec(ref);if(handoff){const h=one<any>(db,"SELECT work_id FROM mgmt_handoffs WHERE handoff_id=?",handoff[1]);if(h)return h.work_id;}
    const parent=one<any>(db,"SELECT work_id FROM mgmt_session_binding WHERE stable_id=?",ref);if(parent)return parent.work_id;
  }
  return null;
}
async function hostHome(fs:SourceFs,h:SourceHost){if(h.kind==="local")return homedir();const r=await fs.exec("/",["sh","-c","printf %s \"$HOME\""],5000);if(r.code!==0||!r.stdout.trim())throw new Error(r.stderr.trim()||"remote home unavailable");return r.stdout.trim();}
export async function scanOnce(db:Database,ledger:Database|null,cfg:ManageConfig,opts:{now?:number;fsFor?:(h:SourceHost)=>SourceFs}={}):Promise<ScanReport>{
  ensureControlSchema(db);ensureMgmtSchema(db);const now=opts.now??Date.now();const report:ScanReport={hosts:[],discovered:0,executions:0,versions:0,links:0,archived:0,skipped:0,inputs:0,artifacts:0};
  for(const h of cfg.hosts){const fs=opts.fsFor?.(h)??(h.kind==="local"?localSourceFs(h):sshSourceFs(h));try{
    const home=await hostHome(fs,h);const files=new Map<string,{path:string;mtimeMs:number;size:number;runtime:"pi"|"omp"|"claude"}>();
    for(const agent of cfg.agents)for(const dir of sessionDirs(agent,home))for(const f of await fs.listFiles(dir,{sinceMs:now-cfg.lookback_ms,suffix:".jsonl"}))files.set(f.path,{...f,runtime:detectRuntimeFromPath(f.path)??agent});
    for(const file of files.values()){
      const runtime=file.runtime;if(!cfg.agents.includes(runtime)){report.skipped++;continue;}
      const sourceKey=`${h.host}:${file.path}`;const old=one<any>(db,"SELECT cursor FROM mgmt_cursors WHERE source_key=?",sourceKey);let cursor:any={byte:0,generation:null,header:null,line:0};try{if(old)cursor={...cursor,...JSON.parse(old.cursor)};}catch{}
      let range=await fs.readRange(file.path,cursor.byte,cfg.snapshot.file_max_bytes);if(!range){report.skipped++;continue;}
      if(cursor.byte>0&&(range.nextByte<cursor.byte||generationKey(range.generation)!==generationKey(cursor.generation??range.generation))){cursor={byte:0,generation:null,header:null,line:0};range=await fs.readRange(file.path,0,cfg.snapshot.file_max_bytes);if(!range)continue;}
      if(range.bytes.length===0||range.nextByte<=cursor.byte){report.skipped++;continue;}
      const chunk=new TextDecoder().decode(range.bytes);const text=cursor.header?`${cursor.header}\n${chunk}`:chunk;const record=parser(runtime,text);if(!record){updateCursor(db,sourceKey,{...cursor,byte:range.nextByte,generation:range.generation},now,"parse_error");report.skipped++;continue;}
      const shift=cursor.header?(cursor.line||0)-1:0;for(const x of [...record.userMessages,...record.toolEvents])x.lineNo+=shift;record.lastLineNo+=shift;
      const sid=stableId(h.host,runtime,record.sessionUuid);let execution=one<any>(db,"SELECT execution_id,work_id FROM mgmt_executions WHERE stable_id=?",sid);let workId=execution?.work_id;
      if(!workId){workId=strongWork(db,ledger,sid);if(!workId){workId=createDiscoveredWork(db,sid,record.userMessages[0]?.text.slice(0,120)||`${runtime} ${record.sessionUuid}`,now);report.discovered++;}const l=ledgerEvidence(ledger,sid);const coverage=l?"ledger_full":"file_only";const eid=bindExecution(db,{workId,stableId:sid,writerId:l?.writer_id??record.sessionUuid,agent:runtime,cwd:record.cwd,coverage,state:l?.state==="done"||l?.state==="failed"?`ended_${l.state==="done"?"ok":"failed"}`:"running",startedAt:record.startedAt??file.mtimeMs,observedAt:now,evidence:l??{path:file.path},role:workId===strongWork(db,ledger,sid)?"child":"origin"});execution={execution_id:eid,work_id:workId};report.executions++;}
      const beforeV=(one<any>(db,"SELECT count(*) n FROM mgmt_artifact_versions",)?.n??0),beforeL=(one<any>(db,"SELECT count(*) n FROM mgmt_links",)?.n??0);
      const collected=await collectExecution(db,fs,workId,execution.execution_id,file.path,record,{fileMaxBytes:cfg.snapshot.file_max_bytes,workMaxBytes:cfg.snapshot.work_max_bytes,snapshotRoot:cfg.snapshot_root},now);report.inputs!+=collected.inputs;report.artifacts!+=collected.artifacts;
      report.versions+=(one<any>(db,"SELECT count(*) n FROM mgmt_artifact_versions")?.n??0)-beforeV;report.links+=(one<any>(db,"SELECT count(*) n FROM mgmt_links")?.n??0)-beforeL;
      const firstLine=text.split(/\r?\n/).find(Boolean)??cursor.header;updateCursor(db,sourceKey,{byte:range.nextByte,generation:range.generation,header:firstLine,line:record.lastLineNo},now,range.eof?"eof":"partial");
    }
    report.hosts.push({host:h.host,state:"ok"});
  }catch(error){report.hosts.push({host:h.host,state:"unavailable",error:error instanceof Error?error.message:String(error)});}}
  const close=deriveCloseoutAndArchive(db,ledger,{now,archiveGraceMs:cfg.archive_grace_ms});report.archived=close.archived;return report;
}
export function listWorks(db:Database,filter:{track?:"tracking"|"paused"|"archived"}={}){ensureMgmtSchema(db);const where=filter.track?"WHERE p.track_state=?":"";return all<any>(db,`SELECT w.work_id,w.title,w.state,p.track_state,p.origin_mode,p.decision_owner,p.input_head,p.updated_at,(SELECT count(*) FROM mgmt_executions e WHERE e.work_id=w.work_id) executions,(SELECT CASE WHEN count(DISTINCT e.source_coverage)=1 THEN min(e.source_coverage) ELSE 'gapped' END FROM mgmt_executions e WHERE e.work_id=w.work_id) coverage FROM control_works w JOIN mgmt_work_profile p ON p.work_id=w.work_id ${where} ORDER BY p.updated_at DESC`,...(filter.track?[filter.track]:[]));}
export function showWork(db:Database,workId:string):WorkDetail|null{ensureMgmtSchema(db);const profile=one<any>(db,"SELECT w.*,p.* FROM control_works w JOIN mgmt_work_profile p USING(work_id) WHERE w.work_id=?",workId);if(!profile)return null;return {...profile,executions:all(db,"SELECT * FROM mgmt_executions WHERE work_id=? ORDER BY started_at",workId),inputs:all(db,"SELECT * FROM mgmt_inputs WHERE work_id=? ORDER BY CASE WHEN input_id=? THEN 0 ELSE 1 END,version DESC",workId,profile.input_head),artifacts:all(db,`SELECT a.*,v.version_id,v.content_sha256,v.snapshot_state,v.sensitivity,v.shareable,v.observed_at FROM mgmt_artifacts a LEFT JOIN mgmt_artifact_versions v ON v.artifact_id=a.artifact_id WHERE a.work_id=? ORDER BY a.display_path,v.observed_at DESC`,workId),links:all(db,"SELECT l.* FROM mgmt_links l JOIN mgmt_artifacts a ON a.artifact_id=l.object WHERE a.work_id=?",workId),handoffs:all(db,"SELECT * FROM mgmt_handoffs WHERE work_id=? ORDER BY rowid DESC",workId),attention:all(db,"SELECT * FROM control_attention WHERE work_id=? AND state!='resolved'",workId)};}
export function setTracking(db:Database,workId:string,on:boolean):void{ensureMgmtSchema(db);const r=db.query("UPDATE mgmt_work_profile SET track_state=?,archived_at=CASE WHEN ? THEN NULL ELSE archived_at END,updated_at=? WHERE work_id=?").run(on?"tracking":"paused",on?1:0,Date.now(),workId);if(r.changes!==1)throw new ControlError("not_found","work not found");}
