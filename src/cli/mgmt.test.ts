import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureControlSchema } from "../control/store";
import { runMgmtCli } from "./mgmt";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function isolatedHome() {
  const home = mkdtempSync(join(tmpdir(), "overload-mgmt-cli-"));
  roots.push(home);
  const controlPath = join(home, "orchestrator-answers.db");
  const db = new Database(controlPath);
  ensureControlSchema(db);
  db.close();
  return { home, controlPath };
}

describe("runMgmtCli", () => {
  test("works on an empty control db prints an empty list and resolves", async () => {
    const { home } = isolatedHome();
    const prev = process.env.OVERLOAD_HOME;
    process.env.OVERLOAD_HOME = home;
    try {
      await expect(runMgmtCli(["works"])).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.OVERLOAD_HOME; else process.env.OVERLOAD_HOME = prev;
    }
  });

  test("an unknown command rejects with a usage error", async () => {
    const { home } = isolatedHome();
    const prev = process.env.OVERLOAD_HOME;
    process.env.OVERLOAD_HOME = home;
    try {
      await expect(runMgmtCli(["nonsense"])).rejects.toThrow(/usage: overload mgmt/);
    } finally {
      if (prev === undefined) delete process.env.OVERLOAD_HOME; else process.env.OVERLOAD_HOME = prev;
    }
  });

  test("show on a missing work id rejects as work not found", async () => {
    const { home } = isolatedHome();
    const prev = process.env.OVERLOAD_HOME;
    process.env.OVERLOAD_HOME = home;
    try {
      await expect(runMgmtCli(["show", "no-such-work"])).rejects.toThrow("work not found");
    } finally {
      if (prev === undefined) delete process.env.OVERLOAD_HOME; else process.env.OVERLOAD_HOME = prev;
    }
  });

  test("works prints a JSON array of listWorks", async () => {
    const { home, controlPath } = isolatedHome();
    const prev = process.env.OVERLOAD_HOME;
    process.env.OVERLOAD_HOME = home;
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
    try {
      await runMgmtCli(["works"]);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0]!);
      expect(Array.isArray(parsed)).toBe(true);
    } finally {
      console.log = orig;
      if (prev === undefined) delete process.env.OVERLOAD_HOME; else process.env.OVERLOAD_HOME = prev;
    }
  });
});
