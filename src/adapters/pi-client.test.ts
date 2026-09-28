// Local-only socket-protocol tests for PiBrokerClient handshake (ADP-16),
// stopPiBroker shutdown (ADP-17), and PiSessionHandle guards (ADP-19).
// We stand up a hand-rolled net.createServer that mimics the broker JSONL
// wire protocol — no real pi binary required.
import { expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectPiBroker,
  stopPiBroker,
  PiBrokerClient,
} from "./pi-broker";
import { PiSessionHandle } from "./pi";
import type { PiBrokerConfig } from "./pi-broker";

const TOKEN = "owner-token-1";

type FakeServerOpts = {
  acceptHello?: (token: string) => boolean;
  rejectCommand?: boolean;
};

function startFakeBroker(socketPath: string, opts: FakeServerOpts = {}): {
  server: Server;
  receivedCommands: string[];
  closed: () => boolean;
} {
  const receivedCommands: string[] = [];
  let closed = false;
  const server = createServer((socket: Socket) => {
    socket.on("data", (chunk) => {
      const lines = chunk.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (record.op === "hello") {
          if (!opts.acceptHello || !opts.acceptHello(record.token)) {
            socket.write(`${JSON.stringify({ type: "error", reason: "runtime_ownership_rejected" })}\n`);
            socket.destroy();
            continue;
          }
          socket.write(
            `${JSON.stringify({
              type: "hello",
              ok: true,
              reference: {
                runtimeKind: "pi",
                sessionId: "sess-1",
                ownerId: "owner",
                cwd: "/repo",
                sessionFile: "/repo/.pi/sess-1.json",
              },
              seq: 0,
            })}\n`,
          );
          continue;
        }
        if (record.op === "command") {
          receivedCommands.push(JSON.stringify(record.payload));
          if (opts.rejectCommand || record.token !== TOKEN) {
            socket.write(
              `${JSON.stringify({ type: "command_response", commandId: record.commandId, state: "rejected", reason: "runtime_ownership_rejected" })}\n`,
            );
            continue;
          }
          const type = record.payload?.type;
          if (type === "shutdown") {
            socket.write(
              `${JSON.stringify({ type: "command_response", commandId: record.commandId, state: "accepted" })}\n`,
            );
            closed = true;
            continue;
          }
          socket.write(
            `${JSON.stringify({ type: "command_response", commandId: record.commandId, state: "accepted" })}\n`,
          );
        }
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(socketPath, () => {
      resolve({ server, receivedCommands, closed: () => closed });
    });
  }) as any;
}

test("ADP-16 connectPiBroker resolves a reference on a valid hello", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-client-"));
  const socketPath = join(root, "b.sock");
  const fake = await startFakeBroker(socketPath, { acceptHello: (t) => t === TOKEN });
  try {
    const client = await connectPiBroker(socketPath, TOKEN, 0, 2000);
    expect(client.reference).toMatchObject({
      runtimeKind: "pi",
      sessionId: "sess-1",
      ownerId: "owner",
      cwd: "/repo",
    });
    client.close();
  } finally {
    fake.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ADP-16 connectPiBroker rejects an ownership-rejected hello", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-client-"));
  const socketPath = join(root, "b.sock");
  const fake = await startFakeBroker(socketPath, { acceptHello: (t) => t === TOKEN });
  try {
    await expect(connectPiBroker(socketPath, "wrong-token", 0, 500)).rejects.toThrow();
  } finally {
    fake.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("ADP-17 stopPiBroker sends a shutdown command and closes the client", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-broker-stop-"));
  const socketPath = join(root, "b.sock");
  const fake = await startFakeBroker(socketPath, { acceptHello: (t) => t === TOKEN });
  try {
    const receipt = await stopPiBroker(socketPath, TOKEN, 2000);
    expect(receipt.state).toBe("accepted");
    expect(fake.receivedCommands.some((c) => c.includes("shutdown"))).toBe(true);
  } finally {
    fake.server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ADP-19: PiSessionHandle guards. We bypass the socket entirely and feed a
// duck-typed fake client that records commands and scripted receipts.
function fakeClient(script: Array<{ state: "accepted" | "rejected" | "unknown"; reason?: string }>) {
  const calls: Array<{ payload: any; turnId?: string }> = [];
  let i = 0;
  return {
    calls,
    async *events(): AsyncIterable<any> {
      return;
    },
    async command(payload: any, turnId?: string): Promise<any> {
      calls.push({ payload, turnId });
      const next = script[Math.min(i++, script.length - 1)];
      return { state: next.state, commandId: "cmd-1", ...(next.reason ? { reason: next.reason } : {}) };
    },
    close() {},
  } as unknown as PiBrokerClient;
}

test("ADP-19 PiSessionHandle rejects submit after close and serializes turns", async () => {
  const reference = { runtimeKind: "pi", sessionId: "s", ownerId: "o", cwd: "/c" };
  const handle = new PiSessionHandle(reference, fakeClient([{ state: "accepted" }]) as any, 1000);
  const first = await handle.submit({ turnId: "t1", text: "go" });
  expect(first.state).toBe("accepted");
  // A second submit while a turn is in flight must be rejected without sending.
  const second = await handle.submit({ turnId: "t2", text: "go" });
  expect(second.reason).toBe("turn_in_flight");
  await handle.close();
  const afterClose = await handle.submit({ turnId: "t3", text: "go" });
  expect(afterClose.reason).toBe("runtime_closed");
});

test("ADP-19 PiSessionHandle confirms only yes/no and validates select options", async () => {
  const reference = { runtimeKind: "pi", sessionId: "s", ownerId: "o", cwd: "/c" };
  const client = fakeClient([{ state: "accepted" }]);
  const handle = new PiSessionHandle(reference, client as any, 1000);
  // Seed a pending confirm UI request so answer() knows the method.
  (handle as any).uiMethods.set("req-1", { method: "confirm" });
  (handle as any).uiMethods.set("req-2", { method: "select", options: ["ok", "no"] });

  expect((await handle.answer("req-1", "maybe")).reason).toBe("invalid_confirm_answer");
  expect((await handle.answer("req-1", "yes")).state).toBe("accepted");
  expect((await handle.answer("req-2", "banana")).reason).toBe("invalid_select_answer");
  expect((await handle.answer("req-2", "ok")).state).toBe("accepted");
  expect((await handle.answer("missing", "x")).reason).toBe("unknown_ui_request");
  await handle.close();
});

test("ADP-19 PiSessionHandle treats an unknown submit receipt as prior_turn_unknown", async () => {
  const reference = { runtimeKind: "pi", sessionId: "s", ownerId: "o", cwd: "/c" };
  const handle = new PiSessionHandle(reference, fakeClient([{ state: "unknown", reason: "pi_rejected" }]) as any, 1000);
  const first = await handle.submit({ turnId: "t1", text: "go" });
  expect(first.state).toBe("unknown");
  // Prior turn ended unknown -> a follow-up submit must be rejected locally.
  const follow = await handle.submit({ turnId: "t2", text: "again" });
  expect(follow.reason).toBe("prior_turn_unknown");
  await handle.close();
});
