import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { enqueueControlEvent, ensureOutbox } from "./outbox";

describe("control outbox identity",()=>{
 test("retries retain stable event id and reject changed payload",()=>{const db=new Database(":memory:");ensureOutbox(db);const input={entity_id:"i",entity_version:1,kind:"attention.created",payload:{x:1}};const a=enqueueControlEvent(db,input,1);const b=enqueueControlEvent(db,input,2);expect(b).toBe(a);expect((db.query("SELECT COUNT(*) n FROM control_outbox").get() as {n:number}).n).toBe(1);expect(()=>enqueueControlEvent(db,{...input,payload:{x:2}},3)).toThrow();db.close();});
});
