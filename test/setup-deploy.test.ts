/**
 * test/setup-deploy.test.ts — one-shot setup composition (INS-05) and the
 * devbox dry-run contract (DEP-01/DEP-02). Both are dry-run paths, so no launchd
 * job is touched and no ssh/scp is actually executed; an isolated HOME keeps
 * ~/.pi / ~/.omp / LaunchAgents untouched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function sh(script: string, args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "overload-setup-")); roots.push(root);
  const proc = Bun.spawn(["/bin/sh", script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: join(root, "home") },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("setup.sh composition (INS-05)", () => {
  test("--dry-run runs launchd installer then extension installer, in order, rc=0", async () => {
    const out = await sh("scripts/setup.sh", ["--dry-run"]);
    expect(out.exitCode).toBe(0);
    const launchdIdx = out.stdout.indexOf("app.overload.ingest");
    const extIdx = out.stdout.indexOf(".pi/agent/extensions/overload.ts");
    expect(launchdIdx).toBeGreaterThanOrEqual(0);
    expect(extIdx).toBeGreaterThanOrEqual(0);
    // launchd installer runs before extension installer
    expect(launchdIdx).toBeLessThan(extIdx);
  });
  test("unknown arg prints usage and exits 2", async () => {
    const out = await sh("scripts/setup.sh", ["--bogus"]);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("Usage: setup.sh");
  });
});

describe("deploy-devbox.sh dry-run (DEP-01 / DEP-02)", () => {
  test("--dry-run previews pi+omp scp, mkdir/chmod 700, host=devbox 0600; no prime", async () => {
    const out = await sh("scripts/deploy-devbox.sh", ["--dry-run"]);
    expect(out.exitCode).toBe(0);
    // every previewed command is a no-op dry-run line
    for (const line of out.stdout.split("\n")) {
      if (line.trim() && !line.startsWith("devbox extension preparation complete")) expect(line.startsWith("+ ")).toBe(true);
    }
    expect(out.stdout).toContain(".pi/agent/extensions/overload.ts");
    expect(out.stdout).toContain(".omp/agent/extensions/overload.ts");
    expect(out.stdout).toContain("chmod 700");
    expect(out.stdout).toContain("printf \"%s\\n\" devbox");
    expect(out.stdout).toContain("chmod 600");
    expect(out.stdout).not.toContain(".prime");
  });
  test("unknown arg and extra arg both usage exit 2", async () => {
    const bad = await sh("scripts/deploy-devbox.sh", ["--force"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stderr).toContain("usage:");
    const extra = await sh("scripts/deploy-devbox.sh", ["--dry-run", "extra"]);
    expect(extra.exitCode).toBe(2);
    expect(extra.stderr).toContain("usage:");
  });
});
