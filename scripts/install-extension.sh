#!/bin/sh
# Install or remove the Overload extension for local pi/omp runtimes so they
# emit session-lifecycle telemetry to the spool.
set -eu
umask 077

usage() {
  cat <<'EOF'
Usage: install-extension.sh [--install|--uninstall] [--dry-run]

Installs (or removes) src/extension/overload.ts as
~/.pi/agent/extensions/overload.ts and ~/.omp/agent/extensions/overload.ts.
Restart pi/omp after installing for the extension to load. Prime is
intentionally excluded: its extension-directory convention is unverified
(see docs/integrations.md).
EOF
}

mode=install
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install) mode=install ;;
    --uninstall) mode=uninstall ;;
    --dry-run) dry_run=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
source_file="$root/src/extension/overload.ts"
[ -f "$source_file" ] || { printf 'missing extension: %s\n' "$source_file" >&2; exit 1; }

targets="$HOME/.pi/agent/extensions/overload.ts $HOME/.omp/agent/extensions/overload.ts"

if [ "$dry_run" -eq 1 ]; then
  for target in $targets; do printf '%s %s\n' "$mode" "$target"; done
  exit 0
fi

if [ "$mode" = install ]; then
  for target in $targets; do
    dir=$(dirname -- "$target")
    mkdir -p "$dir"
    chmod 700 "$dir"
    cp "$source_file" "$target"
    chmod 600 "$target"
  done
  printf 'installed Overload extension for pi and omp (restart each runtime to load it)\n'
else
  for target in $targets; do rm -f "$target"; done
  printf 'removed Overload extension for pi and omp\n'
fi
