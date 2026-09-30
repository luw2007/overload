import { expect, test } from "bun:test";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { FeishuChannelConfig } from "./feishu";
import { classifyFeishuError, FeishuChannel } from "./feishu";
import type { ChannelEvent, ChannelMessage } from "./types";

type Handler = (value: unknown) => void | Promise<void>;
class FakeLarkChannel {
 readonly handlers = new Map<string, Handler>();
 readonly sent: Array<{ to: string; input: unknown; options: unknown }> = [];
 readonly updates: Array<{ messageId: string; card: object }> = [];
 readonly edits: Array<{ messageId: string; text: string }> = [];
 readonly reactions: Array<{ messageId: string; emojiType: string }> = [];
 readonly removedReactions: Array<{ messageId: string; reactionId: string }> =
  [];
 connected = false;
 updateError: unknown = null;
 sendError: unknown = null;
 connectPromise: Promise<void> = Promise.resolve();
 on(name: string, handler: Handler) {
  this.handlers.set(name, handler);
  return () => {
   if (this.handlers.get(name) === handler) this.handlers.delete(name);
  };
 }
 async connect() {
  await this.connectPromise;
  this.connected = true;
 }
 async disconnect() {
  this.connected = false;
 }
 async send(to: string, input: unknown, options?: unknown) {
  this.sent.push({ to, input, options });
  if (this.sendError) {
   const error = this.sendError;
   this.sendError = null;
   throw error;
  }
  return { messageId: "sent-1" };
 }
 async updateCard(messageId: string, card: object) {
  this.updates.push({ messageId, card });
  if (this.updateError) throw this.updateError;
 }
 async editMessage(messageId: string, text: string) {
  this.edits.push({ messageId, text });
 }
 async addReaction(messageId: string, emojiType: string) {
  this.reactions.push({ messageId, emojiType });
  return "reaction-1";
 }
 async removeReaction(messageId: string, reactionId: string) {
  this.removedReactions.push({ messageId, reactionId });
 }
 async emit(name: string, value: unknown) {
  await this.handlers.get(name)?.(value);
 }
}

let fake: FakeLarkChannel;
let factoryOptions: Record<string, unknown>;
const createChannel: NonNullable<FeishuChannelConfig["createChannel"]> = (
 options,
) => {
 factoryOptions = options as unknown as Record<string, unknown>;
 fake = new FakeLarkChannel();
 return fake as unknown as ReturnType<
  NonNullable<FeishuChannelConfig["createChannel"]>
 >;
};
const config = {
 appId: "cli_0123456789abcdef",
 appSecret: "secret",
 instanceId: "feishu-main",
 createChannel,
};
function channel() {
 return new FeishuChannel(config);
}
function raw(eventId = "event-1", tenantId = "tenant-1") {
 return { event_id: eventId, tenant_key: tenantId };
}

test("uses the official websocket transport and does not report start before connect", async () => {
 const instance = channel();
 let release!: () => void;
 fake.connectPromise = new Promise<void>((resolve) => {
  release = resolve;
 });
 const starting = instance.start(async () => {});
 await Promise.resolve();
 expect(factoryOptions.transport).toBe("websocket");
 expect(factoryOptions.policy).toEqual({
  requireMention: true,
  dmMode: "open",
 });
 expect(fake.connected).toBe(false);
 release();
 await starting;
 expect(fake.connected).toBe(true);
 await instance.stop();
 expect(fake.connected).toBe(false);
});

