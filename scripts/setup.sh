#!/bin/sh
# One-shot convenience installer. Composes the existing per-component
# installers; does not duplicate their logic.
set -eu

usage() {
  cat <<'EOF'
Usage: setup.sh [--dry-run]

Runs, in order:
  1. install-launchd.sh --install    (ingest, notifier, maintenance, pull, web)
  2. install-extension.sh --install  (pi, omp lifecycle telemetry)
  3. install-claude-hooks.sh         (best-effort; skipped without jq)

Run `bun src/cli/overload.ts doctor` afterward to confirm everything is healthy.
EOF
}

dry_run=0
case "${1-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { usage >&2; exit 2; }

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
install_flag=--install
[ "$dry_run" -eq 1 ] && install_flag=--dry-run

"$root/scripts/install-launchd.sh" "$install_flag"
"$root/scripts/install-extension.sh" "$install_flag"

if [ "$dry_run" -eq 1 ]; then
  printf 'would run: install-claude-hooks.sh (best-effort; skipped without jq)\n'
elif command -v jq >/dev/null 2>&1; then
  "$root/scripts/install-claude-hooks.sh" || printf 'Claude Code hooks: install-claude-hooks.sh failed; run it manually if you use Claude Code\n' >&2
else
  printf 'Claude Code hooks: skipped (jq not found)\n'
fi

[ "$dry_run" -eq 1 ] || printf '\nSetup complete. Verify with:\n  bun %s/src/cli/overload.ts doctor\n' "$root"
