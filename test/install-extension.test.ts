/**
 * test/install-extension.test.ts — scripts/install-extension.sh against an
 * isolated HOME (INS-04). Real copy, perms 0700 dirs / 0600 files, byte-identical
 * to src/extension/overload.ts, pi+omp only (prime excluded), uninstall removes.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SRC = join(import.meta.dir, "../src/extension/overload.ts");

async function run(args: string[], home: string) {
  const proc = Bun.spawn(["/bin/sh", "scripts/install-extension.sh", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const targets = (home: string) => [
  join(home, ".pi/agent/extensions/overload.ts"),
  join(home, ".omp/agent/extensions/overload.ts"),
];

describe("install-extension.sh (INS-04)", () => {
  test("installs to pi+omp with 0700 dirs / 0600 files, byte-identical; prime untouched", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "overload-ins04-")), "home"); roots.push(home);
    const out = await run(["--install"], home);
    expect(out.exitCode).toBe(0);
    const source = readFileSync(SRC);
    for (const t of targets(home)) {
      expect(existsSync(t)).toBe(true);
      expect(statSync(t).mode & 0o777).toBe(0o600);
      expect(readFileSync(t)).toEqual(source);
      expect(statSync(join(t, "..")).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(join(home, ".prime/agent/extensions/overload.ts"))).toBe(false);
  });

  test("uninstall removes both extension files", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "overload-ins04-")), "home"); roots.push(home);
    await run(["--install"], home);
    const out = await run(["--uninstall"], home);
    expect(out.exitCode).toBe(0);
    for (const t of targets(home)) expect(existsSync(t)).toBe(false);
  });

  test("unknown flag prints usage and exits 2", async () => {
    const home = join(mkdtempSync(join(tmpdir(), "overload-ins04-")), "home"); roots.push(home);
    const out = await run(["--bogus"], home);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Usage: install-extension.sh");
  });
});
