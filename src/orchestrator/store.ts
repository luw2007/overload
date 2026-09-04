import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
export const STATES = ["queued", "starting", "running", "awaiting_human", "submitted", "blocked", "done", "failed", "abandoned"] as const;
export type TaskState = typeof STATES[number];
export type Task = { task_id:string; title:string; repo:string; base_ref:string; worktree:string|null; branch:string|null; state:TaskState; attempt_id:string|null; owner_instance:string|null; lease_expires_at:number|null; heartbeat_at:number|null; runner_pid:number|null; runner_boot_id:string|null; retry_budget:number; stable_id:string|null; pr_url:string|null; blocked_reason:string|null; terminal_reason:string|null; created_at:number; updated_at:number };
export type TransitionDetail = Record<string, unknown>;
export type Recovery={task_id:string;attempt_id:string;spawn_state:"intent"|"spawned"|"failed";spawn_at:number;unknown_ticks:number};
const rules: Record<TaskState, Record<string, TaskState>> = {
  queued:{claim:"starting",human_abandon:"abandoned"},
  starting:{worktree_ok:"running",spawn_ok:"running",spawn_fail:"blocked",worktree_fail:"failed",bind_timeout:"running",session_bound:"running",runner_dead:"starting",spawn_unverified:"blocked",no_attempt:"blocked",human_abandon:"abandoned"},
  running:{session_bound:"running",bind_timeout:"running",runner_exit:"awaiting_human",runner_dead:"starting",check_absent:"blocked",liveness_unknown:"blocked",no_attempt:"blocked",human_abandon:"abandoned"},
  awaiting_human:{"answer=approve":"submitted","answer=reject":"blocked","answer=abandon":"abandoned",gate_expire:"blocked","answer=rerun":"submitted","answer=new-task":"done",human_abandon:"abandoned"},
  submitted:{push_pr_ok:"submitted",tool_missing:"blocked",push_fail:"blocked",ci_merged:"done",ci_anomaly:"awaiting_human",human_abandon:"abandoned"},
  blocked:{human_reopen:"starting",human_abandon:"abandoned"}, done:{}, failed:{}, abandoned:{}
};

