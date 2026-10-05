import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Work } from "../control/types";

const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf8");
export const STATES = ["queued", "starting", "running", "awaiting_human", "submitted", "blocked", "done", "failed", "abandoned"] as const;
export type TaskState = typeof STATES[number];
export type Task = { task_id:string; title:string; repo:string; base_ref:string; worktree:string|null; branch:string|null; state:TaskState; attempt_id:string|null; owner_instance:string|null; lease_expires_at:number|null; heartbeat_at:number|null; runner_pid:number|null; runner_boot_id:string|null; retry_budget:number; stable_id:string|null; pr_url:string|null; blocked_reason:string|null; terminal_reason:string|null; work_id:string|null; contract_revision:number|null; budget_deadline_at:number|null; ci_observation_failures:number; stop_state:"stop_requested"|"stopped_confirmed"|"stop_unconfirmed"|null; stop_requested_at:number|null; stop_deadline_at:number|null; stop_reason:string|null; created_at:number; updated_at:number };
export type TransitionDetail = Record<string, unknown>;
export type Recovery={task_id:string;attempt_id:string;spawn_state:"intent"|"spawned"|"failed";spawn_at:number;unknown_ticks:number};
const rules: Record<TaskState, Record<string, TaskState>> = {
  queued:{claim:"starting",human_abandon:"abandoned"},
  starting:{worktree_ok:"running",spawn_ok:"running",spawn_fail:"blocked",worktree_fail:"failed",bind_timeout:"running",session_bound:"running",runner_dead:"starting",spawn_unverified:"blocked",no_attempt:"blocked",human_abandon:"abandoned"},
  running:{session_bound:"running",bind_timeout:"running",runner_exit:"awaiting_human",runner_dead:"starting",check_absent:"blocked",liveness_unknown:"blocked",no_attempt:"blocked",human_abandon:"abandoned","answer=confirm-stopped":"running","answer=keep-held":"running"},
  awaiting_human:{"answer=approve":"submitted","answer=reject":"blocked","answer=abandon":"abandoned","answer=recheck":"submitted","answer=manual-followup":"blocked",gate_expire:"blocked",human_abandon:"abandoned"},
  submitted:{push_pr_ok:"submitted",tool_missing:"blocked",push_fail:"blocked",ci_merged:"done",ci_anomaly:"awaiting_human",human_abandon:"abandoned"},
  blocked:{human_reopen:"starting",human_abandon:"abandoned"}, done:{}, failed:{}, abandoned:{}
};

