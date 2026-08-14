#!/bin/sh
# The ingest loop (owned by N5) must touch this heartbeat; this watchdog only reads it.
set -u

HEARTBEAT=${OVERLOAD_HEARTBEAT:-"${HOME}/.overload/ingest.heartbeat"}
STATE=${OVERLOAD_WATCHDOG_STATE:-"${HOME}/.overload/watchdog.state"}
MAX_AGE=${OVERLOAD_HEARTBEAT_MAX_AGE_SEC:-30}
SLEEP_SKEW=${OVERLOAD_SLEEP_SKEW_SEC:-60}
INGEST_LABEL=${OVERLOAD_INGEST_LABEL:-works.earendil.overload.ingest}

wall_now=$(date +%s) || exit 1
boot_raw=$(sysctl -n kern.boottime 2>/dev/null || printf '')
boot_sec=$(printf '%s\n' "$boot_raw" | awk 'match($0, /sec = [0-9]+/) { value=substr($0, RSTART+6, RLENGTH-6); print value; exit }')
case $boot_sec in ''|*[!0-9]*) boot_sec=0 ;; esac
uptime_now=$((wall_now - boot_sec))

mkdir -p "${HOME}/.overload" 2>/dev/null || :
if [ -r "$STATE" ]; then
  read previous_wall previous_uptime < "$STATE" || :
  case ${previous_wall:-}:${previous_uptime:-} in
    *[!0-9:]*|:|*: ) previous_wall=0; previous_uptime=0 ;;
  esac
  wall_delta=$((wall_now - previous_wall))
  uptime_delta=$((uptime_now - previous_uptime))
  skew=$((wall_delta - uptime_delta))
  [ "$skew" -lt 0 ] && skew=$((-skew))
  if [ "$previous_wall" -gt 0 ] && [ "$boot_sec" -gt 0 ] && [ "$skew" -gt "$SLEEP_SKEW" ]; then
    tmp="${STATE}.tmp.$$"
    printf '%s %s\n' "$wall_now" "$uptime_now" > "$tmp" && mv "$tmp" "$STATE"
    exit 2
  fi
fi
tmp="${STATE}.tmp.$$"
printf '%s %s\n' "$wall_now" "$uptime_now" > "$tmp" && mv "$tmp" "$STATE"

loaded=0
if launchctl list "$INGEST_LABEL" >/dev/null 2>&1; then loaded=1; fi

heartbeat_mtime=0
if [ -e "$HEARTBEAT" ]; then
  heartbeat_mtime=$(stat -f %m "$HEARTBEAT" 2>/dev/null || printf 0)
fi
case $heartbeat_mtime in ''|*[!0-9]*) heartbeat_mtime=0 ;; esac
age=$((wall_now - heartbeat_mtime))
[ "$age" -lt 0 ] && age=0

if [ "$loaded" -eq 1 ] && [ "$heartbeat_mtime" -gt 0 ] && [ "$age" -le "$MAX_AGE" ]; then
  exit 0
fi

if [ "$loaded" -eq 0 ]; then
  message="Overload ingest launchd job is not loaded"
elif [ "$heartbeat_mtime" -eq 0 ]; then
  message="Overload ingest heartbeat is missing"
else
  message="Overload ingest heartbeat is stale (${age}s)"
fi
osascript -e 'on run argv
  display notification (item 1 of argv) with title "Overload watchdog"
end run' "$message" >/dev/null 2>&1 || :
exit 1
