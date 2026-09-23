import { afterEach, expect, test } from "bun:test";import { mkdtempSync,rmSync,writeFileSync } from "node:fs";import { tmpdir } from "node:os";import { join } from "node:path";import { Database } from "bun:sqlite";import { openLedger,scanOnce } from "../ingest/ingest";import { addTask,claim,getRecovery,getTask,openStore,setRecovery,type Task } from "./store";import { SpoolWriter } from "./spool";import { Orchestrator } from "./orchestrator";import { taskOrigin } from "./runner";
const BASE_REF="a".repeat(40);
const dirs:string[]=[];afterEach(()=>dirs.splice(0).forEach(d=>rmSync(d,{recursive:true,force:true})));
test("tick emits ingestible overload session and leaves same repo queued",async()=>{const root=mkdtempSync(join(tmpdir(),"orch-int-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");const db=openStore(join(root,"orchestrator.db"));const first=addTask(db,"first","/repo",BASE_REF,1),second=addTask(db,"second","/repo",BASE_REF,2);const spool=new SpoolWriter(db,root);const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),async()=>({ok:false,stdout:"",stderr:"not a repo"}));await orch.tick(3);expect(getTask(db,first.task_id)?.state).toBe("failed");expect(getTask(db,second.task_id)?.state).toBe("queued");const attempt=getTask(db,first.task_id)?.attempt_id;spool.close();db.close();const reopened=openStore(join(root,"orchestrator.db"));expect(getTask(reopened,first.task_id)?.attempt_id).toBe(attempt);reopened.close();const ledger=await openLedger(join(root,"ledger.db"));await scanOnce(ledger,join(root,"spool"),500,"");const row=ledger.query("SELECT runtime,cwd FROM sessions WHERE stable_id=?").get(`local:overload:${first.task_id}`) as {runtime:string;cwd:string};expect(row).toEqual({runtime:"overload",cwd:"/repo"});ledger.close();});
test("tick wires ensureWorktree -> spawnRunner -> session_bound to running with a real scratch repo",async()=>{const root=mkdtempSync(join(tmpdir(),"orch-int2-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");const repo=mkdtempSync(join(tmpdir(),"orch-repo-"));dirs.push(repo);const run=(args:string[])=>Bun.spawnSync(["git",...args],{cwd:repo});run(["init","-q"]);run(["config","user.email","a@a.com"]);run(["config","user.name","a"]);Bun.spawnSync(["bash","-c","echo x > f"],{cwd:repo});run(["add","f"]);run(["commit","-q","-m","init"]);
const db=openStore(join(root,"orchestrator.db"));const baseRef=run(["rev-parse","HEAD"]).stdout.toString().trim();const task=addTask(db,"t",repo,baseRef,1);const spool=new SpoolWriter(db,root);
const spawnCalls:Array<{command:string;args:string[]}>=[];const runnerExec=async(command:string,args:string[])=>{spawnCalls.push({command,args});return{ok:true};};
const worktreeExec=async(cmd:string,args:string[])=>{const proc=Bun.spawnSync([cmd,...args]);return{ok:proc.exitCode===0,stdout:proc.stdout.toString(),stderr:proc.stderr.toString()};};
const orch=new Orchestrator(db,spool,4,join(root,"ledger.db"),worktreeExec as never,runnerExec,join(root,"worktrees"),join(root,"artifacts"));
await orch.tick(1);
const afterStart=getTask(db,task.task_id)!;expect(afterStart.state).toBe("running");expect(afterStart.worktree).toBe(join(root,"worktrees",task.task_id));
expect(spawnCalls).toHaveLength(1);expect(spawnCalls[0]!.args).toContain("--focus");
spool.close();db.close();});
test("tick isolates runner errors across tasks",async()=>{const root=mkdtempSync(join(tmpdir(),"orch-errors-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");const repoA=mkdtempSync(join(tmpdir(),"orch-repo-a-")),repoB=mkdtempSync(join(tmpdir(),"orch-repo-b-"));dirs.push(repoA,repoB);const db=openStore(join(root,"orchestrator.db"));const a=addTask(db,"a",repoA,BASE_REF,1),b=addTask(db,"b",repoB,BASE_REF,2);db.run("UPDATE tasks SET state='starting',attempt_id=? WHERE task_id=?",["attempt-a",a.task_id]);db.run("UPDATE tasks SET state='starting',attempt_id=? WHERE task_id=?",["attempt-b",b.task_id]);const spool=new SpoolWriter(db,root);const worktreeExec=async(_cmd:string,args:string[])=>({ok:true,stdout:args.includes(repoA)?"":"",stderr:""});const runnerExec=async(_command:string,args:string[])=>{if(args.some(arg=>arg.includes(a.task_id)))throw new Error("runner A exploded");return{ok:true};};const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),worktreeExec,runnerExec,join(root,"worktrees"),join(root,"artifacts"));await orch.tick(20);expect(getTask(db,a.task_id)?.state).toBe("starting");expect(getTask(db,b.task_id)?.state).toBe("running");const event=db.query("SELECT from_state,to_state,event,detail FROM task_events WHERE task_id=? AND event='tick_error'").get(a.task_id) as {from_state:string;to_state:string;event:string;detail:string};expect(event.from_state).toBe("starting");expect(event.to_state).toBe("starting");expect(event.event).toBe("tick_error");expect(JSON.parse(event.detail).error).toBe("runner A exploded");spool.close();db.close();});
test("overlapping tick is single-flight",async()=>{const root=mkdtempSync(join(tmpdir(),"orch-overlap-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");const repo=mkdtempSync(join(tmpdir(),"orch-repo-overlap-"));dirs.push(repo);const db=openStore(join(root,"orchestrator.db"));const task=addTask(db,"t",repo,BASE_REF,1);const spool=new SpoolWriter(db,root);let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let calls=0;const worktreeExec=async(cmd:string,args:string[])=>{if(cmd==="git"&&args.includes("worktree"))await gate;return{ok:true,stdout:"",stderr:""};};const runnerExec=async()=>{calls++;return{ok:true};};const orch=new Orchestrator(db,spool,1,join(root,"ledger.db"),worktreeExec,runnerExec,join(root,"worktrees"),join(root,"artifacts"));const first=orch.tick(30);expect(await orch.tick(31)).toEqual([]);release();await first;expect(calls).toBe(1);spool.close();db.close();});

test("§3 spawn intent is committed before the spawn is attempted",async()=>{const root=mkdtempSync(join(tmpdir(),"orch-spawn-intent-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");const db=openStore(join(root,"orchestrator.db"));const task=addTask(db,"ordered spawn",join(root,"repo"),BASE_REF,1);const spool=new SpoolWriter(db,root);let checkedAtSpawn=false;const runnerExec=async()=>{const current=getTask(db,task.task_id)!;const recovery=getRecovery(db,task.task_id);expect(current.attempt_id).not.toBeNull();expect(recovery?.spawn_state).toBe("intent");expect(recovery?.attempt_id).toBe(current.attempt_id);checkedAtSpawn=true;return{ok:true};};const orch=new Orchestrator(db,spool,1,join(root,"ledger.db"),async()=>({ok:true,stdout:"",stderr:""}),runnerExec,join(root,"worktrees"),join(root,"artifacts"));await orch.tick(10);expect(checkedAtSpawn).toBe(true);expect(getRecovery(db,task.task_id)?.spawn_state).toBe("spawned");spool.close();db.close();});

test("runner exit with no check blocks as no_check without spending retry budget",async()=>{const root=mkdtempSync(join(tmpdir(),"orch-no-check-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");const repo=join(root,"repo");Bun.spawnSync(["git","init",repo]);Bun.spawnSync(["git","-C",repo,"config","user.email","t@e.st"]);Bun.spawnSync(["git","-C",repo,"config","user.name","T"]);writeFileSync(join(repo,"a"),"a");Bun.spawnSync(["git","-C",repo,"add","."]);Bun.spawnSync(["git","-C",repo,"commit","-m","base"]);const baseRef=Bun.spawnSync(["git","-C",repo,"rev-parse","HEAD"]).stdout.toString().trim();writeFileSync(join(repo,"a"),"b");Bun.spawnSync(["git","-C",repo,"add","."]);Bun.spawnSync(["git","-C",repo,"commit","-m","change"]);const db=openStore(join(root,"orchestrator.db"));const task=addTask(db,"missing check",repo,baseRef,1);db.run("UPDATE tasks SET state='running',worktree=?,runner_pid=?,retry_budget=2 WHERE task_id=?",[repo,99999999,task.task_id]);const spool=new SpoolWriter(db,root);const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),undefined,undefined,join(root,"worktrees"),join(root,"artifacts"));await (orch as unknown as {pollRunning(task:Task,now:number):Promise<void>}).pollRunning(getTask(db,task.task_id),2);const blocked=getTask(db,task.task_id)!;expect(blocked.state).toBe("blocked");expect(blocked.blocked_reason).toBe("no_check");expect(blocked.retry_budget).toBe(2);const event=db.query("SELECT event,detail FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1").get(task.task_id) as {event:string;detail:string};expect(event.event).toBe("check_absent");expect(JSON.parse(event.detail).reason).toBe("no_check");spool.close();db.close();});

function seedLedgerSession(ledger:Database,stableId:string,origin:string,opts:{pid?:number;bootId?:string;ended?:boolean}={}):void{
  ledger.run("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,branch,created_at,first_seen_at) VALUES(?,?,?,?,?,?,?,?,?)",[stableId,"local","pi","s",origin,"/wt","main",0,0]);
  if(opts.pid!=null)ledger.run("INSERT INTO session_incarnations(stable_id,writer_id,liveness_domain,pid,proc_boot_id,started_at,last_seen_at) VALUES(?,?,?,?,?,?,?)",[stableId,"writer","process",opts.pid,opts.bootId??"boot",0,0]);
  if(opts.ended)ledger.run("INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind) VALUES(?,?,?,?,?,?,?)",["local","writer",1,0,stableId,"writer","session_ended"]);
}
const okExec=async()=>({ok:true,stdout:"",stderr:""});

test("§7-1 crash-before-spawn task is redriven without spending retry budget",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon1-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const calls:number[]=[];const runnerExec=async()=>{calls.push(1);return{ok:true};};
  const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),okExec,runnerExec,join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  await orch.tick(1);
  const after=getTask(db,task.task_id)!;
  expect(calls).toHaveLength(1);expect(after.state).toBe("running");expect(after.retry_budget).toBe(2);
  const recovery=db.query("SELECT spawn_state FROM task_recovery WHERE task_id=?").get(task.task_id) as {spawn_state:string};
  expect(recovery.spawn_state).toBe("spawned");
  spool.close();db.close();
});

