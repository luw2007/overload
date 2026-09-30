import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { acceptCommand, acceptMessage, bindingKey, ensureAdapterSchema } from "./store";
import type { ChannelAddress, ChannelEvent } from "./types";

const CHAT = "oc_5ad11d72b830411d72b836c20";
const ROOT = "om_dc13264520392913993dd051dba21dcf";
const REPLY = "om_b2f67d1e3a0c4c8e9d1f5a7b3c2e4d6f";
const TOPIC = "omt_1a3b99f9d2cfb2d2";
const base = { instanceId: "feishu-main", tenantId: "tenant", chatId: CHAT };

function db() {
 const db = new Database(":memory:");
 ensureAdapterSchema(db);
 return db;
}
function message(id: string, address: ChannelAddress): Extract<ChannelEvent, { kind: "message" }> {
 return {
  kind: "message",
  eventId: "ev-" + id,
  identity: { instanceId: "feishu-main", tenantId: "tenant", userId: "ou_owner" },
  address,
  messageId: id,
  text: "text " + id,
  receivedAt: 1_700_000_000_000,
 };
}

test("§11.1 a topic's first message and its follow-up map to one conversation", () => {
 const d = db();
 const first = acceptMessage(d, message(ROOT, { ...base, rootMessageId: ROOT }), "operator");
 const followUp = acceptMessage(d, message(REPLY, { ...base, rootMessageId: ROOT, threadId: TOPIC }), "operator");
 expect(followUp.conversationId).toBe(first.conversationId!);
 expect(d.query("SELECT binding_key FROM conversations").all()).toEqual([
  { binding_key: JSON.stringify(["feishu-main", "tenant", CHAT, ROOT]) },
 ]);
 expect(d.query("SELECT sequence,source_message_id FROM conversation_turns ORDER BY sequence").all()).toEqual([
  { sequence: 1, source_message_id: ROOT },
  { sequence: 2, source_message_id: REPLY },
 ]);
 // A slash command inside the topic resolves to the same conversation.
 const command = acceptCommand(d, { ...message("om_cmd", { ...base, rootMessageId: ROOT, threadId: TOPIC }), eventId: "ev-cmd" }, "operator");
 expect(command.conversation.id).toBe(first.conversationId!);
});

test("different roots in one chat stay separate conversations", () => {
 const d = db();
 const one = acceptMessage(d, message(ROOT, { ...base, rootMessageId: ROOT }), "operator");
 const two = acceptMessage(d, message(REPLY, { ...base, rootMessageId: REPLY }), "operator");
 expect(one.conversationId).not.toBe(two.conversationId);
});

test("addresses without a root keep the existing binding key, so stored conversations still match", () => {
 expect(bindingKey(base)).toBe(JSON.stringify(["feishu-main", "tenant", CHAT, null]));
 expect(bindingKey({ ...base, threadId: "thread-one" })).toBe(
  JSON.stringify(["feishu-main", "tenant", CHAT, "thread-one"]),
 );
 // A pre-split Feishu group conversation stored its root message in threadId; the new address keys the same.
 expect(bindingKey({ ...base, rootMessageId: ROOT, threadId: TOPIC })).toBe(bindingKey({ ...base, threadId: ROOT }));
});
