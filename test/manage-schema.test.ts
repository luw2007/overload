import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ControlError, ensureControlSchema, openControl } from "../src/control/store";
import { setInputHead, setParentHandoff } from "../src/manage/schema";

const tables = [
  "mgmt_acceptances", "mgmt_artifact_versions", "mgmt_artifacts", "mgmt_corrections",
  "mgmt_cursors", "mgmt_discovery_log", "mgmt_exec_records", "mgmt_executions",
  "mgmt_external_effects", "mgmt_handoff_launch_attempts", "mgmt_handoffs", "mgmt_inputs",
  "mgmt_links", "mgmt_manifest_entries", "mgmt_manifests", "mgmt_observations",
  "mgmt_session_binding", "mgmt_submissions", "mgmt_summaries", "mgmt_work_alias",
  "mgmt_work_hints", "mgmt_work_profile",
];
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function dbFixture(){const db=new Database(":memory:");db.exec("PRAGMA foreign_keys=ON");ensureControlSchema(db);return db;}
function work(db:Database,id:string){db.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run(id,id,"test",id,"candidate",0,null,1,1);db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES (?,?,?,?,?,?,?)").run(id,"discovered","mgmt","tracking","owner",id,1);}
function binding(db:Database,id:string,workId:string){db.query("INSERT INTO mgmt_session_binding VALUES (?,?,?,?,?)").run(id,workId,"origin","e",1);}
function execution(db:Database,id:string,workId:string,stableId:string){db.query("INSERT INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,ledger_evidence,started_at) VALUES (?,?,?,?,?,?,?,?,?)").run(id,workId,stableId,"writer",1,"running","ledger_full","{}",1);}

describe("management schema",()=>{
  test("fresh control DB is v3 with the exact management tables",()=>{const db=dbFixture();expect(db.query("SELECT version FROM control_schema_meta WHERE id=1").get()).toEqual({version:3});expect((db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'mgmt_%' ORDER BY name").all() as {name:string}[]).map(x=>x.name)).toEqual(tables);db.close();});
  test("v1 migrates without touching control works",()=>{const db=dbFixture();work(db,"keep");for(const name of [...tables].reverse())db.exec(`DROP TABLE ${name}`);db.query("UPDATE control_schema_meta SET version=1 WHERE id=1").run();ensureControlSchema(db);expect(db.query("SELECT work_id,title FROM control_works").all()).toEqual([{work_id:"keep",title:"keep"}]);expect(db.query("SELECT version FROM control_schema_meta WHERE id=1").get()).toEqual({version:3});db.close();});
  test("openControl enables foreign keys",()=>{const dir=mkdtempSync(join(tmpdir(),"overload-mgmt-"));dirs.push(dir);const db=openControl(join(dir,"control.db"));expect(db.query("PRAGMA foreign_keys").get()).toEqual({foreign_keys:1});db.close();});
  test("foreign keys reject invalid direct inserts",()=>{const db=dbFixture();work(db,"w1");binding(db,"s1","w1");expect(()=>execution(db,"e0","ghost","s1")).toThrow();expect(()=>db.query("INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_state,producer,observed_at) VALUES ('v0','ghost','content','x','stored','unknown',1)").run()).toThrow();db.query("INSERT INTO mgmt_artifacts VALUES ('a1','w1','file','a1',NULL,1),('a2','w1','file','a2',NULL,1)").run();db.query("INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_state,producer,observed_at) VALUES ('v1','a1','content','x','stored','unknown',1)").run();db.query("INSERT INTO mgmt_manifests VALUES ('m1','w1',NULL,NULL,NULL,NULL,NULL,'{}','test',1)").run();expect(()=>db.query("INSERT INTO mgmt_manifest_entries VALUES ('m1','a2','v1')").run()).toThrow();expect(()=>db.query("INSERT INTO mgmt_acceptances(acceptance_id,work_id,manifest_id,verdict,actor,decided_at) VALUES ('ac','w1','ghost','accepted','owner',1)").run()).toThrow();db.close();});
  test("de-cycled pointers accept same-work and reject cross-work targets",()=>{const db=dbFixture();work(db,"w1");work(db,"w2");db.query("INSERT INTO mgmt_inputs(input_id,work_id,kind,version,at) VALUES ('i1','w1','user_message',1,1),('i2','w2','user_message',1,1)").run();setInputHead(db,"w1","i1");expect(()=>setInputHead(db,"w1","i2")).toThrow(ControlError);binding(db,"s1","w1");binding(db,"s2","w2");execution(db,"e1","w1","s1");execution(db,"e2","w2","s2");db.query("INSERT INTO mgmt_handoffs(handoff_id,work_id,source_execution_id,target_agent,state,packet,packet_sha256,workspace_fp) VALUES ('h1','w1','e1','pi','stale','{}','x','fp'),('h2','w2','e2','pi','stale','{}','x','fp')").run();setParentHandoff(db,"e1","h1");expect(()=>setParentHandoff(db,"e2","h1")).toThrow(ControlError);db.close();});
  test("full chain passes foreign_key_check",()=>{const db=dbFixture();work(db,"w");binding(db,"s","w");execution(db,"e","w","s");db.query("INSERT INTO mgmt_artifacts VALUES ('a','w','file','a',NULL,1)").run();db.query("INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_state,producer,observed_at) VALUES ('v','a','content','x','stored','e',1)").run();db.query("INSERT INTO mgmt_observations(version_id,execution_id,observed_source,evidence_ref,observed_at) VALUES ('v','e','ledger','ref',1)").run();expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);db.close();});
});
