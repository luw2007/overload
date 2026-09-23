import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-host-context-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");
const realCmuxSurface = process.env.CMUX_SURFACE_ID;
let probe: "no-host" | "fail" | "slow" = "no-host";
let probeTimeouts: number[] = [];

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));
mock.module("node:child_process", () => ({
  execFile: (_file: string, _args: string[], _options: unknown, callback: (error: null, stdout: string) => void) => callback(null, ""),
  execFileSync: (file: string, args: string[], options: { timeout: number }) => {
    if (file === "/usr/bin/tty") return Buffer.from("not a tty\n");
    probeTimeouts.push(options.timeout);
    if (probe === "fail") throw Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT" });
    if (probe === "slow") {
      const until = performance.now() + options.timeout;
      while (performance.now() < until) {}
      throw Object.assign(new Error("ps timed out"), { code: "ETIMEDOUT" });
    }
    return Buffer.from(args.includes("ppid=") ? "1\n" : "PID TTY STAT TIME COMMAND\n");
  },
}));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();

function dispatch(name: string, event: unknown, ctx: unknown = {}): unknown[] {
  return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
}

async function start(session: string): Promise<{ elapsed: number; detail: Record<string, unknown> }> {
  const begun = performance.now();
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => session },
  }));
  const elapsed = performance.now() - begun;
  await Bun.sleep(80);
  const spool = join(home, ".overload", "spool", "local");
  const envelopes = readdirSync(spool)
    .flatMap((emitter) => readdirSync(join(spool, emitter)).map((name) => join(spool, emitter, name)))
    .flatMap((path) => readFileSync(path, "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const event = envelopes.findLast((item) => item.kind === "session_started" && item.session === session);
  expect(event).toBeDefined();
  return { elapsed, detail: event.detail };
}

beforeAll(async () => {
  delete process.env.CMUX_SURFACE_ID;
  const { default: overload } = await import("../../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as never);
});

afterAll(() => {
  if (realCmuxSurface === undefined) delete process.env.CMUX_SURFACE_ID;
  else process.env.CMUX_SURFACE_ID = realCmuxSurface;
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

describe("extension cmux host probe", () => {
  test("records probe failure but not a genuine no-host result", async () => {
    probe = "no-host";
    const noHost = await start("11111111-1111-4111-8111-111111111111");
    expect(noHost.detail.host).toBeUndefined();
    expect(noHost.detail.host_probe_error).toBeUndefined();

    probe = "fail";
    const failed = await start("22222222-2222-4222-8222-222222222222");
    expect(failed.detail.host).toBeUndefined();
    expect(failed.detail.host_probe_error).toBe("ps_timeout");
  });

  test("uses a realistic per-call timeout and bounds the full process walk", async () => {
    probe = "slow";
    probeTimeouts = [];
    const result = await start("33333333-3333-4333-8333-333333333333");
    expect(probeTimeouts[0]).toBe(250);
    expect(result.elapsed).toBeLessThan(1_200);
    expect(result.detail.host_probe_error).toBe("ps_timeout");
  });
});
