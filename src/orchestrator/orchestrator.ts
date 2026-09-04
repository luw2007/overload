#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTask, claim, listTasks, openStore, renewLeases, transition, getRecovery, setRecovery, bumpUnknown, resetUnknown, type Task, type TransitionDetail } from "./store";
import { SpoolWriter } from "./spool";
import { ensureWorktree, worktreesRoot, defaultCommandExecutor, defaultPidAlive, type CommandExecutor } from "./worktree";
import { spawnRunner, bindRunnerSession, probeRunnerLiveness, defaultRunnerExecutor, type RunnerExecutor } from "./runner";
import { collectEvidence, evidenceReady } from "./evidence";
import { submitTask } from "./submit";
import { checkPr } from "./pr";
import { consumeAnswers, expireApprovals, openAnswersDb, requestApproval } from "./approval";
import type { Database } from "bun:sqlite";

const BIND_TIMEOUT_TICKS = 12; // ~60s at the 5s tick interval, plan §3.3 bind_timeout.

export class Orchestrator {
  readonly owner=randomUUID(); private started=new Set<string>(); private bindAttempts=new Map<string,number>(); private lastCiCheck=new Map<string,number>(); private reconciled=new Set<string>(); private inFlight=false;
  private static readonly CI_CHECK_INTERVAL=5*60*1000; // 5 minutes
  constructor(readonly db:Database,readonly spool:SpoolWriter,readonly concurrency=2,
    readonly ledgerPath=process.env.OVERLOAD_LEDGER_PATH??join(homedir(),".overload","ledger.db"),
    readonly worktreeExec:CommandExecutor=defaultCommandExecutor,readonly runnerExec:RunnerExecutor=defaultRunnerExecutor,
    readonly worktreesDir=worktreesRoot(),readonly artifactsDir=join(homedir(),".overload","artifacts")) {
    if(concurrency<1||concurrency>4)throw new Error("concurrency must be between 1 and 4");
  }
  private mine(t:Task,now:number):boolean{return t.owner_instance==null||t.owner_instance===this.owner||t.lease_expires_at==null||t.lease_expires_at<=now}
  // §1.3: every post-await write from this class is CAS'd against this.owner; a loser leaves a
  // fence_lost audit event and its tasks row untouched, so drop any of our own in-flight memory of it.
  private casTransition(taskId:string,event:string,detail:TransitionDetail,now:number):Task{
    const result=transition(this.db,taskId,event,detail,now,this.owner);
    if(result.owner_instance!==this.owner){this.bindAttempts.delete(taskId);this.lastCiCheck.delete(taskId);this.started.delete(taskId);}
    return result;
  }
  // §2.2/§3.2: unknown_ticks lives in task_recovery so the 12-tick bound survives an orchestrator restart.
  private bumpUnknownAndMaybeBlock(task:Task,now:number,reason:"spawn_unverified"|"liveness_unknown"):void{
    if(!getRecovery(this.db,task.task_id)&&task.attempt_id)setRecovery(this.db,task.task_id,task.attempt_id,"intent",now);
    if(bumpUnknown(this.db,task.task_id)>=BIND_TIMEOUT_TICKS)this.casTransition(task.task_id,reason,{},now);
  }
  private async collectAndResolve(task:Task,now:number):Promise<void>{
    if(!task.worktree)return;
    try {
      const evidence=await collectEvidence(task.worktree,task.task_id,task.base_ref,this.worktreeExec,this.artifactsDir),ready=evidenceReady(evidence);
      if(ready.ready){this.casTransition(task.task_id,"runner_exit",{evidence_complete:true},now);requestApproval(this.db,this.spool,task.task_id,"ready","Approve these verified changes?",["approve","reject","abandon"]);}
      else if(ready.reason==="no_check")this.casTransition(task.task_id,"check_absent",{reason:ready.reason},now);
      else this.casTransition(task.task_id,"runner_exit",{evidence_complete:false,reason:ready.reason},now);
    } catch(error) { this.casTransition(task.task_id,"runner_exit",{evidence_complete:false,reason:"evidence_collection_failed",error:String((error as Error).message??error)},now); }
  }
  // §3.3 rows #1-#6: a "starting" task never seen by pollBinding yet. Anything but a genuinely
  // fresh row (no recovery, no pid, no stable_id) must be probed, never blind-spawned again.
  private async reconcileStarting(task:Task,now:number):Promise<void>{
    const recovery=getRecovery(this.db,task.task_id);
    if(!recovery){ if(task.runner_pid==null&&task.stable_id==null)return; /* row #1: fresh, leave it to startRunner */ }
    else if(recovery.spawn_state==="failed")return; // row #4: startRunner already routes this to spawn_fail
    if(!task.attempt_id)return;
    const p=probeRunnerLiveness(this.ledgerPath,task.task_id,task.attempt_id);
    if(p.kind==="found"&&p.has_incarnation&&p.pid!=null&&p.ended){
      resetUnknown(this.db,task.task_id);
      this.casTransition(task.task_id,"session_bound",{stable_id:p.stable_id,runner_pid:p.pid,runner_boot_id:p.boot_id},now);
      const bound=getTask(this.db,task.task_id); if(bound)await this.collectAndResolve(bound,now);
      return;
    }
    if(p.kind==="found"&&p.has_incarnation&&p.pid!=null&&defaultPidAlive(p.pid)){
      resetUnknown(this.db,task.task_id);
      this.casTransition(task.task_id,"session_bound",{stable_id:p.stable_id,runner_pid:p.pid,runner_boot_id:p.boot_id},now);
      return;
    }
    if(p.kind==="found"&&p.has_incarnation&&p.pid!=null&&!defaultPidAlive(p.pid)){
      resetUnknown(this.db,task.task_id);
      this.casTransition(task.task_id,"runner_dead",{},now);
      return;
    }
    this.bumpUnknownAndMaybeBlock(task,now,"spawn_unverified");
  }
  // §3.3 rows #9/#11/#12/#13: bound tasks whose pid is alive per this process, which pollRunning
  // (defaultPidAlive only) can't tell apart on its own — reconcile owns pid-recycle/exited/unknown here.
  private async reconcileRunning(task:Task,now:number):Promise<void>{
    if(task.runner_pid==null||!defaultPidAlive(task.runner_pid))return; // pollBinding/pollRunning already own these
    if(!task.attempt_id)return;
    const p=probeRunnerLiveness(this.ledgerPath,task.task_id,task.attempt_id);
    if(p.kind==="found"&&p.ended){resetUnknown(this.db,task.task_id);await this.collectAndResolve(task,now);return;}
    if(p.kind==="found"&&p.has_incarnation&&p.pid===task.runner_pid&&p.boot_id===task.runner_boot_id){resetUnknown(this.db,task.task_id);return;}
    if(p.kind==="found"&&p.has_incarnation){resetUnknown(this.db,task.task_id);this.reconciled.add(task.task_id);this.casTransition(task.task_id,"runner_dead",{},now);return;}
    this.bumpUnknownAndMaybeBlock(task,now,"liveness_unknown");
  }
  async reconcile(now=Date.now()):Promise<void>{
    for(const task of listTasks(this.db)){
      if(!this.mine(task,now))continue;
      if(task.state==="starting")await this.reconcileStarting(task,now);
      else if(task.state==="running")await this.reconcileRunning(task,now);
    }
  }
  async tick(now=Date.now()):Promise<Task[]> {
    if(this.inFlight)return [];
    this.inFlight=true;
    try {
      this.reconciled.clear();await this.reconcile(now); const claimed=claim(this.db,this.owner,this.concurrency,now);
      for(const task of claimed){this.spool.emit(task.task_id,"session_started",{parent:"orchestrator",cwd:task.repo,branch:task.branch,lease:{pid:process.pid,proc_boot_id:this.owner}});this.started.add(task.task_id);}
      for(const task of listTasks(this.db)) {
        if(!this.mine(task,now)||this.reconciled.has(task.task_id))continue;
        try {
          if(task.state==="starting") await this.startRunner(task);
          else if(task.state==="running") await this.pollRunning(task,now);
          else if(task.state==="submitted") await this.pollSubmitted(task,now);
        } catch(error) {
          const state=getTask(this.db,task.task_id)?.state??task.state;
          this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,now,state,state,"tick_error",JSON.stringify({error:error instanceof Error?error.message:String(error)})]);
        }
      }
      try {
        const answers=openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH);try{consumeAnswers(this.db,answers,this.spool,now);}finally{answers.close();}
        expireApprovals(this.db,now);
        renewLeases(this.db,this.owner,now);
      } catch(error) { console.error(error); }
      return claimed.map(t=>getTask(this.db,t.task_id)!);
    } finally { this.inFlight=false; }
  }
  // §3.6/§3.7: ensureWorktree -> spawnRunner -> transition. worktree_ok/spawn_ok both land on "running"
  // (store.ts's rules), matching the plan's combined "worktree_ok ∧ spawn_ok -> running" row.
  private async startRunner(task:Task):Promise<void> {
    const attemptId=task.attempt_id; if(!attemptId){this.casTransition(task.task_id,"no_attempt",{reason:"no_attempt"},Date.now());return;} // claim() always sets attempt_id before "starting"; nothing to do without it.
    const recovery=getRecovery(this.db,task.task_id);
    if(recovery){ if(recovery.spawn_state==="failed")this.casTransition(task.task_id,"spawn_fail",{reason:"tool_missing"},Date.now()); return; }
    // §6 legacy migration: a "starting" row with signs of a prior spawn but no task_recovery row (old
    // schema) is treated as "intent" — never blind-spawn, let reconcile probe it via the ledger.
    if(task.runner_pid!=null||task.stable_id!=null)return;
    const branch=task.branch??`overload/task-${task.task_id}`;
    let dir:string;
    try { ({dir}=await ensureWorktree(task.repo,task.task_id,branch,task.base_ref,this.worktreesDir,this.worktreeExec)); }
    catch(error){ this.casTransition(task.task_id,"worktree_fail",{reason:"repo_gone",detail:String((error as Error).message??error)},Date.now()); return; }
    setRecovery(this.db,task.task_id,attemptId,"intent");
    const spawned=await spawnRunner(task,dir,attemptId,task.title,this.runnerExec,this.artifactsDir);setRecovery(this.db,task.task_id,attemptId,spawned.ok?"spawned":"failed");
    if(!spawned.ok){ this.casTransition(task.task_id,"spawn_fail",{worktree:dir,branch,reason:"tool_missing",detail:spawned.error},Date.now()); return; }
    this.casTransition(task.task_id,"spawn_ok",{worktree:dir,branch},Date.now());
    this.bindAttempts.set(task.task_id,0);
  }
  private async pollRunning(task:Task,now:number):Promise<void> {
    if(task.runner_pid==null){await this.pollBinding(task,now);return;}
    if(defaultPidAlive(task.runner_pid))return;
    await this.collectAndResolve(task,now);
  }
  // §3.7 会话绑定: poll ledger.db (readonly) each tick until bound, or give up after BIND_TIMEOUT_TICKS.
  private async pollBinding(task:Task,now:number):Promise<void> {
    if(task.stable_id)return;
    if(!task.attempt_id){this.casTransition(task.task_id,"no_attempt",{reason:"no_attempt"},now);return;}
    const bound=bindRunnerSession(this.ledgerPath,task,task.attempt_id);
    if(bound){ this.casTransition(task.task_id,"session_bound",{stable_id:bound.stable_id,runner_pid:bound.pid,runner_boot_id:bound.boot_id},now); this.bindAttempts.delete(task.task_id); return; }
    const attempts=(this.bindAttempts.get(task.task_id)??0)+1; this.bindAttempts.set(task.task_id,attempts);
    if(attempts>=BIND_TIMEOUT_TICKS){ this.casTransition(task.task_id,"bind_timeout",{blocked:task.retry_budget<=0},now); this.bindAttempts.delete(task.task_id); }
  }
  // §3.8 submitted: push/PR then CI polling (5-min cadence via in-memory Map).
  private async pollSubmitted(task:Task,now:number):Promise<void> {
    // Step 1: if pr_url not yet set, run the submit pipeline.
    if(!task.pr_url) {
      if(!task.worktree||!task.branch) return;
      const result=await submitTask(task,task.worktree,join(this.artifactsDir,task.task_id),this.worktreeExec);
      if(result.ok){ this.casTransition(task.task_id,"push_pr_ok",{pr_url:result.prUrl},now); }
      else { this.casTransition(task.task_id,result.reason==="tool_missing"?"tool_missing":"push_fail",{reason:result.reason},now); }
      return;
    }
    // Step 2: CI recon — only every 5 minutes per task.
    const lastCheck=this.lastCiCheck.get(task.task_id)??0;
    if(now-lastCheck<Orchestrator.CI_CHECK_INTERVAL) return;
    this.lastCiCheck.set(task.task_id,now);
    const pr=await checkPr(task.pr_url,this.worktreeExec);
    if(pr.status==="merged"){ this.casTransition(task.task_id,"ci_merged",{},now); this.lastCiCheck.delete(task.task_id); }
    else if(pr.status==="anomaly"){
      // Dedup: only request approval if no unconsumed ci_anomaly approval exists.
      const existing=this.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='ci_anomaly' AND consumed_at IS NULL").get(task.task_id);
      if(!existing){ requestApproval(this.db,this.spool,task.task_id,"ci_anomaly",pr.detail??"CI anomaly detected",["rerun","new-task","abandon"]); }
      this.casTransition(task.task_id,"ci_anomaly",{reason:pr.detail},now); this.lastCiCheck.delete(task.task_id);
    }
    // "clean" -> no action, wait for next poll.
  }
}
export async function main(argv=Bun.argv.slice(2)):Promise<void>{const i=argv.indexOf("--concurrency");const concurrency=i<0?2:Number(argv[i+1]);const db=openStore();const spool=new SpoolWriter(db);const orch=new Orchestrator(db,spool,concurrency);const stop=()=>{spool.close();db.close();process.exit(0)};process.on("SIGINT",stop);process.on("SIGTERM",stop);await orch.tick();setInterval(()=>orch.tick(),5000);}
if(import.meta.main)await main();
