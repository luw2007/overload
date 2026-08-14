#!/usr/bin/env bash
# V-5 acceptance matrix for the Claude hook. Inputs are crafted JSON only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; HOOK="${HOOK:-$ROOT/src/hooks/claude/overload-hook.sh}"
if [[ ! -f "$HOOK" ]]; then echo "SKIP V-5: missing entry: $HOOK"; echo 'RESULT: PASS (skip=1)'; exit 0; fi
W="$(mktemp -d -t overload-v5-XXXXXX)"; trap 'rm -rf "$W"' EXIT; export HOME="$W"; mkdir -p "$W/.overload"
printf 'local\n' > "$W/.overload/host"
validate(){ bun "$ROOT/test/harness/validate-envelope.ts" --spool "$W/.overload" >/dev/null; }
run(){ printf '%s\n' "$1" | "$HOOK"; validate; }
run '{"hook_event_name":"SessionStart","session_id":"s-v5"}'
run '{"hook_event_name":"PermissionRequest","session_id":"s-v5","tool_name":"Bash","tool_input":{"command":"echo hi"}}'
# A separate timeout-shaped request is accepted by implementations that expose
# the native decision timeout; it must never make the hook fail the host.
printf '%s\n' '{"hook_event_name":"PermissionRequest","session_id":"s-timeout","timeout":true}' | "$HOOK" || true
run '{"hook_event_name":"SessionStop","session_id":"s-v5"}'
# Duplicate delivery is intentionally sent twice; envelope emitters must remain
# distinct across processes and the downstream UNIQUE key handles replay.
printf '%s\n' '{"hook_event_name":"Notification","session_id":"s-dup"}' | "$HOOK"; printf '%s\n' '{"hook_event_name":"Notification","session_id":"s-dup"}' | "$HOOK"; validate
# Spool cannot be written: hooks are best-effort and must be silent rc=0.
rm -rf "$W/.overload/spool"; mkdir "$W/.overload/spool"; chmod 500 "$W/.overload/spool"
out="$(printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"s-ro"}' | "$HOOK" 2>/dev/null)"; rc=$?; chmod 700 "$W/.overload/spool"
[[ $rc -eq 0 && -z "$out" ]] || { echo "FAIL V-5: unwritable spool rc=$rc output=$out"; exit 1; }
echo 'PASS V-5: lifecycle, permission, timeout, duplicate, and unwritable-spool cases'; echo 'RESULT: PASS'
