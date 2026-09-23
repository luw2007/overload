/**
 * test/audit-pipeline-pull.test.ts — audit backfill for pull stories whose r2
 * evidence described manual behavioral runs or "green suite" but shipped no
 * assertion. Isolated tmp dirs; fake ssh/rsync via scripts.
 *
 * Covers: PUL-02 ssh preflight args, PUL-04 heartbeat absent on failure,
 * PUL-05 atomic state file + perms, PUL-07 loadConfig rejection,
 * PUL-08 time-budget kills the child process group (no wall-clock blowout).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Puller, loadConfig, type PullConfig } from "../src/pull/pull";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

async function fixture(opts: { failing?: boolean; sshBody?: string; timeout_ms?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ov-pulaudit-"));
  roots.push(root);
  for (const d of ["remote-spool", "dest", "admin-spool"]) await mkdir(join(root, d), { recursive: true });
  const ssh = join(root, "ssh.sh");
  await writeFile(ssh, opts.sshBody ?? (opts.failing ? "#!/bin/sh\nexit 9\n" : "#!/bin/sh\nexit 0\n"), { mode: 0o700 });
  const db = join(root, "ledger.db");
  new Database(db).close();
  const config: PullConfig = {
    remote: "local", remote_spool: join(root, "remote-spool"), dest: join(root, "dest"),
    ssh_cmd: ssh, rsync_cmd: "rsync", fail_threshold: 4, timeout_ms: opts.timeout_ms ?? 5_000,
    ledger: db, admin_spool: join(root, "admin-spool"),
    heartbeat: join(root, "pull.heartbeat"), state: join(root, "pull-state.json"), lock: join(root, "pull.lock"),
  };
  return { root, config };
}

describe("PUL-02 ssh preflight passes BatchMode + ConnectTimeout", () => {
  test("ssh is invoked with -o BatchMode=yes -o ConnectTimeout=5", async () => {
    const f = await fixture();
    const argsLog = join(f.root, "ssh-args.txt");
    const ssh = join(f.root, "ssh.sh");
    await writeFile(ssh, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argsLog)}\nexit 0\n`, { mode: 0o700 });
    await new Puller({ ...f.config, ssh_cmd: ssh }).runOnce();
    const args = (await readFile(argsLog, "utf8")).split("\n");
    expect(args).toContain("-o"); expect(args).toContain("BatchMode=yes");
    expect(args).toContain("ConnectTimeout=5");
  });
});

describe("PUL-04 heartbeat is touched only on success", () => {
  test("a failing run leaves pull.heartbeat absent", async () => {
    const f = await fixture({ failing: true });
    await new Puller(f.config).runOnce();
    await expect(access(f.config.heartbeat)).rejects.toBeDefined();
  });
});

describe("PUL-05 pull-state.json is atomic + 0600", () => {
  test("after one failure it records {failures:1,outage_reported:false} at 0600", async () => {
    const f = await fixture({ failing: true });
    await new Puller(f.config).runOnce();
    const mode = (await stat(f.config.state)).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(JSON.parse(await readFile(f.config.state, "utf8"))).toEqual({ failures: 1, outage_reported: false });
  });
});

describe("PUL-07 loadConfig rejects invalid flags (exit 2 contract)", () => {
  test("--fail-threshold 0 and unknown flag throw", async () => {
    await expect(loadConfig(["--fail-threshold", "0"])).rejects.toThrow(/positive integer/);
    await expect(loadConfig(["--nope"])).rejects.toThrow(/invalid argument/);
  });
});

describe("PUL-08 a hung child is reaped within the time budget", () => {
  test("ssh sleeping 60s is killed by the deadline; run fails well under the wall clock", async () => {
    const f = await fixture({ sshBody: "#!/bin/sh\nsleep 60\n", timeout_ms: 1_500 });
    const started = Date.now();
    const summary = await new Puller(f.config).runOnce();
    const elapsed = Date.now() - started;
    expect(summary.success).toBe(false);
    expect(elapsed).toBeLessThan(6_000); // not the natural 60s lifetime
  }, 15_000);
});
