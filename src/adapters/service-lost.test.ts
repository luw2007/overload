import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openMailbox } from "../decision-bot/mailbox";
import { AdapterService } from "./service";
import type { AgentRuntime, ChannelAdapter, ChannelEvent, ChannelMessage, SessionHandle } from "./types";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "adapter-loss-")), db = openMailbox(join(root, "control.db"));
  const submitted: string[] = [], sent: ChannelMessage[] = [], reactions: string[] = [];
  const handles = new Map<string, SessionHandle>(), failures = new Map<string, () => void>(), drained = new Map<string, Promise<void>>();
  const runtime: AgentRuntime = {
    kind: "test", capabilities: { restore: false, answer: false, steer: false },
    async start(request) {
      const loss = Promise.withResolvers<void>(), done = Promise.withResolvers<void>();
      failures.set(request.sessionId, () => loss.resolve()); drained.set(request.sessionId, done.promise);
      const handle: SessionHandle = { reference: { ...request, runtimeKind: "test" },
        events: { async *[Symbol.asyncIterator]() { try { await loss.promise; throw new Error("stream_lost"); } finally { done.resolve(); } } },
        async submit(turn) { submitted.push(turn.turnId); return { state: "accepted", commandId: turn.turnId }; },
        async cancel(turnId) { return { state: "rejected", commandId: turnId }; }, async close() {},
      };
      handles.set(request.sessionId, handle); return handle;
    },
    async connect(reference) { const handle = handles.get(reference.sessionId); if (!handle) throw new Error("missing handle"); return handle; },
  };
  const channel: ChannelAdapter = { kind: "test", instanceId: "channel", capabilities: { update: true, actions: true },
    async start() {}, async stop() {}, async send(message) { sent.push(message); return { state: "sent", messageId: "result-" + sent.length }; },
    async addReaction(messageId, type) { reactions.push(messageId + ":add:" + type); return "reaction"; },
    async removeReaction(messageId) { reactions.push(messageId + ":removed"); },
  };
  const service = new AdapterService(db, { runtime, channels: [channel], cwd: root, authorize: () => "owner" });
  const event: ChannelEvent = { kind: "message", eventId: "one", identity: { instanceId: "channel", tenantId: "tenant", userId: "owner" },
    address: { instanceId: "channel", tenantId: "tenant", chatId: "chat" }, messageId: "om_source", text: "work", receivedAt: Date.now() };
  return { db, service, submitted, sent, reactions, event, failures, drained,
    async close() { await service.stop(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("event iterator loss delivers one unknown result, clears reaction, and fences queued input", async () => {
  const f = fixture();
  try {
    await f.service.start(); await f.service.accept(f.event); await f.service.tick();
    const binding = f.db.query("SELECT session_reference FROM conversations").get() as { session_reference: string };
    const reference: unknown = JSON.parse(binding.session_reference);
    if (!reference || typeof reference !== "object" || !("sessionId" in reference) || typeof reference.sessionId !== "string") throw new Error("invalid reference");
    const sessionId = reference.sessionId;
    f.db.run("UPDATE conversation_turns SET output='partial secret output'");
    f.failures.get(sessionId)!(); await f.drained.get(sessionId); await Promise.resolve();
    await f.service.accept({ ...f.event, eventId: "two", messageId: "om_next" });
    await f.service.tick(); await f.service.tick();
    expect(f.db.query("SELECT state,reason,reaction_state FROM conversation_turns WHERE sequence=1").get())
      .toEqual({ state: "unknown", reason: "stream_lost", reaction_state: "done" });
    expect(f.submitted).toHaveLength(1);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]).toMatchObject({ replyTo: "om_source", importance: "important", terminal: true });
    expect(f.sent[0].text).not.toContain("partial secret output");
    expect(f.reactions.filter(reaction => reaction.startsWith("om_source:"))).toEqual(["om_source:add:GoGoGo", "om_source:removed"]);
    expect(f.db.query("SELECT COUNT(*) n FROM channel_deliveries WHERE business_key LIKE 'result:%:unknown'").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("an old observer cannot finalize a replacement session or a new lease owner's turn", async () => {
  for (const mode of ["replacement-session", "foreign-lease"] as const) {
    const f = fixture();
    try {
      await f.service.start(); await f.service.accept(f.event); await f.service.tick();
      const binding = f.db.query("SELECT id,session_reference FROM conversations").get() as { id: string; session_reference: string };
      const reference: unknown = JSON.parse(binding.session_reference);
      if (!reference || typeof reference !== "object" || !("sessionId" in reference) || typeof reference.sessionId !== "string") throw new Error("invalid reference");
      if (mode === "replacement-session") {
        f.db.run("UPDATE conversations SET session_reference=? WHERE id=?", [JSON.stringify({ ...reference, sessionId: "replacement" }), binding.id]);
        f.db.run("INSERT INTO runtime_ownership VALUES(?,?,?)", ["replacement", f.service.token, Date.now() + 60000]);
      } else f.db.run("UPDATE runtime_ownership SET owner_token='new-owner',expires_at=?", [Date.now() + 60000]);
      f.failures.get(reference.sessionId)!(); await f.drained.get(reference.sessionId); await Promise.resolve();
      await f.service.tick();
      expect(f.db.query("SELECT state FROM conversation_turns").get()).toEqual({ state: "running" });
      expect(f.sent).toEqual([]); expect(f.submitted).toHaveLength(1);
      expect(f.reactions).toEqual(["om_source:add:GoGoGo"]);
    } finally { await f.close(); }
  }
});
