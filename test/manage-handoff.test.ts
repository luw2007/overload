import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { ensureControlSchema, ControlError } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { checkHandoffPreconditions, createHandoff } from "../src/manage/handoff";
import { launchHandoff, reconcileLaunches } from "../src/manage/launch";

function fixture(coverage="ledger_full", state="running") {
  const db=new Database(":memory:"); ensureControlSchema(db); ensureMgmtSchema(db);
  const ledger=new Database(":memory:"); ledger.exec(readFileSync(new URL("../src/ingest/schema.sql",import.meta.url),"utf8"));
  db.query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)").run("w","work","test","w","active",0,null,1,1);
  db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES ('w','discovered','mgmt','tracking','owner','work',1)").run();
  db.query("INSERT INTO mgmt_session_binding VALUES ('s','w','origin','seed',1)").run();
  db.query("INSERT INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,ledger_evidence,started_at,cwd) VALUES ('e','w','s','wr',1,'running',?,'{}',1,'/tmp')").run(coverage);
  ledger.query("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,first_seen_at) VALUES ('s','local','pi','s','human','/tmp',1)").run();
  ledger.query("INSERT INTO current(stable_id,writer_id,state,origin,last_event_at) VALUES ('s','wr',?,'human',?)").run(state,Date.now());
  return {db,ledger};
}

describe("management handoff",()=>{
  test("running and blocked sources are rejected",()=>{
    let f=fixture(); expect(checkHandoffPreconditions(f.db,f.ledger,"e").cause).toBe("source_running");
    f=fixture("ledger_full","awaiting"); f.ledger.query("INSERT INTO requests(request_uid,stable_id,writer_id,state) VALUES ('r','s','wr','pending')").run();
    expect(checkHandoffPreconditions(f.db,f.ledger,"e")).toMatchObject({cause:"blocked_on_ask",allowed:[]});
  });
  test("file-only requires isolation and confirmation reason",()=>{
    const {db,ledger}=fixture("file_only","idle");
    expect(checkHandoffPreconditions(db,ledger,"e").allowed).toEqual(["isolate_with_confirmation"]);
    expect(()=>createHandoff(db,{workId:"w",sourceExecutionId:"e",targetAgent:"pi",ledger})).toThrow(ControlError);
    expect(()=>createHandoff(db,{workId:"w",sourceExecutionId:"e",targetAgent:"pi",ledger,isolate:true})).toThrow("confirmation_required");
    expect(createHandoff(db,{workId:"w",sourceExecutionId:"e",targetAgent:"pi",ledger,isolate:true,override_reason:"accepted"}).state).toBe("ready_to_launch");
  });
  test("no-effect launch retries same handoff and persists requested before executor",async()=>{
    const {db,ledger}=fixture("ledger_full","done");
    const handoff=createHandoff(db,{workId:"w",sourceExecutionId:"e",targetAgent:"pi",ledger});
    const noEffect=Object.assign(new Error("missing binary"),{no_effect:true});
    expect(await launchHandoff(db,handoff.handoff_id,{confirmed:true,executor:async request=>{expect(db.query("SELECT state FROM mgmt_handoff_launch_attempts WHERE idempotency_key=?").get(request.idempotencyKey)).toEqual({state:"requested"});throw noEffect;}})).toMatchObject({attempt_no:1,state:"ready_to_launch",outcome:"failed_no_effect"});
    expect(await launchHandoff(db,handoff.handoff_id,{confirmed:true,executor:async request=>{expect(db.query("SELECT state FROM mgmt_handoff_launch_attempts WHERE idempotency_key=?").get(request.idempotencyKey)).toEqual({state:"requested"});return {pid:42,receipt:"pid:42"};}})).toMatchObject({attempt_no:2,state:"launching"});
    expect((db.query("SELECT count(*) n FROM mgmt_handoffs").get() as any).n).toBe(1);
    expect(db.query("SELECT attempt_no,state FROM mgmt_handoff_launch_attempts ORDER BY attempt_no").all()).toEqual([{attempt_no:1,state:"failed_no_effect"},{attempt_no:2,state:"started"}]);
  });
  test("launch confirmation, unknown idempotency, and reconcile",async()=>{
    const {db,ledger}=fixture("ledger_full","done"); ledger.query("INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind) VALUES ('local','x',1,?,'s','wr','session_ended')").run(Date.now());
    const handoff=createHandoff(db,{workId:"w",sourceExecutionId:"e",targetAgent:"pi",ledger});
    await expect(launchHandoff(db,handoff.handoff_id)).rejects.toMatchObject({code:"invalid"});
    expect((await launchHandoff(db,handoff.handoff_id,{confirmed:true,executor:async()=>{throw new Error("timeout")},timeoutMs:50})).state).toBe("launch_unknown");
    expect(JSON.parse((db.query("SELECT options FROM control_attention").get() as any).options)).toEqual(["jump","attach","abandon"]);
    await expect(launchHandoff(db,handoff.handoff_id,{confirmed:true})).rejects.toMatchObject({code:"conflict"});
    ledger.query("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,first_seen_at) VALUES ('new','local','pi','new',?, '/tmp',2)").run(`mgmt:handoff:${handoff.handoff_id}`);
    expect(reconcileLaunches(db,ledger).bound).toBe(1);
    expect(db.query("SELECT state,new_stable_id FROM mgmt_handoffs WHERE handoff_id=?").get(handoff.handoff_id)).toEqual({state:"bound",new_stable_id:"new"});
    expect((db.query("SELECT parent_handoff_id FROM mgmt_executions WHERE stable_id='new'").get() as any).parent_handoff_id).toBe(handoff.handoff_id);
    expect((db.query("SELECT state FROM control_attention").get() as any).state).toBe("resolved");
  });
});
