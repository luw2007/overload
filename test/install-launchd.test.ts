import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
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

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overload-launchd-"));
  roots.push(root);
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  script(join(bin, "bun"), "exit 0");
  script(join(bin, "launchctl"), "printf '%s\\n' \"$*\" >>\"$LAUNCHCTL_LOG\"");
  const project = join(root, "portable-checkout");
  mkdirSync(join(project, "src", "ingest"), { recursive: true });
  mkdirSync(join(project, "src", "orchestrator"), { recursive: true });
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(join(project, "src", "ingest", "ingest.ts"), "");
  writeFileSync(join(project, "src", "orchestrator", "orchestrator.ts"), "");
  writeFileSync(join(project, "scripts", "maintenance.sh"), "");
  const agents = join(root, "home", "Library", "LaunchAgents");
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, "works.earendil.overload.notifier.plist"), "legacy notifier");
  return { root, project, agents };
}

function bootstrappedNames(root: string): string[] {
  const log = readFileSync(join(root, "launchctl.log"), "utf8").trim();
  if (!log) return [];
  return log.split("\n")
    .filter((line) => line.startsWith("bootstrap "))
    .map((line) => line.match(/works\.earendil\.overload\.([^.]+)\.plist$/)?.[1] ?? "");
}

describe("portable launchd installer", () => {
  test("installs four jobs by default", async () => {
    const { root, project, agents } = fixture();
    const installed = await run(root, ["--install", "--project-dir", project]);
    expect(installed).toMatchObject({ exitCode: 0, stderr: "" });

    const names = ["ingest", "maintenance", "pull", "web"];
    expect(bootstrappedNames(root)).toEqual(names);
    for (const name of names) {
      const path = join(agents, `works.earendil.overload.${name}.plist`);
      expect(existsSync(path)).toBe(true);
      const value = readFileSync(path, "utf8");
      expect(value).toContain(project);
      expect(value).not.toContain("$HOME/ai/overload");
      // Whoever runs this: the plist must name the checkout, never the operator.
      expect(value).not.toContain(userInfo().username);
    }
    expect(existsSync(join(agents, "works.earendil.overload.orchestrator.plist"))).toBe(false);
    expect(existsSync(join(agents, "works.earendil.overload.notifier.plist"))).toBe(false);

    const removed = await run(root, ["--uninstall", "--project-dir", project]);
    expect(removed).toMatchObject({ exitCode: 0, stderr: "" });
    for (const name of names) expect(existsSync(join(agents, `works.earendil.overload.${name}.plist`))).toBe(false);
  });

  test("installs orchestrator only with --with-orchestrator and uninstall removes all five", async () => {
    const { root, project, agents } = fixture();
    const names = ["ingest", "maintenance", "pull", "web", "orchestrator"];
    const installed = await run(root, ["--install", "--with-orchestrator", "--project-dir", project]);
    expect(installed).toMatchObject({ exitCode: 0, stderr: "" });
    expect(bootstrappedNames(root)).toEqual(names);
    for (const name of names) expect(existsSync(join(agents, `works.earendil.overload.${name}.plist`))).toBe(true);

    const orchestrator = readFileSync(join(agents, "works.earendil.overload.orchestrator.plist"), "utf8");
    expect(orchestrator).toContain(`${project}/src/orchestrator/orchestrator.ts`);
    expect(orchestrator).toContain("<key>KeepAlive</key><true/>");

    const removed = await run(root, ["--uninstall", "--project-dir", project]);
    expect(removed).toMatchObject({ exitCode: 0, stderr: "" });
    for (const name of names) expect(existsSync(join(agents, `works.earendil.overload.${name}.plist`))).toBe(false);
  });

  test("stops before bootstrap when plutil rejects plist", async () => {
    const { root, project } = fixture();
    script(join(root, "bin", "plutil"), 'case "$2" in\n  *orchestrator.plist) exit 1;;\nesac\nexit 0');
    const failed = await run(root, ["--install", "--with-orchestrator", "--project-dir", project]);
    expect(failed.exitCode).toBe(1);
    expect(bootstrappedNames(root)).toEqual(["ingest", "maintenance", "pull", "web"]);
  });
});
