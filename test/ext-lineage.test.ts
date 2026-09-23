import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

// EXT-19/EXT-20 behavioral tests against the real extension. Bun's os.homedir()
// ignores process.env.HOME (verified: returns the passwd entry), so isolation
// MUST mock node:os — a plain HOME redirect silently pollutes the real
// ~/.overload spool and, via the 2s ingest daemon, the real ledger.

const home = mkdtempSync(join(tmpdir(), "overload-ext-lineage-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();

function dispatch(name: string, event: unknown, ctx: unknown = {}): unknown[] {
  return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
}

function mutate(command: string): string {
  const input = { command };
  dispatch("tool_call", { toolName: "bash", input });
  return input.command;
}

beforeAll(async () => {
  process.env.CMUX_SURFACE_ID = "test-cmux-surface";
  process.env.TERM_PROGRAM = "ghostty";
  process.env.TERM_SESSION_ID = "test-terminal-session";
  process.env.OVERLOAD_PARENT = "outer-parent";
  // Dynamic import required: the node:os mock above must be registered before
  // the extension module evaluates; a static import would hoist past it.
  const { default: overload } = await import("../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as never);
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => "11111111-2222-3333-4444-555555555555" },
  }));
});

afterAll(() => {
  // Sentinel: this test process must never have written to the real spool.
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

describe("EXT-20 env parent export", () => {
  test("session_start exports this session's stable id for descendants", () => {
    expect(process.env.OVERLOAD_PARENT).toMatch(/^local:(pi|omp|prime):11111111-2222-3333-4444-555555555555$/);
  });
});

describe("EXT-19 spawn lineage injection", () => {
  test("agent CLI spawns gain OVERLOAD_PARENT with this session's stable id", () => {
    const result = mutate("pi -p hello");
    expect(result).toMatch(/^OVERLOAD_PARENT=local:(pi|omp|prime):11111111-2222-3333-4444-555555555555 pi -p hello$/);
    expect(mutate("omp run task")).toStartWith("OVERLOAD_PARENT=local:");
  });

  test("compound commands with metachars are never rewritten", () => {
    expect(mutate("pi -p hi | tee log")).toBe("pi -p hi | tee log");
    expect(mutate("pi -p $(cat x)")).toBe("pi -p $(cat x)");
  });

  test("commands already carrying OVERLOAD_PARENT are untouched", () => {
    expect(mutate("OVERLOAD_PARENT=custom pi -p hi")).toBe("OVERLOAD_PARENT=custom pi -p hi");
    expect(mutate("pi run --env OVERLOAD_PARENT=x")).toBe("pi run --env OVERLOAD_PARENT=x");
  });

  test("non-agent commands are untouched", () => {
    expect(mutate("ls -la")).toBe("ls -la");
    expect(mutate("pipx install foo")).toBe("pipx install foo");
  });

  test("git commit trailer injection (EXT-11) still works after the refactor", () => {
    const result = mutate('git commit -m "msg"');
    expect(result).toMatch(/^git commit -m "msg" --trailer "Overload-Session: local:(pi|omp|prime):11111111-2222-3333-4444-555555555555#/);
  });
});

// Last describe: sealing ends the session, so mutation tests run before it.
describe("EXT-20 spool record", () => {
  test("the session's OWN parent (pre-start env value) reached the spool", async () => {
    // session_shutdown drains the write queue and seals the segment (EXT-13),
    // making the read deterministic without timers.
    await Promise.all(dispatch("session_shutdown", { reason: "test_end" }));
    const hostDir = join(home, ".overload", "spool", "local");
    const spoolFiles = readdirSync(hostDir, { recursive: true }) as string[];
    const sealed = spoolFiles.find((name) => name.includes("seg-"));
    expect(sealed).toBeDefined();
    const first = readFileSync(join(hostDir, sealed!), "utf8").split("\n")[0]!;
    const envelope = JSON.parse(first) as { kind: string; detail?: { parent?: string; host?: { app?: string; session_id?: string } } };
    expect(envelope.kind).toBe("session_started");
    expect(envelope.detail?.parent).toBe("outer-parent");
    expect(envelope.detail?.host).toEqual({ app: "cmux", session_id: "test-cmux-surface" });
  });
});
