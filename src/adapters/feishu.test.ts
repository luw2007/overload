import { expect, test } from "bun:test";
import type { FeishuChannelConfig } from "./feishu";
import { FeishuChannel } from "./feishu";
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
 expect(events).toHaveLength(1);
 await instance.stop();
});

test("sends threaded text and decision cards, and updates existing cards", async () => {
 const instance = channel();
 await instance.start(async () => {});
 const text: ChannelMessage = {
  deliveryId: "d1",
  address: {
   instanceId: "feishu-main",
   tenantId: "tenant",
   chatId: "chat",
   threadId: "root",
  },
  text: "hello",
 };
 expect(await instance.send(text)).toEqual({
  state: "sent",
  messageId: "sent-1",
 });
 expect(fake.sent[0]).toMatchObject({
  to: "chat",
  input: { markdown: "hello" },
  options: { replyTo: "root", replyInThread: true },
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