test("§7-2 intent state never spawns while the ingest window catches up",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon2-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const calls:number[]=[];const runnerExec=async()=>{calls.push(1);return{ok:true};};
  const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),okExec,runnerExec,join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  claim(db,orch.owner,4,0);
  const attempt=getTask(db,task.task_id)!.attempt_id!;
  setRecovery(db,task.task_id,attempt,"intent",0);
  (await openLedger(join(root,"ledger.db"))).close(); // ledger exists but has no matching origin (ingest hasn't caught up)
  await orch.tick(1);
  let after=getTask(db,task.task_id)!;
  expect(calls).toHaveLength(0);expect(after.state).toBe("starting");
  let recovery=db.query("SELECT unknown_ticks FROM task_recovery WHERE task_id=?").get(task.task_id) as {unknown_ticks:number};
  expect(recovery.unknown_ticks).toBe(1);
  for(let i=2;i<=12;i++)await orch.tick(i);
  after=getTask(db,task.task_id)!;
  expect(after.state).toBe("blocked");expect(after.blocked_reason).toBe("spawn_unverified");expect(after.retry_budget).toBe(2);
  expect(calls).toHaveLength(0);
  spool.close();db.close();
});

test("§7-3 a still-alive runner recovers without a double spawn",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon3-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const calls:number[]=[];const runnerExec=async()=>{calls.push(1);return{ok:true};};
  const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),okExec,runnerExec,join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  claim(db,orch.owner,4,0);
  const attempt=getTask(db,task.task_id)!.attempt_id!;
  setRecovery(db,task.task_id,attempt,"spawned",0);
  const ledger=await openLedger(join(root,"ledger.db"));
  seedLedgerSession(ledger,"local:pi:live",taskOrigin(task.task_id,attempt),{pid:process.pid,bootId:"boot-live"});
  ledger.close();
  await orch.tick(1);
  expect(calls).toHaveLength(0);
  const after=getTask(db,task.task_id)!;
  expect(after.state).toBe("running");expect(after.stable_id).toBe("local:pi:live");
  spool.close();db.close();
});

