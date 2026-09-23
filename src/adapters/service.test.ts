import { expect, test } from "bun:test";
import { openMailbox } from "../decision-bot/mailbox";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterService } from "./service";
import type {
 AgentRuntime,
 SessionHandle,
 ChannelAdapter,
 ChannelEvent,
 ChannelMessage,
 SessionReference,
} from "./types";
function harness() {
 const root = mkdtempSync(join(tmpdir(), "adapter-core-")),
  db = openMailbox(join(root, "control.db"));
 const submitted: string[] = [],
  sent: ChannelMessage[] = [],
  handles = new Map<string, SessionHandle>();
 const runtime: AgentRuntime = {
  kind: "test",
  capabilities: { restore: false, answer: true, steer: false },
  async start(r) {
   const handle: SessionHandle = {
    reference: { ...r, runtimeKind: "test" },
    events: {
     async *[Symbol.asyncIterator]() {
      await Promise.withResolvers<void>().promise;
     },
    },
    async submit(t) {
     submitted.push(t.turnId);
     return { state: "accepted", commandId: t.turnId };
    },
    async cancel(id) {
     return { state: "rejected", commandId: id };
    },
    async answer(id) {
     return { state: "accepted", commandId: id };
    },
    async close() {},
   };
   handles.set(r.sessionId, handle);
   return handle;
  },
  async connect(r) {
   const h = handles.get(r.sessionId);
   if (!h) throw new Error("not owned");
   return h;
  },
 };
 const channel: ChannelAdapter = {
  kind: "test",
  instanceId: "channel-one",
  capabilities: { update: true, actions: true },
  async start() {},
  async stop() {},
  async send(m) {
   sent.push(m);
   return {
    state: "sent",
    messageId: m.replaceMessageId ?? "message-" + sent.length,
   };
  },
 };
 const service = new AdapterService(db, {
  runtime,
  channels: [channel],
  cwd: root,
  authorize: (i) => (i.userId === "owner" ? "operator" : null),
 });
 const event = (id: string, chatId = "chat"): ChannelEvent => ({
  kind: "message",
  eventId: id,
  identity: { instanceId: "channel-one", tenantId: "tenant", userId: "owner" },
  address: { instanceId: "channel-one", tenantId: "tenant", chatId },
  messageId: id,
  text: "question " + id,
  receivedAt: Date.now(),
 });
 return {
  root,
  db,
  service,
  event,
  submitted,
  sent,
  runtime,
  channel,
  async close() {
   await service.stop();
   db.close();
   rmSync(root, { recursive: true, force: true });
  },
 };
}
test("commands reply through delivery queue and do not create turns", async () => {
 const h = harness();
 try {
  h.service.config.allowedModels = ["openai/gpt-5", "anthropic/claude"];
  await h.service.accept({ ...h.event("help"), text: "/help" });
  await h.service.accept({ ...h.event("model"), text: "/model" });
  await h.service.accept({ ...h.event("status"), text: "/model status" });
  await h.service.accept({ ...h.event("provider"), text: "/model openai" });
  await h.service.accept({ ...h.event("unknown"), text: "/model unknown" });
  await h.service.accept({ ...h.event("set"), text: "/model openai/gpt-5" });
  await h.service.tick();
  expect(
   h.db.query("SELECT count(*) AS count FROM conversation_turns").get(),
  ).toEqual({ count: 0 });
  expect(h.db.query("SELECT provider,model FROM conversations").get()).toEqual({
   provider: "openai",
   model: "gpt-5",
  });
  expect(h.sent.map((message) => message.text)).toEqual([
   "/help：查看帮助\n/new：保留历史；下一条普通消息启动全新运行时\n/model、/model status：查看当前生效模型\n/model <provider>：列出该 provider 可用模型\n/model <provider>/<model>：设置下次全新运行时模型\n/cancel：取消当前运行\n可用模型：openai/gpt-5、anthropic/claude",
   "当前生效模型：default",
   "当前生效模型：default",
   "openai 可用模型：openai/gpt-5",
   "unknown 没有配置模型。",
   "下次运行模型：openai/gpt-5",
  ]);
 } finally {
  await h.close();
 }
});
test("new closes owned runtime and preserves turns", async () => {
 const h = harness();
 try {
  await h.service.accept(h.event("first"));
  await h.service.tick();
  h.db.run("UPDATE conversation_turns SET state='completed'");
  await h.service.accept({ ...h.event("new"), text: "/new" });
  await h.service.tick();
  expect(
   h.db.query("SELECT session_reference FROM conversations").get(),
  ).toEqual({ session_reference: null });
  expect(
   h.db.query("SELECT count(*) AS count FROM conversation_turns").get(),
  ).toEqual({ count: 1 });
  expect(
   h.db.query("SELECT count(*) AS count FROM runtime_ownership").get(),
  ).toEqual({ count: 0 });
 } finally {
  await h.close();
 }
});
test("new rejects unresolved runtime states", async () => {
 const h = harness();
 try {
  await h.service.accept(h.event("first"));
  await h.service.tick();
  for (const state of [
   "submitting",
   "running",
   "blocked",
   "cancelling",
   "unknown",
  ]) {
   h.db.run("UPDATE conversation_turns SET state=?", [state]);
   await h.service.accept({ ...h.event("new-" + state), text: "/new" });
  }
  await h.service.tick();
  expect(h.sent.map((message) => message.text)).toEqual([
   "当前运行未结束，不能新建会话。",
   "当前运行未结束，不能新建会话。",
   "当前运行未结束，不能新建会话。",
   "当前运行未结束，不能新建会话。",
   "当前运行未结束，不能新建会话。",
  ]);
  expect(
   h.db.query("SELECT session_reference FROM conversations").get(),
  ).toEqual({ session_reference: expect.any(String) });
 } finally {
  await h.close();
 }
});
test("requester authorization may submit text but cannot decide cards", async () => {
 const h = harness();
 try {
  const requester = {
   ...h.event("requester"),
   identity: {
    instanceId: "channel-one",
    tenantId: "tenant",
    userId: "requester",
   },
  };
  h.service.config.authorize = (i) =>
   i.userId === "requester"
    ? { ownerId: "operator", role: "requester" }
    : "operator";
  await h.service.accept(requester);
  expect(h.db.query("SELECT text FROM conversation_turns").get()).toEqual({
   text: "question requester",
  });
  await expect(
   h.service.accept({
    kind: "decision",
    eventId: "decision",
    identity: requester.identity,
    address: requester.address,
    messageId: "card",
    receivedAt: Date.now(),
    itemId: "missing",
    revision: 1,
    answer: "approve",
   }),
  ).rejects.toThrow("decision_owner_mismatch");
 } finally {
  await h.close();
 }
});

