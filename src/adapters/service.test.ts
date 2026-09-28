import { expect, test } from "bun:test";
import { openMailbox } from "../decision-bot/mailbox";
import { createWork, getAttention, projectAttentionMaterial, upsertAttention } from "../control/store";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterService } from "./service";
import { createWork, upsertAttention } from "../control/store";
import { Database } from "bun:sqlite";
import { startWebServer } from "../web/server";
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
test("queued turns restore a stopped runtime and submit only once", async () => {
 const h = harness();
 try {
  await h.service.start();
  await h.service.accept(h.event("first"));
  await h.service.tick();
  const c = h.db.query("SELECT id,session_reference FROM conversations").get() as { id: string; session_reference: string };
  const reference = JSON.parse(c.session_reference) as SessionReference;
  h.service.recordRuntimeEvent(c.id, {
   eventId: "first-complete", sessionId: reference.sessionId,
   turnId: h.submitted[0], kind: "completed", text: "done",
  });
  await h.service.accept(h.event("second"));
  await h.service.stop();
  const resumed = new AdapterService(h.db, {
   runtime: h.runtime, channels: [h.channel], cwd: h.root,
   authorize: (identity) => identity.userId === "owner" ? "operator" : null,
  });
  let restores = 0;
  Object.assign(h.runtime, {
   capabilities: { restore: true, answer: true, steer: false },
   async connect() { throw new Error("runtime_not_live"); },
   async restore() { restores++; return await this.start(reference); },
  });
  await resumed.start();
  await resumed.tick();
  expect(restores).toBe(1);
  expect(h.submitted).toHaveLength(2);
  expect(h.db.query("SELECT sequence,state FROM conversation_turns ORDER BY sequence").all()).toEqual([
   { sequence: 1, state: "completed" },
   { sequence: 2, state: "running" },
  ]);
  await resumed.stop();
 } finally {
  await h.close();
 }
});

