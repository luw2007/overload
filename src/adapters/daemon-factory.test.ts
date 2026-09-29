import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const FAKE_CHANNEL_KEYS = ["OVERLOAD_CHANNEL", "OVERLOAD_RUNTIME", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_INSTANCE_ID", "OVERLOAD_CHANNEL_AUTH_FILE", "OVERLOAD_RUNTIME_CWD", "OVERLOAD_ANSWERS_PATH", "OVERLOAD_WEB_PORT", "HOME", "OVERLOAD_LEDGER_PATH", "OVERLOAD_ORCHESTRATOR_PATH", "OVERLOAD_SPOOL_ROOT"];

/** The control-plane port must be known before the daemon starts, so it is reserved and released
 *  rather than taken from a live listener. */
function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("probe") });
  const port = probe.port;
  probe.stop(true);
  return port;
}

function setupEnv(): { root: string; channel: FakeChannel; webPort: number } {
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
  delete process.env.OVERLOAD_WEB_PORT;
  // The daemon hosts the control plane on the configured port; keep it off a live one, and off
  // the operator's real ledger/spool (homedir() may also be mocked by another test file).
  process.env.HOME = root;
  const webPort = freePort();
  mkdirSync(join(root, ".overload"), { recursive: true });
  writeFileSync(webConfigPath(root), JSON.stringify({ web_port: webPort }));
  process.env.OVERLOAD_LEDGER_PATH = join(root, "ledger.db");
  process.env.OVERLOAD_ORCHESTRATOR_PATH = join(root, "orchestrator.db");
  process.env.OVERLOAD_SPOOL_ROOT = root;
  writeFileSync(join(root, "host"), "local\n");

  const channel = new FakeChannel();
  return { root, channel, webPort };
}

function webConfigPath(root: string): string {
  return join(root, ".overload", "config.json");
}

function fakeFactories(channel: FakeChannel, root: string) {
  return {
    channelFactories: { fake: () => channel },
    runtimeFactories: { fake: () => new FakeRuntime() },
    // homedir() is fixed at process start, so HOME=root does not move the real config file.
    webConfigPath: webConfigPath(root),
  };
}

describe("ADP-01 startAdapterDaemon factory injection", () => {
  test("injects fake channel + runtime, starts service, returns stop()", async () => {
    const { channel, root } = setupEnv();
    const daemon = await startAdapterDaemon(fakeFactories(channel, root));
    expect(channel.started).toBe(1);
    expect(typeof daemon.stop).toBe("function");
    // The daemon registers a 1s setInterval; after stop() the timer is cleared.
    await daemon.stop();
    expect(channel.stopped).toBe(1);
  }, 20_000); // the daemon hosts a web server whose first ledger initialization takes seconds

  test("missing FEISHU_APP_ID throws before connecting to network", async () => {
    const { root } = setupEnv();
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.FEISHU_APP_FILE;
    await expect(startAdapterDaemon(fakeFactories(new FakeChannel(), root))).rejects.toThrow(/FEISHU_APP_ID is required/);
  });

  test("missing OVERLOAD_CHANNEL_AUTH_FILE throws", async () => {
    const { root } = setupEnv();
    delete process.env.OVERLOAD_CHANNEL_AUTH_FILE;
    await expect(startAdapterDaemon(fakeFactories(new FakeChannel(), root))).rejects.toThrow(/OVERLOAD_CHANNEL_AUTH_FILE is required/);
  });

  test("unsupported channel name throws", async () => {
    setupEnv();
    process.env.OVERLOAD_CHANNEL = "nonexistent-channel";
    await expect(startAdapterDaemon({ channelFactories: {}, runtimeFactories: { fake: () => new FakeRuntime() } }))
      .rejects.toThrow(/Unsupported channel/);
  });

  test("hosts the control plane on the configured web_port", async () => {
    const { channel, root, webPort } = setupEnv();
    const daemon = await startAdapterDaemon(fakeFactories(channel, root));
    try {
      const response = await fetch(`http://127.0.0.1:${webPort}/api/capabilities`);
      expect(response.status).toBe(200);
      expect((await response.json()).web).toMatchObject({ bind: "127.0.0.1", port: webPort });
    } finally {
      await daemon.stop();
    }
  }, 20_000);

  test("starts anyway when another process already serves the control-plane port", async () => {
    const { channel, root, webPort } = setupEnv();
    const sibling = Bun.serve({ hostname: "127.0.0.1", port: webPort, fetch: () => new Response("sibling") });
    try {
      const daemon = await startAdapterDaemon(fakeFactories(channel, root));
      expect(channel.started).toBe(1);
      // The port's existing owner keeps serving it: the daemon must not replace or fight it.
      expect(await (await fetch(`http://127.0.0.1:${webPort}/api/capabilities`)).text()).toBe("sibling");
      await daemon.stop();
      expect(channel.stopped).toBe(1);
      expect(await (await fetch(`http://127.0.0.1:${webPort}/api/capabilities`)).text()).toBe("sibling");
    } finally {
      sibling.stop(true);
    }
  }, 20_000);

  test("service.start failure triggers service.stop() and rethrows", async () => {
    const { root } = setupEnv();
    const failingChannel = new FakeChannel();
    failingChannel.start = async () => { throw new Error("connect failed"); };
    let stopped = false;
    const origStop = failingChannel.stop.bind(failingChannel);
    failingChannel.stop = async () => { stopped = true; await origStop(); };
    await expect(startAdapterDaemon(fakeFactories(failingChannel, root))).rejects.toThrow("connect failed");
    expect(stopped).toBe(true);
  }, 20_000);
});
