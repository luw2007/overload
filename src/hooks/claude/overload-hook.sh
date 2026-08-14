#!/bin/sh
# Overload telemetry hook for Claude Code. This hook is deliberately fail-open:
# telemetry failures must never interrupt a Claude session.

set +e
umask 077

payload=$(cat 2>/dev/null) || exit 0
command -v jq >/dev/null 2>&1 || exit 0
printf '%s' "$payload" | jq -e 'type == "object"' >/dev/null 2>&1 || exit 0

session=$(printf '%s' "$payload" | jq -r '(.session_id // empty) | strings' 2>/dev/null)
event=$(printf '%s' "$payload" | jq -r '(.hook_event_name // empty) | strings' 2>/dev/null)
[ -n "$session" ] || exit 0
[ -n "$event" ] || exit 0

host_file=${OVERLOAD_HOST_FILE:-"$HOME/.overload/host"}
host=$(head -n 1 "$host_file" 2>/dev/null | tr -d '\r\n')
case "$host" in
  local|devbox) ;;
  *) exit 0 ;;
esac

random_hex() {
  value=$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
  if [ "${#value}" -eq 8 ]; then
    printf '%s' "$value"
  else
    printf '%08x' "$$" 2>/dev/null
  fi
}

new_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen 2>/dev/null | tr '[:upper:]' '[:lower:]'
  else
    hex=$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')
    [ "${#hex}" -eq 32 ] || return 1
    printf '%s-%s-%s-%s-%s\n' \
      "$(printf '%s' "$hex" | cut -c1-8)" \
      "$(printf '%s' "$hex" | cut -c9-12)" \
      "$(printf '%s' "$hex" | cut -c13-16)" \
      "$(printf '%s' "$hex" | cut -c17-20)" \
      "$(printf '%s' "$hex" | cut -c21-32)"
  fi
}

boot8=$(random_hex) || exit 0
[ -n "$boot8" ] || exit 0
emitter_id="claude-$$-$boot8"
writer_id="claude-$session"
spool_root=${OVERLOAD_SPOOL_ROOT:-"$HOME/.overload/spool"}
emitter_dir="$spool_root/$host/$emitter_id"
active="$emitter_dir/active-$emitter_id-1.ndjson"
sealed="$emitter_dir/seg-$emitter_id-1.ndjson"

mkdir -p "$emitter_dir" >/dev/null 2>&1 || exit 0
chmod 700 "$spool_root" "$spool_root/$host" "$emitter_dir" >/dev/null 2>&1 || exit 0
: >"$active" 2>/dev/null || exit 0
chmod 600 "$active" >/dev/null 2>&1 || { rm -f "$active"; exit 0; }

# shellcheck disable=SC2329 # invoked through the EXIT trap below
seal_segment() {
  if [ -f "$active" ]; then
    if [ -s "$active" ]; then
      mv "$active" "$sealed" >/dev/null 2>&1 || rm -f "$active"
      [ ! -f "$sealed" ] || chmod 600 "$sealed" >/dev/null 2>&1
    else
      rm -f "$active"
    fi
  fi
}
trap 'seal_segment' 0
trap 'exit 0' HUP INT TERM

seq=0
write_event() {
  kind=$1
  if [ "$#" -ge 2 ]; then detail=$2; else detail='{}'; fi
  seq=$((seq + 1))
  at=$(($(date +%s 2>/dev/null) * 1000))
  line=$(jq -cn \
    --argjson at "$at" \
    --arg host "$host" \
    --arg session "$session" \
    --arg emitter "$emitter_id" \
    --arg writer "$writer_id" \
    --argjson seq "$seq" \
    --arg kind "$kind" \
    --argjson detail "$detail" \
    '{v:1,at:$at,host:$host,runtime:"claude",session:$session,emitter_id:$emitter,writer_id:$writer,seq:$seq,kind:$kind,dropped_total:0,write_error_total:0,detail:$detail}' \
    2>/dev/null) || return 1
  printf '%s\n' "$line" >>"$active" 2>/dev/null || return 1
  return 0
}

case "$event" in
  SessionStart)
    write_event session_started "$(jq -cn --arg event "$event" '{hook_event_name:$event}')" || exit 0
    ;;
  Stop|SessionEnd|SessionStop)
    write_event session_ended "$(jq -cn --arg event "$event" '{hook_event_name:$event}')" || exit 0
    ;;
  SubagentStop|TaskCompleted)
    write_event settled "$(jq -cn --arg event "$event" '{hook_event_name:$event}')" || exit 0
    ;;
  Notification|UserPromptSubmit|PreToolUse|PostToolUse)
    write_event working "$(jq -cn --arg event "$event" '{hook_event_name:$event}')" || exit 0
    ;;
  PermissionRequest)
    request_id=$(new_uuid) || exit 0
    [ -n "$request_id" ] || exit 0
    tool_name=$(printf '%s' "$payload" | jq -r '(.tool_name // "unknown") | if type == "string" then . else "unknown" end' 2>/dev/null)
    # Summarize structure only: command text and arguments may contain secrets.
    tool_summary=$(printf '%s' "$payload" | jq -c '
      (.tool_input // {}) |
      if type == "object" then {keys:(keys_unsorted[0:10])}
      else {type:(type)} end
    ' 2>/dev/null)
    [ -n "$tool_summary" ] || tool_summary='{}'
    requested=$(jq -cn --arg id "$request_id" --arg tool "$tool_name" --argjson input "$tool_summary" \
      '{request_id:$id,tool_name:$tool,tool_input:$input}') || exit 0
    write_event decision_requested "$requested" || exit 0

    decision=$(printf '%s' "$payload" | jq -r '
      (.permission_decision // .decision // .permission_response.behavior // .hookSpecificOutput.decision.behavior // empty) |
      if type == "string" then ascii_downcase else empty end
    ' 2>/dev/null)
    if [ -z "$decision" ]; then
      timeout_seconds=${OVERLOAD_PERMISSION_TIMEOUT_SECONDS:-30}
      case "$timeout_seconds" in *[!0-9]*|'') timeout_seconds=30 ;; esac
      [ "$timeout_seconds" -eq 0 ] || sleep "$timeout_seconds"
      state=timed_out
    else
      case "$decision" in
        allow|approve|approved|resolved) state=resolved ;;
        deny|denied|cancel|cancelled|canceled) state=cancelled ;;
        timeout|timed_out) state=timed_out ;;
        *) state=resolved ;;
      esac
    fi
    resolved=$(jq -cn --arg id "$request_id" --arg state "$state" '{request_id:$id,state:$state}') || exit 0
    write_event decision_resolved "$resolved" || exit 0
    ;;
  *)
    # Unknown future events are ignored rather than risking Claude execution.
    ;;
esac

exit 0
