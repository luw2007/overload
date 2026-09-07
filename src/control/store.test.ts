import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { actOnAttention, promoteWork, ControlError, createWork, ensureControlSchema, getAttention, getWork, recordStopCondition, resolveAttentionDecision, reviseContract, upsertAttention } from "./store";
import type { Contract } from "./types";

const contract: Contract = { objective:"ship",acceptance:[{id:"human",kind:"human",description:"owner accepts"}],non_goals:[],scope:{allowed_effects:["write"]},budget:{retry_limit:1},stop_conditions:[{id:"risk",kind:"hard",description:"unexpected destructive effect"}],decision_owner:"owner" };
function fixture(){const db=new Database(":memory:");ensureControlSchema(db);return db;}

describe("control store CAS and attention semantics",()=>{
  test("contract revision supersedes only unconsumed open attention and emits in same transaction",()=>{
    const db=fixture();const work=createWork(db,{title:"x",source:"test",contract},1);
    const item=upsertAttention(db,{item_id:"i",work_id:work.work_id,state:"open",effect_state:"not_started",urgency:"inbox",conclusion:"decide",trigger:"risk",impact:"blocked",recommendation:"approve",options:["approve"],owner:"owner",expires_at:null,source_link:null,approval_id:"a",consumer_owner:"orchestrator",contract_revision:1,decision_mode:"human_only",evidence:{}},2);
    const revised=reviseContract(db,work.work_id,1,{...contract,objective:"ship v2"},"scope changed",3);
    expect(revised.revision).toBe(2);expect(getAttention(db,item.item_id)?.state).toBe("superseded");
    expect((db.query("SELECT COUNT(*) n FROM control_outbox").get() as {n:number}).n).toBe(4);db.close();
  });
  test("schema version refuses newer databases and initialization records version",()=>{
    const db=fixture();expect(db.query("SELECT version FROM control_schema_meta WHERE id=1").get()).toEqual({version:1});db.query("UPDATE control_schema_meta SET version=99 WHERE id=1").run();expect(()=>ensureControlSchema(db)).toThrow(ControlError);db.close();
  });
  test("malformed contract does not default missing scope, acceptance, or hard cost",()=>{
    const db=fixture();for(const malformed of [{...contract,acceptance:[]},{...contract,scope:{}},{...contract,budget:{cost_mode:"hard"}}])expect(()=>createWork(db,{title:"x",source:"test",contract:malformed as Contract})).toThrow(ControlError);db.close();
  });
  test("stop-condition expected revision is checked atomically",()=>{
    const db=fixture();const work=createWork(db,{title:"x",source:"test",contract},1);expect(()=>recordStopCondition(db,work.work_id,"risk",{},2,2)).toThrow(ControlError);expect(recordStopCondition(db,work.work_id,"risk",{fact:true},2,1).contract_revision).toBe(1);db.close();
  });
  test.each(["stop","continue"] as const)("generic %s decision applies work effect before resolving",(selected)=>{
    const db=fixture();const work=createWork(db,{title:"x",source:"test",contract},1);const item=recordStopCondition(db,work.work_id,"risk",{},2,1);const resolved=resolveAttentionDecision(db,item.item_id,item.revision,{selected_option:selected},3);expect(resolved).toMatchObject({state:"resolved",effect_state:"succeeded",revision:3,contract_revision:2});expect(getWork(db,work.work_id)).toMatchObject({state:selected==="stop"?"stopped":"active",revision:2});expect((db.query("SELECT kind FROM control_attention_events WHERE item_id=? ORDER BY revision").all(item.item_id) as Array<{kind:string}>).map(row=>row.kind)).toEqual(["upsert","applying","resolved"]);db.close();
  });
  test("narrow rejects missing contract without changing card and atomically revises with valid replacement",()=>{
    const db=fixture();const work=createWork(db,{title:"x",source:"test",contract},1);const item=recordStopCondition(db,work.work_id,"risk",{},2,1);expect(()=>resolveAttentionDecision(db,item.item_id,item.revision,{selected_option:"narrow"},3)).toThrow(ControlError);expect(getAttention(db,item.item_id)).toMatchObject({state:"open",effect_state:"not_started",revision:1});const replacement={...contract,objective:"ship narrow"};const resolved=resolveAttentionDecision(db,item.item_id,item.revision,{selected_option:"narrow",replacement_contract:replacement,reason:"reduce risk"},4);expect(resolved).toMatchObject({state:"resolved",effect_state:"succeeded",contract_revision:2});expect(getWork(db,work.work_id)).toMatchObject({state:"active",revision:2,contract:replacement});db.close();
  });
  test("generic decision stale CAS and approval-linked route fail without mutation",()=>{
    const db=fixture();const work=createWork(db,{title:"x",source:"test",contract},1);const item=recordStopCondition(db,work.work_id,"risk",{},2,1);expect(()=>resolveAttentionDecision(db,item.item_id,2,{selected_option:"stop"},3)).toThrow(ControlError);const linked=upsertAttention(db,{item_id:"linked",work_id:work.work_id,state:"open",effect_state:"not_started",urgency:"now",conclusion:"linked",trigger:"risk",impact:"blocked",recommendation:"stop",options:["stop"],owner:"owner",expires_at:null,source_link:null,approval_id:"a",consumer_owner:"orchestrator",contract_revision:1,decision_mode:"human_only",evidence:{}},3);expect(()=>resolveAttentionDecision(db,linked.item_id,linked.revision,{selected_option:"stop"},4)).toThrow(ControlError);expect(getWork(db,work.work_id)?.state).toBe("active");expect(getAttention(db,item.item_id)?.state).toBe("open");db.close();
  });
  test("stale mutation conflicts, ack does not resolve, unresolved external effect blocks resolve",()=>{
    const db=fixture();const work=createWork(db,{title:"x",source:"test",contract},1);
    const item=upsertAttention(db,{item_id:"i",work_id:work.work_id,state:"open",effect_state:"unknown",urgency:"inbox",conclusion:"decide",trigger:"risk",impact:"blocked",recommendation:null,options:[],owner:"owner",expires_at:null,source_link:null,approval_id:"a",consumer_owner:"extension",contract_revision:1,decision_mode:"human_only",evidence:{}},2);
    expect(actOnAttention(db,"i",1,"ack",{},3).state).toBe("open");
    expect(()=>actOnAttention(db,"i",1,"defer",{defer_until:10},4)).toThrow(ControlError);
    expect(()=>actOnAttention(db,"i",2,"resolve",{},4)).toThrow(ControlError);db.close();
  });
});

test("promotion requires candidate and current revision and emits a new contract",()=>{
 const db=fixture();const w=createWork(db,{title:"idea",source:"operator",candidate:true},1);
 const promoted=promoteWork(db,w.work_id,1,contract,"promoted",2);
 expect(promoted.state).toBe("active");expect(promoted.revision).toBe(2);
 expect(()=>promoteWork(db,w.work_id,2,contract,"again",3)).toThrow();
 const candidate=createWork(db,{title:"next",source:"operator",candidate:true},3);
 expect(()=>promoteWork(db,candidate.work_id,2,contract,"stale",4)).toThrow();
 expect(()=>promoteWork(db,candidate.work_id,1,{...contract,acceptance:[]},"invalid",4)).toThrow();
 expect(getWork(db,candidate.work_id)?.state).toBe("candidate");db.close();
});
