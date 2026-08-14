#!/bin/sh
# Install or remove Overload's Claude Code hooks without replacing user config.
set -eu
umask 077

usage() {
  cat <<'EOF'
Usage: install-claude-hooks.sh [--settings <path>] [--uninstall]

Merges Overload command hooks into Claude Code settings. Existing settings and
hooks are preserved. The first install/update in each invocation writes
<settings>.bak before replacing the settings file atomically.
EOF
}

settings=${HOME:?HOME must be set}/.claude/settings.json
uninstall=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --settings)
      [ "$#" -ge 2 ] || { usage >&2; exit 2; }
      settings=$2
      shift 2
      ;;
    --uninstall)
      uninstall=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v jq >/dev/null 2>&1 || { printf 'jq is required\n' >&2; exit 1; }
script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
root=$(CDPATH='' cd -- "$script_dir/.." && pwd)
hook="$root/src/hooks/claude/overload-hook.sh"
[ "$uninstall" -eq 1 ] || [ -x "$hook" ] || { printf 'hook is not executable: %s\n' "$hook" >&2; exit 1; }

settings_dir=$(dirname -- "$settings")
mkdir -p "$settings_dir"
chmod 700 "$settings_dir" 2>/dev/null || true
if [ -f "$settings" ]; then
  jq -e 'type == "object"' "$settings" >/dev/null || { printf 'invalid settings JSON: %s\n' "$settings" >&2; exit 1; }
  source=$settings
else
  source=$(mktemp "${TMPDIR:-/tmp}/overload-claude-settings.XXXXXX")
  printf '{}\n' >"$source"
fi

tmp=$(mktemp "$settings_dir/.settings.overload.XXXXXX")
cleanup() {
  rm -f "$tmp"
  [ "$source" = "$settings" ] || rm -f "$source"
}
trap cleanup EXIT HUP INT TERM

# The marker is intentionally embedded in the command so uninstall removes only
# entries owned by this installer, leaving every unrelated matcher untouched.
marker='OVERLOAD_CLAUDE_HOOK=1'
command="$marker \"$hook\""

if [ "$uninstall" -eq 1 ]; then
  jq --arg marker "$marker" '
    .hooks = ((.hooks // {}) | with_entries(
      .value = ((.value // []) | map(
        .hooks = ((.hooks // []) | map(select(((.command // "") | contains($marker)) | not))) |
        select((.hooks | length) > 0)
      )) |
      select((.value | length) > 0)
    )) |
    if (.hooks | length) == 0 then del(.hooks) else . end
  ' "$source" >"$tmp"
else
  jq --arg command "$command" '
    def owned: any(.hooks[]?; ((.command // "") | contains("OVERLOAD_CLAUDE_HOOK=1")));
    def addhook($event; $matcher):
      .hooks = (.hooks // {}) |
      .hooks[$event] = (.hooks[$event] // []) |
      if any(.hooks[$event][]?; owned) then .
      else .hooks[$event] += [{matcher:$matcher,hooks:[{type:"command",command:$command,timeout:35}]}] end;
    addhook("SessionStart"; "") |
    addhook("Stop"; "") |
    addhook("SubagentStop"; "") |
    addhook("Notification"; "") |
    addhook("PermissionRequest"; "*")
  ' "$source" >"$tmp"
fi

chmod 600 "$tmp"
if [ -f "$settings" ] && cmp -s "$settings" "$tmp"; then
  exit 0
fi
if [ -f "$settings" ]; then
  cp -p "$settings" "$settings.bak"
  chmod 600 "$settings.bak" 2>/dev/null || true
fi
mv "$tmp" "$settings"
chmod 600 "$settings"
printf '%s Overload Claude hooks in %s\n' "$([ "$uninstall" -eq 1 ] && printf removed || printf installed)" "$settings"
