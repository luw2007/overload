/**
 * test/ext-seal-30s-real.test.ts — real-clock behavioral test for:
 *   EXT-14(a) segment age seal: after a real fs write lands, armSealTimer()
 *         arms a 30s timer (SEGMENT_MAX_AGE_MS=30000 in extension/overload.ts).
 *         When it fires with the queue drained, the active file is renamed to
 *         seg-<emitter>-<n>.ndjson, the segment counter advances, and the next
 *         write materializes active-<emitter>-<n+1>.ndjson (no path reuse).
 *
 * This CANNOT use fake timers: the seal timer only arms after a real fs write
 * and Bun fake timers do not pump the threadpool fs between steps. So the test
 * really sleeps ~31s. Budget: bun test timeout 60000ms for this file.
 *
 * tmp HOME isolation via mock.module("node:os"); never touches ~/.overload.
 * The 1MB inline seal path is covered by test/ext-seal-overflow.test.ts.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-seal30s-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");
const SESSION = "9f1e7a30-0000-4000-8000-000000000003";

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
function listFiles(): string[] {
  return readdirSync(emitterDir());
}
function segIndex(name: string): number {
  return Number(name.match(/-(\d+)\.ndjson$/)?.[1]);
}

// Unthrottled consequential tool call → synchronous tool_activity enqueue.
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

test("EXT-14(a): real 31s clock seals active -> seg- and opens a higher-segment active", async () => {
  // 1) Confirm the active segment exists and carries data; record its index.
  push("seed-1"); push("seed-2"); push("seed-3");
  await Bun.sleep(800);
  const before = listFiles();
  const activeBefore = before.find((f) => f.startsWith("active-"));
  expect(activeBefore).toBeDefined();
  expect(statSync(join(emitterDir(), activeBefore!)).size).toBeGreaterThan(0);
  const sealedIndex = segIndex(activeBefore!);

  // 2) Real wait past SEGMENT_MAX_AGE_MS=30000 (timer armed by the seed writes).
  await Bun.sleep(31_000);

  // 3) Materialize the new active segment: seal() renames but does not create
  //    the next active file; the first post-seal write does.
  push("post-seal-1");
  await Bun.sleep(800);

  const after = listFiles();
  const sealedName = after.find((f) => f.startsWith("seg-") && segIndex(f) === sealedIndex);
  expect(sealedName).toBeDefined();
  // The sealed file must carry the seed lines.
  expect(statSync(join(emitterDir(), sealedName!)).size).toBeGreaterThan(0);

  // Original active path is gone (renamed); the new active uses a higher index.
  expect(after).not.toContain(activeBefore!);
  const activeAfter = after.find((f) => f.startsWith("active-"));
  expect(activeAfter).toBeDefined();
  expect(segIndex(activeAfter!)).toBeGreaterThan(sealedIndex);
  // No path reuse: sealed segment index strictly precedes the new active index.
  expect(segIndex(activeAfter!)).toBe(sealedIndex + 1);
}, 60_000);
