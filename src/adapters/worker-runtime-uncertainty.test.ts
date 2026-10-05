import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CoordinatorWorkers,type ManagedStartResult} from './worker-runtime';
import {addTask,claim,getTask,openStore,setRecovery} from '../orchestrator/store';
import type {AgentRuntime,CommandReceipt,RuntimeEvent,SessionHandle,StartRequest} from './types';
import {Orchestrator} from '../orchestrator/orchestrator';
import {SpoolWriter} from '../orchestrator/spool';

function fixture(){
 const root=mkdtempSync(join(tmpdir(),'managed-runner-'));
 const db=openStore(join(root,'tasks.db'));
 db.exec('CREATE TABLE coordinator_children(task_id TEXT PRIMARY KEY,kind TEXT NOT NULL)');
 const task=addTask(db,'inspect',join(root,'repo'),'main');
 db.run("INSERT INTO coordinator_children VALUES(?,'ship')",[task.task_id]);
 const owner='owner-a';const started=claim(db,owner,2)[0];
 return {root,db,task:started,owner,dispose:()=>{db.close();rmSync(root,{recursive:true,force:true});}};
}

function handle(request:StartRequest,events:AsyncIterable<RuntimeEvent>,submit:()=>Promise<CommandReceipt>):SessionHandle{
 return {reference:{runtimeKind:'fake',sessionId:request.sessionId,ownerId:request.ownerId,cwd:request.cwd},events,submit,cancel:async()=>({state:'rejected',commandId:'cancel'}),close:async()=>{}};
}
async function* parked():AsyncIterable<RuntimeEvent>{const gate=Promise.withResolvers<void>();await gate.promise;}
function receipt(state:CommandReceipt['state'],reason?:string):CommandReceipt{return {state,commandId:'command',reason};}

for(const mode of ['rejected','unknown','start_throw','submit_throw'] as const){
 test(`managed ${mode} preserves claim until confirmed shutdown`,async()=>{
  const f=fixture();let starts=0,shutdowns=0;
  try{
   const runtime:AgentRuntime={kind:'fake',capabilities:{restore:false,answer:false,steer:false},async start(request){starts++;if(mode==='start_throw')throw Error('created_but_start_failed');return handle(request,parked(),async()=>{if(mode==='submit_throw')throw Error('submit_failed');return receipt(mode,'original_'+mode);});},async connect(){throw Error('must_not_reconnect');},async shutdown(){shutdowns++;return receipt('unknown','still_alive');}};
   const workers=new CoordinatorWorkers(f.db,runtime,f.root);
   setRecovery(f.db,f.task.task_id,f.task.attempt_id!,'intent');
   const result=await workers.start(f.task,f.task.repo,f.task.attempt_id!,'prompt');
   expect(result.ok).toBe(false);expect(result.uncertain).toBe(true);
   expect(getTask(f.db,f.task.task_id)?.stop_state).toBe('stop_unconfirmed');
   const same=addTask(f.db,'same',f.task.repo,'main');
   const other=addTask(f.db,'other',join(f.root,'elsewhere'),'main');
   expect(claim(f.db,'owner-b',1)).toHaveLength(0);
   expect(claim(f.db,'owner-b',2).map(row=>row.task_id)).toEqual([other.task_id]);
   expect(getTask(f.db,same.task_id)?.state).toBe('queued');
   expect((await workers.start(f.task,f.task.repo,f.task.attempt_id!,'prompt')).ok).toBe(false);
   expect(starts).toBe(1);expect(shutdowns).toBe(1);
  }finally{f.dispose();}
 });
}

test('confirmed shutdown releases blocked repo while retaining original failure',async()=>{
 const f=fixture();try{
  const runtime:AgentRuntime={kind:'fake',capabilities:{restore:false,answer:false,steer:false},async start(request){return handle(request,parked(),async()=>receipt('rejected','real_submit_reason'));},async connect(){throw Error('unexpected_connect');},async shutdown(){return receipt('accepted');}};
  const workers=new CoordinatorWorkers(f.db,runtime,f.root);
  const result=await workers.start(f.task,f.task.repo,f.task.attempt_id!,'prompt');
  expect(result.uncertain).toBe(false);
  expect(getTask(f.db,f.task.task_id)?.stop_state).toBe('stopped_confirmed');
  expect(getTask(f.db,f.task.task_id)?.stop_reason).toBe('real_submit_reason');
  f.db.run("UPDATE tasks SET state='blocked' WHERE task_id=?",[f.task.task_id]);
  const next=addTask(f.db,'next',f.task.repo,'main');
  expect(claim(f.db,'owner-b',2).map(task=>task.task_id)).toEqual([next.task_id]);
 }finally{f.dispose();}
});

