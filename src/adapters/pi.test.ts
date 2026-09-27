import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPiRunnerInvocation, PiRuntime } from "./pi";
import { brokerMetadataPath, brokerSocketPath } from "./pi-broker";

test("buildPiRunnerInvocation wraps pi prompt in cmux new-workspace with parent origin", () => {
  const inv = buildPiRunnerInvocation("task-1", "attempt-2", "/worktree", "/tmp/prompt.txt");
  expect(inv.command).toBe("cmux");
  expect(inv.args).toContain("new-workspace");
  expect(inv.args).toContain("--cwd");
  expect(inv.args).toContain("/worktree");
  const command = inv.args[inv.args.indexOf("--command") + 1];
  expect(command).toContain("OVERLOAD_PARENT='orch:task:task-1:attempt-2'");
  expect(command).toContain("OVERLOAD_ORCH_TASK='task-1'");
  expect(command).toContain("pi -p '@/tmp/prompt.txt'");
});

test("connect treats stale starting metadata without a live socket as not live", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-runtime-"));
  const sessionId = "stale-session";
  const metadataPath = brokerMetadataPath(runtimeRoot, sessionId);
  mkdirSync(join(runtimeRoot, "metadata"), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify({
    runtimeRoot, metadataPath, socketPath: brokerSocketPath(runtimeRoot, sessionId),
    sessionId, ownerId: "owner-1", ownerToken: "token-1", cwd: "/tmp",
    command: "pi", stderrLimit: 1024, pid: 99999, state: "starting", updatedAt: Date.now(),
  }));
  const runtime = new PiRuntime({ runtimeRoot, connectTimeoutMs: 5000 });
  const start = Date.now();
  await expect(
    runtime.connect({ runtimeKind: "pi", sessionId, ownerId: "owner-1", cwd: "/tmp" }),
  ).rejects.toThrow("runtime_not_live");
  expect(Date.now() - start).toBeLessThan(500);
  rmSync(runtimeRoot, { recursive: true, force: true });
});

test("connect and restore treat a leftover socket file from a dead pid as not live", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-runtime-"));
  const sessionId = "dead-pid-session";
  const metadataPath = brokerMetadataPath(runtimeRoot, sessionId);
  const socketPath = brokerSocketPath(runtimeRoot, sessionId);
  mkdirSync(join(runtimeRoot, "metadata"), { recursive: true });
  mkdirSync(join(runtimeRoot, "sockets"), { recursive: true });
  writeFileSync(socketPath, "");
  const deadPid = 99999991;
  writeFileSync(metadataPath, JSON.stringify({
    runtimeRoot, metadataPath, socketPath,
    sessionId, ownerId: "owner-1", ownerToken: "token-1", cwd: "/tmp",
    command: "pi", stderrLimit: 1024, pid: deadPid, state: "starting", updatedAt: Date.now(),
  }));
  const runtime = new PiRuntime({ runtimeRoot, connectTimeoutMs: 5000 });
  const reference = { runtimeKind: "pi" as const, sessionId, ownerId: "owner-1", cwd: "/tmp" };
  const connectStart = Date.now();
  await expect(runtime.connect(reference)).rejects.toThrow("runtime_not_live");
  expect(Date.now() - connectStart).toBeLessThan(500);
  // Legacy metadata carries no process identities, so a dead-looking pid cannot prove the broker is gone
  // (pid reuse): restore refuses as ambiguous instead of spawning a second broker for the same session.
  rmSync(socketPath);
  let spawned = false;
  const restoringRuntime = new PiRuntime({
    runtimeRoot, connectTimeoutMs: 200,
    spawnBroker: async () => { spawned = true; },
  });
  await expect(
    restoringRuntime.restore({ ...reference, sessionFile: "/tmp/session.jsonl" }),
  ).rejects.toThrow("runtime_live_ambiguous");
  expect(spawned).toBe(false);
  rmSync(runtimeRoot, { recursive: true, force: true });
});
