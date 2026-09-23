/**
 * test/maintenance.test.ts — scripts/maintenance.sh exit-code composition under
 * a forged OVERLOAD_ROOT + fake bun. recon failure must never suppress watchdog,
 * and a nonzero watchdog status must win the final exit code. The real
 * watchdog.sh behavior is covered by test/watchdog.test.ts; here it is a
 * controllable stub so only the composition logic is exercised.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sh(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function run(o: { reconExit: number; watchdogExit: number }) {
  const root = mkdtempSync(join(tmpdir(), "overload-maintenance-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  const project = join(root, "project");
  mkdirSync(join(project, "src", "recon"), { recursive: true });
  mkdirSync(join(project, "src", "notify"), { recursive: true });
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(join(project, "src/recon/recon.ts"), "");
  writeFileSync(join(project, "src/notify/nudge.ts"), "");
  // controllable watchdog stub that proves it was invoked even on recon failure
  sh(join(project, "scripts/watchdog.sh"),
    `printf 'watchdog-ran\\n' >>"$WATCHDOG_MARKER"; exit "$OVERLOAD_FAKE_WATCHDOG_EXIT"`);
  // fake bun: $1 is the script path; recon -> recon exit code; nudge -> always 0
  sh(join(bin, "bun"), `case "$1" in *recon.ts) exit "$OVERLOAD_FAKE_RECON_EXIT" ;; *) exit 0 ;; esac`);

  const marker = join(root, "watchdog.marker");
  const proc = Bun.spawn(["/bin/sh", "scripts/maintenance.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      OVERLOAD_ROOT: project,
      OVERLOAD_BUN: join(bin, "bun"),
      OVERLOAD_FAKE_RECON_EXIT: String(o.reconExit),
      OVERLOAD_FAKE_WATCHDOG_EXIT: String(o.watchdogExit),
      WATCHDOG_MARKER: marker,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  const watchdogRan = readFileSync(marker, "utf8").includes("watchdog-ran");
  return { stdout, stderr, exitCode, watchdogRan };
}

describe("maintenance composition (OPS-04 / OPS-06)", () => {
  test("recon=7 + watchdog=0 -> recon propagates rc=7, watchdog still invoked", async () => {
    const out = await run({ reconExit: 7, watchdogExit: 0 });
    expect(out.watchdogRan).toBe(true);
    expect(out.exitCode).toBe(7);
  });
  test("recon=7 + watchdog=1 -> watchdog nonzero wins rc=1", async () => {
    const out = await run({ reconExit: 7, watchdogExit: 1 });
    expect(out.watchdogRan).toBe(true);
    expect(out.exitCode).toBe(1);
  });
});
