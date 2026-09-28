/**
 * test/ext-seal-overflow.test.ts — real-run behavioral test for:
 *   EXT-14(b) segment inline sealing at SEGMENT_MAX_BYTES=1048576: writing
 *         >1MB triggers an inline seal() inside drainAsync, renaming the active
 *         file to seg- and advancing the segment counter (no path reuse).
 *
 * The 30s age-based seal (EXT-14a) cannot be fast-forwarded with Bun fake timers:
 * the seal timer only arms after a real fs write lands, and Bun's fake timers
 * do not pump the threadpool fs between test steps. The shared seal() rename +
 * monotonic-segment behavior is proven here by the 1MB inline path.
 * tmp HOME isolation via node:os mock; never ~/.overload.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-seal-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");
const SESSION = "9f1e7a30-0000-4000-8000-000000000002";
const SEGMENT_MAX_BYTES = 1_048_576;

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

// A consequential `git push` reaches the unthrottled tool_activity branch and
// emits synchronously at the top of the async handler (no await before emit).
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

test("EXT-14(b): inline seal fires at 1MB and advances segment without path reuse", async () => {
  let n = 0;
  let sealedBig: string | undefined;
  // Enqueue in small batches with a real pause so the queue never reaches the
  // overflow limit (which would drop lines and corrupt the byte accounting).
  for (let batch = 0; batch < 200 && !sealedBig; batch++) {
    for (let i = 0; i < 150; i++) push(`seal-${n++}`);
    await Bun.sleep(25);
    sealedBig = listFiles().find((f) => f.startsWith("seg-") && statSync(join(emitterDir(), f)).size >= SEGMENT_MAX_BYTES);
  }

  expect(sealedBig).toBeDefined();
  const sealedSize = statSync(join(emitterDir(), sealedBig!)).size;
  expect(sealedSize).toBeGreaterThanOrEqual(SEGMENT_MAX_BYTES);

  // After a seal, the new active file is created lazily on the next write.
  // Enqueue one more event to force active creation, then bounded-poll for it.
  push(`seal-post-${n++}`);
  let active: string | undefined;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 3000) {
    active = listFiles().find((f) => f.startsWith("active-"));
    if (active) break;
    await Bun.sleep(50);
  }

  // The active path must reuse a higher segment index than the sealed one.
  const segIndex = (name: string) => Number(name.match(/-(\d+)\.ndjson$/)?.[1]);
  expect(active).toBeDefined();
  expect(segIndex(active!)).toBeGreaterThan(segIndex(sealedBig!));
});
