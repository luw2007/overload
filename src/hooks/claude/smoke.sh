#!/bin/sh
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' cd -- "$HERE/../../.." && pwd)
HOOK="$HERE/overload-hook.sh"
INSTALLER="$ROOT/scripts/install-claude-hooks.sh"
TMP=${TMPDIR:-/tmp}/overload-claude-smoke-$$
trap 'rm -rf "$TMP"' EXIT HUP INT TERM
mkdir -p "$TMP/home/.overload" "$TMP/config"
printf 'devbox\n' >"$TMP/home/.overload/host"
chmod 700 "$TMP/home/.overload"
chmod 600 "$TMP/home/.overload/host"

run_hook() {
  payload=$1
  parent=${2-}
  printf '%s\n' "$payload" | HOME="$TMP/home" OVERLOAD_PARENT="$parent" OVERLOAD_PERMISSION_TIMEOUT_SECONDS=0 "$HOOK"
}

run_hook '{"hook_event_name":"SessionStart","session_id":"session-smoke"}'
run_hook '{"hook_event_name":"SessionStart","session_id":"session-path-parent","transcript_path":"/Users/test/.claude/projects/example/0b198322-1234-4abc-8def-1234567890ab/subagents/agent-worker.jsonl"}' 'env:must-not-win'
run_hook '{"hook_event_name":"SessionStart","session_id":"session-env-parent","transcript_path":"/Users/test/.claude/projects/example/session.jsonl"}' 'orca:parent-worktree'
long_parent=$(printf '%0201d' 0)
run_hook '{"hook_event_name":"SessionStart","session_id":"session-truncated-parent"}' "$long_parent"
run_hook '{"hook_event_name":"SessionStart","session_id":"session-no-parent"}'
run_hook '{"hook_event_name":"SessionStart","session_id":"session-malformed-parent","transcript_path":"/Users/test/.claude/projects/example/0b198322-1234-4abc-8def-1234567890ab /subagents/agent bad.jsonl"}'
run_hook '{"hook_event_name":"Notification","session_id":"session-smoke"}'
run_hook '{"hook_event_name":"SubagentStop","session_id":"session-smoke"}'
run_hook '{"hook_event_name":"Stop","session_id":"session-smoke"}'
run_hook '{"hook_event_name":"PermissionRequest","session_id":"session-response","tool_name":"Bash","tool_input":{"command":"printf hello"},"permission_decision":"allow"}'
run_hook '{"hook_event_name":"PermissionRequest","session_id":"session-timeout","tool_name":"Write","tool_input":{"file_path":"/tmp/example"}}'
# Duplicate delivery must remain valid and independently correlated.
run_hook '{"hook_event_name":"PermissionRequest","session_id":"session-response","tool_name":"Bash","tool_input":{"command":"printf hello"},"permission_decision":"deny"}'

bun "$ROOT/test/harness/validate-envelope.ts" --spool "$TMP/home/.overload"

files=$(find "$TMP/home/.overload/spool" -type f -name 'seg-*.ndjson' | wc -l | tr -d ' ')
[ "$files" -eq 12 ]
[ "$(find "$TMP/home/.overload/spool" -type f -name 'active-*.ndjson' | wc -l | tr -d ' ')" -eq 0 ]

# Generated spool paths contain only the fixed emitter alphabet.
# shellcheck disable=SC2046
jq -s '
  ([.[] | select(.kind == "decision_requested")] | length) == 3 and
  ([.[] | select(.kind == "decision_resolved")] | length) == 2 and
  ([.[] | select(.session == "session-path-parent" and .detail.parent == "devbox:claude:0b198322-1234-4abc-8def-1234567890ab")] | length) == 1 and
  ([.[] | select(.session == "session-env-parent" and .detail.parent == "orca:parent-worktree")] | length) == 1 and
  ([.[] | select(.session == "session-truncated-parent" and (.detail.parent | length) == 200)] | length) == 1 and
  ([.[] | select(.session == "session-no-parent" and (.detail | has("parent")))] | length) == 0 and
  ([.[] | select(.session == "session-malformed-parent" and (.detail | has("parent")))] | length) == 0 and
  (group_by(.emitter_id) | all(
    if ([.[] | select(.kind == "decision_requested")] | length) == 1
    then ([.[].detail.request_id] | unique | length) == 1
    else true end
  ))
' $(find "$TMP/home/.overload/spool" -type f -name 'seg-*.ndjson') | grep -qx true

# An unusable spool must never produce output or a failing hook status.
: >"$TMP/not-a-directory"
out=$(printf '%s\n' '{"hook_event_name":"SessionStart","session_id":"silent"}' |
  HOME="$TMP/home" OVERLOAD_SPOOL_ROOT="$TMP/not-a-directory" "$HOOK")
[ -z "$out" ]

# Installer preserves unrelated settings, backs up, installs once, and uninstalls only itself.
settings="$TMP/config/settings.json"
printf '%s\n' '{"theme":"dark","hooks":{"SessionStart":[{"matcher":"keep","hooks":[{"type":"command","command":"keep-me"}]}]}}' >"$settings"
"$INSTALLER" --settings "$settings"
[ -f "$settings.bak" ]
jq -e '.theme == "dark" and (.hooks.SessionStart | map(.hooks[]?.command) | index("keep-me") != null)' "$settings" >/dev/null
first=$(jq -cS . "$settings")
"$INSTALLER" --settings "$settings"
[ "$first" = "$(jq -cS . "$settings")" ]
"$INSTALLER" --uninstall --settings "$settings"
jq -e '.theme == "dark" and (.hooks.SessionStart | length) == 1 and .hooks.SessionStart[0].hooks[0].command == "keep-me" and (.hooks.PermissionRequest // [] | length) == 0' "$settings" >/dev/null

printf 'claude hook smoke: ok (%s sealed files)\n' "$files"
