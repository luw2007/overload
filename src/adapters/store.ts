import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
 ChannelEvent,
 ChannelAddress,
 ChannelMessage,
 SessionReference,
} from "./types";
export function ensureAdapterSchema(db: Database): void {
 db.exec(`
CREATE TABLE IF NOT EXISTS channel_inbound(instance_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,received_at INTEGER NOT NULL,PRIMARY KEY(instance_id,event_id));
CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,binding_key TEXT UNIQUE NOT NULL,address TEXT NOT NULL,owner_id TEXT NOT NULL,session_reference TEXT,work_id TEXT,coordinator_work_id TEXT,provider TEXT,model TEXT,created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_turns(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,sequence INTEGER NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,output TEXT,reason TEXT,created_at INTEGER NOT NULL,source_message_id TEXT,received_reaction_id TEXT,reaction_state TEXT NOT NULL DEFAULT 'pending',UNIQUE(conversation_id,sequence));
CREATE TABLE IF NOT EXISTS channel_deliveries(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,business_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',message_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL DEFAULT 0,reason TEXT);
CREATE TABLE IF NOT EXISTS approval_channel_bindings(consumer_owner TEXT NOT NULL,approval_id TEXT NOT NULL,target_version TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,PRIMARY KEY(consumer_owner,approval_id,target_version));
CREATE TABLE IF NOT EXISTS runtime_ownership(session_id TEXT PRIMARY KEY,owner_token TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS channel_runtime_events(event_id TEXT NOT NULL,session_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(session_id,event_id));
CREATE TABLE IF NOT EXISTS runtime_decisions(item_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,turn_id TEXT NOT NULL,request_id TEXT NOT NULL,receipt_id TEXT,dispatch_state TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS channel_card_bindings(item_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,message_id TEXT,last_revision INTEGER NOT NULL DEFAULT 0,last_state TEXT);
CREATE TABLE IF NOT EXISTS channel_progress(
 turn_id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL,
 channel_instance_id TEXT NOT NULL,
 message_id TEXT,
 create_state TEXT NOT NULL DEFAULT 'none' CHECK (create_state IN ('none','sending','sent','unknown','failed')),
 create_uuid TEXT NOT NULL,
 view_state TEXT NOT NULL DEFAULT 'queued',
 desired_version INTEGER NOT NULL DEFAULT 0 CHECK (desired_version >= 0),
 sent_version INTEGER NOT NULL DEFAULT 0 CHECK (sent_version >= 0),
 desired_hash TEXT,
 desired_view_json TEXT,
 last_activity_at INTEGER,
 last_activity_label TEXT,
 completed_tool_count INTEGER NOT NULL DEFAULT 0,
 last_patch_at INTEGER,
 patch_count INTEGER NOT NULL DEFAULT 0 CHECK (patch_count >= 0),
 next_at INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0,1)),
 reason TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 FOREIGN KEY (turn_id) REFERENCES conversation_turns(id),
 FOREIGN KEY (conversation_id) REFERENCES conversations(id),
 CHECK (desired_view_json IS NULL OR json_valid(desired_view_json)),
 CHECK (sent_version <= desired_version)
);
CREATE INDEX IF NOT EXISTS channel_progress_due ON channel_progress(next_at, turn_id) WHERE degraded=0 AND desired_version > sent_version;
`);
 const columns = new Set(
  (
   db.query("PRAGMA table_info(conversation_turns)").all() as { name: string }[]
  ).map((row) => row.name),
 );
 if (!columns.has("source_message_id"))
  db.exec("ALTER TABLE conversation_turns ADD COLUMN source_message_id TEXT");
 if (!columns.has("received_reaction_id"))
  db.exec(
   "ALTER TABLE conversation_turns ADD COLUMN received_reaction_id TEXT",
  );
 if (!columns.has("reaction_state"))
  db.exec(
   "ALTER TABLE conversation_turns ADD COLUMN reaction_state TEXT NOT NULL DEFAULT 'pending'",
  );
 const conversationColumns = new Set(
  (
   db.query("PRAGMA table_info(conversations)").all() as { name: string }[]
  ).map((column) => column.name),
 );
 if (!conversationColumns.has("provider"))
  db.exec("ALTER TABLE conversations ADD COLUMN provider TEXT");
 if (!conversationColumns.has("model"))
  db.exec("ALTER TABLE conversations ADD COLUMN model TEXT");
 if (!conversationColumns.has("coordinator_work_id"))
  db.exec("ALTER TABLE conversations ADD COLUMN coordinator_work_id TEXT");
}
// The root message is the conversation key, so a topic's first message and its follow-ups share one
// conversation. Addresses without a root (other channels, rows written before the split) keep keying on
// threadId, which is what every existing binding_key already holds.
export function bindingKey(address: ChannelAddress): string {
 return JSON.stringify([
  address.instanceId,
  address.tenantId,
  address.chatId,
  address.rootMessageId ?? address.threadId ?? null,
 ]);
}
export type Conversation = {
 id: string;
 binding_key: string;
 address: string;
 owner_id: string;
 session_reference: string | null;
 work_id: string | null;
 coordinator_work_id: string | null;
 provider: string | null;
 model: string | null;
 created_at: number;
};
export type StoredTurn = {
 id: string;
 conversation_id: string;
 sequence: number;
 text: string;
 state: string;
 output: string | null;
 reason: string | null;
 created_at: number;
 source_message_id: string | null;
 received_reaction_id: string | null;
 reaction_state: "pending" | "active" | "done_pending" | "done";
};
export function acceptCommand(
 db: Database,
 event: Extract<ChannelEvent, { kind: "message" }>,
 ownerId: string,
 workId: string | null = null,
): { duplicate: boolean; conversation: Conversation } {
 return db.transaction(() => {
  const inserted = db.run(
   "INSERT OR IGNORE INTO channel_inbound VALUES(?,?,?,?)",
   [
    event.identity.instanceId,
    event.eventId,
    JSON.stringify(event),
    event.receivedAt,
   ],
  );
  const binding = bindingKey(event.address);
  let conversation = db
   .query("SELECT * FROM conversations WHERE binding_key=?")
   .get(binding) as Conversation | null;
  if (conversation && conversation.owner_id !== ownerId)
   throw new Error("conversation_owner_mismatch");
  if (conversation && conversation.coordinator_work_id !== workId)
   throw new Error("conversation_work_mismatch");
  if (!conversation) {
   const id = randomUUID();
   db.run(
    "INSERT INTO conversations(id,binding_key,address,owner_id,work_id,coordinator_work_id,created_at) VALUES(?,?,?,?,?,?,?)",
    [id, binding, JSON.stringify(event.address), ownerId, workId, workId, event.receivedAt],
   );
   conversation = db
    .query("SELECT * FROM conversations WHERE id=?")
    .get(id) as Conversation;
  }
  return { duplicate: !inserted.changes, conversation };
 })();
}
export function acceptMessage(
 db: Database,
 event: Extract<ChannelEvent, { kind: "message" }>,
 ownerId: string,
 workId: string | null = null,
): {
 duplicate: boolean;
 conversationId: string | null;
 turnId: string | null;
} {
 return db
  .transaction(() => {
   if (
    !event.eventId ||
    !event.text.trim() ||
    event.text.length > 100000 ||
    !event.address.chatId ||
    !ownerId
   )
    throw new Error("invalid_channel_message");
   const inserted = db.run(
    "INSERT OR IGNORE INTO channel_inbound VALUES(?,?,?,?)",
    [
     event.identity.instanceId,
     event.eventId,
     JSON.stringify(event),
     event.receivedAt,
    ],
   );
   if (!inserted.changes)
    return { duplicate: true, conversationId: null, turnId: null };
   const binding = bindingKey(event.address);
   let conversation = db
    .query("SELECT * FROM conversations WHERE binding_key=?")
    .get(binding) as Conversation | null;
   if (conversation && conversation.owner_id !== ownerId)
    throw new Error("conversation_owner_mismatch");
   if (conversation && conversation.coordinator_work_id !== workId)
    throw new Error("conversation_work_mismatch");
   if (!conversation) {
    const id = randomUUID();
    db.run(
     "INSERT INTO conversations(id,binding_key,address,owner_id,work_id,coordinator_work_id,created_at) VALUES(?,?,?,?,?,?,?)",
     [id, binding, JSON.stringify(event.address), ownerId, workId, workId, event.receivedAt],
    );
    conversation = db
     .query("SELECT * FROM conversations WHERE id=?")
     .get(id) as Conversation;
   }
   const row = db
    .query(
     "SELECT COALESCE(MAX(sequence),0)+1 n FROM conversation_turns WHERE conversation_id=?",
    )
    .get(conversation.id) as { n: number };
   const sequence = row.n;
   const turnId = randomUUID();
   db.run(
    "INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,created_at,source_message_id) VALUES(?,?,?,?,?,?,?)",
    [
     turnId,
     conversation.id,
     sequence,
     event.text,
     "queued",
     event.receivedAt,
     event.messageId,
    ],
   );
   return { duplicate: false, conversationId: conversation.id, turnId };
  })
  .immediate();
}
export function bindSession(
 db: Database,
 conversationId: string,
 reference: SessionReference,
): void {
 const updated = db.run(
  "UPDATE conversations SET session_reference=? WHERE id=? AND session_reference IS NULL",
  [JSON.stringify(reference), conversationId],
 );
 if (!updated.changes) throw new Error("session_already_bound");
}
export function enqueueDelivery(
 db: Database,
 conversationId: string,
 businessKey: string,
 address: ChannelAddress,
 text: string,
 options: Pick<ChannelMessage, "replyTo" | "importance" | "terminal"> = {},
): void {
 const id = randomUUID();
 db.run(
  "INSERT OR IGNORE INTO channel_deliveries(id,conversation_id,business_key,payload) VALUES(?,?,?,?)",
  [
   id,
   conversationId,
   businessKey,
   JSON.stringify({ deliveryId: id, address, text, ...options }),
  ],
 );
}