test("§7-4 exited is distinguishable from absent",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon4-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const evidenceExec=async(_cmd:string,args:string[])=>{
    if(args[0]==="diff")return{ok:true,stdout:"diff-content\n",stderr:""};
    if(args[0]==="log")return{ok:true,stdout:"abc123 msg\n",stderr:""};
    return{ok:true,stdout:"",stderr:""};
  };
  // (a) ledger says the session already ended: exited -> evidence collection, not runner_dead / unknown.
  {
    const db=openStore(join(root,"a.db"));const spool=new SpoolWriter(db,root);
    const orch=new Orchestrator(db,spool,2,join(root,"a-ledger.db"),evidenceExec,undefined,join(root,"worktrees"),join(root,"artifacts-a"));
    const task=addTask(db,"t","/repo",BASE_REF,0);claim(db,orch.owner,4,0);
    const attempt=getTask(db,task.task_id)!.attempt_id!;
    db.run("UPDATE tasks SET state='running',worktree=?,runner_pid=?,runner_boot_id='boot-x' WHERE task_id=?",[join(root,"wt-a"),process.pid,task.task_id]);
    setRecovery(db,task.task_id,attempt,"spawned",0);
    const ledger=await openLedger(join(root,"a-ledger.db"));
    seedLedgerSession(ledger,"local:pi:a",taskOrigin(task.task_id,attempt),{pid:process.pid,bootId:"boot-x",ended:true});
    ledger.close();
    await orch.tick(1);
    const event=db.query("SELECT event FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1").get(task.task_id) as {event:string};
    expect(["check_absent","runner_exit"]).toContain(event.event);
    const recovery=db.query("SELECT unknown_ticks FROM task_recovery WHERE task_id=?").get(task.task_id) as {unknown_ticks:number};
    expect(recovery.unknown_ticks).toBe(0);
    spool.close();db.close();
  }
  // (b) ledger has nothing at all for this origin: unknown, counts up, no state change.
  {
    const db=openStore(join(root,"b.db"));const spool=new SpoolWriter(db,root);
    const orch=new Orchestrator(db,spool,2,join(root,"b-ledger.db"),evidenceExec,undefined,join(root,"worktrees"),join(root,"artifacts-b"));
    const task=addTask(db,"t","/repo",BASE_REF,0);claim(db,orch.owner,4,0);
    const attempt=getTask(db,task.task_id)!.attempt_id!;
    db.run("UPDATE tasks SET state='running',worktree=?,runner_pid=?,runner_boot_id='boot-x' WHERE task_id=?",[join(root,"wt-b"),process.pid,task.task_id]);
    setRecovery(db,task.task_id,attempt,"spawned",0);
    (await openLedger(join(root,"b-ledger.db"))).close();
    await orch.tick(1);
    const after=getTask(db,task.task_id)!;expect(after.state).toBe("running");
    const recovery=db.query("SELECT unknown_ticks FROM task_recovery WHERE task_id=?").get(task.task_id) as {unknown_ticks:number};
    expect(recovery.unknown_ticks).toBe(1);
    spool.close();db.close();
  }
});