test("delivery uuid is stable across retry and terminal results reply to their source", async () => {
 const h = harness();
 try {
  let attempts = 0;
  h.channel.send = async (message) => {
   h.sent.push(message);
   return ++attempts === 1
    ? { state: "retryable", reason: "rate_limited" }
    : { state: "sent", messageId: "sent" };
  };
  await h.service.start();
  await h.service.accept(h.event("source"));
  await h.service.tick();
  const c = h.db
   .query("SELECT id,session_reference FROM conversations")
   .get() as { id: string; session_reference: string };
  const reference = JSON.parse(c.session_reference) as SessionReference;
  h.service.recordRuntimeEvent(c.id, {
   eventId: "done",
   sessionId: reference.sessionId,
   turnId: h.submitted[0],
   kind: "completed",
   text: "done",
  });
  await h.service.tick();
  h.db.run("UPDATE channel_deliveries SET next_at=0 WHERE state='retryable'");
  await h.service.tick();
  const deliveries = h.sent.filter((message) => message.text === "done");
  expect(deliveries).toHaveLength(2);
  expect(deliveries[0].deliveryUuid).toBe(deliveries[1].deliveryUuid);
  expect(deliveries[0].deliveryUuid!.length).toBeLessThanOrEqual(50);
  expect(deliveries[0]).toMatchObject({
   replyTo: "source",
   importance: "important",
   terminal: true,
  });
 } finally {
  await h.close();
 }
});

test("terminal completion before reaction acknowledgement converges to DONE", async () => {
 const h = harness();
 try {
  const reactions: string[] = [];
  let attempts = 0;
  h.channel.addReaction = async (_messageId, emoji) => {
   reactions.push(emoji);
   if (emoji === "GoGoGo" && ++attempts === 1)
    throw new Error("transient reaction failure");
   return emoji === "GoGoGo" ? "reaction-id" : "done-id";
  };
  h.channel.removeReaction = async (_messageId, reactionId) => {
   reactions.push("remove:" + reactionId);
  };
  await h.service.start();
  await h.service.accept(h.event("source"));
  await h.service.tick();
  const conversation = h.db
   .query("SELECT id,session_reference FROM conversations")
   .get() as { id: string; session_reference: string };
  const reference = JSON.parse(
   conversation.session_reference,
  ) as SessionReference;
  h.service.recordRuntimeEvent(conversation.id, {
   eventId: "done-before-ack",
   sessionId: reference.sessionId,
   turnId: h.submitted[0],
   kind: "completed",
  });
  await h.service.tick();
  expect(reactions).toEqual(["GoGoGo", "GoGoGo", "remove:reaction-id", "DONE"]);
  expect(
   h.db.query("SELECT reaction_state FROM conversation_turns").get(),
  ).toEqual({ reaction_state: "done" });
 } finally {
  await h.close();
 }
});

