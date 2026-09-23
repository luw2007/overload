/**
 * test/ext-host-identity-devbox.test.ts — EXT-16(a): a ~/.overload/host file
 * containing exactly "devbox" routes the spool to spool/devbox/.
 * Host is resolved once at SpoolWriter construction (import time), so this is
 * its own module graph. tmp HOME isolation via node:os mock.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-host-devbox-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();

beforeAll(async () => {
  mkdirSync(join(home, ".overload"), { recursive: true });
  writeFileSync(join(home, ".overload", "host"), "devbox\n");
  const { default: overload } = await import("../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as never);
  const start = handlers.get("session_start") ?? [];
  await Promise.all(start.map((h) => h({ reason: "startup" }, { cwd: home, sessionManager: { getSessionId: () => "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee" } })));
});

afterAll(() => {
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

test("EXT-16(a): host file 'devbox' yields spool/devbox/", () => {
  expect(existsSync(join(home, ".overload", "spool", "devbox"))).toBe(true);
  expect(existsSync(join(home, ".overload", "spool", "local"))).toBe(false);
});
