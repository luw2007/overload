import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Executor } from "../web/jump";
import { runDoctor, type DoctorDeps, type StatInfo } from "./doctor";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const NOW = 1_800_000_000_000;
const OVERLOAD_ROOT = "/tmp/overload-doctor-root";

function seededLedger(events: Array<{ at: number; kind: string }> = [{ at: NOW - 60_000, kind: "session_started" }]): { path: string; db: Database } {
  const root = mkdtempSync(join(tmpdir(), "overload-doctor-")); roots.push(root);
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.run("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, at INTEGER, kind TEXT, detail TEXT)");
  for (const event of events) db.run("INSERT INTO journal(at, kind, detail) VALUES (?, ?, '{}')", [event.at, event.kind]);
  return { path, db };
}

function launchctlOf(states: Record<string, { state?: string; lastExit?: number }>): Executor {
  return async (command, args) => {
    if (command !== "launchctl" || args[0] !== "print") return { ok: false, error: "unexpected command" };
    const label = args[1]!.split("/").pop()!.replace("works.earendil.overload.", "");
    const entry = states[label];
    if (!entry) return { ok: false, error: "Could not find service" };
    const exitLine = entry.lastExit == null ? "" : `\tlast exit code = ${entry.lastExit}\n`;
    return { ok: true, stdout: `x = {\n\tstate = ${entry.state ?? "running"}\n${exitLine}}` };
  };
}

const HEALTHY_LAUNCHD = launchctlOf({
  ingest: { state: "running" }, notifier: { state: "running" }, web: { state: "running" },
  maintenance: { state: "not running", lastExit: 0 }, pull: { state: "not running", lastExit: 0 },
});

/** Every dimension defaults to healthy; each test overrides only what it probes. */
function baseDeps(overrides: { exec?: Executor; ledgerPath?: string; extraFiles?: Record<string, StatInfo>; now?: () => number } = {}): DoctorDeps {
  const ledgerPath = overrides.ledgerPath ?? seededLedger().path;
  const files: Record<string, StatInfo> = {
    "/tmp/pi-ext.ts": { mtimeMs: NOW, mode: 0o100600 },
    "/tmp/omp-ext.ts": { mtimeMs: NOW, mode: 0o100600 },
    [OVERLOAD_ROOT]: { mtimeMs: NOW, mode: 0o40700 },
    [join(OVERLOAD_ROOT, "ingest.heartbeat")]: { mtimeMs: NOW - 5_000, mode: 0o100600 },
    [join(OVERLOAD_ROOT, "pull.heartbeat")]: { mtimeMs: NOW - 5_000, mode: 0o100600 },
    [ledgerPath]: { mtimeMs: NOW, mode: 0o100600 },
    ...overrides.extraFiles,
  };
  return {
    ledgerPath,
    overloadRoot: OVERLOAD_ROOT,
    extensionTargets: [{ label: "pi", path: "/tmp/pi-ext.ts" }, { label: "omp", path: "/tmp/omp-ext.ts" }],
    uid: "502",
    exec: overrides.exec ?? HEALTHY_LAUNCHD,
    stat: async (path) => files[path] ?? null,
    now: overrides.now ?? (() => NOW),
  };
}

