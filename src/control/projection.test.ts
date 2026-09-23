import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { initializeLedger } from "../ingest/ingest";
import { applyControlEvent } from "./projection";

function canonical(value:unknown):string {if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return`[${value.map(canonical).join(",")}]`;const row=value as Record<string,unknown>;return`{${Object.keys(row).sort().map(k=>`${JSON.stringify(k)}:${canonical(row[k])}`).join(",")}}`;}
function detail(revision=1){const attention={item_id:"i",work_id:"w",revision,state:"open",effect_state:"not_started",urgency:"inbox",conclusion:"c",trigger:"t",impact:"i",recommendation:null,options:[],owner:"o",expires_at:null,defer_until:null,acknowledged_at:null,source_link:null,approval_id:null,consumer_owner:null,contract_revision:1,decision_mode:"human_only",evidence:{},created_at:1,updated_at:revision};const payload={attention};return{event_id:`e${revision}`,payload_hash:createHash("sha256").update(canonical(payload)).digest("hex"),payload};}
describe("control projection durable dedup",()=>{
 test("same event is idempotent and newer revision wins",()=>{const db=new Database(":memory:");initializeLedger(db);applyControlEvent(db,detail(),1);applyControlEvent(db,detail(),2);applyControlEvent(db,detail(2),3);expect(db.query("SELECT revision FROM control_attention WHERE item_id='i'").get()).toEqual({revision:2});expect((db.query("SELECT COUNT(*) n FROM applied_control_events").get() as {n:number}).n).toBe(2);db.close();});
 test("same identity with another payload fails safe",()=>{const db=new Database(":memory:");initializeLedger(db);const first=detail();applyControlEvent(db,first,1);expect(()=>applyControlEvent(db,{...detail(2),event_id:first.event_id},2)).toThrow();db.close();});
});
