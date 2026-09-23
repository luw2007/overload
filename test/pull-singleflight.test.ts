/**
 * test/pull-singleflight.test.ts — single-flight contract for `pull --once`.
 *
 * underSingleFlight (src/pull/pull.ts): when flock(1) is unavailable (true on
 * this macOS host, verified via `which flock`), it falls back to a mkdir-based
 * lockdir (`<lock>.d`). The holder proceeds through execute(); a concurrent
 * second caller whose mkdir hits EEXIST must return 0 immediately WITHOUT
 * running the pull pipeline (no rsync, no transfer).
 *
 * tmp isolation: lockdir, dest, state, ledger, admin spool and fake ssh/rsync
 * scripts all live under mkdtemp; nothing touches ~/.overload.
 */
import { afterAll, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { underSingleFlight, type PullConfig } from "../src/pull/pull";

const tmpRoot = mkdtempSync(join(tmpdir(), "overload-pul-sf-"));
const lock = join(tmpRoot, "pull.lock");
const lockdir = `${lock}.d`;
const dest = join(tmpRoot, "dest");
const rsyncLog = join(tmpRoot, "rsync-invocations.log");

// Fake ssh: hold the "transfer" for 6s so the first caller keeps the lock
// while the second caller races in.
const fakeSsh = join(tmpRoot, "fake-ssh.sh");
writeFileSync(fakeSsh, `#!/bin/sh\nsleep 6\nexit 0\n`);
chmodSync(fakeSsh, 0o700);
// Fake rsync: append a marker line once per real invocation (proves the
// second caller never reaches the pipeline).
const fakeRsync = join(tmpRoot, "fake-rsync.sh");
writeFileSync(fakeRsync, `#!/bin/sh\necho invocated >> "${rsyncLog}"\nexit 0\n`);
chmodSync(fakeRsync, 0o700);

const config: PullConfig = {
  remote: "local",
  remote_spool: join(tmpRoot, "remote-spool"),
  dest,
  ssh_cmd: fakeSsh,
  rsync_cmd: fakeRsync,
  fail_threshold: 4,
  timeout_ms: 20_000,
  ledger: join(tmpRoot, "ledger.db"),
  admin_spool: join(tmpRoot, "admin"),
  heartbeat: join(tmpRoot, "pull.heartbeat"),
  state: join(tmpRoot, "pull-state.json"),
  lock,
};

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

// This host has no flock(1); the mkdir-EEXIST fallback path is what we exercise.
// On a host with flock(1) the re-exec path is taken and this scenario does not
// apply, so skip rather than assert the wrong branch.
test.skipIf(Bun.which("flock"))("PUL-06: concurrent second call hits mkdir EEXIST, returns 0 without pulling", async () => {
  // First call acquires the lockdir and enters execute() (fake ssh sleeps 6s).
  const p1 = underSingleFlight(config, []);
  await Bun.sleep(500);
  expect(existsSync(lockdir)).toBe(true);

  // Second call races in while p1 holds the lock: mkdir → EEXIST → rc 0 fast.
  const start = Date.now();
  const rc2 = await underSingleFlight(config, []);
  const waited = Date.now() - start;
  expect(rc2).toBe(0);
  expect(waited).toBeLessThan(2_000);

  // The lock is still held by p1, proving p2 did not execute pull.
  expect(existsSync(lockdir)).toBe(true);

  const rc1 = await p1;
  expect(rc1).toBe(0);
  // Holder cleaned up the fallback lockdir.
  expect(existsSync(lockdir)).toBe(false);

  // rsync ran exactly once — only inside the first caller.
  const invocations = readFileSync(rsyncLog, "utf8").trim().split("\n").filter(Boolean).length;
  expect(invocations).toBe(1);

  // No segment/active files transferred into dest.
  expect(readdirSync(dest).some((f) => /^(seg|active)-/.test(f))).toBe(false);
}, 30_000);