test("normalizes authenticated direct and mentioned group messages with thread identity", async () => {
 const instance = channel();
 const events: ChannelEvent[] = [];
 await instance.start(async (event) => {
  events.push(event);
 });
 await fake.emit("message", {
  messageId: "ignored",
  chatId: "chat",
  chatType: "group",
  senderId: "user",
  content: "ignored",
  mentionedBot: false,
  createTime: 0,
  raw: raw("ignored"),
 });
 await fake.emit("message", {
  messageId: "m1",
  chatId: "chat",
  chatType: "group",
  senderId: "user",
  content: "hello",
  mentionedBot: true,
  rootId: "root",
  threadId: "thread",
  createTime: 1_700_000_000,
  raw: raw("e1", "tenant"),
 });
 await fake.emit("message", {
  messageId: "m2",
  chatId: "dm",
  chatType: "p2p",
  senderId: "user-2",
  content: "direct",
  mentionedBot: false,
  createTime: 1_700_000_001,
  raw: raw("e2", "tenant"),
 });
 expect(events).toHaveLength(2);
 expect(events[0]).toMatchObject({
  kind: "message",
  eventId: "e1",
  identity: { instanceId: "feishu-main", tenantId: "tenant", userId: "user" },
  address: { chatId: "chat", threadId: "thread" },
  messageId: "m1",
  text: "hello",
  receivedAt: 1_700_000_000_000,
 });
 expect(events[1]).toMatchObject({
  kind: "message",
  eventId: "e2",
  address: { chatId: "dm" },
  text: "direct",
 });
 await instance.stop();
});

test("exposes SDK reaction methods", async () => {
 const instance = channel();
 await instance.addReaction("message-1", "GoGoGo");
 await instance.removeReaction("message-1", "reaction-1");
 expect(fake.reactions).toEqual([
  { messageId: "message-1", emojiType: "GoGoGo" },
 ]);
 expect(fake.removedReactions).toEqual([
  { messageId: "message-1", reactionId: "reaction-1" },
 ]);
});

test("replies when a requester invokes an owner-only slash command", async () => {
 const instance = channel();
 await instance.start(async () => {
  throw new Error("command_owner_mismatch");
 });
 await fake.emit("message", {
  messageId: "message-1",
  chatId: "chat",
  chatType: "p2p",
  senderId: "requester",
  content: "/new",
  createTime: 0,
  raw: raw("command-owner-mismatch"),
 });
 expect(fake.sent).toEqual([
  {
   to: "chat",
   input: { markdown: "仅会话 Owner 可以执行该命令。" },
   options: { replyTo: "message-1" },
  },
 ]);
 await instance.stop();
});

test("replies when a non-owner submits a card decision", async () => {
 const instance = channel();
 await instance.start(async () => {
  throw new Error("decision_owner_mismatch");
 });
 await fake.emit("cardAction", {
  messageId: "card-1",
  chatId: "chat",
  operator: { openId: "requester" },
  action: {
   tag: "button",
   value: { itemId: "item-1", revision: 1, answer: "approve" },
  },
  raw: raw("action-owner-mismatch", "tenant"),
 });
 expect(fake.sent).toEqual([
  {
   to: "chat",
   input: { markdown: "仅会话 Owner 可以提交决定。" },
   options: { replyTo: "card-1" },
  },
 ]);
 await instance.stop();
});

test("replies once when a card decision is stale", async () => {
 const instance = channel();
 let attempts = 0;
 await instance.start(async () => {
  attempts++;
  throw new Error("stale attention revision");
 });
 const action = {
  messageId: "card-stale",
  chatId: "chat",
  operator: { openId: "owner" },
  action: {
   tag: "button",
   value: { itemId: "item-stale", revision: 1, answer: "continue" },
  },
  raw: raw("action-stale", "tenant"),
 };
 await fake.emit("cardAction", action);
 expect(attempts).toBe(1);
 expect(fake.sent).toEqual([{
  to: "chat",
  input: { markdown: "该决定已更新或失效，请刷新后查看当前状态。" },
  options: { replyTo: "card-stale" },
 }]);
 await instance.stop();
});

