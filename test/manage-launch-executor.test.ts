import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { localLaunchExecutor, type LaunchRequest } from "../src/manage/launch";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function request(argv: string[], cwd: string): LaunchRequest {
  return { handoffId: "h1", agent: "pi", cwd, host: { host: "local", kind: "local" }, argv, env: {}, idempotencyKey: "k" };
}

test("MAN-26: localLaunchExecutor spawns a tmp executable stub and returns pid + receipt", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "overload-man26-"));
  dirs.push(dir);
  const stub = join(dir, "stub.sh");
  await writeFile(stub, "#!/bin/sh\necho stub-pid-$$\n");
  await chmod(stub, 0o755);

  const result = await localLaunchExecutor(request([stub], dir));
  expect(typeof result.pid).toBe("number");
  expect(result.pid).toBeGreaterThan(0);
  expect(result.receipt).toBe(`pid:${result.pid}`);
});

test("MAN-26: localLaunchExecutor maps ENOENT (missing binary) to a no_effect error", async () => {
  const dir = await mkdtemp(resolve(tmpdir(), "overload-man26-missing-"));
  dirs.push(dir);
  const missing = "/tmp/nonexistent-binary-xyz-never-exists";

  let caught: any = null;
  try {
    await localLaunchExecutor(request([missing], dir));
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(caught?.code).toBe("ENOENT");
  expect(caught?.no_effect).toBe(true);
});
