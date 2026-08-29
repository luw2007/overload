#!/bin/sh
# launchd combines the two interval jobs in one process: recon first, watchdog second.
# Failures remain visible through exit status, logs, and the web dashboard.
set -u
ROOT=${OVERLOAD_ROOT:-"${HOME}/ai/overload"}
BUN=${OVERLOAD_BUN:-"${HOME}/.bun/bin/bun"}

recon_status=0
if [ -f "${ROOT}/src/recon/recon.ts" ]; then
  "$BUN" "${ROOT}/src/recon/recon.ts" --once || recon_status=$?
fi
# P5 recall nudge: best-effort, never fails the maintenance job.
"$BUN" "${ROOT}/src/notify/nudge.ts" || true
"${ROOT}/scripts/watchdog.sh"
watchdog_status=$?
[ "$watchdog_status" -ne 0 ] && exit "$watchdog_status"
exit "$recon_status"
