import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMailbox } from "../decision-bot/mailbox";
import { AdapterService } from "./service";
import { getProgress } from "./progress";
import type {
 AgentRuntime,
 ChannelAdapter,
 ChannelMessage,
 DeliveryReceipt,
 ProgressMessage,
 RuntimeEvent,
 SessionHandle,
} from "./types";

const T0 = 1_700_000_000_000;
const ADDRESS = { instanceId: "fake", tenantId: "t", chatId: "oc_1", rootMessageId: "om_root" };

// A fake channel that records every progress call and lets a test script the next receipts.
function harness(opts: { silent?: (id: string) => boolean } = {}) {
 const db = openMailbox(join(mkdtempSync(join(tmpdir(), "progress-")), "control.db"));
 let clock = T0;
 const creates: ProgressMessage[] = [];
 const patches: { messageId: string; message: ProgressMessage; at: number }[] = [];
 const sent: ChannelMessage[] = [];
 const script = { create: [] as DeliveryReceipt[], patch: [] as DeliveryReceipt[] };
 const channel: ChannelAdapter = {
  kind: "fake",
  instanceId: "fake",
  capabilities: { update: true, actions: true },
  async start() {},
  async stop() {},
  async send(m) {
   sent.push(m);
   return { state: "sent", messageId: "m-" + sent.length };
  },
  async createProgress(m) {
   creates.push(m);
   return script.create.shift() ?? { state: "sent", messageId: "card-" + creates.length };
  },
  async updateProgress(messageId, m) {
   patches.push({ messageId, message: m, at: clock });
   return script.patch.shift() ?? { state: "sent", messageId };
  },
 };
 const handle = (sessionId: string): SessionHandle => ({
  reference: { runtimeKind: "test", sessionId, ownerId: "o", cwd: "/" },
  events: { async *[Symbol.asyncIterator]() { await Promise.withResolvers<void>().promise; } },
  async submit(t) { return { state: "accepted", commandId: t.turnId }; },
  async cancel(id) { return { state: "rejected", commandId: id }; },
  async close() {},
 });
 const runtime: AgentRuntime = {
  kind: "test",
  capabilities: { restore: false, answer: false, steer: false },
  async start(r) { return handle(r.sessionId); },
  async connect(r) { return handle(r.sessionId); },
 };
 const make = () =>
  new AdapterService(db, { runtime, channels: [channel], cwd: "/", authorize: () => "o", now: () => clock, silentTurn: opts.silent });
 let service = make();
 let n = 0;
 const turn = (id: string, state = "running") => {
  const cid = "c-" + id;
  db.run("INSERT INTO conversations(id,binding_key,address,owner_id,session_reference,created_at) VALUES(?,?,?,?,?,?)", [
   cid, "b-" + id, JSON.stringify(ADDRESS), "o",
   JSON.stringify({ runtimeKind: "test", sessionId: "s-" + id, ownerId: "o", cwd: "/" }), T0,
  ]);
  db.run("INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,created_at) VALUES(?,?,?,?,?,?)", [id, cid, 1, "SECRET user text", state, T0]);
  return cid;
 };
 const tool = (id: string, kind: "tool_started" | "tool_finished", name = "read") =>
  service.recordRuntimeEvent("c-" + id, { eventId: "e" + ++n, sessionId: "s-" + id, turnId: id, kind, toolName: name } as RuntimeEvent);
 const finish = (id: string, kind: "completed" | "failed" = "completed") =>
  service.recordRuntimeEvent("c-" + id, { eventId: "e" + ++n, sessionId: "s-" + id, turnId: id, kind, text: "done" } as RuntimeEvent);
 return {
  db, creates, patches, sent, script, turn, tool, finish,
  get service() { return service; },
  restart: () => { service = make(); },
  at: (ms: number) => { clock = T0 + ms; },
  tick: () => service.tick(),
  row: (id: string) => getProgress(db, id)!,
 };
}

