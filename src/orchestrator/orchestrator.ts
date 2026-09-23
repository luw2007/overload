#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTask, claim, listTasks, openStore, renewLeases, transition, getRecovery, setRecovery, bumpUnknown, resetUnknown, type Task, type TransitionDetail } from "./store";
import { getWork, publishControlEvents } from "../control/store";
import { SpoolWriter } from "./spool";
import { ensureWorktree, worktreesRoot, gcCandidates, defaultCommandExecutor, defaultPidAlive, type CommandExecutor } from "./worktree";
import { spawnRunner, bindRunnerSession, probeRunnerLiveness, defaultRunnerExecutor, type RunnerExecutor } from "./runner";
import { collectEvidence, evidenceReady } from "./evidence";
import { submitTask } from "./submit";
import { checkPr } from "./pr";
import { consumeAnswers, expireApprovals, openAnswersDb, requestApproval, repairApprovalIntents, reconcileApprovalEffects } from "./approval";
import { buildAgentTaskContext } from "./agent-task-context";
import { collectAndSpool, spoolContextEnvelope } from "./context-collector";
import { determineRecoveryOutcome } from "./recovery-context";
import type { Database } from "bun:sqlite";

const BIND_TIMEOUT_TICKS = 12; // ~60s at the 5s tick interval, plan §3.3 bind_timeout.

