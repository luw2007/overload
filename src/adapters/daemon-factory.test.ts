import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdapterDaemon } from "./daemon";
import type { AgentRuntime, ChannelAdapter, ChannelAddress, ChannelEvent, ChannelIdentity, DeliveryReceipt, SessionHandle, SessionReference, StartRequest, TurnRequest, RuntimeEvent } from "./types";

const roots: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function saveEnv(keys: string[]) {
  for (const k of keys) savedEnv[k] = process.env[k];
}

/** A no-op channel that records start/stop calls. */
class FakeChannel implements ChannelAdapter {
  readonly kind = "fake";
  readonly instanceId = "fake-instance";
  readonly capabilities = { update: false, actions: false };
  started = 0;
  stopped = 0;
  async start(_accept: (event: ChannelEvent) => Promise<void>): Promise<void> { this.started++; }
  async stop(): Promise<void> { this.stopped++; }
  async send(_message: import("./types").ChannelMessage): Promise<DeliveryReceipt> {
    return { state: "sent", messageId: "msg-1" };
  }
}

/** A minimal runtime that never connects. */
class FakeRuntime implements AgentRuntime {
  readonly kind = "fake";
  readonly capabilities = { restore: false, answer: false, steer: false };
  async start(_request: StartRequest): Promise<SessionHandle> { throw new Error("not used"); }
  async connect(_ref: SessionReference): Promise<SessionHandle> { throw new Error("not used"); }
}

const FAKE_CHANNEL_KEYS = ["OVERLOAD_CHANNEL", "OVERLOAD_RUNTIME", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_INSTANCE_ID", "OVERLOAD_CHANNEL_AUTH_FILE", "OVERLOAD_RUNTIME_CWD", "OVERLOAD_ANSWERS_PATH"];

function setupEnv(): { root: string; channel: FakeChannel } {
  saveEnv(FAKE_CHANNEL_KEYS);
  const root = mkdtempSync(join(tmpdir(), "overload-daemon-factory-"));
  roots.push(root);

  // Auth file with one valid entry.
  const authFile = join(root, "auth.json");
  writeFileSync(authFile, JSON.stringify([{
    instanceId: "fake-instance", tenantId: "t1", userId: "u1", ownerId: "owner-1",
    appId: "app-id", chatId: "chat-1", role: "owner",
  }]));

  process.env.OVERLOAD_CHANNEL_AUTH_FILE = authFile;
  process.env.FEISHU_APP_ID = "app-id";
  process.env.FEISHU_APP_SECRET = "app-secret";
  process.env.FEISHU_INSTANCE_ID = "fake-instance";
  process.env.OVERLOAD_RUNTIME_CWD = root;
  process.env.OVERLOAD_ANSWERS_PATH = join(root, "answers.db");
  process.env.OVERLOAD_CHANNEL = "fake";
  process.env.OVERLOAD_RUNTIME = "fake";

  const channel = new FakeChannel();
  return { root, channel };
}

function fakeFactories(channel: FakeChannel) {
  return {
    channelFactories: { fake: () => channel },
    runtimeFactories: { fake: () => new FakeRuntime() },
  };
}

describe("ADP-01 startAdapterDaemon factory injection", () => {
  test("injects fake channel + runtime, starts service, returns stop()", async () => {
    const { channel } = setupEnv();
    const daemon = await startAdapterDaemon(fakeFactories(channel));
    expect(channel.started).toBe(1);
    expect(typeof daemon.stop).toBe("function");
    // The daemon registers a 1s setInterval; after stop() the timer is cleared.
    await daemon.stop();
    expect(channel.stopped).toBe(1);
  });

  test("missing FEISHU_APP_ID throws before connecting to network", async () => {
    setupEnv();
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_FILE;
    await expect(startAdapterDaemon(fakeFactories(new FakeChannel()))).rejects.toThrow(/FEISHU_APP_ID is required/);
  });

  test("missing OVERLOAD_CHANNEL_AUTH_FILE throws", async () => {
    setupEnv();
    delete process.env.OVERLOAD_CHANNEL_AUTH_FILE;
    await expect(startAdapterDaemon(fakeFactories(new FakeChannel()))).rejects.toThrow(/OVERLOAD_CHANNEL_AUTH_FILE is required/);
  });

  test("unsupported channel name throws", async () => {
    setupEnv();
    process.env.OVERLOAD_CHANNEL = "nonexistent-channel";
    await expect(startAdapterDaemon({ channelFactories: {}, runtimeFactories: { fake: () => new FakeRuntime() } }))
      .rejects.toThrow(/Unsupported channel/);
  });

  test("service.start failure triggers service.stop() and rethrows", async () => {
    setupEnv();
    const failingChannel = new FakeChannel();
    failingChannel.start = async () => { throw new Error("connect failed"); };
    let stopped = false;
    const origStop = failingChannel.stop.bind(failingChannel);
    failingChannel.stop = async () => { stopped = true; await origStop(); };
    await expect(startAdapterDaemon(fakeFactories(failingChannel))).rejects.toThrow("connect failed");
    expect(stopped).toBe(true);
  });
});