test("§7-5 owner CAS blocks a stale post-await write once the lease has been taken over",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon5-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spoolA=new SpoolWriter(db,root);const spoolB=new SpoolWriter(db,root);
  let releaseSpawn!:()=>void;const gate=new Promise<void>((resolve)=>{releaseSpawn=resolve;});
  const runnerExecA=async()=>{await gate;return{ok:true};};
  const orchA=new Orchestrator(db,spoolA,2,join(root,"ledger.db"),okExec,runnerExecA,join(root,"worktrees"),join(root,"artifacts"));
  const orchB=new Orchestrator(db,spoolB,2,join(root,"ledger.db"),okExec,async()=>({ok:true}),join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  claim(db,orchA.owner,4,0);
  db.run("UPDATE tasks SET lease_expires_at=? WHERE task_id=?",[-1,task.task_id]); // A's lease is already expired
  const tickA=orchA.tick(1); // hangs inside spawnRunner
  await orchB.tick(2); // B sees the expired lease, takes over via renewLeases
  releaseSpawn();
  await tickA; // A's post-await spawn_ok must now lose its CAS
  const after=getTask(db,task.task_id)!;
  expect(after.state).toBe("starting");
  expect(after.owner_instance).toBe(orchB.owner);
  expect(after.runner_pid).toBeNull();
  const fenceLost=db.query("SELECT detail FROM task_events WHERE task_id=? AND event='fence_lost' ORDER BY id DESC LIMIT 1").get(task.task_id) as {detail:string}|null;
  expect(fenceLost).not.toBeNull();
  expect(fenceLost!.detail).toContain("spawn_ok");
  expect(db.query("SELECT 1 FROM task_events WHERE task_id=? AND event='tick_error'").get(task.task_id)).toBeNull();
  spoolA.close();spoolB.close();db.close();
});

