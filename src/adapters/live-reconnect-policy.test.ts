import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailbox } from "../decision-bot/mailbox";
import { AdapterService } from "./service";
import { PiRuntime } from "./pi";
import { readBrokerMetadata, runPiBroker } from "./pi-broker";
import type { ChannelAdapter, ChannelEvent, RuntimePolicy, SessionReference } from "./types";

// Actual Unix broker and RPC child; the child records every prompt before replying.
const RPC_CHILD = `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
 buffer += decoder.decode(chunk, { stream: true });
 let newline;
 while ((newline = buffer.indexOf("\\n")) >= 0) {
  const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
  if (!line.trim()) continue;
  const command = JSON.parse(line);
  if (command.type === "get_state") {
   process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: { sessionFile: process.cwd() + "/session.json" } }) + "\\n");
  } else if (command.type === "prompt") {
   appendFileSync("prompts.ndjson", JSON.stringify(command) + "\\n");
   process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true }) + "\\n");
   process.stdout.write(JSON.stringify({ type: "agent_settled", turn_id: command.turnId ?? command.turn_id }) + "\\n");
  }
 }
}
`;

async function fixture(strict: boolean) {
 const root = realpathSync(mkdtempSync(join(tmpdir(), "live-policy-")));
 const runtimeRoot = join(root, "runtime");
 const configPath = join(root, "gate.json");
 const approvalRoot = join(root, "repo");
 mkdirSync(approvalRoot);
 const gate = { enabled: true, require_approval_write_paths: [approvalRoot], allowed_write_roots: [approvalRoot], block_bash_patterns: [".*"] };
 writeFileSync(configPath, JSON.stringify({ approval_gate: gate }));
 const command = join(root, "fake-pi.mjs");
 writeFileSync(command, RPC_CHILD); chmodSync(command, 0o755);
 const db = openMailbox(join(root, "control.db"));
 let brokerDone: Promise<void> | undefined;
 const runtime = new PiRuntime({ runtimeRoot, command, commandTimeoutMs: 2000, spawnBroker: async config => { brokerDone = runPiBroker(config); } });
 let policy: RuntimePolicy | undefined = strict ? { configPath, approvalRoot, requiredApprovalGate: true } : undefined;
 const sent: string[] = [];
 const channel: ChannelAdapter = {
  kind: "test", instanceId: "private-channel", capabilities: { update: true, actions: true },
  async start() {}, async stop() {},
  async send(message) { sent.push(message.text); return { state: "sent", messageId: message.deliveryId }; },
 };
 const createService = () => new AdapterService(db, { runtime, channels: [channel], cwd: root, authorize: () => "owner", runtimeConfig: () => policy as { configPath: string; requiredApprovalGate?: boolean; approvalRoot?: string } | undefined });
 let service = createService();
 const event = (id: string): ChannelEvent => ({ kind: "message", eventId: id, messageId: id, text: id, receivedAt: Date.now(), identity: { instanceId: channel.instanceId, tenantId: "private", userId: "owner" }, address: { instanceId: channel.instanceId, tenantId: "private", chatId: "private" } });
 let reference: SessionReference | undefined;
 const count = () => existsSync(join(root, "prompts.ndjson")) ? readFileSync(join(root, "prompts.ndjson"), "utf8").trim().split("\n").length : 0;
 const close = async () => {
  try {
   await service.stop();
   if (reference) expect((await runtime.shutdown(reference)).state).toBe("accepted");
   if (brokerDone) await brokerDone;
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
 };
 try {
  await service.accept(event("initial"));
  const conversation = db.query("SELECT id FROM conversations").get() as { id: string };
  await service.pump(conversation.id);
  const stored = db.query("SELECT session_reference FROM conversations").get();
  if (!stored || typeof stored !== "object" || !("session_reference" in stored) || typeof stored.session_reference !== "string") throw new Error("Missing stored session reference");
  reference = JSON.parse(stored.session_reference);
  expect(count()).toBe(1);
  // The real socket/RPC event loop cannot use fake timers; wait for observed settlement.
  const deadline = Date.now() + 2000;
  let initial = db.query("SELECT state FROM conversation_turns WHERE sequence=1").get() as { state: string };
  while (initial.state !== "completed" && Date.now() < deadline) {
   await Bun.sleep(10);
   initial = db.query("SELECT state FROM conversation_turns WHERE sequence=1").get() as { state: string };
  }
  expect(initial.state).toBe("completed");
  return {
   root, configPath, approvalRoot, gate, db, sent, runtimeRoot, reference: reference!, count, close,
   setPolicy(value: RuntimePolicy | undefined) { policy = value; },
   async queue(cached = false) {
    if (!cached) { await service.stop(); service = createService(); }
    await service.accept(event("next"));
    await service.pump(conversation.id);
    await service.tick();
   },
  };
 } catch (error) { await close(); throw error; }
}

for (const strict of [false, true]) {
 test(`live reconnect continues with matching ${strict ? "strict" : "ordinary"} policy`, async () => {
  const h = await fixture(strict);
  try {
   await h.queue();
   expect(h.count()).toBe(2);
   const turn = h.db.query("SELECT state FROM conversation_turns WHERE sequence=2").get() as { state: string };
   expect(["running", "completed"]).toContain(turn.state);
  } finally { await h.close(); }
 }, 15000);
}

const cases = ["ordinary-to-required", "config-rotation", "root-rotation", "missing-policy", "weakened-config", "missing-metadata-flag", "cached-policy-transition"] as const;
for (const scenario of cases) {
 test(`live reconnect fails closed before prompt: ${scenario}`, async () => {
  const h = await fixture(scenario !== "ordinary-to-required" && scenario !== "cached-policy-transition");
  try {
   const required = { configPath: h.configPath, approvalRoot: h.approvalRoot, requiredApprovalGate: true };
   if (scenario === "ordinary-to-required" || scenario === "cached-policy-transition") h.setPolicy(required);
   if (scenario === "config-rotation") {
    const path = join(h.root, "rotated.json"); writeFileSync(path, JSON.stringify({ approval_gate: h.gate })); h.setPolicy({ ...required, configPath: path });
   }
   if (scenario === "root-rotation") {
    const path = join(h.root, "rotated-root"); mkdirSync(path); h.setPolicy({ ...required, approvalRoot: path });
   }
   if (scenario === "missing-policy") h.setPolicy(undefined);
   if (scenario === "weakened-config") writeFileSync(h.configPath, JSON.stringify({ approval_gate: { ...h.gate, enabled: false } }));
   if (scenario === "missing-metadata-flag") {
    const path = join(h.runtimeRoot, "metadata", h.reference.sessionId + ".json");
    const metadata = readBrokerMetadata(path)!; delete metadata.requiredApprovalGate; writeFileSync(path, JSON.stringify(metadata));
   }
   await h.queue(scenario === "cached-policy-transition");
   expect(h.count()).toBe(1);
   expect(h.db.query("SELECT state FROM conversation_turns WHERE sequence=2").get()).toEqual({ state: "queued" });
   expect(h.sent.join("\n")).toContain(scenario === "weakened-config" ? "Required runtime config must enable approval_gate" : "runtime_approval_gate_mismatch");
  } finally { await h.close(); }
 }, 15000);
}
