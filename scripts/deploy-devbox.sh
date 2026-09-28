#!/bin/sh
# Usage: scripts/deploy-devbox.sh [--dry-run]
# Prepares a remote host: installs the Overload extension for pi and omp and
# writes its host_id. Prime is intentionally not deployed; load it manually
# with prime's -e option after reviewing the extension path.
#
# Target host defaults to "devbox". Override with OVERLOAD_REMOTE (ssh host)
# and OVERLOAD_HOST_ID (value written to ~/.overload/host); HOST_ID defaults
# to OVERLOAD_REMOTE.
set -eu

DRY_RUN=0
case "${1-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac
[ "$#" -le 1 ] || { echo "usage: $0 [--dry-run]" >&2; exit 2; }

REMOTE=${OVERLOAD_REMOTE:-devbox}
HOST_ID=${OVERLOAD_HOST_ID:-$REMOTE}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SOURCE="${ROOT}/src/extension/overload.ts"
[ -f "$SOURCE" ] || { echo "missing extension: $SOURCE" >&2; exit 1; }

run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '+ '
    printf "'%s' " "$@"
    printf '\n'
  else
    "$@"
  fi
}

run ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE" \
  'umask 077; mkdir -p "$HOME/.pi/agent/extensions" "$HOME/.omp/agent/extensions" "$HOME/.overload"; chmod 700 "$HOME/.pi/agent/extensions" "$HOME/.omp/agent/extensions" "$HOME/.overload"'
run scp -q "$SOURCE" "$REMOTE:.pi/agent/extensions/overload.ts"
run scp -q "$SOURCE" "$REMOTE:.omp/agent/extensions/overload.ts"
run ssh -o BatchMode=yes -o ConnectTimeout=5 "$REMOTE" \
  'umask 077; printf "%s\n" '"$HOST_ID"' > "$HOME/.overload/host"; chmod 600 "$HOME/.overload/host" "$HOME/.pi/agent/extensions/overload.ts" "$HOME/.omp/agent/extensions/overload.ts"'

if [ "$DRY_RUN" -eq 1 ]; then
  echo "$REMOTE extension preparation complete (dry-run)"
else
  echo "$REMOTE extension preparation complete"
fi
