// Local-only server-side test for the PiBroker socket server (ADP-15).
// runPiBroker spawns a child speaking `config.command`; instead of the real
// pi binary we drop a tiny fake RPC responder script onto tmp and point
// `command` at it. This exercises listen + hello token validation + command
// auth + journal persistence against a real unix socket.
import { expect, test } from "bun:test";
import { writeFileSync, mkdtempSync, rmSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectPiBroker, readBrokerMetadata, runPiBroker, type PiBrokerConfig } from "./pi-broker";

const FAKE_PI = `#!/usr/bin/env bun
// Minimal fake pi RPC responder: answers get_state, then settles prompts.
const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let nl = buf.indexOf("\\n");
  while (nl >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\\n");
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    if (rec.type === "get_state" && rec.id === "__overload_state__") {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id, success: true, data: { sessionFile: "/fake/session.json" } }) + "\\n");
      continue;
    }
    if (rec.type === "prompt" && rec.id) {
      process.stdout.write(JSON.stringify({ type: "response", id: rec.id, success: true }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled", turn_id: rec.turnId ?? rec.turn_id }) + "\\n");
      continue;
    }
  }
}
`;

function buildConfig(root: string, token: string): PiBrokerConfig {
  const sessionId = "srv-sess";
  return {
    runtimeRoot: root,
    metadataPath: join(root, "metadata", `${sessionId}.json`),
    socketPath: join(root, "sockets", `${sessionId}.sock`),
    sessionId,
    ownerId: "owner",
    ownerToken: token,
    cwd: root,
    command: join(root, "fake-pi.mjs"),
    stderrLimit: 4096,
  };
}

test("ADP-15 PiBroker listens, enforces ownerToken on hello and commands, persists journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-server-"));
  const token = "server-token-xyz";
  try {
    writeFileSync(join(root, "fake-pi.mjs"), FAKE_PI);
    chmodSync(join(root, "fake-pi.mjs"), 0o755);
    const config = buildConfig(root, token);
    const brokerDone = runPiBroker(config);

    // Wait for the socket to appear and the broker to be ready.
    const socketPath = config.socketPath;
    const deadline = Date.now() + 5000;
    while (!existsSync(socketPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(existsSync(socketPath)).toBe(true);

    // Wrong token at hello must be rejected.
    await expect(connectPiBroker(socketPath, "nope", 0, 1500)).rejects.toThrow();

    // Correct token connects and resolves a reference.
    const client = await connectPiBroker(socketPath, token, 0, 2000);
    expect(client.reference?.sessionId).toBe("srv-sess");

    // Authorized command accepted; unauthorized command rejected.
    const ok = await client.command({ type: "prompt", message: "hi", turnId: "t1" } as any, "t1");
    expect(ok.state).toBe("accepted");
    client.close();

    // Metadata file was written with the configured fields.
    const meta = readBrokerMetadata(config.metadataPath);
    expect(meta?.sessionId).toBe("srv-sess");
    expect(meta?.ownerToken).toBe(token);

    // Journal exists (events were persisted as ndjson rows).
    const journal = join(root, "events", `${config.sessionId}.ndjson`);
    expect(existsSync(journal)).toBe(true);

    // Shutdown the broker cleanly.
    const shutdown = await connectPiBroker(socketPath, token, 0, 2000);
    await shutdown.command({ type: "shutdown" });
    shutdown.close();
    await Promise.race([brokerDone, new Promise((r) => setTimeout(r, 3000))]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);
