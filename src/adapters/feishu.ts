import { createLarkChannel } from "@larksuiteoapi/node-sdk";
import type {
 CardActionEvent,
 NormalizedMessage,
} from "@larksuiteoapi/node-sdk";
import type {
 ChannelAdapter,
 ChannelAddress,
 ChannelEvent,
 ChannelMessage,
 DeliveryReceipt,
 ProgressMessage,
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
 // The SDK's send() drops `uuid` (1.73.3 SendOptions has no such field), so anything that needs Feishu's
 // server-side dedupe goes through the raw open-platform message API instead.
 rawClient: { im: { v1: { message: FeishuRawMessageApi } } };
};
type FeishuRawMessageApi = {
 create(payload: {
  params: { receive_id_type: "chat_id" };
  data: { receive_id: string; msg_type: string; content: string; uuid: string };
 }): Promise<unknown>;
 reply(payload: {
  path: { message_id: string };
  data: { msg_type: string; content: string; reply_in_thread: boolean; uuid: string };
 }): Promise<unknown>;
 patch(payload: {
  path: { message_id: string };
  data: { content: string };
 }): Promise<unknown>;
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
export type FeishuErrorKind =
 | "rate_limited"
 | "not_connected"
 | "target_revoked"
 | "message_not_found"
 | "permission_denied"
 | "format_error"
 | "unknown";
// Feishu business codes, from the open-platform im/v1 message reply and patch references. The SDK's own
// inferCode() gets two of these wrong (230020 as target_revoked, 99991400 as permission_denied), so a
// numeric code always wins over the SDK's string code.
const FEISHU_CODES: Record<number, FeishuErrorKind> = {
 99991400: "rate_limited",
 230020: "rate_limited",
 230011: "target_revoked",
 230019: "target_revoked",
 230110: "message_not_found",
 230001: "format_error",
 230025: "format_error",
 230099: "format_error",
 230002: "permission_denied",
 230006: "permission_denied",
 230013: "permission_denied",
 230017: "permission_denied",
 230027: "permission_denied",
 230031: "permission_denied",
 230035: "permission_denied",
 232009: "permission_denied",
};
const SDK_CODES = new Set<string>([
 "rate_limited",
 "not_connected",
 "target_revoked",
 "message_not_found",
 "permission_denied",
 "format_error",
]);
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH"]);
function field(value: unknown, name: string): unknown {
 return value && typeof value === "object" ? (value as Record<string, unknown>)[name] : undefined;
}
function header(headers: unknown, name: string): number | undefined {
 const get = field(headers, "get");
 const value =
  typeof get === "function" ? get.call(headers, name) : field(headers, name);
 const seconds = Number(value);
 return value !== undefined && value !== null && Number.isFinite(seconds) && seconds >= 0
  ? seconds * 1000
  : undefined;
}
/**
 * One classification for every Feishu failure shape: an SDK LarkChannelError (string `code`, raw error in
 * `cause`), an axios error (`response.status`, `response.data.code`, `response.headers`), or a 200 body with
 * a non-zero `code`. Anything unrecognised is `unknown`: the request may have landed, so callers must not
 * send a replacement.
 */
export function classifyFeishuError(error: unknown): {
 kind: FeishuErrorKind;
 code: string;
 retryAfterMs?: number;
} {
 const sources = [error, field(error, "cause")].filter(Boolean);
 let kind: FeishuErrorKind | undefined;
 let code = "";
 let retryAfterMs: number | undefined;
 for (const source of sources) {
  const response = field(source, "response");
  const numeric = [field(field(response, "data"), "code"), field(field(source, "data"), "code"), field(source, "code")].find(
   (value) => typeof value === "number" && value !== 0,
  ) as number | undefined;
  const status = field(response, "status") ?? field(source, "status");
  const headers = field(response, "headers") ?? field(source, "headers");
  retryAfterMs ??= header(headers, "retry-after") ?? header(headers, "x-ogw-ratelimit-reset");
  if (!kind && numeric !== undefined && FEISHU_CODES[numeric]) {
   kind = FEISHU_CODES[numeric];
   code = String(numeric);
  } else if (!kind && status === 429) kind = "rate_limited";
  else if (!kind && (status === 401 || status === 403)) kind = "permission_denied";
  else if (!kind && status === 404) kind = "message_not_found";
  if (!code && numeric !== undefined) code = String(numeric);
 }
 const named = field(error, "code");
 if (!kind && typeof named === "string") {
  if (SDK_CODES.has(named)) kind = named as FeishuErrorKind;
  else if (NETWORK_CODES.has(named)) kind = "not_connected";
 }
 if (!code && typeof named === "string") code = named;
 return {
  kind: kind ?? "unknown",
  code: code || "feishu_send_failed",
  ...(kind === "rate_limited" && retryAfterMs !== undefined ? { retryAfterMs } : {}),
 };
}
function receipt(error: unknown): DeliveryReceipt {
 const { kind, code, retryAfterMs } = classifyFeishuError(error);
 const reason = kind === "unknown" ? code : kind;
 if (kind === "rate_limited" || kind === "not_connected")
  return { state: "retryable", reason, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
 if (kind === "unknown") return { state: "unknown", reason };
 return { state: "failed", reason };
}
function missingAnchor(error: unknown): boolean {
 const { kind } = classifyFeishuError(error);
 return kind === "target_revoked" || kind === "message_not_found";
}
/** The message a reply must anchor to. A Feishu thread id (omt_*) is never a valid reply target. */
export function replyAnchor(address: ChannelAddress): string | undefined {
 // Addresses stored before rootMessageId existed carried the root in threadId when it was a message id.
 return address.rootMessageId ?? (address.threadId?.startsWith("om_") ? address.threadId : undefined);
}
function rawMessageId(response: unknown): string {
 const code = field(response, "code");
 if (typeof code === "number" && code !== 0) throw response;
 return requiredString(field(field(response, "data"), "message_id"), "message_id");
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
  // A group message with no root starts its own topic, so it is the root. A direct message with no root
  // stays keyed on the chat, as before.
  const rootMessageId =
   message.rootId ?? (message.chatType === "group" ? message.messageId : undefined);
  const threadId = message.threadId;
  const reply = { replyTo: rootMessageId ?? message.messageId };
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
     ...(rootMessageId ? { rootMessageId } : {}),
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
     reply,
    );
    return;
   }
   if (error instanceof Error && error.message === "command_owner_mismatch") {
    await this.channel.send(
     message.chatId,
     { markdown: "仅会话 Owner 可以执行该命令。" },
     reply,
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
  const rootMessageId =
   typeof value.rootMessageId === "string" && value.rootMessageId
    ? value.rootMessageId
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
     ...(rootMessageId ? { rootMessageId } : {}),
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
   if (
    error instanceof Error &&
    (error.message === "stale_decision" ||
     error.message === "stale attention revision" ||
     error.message === "decision_material_unavailable")
   ) {
    await this.channel.send(
     action.chatId,
     { markdown: "该决定已更新或失效，请刷新后查看当前状态。" },
     { replyTo: action.messageId },
    );
    return;
   }
   // Plan §4.5: another entry already consumed this decision, or the target can no longer accept it.
   // Local mailbox facts win, so Feishu reports current state and never retries the answer — returning
   // here (rather than rethrowing) is what keeps the channel from re-delivering it.
   if (
    error instanceof Error &&
    (error.message === "already_consumed" ||
     error.message === "expired" ||
     error.message === "owner_conflict")
   ) {
    await this.channel.send(
     action.chatId,
     {
      markdown: error.message === "already_consumed"
       ? "该决定已在其他入口被记录，本次回答不会重复生效；卡片显示的是当前状态。"
       : error.message === "expired"
        ? "该决定已过期，本次回答不会生效；请刷新后查看当前状态。"
        : "该决定由其他入口的所有者持有，本次回答不会生效；请刷新后查看当前状态。",
     },
     { replyTo: action.messageId },
    );
    return;
   }
   throw error;
  }
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
    rootMessageId: message.address.rootMessageId,
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
      !missingAnchor(error) ||
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
    : (replyAnchor(message.address) ?? message.replyTo);
   // uuid is passed for forward compatibility only: SDK 1.73.3 send() does not forward it, so this path
   // gets no server-side dedupe. Progress cards, which need it, use createProgress().
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
   return receipt(error);
  }
 }
 private progressCard(message: ProgressMessage): string {
  // No mentions, no actions: the progress card is low-noise status, and decisions keep their own card.
  return JSON.stringify({
   config: { wide_screen_mode: true, update_multi: true },
   header: { title: { tag: "plain_text", content: message.title } },
   elements: [{ tag: "markdown", content: message.text }],
  });
 }
 /**
  * Creates a progress card through the raw message API so the stable uuid reaches Feishu. There is no
  * anchor fallback and no retry here: an unknown result must never be answered with a second card.
  */
 async createProgress(message: ProgressMessage): Promise<DeliveryReceipt> {
  const api = this.channel.rawClient.im.v1.message;
  const content = this.progressCard(message);
  const root = replyAnchor(message.address);
  try {
   const response = root
    ? await api.reply({
       path: { message_id: root },
       data: { msg_type: "interactive", content, reply_in_thread: true, uuid: message.deliveryUuid },
      })
    : await api.create({
       params: { receive_id_type: "chat_id" },
       data: {
        receive_id: message.address.chatId,
        msg_type: "interactive",
        content,
        uuid: message.deliveryUuid,
       },
      });
   return { state: "sent", messageId: rawMessageId(response) };
  } catch (error) {
   return receipt(error);
  }
 }
 async updateProgress(messageId: string, message: ProgressMessage): Promise<DeliveryReceipt> {
  try {
   const response = await this.channel.rawClient.im.v1.message.patch({
    path: { message_id: messageId },
    data: { content: this.progressCard(message) },
   });
   const code = field(response, "code");
   if (typeof code === "number" && code !== 0) throw response;
   return { state: "sent", messageId };
  } catch (error) {
   return receipt(error);
  }
 }
}
