/**
 * test/ext-installed-shape.test.ts — the extension must load from its INSTALLED
 * shape, not just from the repo.
 *
 * scripts/install-extension.sh copies src/extension/overload.ts as a single file
 * to ~/.pi/agent/extensions/overload.ts and ~/.omp/agent/extensions/overload.ts.
 * The hosts do not bundle, do not rewrite imports and do not resolve against the
 * repo, so any non-`node:` import is unresolvable there — and both pi and omp
 * fail *non-fatally*: they print "Failed to load extension" and run on with no
 * Overload telemetry at all.
 *
 * Every other extension test imports ../src/extension/overload.ts from inside the
 * repo, where ../shared/* resolves, so the suite stays green while the installed
 * file is dead. These two tests close that gap: one loads a copy from a temp
 * directory shaped like an install, the other names the constraint directly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SRC = join(import.meta.dir, "../src/extension/overload.ts");

/** A copy at ~/.pi/agent/extensions/overload.ts under a temp HOME, away from the repo. */
function installedCopy(runtime: "pi" | "omp"): string {
  const home = join(mkdtempSync(join(tmpdir(), "overload-installed-")), "home");
  roots.push(join(home, ".."));
  const dir = join(home, `.${runtime}/agent/extensions`);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, "overload.ts");
  copyFileSync(SRC, target);
  return target;
}

describe("installed extension shape", () => {
  for (const runtime of ["pi", "omp"] as const) {
    test(`loads as a single copied file under ~/.${runtime}/agent/extensions`, async () => {
      const target = installedCopy(runtime);
      // A fresh bun process: the host dynamically imports the installed path, so
      // resolution must succeed with nothing but the copied file present.
      const proc = Bun.spawn(["bun", "-e", `
        const mod = await import(${JSON.stringify(target)})
        if (typeof mod.default !== "function") { console.error("no default export"); process.exit(3) }
      `], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      expect({ exitCode, stdout, stderr }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    });
  }

  test("imports only node: builtins", () => {
    const source = readFileSync(SRC, "utf8");
    const specifiers = [
      ...source.matchAll(/(?:^|\n)\s*import\s+(?:[^"'\n]*?from\s*)?["']([^"']+)["']/g),
      ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
      ...source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    // Installed as a single copied file, so a bare or relative specifier cannot
    // resolve at ~/.pi/agent/extensions/overload.ts. Inline the helper instead.
    expect(specifiers.filter((specifier) => !specifier.startsWith("node:"))).toEqual([]);
  });
});