test("§7-6 an external instance's tick never touches this instance's task",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon6-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const calls:number[]=[];const runnerExec=async()=>{calls.push(1);return{ok:true};};
  const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),okExec,runnerExec,join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  db.run("UPDATE tasks SET state='running',owner_instance='other',lease_expires_at=? WHERE task_id=?",[60_000,task.task_id]);
  const before=getTask(db,task.task_id)!;
  await orch.tick(1);
  const untouched=getTask(db,task.task_id)!;
  expect(untouched.owner_instance).toBe(before.owner_instance);expect(untouched.lease_expires_at).toBe(before.lease_expires_at);
  expect(untouched.state).toBe(before.state);expect(untouched.updated_at).toBe(before.updated_at);
  expect(calls).toHaveLength(0);
  db.run("UPDATE tasks SET lease_expires_at=? WHERE task_id=?",[-1,task.task_id]);
  await orch.tick(2);
  expect(getTask(db,task.task_id)!.owner_instance).toBe(orch.owner);
  spool.close();db.close();
});

test("§7-7 a pid recycled by an unrelated process is judged dead, not stuck",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon7-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),okExec,async()=>({ok:true}),join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  claim(db,orch.owner,4,0);
  const originalAttempt=getTask(db,task.task_id)!.attempt_id!;
  db.run("UPDATE tasks SET state='running',worktree=?,runner_pid=?,runner_boot_id='boot-old' WHERE task_id=?",[join(root,"wt"),process.pid,task.task_id]);
  setRecovery(db,task.task_id,originalAttempt,"spawned",0);
  const ledger=await openLedger(join(root,"ledger.db"));
  seedLedgerSession(ledger,"local:pi:recycled",taskOrigin(task.task_id,originalAttempt),{pid:process.pid,bootId:"boot-new"});
  ledger.close();
  await orch.tick(1);
  const after=getTask(db,task.task_id)!;
  const event=db.query("SELECT event FROM task_events WHERE task_id=? ORDER BY id DESC LIMIT 1").get(task.task_id) as {event:string};
  expect(event.event).toBe("runner_dead");
  expect(after.state).toBe("starting");expect(after.retry_budget).toBe(1);
  expect(after.runner_pid).toBeNull();expect(after.stable_id).toBeNull();
  expect(after.attempt_id).not.toBe(originalAttempt);
  expect(db.query("SELECT 1 FROM task_recovery WHERE task_id=?").get(task.task_id)).toBeNull();
  spool.close();db.close();
});

test("§7-8 liveness_unknown's bound survives an orchestrator restart",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon8-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const missingLedger=join(root,"missing-ledger.db");
  const db=openStore(join(root,"db"));let spool=new SpoolWriter(db,root);
  let orch=new Orchestrator(db,spool,2,missingLedger,okExec,async()=>({ok:true}),join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  claim(db,orch.owner,4,0);
  const attempt=getTask(db,task.task_id)!.attempt_id!;
  db.run("UPDATE tasks SET state='running',worktree=?,runner_pid=?,runner_boot_id='boot-x' WHERE task_id=?",[join(root,"wt"),process.pid,task.task_id]);
  setRecovery(db,task.task_id,attempt,"spawned",0);
  for(let i=1;i<=6;i++)await orch.tick(i);
  let recovery=db.query("SELECT unknown_ticks FROM task_recovery WHERE task_id=?").get(task.task_id) as {unknown_ticks:number};
  expect(recovery.unknown_ticks).toBe(6);
  spool.close();
  db.run("UPDATE tasks SET lease_expires_at=? WHERE task_id=?",[-1,task.task_id]); // simulate a restart: expire the old lease
  spool=new SpoolWriter(db,root);
  orch=new Orchestrator(db,spool,2,missingLedger,okExec,async()=>({ok:true}),join(root,"worktrees"),join(root,"artifacts"));
  for(let i=7;i<=12;i++)await orch.tick(i);
  const after=getTask(db,task.task_id)!;
  expect(after.state).toBe("blocked");expect(after.blocked_reason).toBe("liveness_unknown");expect(after.retry_budget).toBe(2);
  spool.close();db.close();
});

