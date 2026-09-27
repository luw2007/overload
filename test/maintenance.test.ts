/**
 * scripts/maintenance.sh exit-code composition, stage order, and the recon and
 * wait-observer process-group deadlines under a forged OVERLOAD_ROOT. The real
 * watchdog and nudge behavior are covered separately; these fixtures exercise
 * orchestration without sending a notification or touching the production ledger.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControl } from "../src/control/store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function sh(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

/** `enabled` sets OVERLOAD_CONDITION_WAITS=1 (§14.1 gate); otherwise the variable is forced empty (disabled). */
type Observer = { exit?: number; mode?: "hang" | "orphan"; real?: boolean; enabled?: boolean };

async function run(o: {
  reconExit?: number; watchdogExit: number; timeoutMs?: number; slowRecon?: boolean;
  observer?: Observer; observerTimeoutMs?: string;
}) {
  const root = mkdtempSync(join(tmpdir(), "overload-maintenance-")); roots.push(root);
  const project = join(root, "project");
  mkdirSync(join(project, "src", "recon"), { recursive: true });
  mkdirSync(join(project, "src", "notify"), { recursive: true });
  mkdirSync(join(project, "scripts"), { recursive: true });
  writeFileSync(join(project, "src/recon/recon.ts"), `
import { appendFileSync } from "node:fs";
appendFileSync(process.env.STAGE_MARKER!, "recon\\n");
if (process.env.OVERLOAD_SLOW_RECON === "1") {
  process.on("SIGTERM", () => {});
  const child = Bun.spawn(["/bin/sh", "-c", 'trap "" TERM; echo $$ >"$RECON_CHILD_PID"; while :; do sleep 1; done'], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env,
  });
  await child.exited;
} else {
  process.exit(Number(process.env.OVERLOAD_FAKE_RECON_EXIT));
}
`);
  if (o.observer?.real) {
    // The production CLI, resolved from the real source tree, against temp databases.
    mkdirSync(join(project, "src"), { recursive: true });
    symlinkSync(join(import.meta.dir, "..", "src", "waits"), join(project, "src", "waits"));
    if (o.observer.enabled) openControl(join(root, "control.db")).close();
  } else if (o.observer) {
    mkdirSync(join(project, "src", "waits"), { recursive: true });
    writeFileSync(join(project, "src/waits/cli.ts"), `
import { appendFileSync, writeFileSync } from "node:fs";
appendFileSync(process.env.STAGE_MARKER!, \`observer \${Date.now()} \${process.argv.slice(2).join(" ")}\\n\`);
const mode = process.env.OVERLOAD_FAKE_OBSERVER_MODE;
if (mode === "hang" || mode === "orphan") {
  if (mode === "hang") process.on("SIGTERM", () => {});
  const child = Bun.spawn(["/bin/sh", "-c", mode === "hang" ? 'trap "" TERM; while :; do sleep 1; done' : 'while :; do sleep 1; done'], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  writeFileSync(process.env.OBSERVER_CHILD_PID!, String(child.pid));
  if (mode === "hang") await child.exited;
  else { child.unref(); process.exit(0); }
} else {
  process.exit(Number(process.env.OVERLOAD_FAKE_OBSERVER_EXIT));
}
`);
  }
  writeFileSync(join(project, "src/notify/nudge.ts"), `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
let observerChild = "none";
if (existsSync(process.env.OBSERVER_CHILD_PID!)) {
  try { process.kill(Number(readFileSync(process.env.OBSERVER_CHILD_PID!, "utf8")), 0); observerChild = "alive"; } catch { observerChild = "dead"; }
}
appendFileSync(process.env.STAGE_MARKER!, \`nudge \${Date.now()} \${observerChild}\\n\`);
appendFileSync(process.env.NUDGE_MARKER!, "nudge-ran\\n");
`);
  sh(join(project, "scripts/watchdog.sh"),
    `printf 'watchdog\\n' >>"$STAGE_MARKER"; printf 'watchdog-ran\\n' >>"$WATCHDOG_MARKER"; exit "$OVERLOAD_FAKE_WATCHDOG_EXIT"`);

  const marker = join(root, "watchdog.marker");
  const nudgeMarker = join(root, "nudge.marker");
  const stageMarker = join(root, "stages.marker");
  const childPidFile = join(root, "recon-child.pid");
  const observerChildPidFile = join(root, "observer-child.pid");
  const startedAt = Date.now();
  const proc = Bun.spawn(["/bin/sh", "scripts/maintenance.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: root,
      PATH: "/usr/bin:/bin",
      OVERLOAD_ROOT: project,
      OVERLOAD_BUN: process.execPath,
      OVERLOAD_RECON_TIMEOUT_MS: String(o.timeoutMs ?? 2000),
      ...(o.observerTimeoutMs === undefined ? {} : { OVERLOAD_OBSERVER_TIMEOUT_MS: o.observerTimeoutMs }),
      OVERLOAD_FAKE_RECON_EXIT: String(o.reconExit ?? 0),
      OVERLOAD_FAKE_WATCHDOG_EXIT: String(o.watchdogExit),
      OVERLOAD_FAKE_OBSERVER_EXIT: String(o.observer?.exit ?? 0),
      OVERLOAD_FAKE_OBSERVER_MODE: o.observer?.mode ?? "",
      OVERLOAD_SLOW_RECON: o.slowRecon ? "1" : "0",
      OVERLOAD_CONDITION_WAITS: o.observer?.enabled ? "1" : "",
      OVERLOAD_ANSWERS_PATH: join(root, "control.db"),
      OVERLOAD_ORCHESTRATOR_PATH: join(root, "orchestrator.db"),
      OVERLOAD_LEDGER_PATH: join(root, "ledger.db"),
      RECON_CHILD_PID: childPidFile,
      OBSERVER_CHILD_PID: observerChildPidFile,
      NUDGE_MARKER: nudgeMarker,
      WATCHDOG_MARKER: marker,
      STAGE_MARKER: stageMarker,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  const lines = (path: string) => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
  const stages = lines(stageMarker).map((line) => line.split(" "));
  const childPid = existsSync(childPidFile) ? Number(readFileSync(childPidFile, "utf8").trim()) : undefined;
  const observerChildPid = existsSync(observerChildPidFile) ? Number(readFileSync(observerChildPidFile, "utf8").trim()) : undefined;
  return {
    stdout, stderr, exitCode, watchdogRuns: lines(marker).length, nudgeRuns: lines(nudgeMarker).length, childPid, observerChildPid,
    stages, order: stages.map((stage) => stage[0]), elapsedMs: Date.now() - startedAt,
  };
}

function gone(pid: number): boolean {
  return Bun.spawnSync(["/bin/kill", "-0", String(pid)], { stdout: "ignore", stderr: "ignore" }).exitCode !== 0;
}

describe("maintenance composition (OPS-04 / OPS-06)", () => {
  test("recon=7 + watchdog=0 -> recon propagates rc=7, downstream runs once", async () => {
    const out = await run({ reconExit: 7, watchdogExit: 0 });
    expect(out.watchdogRuns).toBe(1);
    expect(out.nudgeRuns).toBe(1);
    expect(out.exitCode).toBe(7);
  });
  test("recon=7 + watchdog=1 -> watchdog nonzero wins rc=1", async () => {
    const out = await run({ reconExit: 7, watchdogExit: 1 });
    expect(out.watchdogRuns).toBe(1);
    expect(out.nudgeRuns).toBe(1);
    expect(out.exitCode).toBe(1);
  });
  test("slow recon stays within its total budget, returns rc=124, kills its tree, and runs downstream once", async () => {
    const timeoutMs = 1200;
    const out = await run({ watchdogExit: 0, timeoutMs, slowRecon: true });
    expect(out.exitCode).toBe(124);
    expect(out.stderr).toContain(`recon timed out after ${timeoutMs}ms`);
    expect(out.elapsedMs).toBeLessThan(timeoutMs + 800);
    expect(out.watchdogRuns).toBe(1);
    expect(out.nudgeRuns).toBe(1);
    expect(out.childPid).toBeNumber();
    expect(gone(out.childPid!)).toBe(true);
  });
  test("invalid timeout fails before recon or notification projection", async () => {
    const out = await run({ watchdogExit: 0, timeoutMs: 0 });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("invalid OVERLOAD_RECON_TIMEOUT_MS: 0");
    expect(existsSync(join(roots.at(-1)!, "nudge.marker"))).toBe(false);
  });
});

describe("maintenance wait observer stage (phase B §9.2)", () => {
  test("runs one observe --once round after recon and before nudge and watchdog", async () => {
    const out = await run({ watchdogExit: 0, observer: {} });
    expect(out.exitCode).toBe(0);
    expect(out.order).toEqual(["recon", "observer", "nudge", "watchdog"]);
    expect(out.stages[1]!.slice(2)).toEqual(["observe", "--once"]);
  });

  test("observer failure is recorded, never stops nudge or watchdog, and surfaces after recon and watchdog", async () => {
    const failed = await run({ watchdogExit: 0, observer: { exit: 3 } });
    expect(failed.order).toEqual(["recon", "observer", "nudge", "watchdog"]);
    expect(failed.exitCode).toBe(3);
    const withRecon = await run({ reconExit: 7, watchdogExit: 0, observer: { exit: 3 } });
    expect(withRecon.order).toEqual(["recon", "observer", "nudge", "watchdog"]);
    expect(withRecon.exitCode).toBe(7);
    const withWatchdog = await run({ reconExit: 7, watchdogExit: 1, observer: { exit: 3 } });
    expect(withWatchdog.nudgeRuns).toBe(1);
    expect(withWatchdog.exitCode).toBe(1);
  });

  test("B05: a hung observer and its TERM-ignoring child are TERMed at 4s, KILLed and reaped by 5s, then nudge runs", async () => {
    const out = await run({ watchdogExit: 0, observer: { mode: "hang" } });
    expect(out.exitCode).toBe(124);
    expect(out.stderr).toContain("wait observer timed out after 5000ms");
    expect(out.order).toEqual(["recon", "observer", "nudge", "watchdog"]);
    const observerStart = Number(out.stages[1]![1]);
    const [, nudgeStart, observerChild] = out.stages[2]!;
    // From the observer's own start to the next stage's start: the 5s group bound plus one Bun startup.
    expect(Number(nudgeStart) - observerStart).toBeGreaterThanOrEqual(4900);
    expect(Number(nudgeStart) - observerStart).toBeLessThan(5600);
    expect(observerChild).toBe("dead");
    expect(gone(out.observerChildPid!)).toBe(true);
  }, 15_000);

  test("descendants left behind by an exited observer are terminated before nudge", async () => {
    const out = await run({ watchdogExit: 0, observer: { mode: "orphan" } });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("wait observer left descendants");
    expect(out.stages[2]![2]).toBe("dead");
    expect(out.elapsedMs).toBeLessThan(3000);
  });

  test("the observer budget can be tightened but never raised above 5s", async () => {
    const raised = await run({ watchdogExit: 0, observer: {}, observerTimeoutMs: "5001" });
    expect(raised.exitCode).toBe(2);
    expect(raised.stderr).toContain("invalid OVERLOAD_OBSERVER_TIMEOUT_MS: 5001");
    expect(raised.order).toEqual([]);
    const tightened = await run({ watchdogExit: 0, observer: { mode: "hang" }, observerTimeoutMs: "1500" });
    expect(tightened.exitCode).toBe(124);
    expect(tightened.stderr).toContain("wait observer timed out after 1500ms");
    expect(tightened.stages[2]![2]).toBe("dead");
  });

  test("with OVERLOAD_CONDITION_WAITS=1 the production observer CLI completes a real round under the wrapper and prints one JSON line", async () => {
    const out = await run({ watchdogExit: 0, observer: { real: true, enabled: true } });
    expect(out.stderr).toBe("");
    expect(out.exitCode).toBe(0);
    expect(out.order).toEqual(["recon", "nudge", "watchdog"]);
    const lines = out.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ claimed: 0, observed: 0, ready: 0, unavailable: 0, expired: 0, conflicted: 0, timed_out: 0 });
  });

  test("§14.1 default-off: the production observer reports disabled, opens no database, and nudge and watchdog still run", async () => {
    const out = await run({ watchdogExit: 0, observer: { real: true } });
    expect(out.stderr).toBe("");
    expect(out.exitCode).toBe(0);
    expect(out.order).toEqual(["recon", "nudge", "watchdog"]);
    expect(out.nudgeRuns).toBe(1);
    expect(out.watchdogRuns).toBe(1);
    const lines = out.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ status: "disabled", reason: "OVERLOAD_CONDITION_WAITS is not 1" });
    const root = roots.at(-1)!;
    for (const db of ["control.db", "orchestrator.db", "ledger.db"]) expect(existsSync(join(root, db))).toBe(false);
  });
});