// Plan §4.5: local mailbox facts win, so the entry that lost the consume race reports current state
// and never retries the answer.
test("A09 reports current state once and does not retry when another entry already consumed", async () => {
 const instance = channel();
 let attempts = 0;
 await instance.start(async () => {
  attempts++;
  throw new Error("already_consumed");
 });
 const action = {
  messageId: "card-consumed",
  chatId: "chat",
  operator: { openId: "owner" },
  action: {
   tag: "button",
   value: { itemId: "item-consumed", revision: 1, answer: "approve" },
  },
  raw: raw("action-consumed", "tenant"),
 };
 await fake.emit("cardAction", action);
 expect(attempts).toBe(1);
 expect(fake.sent).toEqual([{
  to: "chat",
  input: { markdown: "该决定已在其他入口被记录，本次回答不会重复生效；卡片显示的是当前状态。" },
  options: { replyTo: "card-consumed" },
 }]);
 await instance.stop();
});

test("normalizes card callbacks without unauthenticated tenant bypass", async () => {
 const instance = channel();
 const events: ChannelEvent[] = [];
 await instance.start(async (event) => {
  events.push(event);
 });
 await fake.emit("cardAction", {
  messageId: "card-1",
  chatId: "chat",
  operator: { openId: "user" },
  action: {
   tag: "button",
   value: JSON.stringify({
    itemId: "item-1",
    revision: 3,
    answer: "approve",
    threadId: "root",
   }),
  },
  raw: raw("action-1", "tenant"),
 });
 await fake.emit("cardAction", {
  messageId: "card-2",
  chatId: "chat",
  operator: { openId: "user" },
  action: {
   tag: "button",
   value: JSON.stringify({ itemId: "item-2", revision: 1, answer: "approve" }),
  },
  raw: raw("action-2", "tenant"),
 });
 expect(events[0]).toMatchObject({
  kind: "decision",
  eventId: "action-1",
  identity: { tenantId: "tenant", userId: "user" },
  address: { chatId: "chat", threadId: "root" },
  messageId: "card-1",
  itemId: "item-1",
  revision: 3,
  answer: "approve",
 });
 expect(events[1]).toMatchObject({
  kind: "decision",
  eventId: "action-2",
  address: { chatId: "chat" },
  messageId: "card-2",
  itemId: "item-2",
 });
 await expect(
  fake.emit("cardAction", {
   messageId: "card-2",
   chatId: "chat",
   operator: { openId: "user" },
   action: {
    tag: "button",
    value: { itemId: "item-2", revision: 1, answer: "approve" },
   },
   raw: { event_id: "action-2" },
  }),
 ).rejects.toThrow("invalid_feishu_tenant_key");
 expect(events).toHaveLength(2);
 await instance.stop();
});

test("sends threaded text and decision cards without a second client confirmation, and updates existing cards", async () => {
 const instance = channel();
 await instance.start(async () => {});
 const text: ChannelMessage = {
  deliveryId: "d1",
  address: {
   instanceId: "feishu-main",
   tenantId: "tenant",
   chatId: "oc_5ad11d72b830411d72b836c20",
   rootMessageId: "om_dc13264520392913993dd051dba21dcf",
   threadId: "omt_1a3b99f9d2cfb2d2",
  },
  text: "hello",
 };
 expect(await instance.send(text)).toEqual({
  state: "sent",
  messageId: "sent-1",
 });
 expect(fake.sent[0]).toMatchObject({
  to: "oc_5ad11d72b830411d72b836c20",
  input: { markdown: "hello" },
  options: { replyTo: "om_dc13264520392913993dd051dba21dcf", replyInThread: true },
 });
 const decision: ChannelMessage = {
  deliveryId: "d2",
  address: text.address,
  text: "review",
  decision: {
   itemId: "item",
   revision: 2,
   title: "Review",
   owner: "owner",
   options: ["approve"],
   state: "open",
  },
 };
 expect(await instance.send(decision)).toEqual({
  state: "sent",
  messageId: "sent-1",
 });
 expect(fake.sent[1].input).toMatchObject({
  card: { header: { title: { content: "Review" } } },
 });
 expect(fake.sent[1].options).toMatchObject({
  replyTo: "om_dc13264520392913993dd051dba21dcf",
 });
 expect(JSON.stringify(fake.sent[1].input)).not.toContain("confirm");
 const update = { ...decision, replaceMessageId: "card-1" };
 expect(await instance.send(update)).toEqual({
  state: "sent",
  messageId: "card-1",
 });
 expect(fake.updates).toHaveLength(1);
 await instance.stop();
});

