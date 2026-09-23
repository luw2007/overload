import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

test("extension cmux host probe", () => {
  const result = spawnSync(process.execPath, ["test", join(import.meta.dir, "fixtures/ext-host-context.fixture.ts")], {
    encoding: "utf8",
    env: process.env,
  });
  expect(result.stderr + result.stdout).toContain("2 pass");
  expect(result.status, result.stderr + result.stdout).toBe(0);
});
