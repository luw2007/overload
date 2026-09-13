import type { Database } from "bun:sqlite";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { classifyContent } from "./classify";
import { artifactId, canonicalFileKey, versionId } from "./identity";
import { invalidateAcceptances } from "./manifest";
import { canonicalWorkId } from "./relations";
import type { SourceFs } from "./source";
import type { SessionRecord } from "./readers/types";
import { addInputs, id, one } from "./store";

export type CollectionLimits={fileMaxBytes:number;workMaxBytes:number;snapshotRoot:string};
type Captured={artifactId:string;versionId:string;key:string;path:string;sha:string;snapshot:string|null;sensitivity:string;line:number;relation:"modified"|"created"|"present_in_workspace";kind:"file"|"git_dirty";contentKind:"content"|"deleted";producer:string;evidenceRef:string;evidenceAt:number;bytes:number};
const corrected=(db:Database,evidenceRef:string)=>!!one(db,"SELECT 1 FROM mgmt_corrections WHERE evidence_ref=?",evidenceRef);
const sourceHost=(stableId:string,agent:string)=>{const marker=`:${agent}:`,at=stableId.indexOf(marker);return at<0?stableId:stableId.slice(0,at);};
function dirtyPaths(stdout:string,cwd:string):string[]{
  const fields=stdout.split("\0"),paths:string[]=[];
  for(let i=0;i<fields.length;i++){const field=fields[i]!;if(field.length<4||field[2]!==" "||field.slice(0,2)==="!!")continue;const status=field.slice(0,2),path=field.slice(3);if(path)paths.push(isAbsolute(path)?resolve(path):resolve(cwd,path));if(status.includes("R")||status.includes("C"))i++;}
  return paths;
}
async function capture(fs:SourceFs,workId:string,kind:Captured["kind"],path:string,key:string,line:number,relation:Captured["relation"],producer:string,evidenceRef:string,evidenceAt:number,limits:CollectionLimits,used:number,now:number,staged:{tmp:string;final:string}[]):Promise<Captured|null>{
  const aid=artifactId(workId,kind,key);
  const file=await fs.readFile(path,Math.min(limits.fileMaxBytes,Math.max(0,limits.workMaxBytes-used)));
  if(!file){if(kind!=="git_dirty")return null;const sha=id("deleted",path),vid=versionId(aid,"deleted",sha);return {artifactId:aid,versionId:vid,key,path,sha,snapshot:null,sensitivity:"unknown",line,relation,kind,contentKind:"deleted",producer,evidenceRef,evidenceAt,bytes:0};}
  const vid=versionId(aid,"content",file.sha256),verdict=classifyContent(path,file.bytes);let snapshot:string|null=null;
  if(verdict.sensitivity==="none"){snapshot=join(limits.snapshotRoot,workId,aid,file.sha256);const tmp=`${snapshot}.pending-${id(now,line,kind)}`;await mkdir(dirname(tmp),{recursive:true,mode:0o700});await writeFile(tmp,file.bytes,{mode:0o600});staged.push({tmp,final:snapshot});}
  return {artifactId:aid,versionId:vid,key,path,sha:file.sha256,snapshot,sensitivity:verdict.sensitivity,line,relation,kind,contentKind:"content",producer,evidenceRef,evidenceAt,bytes:file.bytes.length};
}
function markContention(db:Database,current:{executionId:string;path:string;evidenceAt:number}){
  const me=one<any>(db,"SELECT stable_id,agent,cwd FROM mgmt_executions WHERE execution_id=?",current.executionId);if(!me?.cwd)return;
  const key=canonicalFileKey(me.cwd,current.path),host=sourceHost(me.stable_id,me.agent);
  const candidates=db.query(`SELECT l.link_id,l.subject execution_id,v.version_id,v.evidence_at,e.stable_id,e.agent,e.cwd
    FROM mgmt_links l JOIN mgmt_artifact_versions v ON v.version_id=l.object JOIN mgmt_artifacts a ON a.artifact_id=v.artifact_id
    JOIN mgmt_executions e ON e.execution_id=l.subject
    WHERE l.superseded_at IS NULL AND l.relation IN ('modified','created') AND a.kind='file' AND a.canonical_key=?`).all(key) as any[];
  const overlapping=candidates.filter(x=>x.execution_id!==current.executionId&&x.cwd===me.cwd&&sourceHost(x.stable_id,x.agent)===host&&Math.abs((x.evidence_at??current.evidenceAt)-current.evidenceAt)<=60_000);
  if(!overlapping.length)return;
  const executionIds=new Set([current.executionId,...overlapping.map(x=>x.execution_id)]);
  const active=candidates.filter(x=>executionIds.has(x.execution_id));
  for(const row of active){db.query("UPDATE mgmt_artifact_versions SET producer='multiple' WHERE version_id=?").run(row.version_id);db.query("UPDATE mgmt_links SET confidence='uncertain' WHERE link_id=? AND superseded_at IS NULL").run(row.link_id);}
}
export async function collectExecution(db:Database,fs:SourceFs,workId:string,executionId:string,sourcePath:string,record:SessionRecord,limits:CollectionLimits,now:number):Promise<{inputs:number;artifacts:number}> {
  const ownerWorkId=canonicalWorkId(db,workId),staged:{tmp:string;final:string}[]=[],rows:Captured[]=[],reads:{artifactId:string;key:string;path:string;line:number;evidenceRef:string}[]=[],attempts:{artifactId:string;key:string;path:string;line:number;evidenceRef:string}[]=[];let used=0,artifacts=0;
  const successfulWrites=new Set<string>();
  for(const event of record.toolEvents){
    if(!event.path)continue;const evidenceRef=`${sourcePath}#L${event.lineNo}`;if(corrected(db,evidenceRef))continue;
    const key=canonicalFileKey(record.cwd,event.path),aid=artifactId(ownerWorkId,"file",key);
    if(event.relation==="read"){if(!event.isError)reads.push({artifactId:aid,key,path:event.path,line:event.lineNo,evidenceRef});continue;}
    if(event.relation!=="modified"&&event.relation!=="created")continue;if(event.isError){attempts.push({artifactId:aid,key,path:event.path,line:event.lineNo,evidenceRef});continue;}if(!event.succeeded)continue;
    successfulWrites.add(key);const row=await capture(fs,ownerWorkId,"file",event.path,key,event.lineNo,event.relation,executionId,evidenceRef,event.at??now,limits,used,now,staged);if(row){rows.push(row);used+=row.bytes;}
  }
  if(record.cwd){const status=await fs.exec(record.cwd,["git","status","--porcelain=v1","-z","--untracked-files=all","--","."],10_000);if(status.code===0)for(const path of dirtyPaths(status.stdout,record.cwd)){const key=canonicalFileKey(record.cwd,path);if(successfulWrites.has(key))continue;
    const evidenceRef=`${sourcePath}#git-status:${key}`;if(corrected(db,evidenceRef))continue;const row=await capture(fs,ownerWorkId,"git_dirty",path,key,record.lastLineNo,"present_in_workspace","unknown",evidenceRef,now,limits,used,now,staged);if(row){rows.push(row);used+=row.bytes;}
  }}
  db.exec("BEGIN IMMEDIATE");
  try{
    addInputs(db,workId,executionId,record.userMessages,sourcePath,now);
    for(const read of reads){db.query("INSERT OR IGNORE INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,display_path,created_at) VALUES(?,?,'file',?,?,?)").run(read.artifactId,ownerWorkId,read.key,read.path,now);db.query("INSERT OR IGNORE INTO mgmt_links(link_id,work_id,subject,relation,object,confidence,evidence_ref,observed_at) SELECT ?,?,?,'read',?,'strong',?,? WHERE NOT EXISTS(SELECT 1 FROM mgmt_corrections WHERE evidence_ref=?)").run(id(executionId,"read",read.artifactId,read.line),ownerWorkId,executionId,read.artifactId,read.evidenceRef,now,read.evidenceRef);}
    for(const attempt of attempts){db.query("INSERT OR IGNORE INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,display_path,created_at) VALUES(?,?,'file',?,?,?)").run(attempt.artifactId,ownerWorkId,attempt.key,attempt.path,now);db.query("INSERT OR IGNORE INTO mgmt_links(link_id,work_id,subject,relation,object,confidence,evidence_ref,observed_at) SELECT ?,?,?,'attempted_modify',?,'strong',?,? WHERE NOT EXISTS(SELECT 1 FROM mgmt_corrections WHERE evidence_ref=?)").run(id(executionId,"attempted_modify",attempt.artifactId,attempt.line),ownerWorkId,executionId,attempt.artifactId,attempt.evidenceRef,now,attempt.evidenceRef);}
    let insertedVersion=false;
    for(const row of rows){if(corrected(db,row.evidenceRef))continue;db.query("INSERT OR IGNORE INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,display_path,created_at) VALUES(?,?,?,?,?,?)").run(row.artifactId,ownerWorkId,row.kind,row.key,row.path,now);const snapshotState=row.snapshot?"pending":row.sensitivity!=="none"?"withheld_sensitive":"reference_only",stale=now-row.evidenceAt>60_000?1:0;
      insertedVersion=!!db.query(`INSERT OR IGNORE INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_path,staging_name,snapshot_state,sensitivity,producer,stale_capture,observed_at,evidence_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(row.versionId,row.artifactId,row.contentKind,row.sha,row.snapshot,row.snapshot?staged.find(x=>x.final===row.snapshot)?.tmp:null,snapshotState,row.sensitivity,row.producer,stale,now,row.evidenceAt).changes||insertedVersion;
      db.query("INSERT OR IGNORE INTO mgmt_observations(version_id,execution_id,observed_source,evidence_ref,observed_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM mgmt_corrections WHERE evidence_ref=?)").run(row.versionId,row.relation==="present_in_workspace"?null:executionId,row.relation==="present_in_workspace"?"git_status":"tool_event",row.evidenceRef,now,row.evidenceRef);
      db.query("INSERT OR IGNORE INTO mgmt_links(link_id,work_id,subject,relation,object,confidence,evidence_ref,observed_at) SELECT ?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM mgmt_corrections WHERE evidence_ref=?)").run(id(row.relation==="present_in_workspace"?ownerWorkId:executionId,row.relation,row.versionId,row.line),ownerWorkId,row.relation==="present_in_workspace"?ownerWorkId:executionId,row.relation,row.versionId,row.relation==="present_in_workspace"?"uncertain":"strong",row.evidenceRef,now,row.evidenceRef);
      if(row.relation!=="present_in_workspace")markContention(db,{executionId,path:row.path,evidenceAt:row.evidenceAt});artifacts++;
    }
    if(insertedVersion)invalidateAcceptances(db,ownerWorkId,"artifact_version_changed",now);
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  for(const file of staged){await rename(file.tmp,file.final);db.query("UPDATE mgmt_artifact_versions SET snapshot_state='stored',staging_name=NULL WHERE snapshot_path=? AND snapshot_state='pending'").run(file.final);}
  return {inputs:record.userMessages.length,artifacts};
}