export function openStore(path = process.env.OVERLOAD_ORCHESTRATOR_PATH ?? join(homedir(), ".overload", "orchestrator.db")): Database {
  mkdirSync(dirname(path), { recursive:true, mode:0o700 });
  const db = new Database(path, { create:true }); db.exec(schema); chmodSync(path, 0o600);
  db.run("INSERT OR IGNORE INTO spool_seq(id,seq,segment) VALUES(1,0,0)"); return db;
}
export function addTask(db:Database,title:string,repo:string,baseRef:string,now=Date.now()): Task {
  const id=randomUUID(); db.run("INSERT INTO tasks(task_id,title,repo,base_ref,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",[id,title,repo,baseRef,"queued",now,now]);
  db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event) VALUES(?,?,?,?,?)",[id,now,null,"queued","add"]); return getTask(db,id)!;
}
export function getTask(db:Database,id:string):Task|null { return db.query("SELECT * FROM tasks WHERE task_id=?").get(id) as Task|null; }
export function listTasks(db:Database,state?:TaskState):Task[] { return (state?db.query("SELECT * FROM tasks WHERE state=? ORDER BY created_at,task_id").all(state):db.query("SELECT * FROM tasks ORDER BY created_at,task_id").all()) as Task[]; }
function targetFor(task:Task,event:string,detail:TransitionDetail):TaskState|null {
  // §3.1-2: runner_dead applies the same budget-gated fallback from both starting and running.
  if((task.state==="starting"||task.state==="running")&&event==="runner_dead")return task.retry_budget>0?"starting":"blocked";
  if(task.state==="running"&&event==="runner_exit"){
    if(detail.evidence_complete===false)return task.retry_budget>0?"starting":"blocked";
    return "awaiting_human";
  }
  if((task.state==="starting"||task.state==="running")&&event==="bind_timeout"&&detail.blocked===true)return "blocked";
  return rules[task.state][event]??null;
}
export function transition(db:Database,id:string,event:string,detail:TransitionDetail={},now=Date.now(),expectOwner?:string):Task {
  const task=getTask(db,id); if(!task)throw new Error(`Task not found: ${id}`); const to=targetFor(task,event,detail); if(!to)throw new Error(`Illegal transition: ${task.state} + ${event}`);
  let budget=task.retry_budget; if((event==="runner_dead"||(event==="runner_exit"&&detail.evidence_complete===false)||event==="bind_timeout")&&budget>0)budget--;
  if(event==="human_reopen")budget=2;
  const reasons:Record<string,string>={spawn_fail:"tool_missing",worktree_fail:"repo_gone",check_absent:"no_check","answer=reject":"rejected",gate_expire:"gate_expired",tool_missing:"tool_missing",push_fail:"push_failed",bind_timeout:"bind_timeout",spawn_unverified:"spawn_unverified",liveness_unknown:"liveness_unknown",no_attempt:"no_attempt"};
  let blocked=to==="blocked"?(String(detail.reason??reasons[event]??(event==="runner_dead"?"runner_crash":"evidence_missing"))):null;
  const terminal=(to==="done"||to==="failed"||to==="abandoned")?String(detail.reason??event):null;
  // M2 §3.7: session-binding fields are optionally supplied via detail and persisted verbatim; absent keys keep the existing column value.
  const worktree=typeof detail.worktree==="string"?detail.worktree:task.worktree;
  const branch=typeof detail.branch==="string"?detail.branch:task.branch;
  // §3.1-3: rewinding to "starting" on a real attempt failure rotates attempt_id and clears the pid/binding
  // columns so the next spawn can't be confused with the dead one's ledger origin (plan §0-3/§3.1-3).
  const rotateAttempt=to==="starting"&&(event==="runner_dead"||(event==="runner_exit"&&detail.evidence_complete===false));
  const stableId=rotateAttempt?null:(typeof detail.stable_id==="string"?detail.stable_id:task.stable_id);
  const runnerPid=rotateAttempt?null:(typeof detail.runner_pid==="number"?detail.runner_pid:task.runner_pid);
  const runnerBootId=rotateAttempt?null:(typeof detail.runner_boot_id==="string"?detail.runner_boot_id:task.runner_boot_id);
  const attemptId=rotateAttempt?randomUUID():task.attempt_id;
  const prUrl=typeof detail.pr_url==="string"?detail.pr_url:task.pr_url;
  let applied=false;
  db.transaction(()=>{
    let sql="UPDATE tasks SET state=?,retry_budget=?,blocked_reason=?,terminal_reason=?,worktree=?,branch=?,stable_id=?,runner_pid=?,runner_boot_id=?,pr_url=?,attempt_id=?,updated_at=? WHERE task_id=?";
    const params:unknown[]=[to,budget,blocked,terminal,worktree,branch,stableId,runnerPid,runnerBootId,prUrl,attemptId,now,id];
    if(expectOwner!==undefined){sql+=" AND (owner_instance IS NULL OR owner_instance=?)";params.push(expectOwner);}
    const result=db.run(sql,params);
    applied=result.changes>0;
    if(applied){
      db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[id,now,task.state,to,event,Object.keys(detail).length?JSON.stringify(detail):null]);
      if(rotateAttempt)db.run("DELETE FROM task_recovery WHERE task_id=?",[id]);
    } else {
      // §1.3-4: CAS lost to another owner. Don't touch tasks; leave an audit trail for a human.
      const currentOwner=(db.query("SELECT owner_instance FROM tasks WHERE task_id=?").get(id) as {owner_instance:string|null}).owner_instance;
      db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[id,now,task.state,task.state,"fence_lost",JSON.stringify({event,detail,owner:expectOwner,current_owner:currentOwner})]);
    }
  })();
  return getTask(db,id)!;
}
export function claim(db:Database,owner:string,concurrency=2,now=Date.now()):Task[] {
  if(concurrency<1||concurrency>4)throw new Error("concurrency must be between 1 and 4"); const claimed:Task[]=[];
  db.exec("BEGIN IMMEDIATE");
  try {
    let active=(db.query("SELECT count(*) n FROM tasks WHERE state IN ('starting','running')").get() as {n:number}).n;
    const candidates=db.query("SELECT task_id FROM tasks WHERE state='queued' ORDER BY created_at,task_id").all() as {task_id:string}[];
    for(const c of candidates){if(active>=concurrency)break;db.exec("SAVEPOINT candidate");try{const attempt=randomUUID();const result=db.run("UPDATE tasks SET state='starting',attempt_id=?,owner_instance=?,lease_expires_at=?,updated_at=? WHERE task_id=? AND state='queued'",[attempt,owner,now+60_000,now,c.task_id]);if(result.changes){db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event) VALUES(?,?,?,?,?)",[c.task_id,now,"queued","starting","claim"]);claimed.push(getTask(db,c.task_id)!);active++;}db.exec("RELEASE candidate");}catch(error){db.exec("ROLLBACK TO candidate");db.exec("RELEASE candidate");if(!String(error).includes("UNIQUE constraint failed"))throw error;}}
    db.exec("COMMIT"); return claimed;
  } catch(error){try{db.exec("ROLLBACK");}catch{}throw error;}
}
export function renewLeases(db:Database,owner:string,now=Date.now()):void {db.run("UPDATE tasks SET owner_instance=?1,lease_expires_at=?2,heartbeat_at=?3,updated_at=?4 WHERE state NOT IN ('done','failed','abandoned') AND (owner_instance IS NULL OR owner_instance=?1 OR lease_expires_at IS NULL OR lease_expires_at<=?5)",[owner,now+60_000,now,now,now]);}
export function events(db:Database,id:string):unknown[]{return db.query("SELECT * FROM task_events WHERE task_id=? ORDER BY id").all(id);}
export function getRecovery(db:Database,id:string):Recovery|null{return db.query("SELECT * FROM task_recovery WHERE task_id=?").get(id) as Recovery|null}
export function setRecovery(db:Database,id:string,attempt:string,state:Recovery["spawn_state"],now=Date.now()):void{db.run("INSERT OR REPLACE INTO task_recovery(task_id,attempt_id,spawn_state,spawn_at,unknown_ticks) VALUES(?,?,?,?,COALESCE((SELECT unknown_ticks FROM task_recovery WHERE task_id=? AND attempt_id=?),0))",[id,attempt,state,now,id,attempt])}
export function bumpUnknown(db:Database,id:string):number{db.run("UPDATE task_recovery SET unknown_ticks=unknown_ticks+1 WHERE task_id=?",[id]);return getRecovery(db,id)?.unknown_ticks??0}
export function resetUnknown(db:Database,id:string):void{db.run("UPDATE task_recovery SET unknown_ticks=0 WHERE task_id=?",[id])}
