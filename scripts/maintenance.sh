#!/bin/sh
# launchd combines the two interval jobs in one process: recon first, watchdog second.
# A recon failure must not suppress the independent heartbeat alarm.
set -u
ROOT=${OVERLOAD_ROOT:-"${HOME}/ai/overload"}
BUN=${OVERLOAD_BUN:-"${HOME}/.bun/bin/bun"}

recon_status=0
if [ -f "${ROOT}/src/recon/recon.ts" ]; then
  "$BUN" "${ROOT}/src/recon/recon.ts" --once || recon_status=$?
fi
"${ROOT}/scripts/watchdog.sh"
watchdog_status=$?
[ "$watchdog_status" -ne 0 ] && exit "$watchdog_status"
exit "$recon_status"
