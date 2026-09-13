import type { Database } from "bun:sqlite";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { classifyContent } from "./classify";
import { artifactId, canonicalFileKey, versionId } from "./identity";
import { invalidateAcceptances } from "./manifest";
import type { SourceFs } from "./source";
import type { SessionRecord } from "./readers/types";
import { addInputs, id, one, updateCursor } from "./store";

export type CollectionLimits={fileMaxBytes:number;workMaxBytes:number;snapshotRoot:string};
export async function collectExecution(db:Database, fs:SourceFs, workId:string, executionId:string, sourcePath:string, record:SessionRecord, limits:CollectionLimits, now:number):Promise<{inputs:number;artifacts:number}> {
  const staged:{tmp:string;final:string}[]=[]; let used=0; let artifacts=0;
  const rows:{artifactId:string;versionId:string;key:string;path:string;sha:string;snapshot:string|null;truncated:boolean;sensitivity:string;line:number;relation:string}[]=[];
  const reads:{artifactId:string;key:string;path:string;line:number}[]=[];
  for(const event of record.toolEvents){
    if(!event.path)continue;
    const key=canonicalFileKey(record.cwd,event.path), aid=artifactId(workId,"file",key);
    if(event.relation==="read"){reads.push({artifactId:aid,key,path:event.path,line:event.lineNo});continue;}
    if(event.relation!=="modified"&&event.relation!=="created")continue;
    const file=await fs.readFile(event.path,Math.min(limits.fileMaxBytes,Math.max(0,limits.workMaxBytes-used)));
    if(!file)continue;
    used+=file.bytes.length;
    const vid=versionId(aid,"content",file.sha256);
    const verdict=classifyContent(event.path,file.bytes); let snapshot:string|null=null;
    if(verdict.snapshotAllowed){
      snapshot=join(limits.snapshotRoot,workId,aid,file.sha256); const tmp=`${snapshot}.pending-${id(now,event.lineNo)}`;
      await mkdir(dirname(tmp),{recursive:true}); await writeFile(tmp,file.bytes); staged.push({tmp,final:snapshot});
    }
    rows.push({artifactId:aid,versionId:vid,key,path:event.path,sha:file.sha256,snapshot,truncated:file.truncated,sensitivity:verdict.sensitivity,line:event.lineNo,relation:event.relation});
  }
  db.exec("BEGIN IMMEDIATE");
  try{
    addInputs(db,workId,executionId,record.userMessages,sourcePath,now);
    for(const read of reads){
      db.query("INSERT OR IGNORE INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,display_path,created_at) VALUES(?,?,'file',?,?,?)").run(read.artifactId,workId,read.key,read.path,now);
      db.query("INSERT OR IGNORE INTO mgmt_links(link_id,work_id,subject,relation,object,confidence,evidence_ref,observed_at) VALUES(?,?,?,'read',?,'strong',?,?)").run(id(executionId,"read",read.artifactId,read.line),workId,executionId,read.artifactId,`${sourcePath}#L${read.line}`,now);
    }
    let insertedVersion = false;
    for(const row of rows){
      db.query("INSERT OR IGNORE INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,display_path,created_at) VALUES(?,?,'file',?,?,?)").run(row.artifactId,workId,row.key,row.path,now);
      const snapshotState=row.snapshot?"pending":row.sensitivity==="sensitive"?"withheld_sensitive":"reference_only";
      insertedVersion =
        !!db.query(`INSERT OR IGNORE INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_path,staging_name,snapshot_state,sensitivity,producer,observed_at,evidence_at)
        VALUES(?,?,'content',?,?,?,?,?,?,?,?)`).run(row.versionId,row.artifactId,row.sha,row.snapshot,row.snapshot?staged.find(x=>x.final===row.snapshot)?.tmp:null,snapshotState,row.sensitivity,executionId,now,now).changes || insertedVersion;
      db.query("INSERT OR IGNORE INTO mgmt_observations(version_id,execution_id,observed_source,evidence_ref,observed_at) VALUES(?,?,?,?,?)").run(row.versionId,executionId,"tool_event",`${sourcePath}#L${row.line}`,now);
      db.query("INSERT OR IGNORE INTO mgmt_links(link_id,work_id,subject,relation,object,confidence,evidence_ref,observed_at) VALUES(?,?,?,?,?,'strong',?,?)").run(id(executionId,row.relation,row.versionId,row.line),workId,executionId,row.relation,row.versionId,`${sourcePath}#L${row.line}`,now);
      artifacts++;
    }
    if (insertedVersion)
      invalidateAcceptances(db, workId, "artifact_version_changed", now);
    updateCursor(db,sourcePath,{byte:one<any>(db,"SELECT cursor FROM mgmt_cursors WHERE source_key=?",sourcePath)?.cursor??0,generation:"parsed",line:record.lastLineNo},"parsed",now);
    db.exec("COMMIT");
  }catch(error){db.exec("ROLLBACK");throw error;}
  for(const file of staged){try{await rename(file.tmp,file.final);db.query("UPDATE mgmt_artifact_versions SET snapshot_state='stored',staging_name=NULL WHERE snapshot_path=?").run(file.final);}catch{db.query("UPDATE mgmt_artifact_versions SET snapshot_state='lost' WHERE snapshot_path=?").run(file.final);}}
  return {inputs:record.userMessages.length,artifacts};
}
