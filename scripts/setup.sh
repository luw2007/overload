#!/bin/sh
# One-shot convenience installer. Composes the existing per-component
# installers; does not duplicate their logic.
set -eu

usage() {
  cat <<'EOF'
Usage: setup.sh [--actor NAME] [--dry-run]

Runs, in order:
  1. install-launchd.sh --install    (ingest, maintenance, pull, web)
  2. install-extension.sh --install  (pi, omp lifecycle telemetry)

--actor NAME (or OVERLOAD_ACTOR in the environment) is the operator identity the web dashboard
decides under; install-launchd.sh requires it. See docs/guides/macos-deployment-runbook.md.

Run `bun src/cli/overload.ts doctor` afterward to confirm the services are healthy.
EOF
}

dry_run=0
actor=${OVERLOAD_ACTOR:-}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1 ;;
    --actor)
      shift
      [ "$#" -gt 0 ] || { usage >&2; exit 2; }
      actor=$1
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
install_flag=--install
[ "$dry_run" -eq 1 ] && install_flag=--dry-run

OVERLOAD_ACTOR=$actor "$root/scripts/install-launchd.sh" "$install_flag"
"$root/scripts/install-extension.sh" "$install_flag"

[ "$dry_run" -eq 1 ] || printf '\nSetup complete. Verify with:\n  bun %s/src/cli/overload.ts doctor\n' "$root"