// B-ORCH-CHECK-PK: attempt_check_results durable identity is (work_id,result_set_version,check_id).
// schema.sql's CREATE TABLE IF NOT EXISTS never rebuilds an existing table, so openStore migrates a
// legacy table before db.exec(schema) or any producer/reader touches the connection. The rebuilt
// table and index use the exact schema.sql statements, so fresh and migrated stores share one DDL.
const CHECK_RESULTS_KEY = "work_id,result_set_version,check_id";
const CHECK_RESULTS_LEGACY = "attempt_check_results_legacy_pk";
function schemaStatement(head:string):string{
  const start=schema.indexOf(head);
  if(start<0)throw new Error(`schema.sql is missing statement: ${head}`);
  return schema.slice(start,schema.indexOf(";",start)+1);
}
const CHECK_RESULTS_TABLE_DDL = schemaStatement("CREATE TABLE IF NOT EXISTS attempt_check_results(");
const CHECK_RESULTS_INDEX_DDL = schemaStatement("CREATE INDEX IF NOT EXISTS idx_check_results_work ");
type TableColumn = { name:string; notnull:number; pk:number };
function tableColumns(db:Database,table:string):TableColumn[]{
  // PRAGMA table_xinfo rows always carry name/notnull/pk; bun:sqlite returns them untyped.
  const columns=db.query(`PRAGMA table_xinfo(${table})`).all() as TableColumn[];
  return columns;
}
function hasCheckResultsKey(columns:TableColumn[]):boolean{
  const key=columns.filter(column=>column.pk>0).sort((a,b)=>a.pk-b.pk).map(column=>column.name).join(",");
  return key===CHECK_RESULTS_KEY&&columns.some(column=>column.name==="work_id"&&column.notnull===1);
}
function migrateCheckResultsKey(db:Database):void{
  const current=tableColumns(db,"attempt_check_results");
  if(current.length===0||hasCheckResultsKey(current))return;
  try{
    db.transaction(()=>{
      if(hasCheckResultsKey(tableColumns(db,"attempt_check_results")))return; // a concurrent opener migrated first
      db.exec(`ALTER TABLE attempt_check_results RENAME TO ${CHECK_RESULTS_LEGACY}`);
      db.exec(CHECK_RESULTS_TABLE_DDL);
      const legacyNames=tableColumns(db,CHECK_RESULTS_LEGACY).map(column=>column.name);
      const names=tableColumns(db,"attempt_check_results").map(column=>column.name);
      if(legacyNames.length!==names.length||names.some(name=>!legacyNames.includes(name)))
        throw new Error(`legacy columns [${legacyNames.join(",")}] do not match [${names.join(",")}]`);
      // A missing (NULL/empty) Work ID is backfilled only from the exactly-one tasks row with the same
      // task_id whose work_id is non-empty. Everything else stays NULL and fails closed below.
      const taskColumns=db.query("PRAGMA table_info(tasks)").all() as {name:string}[];
      const workId=taskColumns.some(column=>column.name==="work_id")
        ?"COALESCE(NULLIF(r.work_id,''),(SELECT CASE WHEN COUNT(*)=1 THEN NULLIF(MAX(t.work_id),'') END FROM tasks t WHERE t.task_id=r.task_id))"
        :"NULLIF(r.work_id,'')";
      const legacyRows=`SELECT ${names.map(name=>name==="work_id"?`${workId} AS work_id`:`r.${name}`).join(",")} FROM ${CHECK_RESULTS_LEGACY} r`;
      const unresolved=db.query(`SELECT r.task_id,r.result_set_version,r.check_id FROM ${CHECK_RESULTS_LEGACY} r WHERE (${workId}) IS NULL ORDER BY r.task_id,r.result_set_version,r.check_id`).all() as {task_id:string;result_set_version:number;check_id:string}[];
      if(unresolved.length)throw new Error(`${unresolved.length} row(s) have no provable Work ID, first task_id=${unresolved[0].task_id} result_set_version=${unresolved[0].result_set_version} check_id=${unresolved[0].check_id}`);
      const duplicates=db.query(`SELECT work_id,result_set_version,check_id FROM (${legacyRows}) GROUP BY work_id,result_set_version,check_id HAVING COUNT(*)>1 ORDER BY work_id,result_set_version,check_id`).all() as {work_id:string;result_set_version:number;check_id:string}[];
      if(duplicates.length)throw new Error(`${duplicates.length} (${CHECK_RESULTS_KEY}) key(s) would be duplicated, first work_id=${duplicates[0].work_id} result_set_version=${duplicates[0].result_set_version} check_id=${duplicates[0].check_id}`);
      db.run(`INSERT INTO attempt_check_results(${names.join(",")}) ${legacyRows}`);
      const migratedRows=`SELECT ${names.join(",")} FROM attempt_check_results`;
      const verify=db.query(`SELECT (SELECT COUNT(*) FROM ${CHECK_RESULTS_LEGACY}) AS legacy,(SELECT COUNT(*) FROM attempt_check_results) AS migrated,(SELECT COUNT(*) FROM (${legacyRows} EXCEPT ${migratedRows}))+(SELECT COUNT(*) FROM (${migratedRows} EXCEPT ${legacyRows})) AS mismatched`).get() as {legacy:number;migrated:number;mismatched:number};
      if(verify.legacy!==verify.migrated||verify.mismatched!==0)throw new Error(`copy verification failed: legacy=${verify.legacy} migrated=${verify.migrated} mismatched=${verify.mismatched}`);
      db.exec(`DROP TABLE ${CHECK_RESULTS_LEGACY}`);
      db.exec(CHECK_RESULTS_INDEX_DDL);
      if(!hasCheckResultsKey(tableColumns(db,"attempt_check_results")))throw new Error(`rebuilt table does not carry key (${CHECK_RESULTS_KEY})`);
    }).immediate();
  }catch(error){
    throw new Error(`attempt_check_results migration to (${CHECK_RESULTS_KEY}) failed closed; legacy table left unchanged: ${error instanceof Error?error.message:String(error)}`,{cause:error});
  }
}