test("one card for a whole turn; intermediate activity collapses into the latest snapshot", async () => {
 const h = harness();
 h.turn("t1");
 h.at(5_000);
 await h.tick();
 expect(h.creates).toHaveLength(0); // under 10s: no card
 for (let i = 0; i < 10; i++) { h.tool("t1", "tool_started"); h.tool("t1", "tool_finished"); }
 h.at(10_000);
 await h.tick();
 expect(h.creates).toHaveLength(1);
 expect(h.creates[0].address.rootMessageId).toBe("om_root");
 expect(h.creates[0].deliveryUuid).toBe(h.row("t1").create_uuid);
 expect(h.creates[0].text).toContain("已完成 10 个工具");
 // 20 more events inside the 5s gap: one desired view, nothing sent yet.
 const before = h.row("t1").desired_version;
 for (let i = 0; i < 10; i++) { h.tool("t1", "tool_started"); h.tool("t1", "tool_finished"); }
 h.at(12_000);
 await h.tick();
 expect(h.patches).toHaveLength(0);
 expect(h.row("t1").desired_version).toBe(before + 1);
 h.at(15_000);
 await h.tick();
 expect(h.patches).toHaveLength(1);
 expect(h.patches[0].message.text).toContain("已完成 20 个工具");
 expect(h.row("t1").sent_version).toBe(h.row("t1").desired_version);
 // same hash: another tick sends nothing
 h.at(16_000);
 await h.tick();
 expect(h.patches).toHaveLength(1);
 // terminal: result message plus a final PATCH, still one card
 h.finish("t1");
 h.at(17_000);
 await h.tick();
 expect(h.creates).toHaveLength(1);
 expect(h.patches.at(-1)!.message.title).toBe("已完成");
 expect(h.sent.map((m) => m.text)).toEqual(["done"]);
 for (const text of [...h.creates, ...h.patches.map((p) => p.message)].map((m) => m.title + m.text))
  expect(text).not.toContain("SECRET");
});

test("state transitions send after 1s, plain activity waits 5s", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.tool("t1", "tool_started");
 h.at(12_000);
 await h.tick();
 expect(h.patches).toHaveLength(0); // same state (running), 2s < 5s
 h.at(15_000);
 await h.tick();
 expect(h.patches).toHaveLength(1);
 h.finish("t1");
 h.at(15_500);
 await h.tick();
 expect(h.patches).toHaveLength(1); // terminal, but 0.5s < 1s
 h.at(16_000);
 await h.tick();
 expect(h.patches).toHaveLength(2);
});

test("stale view is sent without waiting for the 5s gap", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.at(15_000);
 h.tool("t1", "tool_started"); // activity at 15s
 h.at(20_000);
 await h.tick(); // patch at 20s
 h.at(135_000); // 120s idle
 await h.tick();
 const last = h.patches.at(-1)!;
 expect(last.message.title).toBe("疑似卡住");
 // stale right after a previous send (<5s) is not delayed by the activity gap
 expect(h.row("t1").view_state).toBe("stale");
});

test("global budget: 20 turns → 2 progress calls per second; results and decisions are not blocked", async () => {
 const h = harness();
 for (let i = 0; i < 20; i++) h.turn("t" + i);
 h.turn("done");
 h.finish("done"); // enqueues a result delivery
 h.at(10_000);
 await h.tick();
 expect(h.creates).toHaveLength(2);
 expect(h.sent.map((m) => m.text)).toEqual(["done"]); // result went out despite the exhausted budget
 await h.tick(); // same instant: window still full
 expect(h.creates).toHaveLength(2);
 h.at(10_500);
 await h.tick();
 expect(h.creates).toHaveLength(2);
 h.at(11_000);
 await h.tick();
 expect(h.creates).toHaveLength(4);
});

test("429 backs off by retryAfterMs; transient failures stop after 4 attempts", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.tool("t1", "tool_started");
 h.script.patch.push({ state: "retryable", reason: "rate_limited", retryAfterMs: 20_000 });
 h.at(15_000);
 await h.tick();
 expect(h.patches).toHaveLength(1);
 expect(h.row("t1").next_at).toBe(T0 + 35_000);
 h.at(34_000);
 await h.tick();
 expect(h.patches).toHaveLength(1);
 h.script.patch.push(
  { state: "retryable", reason: "not_connected" },
  { state: "retryable", reason: "not_connected" },
  { state: "retryable", reason: "not_connected" },
 );
 for (let t = 35_000, i = 0; i < 12; i++, t += 70_000) { h.at(t); await h.tick(); }
 const attempts = h.patches.length - 1; // minus the 429 one
 expect(h.row("t1").degraded).toBe(1);
 expect(h.patches.length).toBeLessThanOrEqual(4);
 expect(attempts).toBeGreaterThan(0);
});

test("message_not_found degrades the card; the final result is still sent", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.tool("t1", "tool_started");
 h.script.patch.push({ state: "failed", reason: "message_not_found" });
 h.at(15_000);
 await h.tick();
 expect(h.row("t1").degraded).toBe(1);
 h.finish("t1");
 h.at(20_000);
 await h.tick();
 expect(h.patches).toHaveLength(1); // no more progress calls
 expect(h.sent.map((m) => m.text)).toEqual(["done"]);
 expect(h.creates).toHaveLength(1);
});