describe("runDoctor", () => {
  test("reports OK across the board on a healthy install and exits 0", async () => {
    const { checks, exitCode } = await runDoctor(baseDeps());
    expect(exitCode).toBe(0);
    expect(checks.every((check) => check.status !== "FAIL")).toBe(true);
    expect(checks.find((check) => check.label === "ledger")?.status).toBe("OK");
    expect(checks.find((check) => check.label === "telemetry:liveness")?.status).toBe("OK");
  });

  test("fails when the ledger cannot be opened, but still runs independent checks", async () => {
    const deps = baseDeps({ ledgerPath: "/nonexistent/does-not-exist.db" });
    const { checks, exitCode } = await runDoctor(deps);
    expect(exitCode).toBe(1);
    expect(checks.find((check) => check.label === "ledger")?.status).toBe("FAIL");
    expect(checks.find((check) => check.label === "telemetry:liveness")).toEqual({ status: "FAIL", label: "telemetry:liveness", detail: "ledger unavailable" });
    // Extension/launchd checks are independent of the ledger and still run.
    expect(checks.find((check) => check.label === "extension:pi")?.status).toBe("OK");
    expect(checks.find((check) => check.label === "launchd:ingest")?.status).toBe("OK");
  });

  test("warns (not fails) when an extension file is missing", async () => {
    const deps = baseDeps({ extraFiles: { "/tmp/pi-ext.ts": null } });
    const { checks, exitCode } = await runDoctor(deps);
    const pi = checks.find((check) => check.label === "extension:pi")!;
    expect(pi.status).toBe("WARN");
    expect(pi.detail).toContain("install-extension.sh");
    expect(exitCode).toBe(0);
  });

  test("fails when a keepalive job is not running", async () => {
    const deps = baseDeps({ exec: launchctlOf({ ingest: { state: "not running" }, notifier: { state: "running" }, web: { state: "running" }, maintenance: { lastExit: 0 }, pull: { lastExit: 0 } }) });
    const { checks, exitCode } = await runDoctor(deps);
    expect(checks.find((check) => check.label === "launchd:ingest")).toEqual({ status: "FAIL", label: "launchd:ingest", detail: "state=not running" });
    expect(exitCode).toBe(1);
  });

  test("treats interval-job idle state as healthy but flags a nonzero last exit", async () => {
    const deps = baseDeps({ exec: launchctlOf({ ingest: { state: "running" }, notifier: { state: "running" }, web: { state: "running" }, maintenance: { state: "not running", lastExit: 1 }, pull: { state: "not running", lastExit: 0 } }) });
    const { checks, exitCode } = await runDoctor(deps);
    expect(checks.find((check) => check.label === "launchd:maintenance")).toEqual({ status: "FAIL", label: "launchd:maintenance", detail: "last exit code 1" });
    expect(checks.find((check) => check.label === "launchd:pull")?.status).toBe("OK");
    expect(exitCode).toBe(1);
  });

  test("downgrades a stale pull job to WARN, since remote sync is optional infrastructure", async () => {
    const deps = baseDeps({ exec: launchctlOf({ ingest: { state: "running" }, notifier: { state: "running" }, web: { state: "running" }, maintenance: { lastExit: 0 }, pull: { lastExit: 1 } }) });
    const { checks, exitCode } = await runDoctor(deps);
    expect(checks.find((check) => check.label === "launchd:pull")).toEqual({ status: "WARN", label: "launchd:pull", detail: "last exit code 1" });
    expect(exitCode).toBe(0);
  });

  test("fails a stale ingest heartbeat but only warns on a stale pull heartbeat", async () => {
    const deps = baseDeps({ extraFiles: {
      [join(OVERLOAD_ROOT, "ingest.heartbeat")]: { mtimeMs: NOW - 90_000, mode: 0o100600 },
      [join(OVERLOAD_ROOT, "pull.heartbeat")]: { mtimeMs: NOW - 200_000, mode: 0o100600 },
    } });
    const { checks, exitCode } = await runDoctor(deps);
    expect(checks.find((check) => check.label === "heartbeat:ingest")?.status).toBe("FAIL");
    expect(checks.find((check) => check.label === "heartbeat:pull")?.status).toBe("WARN");
    expect(exitCode).toBe(1);
  });

  test("fails telemetry liveness when a stale session gap has corroborating telemetry_gap evidence", async () => {
    const staleAt = NOW - 40 * 60_000;
    const { path: ledgerPath } = seededLedger([{ at: staleAt, kind: "session_started" }, { at: NOW - 60_000, kind: "telemetry_gap" }]);
    const { checks, exitCode } = await runDoctor(baseDeps({ ledgerPath }));
    const liveness = checks.find((check) => check.label === "telemetry:liveness")!;
    expect(liveness.status).toBe("FAIL");
    expect(liveness.detail).toContain("install-extension.sh");
    expect(exitCode).toBe(1);
  });

  test("only warns telemetry liveness for a stale gap with no corroborating evidence", async () => {
    const staleAt = NOW - 40 * 60_000;
    const { path: ledgerPath } = seededLedger([{ at: staleAt, kind: "session_started" }]);
    const { checks, exitCode } = await runDoctor(baseDeps({ ledgerPath }));
    const liveness = checks.find((check) => check.label === "telemetry:liveness")!;
    expect(liveness.status).toBe("WARN");
    expect(liveness.detail).toContain("may just be idle");
    expect(exitCode).toBe(0);
  });

  test("warns on unexpected ledger directory/file permissions", async () => {
    const { path: ledgerPath } = seededLedger();
    const deps = baseDeps({ ledgerPath, extraFiles: { [OVERLOAD_ROOT]: { mtimeMs: NOW, mode: 0o40755 }, [ledgerPath]: { mtimeMs: NOW, mode: 0o100644 } } });
    const { checks, exitCode } = await runDoctor(deps);
    expect(checks.find((check) => check.label === "permissions:dir")?.status).toBe("WARN");
    expect(checks.find((check) => check.label === "permissions:db")?.status).toBe("WARN");
    expect(exitCode).toBe(0);
  });
});
