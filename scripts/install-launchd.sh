#!/bin/sh
# Install or remove Overload's supported macOS LaunchAgents.
set -eu

usage() {
  cat <<'EOF'
Usage: scripts/install-launchd.sh [--install|--uninstall] [--project-dir PATH] [--dry-run]

Installs or removes the supported Overload LaunchAgents for the current user.
Island is intentionally excluded because it is not release-ready.
EOF
}

mode=install
project_dir=
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) mode=install ;;
    --uninstall) mode=uninstall ;;
    --project-dir)
      shift
      [ "$#" -gt 0 ] || { usage >&2; exit 2; }
      project_dir=$1
      ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
if [ -z "$project_dir" ]; then project_dir=$(CDPATH='' cd -- "$script_dir/.." && pwd -P)
else project_dir=$(CDPATH='' cd -- "$project_dir" && pwd -P) || { printf 'project directory does not exist: %s\n' "$project_dir" >&2; exit 2; }
fi

[ -f "$project_dir/src/ingest/ingest.ts" ] || { printf 'not an Overload checkout: %s\n' "$project_dir" >&2; exit 2; }
[ -f "$project_dir/scripts/maintenance.sh" ] || { printf 'not an Overload checkout: %s\n' "$project_dir" >&2; exit 2; }
command -v launchctl >/dev/null 2>&1 || { printf 'launchctl is required (macOS only)\n' >&2; exit 1; }
bun_path=$(command -v bun) || { printf 'bun is required; install it before running this script\n' >&2; exit 1; }
bun_path=$(CDPATH='' cd -- "$(dirname -- "$bun_path")" && pwd -P)/$(basename -- "$bun_path")

agents_dir=$HOME/Library/LaunchAgents
labels='ingest notifier maintenance pull web'
uid=$(id -u)
xml_escape() {
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g; s/'"'"'/\&apos;/g'
}

write_plist() {
  name=$1
  target=$agents_dir/works.earendil.overload.$name.plist
  case "$name" in
    ingest) arguments="<string>$(xml_escape "$bun_path")</string><string>$(xml_escape "$project_dir/src/ingest/ingest.ts")</string>"; schedule='<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' ;;
    notifier) arguments="<string>$(xml_escape "$bun_path")</string><string>$(xml_escape "$project_dir/src/notify/notifier.ts")</string><string>--sink</string><string>osascript</string>"; schedule='<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' ;;
    maintenance) arguments="<string>$(xml_escape "$project_dir/scripts/maintenance.sh")</string>"; schedule='<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>' ;;
    pull) arguments="<string>$(xml_escape "$bun_path")</string><string>$(xml_escape "$project_dir/src/pull/pull.ts")</string><string>--once</string>"; schedule='<key>RunAtLoad</key><true/><key>StartInterval</key><integer>60</integer>' ;;
    web) arguments="<string>$(xml_escape "$bun_path")</string><string>$(xml_escape "$project_dir/src/web/server.ts")</string>"; schedule='<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>' ;;
  esac
  cat >"$target" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>works.earendil.overload.$name</string>
  <key>ProgramArguments</key><array>$arguments</array>
  <key>EnvironmentVariables</key><dict><key>OVERLOAD_ROOT</key><string>$(xml_escape "$project_dir")</string><key>OVERLOAD_BUN</key><string>$(xml_escape "$bun_path")</string></dict>
  $schedule
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/tmp/overload-$name.log</string>
  <key>StandardErrorPath</key><string>/tmp/overload-$name.err</string>
</dict></plist>
EOF
  plutil -lint "$target" >/dev/null
}

if [ "$dry_run" -eq 1 ]; then
  for name in $labels; do printf '%s %s %s\n' "$mode" "works.earendil.overload.$name" "$agents_dir/works.earendil.overload.$name.plist"; done
  exit 0
fi

mkdir -p "$agents_dir"
if [ "$mode" = install ]; then
  for name in $labels; do
    target=$agents_dir/works.earendil.overload.$name.plist
    launchctl bootout "gui/$uid" "$target" >/dev/null 2>&1 || true
    write_plist "$name"
    launchctl bootstrap "gui/$uid" "$target"
  done
  printf 'Installed Overload LaunchAgents from %s\n' "$project_dir"
else
  for name in $labels; do
    target=$agents_dir/works.earendil.overload.$name.plist
    launchctl bootout "gui/$uid" "$target" >/dev/null 2>&1 || true
    rm -f "$target"
  done
  printf 'Removed Overload LaunchAgents\n'
fi
