/**
 * test/ext-host-identity-unreadable.test.ts — EXT-16(c): an unreadable
 * ~/.overload/host file (chmod 000) fails closed to the "local" host rather
 * than disabling telemetry. Host is resolved once at construction (import time).
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-host-unreadable-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();

beforeAll(async () => {
  mkdirSync(join(home, ".overload"), { recursive: true });
  writeFileSync(join(home, ".overload", "host"), "devbox\n");
  chmodSync(join(home, ".overload", "host"), 0o000);
  const { default: overload } = await import("../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as never);
  const start = handlers.get("session_start") ?? [];
  await Promise.all(start.map((h) => h({ reason: "startup" }, { cwd: home, sessionManager: { getSessionId: () => "cccc3333-dddd-4eee-8fff-111111111111" } })));
});

afterAll(() => {
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

test("EXT-16(c): unreadable host file falls back to spool/local/", () => {
  expect(existsSync(join(home, ".overload", "spool", "local"))).toBe(true);
  expect(existsSync(join(home, ".overload", "spool", "devbox"))).toBe(false);
});