test("§7-9 budget exhaustion lands on blocked, not failed, and doesn't loop",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon9-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),okExec,async()=>({ok:true}),join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  claim(db,orch.owner,4,0);
  const attempt=getTask(db,task.task_id)!.attempt_id!;
  db.run("UPDATE tasks SET state='running',worktree=?,runner_pid=?,runner_boot_id='boot-old',retry_budget=0 WHERE task_id=?",[join(root,"wt"),process.pid,task.task_id]);
  setRecovery(db,task.task_id,attempt,"spawned",0);
  const ledger=await openLedger(join(root,"ledger.db"));
  seedLedgerSession(ledger,"local:pi:x",taskOrigin(task.task_id,attempt),{pid:process.pid,bootId:"boot-new"});
  ledger.close();
  await orch.tick(1);
  let after=getTask(db,task.task_id)!;
  expect(after.state).toBe("blocked");expect(after.blocked_reason).toBe("runner_crash");expect(after.terminal_reason).toBeNull();
  await orch.tick(2);
  after=getTask(db,task.task_id)!;expect(after.state).toBe("blocked");
  const runnerDeadCount=(db.query("SELECT count(*) n FROM task_events WHERE task_id=? AND event='runner_dead'").get(task.task_id) as {n:number}).n;
  expect(runnerDeadCount).toBe(1);
  spool.close();db.close();
});

test("§7-10 a starting task with no attempt_id gets blocked, not silently stuck",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon10-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const orch=new Orchestrator(db,spool,2,join(root,"ledger.db"),okExec,async()=>({ok:true}),join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  db.run("UPDATE tasks SET state='starting' WHERE task_id=?",[task.task_id]);
  await orch.tick(1);
  const after=getTask(db,task.task_id)!;
  expect(after.state).toBe("blocked");expect(after.blocked_reason).toBe("no_attempt");
  spool.close();db.close();
});

test("§7-11 a legacy pre-upgrade row with a pid but no recovery row never gets re-spawned",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-recon11-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"db"));const spool=new SpoolWriter(db,root);
  const calls:number[]=[];const runnerExec=async()=>{calls.push(1);return{ok:true};};
  const orch=new Orchestrator(db,spool,2,join(root,"missing-ledger.db"),okExec,runnerExec,join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"t","/repo",BASE_REF,0);
  claim(db,orch.owner,4,0);
  db.run("UPDATE tasks SET runner_pid=? WHERE task_id=?",[process.pid,task.task_id]);
  await orch.tick(1);
  expect(calls).toHaveLength(0);
  expect(db.query("SELECT state FROM tasks WHERE task_id=?").get(task.task_id)).toEqual({state:"starting"});
  spool.close();db.close();
});

test("§3.6 tick collects abandoned worktrees on its own, throttled, and records each deletion",async()=>{
  const root=mkdtempSync(join(tmpdir(),"orch-gc-"));dirs.push(root);writeFileSync(join(root,"host"),"local\n");
  const db=openStore(join(root,"orchestrator.db"));const spool=new SpoolWriter(db,root);
  const removed:string[][]=[];
  const worktreeExec=async(_cmd:string,args:string[])=>{
    if(args[2]==="worktree"&&args[3]==="remove"){removed.push(args);return{ok:true,stdout:"",stderr:""};}
    return{ok:true,stdout:"",stderr:""}; // `status --porcelain` clean
  };
  const orch=new Orchestrator(db,spool,1,join(root,"ledger.db"),worktreeExec,async()=>({ok:true}),join(root,"worktrees"),join(root,"artifacts"));
  const task=addTask(db,"finished","/repo",BASE_REF,1);
  const now=10*60*60*1000;
  db.run("UPDATE tasks SET state='done',worktree=?,updated_at=? WHERE task_id=?",["/wt/done",now-3*60*60*1000,task.task_id]);
  await orch.tick(now);
  expect(removed).toHaveLength(1);
  expect(db.query("SELECT COUNT(*) AS n FROM task_events WHERE task_id=? AND event='worktree_gc'").get(task.task_id)).toEqual({n:1});
  // Throttled: the next tick a second later must not re-scan every terminal task.
  await orch.tick(now+1000);
  expect(removed).toHaveLength(1);
  spool.close();db.close();
});