test("unknown create degrades without a second card or plain-text fallback", async () => {
 const h = harness();
 h.turn("t1");
 h.script.create.push({ state: "unknown", reason: "timeout" });
 h.at(10_000);
 await h.tick();
 expect(h.row("t1")).toMatchObject({ create_state: "unknown", degraded: 1 });
 h.tool("t1", "tool_started");
 for (const ms of [20_000, 40_000]) { h.at(ms); await h.tick(); }
 expect(h.creates).toHaveLength(1);
 expect(h.patches).toHaveLength(0);
 expect(h.sent).toHaveLength(0);
 h.finish("t1");
 h.at(50_000);
 await h.tick();
 expect(h.sent.map((m) => m.text)).toEqual(["done"]);
});

test("a retryable create (server confirmed not created) is retried a limited number of times", async () => {
 const h = harness();
 h.turn("t1");
 h.script.create.push({ state: "retryable", reason: "rate_limited", retryAfterMs: 3_000 });
 h.at(10_000);
 await h.tick();
 expect(h.row("t1").create_state).toBe("none");
 h.at(12_000);
 await h.tick();
 expect(h.creates).toHaveLength(1);
 h.at(13_000);
 await h.tick();
 expect(h.creates).toHaveLength(2);
 expect(h.row("t1").create_state).toBe("sent");
});

test("PATCH cap: after 60 only the terminal PATCH goes out", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.db.run("UPDATE channel_progress SET patch_count=60 WHERE turn_id='t1'");
 h.tool("t1", "tool_started");
 h.at(20_000);
 await h.tick();
 expect(h.patches).toHaveLength(0);
 h.finish("t1");
 h.at(30_000);
 await h.tick();
 expect(h.patches).toHaveLength(1);
 expect(h.patches[0].message.title).toBe("已完成");
 h.at(60_000);
 await h.tick();
 expect(h.patches).toHaveLength(1);
});

test("a version that advances during the PATCH is not confirmed by it", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.tool("t1", "tool_started");
 const original = h.service.config.channels[0].updateProgress!;
 h.service.config.channels[0].updateProgress = async (id, m) => {
  h.tool("t1", "tool_finished"); // activity lands while the PATCH is in flight
  h.service.projectProgressViews();
  return original(id, m);
 };
 h.at(15_000);
 await h.tick();
 const row = h.row("t1");
 expect(row.desired_version).toBeGreaterThan(row.sent_version);
 h.service.config.channels[0].updateProgress = original;
 h.at(20_000);
 await h.tick();
 expect(h.row("t1").sent_version).toBe(h.row("t1").desired_version);
 expect(h.patches.at(-1)!.message.text).toContain("已完成 1 个工具");
});

test("silent turn never gets a card", async () => {
 const h = harness({ silent: () => true });
 h.turn("t1");
 h.at(30_000);
 await h.tick();
 expect(h.creates).toHaveLength(0);
});

test("turn already final at 10s: no card", async () => {
 const h = harness();
 h.turn("t1");
 h.finish("t1");
 h.at(10_000);
 await h.tick();
 expect(h.creates).toHaveLength(0);
 expect(h.sent).toHaveLength(1);
});

test("late tool event cannot turn a final card back into running", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.finish("t1");
 h.at(12_000);
 await h.tick();
 const version = h.row("t1").desired_version;
 h.tool("t1", "tool_started");
 h.at(20_000);
 await h.tick();
 expect(h.row("t1")).toMatchObject({ view_state: "completed", desired_version: version });
 expect(h.patches.at(-1)!.message.title).toBe("已完成");
});

test("restart: create in flight becomes unknown/degraded and is never re-created", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 h.service.projectProgressViews();
 h.db.run("UPDATE channel_progress SET create_state='sending',attempts=1 WHERE turn_id='t1'");
 h.restart();
 await h.service.start();
 expect(h.row("t1")).toMatchObject({ create_state: "unknown", degraded: 1 });
 h.at(30_000);
 await h.tick();
 expect(h.creates).toHaveLength(0);
});

test("restart: running turn with a lost owner becomes unknown and its card is closed out", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.db.run("DELETE FROM runtime_ownership");
 h.restart();
 await h.service.start();
 h.at(20_000);
 await h.tick();
 expect(h.db.query("SELECT state,reason FROM conversation_turns WHERE id='t1'").get()).toEqual({ state: "unknown", reason: "owner_lost_before_receipt" });
 expect(h.patches.at(-1)!.message.title).toBe("结果未知");
 expect(h.row("t1").sent_version).toBe(h.row("t1").desired_version);
});

test("restart: completed turn whose last PATCH never went out gets its terminal PATCH", async () => {
 const h = harness();
 h.turn("t1");
 h.at(10_000);
 await h.tick();
 h.finish("t1");
 // the process died before the terminal view was even projected
 h.restart();
 await h.service.start();
 h.at(20_000);
 await h.tick();
 expect(h.creates).toHaveLength(1);
 expect(h.patches.at(-1)!.message.title).toBe("已完成");
});