test("passes a stable delivery uuid and only falls back for important terminal revoked updates", async () => {
 const instance = channel();
 await instance.start(async () => {});
 const address = {
  instanceId: "feishu-main",
  tenantId: "tenant",
  chatId: "chat",
 };
 const message: ChannelMessage = {
  deliveryId: "delivery",
  deliveryUuid: "overload-123",
  address,
  text: "done",
  replaceMessageId: "withdrawn",
  importance: "important",
  terminal: true,
  decision: {
   itemId: "item",
   revision: 2,
   title: "Done",
   owner: "owner",
   options: [],
   state: "resolved / succeeded",
  },
 };
 fake.updateError = Object.assign(new Error("withdrawn"), {
  code: "target_revoked",
 });
 expect(await instance.send(message)).toEqual({
  state: "sent",
  messageId: "sent-1",
 });
 expect(fake.sent[0]).toMatchObject({
  to: "chat",
  options: { uuid: "overload-123" },
 });
 expect(fake.sent[0].options).not.toHaveProperty("replyTo");
 fake.sendError = Object.assign(new Error("withdrawn reply"), {
  code: "target_revoked",
 });
 expect(
  await instance.send({
   ...message,
   replaceMessageId: undefined,
   replyTo: "withdrawn",
  }),
 ).toEqual({ state: "sent", messageId: "sent-1" });
 expect(fake.sent.at(-2)?.options).toMatchObject({ replyTo: "withdrawn" });
 expect(fake.sent.at(-1)?.options).not.toHaveProperty("replyTo");
 expect(
  await instance.send({
   ...message,
   decision: {
    ...message.decision!,
    options: ["approve"],
    state: "open / not_started",
   },
  }),
 ).toEqual({ state: "failed", reason: "target_revoked" });
 expect(fake.sent).toHaveLength(3);
 await instance.stop();
});

test("retries a missing reply anchor once with the same delivery uuid", async () => {
 const instance = channel();
 await instance.start(async () => {});
 fake.sendError = Object.assign(new Error("message not found"), {
  code: "message_not_found",
 });
 const message: ChannelMessage = {
  deliveryId: "d",
  deliveryUuid: "overload-anchor",
  address: { instanceId: "feishu-main", tenantId: "tenant", chatId: "chat" },
  text: "reply",
  replyTo: "missing",
 };
 expect(await instance.send(message)).toEqual({
  state: "sent",
  messageId: "sent-1",
 });
 expect(fake.sent).toHaveLength(2);
 expect(fake.sent[0].options).toMatchObject({
  replyTo: "missing",
  uuid: "overload-anchor",
 });
 expect(fake.sent[1].options).toEqual({ uuid: "overload-anchor" });
 await instance.stop();
});

test("does not retry a reply send for generic errors", async () => {
 const instance = channel();
 await instance.start(async () => {});
 fake.sendError = Object.assign(new Error("request timed out"), {
  code: "timeout",
 });
 expect(
  await instance.send({
   deliveryId: "d",
   deliveryUuid: "overload-anchor",
   address: { instanceId: "feishu-main", tenantId: "tenant", chatId: "chat" },
   text: "reply",
   replyTo: "missing",
  }),
 ).toEqual({ state: "unknown", reason: "timeout" });
 expect(fake.sent).toHaveLength(1);
 await instance.stop();
});

