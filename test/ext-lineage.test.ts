import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import overload from "../src/extension/overload";

// EXT-19 behavioral test: the extension mutates bash tool_call commands that
// spawn agent CLIs, injecting this session's stable id as OVERLOAD_PARENT.
// HOME is redirected before the extension boots so the spool never touches
// the real ~/.overload (established host-sim convention).

const home = mkdtempSync(join(tmpdir(), "overload-ext-lineage-"));
process.env.HOME = home;

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

afterAll(async () => {
  try { await Promise.all(dispatch("session_shutdown", { reason: "test_end" })); } catch { /* fail-open */ }
  rmSync(home, { recursive: true, force: true });
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
