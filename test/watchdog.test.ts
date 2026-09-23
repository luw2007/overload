/**
 * test/watchdog.test.ts — scripts/watchdog.sh behavior under a forged, isolated
 * environment. date / sysctl / launchctl / stat are shadowed on PATH so every
 * branch (healthy, unloaded, missing heartbeat, stale heartbeat, sleep-skew
 * reset) is exercised without touching launchd or the real ~/.overload.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const WALL = "1000000";      // fake `date +%s`
const BOOT = "1000";         // fake `sysctl -n kern.boottime` -> sec=1000
const UPTIME = String(Number(WALL) - Number(BOOT)); // 999000

function sh(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function envRoot(): { bin: string; home: string; state: string; heartbeat: string } {
  const root = mkdtempSync(join(tmpdir(), "overload-watchdog-")); roots.push(root);
  const bin = join(root, "bin"); mkdirSync(bin, { recursive: true });
  const home = join(root, "home"); mkdirSync(join(home, ".overload"), { recursive: true });
  sh(join(bin, "date"), `printf '%s\\n' "${WALL}"`);
  sh(join(bin, "sysctl"), `printf 'sec = %s\\n' "${BOOT}"`);
  sh(join(bin, "launchctl"), `[ "$1" = list ] && [ "$OVERLOAD_FAKE_LOADED" = 1 ] && exit 0 || exit 1`);
  // stat -f %m <file>: missing file -> nonzero (mimics real stat)
  sh(join(bin, "stat"), `[ -e "$3" ] || exit 1; printf '%s\\n' "$OVERLOAD_FAKE_MTIME"`);
  return { bin, home, state: join(root, "watchdog.state"), heartbeat: join(root, "ingest.heartbeat") };
}

async function runWatchdog(o: { loaded?: boolean; mtime?: string; initialState?: string; touchHeartbeat?: boolean }) {
  const r = envRoot();
  if (o.initialState !== undefined) writeFileSync(r.state, o.initialState);
  if (o.touchHeartbeat !== false) writeFileSync(r.heartbeat, "x");
  const proc = Bun.spawn(["/bin/sh", "scripts/watchdog.sh"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: r.home,
      PATH: `${r.bin}:/usr/bin:/bin`,
      OVERLOAD_WATCHDOG_STATE: r.state,
      OVERLOAD_HEARTBEAT: r.heartbeat,
      OVERLOAD_FAKE_LOADED: o.loaded === false ? "0" : "1",
      OVERLOAD_FAKE_MTIME: o.mtime ?? WALL,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  const stateNow = existsSync(r.state) ? readFileSync(r.state, "utf8").trim() : null;
  return { stdout, stderr, exitCode, stateNow };
}

describe("watchdog healthy path (OPS-01)", () => {
  test("loaded job + fresh heartbeat -> silent exit 0", async () => {
    const out = await runWatchdog({ loaded: true, mtime: String(Number(WALL) - 10) }); // age=10s <=30
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe("");
    expect(out.stderr).toBe("");
  });
});

describe("watchdog alarms (OPS-02)", () => {
  test("unloaded job -> 'not loaded' message, exit 1", async () => {
    const out = await runWatchdog({ loaded: false });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("overload watchdog: Overload ingest launchd job is not loaded");
  });
  test("loaded + missing heartbeat -> 'heartbeat is missing', exit 1", async () => {
    const out = await runWatchdog({ loaded: true, touchHeartbeat: false });
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("heartbeat is missing");
  });
  test("loaded + stale heartbeat -> 'heartbeat is stale (Ns)', exit 1", async () => {
    const out = await runWatchdog({ loaded: true, mtime: String(Number(WALL) - 1000) }); // age=1000s
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("heartbeat is stale (1000s)");
  });
});

describe("watchdog sleep-skew suppression (OPS-03)", () => {
  test("wall-vs-uptime skew > 60s -> state reset, exit 2, no alarm", async () => {
    // wall_delta=100, uptime_delta=0 -> |skew|=100 > 60
    const out = await runWatchdog({
      loaded: true,
      mtime: WALL,
      initialState: `${Number(WALL) - 100} ${UPTIME}`,
    });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toBe("");
    expect(out.stdout).toBe("");
    // state reset to current wall/uptime
    expect(out.stateNow).toBe(`${WALL} ${UPTIME}`);
  });
});
