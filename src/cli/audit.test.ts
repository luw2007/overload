import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { audit } from "./audit";
import { initializeLedger } from "../ingest/ingest";

describe("ledger-only control audit",()=>{
 test("reports explicit effect and interruption observations without inventing unmeasured outcomes",()=>{const db=new Database(":memory:");initializeLedger(db);db.query("INSERT INTO applied_control_events VALUES (?,?,?)").run("e","h",100);db.query(`INSERT INTO control_attention(item_id,work_id,revision,state,effect_state,urgency,owner,conclusion,trigger,impact,recommendation,options,expires_at,defer_until,acknowledged_at,source_link,approval_id,consumer_owner,contract_revision,decision_mode,evidence,event_id,updated_at) VALUES ('i','w',1,'open','unknown','inbox','o','c','t','i',NULL,'[]',NULL,NULL,50,NULL,NULL,NULL,1,'human_only','{}','e',100)`).run();db.query("INSERT INTO control_attention_feedback VALUES (?,?,?,?,?,?)").run("f","i",1,0,"noise",100);const report=audit(db,{sample:0,sinceMs:100,now:150});expect(report.control).toMatchObject({projectedEvents:1,attentionOpened:1,effectsUnknown:1,acknowledgedOnly:1,feedbackNotUseful:1,feedbackUnmeasured:0});db.close();});
});