test('crashed durable start intent holds repo and global slot across instances',()=>{
 const f=fixture();try{
  f.db.run("UPDATE tasks SET state='blocked',stop_state='stop_unconfirmed',stop_reason='start_unknown' WHERE task_id=?",[f.task.task_id]);
  const second=addTask(f.db,'next',join(f.root,'second'),'main');
  expect(claim(f.db,'new-owner',1)).toHaveLength(0);
  expect(getTask(f.db,second.task_id)?.state).toBe('queued');
  const same=addTask(f.db,'same',f.task.repo,'main');
  expect(claim(f.db,'new-owner',2).map(row=>row.task_id)).toEqual([second.task_id]);
  expect(getTask(f.db,same.task_id)?.state).toBe('queued');
 }finally{f.dispose();}
});

test('cross-session events do not contaminate output; clean end becomes unknown without overwriting completed',async()=>{
 const f=fixture();try{
  const streamDone=Promise.withResolvers<void>();
  const runtime:AgentRuntime={kind:'fake',capabilities:{restore:false,answer:false,steer:false},async start(request){
   async function* events():AsyncIterable<RuntimeEvent>{
    try{
     yield {eventId:'foreign',sessionId:'another-session',turnId:f.task.attempt_id!,kind:'completed',text:'foreign'};
     yield {eventId:'foreign-output',sessionId:'another-session',turnId:f.task.attempt_id!,kind:'output',text:'LEAK'};
     yield {eventId:'output',sessionId:request.sessionId,turnId:f.task.attempt_id!,kind:'output',text:'safe'};
    }finally{streamDone.resolve();}
   }
   return handle(request,events(),async()=>receipt('accepted'));
  },async connect(){throw Error('unexpected_connect');}};
  const workers=new CoordinatorWorkers(f.db,runtime,f.root);
  await workers.start(f.task,f.task.repo,f.task.attempt_id!,'prompt');
  await streamDone.promise;await Promise.resolve();
  const row=f.db.query('SELECT state,output FROM coordinator_runners WHERE task_id=?').get(f.task.task_id) as {state:string;output:string};
  expect(row).toEqual({state:'unknown',output:'safe'});
  expect(getTask(f.db,f.task.task_id)?.stop_state).toBe('stop_unconfirmed');
  expect((f.db.query('SELECT count(*) n FROM coordinator_runner_events').get() as {n:number}).n).toBe(1);
 }finally{f.dispose();}
});

test('completed turn remains completed when stream closes normally',async()=>{
 const f=fixture();const streamDone=Promise.withResolvers<void>();
 try{
  const runtime:AgentRuntime={kind:'fake',capabilities:{restore:false,answer:false,steer:false},async start(request){
   async function* events():AsyncIterable<RuntimeEvent>{
    try{yield {eventId:'done',sessionId:request.sessionId,turnId:f.task.attempt_id!,kind:'completed'};}
    finally{streamDone.resolve();}
   }
   return handle(request,events(),async()=>receipt('accepted'));
  },async connect(){throw Error('unexpected_connect');}};
  const workers=new CoordinatorWorkers(f.db,runtime,f.root);
  await workers.start(f.task,f.task.repo,f.task.attempt_id!,'prompt');
  await streamDone.promise;await Promise.resolve();
  const row=f.db.query('SELECT state FROM coordinator_runners WHERE task_id=?').get(f.task.task_id) as {state:string};
  expect(row.state).toBe('completed');
  expect(getTask(f.db,f.task.task_id)?.stop_state).toBeNull();
 }finally{f.dispose();}
});

