// ADP-20 (guard branches): PiRuntime.start rejects mismatched ownerId/cwd and a
// stopped existing session BEFORE spawning any broker child. We seed a fake
// broker metadata JSON on a tmp runtimeRoot and assert the pre-spawn throws.
// The live start/connect/restore/shutdown round-trip still requires the real
// pi binary and remains out of bun test scope.
import { expect, test } from "bun:test";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiRuntime } from "./pi";

function seedMetadata(root: string, sessionId: string, fields: Record<string, unknown>): void {
  mkdirSync(join(root, "metadata"), { recursive: true });
  writeFileSync(
    join(root, "metadata", `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      ownerId: "owner",
      ownerToken: "tok",
      socketPath: join(root, "sockets", `${sessionId}.sock`),
      ...fields,
    }),
  );
}

test("ADP-20 start rejects an owner/cwd mismatch before spawning the broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-guard-"));
  try {
    seedMetadata(root, "s1", { cwd: "/repo", state: "running" });
    const runtime = new PiRuntime({ runtimeRoot: root, spawnBroker: async () => { throw new Error("should not spawn"); } });
    await expect(
      runtime.start({ sessionId: "s1", ownerId: "intruder", cwd: "/repo" }),
    ).rejects.toThrow("runtime_ownership_mismatch");
    await expect(
      runtime.start({ sessionId: "s1", ownerId: "owner", cwd: "/other" }),
    ).rejects.toThrow("runtime_ownership_mismatch");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ADP-20 start rejects an existing stopped session before spawning the broker", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-runtime-guard-stopped-"));
  try {
    seedMetadata(root, "s2", { cwd: "/repo", state: "stopped" });
    const runtime = new PiRuntime({ runtimeRoot: root, spawnBroker: async () => { throw new Error("should not spawn"); } });
    await expect(
      runtime.start({ sessionId: "s2", ownerId: "owner", cwd: "/repo" }),
    ).rejects.toThrow("runtime_session_exists_stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
