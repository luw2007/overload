import {describe,expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {scanOnce,type ManageConfig} from "../src/manage/manage";
import {ensureControlSchema} from "../src/control/store";
import {ensureMgmtSchema} from "../src/manage/schema";
import {aliasWork} from "../src/manage/relations";
import type {SourceFs,SourceHost} from "../src/manage/source";

const enc=new TextEncoder(),line=(x:unknown)=>JSON.stringify(x),sha=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const session=(id:string,cwd="/repo",origin?:string)=>[
 line({type:"session",id,cwd,timestamp:1,origin}),
 line({type:"message",timestamp:2,message:{role:"user",content:`fix ${id}`}}),
 line({type:"message",timestamp:3,message:{role:"assistant",content:[{type:"toolCall",id:`w-${id}`,name:"write",arguments:{path:`${cwd}/${id}.txt`,create:true}},{type:"toolCall",id:`r-${id}`,name:"read",arguments:{path:`${cwd}/readme.md`}}]}}),
 line({type:"message",timestamp:4,message:{role:"toolResult",toolCallId:`w-${id}`,toolName:"write",isError:false,content:[{type:"text",text:"written"}]}})
].join("\n")+"\n";
function cfg(host:SourceHost={host:"local",kind:"local"}):ManageConfig{return {enabled:true,agents:["pi"],hosts:[host],lookback_ms:1_000_000,follow_new:true,snapshot:{file_max_bytes:10_000,work_max_bytes:100_000,retain_ms:100},archive_grace_ms:100,snapshot_root:"/tmp/overload-manage-test",home_root:"/home/test"};}
function fake(files:Record<string,string>,host:SourceHost={host:"local",kind:"local"}):SourceFs{return {host,listFiles:async()=>Object.entries(files).map(([path,text])=>({path,mtimeMs:10,size:enc.encode(text).length})),readRange:async(path,from,max)=>{const b=enc.encode(files[path]??"");return {bytes:b.slice(from,from+max),nextByte:Math.min(b.length,from+max),eof:from+max>=b.length,generation:"g1"};},readFile:async(path,max)=>{const b=enc.encode(`content:${path}`);return {bytes:b.slice(0,max),truncated:b.length>max,sha256:sha(b.slice(0,max))};},exec:async()=>({code:0,stdout:"/home/test",stderr:""})};}
const count=(db:Database,t:string)=>(db.query(`SELECT count(*) n FROM ${t}`).get() as any).n;

describe("management scan",()=>{
 test("fresh unrelated sessions create separate candidate discovered Works and rescan is row-idempotent",async()=>{const db=new Database(":memory:"),fs=fake({"/home/test/.pi/agent/sessions/a.jsonl":session("a"),"/home/test/.pi/agent/sessions/b.jsonl":session("b")});const first=await scanOnce(db,null,cfg(),{now:20,fsFor:()=>fs});expect(first.discovered).toBe(2);expect(count(db,"control_works")).toBe(2);expect(count(db,"mgmt_executions")).toBe(2);expect(db.query("SELECT DISTINCT state,source FROM control_works").all()).toEqual([{state:"candidate",source:"discovered"}]);expect(db.query("SELECT count(*) n FROM mgmt_work_profile WHERE input_head IS NOT NULL").get()).toEqual({n:2});const before=["control_works","mgmt_executions","mgmt_inputs","mgmt_artifacts","mgmt_artifact_versions","mgmt_links","control_attention"].map(t=>count(db,t));await scanOnce(db,null,cfg(),{now:20,fsFor:()=>fs});expect(["control_works","mgmt_executions","mgmt_inputs","mgmt_artifacts","mgmt_artifact_versions","mgmt_links","control_attention"].map(t=>count(db,t))).toEqual(before);expect(count(db,"control_attention")).toBe(0);});
 test("same repo and near time are not weakly merged",async()=>{const db=new Database(":memory:"),fs=fake({"/home/test/.pi/agent/sessions/a.jsonl":session("a"),"/home/test/.pi/agent/sessions/b.jsonl":session("b")});await scanOnce(db,null,cfg(),{now:30,fsFor:()=>fs});expect(count(db,"control_works")).toBe(2);});
 test("handoff origin attaches successor to seeded Work",async()=>{const db=new Database(":memory:");ensureControlSchema(db);ensureMgmtSchema(db);db.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run("w","work","test","w","active",0,null,1,1);db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES ('w','discovered','mgmt','tracking','owner','work',1)").run();db.query("INSERT INTO mgmt_session_binding VALUES ('source','w','origin','seed',1)").run();db.query("INSERT INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,ledger_evidence,started_at) VALUES ('e','w','source','wr',1,'ended_ok','ledger_full','{}',1)").run();db.query("INSERT INTO mgmt_handoffs(handoff_id,work_id,source_execution_id,target_agent,state,packet,packet_sha256,workspace_fp,isolate) VALUES ('h','w','e','pi','launching','{}','x','x',0)").run();const ledger=new Database(":memory:");ledger.exec(readFileSync(new URL("../src/ingest/schema.sql",import.meta.url),"utf8"));ledger.query("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,first_seen_at) VALUES ('local:pi:child','local','pi','child','mgmt:handoff:h','/repo',1)").run();ledger.query("INSERT INTO current(stable_id,writer_id,state,origin,last_event_at) VALUES ('local:pi:child','wr','done','mgmt:handoff:h',10)").run();const fs=fake({"/home/test/.pi/agent/sessions/child.jsonl":session("child","/repo")});await scanOnce(db,ledger,cfg(),{now:20,fsFor:()=>fs});expect(count(db,"control_works")).toBe(1);expect(db.query("SELECT work_id FROM mgmt_session_binding WHERE stable_id='local:pi:child'").get()).toEqual({work_id:"w"});});
 test("truncated then appended source does not duplicate content versions",async()=>{const db=new Database(":memory:"),path="/home/test/.pi/agent/sessions/a.jsonl",full=session("a");let visible=full.slice(0,full.lastIndexOf("\n",full.length-2)+1);const fs=fake({[path]:visible});await scanOnce(db,null,cfg(),{now:20,fsFor:()=>fs});(fs as any).readRange=async(_p:string,from:number)=>{const b=enc.encode(full);return {bytes:b.slice(from),nextByte:b.length,eof:true,generation:"g1"};};await scanOnce(db,null,cfg(),{now:21,fsFor:()=>fs});expect(count(db,"mgmt_artifact_versions")).toBe(1);});
 test("unavailable host changes no rows and archives nothing",async()=>{const db=new Database(":memory:");const host:SourceHost={host:"down",kind:"ssh",remote:"down"};const fs:SourceFs={host,listFiles:async()=>{throw new Error("offline");},readRange:async()=>null,readFile:async()=>null,exec:async()=>({code:1,stdout:"",stderr:"offline"})};const r=await scanOnce(db,null,cfg(host),{now:20,fsFor:()=>fs});expect(r.hosts).toEqual([{host:"down",state:"unavailable",error:"offline"}]);expect(count(db,"control_works")).toBe(0);expect(r.archived).toBe(0);});
 test("read-only tool creates an artifact link but no content version",async()=>{const db=new Database(":memory:"),path="/home/test/.pi/agent/sessions/read.jsonl",text=[line({type:"session",id:"read",cwd:"/repo",timestamp:1}),line({type:"message",timestamp:2,message:{role:"user",content:"inspect"}}),line({type:"message",timestamp:3,message:{role:"assistant",content:[{type:"toolCall",id:"r",name:"read",arguments:{path:"/repo/readme.md"}}]}})].join("\n")+"\n";await scanOnce(db,null,cfg(),{now:20,fsFor:()=>fake({[path]:text})});expect(count(db,"mgmt_artifact_versions")).toBe(0);expect(count(db,"mgmt_artifacts")).toBe(1);expect(db.query("SELECT relation,confidence,evidence_ref FROM mgmt_links").get()).toEqual({relation:"read",confidence:"strong",evidence_ref:`${path}#L3`});});
});


test("rescanning an aliased session preserves binding and routes new artifacts canonically",async()=>{
 const db=new Database(":memory:");ensureControlSchema(db);
 const files={"/home/test/.pi/agent/sessions/alias.jsonl":session("alias")}, source=fake(files);
 await scanOnce(db,null,cfg(),{now:10,fsFor:()=>source});
 const original=db.query("SELECT work_id FROM mgmt_session_binding WHERE stable_id='local:pi:alias'").get() as {work_id:string};
 db.query("INSERT INTO control_works VALUES ('canonical','canonical','test','canonical','candidate',0,NULL,1,1)").run();
 db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES ('canonical','discovered','mgmt','tracking','owner','canonical',1)").run();
 aliasWork(db,original.work_id,"canonical",{actor:"owner",reason:"same task",now:11});
 files["/home/test/.pi/agent/sessions/alias.jsonl"]+=line({type:"message",timestamp:12,message:{role:"assistant",content:[{type:"toolCall",id:"new",name:"write",arguments:{path:"/repo/new.txt"}}]}})+"\n"+line({type:"message",timestamp:13,message:{role:"toolResult",toolCallId:"new",toolName:"write",isError:false,content:[]}})+"\n";
 await scanOnce(db,null,cfg(),{now:14,fsFor:()=>source});
 expect(db.query("SELECT work_id FROM mgmt_session_binding WHERE stable_id='local:pi:alias'").get()).toEqual(original);
 expect(db.query("SELECT track_state,archive_reason FROM mgmt_work_profile WHERE work_id=?").get(original.work_id)).toEqual({track_state:"archived",archive_reason:"aliased"});
 expect(db.query("SELECT work_id FROM mgmt_artifacts WHERE display_path='/repo/new.txt'").get()).toEqual({work_id:"canonical"});
 expect(db.query("SELECT count(*) n FROM mgmt_executions WHERE stable_id='local:pi:alias'").get()).toEqual({n:1});db.close();
});


test("write result in a later scan retains original call evidence",async()=>{
 const db=new Database(":memory:");ensureControlSchema(db);
 const path="/home/test/.pi/agent/sessions/pending.jsonl", files:{[path:string]:string}={};
 files[path]=[line({type:"session",id:"pending",cwd:"/repo"}),line({type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call",name:"write",arguments:{path:"/repo/pending.txt"}}]}})].join("\n")+"\n";
 const source=fake(files);
 await scanOnce(db,null,cfg(),{now:10,fsFor:()=>source});
 expect(db.query("SELECT count(*) n FROM mgmt_links WHERE relation='modified'").get()).toEqual({n:0});
 files[path]+=line({type:"message",message:{role:"toolResult",toolCallId:"call",toolName:"write",isError:false,content:[]}})+"\n";
 await scanOnce(db,null,cfg(),{now:11,fsFor:()=>source});
 const links=db.query("SELECT evidence_ref FROM mgmt_links WHERE relation='modified'").all();
 expect(links).toEqual([{evidence_ref:`${path}#L2`}]);
 await scanOnce(db,null,cfg(),{now:12,fsFor:()=>source});
 expect(db.query("SELECT count(*) n FROM mgmt_links WHERE relation='modified'").get()).toEqual({n:1});db.close();
});
