import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, controlPayloadHash, ControlEventVerificationError, enqueueControlEvent, ensureOutbox, publishControlEvents } from "./outbox";
import { initializeLedger } from "../ingest/ingest";
import { reduceJournal } from "../ingest/reducer";

describe("control outbox identity",()=>{
 test("retries retain stable event id and reject changed payload",()=>{const db=new Database(":memory:");ensureOutbox(db);const input={entity_id:"i",entity_version:1,kind:"attention.created",payload:{x:1}};const a=enqueueControlEvent(db,input,1);const b=enqueueControlEvent(db,input,2);expect(b).toBe(a);expect((db.query("SELECT COUNT(*) n FROM control_outbox").get() as {n:number}).n).toBe(1);expect(()=>enqueueControlEvent(db,{...input,payload:{x:2}},3)).toThrow();db.close();});
 test("canonical payload identity ignores object insertion order",()=>{const db=new Database(":memory:");ensureOutbox(db);const a=enqueueControlEvent(db,{entity_id:"i",entity_version:1,kind:"attention.updated",payload:{z:1,nested:{b:2,a:3}}},1);const b=enqueueControlEvent(db,{entity_id:"i",entity_version:1,kind:"attention.updated",payload:{nested:{a:3,b:2},z:1}},2);expect(b).toBe(a);expect(canonicalJson({z:1,a:2})).toBe('{"a":2,"z":1}');db.close();});
});

describe("canonical JSON has JSON.stringify value semantics", () => {
  test("non-JSON members normalize exactly like a JSON round trip", () => {
    const value = { b: undefined, a: [undefined, () => 1, NaN, Infinity, 1], f: () => 1, s: Symbol("s"), d: new Date(0), n: { z: null, y: undefined } };
    const text = canonicalJson(value);
    expect(text).toBe('{"a":[null,null,null,null,1],"d":"1970-01-01T00:00:00.000Z","n":{"z":null}}');
    expect(canonicalJson(JSON.parse(JSON.stringify(value)))).toBe(text);
    expect(controlPayloadHash({ x: undefined, y: 1 })).toBe(controlPayloadHash({ y: 1 }));
  });
  test("values JSON cannot represent are rejected with the typed verification error", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    for (const bad of [undefined, () => 1, { n: 1n }, cyclic]) expect(() => canonicalJson(bad)).toThrow(ControlEventVerificationError);
  });
});

describe("outbox poison rows never block later rows", () => {
  test("enqueueing {x:undefined} stores valid JSON and a later event still publishes", () => {
    const db = new Database(":memory:"); ensureOutbox(db);
    enqueueControlEvent(db, { entity_id: "a", entity_version: 1, kind: "k", payload: { x: undefined } }, 1);
    enqueueControlEvent(db, { entity_id: "b", entity_version: 1, kind: "k", payload: { x: 1 } }, 2);
    const emitted: Record<string, unknown>[] = [];
    expect(publishControlEvents(db, "/nonexistent/ledger.db", (detail) => emitted.push(detail), 10)).toEqual({ published: 2, delivered: 0, rejected: 0 });
    expect(emitted.map((detail) => [detail.entity_id, detail.payload])).toEqual([["a", {}], ["b", { x: 1 }]]);
    db.close();
  });
  test("a legacy non-JSON row is made terminal and never re-leased; rows behind it publish", () => {
    const db = new Database(":memory:"); ensureOutbox(db);
    const poison = enqueueControlEvent(db, { entity_id: "a", entity_version: 1, kind: "k", payload: { x: 0 } }, 1);
    db.query(`UPDATE control_outbox SET payload='{"x":undefined}' WHERE event_id=?`).run(poison);
    enqueueControlEvent(db, { entity_id: "b", entity_version: 1, kind: "k", payload: { x: 1 } }, 2);
    const emitted: unknown[] = [];
    expect(publishControlEvents(db, "/nonexistent/ledger.db", (detail) => emitted.push(detail.entity_id), 10)).toEqual({ published: 1, delivered: 0, rejected: 1 });
    expect(emitted).toEqual(["b"]);
    expect(db.query("SELECT source FROM control_outbox_rejections WHERE event_id=?").get(poison)).toEqual({ source: "producer" });
    expect(publishControlEvents(db, "/nonexistent/ledger.db", (detail) => emitted.push(detail.entity_id), 100_000)).toEqual({ published: 1, delivered: 0, rejected: 0 });
    expect(emitted).toEqual(["b", "b"]); // b is unconfirmed so it is retried after its lease; the poison row never is
    db.close();
  });
});

describe("ledger rejection is terminal for the publisher", () => {
  test("publish → reduce → publish yields one gap and no re-emit", () => {
    const dir = mkdtempSync(join(tmpdir(), "overload-outbox-"));
    try {
      const ledgerPath = join(dir, "ledger.db");
      const ledger = new Database(ledgerPath); initializeLedger(ledger);
      const control = new Database(":memory:"); ensureOutbox(control);
      // A snapshot the ledger projection refuses deterministically (unknown Work state).
      const bad = enqueueControlEvent(control, { entity_id: "w1", entity_version: 1, kind: "work.created", work_id: "w1", payload: { work: { work_id: "w1", revision: 1, state: "bogus", updated_at: 1 } } }, 1);
      let seq = 0;
      const emit = (detail: Record<string, unknown>) => {
        seq++;
        ledger.query(`INSERT INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail) VALUES ('local','control',?,?,'local:overload:control','control','control_event',?)`)
          .run(seq, seq, JSON.stringify(detail));
      };
      const gaps = () => ledger.query("SELECT COUNT(*) AS n FROM coverage_gaps WHERE reason='control_event_rejected'").get();

      expect(publishControlEvents(control, ledgerPath, emit, 10)).toEqual({ published: 1, delivered: 0, rejected: 0 });
      reduceJournal(ledger);
      expect(ledger.query("SELECT event_id, reason FROM rejected_control_events").all()).toEqual([{ event_id: bad, reason: `invalid work snapshot: ${bad}` }]);

      for (const now of [40_000, 80_000, 120_000]) {
        expect(publishControlEvents(control, ledgerPath, emit, now).published).toBe(0);
        reduceJournal(ledger);
      }
      expect(ledger.query("SELECT COUNT(*) AS n FROM journal").get()).toEqual({ n: 1 });
      expect(gaps()).toEqual({ n: 1 });
      expect(control.query("SELECT source, reason FROM control_outbox_rejections WHERE event_id=?").get(bad)).toEqual({ source: "ledger", reason: `invalid work snapshot: ${bad}` });
      expect(control.query("SELECT delivered_at IS NOT NULL AS terminal FROM control_outbox WHERE event_id=?").get(bad)).toEqual({ terminal: 1 });

      // A copy already in flight (republished before the verdict reached the publisher) adds no journal-derived gap.
      const detail = JSON.parse((ledger.query("SELECT detail FROM journal").get() as { detail: string }).detail);
      emit(detail);
      reduceJournal(ledger);
      expect(gaps()).toEqual({ n: 1 });
      ledger.close(); control.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
