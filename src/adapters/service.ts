import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
 getAttention,
 getAttentionMaterial,
 createWork,
 getWork,

 resolveAttention,
 upsertAttention,
} from "../control/store";
import {
 cancelTarget,
 writeHumanAnswer,
 registerTarget,
 getTarget,
 consumeDecision,
 observeAndProjectReceiptEffect,
 reconcileExtensionGateClosures,
} from "../decision-bot/mailbox";
import {
 ensureAdapterSchema,
 acceptCommand,
 acceptMessage,
 bindSession,
 bindingKey,
 enqueueDelivery,
 type Conversation,
 type StoredTurn,
} from "./store";
import type {
 AgentRuntime,
 ChannelAdapter,
 ChannelEvent,
 ChannelIdentity,
 ChannelAddress,
 ChannelMessage,
 SessionHandle,
 SessionReference,
 RuntimeEvent,
 CoordinatorBinding,
} from "./types";
import type { AttentionItem } from "../control/types";
import {
 beginProgressCreate,
 listDueProgress,
 markProgressCreateFailed,
 markProgressCreated,
 markProgressDegraded,
 markProgressPatched,
 markProgressRetry,
 openRuntimeDecision,
 projectProgress,
 recordProgressActivity,
 repairProgressOnStart,
 type ProgressRow,
 type ProgressView,
} from "./progress";
export type ChannelAuthorization = {
 ownerId: string;
 role?: "owner" | "requester";
 // A conversation bound to a coordinator work only ever carries that work.
 workId?: string | null;
};
export type AdapterServiceConfig = {
 runtime: AgentRuntime;
 channels: ChannelAdapter[];
 cwd: string;
 authorize: (
  identity: ChannelIdentity,
  address: ChannelAddress,
 ) => string | ChannelAuthorization | null;
 runtimeConfig?: (conversation: Conversation) => { configPath: string; requiredApprovalGate?: boolean; approvalRoot?: string } | undefined;
 provider?: string;
 model?: string;
 allowedModels?: string[];
 coordinator?: (
  conversation: Conversation,
  reference: SessionReference,
 ) => CoordinatorBinding | undefined;
 silentTurn?: (turnId: string) => boolean;
 // Clock for the progress paths only (throttles, budget, backoff); tests inject one, production uses Date.now.
 now?: () => number;
 coordinatorDecision?: (
  item: AttentionItem,
  answer: string,
  actor: string,
 ) => boolean;
};
// fast-channel §8.2 progress throttles.
const PROGRESS_TRANSITION_GAP_MS = 1000;
const PROGRESS_ACTIVITY_GAP_MS = 5000;
const PROGRESS_PATCH_CAP = 60;
const PROGRESS_BUDGET_PER_SECOND = 2;
const PROGRESS_MAX_ATTEMPTS = 4;
// A claimed PATCH is invisible to other flushers this long; a crash mid-PATCH delays the retry, nothing more.
const PROGRESS_LEASE_MS = 30000;
const ACTIVE_TURN_STATES = "'queued','submitting','running','blocked','cancelling'";
const NEXT_STEP: Record<string, string> = {
 queued: "等待前序任务",
 running: "等待工具返回",
 waiting_decision: "请查看下方决策卡",
 completed: "请查看结果消息",
 failed: "请查看结果消息",
 cancelled: "请查看结果消息",
 unknown: "请查看结果消息",
};
export class AdapterService {
 readonly token = randomUUID();
 private handles = new Map<string, SessionHandle>();
 private busy = new Set<string>();
 private stopping = false;
 private sending = false;
 private reactionSync: Promise<void> | null = null;
 private progressSending = false;
 // Timestamps of recent progress calls (create or PATCH): the global "2 per second" window.
 private progressCalls: number[] = [];
 // Per-turn last send, for the 1s / 5s gaps. Lost on restart, which only makes the next send a transition.
 private progressLast = new Map<string, { at: number; state: string }>();
 constructor(
  readonly db: Database,
  readonly config: AdapterServiceConfig,
 ) {
  if (
   new Set(config.channels.map((channel) => channel.instanceId)).size !==
   config.channels.length
  )
   throw new Error("duplicate_channel_instance");
  ensureAdapterSchema(db);
 }
 async start(): Promise<void> {
  this.stopping = false;
  const now = Date.now();
  const lostRows = this.db.query(
   "SELECT c.id AS conversation_id, json_extract(c.session_reference,'$.sessionId') AS expected_session_id FROM conversations c JOIN conversation_turns t ON t.conversation_id=c.id WHERE t.state IN ('submitting','running','cancelling') AND (c.session_reference IS NULL OR json_extract(c.session_reference,'$.sessionId') NOT IN (SELECT session_id FROM runtime_ownership WHERE expires_at>?))",
  ).all(now) as Array<{ conversation_id: string; expected_session_id: string | null }>;
  for (const row of lostRows)
   this.finalizeLostRuntime(row.conversation_id, row.expected_session_id, "owner_lost_before_receipt", true);
  this.db.run(
   "UPDATE channel_deliveries SET state='unknown',reason='delivery_receipt_lost' WHERE state='sending'",
  );
  // A create in flight at exit has an unknown outcome: it degrades the card and is never re-created.
  repairProgressOnStart(this.db, now);
  for (const row of this.db
   .query("SELECT turn_id FROM channel_progress WHERE create_state IN ('unknown','failed') AND degraded=0")
   .all() as { turn_id: string }[])
   markProgressDegraded(this.db, row.turn_id, "create_not_confirmed", now);
  const lost = this.db
   .query(
    "SELECT item_id FROM runtime_decisions WHERE dispatch_state='submitting'",
   )
   .all() as { item_id: string }[];
  for (const row of lost) {
   this.db.run(
    "UPDATE runtime_decisions SET dispatch_state='unknown' WHERE item_id=?",
    [row.item_id],
   );
   const item = getAttention(this.db, row.item_id);
   if (item?.state === "applying") {
    const {
     revision,
     created_at,
     updated_at,
     defer_until,
     acknowledged_at,
     ...values
    } = item;
    upsertAttention(this.db, {
     ...values,
     expected_revision: revision,
     state: "open",
     effect_state: "unknown",
    });
   }
  }
  const started: ChannelAdapter[] = [];
  try {
   for (const channel of this.config.channels) {
    await channel.start((event) => this.accept(event));
    started.push(channel);
   }
   await this.syncReactions();
  } catch (error) {
   this.stopping = true;
   await Promise.allSettled(started.map((channel) => channel.stop()));
   throw error;
  }
 }
 async stop(): Promise<void> {
  this.stopping = true;
  for (const channel of this.config.channels) await channel.stop();
  for (const handle of this.handles.values()) await handle.close();
  this.handles.clear();
  this.db.run("DELETE FROM runtime_ownership WHERE owner_token=?", [
   this.token,
  ]);
 }
 async accept(event: ChannelEvent): Promise<void> {
  const authorization = this.config["authorize"](event.identity, event.address);
  if (!authorization) throw new Error("unauthorized_channel_identity");
  const { ownerId: owner, role, workId = null } =
   typeof authorization === "string"
    ? { ownerId: authorization, role: "owner" as const, workId: null }
    : authorization;
  if (
   event.identity.instanceId !== event.address.instanceId ||
   event.identity.tenantId !== event.address.tenantId
  )
   throw new Error("channel_identity_mismatch");
  if (event.kind === "message") {
   const command = event.text.trim();
   if (command.startsWith("/") && role === "requester")
    throw new Error("command_owner_mismatch");
   if (command === "/cancel") {
    await this.cancelConversation(event, owner);
    return;
   }
   if (
    command === "/help" ||
    command === "/new" ||
    command === "/model" ||
    command === "/model status" ||
    command.startsWith("/model ")
   ) {
    await this.commandConversation(event, owner, command, workId);
    return;
   }
  }
  if (event.kind === "message") {
   const accepted = acceptMessage(this.db, event, owner, workId);
   if (!accepted.duplicate) void this.syncReactions().catch(() => {});
   return;
  }
  if (role === "requester") throw new Error("decision_owner_mismatch");
  this.db
   .transaction(() => {
    if (
     this.db
      .query("SELECT 1 FROM channel_inbound WHERE instance_id=? AND event_id=?")
      .get(event.identity.instanceId, event.eventId)
    )
     return;
    const item = getAttention(this.db, event.itemId);
    if (!item || item.owner !== owner)
     throw new Error("decision_owner_mismatch");
    if (
     item.revision !== event.revision ||
     item.state !== "open" ||
     (item.expires_at !== null && item.expires_at <= Date.now())
    )
     throw new Error("stale_decision");
    // A decision is only valid from the card it was projected to: bind by card message, then confirm the
    // callback came from that card's chat (and thread, when the platform reports one).
    const conversation = this.db
     .query(
      "SELECT c.* FROM channel_card_bindings b JOIN conversations c ON c.id=b.conversation_id WHERE b.item_id=? AND b.message_id=?",
     )
     .get(event.itemId, event.messageId) as Conversation | null;
    if (!conversation) throw new Error("decision_card_mismatch");
    const address = JSON.parse(conversation.address) as ChannelAddress;
    if (
     address.instanceId !== event.address.instanceId ||
     address.tenantId !== event.address.tenantId ||
     address.chatId !== event.address.chatId ||
     (event.address.threadId !== undefined &&
      event.address.threadId !== address.threadId) ||
     conversation.owner_id !== owner ||
     conversation.work_id !== item.work_id
    )
     throw new Error("decision_conversation_mismatch");
    if (this.config.coordinatorDecision?.(item, event.answer, owner)) {
     // The coordinator consumed the decision against its own contract.
    } else if (item.approval_id && item.consumer_owner) {
     const answer = writeHumanAnswer(
      this.db,
      item.consumer_owner,
      item.approval_id,
      event.answer,
      owner,
     );
     if (!answer.ok) throw new Error(answer.reason);
    } else {
     if (event.answer === "narrow") throw new Error("contract_review_required");
     // owner is the authenticated channel identity resolved from
     // config.authorize(event.identity, event.address) and already verified to
     // equal item.owner. Revision and material fingerprint are trusted
     // server-side tokens; channel payloads never supply either value.
     const material = getAttentionMaterial(this.db, item.item_id);
     if (!material) throw new Error("decision_material_unavailable");
     resolveAttention(this.db, item.item_id, {
      selected_option: event.answer,
      reason: "channel operator decision",
      attention_revision: item.revision,
      material_fingerprint: material.fingerprint,
     }, owner);
    }
    if (
     this.db
      .query("SELECT 1 FROM runtime_decisions WHERE item_id=?")
      .get(item.item_id)
    )
     queueMicrotask(() => void this.consumeAnswers());
    // The projected card itself is updated in place with the decision state; no separate receipt message.
    this.db.run("INSERT INTO channel_inbound VALUES(?,?,?,?)", [
     event.identity.instanceId,
     event.eventId,
     JSON.stringify(event),
     event.receivedAt,
    ]);
   })
   .immediate();
 }
 private async commandConversation(
  event: Extract<ChannelEvent, { kind: "message" }>,
  owner: string,
  command: string,
  workId: string | null,
 ): Promise<void> {
  const accepted = acceptCommand(this.db, event, owner, workId);
  if (accepted.duplicate) return;
  const c = accepted.conversation;
  const address = event.address;
  const deliver = (text: string) =>
   enqueueDelivery(this.db, c.id, `command:${event.eventId}`, address, text);
  const model = c.model
   ? `${c.provider}/${c.model}`
   : this.config.model
     ? `${this.config.provider ?? "default"}/${this.config.model}`
     : "default";
  const status = `当前生效模型：${model}`;
  const allowedModels = this.config.allowedModels ?? [];
  if (command === "/help") {
   deliver(
    [
     "/help：查看帮助",
     "/new：保留历史；下一条普通消息启动全新运行时",
     "/model、/model status：查看当前生效模型",
     "/model <provider>：列出该 provider 可用模型",
     "/model <provider>/<model>：设置下次全新运行时模型",
     "/cancel：取消当前运行",
     `可用模型：${allowedModels.join("、") || "未配置"}`,
    ].join("\n"),
   );
   return;
  }
  if (command === "/model" || command === "/model status") {
   deliver(status);
   return;
  }
  if (command.startsWith("/model ")) {
   const value = command.slice(7).trim();
   if (!value.includes("/")) {
    const models = allowedModels.filter((entry) =>
     entry.startsWith(`${value}/`),
    );
    deliver(
     models.length
      ? `${value} 可用模型：${models.join("、")}`
      : `${value} 没有配置模型。`,
    );
    return;
   }
   if (!/^[^/\s]+\/[^/\s]+$/.test(value) || !allowedModels.includes(value)) {
    deliver(
     "模型不允许；请使用 OVERLOAD_PI_ALLOWED_MODELS 中的 provider/model。",
    );
    return;
   }
   if (c.session_reference) {
    deliver("已有运行时；请先 /new。");
    return;
   }
   const slash = value.indexOf("/");
   this.db.run("UPDATE conversations SET provider=?,model=? WHERE id=?", [
    value.slice(0, slash),
    value.slice(slash + 1),
    c.id,
   ]);
   deliver(`下次运行模型：${value}`);
   return;
  }
  const active = this.db
   .query(
    "SELECT 1 FROM conversation_turns WHERE conversation_id=? AND state IN ('submitting','running','blocked','cancelling','unknown')",
   )
   .get(c.id);
  if (active) {
   deliver("当前运行未结束，不能新建会话。");
   return;
  }
  if (c.session_reference) {
   const handle = this.handles.get(c.id);
   if (!handle) {
    deliver("运行时不归当前实例；不能新建会话。");
    return;
   }
   let reference: SessionReference;
   try {
    reference = JSON.parse(c.session_reference) as SessionReference;
   } catch {
    deliver("运行时引用无效；不能新建会话。");
    return;
   }
   try {
    await handle.close();
   } catch {
    deliver("关闭运行时失败；不能新建会话。");
    return;
   }
   this.handles.delete(c.id);
   this.db.transaction(() => {
    this.db.run("DELETE FROM runtime_ownership WHERE session_id=?", [
     reference.sessionId,
    ]);
    this.db.run("UPDATE conversations SET session_reference=NULL WHERE id=?", [
     c.id,
    ]);
   })();
  }
  deliver("已新建会话；下一条消息将启动新的运行时。");
 }
 private async cancelConversation(
  event: Extract<ChannelEvent, { kind: "message" }>,
  owner: string,
 ): Promise<void> {
  const binding = bindingKey(event.address);
  const c = this.db
   .query("SELECT * FROM conversations WHERE binding_key=? AND owner_id=?")
   .get(binding, owner) as Conversation | null;
  if (!c) throw new Error("conversation_not_found");
  const handle = this.handles.get(c.id);
  const turn = this.db
   .transaction(() => {
    if (
     !this.db.run("INSERT OR IGNORE INTO channel_inbound VALUES(?,?,?,?)", [
      event.identity.instanceId,
      event.eventId,
      JSON.stringify(event),
      event.receivedAt,
     ]).changes
    )
     return null;
    const active = this.db
     .query(
      "SELECT * FROM conversation_turns WHERE conversation_id=? AND state IN ('submitting','running','blocked','cancelling') ORDER BY sequence LIMIT 1",
     )
     .get(c.id) as StoredTurn | null;
    if (!active) {
     enqueueDelivery(
      this.db,
      c.id,
      "cancel:" + event.eventId,
      event.address,
      "当前没有可取消的运行。",
     );
     return null;
    }
    this.db.run(
     "UPDATE conversation_turns SET state='cancelling',reason='operator_cancel_requested' WHERE id=?",
     [active.id],
    );
    const decisions = this.db
     .query("SELECT item_id FROM runtime_decisions WHERE turn_id=?")
     .all(active.id) as { item_id: string }[];
    for (const decision of decisions) {
     const target = getTarget(this.db, "extension", decision.item_id);
     if (target)
      cancelTarget(
       this.db,
       "extension",
       target.approvalId,
       target.targetVersion,
      );
     this.db.run(
      "UPDATE runtime_decisions SET dispatch_state='cancelled' WHERE item_id=? AND dispatch_state='pending'",
      [decision.item_id],
     );
    }
    return active;
   })
   .immediate();
  if (!turn) return;
  const lease = handle
   ? (this.db
      .query(
       "SELECT owner_token FROM runtime_ownership WHERE session_id=? AND expires_at>?",
      )
      .get(handle.reference.sessionId, Date.now()) as {
      owner_token: string;
     } | null)
   : null;
  let reason = "现场不可连接；取消未确认。";
  if (handle && lease?.owner_token === this.token) {
   try {
    const result = await handle.cancel(turn.id);
    reason =
     result.state === "accepted"
      ? "取消已被运行时接受；等待终态。已发生或脱离进程组的副作用不保证停止。"
      : "取消未确认：" + (result.reason ?? result.state);
   } catch {
    reason = "取消结果未知；不会自动重跑。";
   }
  }
  enqueueDelivery(
   this.db,
   c.id,
   "cancel:" + event.eventId,
   event.address,
   reason,
  );
 }
 async pump(conversationId: string): Promise<void> {
  if (this.stopping || this.busy.has(conversationId)) return;
  this.busy.add(conversationId);
  try {
   const c = this.db
    .query("SELECT * FROM conversations WHERE id=?")
    .get(conversationId) as Conversation | null;
   if (!c) return;
   const waiting = this.db
    .query(
     "SELECT 1 FROM conversation_turns WHERE conversation_id=? AND state IN ('submitting','running','unknown','blocked','cancelling')",
    )
    .get(c.id);
   const turn = this.db
    .query(
     "SELECT * FROM conversation_turns WHERE conversation_id=? AND state='queued' ORDER BY sequence LIMIT 1",
    )
    .get(c.id) as StoredTurn | null;
   if (!turn && !c.session_reference) return;
   let handle = this.handles.get(c.id);
   const reference = c.session_reference
    ? (JSON.parse(c.session_reference) as SessionReference)
    : {
       runtimeKind: this.config.runtime.kind,
       sessionId: randomUUID(),
       ownerId: c.id,
       cwd: this.config.cwd,
      };
   const now = Date.now();
   const leased = this.db.run(
    "INSERT INTO runtime_ownership(session_id,owner_token,expires_at) VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET owner_token=excluded.owner_token,expires_at=excluded.expires_at WHERE runtime_ownership.owner_token=? OR runtime_ownership.expires_at<?",
    [reference.sessionId, this.token, now + 30000, this.token, now],
   );
   if (!leased.changes) return;
   if (!handle) {
    if (c.session_reference) {
     try {
      handle = await this.config.runtime.connect(reference);
     } catch (error) {
      if (!turn || waiting || !this.config.runtime.capabilities.restore || !this.config.runtime.restore || !(error instanceof Error) || error.message !== "runtime_not_live") throw error;
      handle = await this.config.runtime.restore(reference, this.config.runtimeConfig?.(c) ?? {});
     }
    } else {
     const sessionId = reference.sessionId;
     bindSession(this.db, c.id, reference);
     handle = await this.config.runtime.start({
      sessionId,
      ownerId: c.id,
      cwd: this.config.cwd,
      provider: c.provider ?? this.config.provider,
      model: c.model ?? this.config.model,
      coordinator: this.config.coordinator?.(c, reference),
      ...this.config.runtimeConfig?.(c),
     });
     this.db.run("UPDATE conversations SET session_reference=? WHERE id=?", [
      JSON.stringify(handle.reference),
      c.id,
     ]);
    }
    this.handles.set(c.id, handle);
    void this.observe(c.id, handle);
   }
   this.projectCards();
   await this.flush();
   if (waiting || !turn) return;
   if (
    !this.db.run(
     "UPDATE conversation_turns SET state='submitting' WHERE id=? AND state='queued'",
     [turn.id],
    ).changes
   )
    return;
   let receipt;
   try {
    receipt = await handle.submit({ turnId: turn.id, text: turn.text });
   } catch (error) {
    receipt = {
     state: "unknown",
     reason: error instanceof Error ? error.message : "runtime_submit_failed",
    };
   }
   this.db.run(
    "UPDATE conversation_turns SET state=?,reason=? WHERE id=? AND state='submitting'",
    [
     receipt.state === "accepted"
      ? "running"
      : receipt.state === "rejected"
        ? "failed"
        : "unknown",
     receipt.reason ?? null,
     turn.id,
    ],
   );
   if (receipt.state !== "accepted")
    enqueueDelivery(
     this.db,
     c.id,
     "submit:" + turn.id,
     JSON.parse(c.address) as ChannelAddress,
     receipt.state === "unknown"
      ? "执行接收结果未知，已暂停；不会自动重跑。"
      : "执行请求被拒绝：" + receipt.reason,
    );
  } catch (error) {
   const c = this.db
    .query("SELECT * FROM conversations WHERE id=?")
    .get(conversationId) as Conversation | null;
   if (c)
    enqueueDelivery(
     this.db,
     c.id,
     "runtime-unavailable:" + conversationId,
     JSON.parse(c.address) as ChannelAddress,
     "现场不可连接；已保留排队消息。" +
      (error instanceof Error ? error.message : "runtime unavailable"),
    );
  } finally {
   this.busy.delete(conversationId);
  }
 }
 private async observe(
  conversationId: string,
  handle: SessionHandle,
 ): Promise<void> {
  try {
   for await (const event of handle.events) {
    if (this.stopping) return;
    const lease = this.db
     .query(
      "SELECT owner_token FROM runtime_ownership WHERE session_id=? AND expires_at>?",
     )
     .get(event.sessionId, Date.now()) as { owner_token: string } | null;
    if (lease?.owner_token !== this.token) return;
    this.recordRuntimeEvent(conversationId, event);
    if (event.kind === "blocked") {
     this.projectCards();
     await this.flush();
    }
    if (event.kind === "completed" || event.kind === "failed")
     queueMicrotask(() => void this.pump(conversationId));
   }
  } catch (error) {
   if (!this.stopping) {
    this.finalizeLostRuntime(
     conversationId,
     handle.reference.sessionId,
     error instanceof Error ? error.message : "event_stream_lost",
    );
    queueMicrotask(() => void this.pump(conversationId));
   }
  }
 }
 recordRuntimeEvent(conversationId: string, event: RuntimeEvent): void {
  this.db
   .transaction(() => {
    const c = this.db
     .query("SELECT * FROM conversations WHERE id=?")
     .get(conversationId) as Conversation | null;
    if (!c) return;
    const reference = JSON.parse(
     c.session_reference ?? "null",
    ) as SessionReference | null;
    if (reference?.sessionId !== event.sessionId)
     throw new Error("runtime_session_mismatch");
    if (
     !this.db.run(
      "INSERT OR IGNORE INTO channel_runtime_events VALUES(?,?,?)",
      [event.eventId, event.sessionId, JSON.stringify(event)],
     ).changes
    )
     return;
    if (!event.turnId) return;
    const turn = this.db
     .query("SELECT * FROM conversation_turns WHERE id=? AND conversation_id=?")
     .get(event.turnId, c.id) as StoredTurn | null;
    if (!turn) throw new Error("runtime_turn_mismatch");
    if (event.kind === "tool_started" || event.kind === "tool_finished") {
     recordProgressActivity(this.db, event, this.clock());
     return;
    }
    if (turn.state === "cancelling" && event.kind === "blocked") return;
    if (event.kind === "blocked" && event.requestId && event.options?.length) {
     let work = c.work_id ? getWork(this.db, c.work_id) : null;
     if (!work) {
      work = createWork(this.db, {
       title: turn.text.slice(0, 120),
       source: "channel",
       source_id: c.id,
       contract: {
        objective: turn.text,
        acceptance: [
         {
          id: "owner",
          kind: "human",
          description: "Operator reviews returned execution evidence",
         },
        ],
        non_goals: [],
        scope: { cwd: reference.cwd },
        budget: {},
        stop_conditions: [
         {
          id: "approval",
          kind: "judgment",
          description: "Runtime requests human approval",
         },
        ],
        decision_owner: c.owner_id,
       },
      });
      this.db.run("UPDATE conversations SET work_id=? WHERE id=?", [
       work.work_id,
       c.id,
      ]);
     }
     const itemId = "runtime:" + event.sessionId + ":" + event.requestId;
     const expiresAt = event.expiresAt ?? Date.now() + 86400000;
     registerTarget(this.db, {
      consumerOwner: "extension",
      approvalId: itemId,
      question: event.text ?? "Runtime requires a decision",
      options: event.options,
      effect: "runtime-native-answer",
      scope: { cwd: reference.cwd, gate: "native" },
      evidence: {
       request_id: event.requestId,
       session_id: event.sessionId,
       turn_id: turn.id,
      },
      expiresAt,
      workId: work.work_id,
      contractRevision: work.revision,
      decisionMode: "human_only",
      toolCallId: event.requestId,
      attemptId: turn.id,
     });
     upsertAttention(this.db, {
      item_id: itemId,
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: event.text ?? "Runtime requires a decision",
      trigger: "Runtime native request",
      impact: "Execution is held in the original session.",
      recommendation: null,
      options: event.options,
      owner: c.owner_id,
      expires_at: expiresAt,
      source_link: null,
      approval_id: itemId,
      consumer_owner: "extension",
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: {
       session_id: event.sessionId,
       turn_id: turn.id,
       request_id: event.requestId,
      },
     });
     this.db.run(
      "INSERT OR IGNORE INTO runtime_decisions(item_id,conversation_id,turn_id,request_id) VALUES(?,?,?,?)",
      [itemId, c.id, turn.id, event.requestId],
     );
     this.db.run(
      "INSERT OR IGNORE INTO channel_card_bindings(item_id,conversation_id) VALUES(?,?)",
      [itemId, c.id],
     );
     this.db.run("UPDATE conversation_turns SET state='blocked' WHERE id=?", [
      turn.id,
     ]);
     return;
    }
    if (event.kind === "output") {
     this.db.run(
      "UPDATE conversation_turns SET output=COALESCE(output,'')||? WHERE id=?",
      [event.text ?? "", turn.id],
     );
     return;
    }
    if (["completed", "failed", "unknown", "blocked"].includes(event.kind)) {
     // A turn parked on a channel approval gate reports completed; its card, not a result message, speaks for it.
     const gateBlocked = turn.state === "blocked" && event.kind === "completed";
     const state =
      turn.state === "cancelling" || event.kind === "blocked"
       ? "unknown"
       : event.kind;
     this.db.run(
      "UPDATE conversation_turns SET state=?,reason=?,reaction_state=CASE WHEN received_reaction_id IS NULL THEN reaction_state ELSE 'done_pending' END WHERE id=? AND state NOT IN ('completed','failed')",
      [
       state,
       turn.state === "cancelling"
        ? "cancelled_effects_unconfirmed"
        : (event.reason ?? null),
       turn.id,
      ],
     );
     if (
      !gateBlocked &&
      (state !== "completed" || !this.config.silentTurn?.(turn.id))
     )
      enqueueDelivery(
      this.db,
      c.id,
      "result:" + turn.id + ":" + state,
      JSON.parse(c.address) as ChannelAddress,
      turn.state === "cancelling"
       ? "运行时已返回终态；取消前及后台副作用未确认，现场保持隔离。"
       : (event.text ??
          turn.output ??
          (state === "completed"
           ? "本轮已结束。"
           : state === "unknown"
             ? "结果未知，保留现场，不自动重跑。"
             : (event.reason ?? "执行失败"))),
      {
       replyTo: turn.source_message_id ?? undefined,
       importance: "important",
       terminal: true,
      },
     );
    }
    if (
     event.kind === "completed" ||
     event.kind === "failed" ||
     event.kind === "unknown"
    ) {
     this.db.run(
      "UPDATE approval_channel_bindings SET state='closed' WHERE turn_id=? AND state='active'",
      [turn.id],
     );
     if (turn.state === "cancelling") {
      const pending = this.db
       .query("SELECT item_id FROM runtime_decisions WHERE turn_id=?")
       .all(turn.id) as { item_id: string }[];
      for (const row of pending) {
       const item = getAttention(this.db, row.item_id);
       if (!item) continue;
       const {
        revision,
        created_at,
        updated_at,
        defer_until,
        acknowledged_at,
        ...values
       } = item;
       upsertAttention(this.db, {
        ...values,
        expected_revision: revision,
        state: "open",
        effect_state: "unknown",
        conclusion: "取消运行；副作用尚未确认",
        evidence: {
         ...item.evidence,
         runtime_event: event.eventId,
         cancellation_requested: true,
        },
       });
      }
     }
     if (turn.state === "cancelling") return;
     const decisions = this.db
      .query(
       "SELECT * FROM runtime_decisions WHERE turn_id=? AND receipt_id IS NOT NULL",
      )
      .all(turn.id) as {
      item_id: string;
      receipt_id: string;
      request_id: string;
     }[];
     for (const decision of decisions) {
      const item = getAttention(this.db, decision.item_id);
      if (
       !item ||
       item.effect_state === "succeeded" ||
       item.effect_state === "failed"
      )
       continue;
      const observation = {
       receiptId: decision.receipt_id,
       toolCallId: decision.request_id,
       attemptId: turn.id,
       state: event.kind === "completed" ? "succeeded" : event.kind === "failed" ? "failed" : "unknown",
       evidence: {
        runtime_event: event.eventId,
        text: event.text ?? turn.output,
       },
       observedAt: Date.now(),
      } as const;
      // Atomic observe + project; mailbox owns source/outbox lookup.
      if (!observeAndProjectReceiptEffect(this.db, observation))
       throw new Error(`runtime effect observation rejected: ${decision.request_id}`);
     }
    }
   })
   .immediate();
 }
 /**
  * Finalize a runtime that is lost: mark all in-flight turns unknown, enqueue
  * one terminal result delivery per turn (business_key UNIQUE prevents
  * duplicates across restart/tick), close any open approval bindings.
  *
  * Fencing inside the same IMMEDIATE transaction prevents stale old observers
  * from poisoning a conversation that has moved on (e.g. /new creates a new
  * session after the old observe() crashed; old observe's handle still holds
  * the OLD sessionId so we compare it against the CURRENT conversation's
  * session_reference).
  *
  * @param expectedSessionId sessionId the caller believes it owns; must equal
  *   the CURRENT conversation's sessionId for non-start paths. Pass null from
  *   start() for orphan (session_reference IS NULL) rows — the lease check
  *   handles that case differently.
  */
 private finalizeLostRuntime(
  conversationId: string,
  expectedSessionId: string | null,
  reason: string,
  fromStart = false,
 ): void {
  const now = Date.now();
  this.db
   .transaction(() => {
    // 1. Load conversation (single authoritative row for this conversation_id).
    const c = this.db
     .query("SELECT * FROM conversations WHERE id=?")
     .get(conversationId) as Conversation | null;
    if (!c) return;
    const currentReference: unknown = c.session_reference ? JSON.parse(c.session_reference) : null;
    const currentId = currentReference && typeof currentReference === "object" && "sessionId" in currentReference
      && typeof currentReference.sessionId === "string" ? currentReference.sessionId : null;
    if (currentId !== expectedSessionId) return;
    // 3. Lease fence: only an owner we still consider ours may touch turns.
    //    fromStart=true: accept if NO unexpired owner exists — that's the
    //                    canonical "ownerless lost" scenario.
    //    fromStart=false: require THIS token owns an unexpired lease.
    if (expectedSessionId) {
     const lease = this.db
      .query(
       "SELECT owner_token,expires_at FROM runtime_ownership WHERE session_id=?",
      )
      .get(expectedSessionId) as { owner_token: string; expires_at: number } | null;
     if (fromStart) {
      // start() path: bail if a fresh owner already claimed this session.
      if (lease && lease.expires_at > now) return;
     } else {
      // observe().catch() path: bail if wrong owner OR no lease (race with
      // pump() which already moved on).
      if (!lease || lease.owner_token !== this.token) return;
      if (lease.expires_at <= now) return;
     }
    }
    // 4. Select + update in same tx — CAS on state IN filter means duplicate
    //    calls across restart are safe (already-'unknown' rows silently drop).
    const turns = this.db
     .query(
      "SELECT * FROM conversation_turns WHERE conversation_id=? AND state IN ('submitting','running','cancelling')",
     )
     .all(conversationId) as StoredTurn[];
    for (const turn of turns) {
     const finalReason =
      turn.state === "cancelling" ? "cancelled_effects_unconfirmed" : reason;
     this.db.run(
      "UPDATE conversation_turns SET state='unknown',reason=?,reaction_state=CASE WHEN received_reaction_id IS NULL THEN reaction_state ELSE 'done_pending' END WHERE id=? AND state IN ('submitting','running','cancelling')",
      [finalReason, turn.id],
     );
     enqueueDelivery(
      this.db,
      c.id,
      "result:" + turn.id + ":unknown",
      JSON.parse(c.address) as ChannelAddress,
      turn.state === "cancelling"
       ? "运行时已返回终态；取消前及后台副作用未确认，现场保持隔离。"
       : "结果未知，保留现场，不自动重跑。",
      {
       replyTo: turn.source_message_id ?? undefined,
       importance: "important",
       terminal: true,
      },
     );
     this.db.run(
      "UPDATE approval_channel_bindings SET state='closed' WHERE turn_id=? AND state='active'",
      [turn.id],
     );
    }
   })
   .immediate();
 }
 private syncReactions(): Promise<void> {
  if (this.reactionSync) return this.reactionSync;
  return (this.reactionSync = (async () => {
   const turns = this.db
    .query(
     "SELECT t.*,c.address FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.source_message_id IS NOT NULL AND t.reaction_state IN ('pending','active','done_pending')",
    )
    .all() as Array<StoredTurn & { address: string }>;
   for (const turn of turns) {
    try {
     const address = JSON.parse(turn.address) as ChannelAddress;
     const channel = this.config.channels.find(
      (value) => value.instanceId === address.instanceId,
     );
     if (!channel?.addReaction || !channel.removeReaction) continue;
     if (turn.reaction_state === "pending") {
      const reactionId = await channel.addReaction(
       turn.source_message_id!,
       "GoGoGo",
      );
      this.db.run(
       "UPDATE conversation_turns SET received_reaction_id=?,reaction_state=CASE WHEN state IN ('completed','failed','unknown') THEN 'done_pending' ELSE 'active' END WHERE id=? AND reaction_state='pending'",
       [reactionId, turn.id],
      );
     }
     const current = this.db
      .query(
       "SELECT state,received_reaction_id,reaction_state FROM conversation_turns WHERE id=?",
      )
      .get(turn.id) as Pick<
      StoredTurn,
      "state" | "received_reaction_id" | "reaction_state"
     >;
     if (current.reaction_state === "done_pending") {
      await channel.removeReaction(
       turn.source_message_id!,
       current.received_reaction_id!,
      );
      this.db.run(
       "UPDATE conversation_turns SET reaction_state='done' WHERE id=? AND reaction_state='done_pending'",
       [turn.id],
      );
      if (current.state === "completed")
       await channel.addReaction(turn.source_message_id!, "DONE");
     }
    } catch {
     /* Reaction retries on the next lifecycle sync. */
    }
   }
  })().finally(() => {
   this.reactionSync = null;
  }));
 }
 async tick(): Promise<void> {
  if (this.stopping) return;
  this.db.run("UPDATE runtime_ownership SET expires_at=? WHERE owner_token=?", [
   Date.now() + 30000,
   this.token,
  ]);
  const conversations = this.db.query("SELECT id FROM conversations").all() as {
   id: string;
  }[];
  await Promise.all(conversations.map((c) => this.pump(c.id)));
  await this.consumeAnswers();
  reconcileExtensionGateClosures(this.db, this.clock());
  this.projectGateTargets();
  this.projectCards();
  await this.flush();
  await this.syncReactions();
  // Progress runs strictly after decisions, results and reactions: it must never delay them (§8.3).
  this.projectProgressViews();
  await this.flushProgress();
 }
 private clock(): number {
  return this.config.now?.() ?? Date.now();
 }
 projectProgressViews(): void {
  const now = this.clock();
  const ids = this.db
   .query(
    `SELECT id turn_id FROM conversation_turns WHERE state IN (${ACTIVE_TURN_STATES})
     UNION SELECT turn_id FROM channel_progress WHERE degraded=0 AND view_state NOT IN ('completed','failed','cancelled','unknown')`,
   )
   .all() as { turn_id: string }[];
  for (const { turn_id } of ids)
   projectProgress(this.db, turn_id, { now, openDecision: openRuntimeDecision(this.db, turn_id) });
 }
 private progressBudgetOpen(now: number): boolean {
  this.progressCalls = this.progressCalls.filter((at) => at > now - 1000);
  return this.progressCalls.length < PROGRESS_BUDGET_PER_SECOND;
 }
 // Stale and terminal views skip the 5s coalescing gap; a state change waits 1s; anything else 5s.
 private progressThrottled(row: ProgressRow, view: ProgressView, now: number): boolean {
  if (view.terminal) return now - this.lastProgressAt(row) < PROGRESS_TRANSITION_GAP_MS;
  if (row.patch_count >= PROGRESS_PATCH_CAP) return true;
  if (view.state === "stale") return false;
  const changed = this.progressLast.get(row.turn_id)?.state !== view.state;
  return now - this.lastProgressAt(row) < (changed ? PROGRESS_TRANSITION_GAP_MS : PROGRESS_ACTIVITY_GAP_MS);
 }
 private lastProgressAt(row: ProgressRow): number {
  return Math.max(row.last_patch_at ?? 0, this.progressLast.get(row.turn_id)?.at ?? 0);
 }
 private progressMessage(row: ProgressRow, view: ProgressView) {
  const conversation = this.db
   .query("SELECT address FROM conversations WHERE id=?")
   .get(row.conversation_id) as { address: string };
  // Only fields of the already-redacted ProgressView reach the card; no turn text, output or ids.
  const lines = view.summary.split("；").map((part) => "- " + part);
  const next = NEXT_STEP[view.state];
  if (next) lines.push("- 下一步：" + next);
  return {
   deliveryUuid: row.create_uuid,
   address: JSON.parse(conversation.address) as ChannelAddress,
   title: view.title,
   text: lines.join("\n"),
  };
 }
 // Sends at most the global budget of progress calls, terminal views first, then stale, then the rest.
 // Never called from observe(), so its failures cannot reach that catch's mark-every-turn-unknown.
 async flushProgress(): Promise<void> {
  if (this.progressSending || this.stopping) return;
  this.progressSending = true;
  try {
   const rank = (view: ProgressView) => (view.terminal ? 0 : view.state === "stale" ? 1 : 2);
   const due = listDueProgress(this.db, this.clock(), this.config.silentTurn, 200)
    .filter((row) => row.desired_view_json)
    .map((row) => ({ row, view: JSON.parse(row.desired_view_json!) as ProgressView }))
    .sort((a, b) => rank(a.view) - rank(b.view));
   for (const { row, view } of due) {
    if (this.stopping) break;
    const now = this.clock();
    const channel = this.config.channels.find((c) => c.instanceId === row.channel_instance_id);
    if (row.create_state === "none" ? !channel?.createProgress : !channel?.updateProgress) continue;
    if (row.create_state === "sent" && this.progressThrottled(row, view, now)) continue;
    if (!this.progressBudgetOpen(now)) break;
    if (row.create_state === "none") await this.createProgressCard(channel!, row, view, now);
    else await this.patchProgressCard(channel!, row, view, now);
   }
  } finally {
   this.progressSending = false;
  }
 }
 private async createProgressCard(channel: ChannelAdapter, row: ProgressRow, view: ProgressView, now: number) {
  if (!beginProgressCreate(this.db, row.turn_id, now)) return;
  this.progressCalls.push(now);
  const version = row.desired_version;
  let receipt;
  try {
   receipt = await channel.createProgress!(this.progressMessage(row, view));
  } catch {
   receipt = { state: "unknown", reason: "create_exception" } as const;
  }
  const done = this.clock();
  if (receipt.state === "sent") {
   markProgressCreated(this.db, row.turn_id, receipt.messageId, version, done);
   this.progressLast.set(row.turn_id, { at: done, state: view.state });
   return;
  }
  // begin bumped attempts, so the calls made so far are row.attempts+1.
  if (receipt.state === "retryable" && row.attempts + 1 < PROGRESS_MAX_ATTEMPTS) {
   // Retryable means the server did not create it: back to 'none' (CAS on 'sending') with a delay.
   this.db.run(
    "UPDATE channel_progress SET create_state='none',next_at=?,reason=?,updated_at=? WHERE turn_id=? AND create_state='sending'",
    [done + (receipt.retryAfterMs ?? Math.min(60000, 1000 * 2 ** row.attempts)), receipt.reason, done, row.turn_id],
   );
   return;
  }
  // failed, unknown or retries exhausted: never a second card.
  markProgressCreateFailed(this.db, row.turn_id, receipt.state === "unknown" ? "unknown" : "failed", receipt.reason, done);
  markProgressDegraded(this.db, row.turn_id, receipt.reason, done);
 }
 private async patchProgressCard(channel: ChannelAdapter, row: ProgressRow, view: ProgressView, now: number) {
  const claimed = this.db.run(
   "UPDATE channel_progress SET next_at=? WHERE turn_id=? AND next_at=? AND create_state='sent' AND degraded=0 AND sent_version<desired_version",
   [now + PROGRESS_LEASE_MS, row.turn_id, row.next_at],
  ).changes;
  if (!claimed) return;
  this.progressCalls.push(now);
  // Confirm the snapshot that was sent, not whatever desired_version is by the time the PATCH returns.
  const version = row.desired_version;
  let receipt;
  try {
   receipt = await channel.updateProgress!(row.message_id!, this.progressMessage(row, view));
  } catch {
   receipt = { state: "unknown", reason: "patch_exception" } as const;
  }
  const done = this.clock();
  if (receipt.state === "sent") {
   markProgressPatched(this.db, row.turn_id, version, done);
   this.progressLast.set(row.turn_id, { at: done, state: view.state });
   return;
  }
  if (receipt.state === "retryable" && row.attempts + 1 < PROGRESS_MAX_ATTEMPTS) {
   markProgressRetry(
    this.db,
    row.turn_id,
    row.attempts,
    done + (receipt.retryAfterMs ?? Math.min(60000, 1000 * 2 ** row.attempts)),
    receipt.reason,
    done,
   );
   return;
  }
  // failed (message_not_found, revoked, permission), unknown, or retries exhausted.
  markProgressDegraded(this.db, row.turn_id, receipt.reason, done);
 }
 private async consumeAnswers(): Promise<void> {
  const rows = this.db
   .query("SELECT * FROM runtime_decisions WHERE dispatch_state='pending'")
   .all() as {
   item_id: string;
   conversation_id: string;
   turn_id: string;
   request_id: string;
  }[];
  for (const row of rows) {
   const handle = this.handles.get(row.conversation_id);
   if (!handle?.answer) continue;
   const lease = this.db
    .query(
     "SELECT owner_token FROM runtime_ownership WHERE session_id=? AND expires_at>?",
    )
    .get(handle.reference.sessionId, Date.now()) as {
    owner_token: string;
   } | null;
   if (lease?.owner_token !== this.token) continue;
   const receipt = this.db
    .transaction(() => {
     const target = getTarget(this.db, "extension", row.item_id);
     if (!target) return null;
     const answer = consumeDecision(this.db, {
      consumerOwner: "extension",
      approvalId: row.item_id,
      targetVersion: target.targetVersion,
      policyHash: "human",
      liveValid: () => true,
      contractValid: (t) => {
       const w = t.workId ? getWork(this.db, t.workId) : null;
       return w?.revision === t.contractRevision;
      },
      policyValid: () => false,
     });
     if (!answer) return null;
     this.db.run(
      "UPDATE runtime_decisions SET receipt_id=?,dispatch_state='submitting' WHERE item_id=? AND dispatch_state='pending'",
      [answer.receiptId, row.item_id],
     );
     const item = getAttention(this.db, row.item_id);
     if (item) {
      const {
       revision,
       created_at,
       updated_at,
       defer_until,
       acknowledged_at,
       ...values
      } = item;
      upsertAttention(this.db, {
       ...values,
       expected_revision: revision,
       state: "applying",
       effect_state: "applying",
      });
     }
     return answer;
    })
    .immediate();
   if (!receipt) continue;
   let result;
   try {
    result = await handle.answer(row.request_id, receipt.answer);
   } catch {
    result = { state: "unknown" };
   }
   this.db.run(
    "UPDATE runtime_decisions SET dispatch_state=? WHERE item_id=?",
    [result.state, row.item_id],
   );
   this.db.run(
    "UPDATE conversation_turns SET state=? WHERE id=? AND state NOT IN ('completed','failed')",
    [result.state === "accepted" ? "running" : "unknown", row.turn_id],
   );
   if (result.state !== "accepted") {
    const item = getAttention(this.db, row.item_id);
    if (item && item.state === "applying") {
     const {
      revision,
      created_at,
      updated_at,
      defer_until,
      acknowledged_at,
      ...values
     } = item;
     upsertAttention(this.db, {
      ...values,
      expected_revision: revision,
      state: "open",
      effect_state: "unknown",
      evidence: { ...item.evidence, dispatch_state: result.state },
     });
    }
   }
  }
 }
 // Project an extension approval gate raised inside a channel-owned turn onto a decision card in that
 // conversation. Only a gate whose evidence names exactly the bound session, turn and tool call is projected.
 private projectGateTargets(): void {
  const rows = this.db
   .query(
    "SELECT t.*,b.session_id,b.turn_id,b.tool_call_id bound_tool FROM approval_targets t JOIN approval_channel_bindings b ON b.consumer_owner=t.consumer_owner AND b.approval_id=t.approval_id AND b.target_version=t.target_version WHERE t.consumer_owner='extension' AND t.state='active' AND t.expires_at>? AND b.state='active'",
   )
   .all(Date.now()) as Array<{
   approval_id: string;
   question: string;
   options: string;
   expires_at: number;
   target_version: string;
   evidence: string;
   tool_call_id: string | null;
   request_uid: string | null;
   session_id: string;
   turn_id: string;
   bound_tool: string;
  }>;
  for (const row of rows) {
   let evidence: Record<string, unknown>;
   try {
    evidence = JSON.parse(row.evidence);
   } catch {
    continue;
   }
   const sessionId = row.session_id,
    turnId = row.turn_id,
    toolCallId = row.bound_tool;
   if (
    evidence.session_id !== sessionId ||
    evidence.turn_id !== turnId ||
    evidence.toolCallId !== toolCallId ||
    row.tool_call_id !== toolCallId ||
    typeof row.request_uid !== "string" ||
    !row.request_uid.endsWith("#" + toolCallId)
   )
    continue;
   const conversation = this.db
    .query(
     "SELECT c.* FROM conversations c JOIN conversation_turns t ON t.conversation_id=c.id WHERE json_extract(c.session_reference,'$.sessionId')=? AND t.id=? AND t.state IN ('submitting','running')",
    )
    .get(sessionId, turnId) as Conversation | null;
   if (!conversation) continue;
   const existing = getAttention(this.db, row.approval_id);
   if (existing) {
    if (
     existing.evidence.target_version !== row.target_version &&
     existing.state === "open"
    ) {
     const {
      revision,
      created_at,
      updated_at,
      defer_until,
      acknowledged_at,
      ...values
     } = existing;
     upsertAttention(this.db, {
      ...values,
      expected_revision: revision,
      state: "superseded",
      effect_state: "not_started",
     });
    }
    continue;
   }
   let work = conversation.work_id ? getWork(this.db, conversation.work_id) : null;
   if (!work) {
    work = createWork(this.db, {
     title: row.question.slice(0, 120),
     source: "channel",
     source_id: conversation.id,
     contract: {
      objective: row.question,
      acceptance: [
       {
        id: "effect",
        kind: "artifact",
        description: "Observe the real gated tool result",
       },
      ],
      non_goals: [],
      scope: {
       cwd: (JSON.parse(conversation.session_reference!) as SessionReference).cwd,
       human_only_effects: ["gated_tool"],
      },
      budget: {},
      stop_conditions: [],
      decision_owner: conversation.owner_id,
     },
    });
    this.db.run("UPDATE conversations SET work_id=? WHERE id=?", [
     work.work_id,
     conversation.id,
    ]);
   }
   upsertAttention(this.db, {
    item_id: row.approval_id,
    work_id: work.work_id,
    state: "open",
    effect_state: "not_started",
    urgency: "now",
    conclusion: row.question,
    trigger: "Runtime business approval gate",
    impact:
     "The original tool call remains blocked until this decision is consumed.",
    recommendation: null,
    options: JSON.parse(row.options),
    owner: conversation.owner_id,
    expires_at: row.expires_at,
    source_link: null,
    approval_id: row.approval_id,
    consumer_owner: "extension",
    contract_revision: work.revision,
    decision_mode: "human_only",
    evidence: { ...evidence, target_version: row.target_version },
   });
   this.db.run(
    "INSERT OR IGNORE INTO channel_card_bindings(item_id,conversation_id) VALUES(?,?)",
    [row.approval_id, conversation.id],
   );
  }
 }
 private decisionState(state: string, effectState: string, evidence: Record<string, unknown>): string {
  if (state === "superseded" && evidence.tool_executed === false) {
   if (evidence.gate_outcome === "denied" && evidence.superseded_reason === "gate_denied" && effectState === "succeeded") return "Denied";
   if (evidence.gate_outcome === "expired" && evidence.superseded_reason === "gate_expired" && effectState === "not_started") return "Expired";
   if (evidence.gate_outcome === "cancelled" && evidence.superseded_reason === "gate_cancelled" && effectState === "not_started") return "Cancelled";
  }
  if (state === "applying" || effectState === "applying") return "Applying";
  if (effectState === "unknown") return "Decision received; outcome unknown";
  if (effectState === "succeeded") return "Applied";
  if (effectState === "failed") return "Failed";
  return state === "open" ? "Awaiting decision" : state;
 }
 private projectCards(): void {
  const rows = this.db
   .query(
    "SELECT b.*,c.address FROM channel_card_bindings b JOIN conversations c ON c.id=b.conversation_id",
   )
   .all() as {
   item_id: string;
   conversation_id: string;
   message_id: string | null;
   last_revision: number;
   last_state: string | null;
   address: string;
  }[];
  for (const row of rows) {
   const item = getAttention(this.db, row.item_id);
   if (!item) continue;
   // last_state stores what the card last showed, so compare in the same display vocabulary.
   const state = this.decisionState(item.state, item.effect_state, item.evidence);
   if (row.last_revision === item.revision && row.last_state === state)
    continue;
   const id = randomUUID();
   const message: ChannelMessage = {
    deliveryId: id,
    address: JSON.parse(row.address) as ChannelAddress,
    text: item.conclusion,
    replaceMessageId: row.message_id ?? undefined,
    importance: item.urgency === "now" ? "important" : undefined,
    terminal: item.state !== "open",
    decision: {
     itemId: item.item_id,
     revision: item.revision,
     title: item.conclusion,
     owner: item.owner,
     options:
      item.state === "open" && item.effect_state === "not_started"
       ? item.options
       : [],
     state,
     expiresAt: item.expires_at ?? undefined,
    },
   };
   this.db.run(
    "INSERT OR IGNORE INTO channel_deliveries(id,conversation_id,business_key,payload) VALUES(?,?,?,?)",
    [
     id,
     row.conversation_id,
     "card:" + row.item_id + ":" + item.revision + ":" + state,
     JSON.stringify(message),
    ],
   );
  }
 }
 async flush(): Promise<void> {
  if (this.sending || this.stopping) return;
  this.sending = true;
  try {
   const rows = this.db
    .query(
     "SELECT * FROM channel_deliveries WHERE state IN ('pending','retryable') AND next_at<=? ORDER BY rowid LIMIT 25",
    )
    .all(Date.now()) as { id: string; payload: string; attempts: number }[];
   for (const row of rows) {
    const message = JSON.parse(row.payload) as ChannelMessage;
    message.deliveryUuid =
     "overload-" + row.id.replaceAll("-", "").slice(0, 32);
    const channel = this.config.channels.find(
     (c) => c.instanceId === message.address.instanceId,
    );
    if (!channel) continue;
    if (message.decision) {
     const binding = this.db
      .query("SELECT message_id FROM channel_card_bindings WHERE item_id=?")
      .get(message.decision.itemId) as { message_id: string | null } | null;
     message.replaceMessageId = binding?.message_id ?? undefined;
     const previous = this.db
      .query(
       "SELECT 1 FROM channel_deliveries WHERE json_extract(payload,'$.decision.itemId')=? AND state IN ('sending','unknown','retryable') AND id<>?",
      )
      .get(message.decision.itemId, row.id);
     if (previous) continue;
    }
    if (
     !this.db.run(
      "UPDATE channel_deliveries SET state='sending',attempts=attempts+1 WHERE id=? AND state IN ('pending','retryable')",
      [row.id],
     ).changes
    )
     continue;
    let receipt;
    try {
     receipt = await channel.send(message);
    } catch {
     receipt = { state: "unknown", reason: "send_exception" } as const;
    }
    const state =
     receipt.state === "retryable" && row.attempts >= 4
      ? "failed"
      : receipt.state;
    this.db
     .transaction(() => {
      this.db.run(
       "UPDATE channel_deliveries SET state=?,message_id=?,reason=?,next_at=? WHERE id=?",
       [
        state,
        receipt.state === "sent" ? receipt.messageId : null,
        receipt.state === "sent" ? null : receipt.reason,
        Date.now() + Math.min(60000, 1000 * 2 ** row.attempts),
        row.id,
       ],
      );
      if (receipt.state === "sent" && message.decision)
       this.db.run(
        "UPDATE channel_card_bindings SET message_id=?,last_revision=?,last_state=? WHERE item_id=?",
        [
         receipt.messageId,
         message.decision.revision,
         message.decision.state,
         message.decision.itemId,
        ],
       );
     })
     .immediate();
   }
  } finally {
   this.sending = false;
  }
 }
}
