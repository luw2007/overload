/**
 * test/ext-behavior-extra.test.ts — real-run behavioral tests for:
 *   EXT-04 working transition dedup (before_agent_start/agent_start/turn_start
 *         in one run emit exactly one `working` event).
 *   EXT-09 tool_activity 5s throttle (non-change-capable calls inside a 5s
 *         window collapse to one; the next call after the window emits again).
 *   EXT-10 heartbeat 60s timer (setWorking starts the interval; every 60s of
 *         working time emits a heartbeat; after settle, further 60s advances
 *         emit nothing).
 *
 * Bun's fake timers fake Date.now(), so the synchronous throttle / interval
 * decisions are driven deterministically. The spool writes themselves are real
 * fs; they only flush to disk once we return to real timers, so all dispatch /
 * advance work happens under fake timers and a single final flush reads them.
 * All paths are isolated to a tmp HOME via a node:os mock (never ~/.overload).
 */
import { afterAll, beforeAll, expect, jest, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-behavior-extra-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");
const SESSION = "9f1e7a30-0000-4000-8000-000000000001";

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
function dispatch(name: string, event: unknown, ctx: unknown = {}): unknown[] {
  return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
}

function readAll(): Array<{ kind: string; session: string; dropped_total: number }> {
  const base = join(home, ".overload", "spool");
  const out: Array<{ kind: string; session: string; dropped_total: number }> = [];
  if (!existsSync(base)) return out;
  for (const hostDir of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const emDir of readdirSync(join(base, hostDir.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const emPath = join(base, hostDir.name, emDir.name);
      for (const file of readdirSync(emPath)) {
        for (const line of readFileSync(join(emPath, file), "utf8").split("\n")) {
          if (line.trim()) out.push(JSON.parse(line));
        }
      }
    }
  }
  return out;
}

beforeAll(async () => {
  const { default: overload } = await import("../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as never);
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => SESSION },
  }));
});

afterAll(() => {
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

test("EXT-04: one working run from before_agent_start/agent_start/turn_start", () => {
  jest.useFakeTimers();
  // Run #1: three lifecycle events in one run. Only the false->true transition
  // may emit `working`; the next two must be deduplicated by setWorking().
  dispatch("before_agent_start", {});
  dispatch("agent_start", {});
  dispatch("turn_start", {});
  jest.advanceTimersByTime(1);
  // Settle so run #2 (EXT-10) starts from working=false again.
  dispatch("agent_settled", {});
});

test("EXT-09: tool_activity collapses non-change-capable calls inside 5s", () => {
  // lastToolActivity starts at 0; fake Date.now() is epoch-scaled, so the
  // first call always passes the >=5s gate.
  dispatch("tool_call", { toolName: "read", toolCallId: "ta-1", input: { path: "a" } });
  dispatch("tool_call", { toolName: "read", toolCallId: "ta-2", input: { path: "a" } }); // throttled
  dispatch("tool_call", { toolName: "read", toolCallId: "ta-3", input: { path: "a" } }); // throttled
  jest.advanceTimersByTime(5_000);
  dispatch("tool_call", { toolName: "read", toolCallId: "ta-4", input: { path: "a" } }); // window elapsed
  jest.advanceTimersByTime(1);
});

test("EXT-10: heartbeat fires every 60s while working, stops after settle", () => {
  // Run #2: a single before_agent_start re-enters working (one more `working`).
  dispatch("before_agent_start", {});
  jest.advanceTimersByTime(60_000); // heartbeat #1
  jest.advanceTimersByTime(60_000); // heartbeat #2
  dispatch("agent_settled", {});    // working -> false
  jest.advanceTimersByTime(60_000); // interval still ticks, but emits nothing
});

test("flush and assert", async () => {
  jest.useRealTimers();
  // Let the real fs drain (open/write/close per line) land to disk.
  await Bun.sleep(500);
  const all = readAll().filter((e) => e.session === SESSION);

  // EXT-04: run #1 (3 lifecycle events) emitted exactly 1 `working`; run #2
  // (EXT-10, single before_agent_start) emitted exactly 1. Total 2 proves the
  // three-event run was deduplicated (otherwise it would be 3 + 1 = 4).
  const working = all.filter((e) => e.kind === "working");
  expect(working.length).toBe(2);

  // EXT-09: 4 read calls, only 2 reached the spool (first + after 5s window).
  const toolActivity = all.filter((e) => e.kind === "tool_activity");
  expect(toolActivity.length).toBe(2);

  // EXT-10: exactly two heartbeats, both before settle.
  const heartbeats = all.filter((e) => e.kind === "heartbeat");
  expect(heartbeats.length).toBe(2);
});
