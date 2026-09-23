import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { SpoolWriter } from "./spool";
import { getTask, transition } from "./store";
import { closeTarget, consumeDecision, defaultMailboxPath, getTarget, markReceipt, openMailbox, receipt, registerTarget } from "../decision-bot/mailbox";
import { loadPolicy, policyAuthorizes } from "../decision-bot/policy";
import { getWork, getAttention, upsertAttention, enqueueControlEvent } from "../control/store";

export const defaultAnswersPath=defaultMailboxPath; export const openAnswersDb=openMailbox;
export type ApprovalGate="ready"|"ci_anomaly"|"confirm_stopped"|"keep_held";
const effectFor=(gate:ApprovalGate)=>gate==="ready"?"push_and_create_pr":gate==="confirm_stopped"?"confirm_stopped":gate==="keep_held"?"keep_held":"ci_resolution";
const parse=(text:string)=>JSON.parse(text) as Record<string,unknown>;

/** Rebuild mailbox/control projections from the durable source intent. This is
 * content-idempotent: existing target/card identity must agree or it fails. */
export function repairApprovalIntents(db:Database,answers:Database,now=Date.now()):number{
 let repaired=0; const rows=db.query("SELECT i.*,a.consumed_at FROM approval_intents i JOIN approvals a ON a.approval_id=i.approval_id WHERE i.repaired_at IS NULL").all() as any[];
 for(const row of rows){const task=getTask(db,row.task_id);if(!task)throw new Error(`intent task missing: ${row.task_id}`);const options=JSON.parse(row.options) as string[],evidence=parse(row.evidence);const work=task.work_id?getWork(answers,task.work_id):null;
   if(task.work_id&&(!work||work.revision!==task.contract_revision||work.state!=="active"))throw new Error("contract_revision_invalid");
   const expected={consumerOwner:"orchestrator" as const,approvalId:row.approval_id,stableId:task.stable_id??task.task_id,question:row.question,options,effect:effectFor(row.gate),scope:{gate:row.gate,task_id:task.task_id,repo:task.repo,base:task.base_ref,branch:task.branch,work_id:task.work_id,contract_revision:task.contract_revision},evidence,expiresAt:row.expires_at,workId:task.work_id??undefined,contractRevision:task.contract_revision??undefined,decisionMode:"human_only" as const};
   // Pre-repair targets from older executions lack canonical scope/evidence; only
   // reject a conflicting modern target, then replace the legacy projection.
   const compatible=(current:any)=>!current||current.decisionMode!="human_only"||JSON.stringify({question:current.question,options:current.options,effect:current.effect,scope:current.scope,evidence:current.evidence,expiresAt:current.expiresAt})===JSON.stringify({question:expected.question,options:expected.options,effect:expected.effect,scope:expected.scope,evidence:expected.evidence,expiresAt:expected.expiresAt});
   const current=getTarget(answers,"orchestrator",row.approval_id);if(!compatible(current))throw new Error(`approval intent mismatch: ${row.approval_id}`);
   const target=registerTarget(answers,expected);
   let eventId:string|null=null;if(work){const id=`orchestrator:${row.approval_id}`,existing=getAttention(answers,id);const item=upsertAttention(answers,{item_id:id,work_id:work.work_id,state:existing?.state??"open",effect_state:existing?.effect_state??"not_started",urgency:"inbox",conclusion:row.gate==="ready"?"Verified changes need approval":"A controlled execution decision is required",trigger:row.question,impact:"The controlled task remains held until its effect is verified.",recommendation:options[0]??null,options,owner:work.contract?.decision_owner??"operator",expires_at:row.expires_at,source_link:task.worktree,approval_id:row.approval_id,consumer_owner:"orchestrator",contract_revision:work.revision,decision_mode:"human_only",evidence,expected_revision:existing?.revision},now);
     eventId=enqueueControlEvent(answers,{entity_id:item.item_id,entity_version:item.revision,kind:"attention.opened",work_id:work.work_id,item_id:item.item_id,payload:{attention:item}},now);}db.run("UPDATE approval_intents SET repaired_at=?,control_event_id=? WHERE approval_id=?",[now,eventId,row.approval_id]);repaired++;
 }
 return repaired;
}
export function requestApproval(db:Database,spool:SpoolWriter,taskId:string,gate:ApprovalGate,question:string,options:string[],expiresInMs=24*3600*1000,answers=openMailbox()):string{
 const task=getTask(db,taskId);if(!task)throw new Error(`Task not found: ${taskId}`);const existing=db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate=? AND consumed_at IS NULL").get(taskId,gate) as any;if(existing){repairApprovalIntents(db,answers);return existing.approval_id;}
 const now=Date.now(),approvalId=randomUUID(),expires=now+expiresInMs,path=join(homedir(),".overload","artifacts",taskId);const file=(n:string)=>{const p=join(path,n);return existsSync(p)?readFileSync(p,"utf8"):""};const evidence={diff:file("diff.patch"),commits:file("commits.txt"),status:file("status.txt"),checks:file("checks.txt"),runner:file("runner.log")};
 db.transaction(()=>{db.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at) VALUES(?,?,?,?,?,?,?)",[approvalId,taskId,gate,question,JSON.stringify(options),now,expires]);db.run("INSERT INTO approval_intents(approval_id,task_id,gate,question,options,expires_at,evidence,created_at) VALUES(?,?,?,?,?,?,?,?)",[approvalId,taskId,gate,question,JSON.stringify(options),expires,JSON.stringify(evidence),now]);})();repairApprovalIntents(db,answers,now);return approvalId;
}
export function updateAttention(answers:Database,task:any,approvalId:string,state:"open"|"applying"|"resolved",effect:"not_started"|"applying"|"succeeded"|"failed"|"unknown",now:number){const old=getAttention(answers,`orchestrator:${approvalId}`);if(!old||(old.state===state&&old.effect_state===effect))return;upsertAttention(answers,{...old,expected_revision:old.revision,state,effect_state:effect},now);}
function terminalOutcome(answers:Database,receiptId:string):string|null{const row=answers.query("SELECT outcome FROM decision_receipts WHERE receipt_id=?").get(receiptId) as {outcome:string|null}|null;return row?.outcome??null;}
/** Reconcile receipt/card only from observed task state; never manufacture success. */
export function reconcileApprovalEffects(db:Database,answers:Database,now=Date.now()):void{for(const a of db.query("SELECT * FROM approvals WHERE consumed_at IS NOT NULL").all() as any[]){const task=getTask(db,a.task_id);if(!task)continue;const r=receipt(answers,"orchestrator",a.approval_id);if(!r)continue;let state:"open"|"applying"|"resolved"="applying",effect:"applying"|"succeeded"|"failed"|"unknown"="applying",outcome:string|null=null;
 if(task.state==="done"){state="resolved";effect="succeeded";outcome="succeeded";}else if(["blocked","failed","abandoned"].includes(task.state)){state="open";effect="failed";outcome="failed";}else if(task.state==="awaiting_human"){state="open";effect="unknown";outcome="unknown";}
 updateAttention(answers,task,a.approval_id,state,effect,now);const existing=terminalOutcome(answers,r.receiptId);if(!existing||!['succeeded','failed'].includes(existing)||outcome===existing)markReceipt(answers,r.receiptId,outcome??"unknown",now);}}
export function replayAppliedReceipts(db:Database,answers:Database,now=Date.now()):void{for(const prior of db.query("SELECT receipt_id FROM applied_receipts").all() as any[]){const outcome=terminalOutcome(answers,prior.receipt_id);if(!outcome)markReceipt(answers,prior.receipt_id,"unknown",now);}}
export function consumeAnswers(db:Database,answers:Database,spool:SpoolWriter,now=Date.now()):void{
 repairApprovalIntents(db,answers,now);const policy=loadPolicy(undefined,answers);
 replayAppliedReceipts(db,answers,now);reconcileApprovalEffects(db,answers,now);
 for(const approval of db.query("SELECT * FROM approvals WHERE consumed_at IS NULL").all() as any[]){const target=getTarget(answers,"orchestrator",approval.approval_id);if(!target)continue;let r=receipt(answers,"orchestrator",approval.approval_id);if(!r)r=consumeDecision(answers,{consumerOwner:"orchestrator",approvalId:approval.approval_id,targetVersion:target.targetVersion,policyHash:policy.hash,now,liveValid:()=>getTask(db,approval.task_id)?.state==="awaiting_human",policyValid:(t,p)=>!!p&&t.decisionMode!=="human_only"&&policyAuthorizes(policy,t,p.answer,p.policyHash)});if(!r)continue;const task=getTask(db,approval.task_id);if(!task)continue;
   db.transaction(()=>{if(!db.query("SELECT 1 FROM applied_receipts WHERE receipt_id=?").get(r!.receiptId)){transition(db,approval.task_id,`answer=${r!.answer}`,{actor:r!.actor,approval_id:approval.approval_id,receipt_id:r!.receiptId},now);db.run("INSERT INTO applied_receipts(receipt_id,task_id,answer,applied_at,result) VALUES(?,?,?,?,?)",[r!.receiptId,approval.task_id,r!.answer,now,"transitioned"]);db.run("UPDATE approvals SET consumed_at=?,actor=? WHERE approval_id=?",[now,r!.actor,approval.approval_id]);}});
   updateAttention(answers,task,approval.approval_id,"applying","applying",now);if(!terminalOutcome(answers,r.receiptId))markReceipt(answers,r.receiptId,"unknown",now);spool.emit(task.stable_id??task.task_id,"decision_resolved",{request_id:approval.approval_id,state:"applying",receipt_id:r.receiptId});
 }
}
export function expireApprovals(db:Database,spool:SpoolWriter,now=Date.now(),answers=openMailbox()):void{for(const a of db.query("SELECT * FROM approvals WHERE consumed_at IS NULL AND expires_at<=?").all(now) as any[]){const task=getTask(db,a.task_id);if(task?.state==="awaiting_human")transition(db,a.task_id,"gate_expire",{reason:"gate_expired"},now);closeTarget(answers,"orchestrator",a.approval_id,"expired");updateAttention(answers,task,a.approval_id,"open","failed",now);}}