export class Orchestrator {
  readonly owner=randomUUID(); private started=new Set<string>(); private bindAttempts=new Map<string,number>(); private lastCiCheck=new Map<string,number>(); private reconciled=new Set<string>(); private inFlight=false; private lastGc=0;
  private static readonly CI_CHECK_INTERVAL=5*60*1000; // 5 minutes
  private static readonly GC_INTERVAL=5*60*1000; // §3.6: sweep worktrees at most this often, not on every 5s tick.
  private static readonly GC_MIN_AGE=60*60*1000; // Leave a finished worktree alone for an hour so a human can still look.
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
  private controlValid(task:Task):boolean{
    if(!task.work_id)return true;
    const control=openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH);
    try { const work=getWork(control,task.work_id);return work?.state==="active"&&work.revision===task.contract_revision; }
    finally { control.close(); }
  }
  private superseded(task:Task,now:number):boolean{
    try { if(this.controlValid(task))return false; } catch {
      this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,now,task.state,task.state,"contract_authority_unreadable",JSON.stringify({work_id:task.work_id})]);
      return true;
    }
    // A revised contract never grants a new controlled action. Do not mark a
    // live process terminal: occupancy remains until its authoritative runner
    // session ends, then normal evidence/recovery paths surface the outcome.
    const liveness=task.attempt_id?probeRunnerLiveness(this.ledgerPath,task.task_id,task.attempt_id):{kind:"absent" as const};
    if((task.runner_pid!=null&&defaultPidAlive(task.runner_pid))||liveness.kind==="unreadable"||(liveness.kind==="found"&&!liveness.ended)){
      // Unknown liveness is an occupancy gate, not proof of death. A human must
      // confirm stop or explicitly keep the repo held; the partial index keeps
      // the repo lock while this row remains active.
      this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,now,task.state,task.state,"contract_superseded_occupancy_held",JSON.stringify({work_id:task.work_id,contract_revision:task.contract_revision,liveness:liveness.kind})]);
      return true;
    }
    // No ledger record is unknown unless this task never acquired an attempt.
    if(task.attempt_id){this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,now,task.state,task.state,"contract_superseded_occupancy_held",JSON.stringify({work_id:task.work_id,liveness:"absent"})]);return true;}
    this.casTransition(task.task_id,"human_abandon",{reason:"contract_revision_invalidated",work_id:task.work_id,contract_revision:task.contract_revision},now);
    return true;
  }
  private deadlineExceeded(task:Task,now:number):boolean{return task.budget_deadline_at!=null&&now>=task.budget_deadline_at;}
  private budgetBlocked(task:Task,now:number):boolean{
    if(!this.deadlineExceeded(task,now))return false;
    this.casTransition(task.task_id,"human_abandon",{reason:"managed_budget_deadline_exceeded",deadline_at:task.budget_deadline_at},now);
    return true;
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
        if(["queued","starting","running","awaiting_human","submitted"].includes(task.state)&&this.superseded(task,now))continue;
        if(["queued","starting","running"].includes(task.state)&&this.budgetBlocked(task,now))continue;
        try {
          if(task.state==="starting") await this.startRunner(task);
          else if(task.state==="running") await this.pollRunning(task,now);
          else if(task.state==="submitted") await this.pollSubmitted(task,now);
          else if(["done","failed","abandoned","awaiting_human","blocked"].includes(task.state)) this.attemptRecovery(task.task_id);
        } catch(error) {
          const state=getTask(this.db,task.task_id)?.state??task.state;
          this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,now,state,state,"tick_error",JSON.stringify({error:error instanceof Error?error.message:String(error)})]);
        }
      }
      try {
        const answers=openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH);try{
          repairApprovalIntents(this.db,answers,now);consumeAnswers(this.db,answers,this.spool,now);expireApprovals(this.db,this.spool,now,answers);reconcileApprovalEffects(this.db,answers,now);
          publishControlEvents(answers,this.ledgerPath,detail=>this.spool.emit("control", "control_event", detail),now);
          this.collectContextFacts();
        }finally{answers.close();}
        renewLeases(this.db,this.owner,now);
        await this.collectWorktrees(now);
      } catch(error) { console.error(error); }
      return claimed.map(t=>getTask(this.db,t.task_id)!);
    } finally { this.inFlight=false; }
  }
  /**
   * §3.6: the module that creates worktrees is the one that cleans them, so GC lives and dies with
   * the orchestrator rather than in the default-installed maintenance job. gcCandidates only ever
   * removes clean, terminal, unheld worktrees; dirty ones stay on disk and are left for a human.
   */
  private async collectWorktrees(now:number):Promise<void> {
    if(now-this.lastGc<Orchestrator.GC_INTERVAL)return;
    this.lastGc=now;
    const results=await gcCandidates(this.db,false,this.worktreesDir,this.worktreeExec,defaultPidAlive,{minAgeMs:Orchestrator.GC_MIN_AGE,now});
    for(const result of results){
      if(!result.deleted)continue; // A blocked sweep repeats every interval; recording it would be recurring noise, not news.
      const state=getTask(this.db,result.task_id)?.state??"done";
      this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[result.task_id,now,state,state,"worktree_gc",JSON.stringify({worktree:"removed"})]);
    }
  }
  // §3.6/§3.7: ensureWorktree -> spawnRunner -> transition. worktree_ok/spawn_ok both land on "running"
  // (store.ts's rules), matching the plan's combined "worktree_ok ∧ spawn_ok -> running" row.
  private async startRunner(task:Task):Promise<void> {
    if(this.budgetBlocked(task,Date.now()))return;
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
    // T6: assemble agent task context package; inject hard constraints into system prompt.
    // If blocked(needs_context), record event and wait — do not spawn with placeholder context.
    let promptText=task.title;
    if(task.work_id){
      let control:Database|null=null;
      try{
        control=openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH);
        const ctxResult=buildAgentTaskContext({db:control,orchestratorDb:this.db,work_id:task.work_id,task_id:task.task_id,actor:"orchestrator",scope_filter:{repo:task.repo}});
        if(!ctxResult.ok){
          if(ctxResult.code==="forbidden"){this.casTransition(task.task_id,"spawn_fail",{reason:"context_forbidden",detail:ctxResult.reason},Date.now());return;}
          // 显式兼容模式：开关关闭 → 走 base prompt 旧路径，不中断 spawn。
          if(ctxResult.code==="disabled"){promptText=task.title;}
          else{
            const reason=ctxResult.reason, code=ctxResult.code;
            this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,Date.now(),task.state,task.state,"context_pending",JSON.stringify({reason,code})]);
            let owner:string|null=null;
            try{const wrow=control.query("SELECT contract FROM control_works WHERE work_id=?").get(task.work_id) as {contract:string|null}|null;if(wrow?.contract){try{const c=JSON.parse(wrow.contract) as {decision_owner?:string};owner=typeof c.decision_owner==="string"&&c.decision_owner?c.decision_owner:null;}catch{}}}catch{}
            this.emitContextSpool("context.pending",{work_id:task.work_id,task_id:task.task_id,reason,required_context:code,owner:owner??"unknown",deep_link:this.deepLink(task.work_id,task.task_id)});
            return;
          }
        }else{
          promptText=ctxResult.system_prompt_injection+"\n\n"+task.title;
        }
      }catch(error){
        // 必需上下文不可读不得静默回退：记录 context_pending，等下一 tick 重试，不 spawn。
        const reason=error instanceof Error?error.message:String(error);
        this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,Date.now(),task.state,task.state,"context_pending",JSON.stringify({reason,code:"exception"})]);
        const owner=this.readDecisionOwner(task.work_id);
        this.emitContextSpool("context.pending",{work_id:task.work_id,task_id:task.task_id,reason,required_context:"exception",owner:owner??"unknown",deep_link:this.deepLink(task.work_id,task.task_id)});
        return;
      }
      finally{control?.close();}
    }
    setRecovery(this.db,task.task_id,attemptId,"intent");
    const spawned=await spawnRunner(task,dir,attemptId,promptText,this.runnerExec,this.artifactsDir);setRecovery(this.db,task.task_id,attemptId,spawned.ok?"spawned":"failed");
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
    if(pr.status==="merged"){
      this.casTransition(task.task_id,"ci_merged",{},now);
      this.lastCiCheck.delete(task.task_id);
    } else if(pr.status==="anomaly"){
      const existing=this.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='ci_anomaly' AND consumed_at IS NULL").get(task.task_id);
      if(!existing)requestApproval(this.db,this.spool,task.task_id,"ci_anomaly",pr.detail??"CI anomaly detected",["recheck","manual-followup","abandon"]);
      this.casTransition(task.task_id,"ci_anomaly",{reason:pr.detail},now);
      this.lastCiCheck.delete(task.task_id);
    } else if(pr.status==="observation_failed"){
      const failures=task.ci_observation_failures+1;
      this.db.run("UPDATE tasks SET ci_observation_failures=?,updated_at=? WHERE task_id=?",[failures,now,task.task_id]);
      this.db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[task.task_id,now,task.state,task.state,"ci_observation_failed",JSON.stringify({failures,reason:pr.detail})]);
      // One transient retry is silent; persistent inability to observe is a
      // bounded human escalation on the original item, never false clean.
      if(failures>=2){
        const existing=this.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='ci_anomaly' AND consumed_at IS NULL").get(task.task_id);
        if(!existing)requestApproval(this.db,this.spool,task.task_id,"ci_anomaly","Unable to confirm PR/CI state",["recheck","manual-followup","abandon"]);
        this.casTransition(task.task_id,"ci_anomaly",{reason:"ci_observation_failed",detail:pr.detail},now);
        this.lastCiCheck.delete(task.task_id);
      }
    } else {
      this.db.run("UPDATE tasks SET ci_observation_failures=0,updated_at=? WHERE task_id=?",[now,task.task_id]);
    }
  }
  /**
   * T2b/T10: 采集所有 active work 的 context facts 并写入 spool。
   * collector 只写 NDJSON 文件；web server 的 ingest loop 读文件投影到 control DB。
   * 本方法不直写 control DB（架构红线）。
   */
  private collectContextFacts(): void {
    try {
      const rows = this.db.query(
        "SELECT DISTINCT work_id FROM tasks WHERE work_id IS NOT NULL"
      ).all() as { work_id: string }[];
      for (const row of rows) {
        collectAndSpool(
          { orchestratorDb: this.db, work_id: row.work_id, actor: "orchestrator", runtime_id: this.owner },
          this.spool.dir,
        );
      }
    } catch (error) {
      console.error("context collect failed:", error);
    }
  }

  /**
   * Fix 5: 读 control_works.contract.decision_owner（只读 control DB）。
   * orchestrator 红线：不写 control DB，只读 contract。读失败返回 null（调用方 fail-closed 处理）。
   */
  private readDecisionOwner(workId: string): string | null {
    let control: Database | null = null;
    try {
      control = openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH);
      const row = control.query("SELECT contract FROM control_works WHERE work_id=?").get(workId) as { contract: string | null } | null;
      if (!row?.contract) return null;
      try {
        const c = JSON.parse(row.contract) as { decision_owner?: string };
        return typeof c.decision_owner === "string" && c.decision_owner ? c.decision_owner : null;
      } catch { return null; }
    } catch {
      return null;
    } finally {
      control?.close();
    }
  }

  private deepLink(workId: string, taskId: string): string {
    return `cmux://work/${workId}/task/${taskId}`;
  }

  /**
   * Fix 5: 把 context.pending / recovery_* 事件写入 collector 同款 spool。
   * 与 fact_observed 共用 seg 文件机制（spoolContextEnvelope 分配全局序号 + 原子 rename）。
   * ingest 侧按 kind 分发。写 spool 失败不阻断主流程（task_events 已落库），但记录错误事件。
   */
  private emitContextSpool(kind: string, detail: Record<string, unknown>): void {
    try {
      spoolContextEnvelope(this.db, this.spool.dir, kind, detail, Date.now());
    } catch (error) {
      console.error(`context spool ${kind} failed:`, error);
    }
  }

  /**
   * T7: 对单个 task 尝试恢复决策。调用 determineRecoveryOutcome，将结果记录为 task_events。
   * 不自动 spawn——恢复包/跳转/对账结果供人或上层决策。
   * 幂等：已记录过 recovery_* 事件的 task 跳过。
   *
   * Fix 2: liveness 必须证据驱动。删除"有未消费 approval → 直接 jump"的短路。
   * awaiting_human 不再自己判 jump，统一交给 determineRecoveryOutcome，由它依据
   * task.state + pid/stable_id + task_events 的 runner_exit|runner_dead 判定：
   *   live（进程在跑 + 有未消费 approval）→ recovery_jump
   *   terminated（有 runner_exit/runner_dead）→ checkpoint 恢复评估（不 jump）
   *   unknown（无 pid 无终止事件）→ recovery_reconcile
   *
   * Fix 5: recovery_jump / recovery_package / recovery_reconcile 同时写入 collector spool，
   * Core/Surface 可见。
   */
  attemptRecovery(taskId: string): void {
    const task = getTask(this.db, taskId);
    if (!task || !task.work_id || !task.attempt_id) return;
    // 幂等：已处理过 recovery_* 事件的 task 跳过。
    const done = this.db.query(
      "SELECT 1 FROM task_events WHERE task_id=? AND event IN ('recovery_package_ready','recovery_jump','recovery_reconcile','recovery_blocked') LIMIT 1"
    ).get(taskId);
    if (done) return;

    // done 正常完成：不产恢复噪声。
    if (task.state === "done") return;

    // terminated 判定必须基于事件证据：runner_exit 或 runner_dead。
    const hasExitEvent = !!this.db.query(
      "SELECT 1 FROM task_events WHERE task_id=? AND event IN ('runner_exit','runner_dead') LIMIT 1"
    ).get(taskId);

    // failed/abandoned：必须有 runner_exit/runner_dead 事件才评估恢复包。
    // 仅凭 state 字符串不足以证明 runner 已终止（可能是编排错误标记的终态）。
    if ((task.state === "failed" || task.state === "abandoned") && !hasExitEvent) return;

    // awaiting_human / running / blocked / submitted：统一交给 determineRecoveryOutcome
    // 做证据驱动的 runtime state 判定（live/terminated/unknown），不再短路 jump。
    let control: Database | null = null;
    try {
      control = openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH);
      // actor 必须是 work contract 的 decision_owner（assembleRecovery 入口校验）。
      let actor = "orchestrator";
      let owner = "unknown";
      const workRow = control.query("SELECT contract FROM control_works WHERE work_id=?").get(task.work_id) as { contract: string | null } | null;
      if (workRow?.contract) {
        try {
          const c = JSON.parse(workRow.contract) as { decision_owner?: string };
          if (typeof c.decision_owner === "string" && c.decision_owner) { actor = c.decision_owner; owner = c.decision_owner; }
        } catch { /* fall through */ }
      }
      const outcome = determineRecoveryOutcome({
        controlDb: control,
        orchestratorDb: this.db,
        work_id: task.work_id,
        task_id: task.task_id,
        attempt_id: task.attempt_id,
        actor,
      });
      const evNow = Date.now();
      const deepLink = this.deepLink(task.work_id, task.task_id);
      if (outcome.type === "recovery_package") {
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [taskId, evNow, task.state, task.state, "recovery_package_ready", JSON.stringify({
            checkpoint_reference: outcome.package.checkpoint_reference,
            session_reference: outcome.package.session_reference,
            recommended_action: outcome.package.recommended_action,
          })]
        );
        // Fix 5: spool 给 Core/Surface。
        this.emitContextSpool("context.recovery_package", {
          work_id: task.work_id,
          task_id: task.task_id,
          checkpoint_reference: outcome.package.checkpoint_reference,
          incomplete_steps: outcome.package.incomplete_steps,
          owner,
          deep_link: deepLink,
        });
      } else if (outcome.type === "jump") {
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [taskId, evNow, task.state, task.state, "recovery_jump", JSON.stringify({
            reason: outcome.reason,
            jump_target: outcome.jump_target,
          })]
        );
        this.emitContextSpool("context.recovery_jump", {
          work_id: task.work_id,
          task_id: task.task_id,
          jump_target: outcome.jump_target,
          owner,
          deep_link: deepLink,
        });
      } else if (outcome.type === "reconcile") {
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [taskId, evNow, task.state, task.state, "recovery_reconcile", JSON.stringify({ reason: outcome.reason })]
        );
        this.emitContextSpool("context.recovery_reconcile", {
          work_id: task.work_id,
          task_id: task.task_id,
          reason: outcome.reason,
          owner,
          deep_link: deepLink,
        });
      } else {
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [taskId, evNow, task.state, task.state, "recovery_blocked", JSON.stringify({ reason: outcome.reason, code: outcome.code })]
        );
      }
    } catch (error) {
      this.db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [taskId, Date.now(), task.state, task.state, "recovery_error", JSON.stringify({ error: error instanceof Error ? error.message : String(error) })]
      );
    } finally {
      control?.close();
    }
  }

}
export async function main(argv=Bun.argv.slice(2)):Promise<void>{const i=argv.indexOf("--concurrency");const concurrency=i<0?2:Number(argv[i+1]);const db=openStore();const spool=new SpoolWriter(db);const orch=new Orchestrator(db,spool,concurrency);const stop=()=>{spool.close();db.close();process.exit(0)};process.on("SIGINT",stop);process.on("SIGTERM",stop);await orch.tick();setInterval(()=>orch.tick(),5000);}
if(import.meta.main)await main();
