import { expect, test } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  JsonlFramer,
  brokerMetadataPath,
  brokerSocketPath,
  readBrokerMetadata,
  runPiBroker,
  connectPiBroker,
  safeToolName,
  toolActivityEvent,
  type PiBrokerConfig,
} from "./pi-broker";

test("JsonlFramer splits newline-delimited records across chunks and strips CR", () => {
  const framer = new JsonlFramer();
  expect(framer.push('{"a":1}\n{"b":2}\r\n')).toEqual([
    { a: 1 },
    { b: 2 },
  ]);
  expect(framer.push(new TextEncoder().encode('{"c":3}\n{"d":4}'))).toEqual([
    { c: 3 },
  ]);
  expect(framer.finish()).toEqual([{ d: 4 }]);
});

test("JsonlFramer rejects non-object JSON records", () => {
  const framer = new JsonlFramer();
  expect(() => framer.push("123\n")).toThrow("rpc_non_object_record");
});

test("broker path helpers embed sessionId under runtimeRoot", () => {
  expect(brokerMetadataPath("/rt", "sess-1")).toBe("/rt/metadata/sess-1.json");
  expect(brokerSocketPath("/rt", "sess-1")).toBe("/rt/sockets/sess-1.sock");
});

test("readBrokerMetadata accepts a valid metadata file and rejects malformed ones", () => {
  const root = mkdtempSync(join(tmpdir(), "broker-meta-"));
  try {
    const valid = join(root, "valid.json");
    writeFileSync(
      valid,
      JSON.stringify({
        sessionId: "s",
        ownerId: "o",
        ownerToken: "t",
        socketPath: "/sock",
        pid: 1,
        state: "running",
        updatedAt: 1,
      }),
    );
    expect(readBrokerMetadata(valid)?.sessionId).toBe("s");

    writeFileSync(join(root, "bad.json"), '{"sessionId":"s"}');
    expect(readBrokerMetadata(join(root, "bad.json"))).toBeNull();
    expect(readBrokerMetadata(join(root, "missing.json"))).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Real-shaped sensitive values: a provider key, an ssh key path, and a destructive shell line.
const SECRET_KEY = "sk-ant-api03-Zk3vQ8mN1pX7rT4wY9bC2dF6gH0jL5sA-uE8iO3nM1qW4xR7tY2vB6cD9fG0hJ_AAAA";
const SECRET_PATH = "/home/luwei.will/.ssh/id_ed25519";
const SECRET_CMD = "curl -H 'Authorization: Bearer ghp_16C7e42F292c6912E7710c838347Ae178B4a' https://api.github.com/user && rm -rf /data00/home/luwei.will/ai/overload/.git";
const SECRET_RESULT = "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const toolStart = (toolName: unknown, toolCallId = "call_01HZX9") => ({
  type: "tool_execution_start", toolCallId, toolName,
  args: { command: SECRET_CMD, path: SECRET_PATH, env: { ANTHROPIC_API_KEY: SECRET_KEY } },
});
const toolEnd = (toolName: unknown, toolCallId = "call_01HZX9") => ({
  type: "tool_execution_end", toolCallId, toolName, isError: true,
  result: { content: [{ type: "text", text: `${SECRET_RESULT}\ncat: ${SECRET_PATH}: Permission denied` }] },
});

test("toolActivityEvent maps tool start and end to facts with only ids, kind and generic name", () => {
  const started = toolActivityEvent(toolStart("bash"), "sess", "turn-1");
  const finished = toolActivityEvent(toolEnd("bash"), "sess", "turn-1");
  expect(started).toMatchObject({ sessionId: "sess", turnId: "turn-1", kind: "tool_started", toolName: "bash" });
  expect(finished).toMatchObject({ sessionId: "sess", turnId: "turn-1", kind: "tool_finished", toolName: "bash" });
  expect(Object.keys(started!).sort()).toEqual(["eventId", "kind", "sessionId", "toolName", "turnId"]);
  expect(Object.keys(finished!).sort()).toEqual(["eventId", "kind", "sessionId", "toolName", "turnId"]);
  expect(started!.eventId).not.toBe(finished!.eventId);
});

test("toolActivityEvent ignores non-tool RPC records", () => {
  for (const type of ["message_update", "message_end", "message_start", "turn_start", "turn_end", "agent_start", "agent_settled", "tool_execution_update", "extension_ui_request", "response", "tool_call", "tool_result"]) {
    expect(toolActivityEvent({ type, toolCallId: "c", toolName: "bash" }, "s", "t")).toBeUndefined();
  }
  expect(toolActivityEvent({ type: "tool_execution_start", toolName: "bash" }, "s", "t")).toBeUndefined(); // no toolCallId
});

test("serialized tool events carry no key, path, command or result", () => {
  const events = [toolStart("bash"), toolEnd("bash"), toolStart(SECRET_PATH, "c2"), toolEnd(SECRET_CMD, "c2")]
    .map(r => toolActivityEvent(r, "sess", "turn-1"));
  const wire = JSON.stringify(events);
  for (const leak of [SECRET_KEY, "sk-ant", SECRET_PATH, ".ssh", SECRET_CMD, "ghp_", "rm -rf", "Bearer", SECRET_RESULT, "AWS_SECRET", "Permission denied", "call_01HZX9"]) {
    expect(wire).not.toContain(leak);
  }
});

test("safeToolName keeps allowlisted names and collapses everything else to \"tool\"", () => {
  for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls", "test"]) expect(safeToolName(name)).toBe(name);
  expect(safeToolName("Bash")).toBe("bash");
  for (const raw of ["mcp__github__create_issue", "coordinator_dispatch", "", SECRET_PATH, SECRET_CMD, SECRET_KEY, "read\nbash", "bash ", "a".repeat(200), 42, null, undefined, { name: "bash" }, ["bash"]]) {
    expect(safeToolName(raw)).toBe(raw === "bash " ? "bash" : "tool");
  }
});

test("toolActivityEvent eventId is stable for a re-delivered record and distinct per call and phase", () => {
  const a = toolActivityEvent(toolStart("read", "c1"), "s", "t")!;
  expect(toolActivityEvent(toolStart("read", "c1"), "s", "t")!.eventId).toBe(a.eventId);
  expect(toolActivityEvent(toolStart("read", "c2"), "s", "t")!.eventId).not.toBe(a.eventId);
  expect(toolActivityEvent(toolEnd("read", "c1"), "s", "t")!.eventId).not.toBe(a.eventId);
});

// Drives the real broker against a fake pi that emits scripted RPC records after a prompt.
const scriptedPi = (records: unknown[]) => `#!/usr/bin/env bun
const decoder = new TextDecoder();
const script = ${JSON.stringify(records)};
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1); nl = buf.indexOf("\\n");
    if (!line.trim()) continue;
    const rec = JSON.parse(line);
    if (rec.type === "get_state") process.stdout.write(JSON.stringify({ type: "response", id: rec.id, success: true, data: { sessionFile: "/fake/session.json" } }) + "\\n");
    if (rec.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id, success: true }) + "\\n");
      for (const r of script) process.stdout.write(JSON.stringify(r) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\\n");
    }
  }
}
`;

test("broker journals tool activity 1:1 with Pi tool records, safely, and replays it; nothing else becomes a tool event", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-tools-"));
  const token = "tok-tools";
  try {
    const script = [
      { type: "turn_start" },
      toolStart("read", "c1"), toolEnd("read", "c1"),
      toolStart("bash", "c2"), { type: "tool_execution_update", toolCallId: "c2", toolName: "bash", partialResult: SECRET_RESULT },
      toolStart("bash", "c2"), // duplicate delivery
      toolEnd("bash", "c2"), toolEnd("bash", "c2"),
      toolStart("mcp__github__create_issue", "c3"), toolEnd("mcp__github__create_issue", "c3"),
      { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: SECRET_CMD } }] } },
    ];
    writeFileSync(join(root, "fake-pi.mjs"), scriptedPi(script));
    chmodSync(join(root, "fake-pi.mjs"), 0o755);
    const sessionId = "tools-sess";
    const config: PiBrokerConfig = {
      runtimeRoot: root, metadataPath: join(root, "metadata", `${sessionId}.json`), socketPath: join(root, "sockets", `${sessionId}.sock`),
      sessionId, ownerId: "owner", ownerToken: token, cwd: root, command: join(root, "fake-pi.mjs"), stderrLimit: 4096,
    };
    const brokerDone = runPiBroker(config);
    const deadline = Date.now() + 5000;
    while (!existsSync(config.socketPath) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25));
    const client = await connectPiBroker(config.socketPath, token, 0, 3000);
    expect((await client.command({ type: "prompt", message: "go" } as any, "turn-9")).state).toBe("accepted");

    const journal = join(root, "events", `${sessionId}.ndjson`);
    const readRows = () => existsSync(journal) ? readFileSync(journal, "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    const wait = Date.now() + 5000;
    while (!readRows().some(r => r.event.kind === "completed") && Date.now() < wait) await new Promise(r => setTimeout(r, 25));

    const rows = readRows();
    const tools = rows.map(r => r.event).filter(e => e.kind === "tool_started" || e.kind === "tool_finished");
    // Pi emitted 4 distinct start/end pairs' worth of facts: c1 s/e, c2 s/e (duplicates dropped), c3 s/e = 6.
    expect(tools.map(e => `${e.kind}:${e.toolName}`)).toEqual([
      "tool_started:read", "tool_finished:read", "tool_started:bash", "tool_finished:bash", "tool_started:tool", "tool_finished:tool",
    ]);
    expect(tools.every(e => e.turnId === "turn-9" && e.sessionId === sessionId)).toBe(true);
    expect(new Set(tools.map(e => e.eventId)).size).toBe(tools.length);
    const wire = readFileSync(journal, "utf8");
    for (const leak of [SECRET_KEY, SECRET_PATH, "rm -rf", "ghp_", "AWS_SECRET", "Permission denied", "mcp__github"]) expect(wire).not.toContain(leak);

    // Replay from seq 0 over a fresh connection delivers the same persisted facts.
    client.close();
    const replay = await connectPiBroker(config.socketPath, token, 0, 3000);
    const replayed: any[] = [];
    const it = replay.events()[Symbol.asyncIterator]();
    const stop = Date.now() + 3000;
    while (replayed.filter(e => e.kind === "completed").length === 0 && Date.now() < stop) {
      const next = await Promise.race([it.next(), new Promise<IteratorResult<any>>(r => setTimeout(() => r({ value: undefined, done: true }), 1000))]);
      if (next.done) break;
      replayed.push(next.value);
    }
    expect(replayed.filter(e => e.kind?.startsWith("tool_")).map(e => e.eventId)).toEqual(tools.map(e => e.eventId));
    replay.close();

    const stopper = await connectPiBroker(config.socketPath, token, 0, 2000);
    await stopper.command({ type: "shutdown" });
    stopper.close();
    await Promise.race([brokerDone, new Promise(r => setTimeout(r, 3000))]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20000);