test("duplicate messages execute once and same conversation serializes turns", async () => {
 const f = harness();
 try {
  await f.service.start();
  await f.service.accept(f.event("one"));
  await f.service.tick();
  await f.service.accept(f.event("one"));
  await f.service.accept(f.event("two"));
  await f.service.tick();
  expect(f.submitted).toHaveLength(1);
  const c = f.db
   .query("SELECT id,session_reference FROM conversations")
   .get() as { id: string; session_reference: string };
  const ref = JSON.parse(c.session_reference) as SessionReference;
  f.service.recordRuntimeEvent(c.id, {
   eventId: "done1",
   sessionId: ref.sessionId,
   turnId: f.submitted[0],
   kind: "completed",
   text: "first result",
  });
  await f.service.tick();
  expect(f.submitted).toHaveLength(2);
  expect(f.db.query("SELECT COUNT(*) n FROM conversations").get()).toEqual({
   n: 1,
  });
  expect(f.sent[0].text).toBe("first result");
 } finally {
  await f.close();
 }
});
test("unknown fences queued work and owner rejection does not persist event", async () => {
 const f = harness();
 try {
  await f.service.start();
  const evil = {
   ...f.event("evil"),
   identity: {
    instanceId: "channel-one",
    tenantId: "tenant",
    userId: "intruder",
   },
  };
  await expect(f.service.accept(evil)).rejects.toThrow("unauthorized");
  await f.service.accept(f.event("one"));
  await f.service.tick();
  const c = f.db
   .query("SELECT id,session_reference FROM conversations")
   .get() as { id: string; session_reference: string };
  const ref = JSON.parse(c.session_reference) as SessionReference;
  f.service.recordRuntimeEvent(c.id, {
   eventId: "lost",
   sessionId: ref.sessionId,
   turnId: f.submitted[0],
   kind: "unknown",
  });
  await f.service.accept(f.event("two"));
  await f.service.tick();
  expect(f.submitted).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) n FROM channel_inbound").get()).toEqual({
   n: 2,
  });
 } finally {
  await f.close();
 }
});
test("native approval consumes once and updates original decision card with effect", async () => {
 const f = harness();
 try {
  await f.service.start();
  await f.service.accept(f.event("one"));
  await f.service.tick();
  const c = f.db
   .query("SELECT id,session_reference FROM conversations")
   .get() as { id: string; session_reference: string };
  const ref = JSON.parse(c.session_reference) as SessionReference;
  f.service.recordRuntimeEvent(c.id, {
   eventId: "blocked",
   sessionId: ref.sessionId,
   turnId: f.submitted[0],
   kind: "blocked",
   requestId: "q",
   requestMethod: "confirm",
   options: ["yes", "no"],
   text: "Proceed?",
  });
  await f.service.tick();
  const card = f.sent.find((m) => m.decision);
  expect(card?.decision?.options).toEqual(["yes", "no"]);
  const input = f.event("approve");
  await f.service.accept({
   ...input,
   kind: "decision",
   itemId: card!.decision!.itemId,
   revision: card!.decision!.revision,
   answer: "yes",
  });
  await f.service.tick();
  f.service.recordRuntimeEvent(c.id, {
   eventId: "done",
   sessionId: ref.sessionId,
   turnId: f.submitted[0],
   kind: "completed",
   text: "verified",
  });
  await f.service.tick();
  const updates = f.sent.filter((m) => m.decision);
  expect(updates.at(-1)?.replaceMessageId).toBeTruthy();
  expect(updates.at(-1)?.decision?.state).toBe("resolved / succeeded");
  expect(
   f.db
    .query(
     "SELECT message_id,last_revision,last_state FROM channel_card_bindings WHERE item_id=?",
    )
    .get(card!.decision!.itemId),
  ).toEqual({
   message_id: updates.at(-1)?.replaceMessageId,
   last_revision: updates.at(-1)?.decision?.revision,
   last_state: "resolved / succeeded",
  });
  expect(f.db.query("SELECT COUNT(*) n FROM decision_receipts").get()).toEqual({
   n: 1,
  });
 } finally {
  await f.close();
 }
});
test("restart retains binding and does not re-submit unknown work", async () => {
 const f = harness();
 let next: AdapterService | undefined;
 try {
  await f.service.start();
  await f.service.accept(f.event("one"));
  await f.service.tick();
  const original = f.db
   .query("SELECT session_reference FROM conversations")
   .get();
  await f.service.stop();
  next = new AdapterService(f.db, {
   runtime: f.runtime,
   channels: [f.channel],
   cwd: f.root,
   authorize: () => "operator",
  });
  await next.start();
  await next.accept(f.event("two"));
  await next.tick();
  expect(f.submitted).toHaveLength(1);
  expect(
   f.db.query("SELECT session_reference FROM conversations").get(),
  ).toEqual(original);
  expect(
   f.db.query("SELECT state FROM conversation_turns WHERE sequence=1").get(),
  ).toEqual({ state: "unknown" });
 } finally {
  await next?.stop();
  await f.close();
 }
});
test("two conversations have distinct sessions and reject cross-session events", async () => {
 const f = harness();
 try {
  await f.service.start();
  await f.service.accept(f.event("a", "chat-a"));
  await f.service.accept(f.event("b", "chat-b"));
  await f.service.tick();
  const rows = f.db
   .query("SELECT id,session_reference FROM conversations ORDER BY id")
   .all() as { id: string; session_reference: string }[];
  const a = JSON.parse(rows[0].session_reference) as SessionReference,
   b = JSON.parse(rows[1].session_reference) as SessionReference;
  expect(a.sessionId).not.toBe(b.sessionId);
  expect(() =>
   f.service.recordRuntimeEvent(rows[0].id, {
    eventId: "foreign",
    sessionId: b.sessionId,
    kind: "completed",
   }),
  ).toThrow("runtime_session_mismatch");
  expect(f.submitted).toHaveLength(2);
 } finally {
  await f.close();
 }
});
test("temporary delivery retries but unknown send never automatically repeats", async () => {
 const f = harness();
 try {
  await f.service.start();
  await f.service.accept(f.event("one"));
  await f.service.tick();
  const c = f.db
   .query("SELECT id,session_reference FROM conversations")
   .get() as { id: string; session_reference: string };
  const ref = JSON.parse(c.session_reference) as SessionReference;
  f.service.recordRuntimeEvent(c.id, {
   eventId: "done",
   sessionId: ref.sessionId,
   turnId: f.submitted[0],
   kind: "completed",
   text: "result",
  });
  let sends = 0;
  f.channel.send = async () => {
   sends++;
   return sends === 1
    ? { state: "retryable", reason: "rate_limited" }
    : { state: "unknown", reason: "lost_response" };
  };
  await f.service.flush();
  expect(sends).toBe(1);
  f.db.run("UPDATE channel_deliveries SET next_at=0");
  await f.service.flush();
  expect(sends).toBe(2);
  await f.service.flush();
  expect(sends).toBe(2);
  expect(f.db.query("SELECT state FROM channel_deliveries").get()).toEqual({
   state: "unknown",
  });
 } finally {
  await f.close();
 }
});
test("channel cancellation never becomes an LLM prompt and fences queued work", async () => {
 const h = harness();
 try {
  await h.service.start();
  await h.service.accept(h.event("run"));
  await h.service.tick();
  const c = h.db.query("SELECT * FROM conversations").get() as {
   id: string;
   session_reference: string;
  };
  const reference = JSON.parse(c.session_reference) as SessionReference;
  const handle = await h.runtime.connect(reference);
  let cancelled = "";
  handle.cancel = async (id) => {
   cancelled = id;
   return { state: "accepted", commandId: id };
  };
  await h.service.accept({ ...h.event("cancel"), text: "/cancel" });
  await h.service.accept(h.event("next"));
  await h.service.tick();
  expect(cancelled).toBe(h.submitted[0]);
  expect(h.submitted).toHaveLength(1);
  h.service.recordRuntimeEvent(c.id, {
   eventId: "cancelled-terminal",
   sessionId: reference.sessionId,
   turnId: cancelled,
   kind: "failed",
   reason: "aborted",
  });
  await h.service.tick();
  expect(h.submitted).toHaveLength(1);
  expect(
   h.db.query("SELECT state FROM conversation_turns WHERE id=?").get(cancelled),
  ).toEqual({ state: "unknown" });
 } finally {
  await h.close();
 }
});
