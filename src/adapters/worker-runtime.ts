import {Database} from 'bun:sqlite';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import type {Task} from '../orchestrator/store';
import type {AgentRuntime,SessionHandle,SessionReference} from './types';
export interface ManagedStartResult {ok:boolean;uncertain?:boolean;error?:string}
export class CoordinatorWorkers{
 private handles=new Map<string,SessionHandle>();
 constructor(readonly db:Database,readonly runtime:AgentRuntime,readonly artifactsRoot:string,readonly provider?:string,readonly model?:string){db.exec(`CREATE TABLE IF NOT EXISTS coordinator_runners(task_id TEXT NOT NULL,attempt_id TEXT NOT NULL,reference TEXT NOT NULL,state TEXT NOT NULL,output TEXT NOT NULL DEFAULT '',reason TEXT,PRIMARY KEY(task_id,attempt_id));CREATE TABLE IF NOT EXISTS coordinator_runner_events(session_id TEXT NOT NULL,event_id TEXT NOT NULL,PRIMARY KEY(session_id,event_id));`);}
 owns(task:Task):boolean{return !!this.db.query('SELECT 1 FROM coordinator_children WHERE task_id=?').get(task.task_id);}
 async start(task:Task,worktree:string,attempt:string,prompt:string):Promise<ManagedStartResult>{
  const reference:SessionReference={runtimeKind:this.runtime.kind,sessionId:'worker-'+task.task_id+'-'+attempt,ownerId:task.task_id,cwd:worktree};
  const owns=()=>!!this.db.query("SELECT 1 FROM tasks WHERE task_id=? AND attempt_id=? AND owner_instance=? AND state='starting'").get(task.task_id,attempt,task.owner_instance);
  // Commit both the cleanup reference and the occupancy fence BEFORE invoking runtime.start.
  const reserved=this.db.transaction(()=>{
   if(!owns())return false;
   try{this.db.run('INSERT INTO coordinator_runners(task_id,attempt_id,reference,state) VALUES(?,?,?,?)',[task.task_id,attempt,JSON.stringify(reference),'starting']);}
   catch(error){if(String(error).includes('UNIQUE constraint failed'))return false;throw error;}
   this.db.run("UPDATE tasks SET stop_state='stop_unconfirmed',stop_requested_at=?,stop_reason='managed_start_unverified' WHERE task_id=? AND attempt_id=? AND owner_instance=? AND state='starting'",[Date.now(),task.task_id,attempt,task.owner_instance]);
   return true;
  }).immediate();
  if(!reserved)return {ok:false,uncertain:true,error:'attempt_already_started_or_owner_lost'};
  let failure='worker_start_unknown';
  try{
   const child=this.db.query('SELECT kind FROM coordinator_children WHERE task_id=?').get(task.task_id) as {kind:string};
   const handle=await this.runtime.start({sessionId:reference.sessionId,ownerId:reference.ownerId,cwd:worktree,provider:this.provider,model:this.model,readOnly:child.kind==='scout'});
   if(handle.reference.runtimeKind!==reference.runtimeKind||handle.reference.sessionId!==reference.sessionId||handle.reference.ownerId!==reference.ownerId||handle.reference.cwd!==reference.cwd){await handle.close();throw new Error('runtime_reference_mismatch');}
   this.db.run("UPDATE coordinator_runners SET reference=?,state='created' WHERE task_id=? AND attempt_id=? AND state='starting'",[JSON.stringify(handle.reference),task.task_id,attempt]);
   if(!owns()){await handle.close();return {ok:false,uncertain:true,error:'managed_owner_lost'};}
   this.handles.set(reference.sessionId,handle);
   const submitted=Promise.withResolvers<void>();
   void this.observe(task.task_id,attempt,task.owner_instance,handle,submitted.promise);
   let receipt;
   try{receipt=await handle.submit({turnId:attempt,text:prompt});}
   finally{submitted.resolve();}
   if(receipt.state!=='accepted'){failure=receipt.reason??'managed_submit_'+receipt.state;}
   else if(owns()){
    let accepted=false;
    this.db.transaction(()=>{
     if(!owns())return;
     const row=this.db.query('SELECT state FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(task.task_id,attempt) as {state:string};
     if(!['created','running','completed','failed'].includes(row.state))return;
     this.db.run("UPDATE coordinator_runners SET state='running' WHERE task_id=? AND attempt_id=? AND state='created'",[task.task_id,attempt]);
     this.db.run("UPDATE tasks SET stop_state=NULL,stop_requested_at=NULL,stop_deadline_at=NULL,stop_reason=NULL WHERE task_id=? AND attempt_id=? AND owner_instance=? AND state='starting' AND stop_reason='managed_start_unverified'",[task.task_id,attempt,task.owner_instance]);
     accepted=true;
    }).immediate();
    if(accepted&&owns())return {ok:true};
    await this.detach(handle);
    return {ok:false,uncertain:true,error:'managed_stream_or_owner_unverified'};
   }
   else failure='managed_owner_lost';
  }catch(error){failure=error instanceof Error?error.message:'worker_start_unknown';}
  const result=await this.cleanupUncertain(task,attempt,reference,failure);
  const handle=this.handles.get(reference.sessionId);
  if(handle)await this.detach(handle);
  return result;
 }
 private async cleanupUncertain(task:Task,attempt:string,reference:SessionReference,reason:string):Promise<{ok:false;uncertain:boolean;error:string}>{
  const fence=()=>!!this.db.query("SELECT 1 FROM tasks WHERE task_id=? AND attempt_id=? AND owner_instance=? AND state IN ('starting','blocked') AND stop_state='stop_unconfirmed'").get(task.task_id,attempt,task.owner_instance);
  // A persisted cleanup intent is single-use: a crash or timeout never triggers a blind second shutdown.
  const cleanup=this.db.transaction(()=>{
   if(!fence())return false;
   const updated=this.db.run("UPDATE coordinator_runners SET state='cleanup_requested',reason=COALESCE(reason,?) WHERE task_id=? AND attempt_id=? AND state IN ('starting','created','running')",[reason,task.task_id,attempt]);
   if(!updated.changes)return false;
   this.db.run("UPDATE tasks SET stop_state='stop_unconfirmed',stop_reason=CASE WHEN stop_reason IS NULL OR stop_reason='managed_start_unverified' THEN ? ELSE stop_reason END WHERE task_id=? AND attempt_id=? AND owner_instance=? AND state IN ('starting','blocked')",[reason,task.task_id,attempt,task.owner_instance]);
   this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) SELECT task_id,?,state,state,'managed_cleanup_requested',? FROM tasks WHERE task_id=? AND attempt_id=? AND owner_instance=?",[Date.now(),JSON.stringify({attempt_id:attempt,reason,reference}),task.task_id,attempt,task.owner_instance]);
   return true;
  }).immediate();
  if(!cleanup)return {ok:false,uncertain:true,error:reason};
  let receipt;
  try{receipt=this.runtime.shutdown?await this.runtime.shutdown(reference):{state:'unknown' as const,reason:'runtime_shutdown_unsupported'};}
  catch(error){receipt={state:'unknown' as const,reason:error instanceof Error?error.message:String(error)};}
  let recorded=false;
  this.db.transaction(()=>{
   if(!fence())return;
   const confirmed=receipt.state==='accepted';
   const updated=this.db.run('UPDATE coordinator_runners SET state=? WHERE task_id=? AND attempt_id=? AND state=?',[confirmed?'stopped':'unknown',task.task_id,attempt,'cleanup_requested']);
   if(!updated.changes)return;
   this.db.run("UPDATE tasks SET stop_state=?,stop_reason=CASE WHEN stop_reason IS NULL OR stop_reason='managed_start_unverified' THEN ? ELSE stop_reason END WHERE task_id=? AND attempt_id=? AND owner_instance=? AND state IN ('starting','blocked')",[confirmed?'stopped_confirmed':'stop_unconfirmed',reason,task.task_id,attempt,task.owner_instance]);
   this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) SELECT task_id,?,state,state,?,? FROM tasks WHERE task_id=? AND attempt_id=? AND owner_instance=?",[Date.now(),confirmed?'managed_cleanup_confirmed':'managed_cleanup_unconfirmed',JSON.stringify({attempt_id:attempt,reason,shutdown_reason:receipt.reason??null}),task.task_id,attempt,task.owner_instance]);
   recorded=true;
  }).immediate();
  return {ok:false,uncertain:!recorded||receipt.state!=='accepted',error:reason};
 }
 async cleanupCreated(task:Task):Promise<'confirmed'|'unknown'> {
  if(!task.attempt_id||task.owner_instance==null)return 'unknown';
  const row=this.db.query('SELECT reference,reason,state FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(task.task_id,task.attempt_id) as {reference:string;reason:string|null;state:string}|null;
  if(!row||row.state!=='created')return 'unknown';
  let reference:SessionReference;
  try{reference=JSON.parse(row.reference) as SessionReference;}
  catch{return 'unknown';}
  const result=await this.cleanupUncertain(task,task.attempt_id,reference,row.reason??task.stop_reason??'managed_start_unverified');
  return result.uncertain?'unknown':'confirmed';
 }
 async probe(task:Task):Promise<'running'|'ended'|'unknown'>{
  if(!task.attempt_id)return 'unknown';const row=this.db.query('SELECT * FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(task.task_id,task.attempt_id) as {reference:string;state:string}|null;
  if(!row)return 'unknown';if(row.state==='completed')return 'ended';if(row.state==='failed'||row.state==='unknown'||row.state==='cleanup_requested'||row.state==='stopped'||row.state==='starting'||row.state==='created')return 'unknown';
  const reference=JSON.parse(row.reference) as SessionReference;
  if(!this.handles.has(reference.sessionId)){try{const handle=await this.runtime.connect(reference);this.handles.set(reference.sessionId,handle);void this.observe(task.task_id,task.attempt_id,task.owner_instance,handle);}catch{return 'unknown';}}
  return 'running';
 }
 private async detach(handle:SessionHandle):Promise<void>{
  if(this.handles.get(handle.reference.sessionId)!==handle)return;
  this.handles.delete(handle.reference.sessionId);
  try{await handle.close();}catch(error){console.error('managed runtime detach failed',error);}
 }
 private async observe(taskId:string,attempt:string,owner:string|null,handle:SessionHandle,submitted?:Promise<void>):Promise<void>{
  const current=()=>!!this.db.query("SELECT 1 FROM tasks WHERE task_id=? AND attempt_id=? AND owner_instance=? AND state IN ('starting','running')").get(taskId,attempt,owner);
  const lost=(reason:string)=>this.db.transaction(()=>{
   if(!current())return;
   const updated=this.db.run("UPDATE coordinator_runners SET state='unknown',reason=? WHERE task_id=? AND attempt_id=? AND state IN ('created','running')",[reason,taskId,attempt]);
   if(!updated.changes)return;
   this.db.run("UPDATE tasks SET stop_state='stop_unconfirmed',stop_reason=? WHERE task_id=? AND attempt_id=? AND owner_instance=?",[reason,taskId,attempt,owner]);
   this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) SELECT task_id,?,state,state,'managed_stream_unverified',? FROM tasks WHERE task_id=? AND attempt_id=? AND owner_instance=?",[Date.now(),JSON.stringify({attempt_id:attempt,reason,reference:handle.reference}),taskId,attempt,owner]);
  }).immediate();
  try{
   for await(const event of handle.events){
    if(event.sessionId!==handle.reference.sessionId||event.turnId!==attempt)continue;
    this.db.transaction(()=>{
     if(!current())return;
     const row=this.db.query('SELECT state FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(taskId,attempt) as {state:string};
     if(!['created','running'].includes(row.state))return;
     if(!this.db.run('INSERT OR IGNORE INTO coordinator_runner_events VALUES(?,?)',[event.sessionId,event.eventId]).changes)return;
     if(event.kind==='output')this.db.run("UPDATE coordinator_runners SET output=output||? WHERE task_id=? AND attempt_id=?",[event.text??'',taskId,attempt]);
     else if(event.kind==='completed'||event.kind==='failed'||event.kind==='unknown'||event.kind==='blocked'){
      const reason=event.reason??event.text??event.kind;
      this.db.run('UPDATE coordinator_runners SET state=?,reason=? WHERE task_id=? AND attempt_id=?',[event.kind==='blocked'?'unknown':event.kind,reason,taskId,attempt]);
      if(event.kind==='completed'){
       const output=this.db.query('SELECT output FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(taskId,attempt) as {output:string};
       const dir=join(this.artifactsRoot,taskId);mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(join(dir,'report-'+attempt+'.txt'),output.output,{mode:0o600});
      }else if(event.kind==='unknown'||event.kind==='blocked'){
       this.db.run("UPDATE tasks SET stop_state='stop_unconfirmed',stop_reason=? WHERE task_id=? AND attempt_id=? AND owner_instance=?",[reason,taskId,attempt,owner]);
       this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) SELECT task_id,?,state,state,'managed_stream_unverified',? FROM tasks WHERE task_id=? AND attempt_id=? AND owner_instance=?",[Date.now(),JSON.stringify({attempt_id:attempt,reason,reference:handle.reference}),taskId,attempt,owner]);
      }
     }
    }).immediate();
    const state=this.db.query('SELECT state FROM coordinator_runners WHERE task_id=? AND attempt_id=?').get(taskId,attempt) as {state:string}|null;
    if(!current()||!state||!['created','running'].includes(state.state))return;
   }
   lost('worker_stream_ended_without_terminal');
  }catch(error){lost(error instanceof Error?error.message:'worker_stream_lost');}
  finally{if(submitted)await submitted;await this.detach(handle);}
 }
 async close():Promise<void>{for(const handle of this.handles.values())await this.detach(handle);}
}
