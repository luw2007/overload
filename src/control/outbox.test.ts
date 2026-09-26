import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { canonicalJson, enqueueControlEvent, ensureOutbox } from "./outbox";

describe("control outbox identity",()=>{
 test("retries retain stable event id and reject changed payload",()=>{const db=new Database(":memory:");ensureOutbox(db);const input={entity_id:"i",entity_version:1,kind:"attention.created",payload:{x:1}};const a=enqueueControlEvent(db,input,1);const b=enqueueControlEvent(db,input,2);expect(b).toBe(a);expect((db.query("SELECT COUNT(*) n FROM control_outbox").get() as {n:number}).n).toBe(1);expect(()=>enqueueControlEvent(db,{...input,payload:{x:2}},3)).toThrow();db.close();});
 test("canonical payload identity ignores object insertion order",()=>{const db=new Database(":memory:");ensureOutbox(db);const a=enqueueControlEvent(db,{entity_id:"i",entity_version:1,kind:"attention.updated",payload:{z:1,nested:{b:2,a:3}}},1);const b=enqueueControlEvent(db,{entity_id:"i",entity_version:1,kind:"attention.updated",payload:{nested:{a:3,b:2},z:1}},2);expect(b).toBe(a);expect(canonicalJson({z:1,a:2})).toBe('{"a":2,"z":1}');db.close();});
});
