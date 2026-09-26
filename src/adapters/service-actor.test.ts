import { expect, test } from "bun:test";
import { openMailbox } from "../decision-bot/mailbox";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AdapterService } from "./service";
import { createWork, getAttention, getAttentionMaterial, projectAttentionMaterial, upsertAttention } from "../control/store";
import type {
 AgentRuntime,
 SessionHandle,
 ChannelAdapter,
 ChannelEvent,
 ChannelMessage,
} from "./types";

/**
 * Verifies that a channel-initiated resolve is attributed to the authenticated
 * channel owner rather than a fixed "adapter-service" pseudo-identity.
 * resolveAttentionDecision enforces actor === work.contract.decision_owner; with
 * the old fixed string the transaction would throw permission_denied.
 */
function harness() {
 const root = mkdtempSync(join(tmpdir(), "adapter-actor-")),
  db = openMailbox(join(root, "control.db"));
 const handles = new Map<string, SessionHandle>();
 const runtime: AgentRuntime = {
  kind: "test",
  capabilities: { restore: false, answer: true, steer: false },
  async start(r) {
   const handle: SessionHandle = {
    reference: { ...r, runtimeKind: "test" },
    events: { async *[Symbol.asyncIterator]() { await Promise.withResolvers<void>().promise; } },
    async submit(t) { return { state: "accepted", commandId: t.turnId }; },
    async cancel(id) { return { state: "accepted", commandId: id }; },
    async answer(id) { return { state: "accepted", commandId: id }; },
    async close() {},
   };
   handles.set(r.sessionId, handle);
   return handle;
  },
  async connect(r) { return handles.get(r.sessionId)!; },
 };
 const channel: ChannelAdapter = {
  kind: "test",
  instanceId: "channel-one",
  capabilities: { update: true, actions: true },
  async start() {},
  async stop() {},
  async send(m: ChannelMessage) { return { state: "sent", messageId: m.replaceMessageId ?? "m1" }; },
 };
 const service = new AdapterService(db, {
  runtime,
  channels: [channel],
  cwd: root,
  authorize: (i) => (i.userId === "owner" ? "operator" : null),
 });
 const event = (id: string): ChannelEvent => ({
  kind: "message",
  eventId: id,
  identity: { instanceId: "channel-one", tenantId: "tenant", userId: "owner" },
  address: { instanceId: "channel-one", tenantId: "tenant", chatId: "chat" },
  messageId: id,
  text: "question " + id,
  receivedAt: Date.now(),
 });
 return {
  root, db, service, event,
  async close() { await service.stop(); db.close(); rmSync(root, { recursive: true, force: true }); },
 };
}

test("channel resolve uses the authenticated owner, not a fixed system identity", async () => {
 const h = harness();
 try {
  await h.service.start();
  await h.service.accept(h.event("one"));
  await h.service.tick();
  const c = h.db.query("SELECT id FROM conversations").get() as { id: string };
  const work = createWork(h.db, {
   title: "decision work",
   source: "decision-test",
   contract: {
    objective: "do the work",
    acceptance: [{ id: "owner", kind: "human", description: "operator reviews" }],
    non_goals: [],
    scope: { cwd: h.root },
    budget: {},
    stop_conditions: [{ id: "approval", kind: "judgment", description: "needs ok" }],
    decision_owner: "operator",
   },
  });
  h.db.run("UPDATE conversations SET work_id=? WHERE id=?", [work.work_id, c.id]);
  upsertAttention(h.db, {
   item_id: "manual-decision",
   work_id: work.work_id,
   state: "open",
   effect_state: "not_started",
   urgency: "now",
   conclusion: "needs a decision",
   trigger: "runtime blocked",
   impact: "work held",
   recommendation: null,
   options: ["continue", "stop"],
   owner: "operator",
   expires_at: null,
   source_link: null,
   approval_id: null,
   consumer_owner: null,
   contract_revision: work.revision,
   decision_mode: "human_only",
   evidence: {},
  });
  const item = getAttention(h.db, "manual-decision")!;
  // Decisions are only accepted from the card they were projected to.
  h.db.run("INSERT INTO channel_card_bindings(item_id,conversation_id,message_id) VALUES(?,?,?)", ["manual-decision", c.id, "card-1"]);
  await h.service.accept({
   ...h.event("answer"),
   messageId: "card-1",
   kind: "decision",
   itemId: "manual-decision",
   revision: item.revision,
   answer: "continue",
  });
  const after = getAttention(h.db, "manual-decision")!;
  expect(after.state).toBe("resolved");
  expect(after.effect_state).toBe("succeeded");
 } finally {
  await h.close();
 }
});

test("channel resolve with a material projection consumes via the strict CAS path", async () => {
 const h = harness();
 try {
  await h.service.start();
  await h.service.accept(h.event("one"));
  await h.service.tick();
  const c = h.db.query("SELECT id FROM conversations").get() as { id: string };
  const work = createWork(h.db, {
   title: "decision work",
   source: "decision-test",
   contract: {
    objective: "do the work",
    acceptance: [{ id: "owner", kind: "human", description: "operator reviews" }],
    non_goals: [],
    scope: { cwd: h.root },
    budget: {},
    stop_conditions: [{ id: "approval", kind: "judgment", description: "needs ok" }],
    decision_owner: "operator",
   },
  });
  h.db.run("UPDATE conversations SET work_id=? WHERE id=?", [work.work_id, c.id]);
  upsertAttention(h.db, {
   item_id: "material-decision",
   work_id: work.work_id,
   state: "open",
   effect_state: "not_started",
   urgency: "now",
   conclusion: "needs a decision",
   trigger: "runtime blocked",
   impact: "work held",
   recommendation: null,
   options: ["continue", "stop"],
   owner: "operator",
   expires_at: null,
   source_link: null,
   approval_id: null,
   consumer_owner: null,
   contract_revision: work.revision,
   decision_mode: "human_only",
   evidence: {},
  });
  projectAttentionMaterial(h.db, "material-decision", {
   risk: "wrong call wastes the run",
   decision: "operator picks continue or stop",
   option_effects: [
    { option: "continue", effect: "proceed" },
    { option: "stop", effect: "halt" },
   ],
   decisive_evidence: [{ object_id: "obj-1", revision: 1, conclusion: "blocked on operator" }],
   validity: { expires_at: null, expired: false },
   consequence: "work drifts if misjudged",
  });
  expect(getAttentionMaterial(h.db, "material-decision")).not.toBeNull();
  const item = getAttention(h.db, "material-decision")!;
  h.db.run("INSERT INTO channel_card_bindings(item_id,conversation_id,message_id) VALUES(?,?,?)", ["material-decision", c.id, "card-1"]);
  await h.service.accept({
   ...h.event("answer"),
   messageId: "card-1",
   kind: "decision",
   itemId: "material-decision",
   revision: item.revision,
   answer: "continue",
  });
  const after = getAttention(h.db, "material-decision")!;
  expect(after.state).toBe("resolved");
  expect(after.effect_state).toBe("succeeded");
 } finally {
  await h.close();
 }
});
