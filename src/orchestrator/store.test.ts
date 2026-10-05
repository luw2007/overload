import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { addTask, claim, getTask, openStore, transition } from "./store";
const BASE_REF="a".repeat(40);const dirs:string[]=[]; function store(){const d=mkdtempSync(join(tmpdir(),"orch-"));dirs.push(d);return openStore(join(d,"db"));}afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
describe("orchestrator store",()=>{
 test("claim enforces repo lock while skipping to independent repo",()=>{const db=store();const a=addTask(db,"a","/a",BASE_REF,1),b=addTask(db,"b","/a",BASE_REF,2),c=addTask(db,"c","/b",BASE_REF,3);expect(claim(db,"owner",4,4).map(x=>x.task_id)).toEqual([a.task_id,c.task_id]);expect(getTask(db,b.task_id)?.state).toBe("queued");db.close();});
 test("cap counts only starting and running",()=>{const db=store();const a=addTask(db,"a","/a",BASE_REF,1),b=addTask(db,"b","/b",BASE_REF,2),c=addTask(db,"c","/c",BASE_REF,3);claim(db,"o",2,4);transition(db,a.task_id,"worktree_ok",{},5);transition(db,a.task_id,"runner_exit",{},6);expect(claim(db,"o",2,7).map(x=>x.task_id)).toEqual([c.task_id]);expect(getTask(db,b.task_id)?.state).toBe("starting");db.close();});
 test("illegal event rejected and budgets only documented retries",()=>{const db=store();const t=addTask(db,"a","/a",BASE_REF);expect(()=>transition(db,t.task_id,"ci_merged")).toThrow("Illegal transition");claim(db,"o");expect(transition(db,t.task_id,"bind_timeout").retry_budget).toBe(1);expect(transition(db,t.task_id,"session_bound").retry_budget).toBe(1);expect(transition(db,t.task_id,"runner_dead").retry_budget).toBe(0);expect(transition(db,t.task_id,"spawn_fail").retry_budget).toBe(0);expect(transition(db,t.task_id,"human_reopen").retry_budget).toBe(2);db.close();});
 test("attempt survives close and reopen",()=>{const d=mkdtempSync(join(tmpdir(),"orch-"));dirs.push(d);const p=join(d,"db");let db=openStore(p);const t=addTask(db,"a","/a",BASE_REF);claim(db,"o");const attempt=getTask(db,t.task_id)?.attempt_id;db.close();db=openStore(p);expect(getTask(db,t.task_id)?.attempt_id).toBe(attempt);expect(getTask(db,t.task_id)?.state).toBe("starting");db.close();});
 test("human reopen rotates runner identity and records the attempt boundary",()=>{
   const db=store();
   try {
     const task=addTask(db,"reopen","/reopen",BASE_REF,1);claim(db,"owner",1,2);
     transition(db,task.task_id,"spawn_ok",{},3);
     const bound=transition(db,task.task_id,"session_bound",{stable_id:"old-session",runner_pid:123,runner_boot_id:"old-boot"},4);
     db.run("INSERT INTO approvals VALUES(?,?,?,?,?,?,?,?,?)",["old-approval",task.task_id,"ready","Proceed?","[\"approve\"]",4,1000,null,null]);
     transition(db,task.task_id,"liveness_unknown",{},5);
     const reopened=transition(db,task.task_id,"human_reopen",{},6);
     expect(reopened.attempt_id).not.toBe(bound.attempt_id);
     expect(reopened).toMatchObject({state:"starting",stable_id:null,runner_pid:null,runner_boot_id:null});
     const event=db.query("SELECT detail FROM task_events WHERE event='human_reopen'").get() as {detail:string};
     expect(JSON.parse(event.detail)).toMatchObject({attempt_id:bound.attempt_id,next_attempt_id:reopened.attempt_id});
     expect(db.query("SELECT expires_at,consumed_at FROM approvals WHERE approval_id='old-approval'").get()).toEqual({expires_at:6,consumed_at:null});
   }finally{db.close();}
 });
 test("held stop state rejects reopening without losing its original attempt",()=>{
   const db=store();
   try {
     const task=addTask(db,"held","/held",BASE_REF,1);claim(db,"owner",1,2);
     transition(db,task.task_id,"spawn_fail",{},3);
     for(const stopState of ['stop_requested','stop_unconfirmed'] as const){
       db.run("UPDATE tasks SET stop_state=? WHERE task_id=?",[stopState,task.task_id]);
       const before=getTask(db,task.task_id);
       expect(()=>transition(db,task.task_id,'human_reopen',{},4)).toThrow();
       expect(getTask(db,task.task_id)).toEqual(before);
       expect(db.query("SELECT event FROM task_events WHERE task_id=? AND event='human_reopen'").all(task.task_id)).toEqual([]);
     }
     db.run("UPDATE tasks SET stop_state='stopped_confirmed' WHERE task_id=?",[task.task_id]);
     expect(transition(db,task.task_id,'human_reopen',{},5).attempt_id).not.toBe(task.attempt_id);
   } finally {db.close();}
 });
});
