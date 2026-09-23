/**
 * test/ext-host-identity-local.test.ts — EXT-16(b): with NO ~/.overload/host
 * file, the host defaults to "local" and the spool lands in spool/local/.
 * Host is resolved once at SpoolWriter construction (import time).
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-host-local-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();

beforeAll(async () => {
  const { default: overload } = await import("../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as never);
  const start = handlers.get("session_start") ?? [];
  await Promise.all(start.map((h) => h({ reason: "startup" }, { cwd: home, sessionManager: { getSessionId: () => "bbbb2222-cccc-4ddd-8eee-ffffffffffff" } })));
});

afterAll(() => {
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

test("EXT-16(b): no host file defaults to spool/local/", () => {
  expect(existsSync(join(home, ".overload", "spool", "local"))).toBe(true);
});
