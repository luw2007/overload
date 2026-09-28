#!/bin/sh
# launchd combines the interval jobs in one process: bounded recon, then the
# bounded condition-wait observer, then notification projection and watchdog.
# Recon and observer failures are recorded, never allowed to stop nudge or
# watchdog; the combined exit status keeps every failure visible.
set -u
ROOT=${OVERLOAD_ROOT:-"${HOME}/ai/overload"}
BUN=${OVERLOAD_BUN:-"${HOME}/.bun/bin/bun"}
# Each stage's total budget reserves its final second for TERM grace, then
# sweeps the process group with KILL before the next stage runs.
RECON_TIMEOUT_MS=${OVERLOAD_RECON_TIMEOUT_MS:-45000}
case "$RECON_TIMEOUT_MS" in
  ''|*[!0-9]*|0) echo "invalid OVERLOAD_RECON_TIMEOUT_MS: $RECON_TIMEOUT_MS" >&2; exit 2 ;;
esac
# The observer's wall clock from spawn to reaping its whole group is <=5s.
OBSERVER_TIMEOUT_MS=${OVERLOAD_OBSERVER_TIMEOUT_MS:-5000}
case "$OBSERVER_TIMEOUT_MS" in
  ''|*[!0-9]*|0) echo "invalid OVERLOAD_OBSERVER_TIMEOUT_MS: $OBSERVER_TIMEOUT_MS" >&2; exit 2 ;;
esac
if [ "$OBSERVER_TIMEOUT_MS" -gt 5000 ]; then
  echo "invalid OVERLOAD_OBSERVER_TIMEOUT_MS: $OBSERVER_TIMEOUT_MS" >&2; exit 2
fi

# Darwin has no /usr/bin/timeout. Run a stage in its own process group so a
# deadline can terminate descendants too; escalate after one second so an
# uncooperative child cannot survive into the next stage. With sweep=1, a
# group that outlives its leader is terminated as well, within the same total.
# Usage: bun -e "$GROUP_RUNNER" <label> <timeout-ms> <sweep:0|1> <argv...>
GROUP_RUNNER='
const [label, timeoutText, sweepText, ...argv] = process.argv.slice(1);
const timeoutMs = Number(timeoutText);
const proc = Bun.spawn(argv, {
  stdin: "ignore", stdout: "inherit", stderr: "inherit", detached: true,
});
let timedOut = false;
let killed = false;
let finishEscalation = () => {};
const escalationDone = new Promise((resolve) => { finishEscalation = resolve; });
const graceMs = Math.min(1000, timeoutMs);
const killGroup = async (signal) => {
  const killer = Bun.spawn(["/bin/kill", `-${signal}`, "--", `-${proc.pid}`], {
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  if (await killer.exited !== 0) {
    try { proc.kill(signal === "TERM" ? "SIGTERM" : "SIGKILL"); } catch {}
  }
};
const groupAlive = () => Bun.spawnSync(["/bin/kill", "-0", "--", `-${proc.pid}`], {
  stdin: "ignore", stdout: "ignore", stderr: "ignore",
}).exitCode === 0;
const finalDeadline = setTimeout(() => {
  killed = true;
  void killGroup("KILL").then(finishEscalation);
}, timeoutMs);
const termDeadline = setTimeout(() => {
  timedOut = true;
  console.error(`${label} timed out after ${timeoutMs}ms`);
  void killGroup("TERM");
}, timeoutMs - graceMs);
let stopping = false;
for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(termDeadline);
    clearTimeout(finalDeadline);
    void killGroup("TERM").then(async () => {
      await Promise.race([proc.exited, Bun.sleep(1000)]);
      if (proc.exitCode === null) await killGroup("KILL");
      await proc.exited;
      process.exit(exitCode);
    });
  });
}
const status = await proc.exited;
clearTimeout(termDeadline);
if (!timedOut && sweepText === "1" && groupAlive()) {
  console.error(`${label} left descendants; terminating its process group`);
  await killGroup("TERM");
  while (!killed && groupAlive()) await Bun.sleep(50);
}
if (timedOut || killed) await escalationDone;
else clearTimeout(finalDeadline);
process.exit(timedOut ? 124 : status);
'

recon_status=0
if [ -f "${ROOT}/src/recon/recon.ts" ]; then
  "$BUN" -e "$GROUP_RUNNER" recon "$RECON_TIMEOUT_MS" 0 \
    "$BUN" "${ROOT}/src/recon/recon.ts" --once || recon_status=$?
fi
# Phase B condition waits: one bounded round; its status never blocks nudge.
# §14.1 default-off: unless OVERLOAD_CONDITION_WAITS=1 the CLI prints
# {"status":"disabled"} and exits 0 without opening any database.
observer_status=0
if [ -f "${ROOT}/src/waits/cli.ts" ]; then
  "$BUN" -e "$GROUP_RUNNER" "wait observer" "$OBSERVER_TIMEOUT_MS" 1 \
    "$BUN" run "${ROOT}/src/waits/cli.ts" observe --once || observer_status=$?
fi
# P5 recall nudge: best-effort, never fails the maintenance job.
"$BUN" "${ROOT}/src/notify/nudge.ts" || true
"${ROOT}/scripts/watchdog.sh"
watchdog_status=$?
[ "$watchdog_status" -ne 0 ] && exit "$watchdog_status"
[ "$recon_status" -ne 0 ] && exit "$recon_status"
exit "$observer_status"