export function openStore(path?: string | null): Database {
  // fail-fast：显式 null/空串/字面量 "undefined" 拒绝；仅 undefined（无参）才内部解析默认。
  if (path === null || path === "" || path === "undefined" || path === "null") throw new Error("openStore: path is required");
  let resolved = path ?? process.env.OVERLOAD_ORCHESTRATOR_PATH ?? "";
  if (!resolved || resolved.trim() === "" || resolved === "undefined" || resolved === "null") resolved = join(homedir(), ".overload", "orchestrator.db");
  if (!resolved.trim()) throw new Error("openStore: path is required");
  mkdirSync(dirname(resolved), { recursive:true, mode:0o700 });
  const db = new Database(resolved, { create:true });
  try {
    // busy_timeout (also set by schema.sql) must precede the migration's write lock so concurrent
    // openers wait instead of failing; the migration must precede every schema write.
    db.exec("PRAGMA busy_timeout = 5000"); migrateCheckResultsKey(db);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
    // Old databases lack stop_state: migrate columns before creating the revised partial index.
    db.transaction(()=>{
      const oldTasks=db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks'").get();
      if(oldTasks){
        const columns=db.query("PRAGMA table_info(tasks)").all() as {name:string}[];
        for(const [name,sql] of [["work_id","TEXT"],["contract_revision","INTEGER"],["budget_deadline_at","INTEGER"],["ci_observation_failures","INTEGER NOT NULL DEFAULT 0"],["stop_state","TEXT"],["stop_requested_at","INTEGER"],["stop_deadline_at","INTEGER"],["stop_reason","TEXT"]] as const)
          if(!columns.some(column=>column.name===name))db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${sql}`);
        const repoIndex=db.query("SELECT sql FROM sqlite_master WHERE type='index' AND name='tasks_repo_active'").get() as {sql:string}|null;
        if(repoIndex&&!repoIndex.sql.includes("stop_state IN ('stop_requested','stop_unconfirmed')"))db.exec("DROP INDEX tasks_repo_active");
      }
      db.exec(schema.replace(/^PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;\s*/,'').trimStart());
    }).immediate();
    chmodSync(resolved, 0o600);
    db.run("INSERT OR IGNORE INTO spool_seq(id,seq,segment) VALUES(1,0,0)"); return db;
  } catch (error) { db.close(); throw error; }
}
export function addTask(db:Database,title:string,repo:string,baseRef:string,now=Date.now(),binding?:{workId?:string;contractRevision?:number;deadlineAt?:number}): Task {
  const id=randomUUID(); db.run("INSERT INTO tasks(task_id,title,repo,base_ref,state,work_id,contract_revision,budget_deadline_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",[id,title,repo,baseRef,"queued",binding?.workId??null,binding?.contractRevision??null,binding?.deadlineAt??null,now,now]);
  db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event) VALUES(?,?,?,?,?)",[id,now,null,"queued","add"]); return getTask(db,id)!;
}
export function bindTaskContract(db:Database,taskId:string,work:Work):Task {
  if(!work.contract)throw new Error("work has no contract");
  db.run("UPDATE tasks SET work_id=?,contract_revision=?,budget_deadline_at=?,retry_budget=?,updated_at=? WHERE task_id=?",[work.work_id,work.revision,work.contract.budget.deadline_at??null,work.contract.budget.retry_limit??2,Date.now(),taskId]);
  const task=getTask(db,taskId);if(!task)throw new Error(`Task not found: ${taskId}`);return task;
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
  return db.transaction(()=>{
  const task=getTask(db,id); if(!task)throw new Error(`Task not found: ${id}`); const to=targetFor(task,event,detail); if(!to)throw new Error(`Illegal transition: ${task.state} + ${event}`);
  let budget=task.retry_budget; if((event==="runner_dead"||(event==="runner_exit"&&detail.evidence_complete===false)||event==="bind_timeout")&&budget>0)budget--;
  if(event==="human_reopen")budget=2;
  const reasons:Record<string,string>={spawn_fail:"tool_missing",worktree_fail:"repo_gone",check_absent:"no_check","answer=reject":"rejected",gate_expire:"gate_expired",tool_missing:"tool_missing",push_fail:"push_failed",bind_timeout:"bind_timeout",spawn_unverified:"spawn_unverified",liveness_unknown:"liveness_unknown",no_attempt:"no_attempt"};
  let blocked=to==="blocked"?(String(detail.reason??reasons[event]??(event==="runner_dead"?"runner_crash":"evidence_missing"))):null;
  const terminal=(to==="done"||to==="failed"||to==="abandoned")?String(detail.reason??event):null;
  // M2 §3.7: session-binding fields are optionally supplied via detail and persisted verbatim; absent keys keep the existing column value.
  const worktree=typeof detail.worktree==="string"?detail.worktree:task.worktree;
  const branch=typeof detail.branch==="string"?detail.branch:task.branch;
  // Reopening is a new attempt too; never reuse the old runner's PID or checkpoint identity.
  const rotateAttempt=to==="starting"&&(event==="human_reopen"||event==="runner_dead"||(event==="runner_exit"&&detail.evidence_complete===false));
  if(rotateAttempt&&(task.stop_state==='stop_requested'||task.stop_state==='stop_unconfirmed'))throw new Error('runner_stop_unconfirmed');
  const stableId=rotateAttempt?null:(typeof detail.stable_id==="string"?detail.stable_id:task.stable_id);
  const runnerPid=rotateAttempt?null:(typeof detail.runner_pid==="number"?detail.runner_pid:task.runner_pid);
  const runnerBootId=rotateAttempt?null:(typeof detail.runner_boot_id==="string"?detail.runner_boot_id:task.runner_boot_id);
  const attemptId=rotateAttempt?randomUUID():task.attempt_id;
  const prUrl=typeof detail.pr_url==="string"?detail.pr_url:task.pr_url;
  let applied=false;
    let sql="UPDATE tasks SET state=?,retry_budget=?,blocked_reason=?,terminal_reason=?,worktree=?,branch=?,stable_id=?,runner_pid=?,runner_boot_id=?,pr_url=?,attempt_id=?,updated_at=? WHERE task_id=?";
    const params:unknown[]=[to,budget,blocked,terminal,worktree,branch,stableId,runnerPid,runnerBootId,prUrl,attemptId,now,id];
    if(expectOwner!==undefined){sql+=" AND (owner_instance IS NULL OR owner_instance=?)";params.push(expectOwner);}
    const result=db.run(sql,params);
    applied=result.changes>0;
    if(applied){
      const eventDetail={...detail,attempt_id:task.attempt_id,...(rotateAttempt?{next_attempt_id:attemptId}:{})};
      db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[id,now,task.state,to,event,JSON.stringify(eventDetail)]);
      if(rotateAttempt){
        db.run("DELETE FROM task_recovery WHERE task_id=?",[id]);
        // Retain audit rows; the normal expiry pass closes their mailbox targets and cards.
        db.run("UPDATE approvals SET expires_at=MIN(expires_at,?) WHERE task_id=? AND consumed_at IS NULL",[now,id]);
      }
    } else {
      // §1.3-4: CAS lost to another owner. Don't touch tasks; leave an audit trail for a human.
      const currentOwner=(db.query("SELECT owner_instance FROM tasks WHERE task_id=?").get(id) as {owner_instance:string|null}).owner_instance;
      db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[id,now,task.state,task.state,"fence_lost",JSON.stringify({event,detail,owner:expectOwner,current_owner:currentOwner})]);
    }
  return getTask(db,id)!;
  }).immediate();
}
export function claim(db:Database,owner:string,concurrency=2,now=Date.now()):Task[] {
  if(concurrency<1||concurrency>4)throw new Error("concurrency must be between 1 and 4"); const claimed:Task[]=[];
  db.exec("BEGIN IMMEDIATE");
  try {
    let active=(db.query("SELECT count(*) n FROM tasks WHERE state IN ('starting','running') OR stop_state IN ('stop_requested','stop_unconfirmed')").get() as {n:number}).n;
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