test("a slow thread does not block another thread in the same chat", async () => {
 const h = harness();
 const started = Promise.withResolvers<void>();
 const release = Promise.withResolvers<void>();
 const secondSubmitted = Promise.withResolvers<void>();
 const originalStart = h.runtime.start.bind(h.runtime);
 h.runtime.start = async (request) => {
  const conversation = h.db.query("SELECT binding_key FROM conversations WHERE id=?").get(request.ownerId) as { binding_key: string };
  if (JSON.parse(conversation.binding_key)[3] === "thread-one") {
   started.resolve();
   await release.promise;
   return originalStart(request);
  }
  const handle = await originalStart(request);
  const originalSubmit = handle.submit.bind(handle);
  handle.submit = async (turn) => {
   const receipt = await originalSubmit(turn);
   secondSubmitted.resolve();
   return receipt;
  };
  return handle;
 };
 try {
  await h.service.accept({ ...h.event("first"), address: { ...h.event("first").address, threadId: "thread-one" } });
  await h.service.accept({ ...h.event("second"), address: { ...h.event("second").address, threadId: "thread-two" } });
  const tick = h.service.tick();
  await started.promise;
  await secondSubmitted.promise;
  expect(h.submitted).toContain(h.db.query("SELECT id FROM conversation_turns WHERE source_message_id='second'").get()?.id);
  release.resolve();
  await tick;
  expect(h.submitted).toHaveLength(2);
 } finally {
  release.resolve();
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
test("generic channel decisions resolve with trusted revision and material tokens", async () => {
 const h = harness();
 try {
  await h.service.start();
  await h.service.accept(h.event("one"));
  const conversation = h.db.query("SELECT id FROM conversations").get();
  if (!conversation || typeof conversation !== "object" || !("id" in conversation)
   || typeof conversation.id !== "string") throw new Error("missing conversation");
  const work = createWork(h.db, {
   title: "generic decision",
   source: "test",
   contract: {
    objective: "choose",
    acceptance: [{ id: "check", kind: "check", description: "choice applied" }],
    non_goals: [],
    scope: { cwd: h.root },
    budget: {},
    stop_conditions: [],
    decision_owner: "operator",
   },
  });
  h.db.run("UPDATE conversations SET work_id=? WHERE id=?", [work.work_id, conversation.id]);
  const item = upsertAttention(h.db, {
   item_id: "generic", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox",
   conclusion: "Continue?", trigger: "choice", impact: "work changes", recommendation: "continue",
   options: ["continue", "stop"], owner: "operator", expires_at: null, source_link: null,
   approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {},
  });
  projectAttentionMaterial(h.db, item.item_id, {
   risk: item.impact,
   decision: item.conclusion,
   option_effects: item.options.map((option) => ({ option, effect: option })),
   decisive_evidence: [],
   validity: { expires_at: null, expired: false },
   consequence: item.impact,
  });
  h.db.run("INSERT INTO channel_card_bindings(item_id,conversation_id,message_id) VALUES(?,?,?)", [item.item_id, conversation.id, "card-generic"]);
  const input = h.event("choose");
  await h.service.accept({ ...input, messageId: "card-generic", kind: "decision", itemId: item.item_id, revision: item.revision, answer: "continue" });
  expect(getAttention(h.db, item.item_id)).toMatchObject({ state: "resolved", effect_state: "succeeded" });
  expect(h.db.query("SELECT COUNT(*) n FROM channel_inbound WHERE event_id='choose'").get()).toEqual({ n: 1 });
 } finally {
  await h.close();
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
test("native approval projects success but keeps independent human acceptance visible", async () => {
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
  const cardMessage = (
   f.db
    .query("SELECT message_id FROM channel_card_bindings WHERE item_id=?")
    .get(card!.decision!.itemId) as { message_id: string }
  ).message_id;
  const input = f.event("approve");
  await f.service.accept({
   ...input,
   messageId: cardMessage,
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
  expect(updates.at(-1)?.decision?.state).toBe("Applying");
  expect(
   f.db
    .query(
     "SELECT message_id,last_revision,last_state FROM channel_card_bindings WHERE item_id=?",
    )
    .get(card!.decision!.itemId),
  ).toEqual({
   message_id: updates.at(-1)?.replaceMessageId,
   last_revision: updates.at(-1)?.decision?.revision,
   last_state: "Applying",
  });
  expect(f.db.query("SELECT COUNT(*) n FROM decision_receipts").get()).toEqual({
   n: 1,
  });
  const attentionRow = f.db.query("SELECT state,effect_state,evidence FROM control_attention WHERE item_id=?")
   .get(card!.decision!.itemId);
  expect(attentionRow).toMatchObject({ state: "applying", effect_state: "succeeded" });
  if (!attentionRow || typeof attentionRow !== "object" || !("evidence" in attentionRow)
   || typeof attentionRow.evidence !== "string") throw new Error("missing attention evidence");
  const evidence = JSON.parse(attentionRow.evidence) as Record<string, unknown>;
  expect(evidence.remaining_responsibility).toBe("Operator reviews returned execution evidence");
  expect(evidence.occurred_effects).toEqual([
   expect.objectContaining({ kind: "q", state: "succeeded", evidence: expect.objectContaining({ runtime_event: "done" }) }),
  ]);
  expect(evidence.effect_projection).toMatchObject({
   receipt_id: expect.any(String),
   tool_call_id: "q",
   state: "succeeded",
   audit_link: expect.objectContaining({
    work_id: expect.any(String),
    item_id: card!.decision!.itemId,
    approval_id: card!.decision!.itemId,
    outbox_event_id: expect.any(String),
   }),
  });
  const projected = f.db.query("SELECT COUNT(*) n FROM control_outbox WHERE item_id=? AND kind='attention.effect_projected'")
   .get(card!.decision!.itemId);
  expect(projected).toEqual({ n: 1 });
  f.service.recordRuntimeEvent(c.id, {
   eventId: "done",
   sessionId: ref.sessionId,
   turnId: f.submitted[0],
   kind: "completed",
   text: "verified",
  });
  expect(f.db.query("SELECT COUNT(*) n FROM control_outbox WHERE item_id=? AND kind='attention.effect_projected'")
   .get(card!.decision!.itemId)).toEqual({ n: 1 });
 } finally {
  await f.close();
 }
});
test("native failed and unknown effects reopen the same attention", async () => {
 for (const kind of ["failed", "unknown"] as const) {
  const f = harness();
  try {
   await f.service.start();
   await f.service.accept(f.event(`one-${kind}`));
   await f.service.tick();
   const conversation = f.db.query("SELECT id,session_reference FROM conversations").get();
   if (!conversation || typeof conversation !== "object" || !("id" in conversation)
    || typeof conversation.id !== "string" || !("session_reference" in conversation)
    || typeof conversation.session_reference !== "string") throw new Error("missing conversation");
   const reference = JSON.parse(conversation.session_reference) as SessionReference;
   f.service.recordRuntimeEvent(conversation.id, {
    eventId: `blocked-${kind}`,
    sessionId: reference.sessionId,
    turnId: f.submitted[0],
    kind: "blocked",
    requestId: `q-${kind}`,
    requestMethod: "confirm",
    options: ["yes", "no"],
    text: "Proceed?",
   });
   await f.service.tick();
   const card = f.sent.find((message) => message.decision);
   if (!card?.decision) throw new Error("missing decision card");
   const cardMessage = (f.db.query("SELECT message_id FROM channel_card_bindings WHERE item_id=?")
    .get(card.decision.itemId) as { message_id: string }).message_id;
   const input = f.event(`approve-${kind}`);
   await f.service.accept({
    ...input,
    messageId: cardMessage,
    kind: "decision",
    itemId: card.decision.itemId,
    revision: card.decision.revision,
    answer: "yes",
   });
   await f.service.tick();
   f.service.recordRuntimeEvent(conversation.id, {
    eventId: `terminal-${kind}`,
    sessionId: reference.sessionId,
    turnId: f.submitted[0],
    kind,
    text: `${kind} result`,
   });
   await f.service.tick();
   const item = getAttention(f.db, card.decision.itemId);
   expect(item).toMatchObject({ item_id: card.decision.itemId, state: "open", effect_state: kind });
   expect(item?.evidence.occurred_effects).toEqual([
    expect.objectContaining({
     kind: `q-${kind}`,
     state: kind,
     evidence: expect.objectContaining({ runtime_event: `terminal-${kind}` }),
    }),
   ]);
   expect(f.db.query("SELECT outcome FROM decision_receipts").get()).toEqual({ outcome: kind });
   expect(f.db.query("SELECT COUNT(*) n FROM control_works").get()).toEqual({ n: 1 });
   expect(f.db.query("SELECT COUNT(*) n FROM control_attention WHERE item_id=?").get(card.decision.itemId)).toEqual({ n: 1 });
   expect(f.db.query("SELECT COUNT(*) n FROM control_outbox WHERE item_id=? AND kind='attention.effect_projected'")
    .get(card.decision.itemId)).toEqual({ n: 1 });
  } finally {
   await f.close();
  }
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
test('runtime config is selected per conversation for every new topic while ordinary chat remains unchanged',async()=>{const f=harness();const starts:any[]=[];f.runtime.start=async request=>{starts.push(request);throw new Error('capture')};const service=new AdapterService(f.db,{runtime:f.runtime,channels:[f.channel],cwd:f.root,authorize:()=>({ownerId:'operator',workId:null}),runtimeConfig:c=>(JSON.parse(c.address) as {chatId:string}).chatId==='botmux'?{configPath:'/tmp/gate.json'}:undefined});try{await service.accept(f.event('one','botmux'));await service.tick();await service.accept(f.event('two','p2p'));await service.tick();expect(starts.map(x=>({ownerId:x.ownerId,configPath:x.configPath??null}))).toEqual([{ownerId:expect.any(String),configPath:'/tmp/gate.json'},{ownerId:expect.any(String),configPath:null}]);}finally{await service.stop();await f.close();}});
test('decision callback restores a missing thread only from its exact persisted card',async()=>{const f=harness();try{await f.service.start();await f.service.accept(f.event('one','chat'));await f.service.tick();const c=f.db.query('SELECT id,address,session_reference FROM conversations').get() as {id:string;address:string;session_reference:string};const address=JSON.parse(c.address);address.threadId='topic-a';f.db.run('UPDATE conversations SET binding_key=?,address=? WHERE id=?',[JSON.stringify(['channel-one','tenant','chat','topic-a']),JSON.stringify(address),c.id]);const ref=JSON.parse(c.session_reference) as SessionReference;f.service.recordRuntimeEvent(c.id,{eventId:'blocked',sessionId:ref.sessionId,turnId:f.submitted[0],kind:'blocked',requestId:'q-thread',requestMethod:'confirm',options:['yes'],text:'Proceed?'});await f.service.tick();const card=f.sent.find(m=>m.decision)!;const cardMessage=(f.db.query('SELECT message_id FROM channel_card_bindings WHERE item_id=?').get(card.decision!.itemId) as {message_id:string}).message_id;const callback={...f.event('callback','chat'),kind:'decision' as const,messageId:cardMessage,itemId:card.decision!.itemId,revision:card.decision!.revision,answer:'yes'};await expect(f.service.accept({...callback,messageId:'other-card'})).rejects.toThrow('decision_card_mismatch');await expect(f.service.accept({...callback,address:{...callback.address,threadId:'topic-b'}})).rejects.toThrow('decision_conversation_mismatch');expect(f.db.query('SELECT COUNT(*) n FROM channel_inbound WHERE event_id=?').get('callback')).toEqual({n:0});await f.service.accept(callback);expect(f.db.query('SELECT COUNT(*) n FROM channel_inbound WHERE event_id=?').get('callback')).toEqual({n:1});}finally{await f.close();}});
test('routes work only to its explicitly authorized conversation',async()=>{const f=harness();const service=new AdapterService(f.db,{runtime:f.runtime,channels:[f.channel],cwd:f.root,authorize:(_identity,address)=>({ownerId:'operator',workId:address.chatId==='coordinator'?'work-1':null})});try{await service.accept(f.event('private','production'));await new Promise(resolve=>setTimeout(resolve,1));await service.accept(f.event('group','coordinator'));expect(f.db.query('SELECT binding_key,work_id,coordinator_work_id FROM conversations ORDER BY binding_key').all()).toEqual([{binding_key:'["channel-one","tenant","coordinator",null]',work_id:'work-1',coordinator_work_id:'work-1'},{binding_key:'["channel-one","tenant","production",null]',work_id:null,coordinator_work_id:null}]);}finally{await service.stop();await f.close();}});
test('rejects changing the work bound to an existing conversation',async()=>{const f=harness();let workId:string|null='work-1';const service=new AdapterService(f.db,{runtime:f.runtime,channels:[f.channel],cwd:f.root,authorize:()=>({ownerId:'operator',workId})});try{await service.accept(f.event('one'));workId='work-2';expect(service.accept(f.event('two'))).rejects.toThrow('conversation_work_mismatch');}finally{await service.stop();await f.close();}});
test('one decision updates its original card without acknowledgement noise or duplicate applying text',async()=>{const f=harness();try{await f.service.accept(f.event('one'));const conversation=f.db.query('SELECT id,address FROM conversations').get() as {id:string;address:string};const work=createWork(f.db,{title:'fixture',source:'test',source_id:'fixture',contract:{objective:'test',acceptance:[{id:'done',kind:'human',description:'done'}],non_goals:[],scope:{cwd:f.root},budget:{},stop_conditions:[],decision_owner:'operator'}});f.db.run('UPDATE conversations SET work_id=? WHERE id=?',[work.work_id,conversation.id]);upsertAttention(f.db,{item_id:'approval',work_id:work.work_id,state:'applying',effect_state:'applying',urgency:'now',conclusion:'Approve fixture execution?',trigger:'test',impact:'test',recommendation:null,options:['approve'],owner:'operator',expires_at:null,source_link:null,approval_id:null,consumer_owner:null,contract_revision:work.revision,decision_mode:'human_only',evidence:{kind:'test'}});f.db.run('INSERT INTO channel_card_bindings(item_id,conversation_id,message_id) VALUES(?,?,?)',['approval',conversation.id,'original-card']);await f.service.tick();const payloads=(f.db.query('SELECT payload FROM channel_deliveries').all() as {payload:string}[]).map(row=>JSON.parse(row.payload) as ChannelMessage);expect(payloads).toHaveLength(1);expect(payloads[0]?.replaceMessageId).toBe('original-card');expect(payloads[0]?.decision?.state).toBe('Applying');expect(payloads.some(payload=>payload.text.includes('决定已接收'))).toBe(false);await f.service.tick();expect(f.db.query('SELECT COUNT(*) n FROM channel_deliveries').get()).toEqual({n:1});}finally{await f.close();}});

// A09: the Web consume route and the channel entry share one mailbox target. Whoever loses the race
// must be told it lost — and be given the current state — rather than the "not written yet" 404 that
// a bare null consume used to produce.
async function racedApproval(f: ReturnType<typeof harness>) {
 const ledgerPath = join(f.root, "ledger.db");
 const ledger = new Database(ledgerPath);
 ledger.exec(await Bun.file(new URL("../ingest/schema.sql", import.meta.url)).text());
 ledger.close();
 // The web server's publish path opens a SpoolWriter against spoolRoot, which needs a host marker.
 writeFileSync(join(f.root, "host"), "local\n");
 await f.service.start();
 await f.service.accept(f.event("one"));
 await f.service.tick();
 const conversation = f.db.query("SELECT id,session_reference FROM conversations").get() as {
  id: string;
  session_reference: string;
 };
 const reference = JSON.parse(conversation.session_reference) as SessionReference;
 f.service.recordRuntimeEvent(conversation.id, {
  eventId: "blocked",
  sessionId: reference.sessionId,
  turnId: f.submitted[0],
  kind: "blocked",
  requestId: "q",
  requestMethod: "confirm",
  options: ["yes", "no"],
  text: "Proceed?",
 });
 await f.service.tick();
 const card = f.sent.find((message) => message.decision);
 if (!card?.decision) throw new Error("missing decision card");
 const itemId = card.decision.itemId;
 const cardMessage = (f.db.query("SELECT message_id FROM channel_card_bindings WHERE item_id=?")
  .get(itemId) as { message_id: string }).message_id;
 const targetVersion = (f.db.query("SELECT target_version FROM approval_targets WHERE approval_id=?")
  .get(itemId) as { target_version: string }).target_version;
 const server = startWebServer({
  ledgerPath,
  controlPath: join(f.root, "control.db"),
  orchestratorPath: join(f.root, "orch.db"),
  spoolRoot: f.root,
  port: 0,
 });
 const decide = () => f.service.accept({
  ...f.event("approve"),
  messageId: cardMessage,
  kind: "decision" as const,
  itemId,
  revision: card.decision!.revision,
  answer: "yes",
 });
 const webConsume = () => fetch(`http://127.0.0.1:${server.port}/api/decision/consume/${encodeURIComponent(itemId)}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
  body: JSON.stringify({ consumer_owner: "extension", target_version: targetVersion }),
 });
 const receipts = () => f.db.query("SELECT COUNT(*) n FROM decision_receipts").get() as { n: number };
 return { itemId, targetVersion, server, decide, webConsume, receipts };
}

test("A09 channel and web entries racing one approval consume it exactly once", async () => {
 const f = harness();
 let raced: Awaited<ReturnType<typeof racedApproval>> | undefined;
 try {
  raced = await racedApproval(f);
  // The channel entry records the human answer; both entries now hold a usable credential.
  await raced.decide();
  const [response] = await Promise.all([raced.webConsume(), f.service.tick()]);
  // Whoever won, the unique receipt is the boundary: never two consumptions.
  expect(raced.receipts()).toEqual({ n: 1 });
  const body = await response.json();
  if (response.status === 200) {
   expect(body).toMatchObject({ approvalId: raced.itemId, consumerOwner: "extension" });
  } else {
   expect(response.status).toBe(409);
   expect(body).toMatchObject({ error: "conflict", code: "already_consumed", retry: false, current_target_state: "consumed" });
  }
 } finally {
  raced?.server.stop(true);
  await f.close();
 }
});

test("A09 the web entry that loses the race gets 409 carrying current state and no second receipt", async () => {
 const f = harness();
 let raced: Awaited<ReturnType<typeof racedApproval>> | undefined;
 try {
  raced = await racedApproval(f);
  // Channel entry wins outright: answer written and consumed before the web entry submits.
  await raced.decide();
  await f.service.tick();
  expect(raced.receipts()).toEqual({ n: 1 });
  const winner = f.db.query("SELECT receipt_id FROM decision_receipts").get() as { receipt_id: string };
  const workId = (f.db.query("SELECT work_id FROM control_attention WHERE item_id=?")
   .get(raced.itemId) as { work_id: string }).work_id;

  const response = await raced.webConsume();
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({
   error: "conflict",
   message: "decision already consumed by another entry",
   code: "already_consumed",
   retry: false,
   approval_id: raced.itemId,
   consumer_owner: "extension",
   expected_target_version: raced.targetVersion,
   current_target_version: raced.targetVersion,
   current_target_state: "consumed",
   current_state: "applying",
   current_effect_state: "applying",
   receipt_id: winner.receipt_id,
   decision_package_url: `/api/context/decision-package?item_id=${encodeURIComponent(raced.itemId)}&work_id=${encodeURIComponent(workId)}`,
  });
  // Losing the race consumed nothing.
  expect(raced.receipts()).toEqual({ n: 1 });
 } finally {
  raced?.server.stop(true);
  await f.close();
 }
});
