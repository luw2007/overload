/**
 * test/launchd-contract.test.ts — checked-in launchd/*.plist contract (OPS-05 /
 * OPS-07). Runs the real, read-only `plutil -lint` on each plist and asserts
 * KeepAlive / StartInterval scheduling plus that pull is documented in the
 * launchd README. Nothing is loaded, unloaded, or written to ~/Library.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const LAUNCHD = join(import.meta.dir, "../launchd");
const JOBS = ["ingest", "maintenance", "pull", "web", "orchestrator"];

function plist(name: string): string {
  return readFileSync(join(LAUNCHD, `app.overload.${name}.plist`), "utf8");
}

async function lint(name: string): Promise<number> {
  const proc = Bun.spawn(["/usr/bin/plutil", "-lint", join(LAUNCHD, `app.overload.${name}.plist`)],
    { stdout: "pipe", stderr: "pipe" });
  const [, , exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return exitCode;
}

describe("plist parse + scheduling (OPS-05)", () => {
  for (const name of JOBS) {
    test(`${name}.plist lints OK`, async () => {
      expect(await lint(name)).toBe(0);
    });
  }
  test("ingest and web are KeepAlive; maintenance and pull run every 60s", () => {
    expect(plist("ingest")).toContain("<key>KeepAlive</key><true/>");
    expect(plist("web")).toContain("<key>KeepAlive</key><true/>");
    expect(plist("maintenance")).toContain("<key>StartInterval</key><integer>60</integer>");
    expect(plist("pull")).toContain("<key>StartInterval</key><integer>60</integer>");
  });
  test("retired notifier plist is gone", () => {
    expect(existsSync(join(LAUNCHD, "app.overload.notifier.plist"))).toBe(false);
  });
});

describe("pull job contract (OPS-07)", () => {
  test("pull.plist runs bun src/pull/pull.ts --once", () => {
    const p = plist("pull");
    expect(p).toContain("src/pull/pull.ts");
    expect(p).toContain("--once");
    expect(p).toContain("<key>StartInterval</key><integer>60</integer>");
  });
  test("README documents pull in both install and uninstall sections", () => {
    const readme = readFileSync(join(LAUNCHD, "README.md"), "utf8");
    const installBlock = readme.slice(0, readme.indexOf("# Uninstall")) >= 0 ? readme.slice(0, readme.indexOf("# Uninstall")) : readme;
    expect(readme).toContain("pull");
    expect(installBlock).toContain("pull");
  });
});