test("classifies official SDK delivery errors without pretending success", async () => {
 const instance = channel();
 await instance.start(async () => {});
 fake.send = async () => {
  throw Object.assign(new Error("rate limited"), { code: "rate_limited" });
 };
 expect(
  await instance.send({
   deliveryId: "d",
   address: { instanceId: "feishu-main", tenantId: "tenant", chatId: "chat" },
   text: "hello",
  }),
 ).toEqual({ state: "retryable", reason: "rate_limited" });
 fake.send = async () => {
  throw Object.assign(new Error("denied"), { code: "permission_denied" });
 };
 expect(
  await instance.send({
   deliveryId: "d2",
   address: { instanceId: "feishu-main", tenantId: "tenant", chatId: "chat" },
   text: "hello",
  }),
 ).toEqual({ state: "failed", reason: "permission_denied" });
 fake.send = async () => {
  throw Object.assign(new Error("timeout"), { code: "send_timeout" });
 };
 expect(
  await instance.send({
   deliveryId: "d3",
   address: { instanceId: "feishu-main", tenantId: "tenant", chatId: "chat" },
   text: "hello",
  }),
 ).toEqual({ state: "unknown", reason: "send_timeout" });
 await instance.stop();
});

// Real-shaped Feishu identifiers: messages are om_*, topics are omt_*, chats are oc_*.
const CHAT = "oc_5ad11d72b830411d72b836c20";
const ROOT = "om_dc13264520392913993dd051dba21dcf";
const REPLY = "om_b2f67d1e3a0c4c8e9d1f5a7b3c2e4d6f";
const TOPIC = "omt_1a3b99f9d2cfb2d2";

test("§11.1 a topic's first message and its follow-up share the root identity, and replies anchor to om_root", async () => {
 const instance = channel();
 const events: ChannelEvent[] = [];
 await instance.start(async (event) => {
  events.push(event);
 });
 await fake.emit("message", {
  messageId: ROOT,
  chatId: CHAT,
  chatType: "group",
  senderId: "ou_owner",
  content: "start",
  mentionedBot: true,
  createTime: 1_700_000_000,
  raw: raw("ev-root", "tenant"),
 });
 await fake.emit("message", {
  messageId: REPLY,
  chatId: CHAT,
  chatType: "group",
  senderId: "ou_owner",
  content: "follow up",
  mentionedBot: true,
  rootId: ROOT,
  threadId: TOPIC,
  createTime: 1_700_000_001,
  raw: raw("ev-reply", "tenant"),
 });
 expect(events.map((e) => e.address)).toEqual([
  { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT, rootMessageId: ROOT },
  { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT, rootMessageId: ROOT, threadId: TOPIC },
 ]);
 // Reactions still land on the message the user sent.
 expect(fake.reactions.map((r) => r.messageId)).toEqual([ROOT, REPLY]);
 // A result for the follow-up carries replyTo=source message; the anchor is still the root.
 for (const [i, event] of events.entries()) {
  await instance.send({
   deliveryId: "d" + i,
   address: event.address,
   text: "result",
   replyTo: event.messageId,
  });
  await instance.send({
   deliveryId: "c" + i,
   address: event.address,
   text: "decide",
   decision: { itemId: "item", revision: 1, title: "Decide", owner: "o", options: ["yes"], state: "open" },
  });
 }
 expect(fake.sent).toHaveLength(4);
 for (const sent of fake.sent)
  expect(sent.options).toMatchObject({ replyTo: ROOT, replyInThread: true });
 expect(fake.sent.map((s) => (s.options as { replyTo: string }).replyTo)).not.toContain(TOPIC);
 await instance.stop();
});

test("§11.1 a legacy address whose threadId is a topic id is never used as a reply target", async () => {
 const instance = channel();
 await instance.send({
  deliveryId: "d",
  address: { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT, threadId: TOPIC },
  text: "result",
  replyTo: REPLY,
 });
 await instance.send({
  deliveryId: "d2",
  address: { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT, threadId: ROOT },
  text: "result",
  replyTo: REPLY,
 });
 expect(fake.sent.map((s) => (s.options as { replyTo: string }).replyTo)).toEqual([REPLY, ROOT]);
});

