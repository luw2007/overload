import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import type {
 CardActionEvent,
 NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import type {
 ChannelAdapter,
 ChannelEvent,
 ChannelMessage,
 DeliveryReceipt,
} from "./types";

export type FeishuChannelConfig = {
 appId: string;
 appSecret: string;
 instanceId: string;
 createChannel?: FeishuChannelFactory;
};

type FeishuSdkMessage = Pick<
 NormalizedMessage,
 | "messageId"
 | "chatId"
 | "chatType"
 | "senderId"
 | "content"
 | "threadId"
 | "rootId"
 | "createTime"
 | "mentionedBot"
 | "raw"
>;
type FeishuSdkAction = Pick<
 CardActionEvent,
 "messageId" | "chatId" | "operator" | "action" | "raw"
>;
type FeishuSdkChannel = {
 on(
  name: "message",
  handler: (message: FeishuSdkMessage) => void | Promise<void>,
 ): () => void;
 on(
  name: "cardAction",
  handler: (action: FeishuSdkAction) => void | Promise<void>,
 ): () => void;
 on(name: "error", handler: (error: unknown) => void): () => void;
 connect(): Promise<void>;
 disconnect(): Promise<void>;
 send(
  to: string,
  input: { markdown: string } | { card: Record<string, unknown> },
  options?: { replyTo?: string; replyInThread?: boolean; uuid?: string },
 ): Promise<{ messageId: string }>;
 updateCard(messageId: string, card: Record<string, unknown>): Promise<void>;
 editMessage(messageId: string, text: string): Promise<void>;
 addReaction(messageId: string, emojiType: string): Promise<string>;
 removeReaction(messageId: string, reactionId: string): Promise<void>;
};
type FeishuChannelFactory = (
 options: Parameters<typeof createLarkChannel>[0],
) => FeishuSdkChannel;

function record(value: unknown): Record<string, unknown> {
 if (!value || typeof value !== "object" || Array.isArray(value))
  throw new Error("invalid_feishu_object");
 return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
 if (typeof value !== "string" || !value)
  throw new Error("invalid_feishu_" + name);
 return value;
}
function rawField(raw: unknown, name: string): string | undefined {
 const value = record(raw);
 const field = value[name];
 if (typeof field === "string") return field;
 const header = value.header;
 const nested =
  header && typeof header === "object" && !Array.isArray(header)
   ? (header as Record<string, unknown>)[name]
   : undefined;
 return typeof nested === "string" ? nested : undefined;
}
function rawIdentity(
 raw: unknown,
 fallbackEventId: string,
): { eventId: string; tenantId: string } {
 return {
  eventId: requiredString(
   rawField(raw, "event_id") ?? fallbackEventId,
   "event_id",
  ),
  tenantId: requiredString(rawField(raw, "tenant_key"), "tenant_key"),
 };
}
function receivedAt(value: number): number {
 if (!Number.isFinite(value) || value <= 0) return Date.now();
 return value < 1_000_000_000_000 ? value * 1000 : value;
}
function actionValue(value: unknown): Record<string, unknown> {
 if (typeof value === "string") {
  try {
   return record(JSON.parse(value));
  } catch {
   throw new Error("invalid_feishu_action_value");
  }
 }
 return record(value);
}
function errorCode(error: unknown): string {
 if (!error || typeof error !== "object" || Array.isArray(error)) return "";
 const code = (error as Record<string, unknown>).code;
 return typeof code === "string" ? code : "";
}
function missingAnchor(error: unknown): boolean {
 return ["target_revoked", "message_not_found"].includes(errorCode(error));
}

export class FeishuChannel implements ChannelAdapter {
 readonly kind = "feishu";
 readonly capabilities = { update: true, actions: true };
 readonly instanceId: string;
 private readonly channel: FeishuSdkChannel;
 private accept: ((event: ChannelEvent) => Promise<void>) | null = null;
 private unsubscribe: () => void = () => {};
 private started = false;
 constructor(readonly config: FeishuChannelConfig) {
  this.instanceId = config.instanceId;
  const factory =
   config.createChannel ??
   (createLarkChannel as unknown as FeishuChannelFactory);
  this.channel = factory({
   appId: config.appId,
   appSecret: config.appSecret,
   transport: "websocket",
   includeRawEvent: true,
   policy: { requireMention: true, dmMode: "open" },
  });
 }
 async start(accept: (event: ChannelEvent) => Promise<void>): Promise<void> {
  if (this.started) throw new Error("feishu_channel_already_started");
  this.accept = accept;
  const onMessage = (message: FeishuSdkMessage) => this.handleMessage(message);
  const onAction = (action: FeishuSdkAction) => this.handleAction(action);
  const removeMessage = this.channel.on("message", onMessage);
  const removeAction = this.channel.on("cardAction", onAction);
  this.unsubscribe = () => {
   removeMessage();
   removeAction();
  };
  try {
   await this.channel.connect();
   this.started = true;
  } catch (error) {
   this.unsubscribe();
   this.unsubscribe = () => {};
   this.accept = null;
   throw error;
  }
 }
 async addReaction(messageId: string, emojiType: string): Promise<string> {
  return this.channel.addReaction(messageId, emojiType);
 }
 async removeReaction(messageId: string, reactionId: string): Promise<void> {
  await this.channel.removeReaction(messageId, reactionId);
 }
 async stop(): Promise<void> {
  this.unsubscribe();
  this.unsubscribe = () => {};
  this.accept = null;
  if (this.started) {
   this.started = false;
   await this.channel.disconnect();
  }
 }
 private async handleMessage(message: FeishuSdkMessage): Promise<void> {
  if (!this.accept) return;
  if (message.chatType === "group" && !message.mentionedBot) return;
  const identity = rawIdentity(message.raw, message.messageId);
  const threadId =
   message.threadId ??
   message.rootId ??
   (message.chatType === "group" ? message.messageId : undefined);
  try {
   await this.accept({
    kind: "message",
    eventId: identity.eventId,
    identity: {
     instanceId: this.instanceId,
     tenantId: identity.tenantId,
     userId: requiredString(message.senderId, "sender"),
    },
    address: {
     instanceId: this.instanceId,
     tenantId: identity.tenantId,
     chatId: requiredString(message.chatId, "chat"),
     ...(threadId ? { threadId } : {}),
    },
    messageId: requiredString(message.messageId, "message"),
    text: requiredString(message.content, "content"),
    receivedAt: receivedAt(message.createTime),
   });
   try {
    await this.channel.addReaction(message.messageId, "GoGoGo");
   } catch {
    /* Like Botmux: acknowledgement is best-effort; accepted work must continue. */
   }
  } catch (error) {
   if (
    error instanceof Error &&
    error.message === "unauthorized_channel_identity"
   ) {
    await this.channel.send(
     message.chatId,
     {
      markdown:
       "此会话尚未获得 Overload 执行授权，消息未提交给 Agent。请联系操作员配置访问权限。",
     },
     { replyTo: message.messageId },
    );
    return;
   }
   if (error instanceof Error && error.message === "command_owner_mismatch") {
    await this.channel.send(
     message.chatId,
     { markdown: "仅会话 Owner 可以执行该命令。" },
     { replyTo: message.messageId },
    );
    return;
   }
   throw error;
  }
 }
 private async handleAction(action: FeishuSdkAction): Promise<void> {
  if (!this.accept) return;
  const value = actionValue(action.action.value);
  const itemId = requiredString(value.itemId, "item_id");
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision))
   throw new Error("invalid_feishu_revision");
  const answer = requiredString(value.answer, "answer");
  const identity = rawIdentity(
   action.raw,
   `card:${action.messageId}:${action.operator.openId}:${JSON.stringify(action.action.value)}`,
  );
  const threadId =
   typeof value.threadId === "string" && value.threadId
    ? value.threadId
    : undefined;
  try {
   await this.accept({
    kind: "decision",
    eventId: identity.eventId,
    identity: {
     instanceId: this.instanceId,
     tenantId: identity.tenantId,
     userId: requiredString(action.operator.openId, "operator"),
    },
    address: {
     instanceId: this.instanceId,
     tenantId: identity.tenantId,
     chatId: requiredString(action.chatId, "chat"),
     ...(threadId ? { threadId } : {}),
    },
    messageId: requiredString(action.messageId, "message"),
    itemId,
    revision,
    answer,
    receivedAt: Date.now(),
   });
  } catch (error) {
   if (error instanceof Error && error.message === "decision_owner_mismatch") {
    await this.channel.send(
     action.chatId,
     { markdown: "仅会话 Owner 可以提交决定。" },
     { replyTo: action.messageId },
    );
    return;
   }
   throw error;
  }
 }
 private receiptFor(error: unknown): DeliveryReceipt {
  const code = errorCode(error);
  if (code === "rate_limited" || code === "not_connected")
   return { state: "retryable", reason: code };
  if (
   code === "permission_denied" ||
   code === "target_revoked" ||
   code === "format_error"
  )
   return { state: "failed", reason: code };
  return { state: "unknown", reason: code || "feishu_send_failed" };
 }
 private card(message: ChannelMessage): object {
  const decision = message.decision;
  if (!decision) throw new Error("decision_required");
  const actions = decision.options.map((answer) => ({
   tag: "button",
   text: { tag: "plain_text", content: answer },
   type: "primary",
   value: {
    itemId: decision.itemId,
    revision: decision.revision,
    answer,
    threadId: message.address.threadId,
   },
   confirm: {
    title: { tag: "plain_text", content: "确认此决定？" },
    text: { tag: "plain_text", content: answer + "；决定将交由原现场消费。" },
   },
  }));
  return {
   config: { wide_screen_mode: true, update_multi: true },
   header: { title: { tag: "plain_text", content: decision.title } },
   elements: [
    {
     tag: "markdown",
     content: decision.state + "\\nOwner: " + decision.owner,
    },
    ...(actions.length ? [{ tag: "action", actions }] : []),
   ],
  };
 }
 async send(message: ChannelMessage): Promise<DeliveryReceipt> {
  try {
   if (message.replaceMessageId) {
    try {
     if (message.decision)
      await this.channel.updateCard(
       message.replaceMessageId,
       this.card(message),
      );
     else
      await this.channel.editMessage(message.replaceMessageId, message.text);
     return { state: "sent", messageId: message.replaceMessageId };
    } catch (error) {
     if (
      errorCode(error) !== "target_revoked" ||
      message.decision?.state.startsWith("open") ||
      !message.terminal ||
      message.importance !== "important"
     )
      throw error;
    }
   }
   const fresh = Boolean(message.replaceMessageId);
   const replyTo = fresh
    ? undefined
    : (message.replyTo ?? message.address.threadId);
   const options = {
    ...(replyTo ? { replyTo, replyInThread: true } : {}),
    ...(message.deliveryUuid ? { uuid: message.deliveryUuid } : {}),
   };
   const input = message.decision
    ? { card: this.card(message) }
    : { markdown: message.text };
   let result;
   try {
    result = await this.channel.send(message.address.chatId, input, options);
   } catch (error) {
    if (!replyTo || !missingAnchor(error)) throw error;
    result = await this.channel.send(
     message.address.chatId,
     input,
     message.deliveryUuid ? { uuid: message.deliveryUuid } : undefined,
    );
   }
   return {
    state: "sent",
    messageId: requiredString(result.messageId, "message_id"),
   };
  } catch (error) {
   return this.receiptFor(error);
  }
 }
}