for(const blocked of [false,true])for(const shutdown of ['accepted','unknown'] as const){
 test(`late startup survives owner takeover (${blocked?'blocked':'starting'}, ${shutdown}) without replay`,async()=>{
  const f=fixture();writeFileSync(join(f.root,'host'),'local\n');
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();
  let starts=0,submits=0,shutdowns=0,closes=0;
  const runtime:AgentRuntime={kind:'fake',capabilities:{restore:false,answer:false,steer:false},async start(request){
   starts++;
   entered.resolve();
   expect(getTask(f.db,f.task.task_id)?.stop_state).toBe('stop_unconfirmed');
   expect(f.db.query('SELECT state FROM coordinator_runners WHERE task_id=?').get(f.task.task_id)).toEqual({state:'starting'});
   await release.promise;
   return {...handle(request,parked(),async()=>{submits++;return receipt('accepted');}),close:async()=>{closes++;}};
  },async connect(){throw Error('must_not_restore');},async shutdown(){shutdowns++;return receipt(shutdown);}};
  const workers=new CoordinatorWorkers(f.db,runtime,f.root),spool=new SpoolWriter(f.db,f.root);
  const orch=new Orchestrator(f.db,spool,1,join(f.root,'ledger.db'),async()=>({ok:true,stdout:'',stderr:''}),undefined,join(f.root,'worktrees'),join(f.root,'artifacts'),workers);
  let pending:Promise<ManagedStartResult>|undefined;
  try{
   setRecovery(f.db,f.task.task_id,f.task.attempt_id!,'intent');
   pending=workers.start(f.task,f.task.repo,f.task.attempt_id!,'prompt');await entered.promise;
   f.db.run('UPDATE tasks SET lease_expires_at=0 WHERE task_id=?',[f.task.task_id]);
   for(let n=0;n<(blocked?12:1);n++)await orch.reconcile(Date.now());
   expect(getTask(f.db,f.task.task_id)?.owner_instance).toBe(orch.owner);
   expect(getTask(f.db,f.task.task_id)?.state).toBe(blocked?'blocked':'starting');
   expect(shutdowns).toBe(0);
   release.resolve();expect((await pending).ok).toBe(false);
   await orch.reconcile(Date.now());await orch.reconcile(Date.now());
   expect(starts).toBe(1);expect(submits).toBe(0);expect(shutdowns).toBe(1);expect(closes).toBe(1);
   expect(getTask(f.db,f.task.task_id)?.stop_state).toBe(shutdown==='accepted'?'stopped_confirmed':'stop_unconfirmed');
   const next=addTask(f.db,'next',f.task.repo,'main');
   expect(claim(f.db,'next-owner',1).map(task=>task.task_id)).toEqual(shutdown==='accepted'?[next.task_id]:[]);
  }finally{release.resolve();if(pending)await pending;await workers.close();spool.close();f.dispose();}
 });
}

test('terminal event before submit ACK detaches once without cancelling the pending command',async()=>{
 const f=fixture(),terminal=Promise.withResolvers<void>(),ack=Promise.withResolvers<void>(),closed=Promise.withResolvers<void>();
 let closes=0,shutdowns=0,acknowledged=false;
 const runtime:AgentRuntime={kind:'fake',capabilities:{restore:false,answer:false,steer:false},async start(request){
  async function* events():AsyncIterable<RuntimeEvent>{try{yield {eventId:'done',sessionId:request.sessionId,turnId:f.task.attempt_id!,kind:'completed'};}finally{terminal.resolve();}}
  return {...handle(request,events(),async()=>{await ack.promise;acknowledged=true;return receipt('accepted');}),close:async()=>{expect(acknowledged).toBe(true);closes++;closed.resolve();}};
 },async connect(){throw Error('unexpected_connect');},async shutdown(){shutdowns++;return receipt('accepted');}};
 const workers=new CoordinatorWorkers(f.db,runtime,f.root);
 try{
  const pending=workers.start(f.task,f.task.repo,f.task.attempt_id!,'prompt');await terminal.promise;
  expect(closes).toBe(0);ack.resolve();expect(await pending).toEqual({ok:true});await closed.promise;
  expect(await workers.probe(getTask(f.db,f.task.task_id)!)).toBe('ended');
  expect(getTask(f.db,f.task.task_id)?.stop_state).toBeNull();
  await workers.close();expect(closes).toBe(1);expect(shutdowns).toBe(0);
 }finally{ack.resolve();await workers.close();f.dispose();}
});