type RecordedRequest = { url?: string; method?: string; data?: Record<string, unknown> };
function realSdk(respond: (request: RecordedRequest) => unknown) {
 const requests: RecordedRequest[] = [];
 const httpInstance = {
  async post(url: string) {
   if (url.includes("tenant_access_token"))
    return { code: 0, tenant_access_token: "t-test", expire: 7200 };
   throw new Error("unexpected post " + url);
  },
  async request(request: RecordedRequest) {
   requests.push(request);
   return respond(request);
  },
 };
 const instance = new FeishuChannel({
  appId: "cli_0123456789abcdef",
  appSecret: "secret",
  instanceId: "feishu-main",
  // The real SDK factory; only the HTTP transport is replaced, so every SDK layer between our adapter and
  // the wire runs as in production.
  createChannel: (options) =>
   createLarkChannel({
    ...options,
    httpInstance: httpInstance as never,
    loggerLevel: LoggerLevel.fatal,
    logger: { error() {}, warn() {}, info() {}, debug() {}, trace() {} },
    cache: new Map() as never,
   }) as never,
 });
 return { instance, requests };
}
const progress = {
 deliveryUuid: "overload-progress-4f1c2a",
 address: { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT, rootMessageId: ROOT, threadId: TOPIC },
 title: "正在处理",
 text: "- 当前：正在处理",
};

test("§11.2 the progress uuid reaches the raw open-platform request body through the real SDK", async () => {
 const { instance, requests } = realSdk(() => ({ code: 0, data: { message_id: "om_progress0000000000000000000001" } }));
 expect(await instance.createProgress(progress)).toEqual({
  state: "sent",
  messageId: "om_progress0000000000000000000001",
 });
 expect(requests).toHaveLength(1);
 expect(requests[0].method).toBe("POST");
 expect(requests[0].url).toEndWith(`/open-apis/im/v1/messages/${ROOT}/reply`);
 expect(requests[0].data).toMatchObject({
  msg_type: "interactive",
  reply_in_thread: true,
  uuid: "overload-progress-4f1c2a",
 });
 expect(JSON.stringify(requests[0])).not.toContain(TOPIC);
 expect(requests[0].data!.content as string).not.toContain("<at");
 // Without a root (direct chat) it is a create, and the uuid still reaches the body.
 await instance.createProgress({ ...progress, address: { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT } });
 expect(requests[1].url).toEndWith("/open-apis/im/v1/messages");
 expect(requests[1].data).toMatchObject({ receive_id: CHAT, uuid: "overload-progress-4f1c2a" });
});

test("§3.3 the SDK's send() path drops uuid, which is why progress does not use it", async () => {
 const { instance, requests } = realSdk(() => ({ code: 0, data: { message_id: "om_result00000000000000000000001" } }));
 await instance.send({
  deliveryId: "d",
  deliveryUuid: "overload-result-uuid",
  address: progress.address,
  text: "done",
 });
 expect(requests).toHaveLength(1);
 expect(requests[0].url).toEndWith(`/open-apis/im/v1/messages/${ROOT}/reply`);
 expect(requests[0].data).not.toHaveProperty("uuid");
});

function httpError(status: number, code: number, headers: Record<string, string> = {}) {
 return Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status, data: { code, msg: "error" }, headers },
 });
}

test("§3.4 PATCH errors from the real SDK are classified: 429, recall, unknown", async () => {
 let next: unknown = null;
 const { instance, requests } = realSdk(() => {
  throw next;
 });
 next = httpError(429, 99991400, { "x-ogw-ratelimit-reset": "7" });
 expect(await instance.updateProgress(ROOT, progress)).toEqual({
  state: "retryable",
  reason: "rate_limited",
  retryAfterMs: 7000,
 });
 expect(requests[0]).toMatchObject({ method: "PATCH" });
 expect(requests[0].url).toEndWith(`/open-apis/im/v1/messages/${ROOT}`);
 next = httpError(400, 230020);
 expect(await instance.updateProgress(ROOT, progress)).toEqual({ state: "retryable", reason: "rate_limited" });
 next = httpError(400, 230011);
 expect(await instance.updateProgress(ROOT, progress)).toEqual({ state: "failed", reason: "target_revoked" });
 next = httpError(400, 230110);
 expect(await instance.updateProgress(ROOT, progress)).toEqual({ state: "failed", reason: "message_not_found" });
 next = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
 expect(await instance.updateProgress(ROOT, progress)).toEqual({ state: "retryable", reason: "not_connected" });
 next = Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" });
 expect(await instance.updateProgress(ROOT, progress)).toEqual({ state: "unknown", reason: "ECONNABORTED" });
 next = httpError(500, 1);
 expect(await instance.updateProgress(ROOT, progress)).toEqual({ state: "unknown", reason: "1" });
 // Each PATCH is one request: no hidden SDK retry behind an unknown result.
 expect(requests).toHaveLength(7);
});

