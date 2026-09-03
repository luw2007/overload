import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpoolWriter } from "./spool";
import { getTask, transition } from "./store";

export const defaultAnswersPath=join(homedir(),".overload","orchestrator-answers.db");
export function openAnswersDb(path=defaultAnswersPath):Database{mkdirSync(dirname(path),{recursive:true,mode:0o700});const db=new Database(path,{create:true});db.exec("CREATE TABLE IF NOT EXISTS answers(approval_id TEXT PRIMARY KEY, answer TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL)");chmodSync(path,0o600);return db;}

export function requestApproval(db:Database,spool:SpoolWriter,taskId:string,gate:"ready"|"ci_anomaly",question:string,options:string[],expiresInMs=24*3600*1000):string{
  const task=getTask(db,taskId);if(!task)throw new Error(`Task not found: ${taskId}`);
  const existing=db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate=? AND consumed_at IS NULL").get(taskId,gate) as {approval_id:string}|null;if(existing)return existing.approval_id;
  const approvalId=randomUUID(),now=Date.now(),expires=now+expiresInMs,path=join(homedir(),".overload","artifacts",taskId);
  db.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at) VALUES(?,?,?,?,?,?,?)",[approvalId,taskId,gate,question,JSON.stringify(options),now,expires]);
  const first=gate==="ready"?"Changes are ready for your approval.":"CI requires your decision.";const checksPath=join(path,"checks.txt");const checksSummary=existsSync(checksPath)?readFileSync(checksPath,"utf8").trim().split("\n")[0]?.slice(0,160)||"check passed":"check evidence unavailable";const hours=Math.ceil(expiresInMs/3600000);
  const summary=`${first} Evidence: ${checksPath} (${checksSummary}). Decide within ${hours}h; without approval the task enters blocked and its worktree is retained.`;
  spool.emit(task.stable_id??taskId,"decision_requested",{request_id:approvalId,summary,question,options,gate,expires_at:expires,evidence_path:path});return approvalId;
}

function audit(db:Database,taskId:string,event:string,detail:Record<string,unknown>,now:number):void{const task=getTask(db,taskId);db.run("INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",[taskId,now,task?.state??null,task?.state??"unknown",event,JSON.stringify(detail)]);}
export function consumeAnswers(db:Database,answers:Database,spool:SpoolWriter,now=Date.now()):void{
  answers.run("DELETE FROM answers WHERE at < ?",now-7*24*3600*1000);
  const rows=answers.query("SELECT approval_id,answer,actor,at FROM answers").all() as Array<{approval_id:string;answer:string;actor:string;at:number}>;
  for(const row of rows){const approval=db.query("SELECT * FROM approvals WHERE approval_id=?").get(row.approval_id) as any;
    let why:string|undefined;if(!approval)why="unknown_approval";else if(approval.consumed_at!==null)why="already_consumed";else if(now>=approval.expires_at)why="expired";else {let opts:string[]=[];try{opts=JSON.parse(approval.options);}catch{}if(!opts.includes(row.answer))why="invalid_option";else if(getTask(db,approval.task_id)?.state!=="awaiting_human")why="task_not_awaiting";}
    if(why){audit(db,approval?.task_id??`approval:${row.approval_id}`,"answer_discarded",{approval_id:row.approval_id,reason:why,actor:row.actor},now);answers.run("DELETE FROM answers WHERE approval_id=?",row.approval_id);continue;}
    const event=`answer=${row.answer}`;db.transaction(()=>{transition(db,approval.task_id,event,{actor:row.actor,approval_id:row.approval_id},now);db.run("UPDATE approvals SET consumed_at=?,actor=? WHERE approval_id=?",[now,row.actor,row.approval_id]);})();spool.emit(getTask(db,approval.task_id)?.stable_id??approval.task_id,"decision_resolved",{request_id:row.approval_id,state:"resolved",selected:row.answer,answer:row.answer,actor:row.actor});answers.run("DELETE FROM answers WHERE approval_id=?",row.approval_id);
  }
}
export function expireApprovals(db:Database,now=Date.now()):void{const rows=db.query("SELECT approval_id,task_id FROM approvals WHERE consumed_at IS NULL AND expires_at<=?").all(now) as Array<{approval_id:string;task_id:string}>;for(const row of rows){const task=getTask(db,row.task_id);if(task?.state==="awaiting_human"){transition(db,row.task_id,"gate_expire",{approval_id:row.approval_id},now);db.run("UPDATE approvals SET consumed_at=? WHERE approval_id=?",[now,row.approval_id]);}}}
