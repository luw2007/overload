import {Database} from 'bun:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Task} from '../orchestrator/store';
import type {AgentRuntime,SessionHandle,SessionReference} from './types';
export class CoordinatorWorkers{
 private handles=new Map<string,SessionHandle>();
 constructor(readonly db:Database,readonly runtime:AgentRuntime,readonly artifactsRoot:string,readonly provider?:string,readonly model?:string){db.exec(`CREATE TABLE IF NOT EXISTS coordinator_runners(task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,reference TEXT NOT NULL,state TEXT NOT NULL,output TEXT NOT NULL DEFAULT '',reason TEXT,PRIMARY KEY(task_id,attempt_id));CREATE TABLE IF NOT EXISTS coordinator_runner_events(session_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(session_id,event_id));`);}
 owns(task:Task):boolean{return !!this.db.query('SELECT 1 FROM coordinator_children WHERE task_id=?').get(task.task_id);}
 async start(task:Task,worktree:string,attempt:string,prompt:string):Promise<{ok:boolean;error?:string}>{
  // PRIMARY KEY(task_id,attempt_id) is the actual duplicate-execution fence; the
  // SELECT above it is only a fast path. A racing second start() for the same
  // attempt must fail the INSERT (UNIQUE constraint) rather than spawn a second
  // runtime session, so a concurrent caller can never slip between the check
  // and the insert and get two live runners for one attempt.
  const reference:SessionReference={runtimeKind:this.runtime.kind,sessionId:'worker-'+task.task_id+'-'+attempt,ownerId:task.task_id,cwd:worktree};
  try{this.db.run('INSERT INTO coordinator_runners(task_id,attempt_id,reference,state) VALUES(?,?,?,?)',[task.task_id,attempt,JSON.stringify(reference),'starting']);}
  catch(error){if(String(error).includes('UNIQUE constraint failed'))return {ok:false,error:'attempt_already_started'};throw error;}
  try{const child=this.db.query('SELECT kind FROM coordinator_children WHERE task_id=?').get(task.task_id) as {kind:string};const handle=await this.runtime.start({sessionId:reference.sessionId,ownerId:reference.ownerId,cwd:worktree,provider:this.provider,model:this.model,readOnly:child.kind==='scout'});this.db.run('UPDATE coordinator_runners SET reference=? WHERE task_id=? AND attempt_id=?',[JSON.stringify(handle.reference),task.task_id,attempt]);this.handles.set(reference.sessionId,handle);void this.observe(task.task_id,attempt,handle);const receipt=await handle.submit({turnId:attempt,text:prompt});this.db.run("UPDATE coordinator_runners SET state=?,reason=? WHERE task_id=? AND attempt_id=? AND state='starting'",[receipt.state==='accepted'?'running':'unknown',receipt.reason??null,task.task_id,attempt]);return {ok:receipt.state==='accepted',error:receipt.reason};}catch(error){const reason=error instanceof Error?error.message:'worker_start_unknown';this.db.run("UPDATE coordinator_runners SET state='unknown',reason=? WHERE task_id=? AND attempt_id=?",[reason,task.task_id,attempt]);return {ok:false,error:reason};}
 }
 async probe(task:Task):Promise<'running'|'ended'|'unknown'>{
  if(!task.attempt_id)return 'unknown';const row=this.db.query('SELECT * FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(task.task_id,task.attempt_id) as {reference:string;state:string}|null;if(!row)return 'unknown';if(row.state==='completed')return 'ended';if(row.state==='failed'||row.state==='unknown')return 'unknown';const reference=JSON.parse(row.reference) as SessionReference;if(!this.handles.has(reference.sessionId)){try{const handle=await this.runtime.connect(reference);this.handles.set(reference.sessionId,handle);void this.observe(task.task_id,task.attempt_id,handle);}catch{return 'unknown';}}return 'running';
 }
 private async observe(taskId:string,attempt:string,handle:SessionHandle):Promise<void>{try{for await(const event of handle.events){this.db.transaction(()=>{if(!this.db.run('INSERT OR IGNORE INTO coordinator_runner_events VALUES(?,?)',[event.sessionId,event.eventId]).changes)return;if(event.turnId!==attempt)return;if(event.kind==='output')this.db.run("UPDATE coordinator_runners SET output=output||? WHERE task_id=? AND attempt_id=?",[event.text??'',taskId,attempt]);else if(event.kind==='completed'||event.kind==='failed'||event.kind==='unknown'||event.kind==='blocked'){this.db.run('UPDATE coordinator_runners SET state=?,reason=? WHERE task_id=? AND attempt_id=?',[event.kind==='blocked'?'unknown':event.kind,event.reason??event.text??null,taskId,attempt]);if(event.kind==='completed'){const row=this.db.query('SELECT output FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(taskId,attempt) as {output:string};const dir=join(this.artifactsRoot,taskId);mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,'report-'+attempt+'.txt'),row.output,{mode:0o600});}}}).immediate();}}catch(error){this.db.run("UPDATE coordinator_runners SET state='unknown',reason=? WHERE task_id=? AND attempt_id=? AND state NOT IN ('completed','failed')",[error instanceof Error?error.message:'worker_stream_lost',taskId,attempt]);}}
 async close():Promise<void>{for(const handle of this.handles.values())await handle.close();this.handles.clear();}
}