test("§3.4 a progress create with an unknown result is not retried or replaced", async () => {
 const { instance, requests } = realSdk(() => {
  throw Object.assign(new Error("timeout of 10000ms exceeded"), { code: "ECONNABORTED" });
 });
 expect(await instance.createProgress(progress)).toEqual({ state: "unknown", reason: "ECONNABORTED" });
 expect(requests).toHaveLength(1);
});

test("§3.4 classification reads every error shape and a numeric Feishu code beats the SDK's string code", () => {
 // The SDK labels 230020 target_revoked and 99991400 permission_denied; the raw cause decides.
 const sdk = (code: string, cause: unknown) => Object.assign(new Error(code), { code, cause });
 expect(classifyFeishuError(sdk("target_revoked", httpError(400, 230020)))).toMatchObject({ kind: "rate_limited" });
 expect(classifyFeishuError(sdk("permission_denied", httpError(400, 99991400, { "retry-after": "2" })))).toEqual({
  kind: "rate_limited",
  code: "99991400",
  retryAfterMs: 2000,
 });
 expect(classifyFeishuError({ code: 230011, msg: "The message is recalled." })).toMatchObject({ kind: "target_revoked" });
 expect(classifyFeishuError(httpError(403, 0))).toMatchObject({ kind: "permission_denied" });
 expect(classifyFeishuError(httpError(400, 230099))).toMatchObject({ kind: "format_error" });
 expect(classifyFeishuError(new Error("boom"))).toEqual({ kind: "unknown", code: "feishu_send_failed" });
 expect(classifyFeishuError(undefined)).toEqual({ kind: "unknown", code: "feishu_send_failed" });
});

test("a terminal decision card whose message is gone (SDK 404) still falls back to a fresh card", async () => {
 const instance = channel();
 fake.updateError = Object.assign(new Error("target_revoked"), {
  code: "target_revoked",
  cause: { response: { status: 404, data: {} } },
 });
 expect(
  await instance.send({
   deliveryId: "d",
   address: { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT, rootMessageId: ROOT },
   text: "done",
   replaceMessageId: "om_gone000000000000000000000000001",
   importance: "important",
   terminal: true,
   decision: { itemId: "item", revision: 2, title: "Done", owner: "o", options: [], state: "resolved" },
  }),
 ).toEqual({ state: "sent", messageId: "sent-1" });
 expect(fake.sent).toHaveLength(1);
});

test("a rate-limited decision card update is retried later, not replaced by a fresh card", async () => {
 const instance = channel();
 // The SDK labels 230020 target_revoked; before this fix that sent a duplicate terminal card.
 fake.updateError = Object.assign(new Error("target_revoked"), {
  code: "target_revoked",
  cause: { response: { status: 400, data: { code: 230020 } } },
 });
 expect(
  await instance.send({
   deliveryId: "d",
   address: { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT, rootMessageId: ROOT },
   text: "done",
   replaceMessageId: "om_card0000000000000000000000000001",
   importance: "important",
   terminal: true,
   decision: { itemId: "item", revision: 2, title: "Done", owner: "o", options: [], state: "resolved" },
  }),
 ).toEqual({ state: "retryable", reason: "rate_limited" });
 expect(fake.sent).toHaveLength(0);
});
