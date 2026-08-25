import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

async function run(root: string, args: string[]) {
  const bin = join(root, "bin");
  const proc = Bun.spawn(["/bin/sh", "scripts/install-launchd.sh", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: join(root, "home"), PATH: `${bin}:/usr/bin:/bin`, LAUNCHCTL_LOG: join(root, "launchctl.log") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

describe("portable launchd installer", () => {
  test("generates validated checkout-specific plists and removes only them", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-launchd-"));
    roots.push(root)
    const bin = join(root, "bin");
    Bun.spawnSync(["mkdir", "-p", bin]);
    script(join(bin, "bun"), "exit 0");
    script(join(bin, "launchctl"), "printf '%s\\n' \"$*\" >>\"$LAUNCHCTL_LOG\"");
    const project = join(root, "portable-checkout");
    Bun.spawnSync(["mkdir", "-p", join(project, "src", "ingest"), join(project, "scripts")]);
    writeFileSync(join(project, "src", "ingest", "ingest.ts"), "");
    writeFileSync(join(project, "scripts", "maintenance.sh"), "");
    const legacyNotifier = join(root, "home", "Library", "LaunchAgents", "works.earendil.overload.notifier.plist");
    Bun.spawnSync(["mkdir", "-p", join(root, "home", "Library", "LaunchAgents")]);
    writeFileSync(legacyNotifier, "legacy notifier");
    const installed = await run(root, ["--install", "--project-dir", project]);
    expect(installed).toMatchObject({ exitCode: 0, stderr: "" });

    const agents = join(root, "home", "Library", "LaunchAgents");
    const names = ["ingest", "maintenance", "pull", "web"];
    for (const name of names) {
      const path = join(agents, `works.earendil.overload.${name}.plist`);
      expect(existsSync(path)).toBe(true);
      const value = readFileSync(path, "utf8");
      expect(value).toContain(project);
      expect(value).not.toContain("$HOME/ai/overload");
      expect(value).not.toContain("operator");
    }
    expect(existsSync(legacyNotifier)).toBe(false);
    expect(readFileSync(join(root, "launchctl.log"), "utf8")).toContain("bootstrap");

    const removed = await run(root, ["--uninstall", "--project-dir", project]);
    expect(removed).toMatchObject({ exitCode: 0, stderr: "" });
    for (const name of names) expect(existsSync(join(agents, `works.earendil.overload.${name}.plist`))).toBe(false);
  });
});
