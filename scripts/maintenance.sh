#!/bin/sh
# launchd combines the two interval jobs in one process: recon first, watchdog second.
# A recon failure must not suppress the independent heartbeat alarm.
set -u
ROOT=${OVERLOAD_ROOT:-"${HOME}/ai/overload"}
BUN=${OVERLOAD_BUN:-"${HOME}/.bun/bin/bun"}

recon_status=0
if [ -f "${ROOT}/src/recon/recon.ts" ]; then
  "$BUN" "${ROOT}/src/recon/recon.ts" --once || {
    recon_status=$?
    # review P2 m6: surface recon failure without suppressing watchdog.
    osascript -e 'display notification "Overload recon failed; review maintenance logs" with title "Overload"' >/dev/null 2>&1 || true
  }
fi
"${ROOT}/scripts/watchdog.sh"
watchdog_status=$?
[ "$watchdog_status" -ne 0 ] && exit "$watchdog_status"
exit "$recon_status"
