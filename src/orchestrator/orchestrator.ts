#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTask, claim, listTasks, openStore, renewLeases, transition, type Task } from "./store";
import { SpoolWriter } from "./spool";
import { ensureWorktree, worktreesRoot, defaultCommandExecutor, defaultPidAlive, type CommandExecutor } from "./worktree";
import { spawnRunner, bindRunnerSession, defaultRunnerExecutor, type RunnerExecutor } from "./runner";
import { collectEvidence, evidenceReady } from "./evidence";
import { submitTask } from "./submit";
import { checkPr } from "./pr";
import { consumeAnswers, expireApprovals, openAnswersDb, requestApproval } from "./approval";
import type { Database } from "bun:sqlite";

const BIND_TIMEOUT_TICKS = 12; // ~60s at the 5s tick interval, plan §3.3 bind_timeout.

export class Orchestrator {
  readonly owner=randomUUID(); private started=new Set<string>(); private bindAttempts=new Map<string,number>(); private lastCiCheck=new Map<string,number>(); private inFlight=false;
  private static readonly CI_CHECK_INTERVAL=5*60*1000; // 5 minutes
  constructor(readonly db:Database,readonly spool:SpoolWriter,readonly concurrency=2,
    readonly ledgerPath=process.env.OVERLOAD_LEDGER_PATH??join(homedir(),".overload","ledger.db"),
    readonly worktreeExec:CommandExecutor=defaultCommandExecutor,readonly runnerExec:RunnerExecutor=defaultRunnerExecutor,
    readonly worktreesDir=worktreesRoot(),readonly artifactsDir=join(homedir(),".overload","artifacts")) {
    if(concurrency<1||concurrency>4)throw new Error("concurrency must be between 1 and 4");
  }
  reconcile(now=Date.now()):void {
    for(const task of listTasks(this.db).filter(t=>t.state==="starting"||t.state==="running")) {
      if(task.state==="starting"&&task.runner_pid==null)continue; // M2: restart idempotent spawn via cmux, see plan §3.5/§3.7.
      // M2: validate pid + ledger incarnation and apply runner_dead.
    }
    renewLeases(this.db,this.owner,now);
  }
  async tick(now=Date.now()):Promise<Task[]> {
    if(this.inFlight)return [];
    this.inFlight=true;
    try {
      this.reconcile(now); const claimed=claim(this.db,this.owner,this.concurrency,now);
      for(const task of claimed){this.spool.emit(task.task_id,"session_started",{parent:"orchestrator",cwd:task.repo,branch:task.branch,lease:{pid:process.pid,proc_boot_id:this.owner}});this.started.add(task.task_id);}
      for(const task of listTasks(this.db)) {
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
    const attemptId=task.attempt_id; if(!attemptId)return; // claim() always sets attempt_id before "starting"; nothing to do without it.
    const branch=task.branch??`overload/task-${task.task_id}`;
    let dir:string;
    try { ({dir}=await ensureWorktree(task.repo,task.task_id,branch,task.base_ref,this.worktreesDir,this.worktreeExec)); }
    catch(error){ transition(this.db,task.task_id,"worktree_fail",{reason:"repo_gone",detail:String((error as Error).message??error)}); return; }
    const spawned=await spawnRunner(task,dir,attemptId,task.title,this.runnerExec,this.artifactsDir);
    if(!spawned.ok){ transition(this.db,task.task_id,"spawn_fail",{worktree:dir,branch,reason:"tool_missing",detail:spawned.error}); return; }
    transition(this.db,task.task_id,"spawn_ok",{worktree:dir,branch});
    this.bindAttempts.set(task.task_id,0);
  }
  private async pollRunning(task:Task,now:number):Promise<void> {
    if(task.runner_pid==null){await this.pollBinding(task);return;}
    if(defaultPidAlive(task.runner_pid)||!task.worktree)return;
    try { const evidence=await collectEvidence(task.worktree,task.task_id,task.base_ref,this.worktreeExec,this.artifactsDir),ready=evidenceReady(evidence);
      if(ready.ready){transition(this.db,task.task_id,"runner_exit",{evidence_complete:true},now);requestApproval(this.db,this.spool,task.task_id,"ready","Approve these verified changes?",["approve","reject","abandon"]);}
      else transition(this.db,task.task_id,"runner_exit",{evidence_complete:false,reason:ready.reason},now);
    } catch(error) { transition(this.db,task.task_id,"runner_exit",{evidence_complete:false,reason:"evidence_collection_failed",error:String((error as Error).message??error)},now); }
  }
  // §3.7 会话绑定: poll ledger.db (readonly) each tick until bound, or give up after BIND_TIMEOUT_TICKS.
  private async pollBinding(task:Task):Promise<void> {
    if(task.stable_id||!task.attempt_id)return;
    const bound=bindRunnerSession(this.ledgerPath,task,task.attempt_id);
    if(bound){ transition(this.db,task.task_id,"session_bound",{stable_id:bound.stable_id,runner_pid:bound.pid,runner_boot_id:bound.boot_id}); this.bindAttempts.delete(task.task_id); return; }
    const attempts=(this.bindAttempts.get(task.task_id)??0)+1; this.bindAttempts.set(task.task_id,attempts);
    if(attempts>=BIND_TIMEOUT_TICKS){ transition(this.db,task.task_id,"bind_timeout",{blocked:task.retry_budget<=0}); this.bindAttempts.delete(task.task_id); }
  }
  // §3.8 submitted: push/PR then CI polling (5-min cadence via in-memory Map).
  private async pollSubmitted(task:Task,now:number):Promise<void> {
    // Step 1: if pr_url not yet set, run the submit pipeline.
    if(!task.pr_url) {
      if(!task.worktree||!task.branch) return;
      const result=await submitTask(task,task.worktree,join(this.artifactsDir,task.task_id),this.worktreeExec);
      if(result.ok){ transition(this.db,task.task_id,"push_pr_ok",{pr_url:result.prUrl},now); }
      else { transition(this.db,task.task_id,result.reason==="tool_missing"?"tool_missing":"push_fail",{reason:result.reason},now); }
      return;
    }
    // Step 2: CI recon — only every 5 minutes per task.
    const lastCheck=this.lastCiCheck.get(task.task_id)??0;
    if(now-lastCheck<Orchestrator.CI_CHECK_INTERVAL) return;
    this.lastCiCheck.set(task.task_id,now);
    const pr=await checkPr(task.pr_url,this.worktreeExec);
    if(pr.status==="merged"){ transition(this.db,task.task_id,"ci_merged",{},now); this.lastCiCheck.delete(task.task_id); }
    else if(pr.status==="anomaly"){
      // Dedup: only request approval if no unconsumed ci_anomaly approval exists.
      const existing=this.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='ci_anomaly' AND consumed_at IS NULL").get(task.task_id);
      if(!existing){ requestApproval(this.db,this.spool,task.task_id,"ci_anomaly",pr.detail??"CI anomaly detected",["rerun","new-task","abandon"]); }
      transition(this.db,task.task_id,"ci_anomaly",{reason:pr.detail},now); this.lastCiCheck.delete(task.task_id);
    }
    // "clean" -> no action, wait for next poll.
  }
}
export async function main(argv=Bun.argv.slice(2)):Promise<void>{const i=argv.indexOf("--concurrency");const concurrency=i<0?2:Number(argv[i+1]);const db=openStore();const spool=new SpoolWriter(db);const orch=new Orchestrator(db,spool,concurrency);const stop=()=>{spool.close();db.close();process.exit(0)};process.on("SIGINT",stop);process.on("SIGTERM",stop);await orch.tick();setInterval(()=>orch.tick(),5000);}
if(import.meta.main)await main();
