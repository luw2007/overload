/**
 * test/ext-overflow-drop.test.ts — EXT-15 overflow drop, on a FRESH SpoolWriter
 * (fresh droppedTotal = 0; each bun test file gets its own module graph).
 *
 * When the in-memory write queue reaches WRITE_QUEUE_LIMIT (1000), further
 * enqueue() calls increment droppedTotal and return WITHOUT pushing an envelope.
 * A tight synchronous burst of 2000 pushes: the drain cannot run until the
 * loop's microtask queue drains, so the queue backs up to 1000 and the other
 * 1000 are dropped. We assert exactly 1000 lines reach disk, all stamped with
 * dropped_total === 1000, and that no seq beyond overflowStart + 1000 survives.
 *
 * tmp HOME isolation via node:os mock; never ~/.overload.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-overflow-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");
const SESSION = "9f1e7a30-0000-4000-8000-000000000003";
const WRITE_QUEUE_LIMIT = 1000;
const BURST = WRITE_QUEUE_LIMIT * 2;

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
function dispatch(name: string, event: unknown, ctx: unknown = {}): unknown[] {
  return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
}

function emitterDir(): string {
  const base = join(home, ".overload", "spool", "local");
  const emitter = readdirSync(base, { withFileTypes: true }).find((d) => d.isDirectory())!;
  return join(base, emitter.name);
}
function readAll(): Array<{ kind: string; session: string; seq: number; dropped_total: number }> {
  const out: Array<{ kind: string; session: string; seq: number; dropped_total: number }> = [];
  for (const file of readdirSync(emitterDir())) {
    for (const line of readFileSync(join(emitterDir(), file), "utf8").split("\n")) {
      if (line.trim()) out.push(JSON.parse(line));
    }
  }
  return out;
}

function push(id: string): void {
  dispatch("tool_call", { toolName: "bash", toolCallId: id, input: { command: "git push origin main" } });
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

test("EXT-15: queue at WRITE_QUEUE_LIMIT drops overflow entries and increments dropped_total", async () => {
  await Bun.sleep(300); // flush the single session_started line
  const overflowStart = Math.max(...readAll().map((e) => e.seq), 0);

  // Tight synchronous burst: drain's first await yields to the microtask queue,
  // which only drains after this loop returns, so the queue backs up to the
  // limit and every call beyond it is dropped (dropped_total++).
  for (let i = 0; i < BURST; i++) push(`overflow-${i}`);

  // Poll until the surviving queue has flushed to disk (robust under parallel load).
  let burstLines: Array<{ kind: string; session: string; seq: number; dropped_total: number }> = [];
  for (let i = 0; i < 80; i++) {
    await Bun.sleep(100);
    burstLines = readAll().filter((e) => e.session === SESSION && e.seq > overflowStart);
    if (burstLines.length === WRITE_QUEUE_LIMIT) break;
  }

  // Exactly WRITE_QUEUE_LIMIT entries survived; the other WRITE_QUEUE_LIMIT
  // were dropped and never written to disk.
  expect(burstLines.length).toBe(WRITE_QUEUE_LIMIT);
  // Every surviving burst line is stamped with the final dropped counter.
  expect(burstLines.every((e) => e.dropped_total === WRITE_QUEUE_LIMIT)).toBe(true);
  // seq kept incrementing on dropped calls too, so the highest surviving seq is
  // overflowStart + the limit (the dropped seqs overflowStart+limit+1..+2*limit
  // produced no line).
  expect(Math.max(...burstLines.map((e) => e.seq))).toBe(overflowStart + WRITE_QUEUE_LIMIT);
});
