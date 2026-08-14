#!/usr/bin/env bash
# test/harness/matrix-v2p.sh — V-2' behavior matrix runner (N3-TASK #5).
#
# For each of pi / omp / prime (the V-2' runtimes from §4-P1):
#   - SKIP gracefully with an explicit SKIP row if the binary is absent.
#   - Load the extension via the runtime's extension flag (-e/--extension) with a
#     trivial -p prompt.
#   - Assert a spool file appears with a valid envelope (frozen contract).
#   - Record which SDK event names fired (V-2' event-name-set compatibility).
# Output: a markdown matrix to stdout (PASS / SKIP / FAIL per runtime).
#
# Extension selection:
#   --extension <path>   Force an extension to load (default: src/extension/
#                        overload.ts if it exists, else the bundled V-2' probe
#                        at test/harness/overload-probe.ts which instruments the
#                        event API surface and writes a contract-valid envelope).
#
# The probe is used so the matrix is runnable TODAY; when N1's overload.ts lands,
# the same runner exercises the real extension with no changes.
#
# Usage:
#   test/harness/matrix-v2p.sh [--extension <path>] [--prompt <text>] [--keep]
#                              [--only pi,omp,prime] [--timeout 90]
#
# Requires: bun, jq, mktemp, timeout. Never touches real ~/.overload.
# Written for bash 3.2 compatibility (no associative arrays).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PROMPT="Reply with exactly one word: ok"
KEEP=0
TIMEOUT=90
ONLY="pi,omp,prime"
EXTENSION=""

usage() {
  cat <<'EOF'
test/harness/matrix-v2p.sh — V-2' behavior matrix runner

For each runtime in pi/omp/prime: load the extension via -e, run a trivial -p
prompt, assert a contract-valid spool envelope appears, and record which SDK
event names fired. Outputs a markdown matrix to stdout.

Usage:
  test/harness/matrix-v2p.sh [--extension <path>] [--prompt <t>] [--keep]
                             [--only pi,omp,prime] [--timeout 90]

Options:
  --extension <path>  Extension to load (default: src/extension/overload.ts if it
                      exists, else test/harness/overload-probe.ts).
  --prompt <text>     Trivial prompt for the -p run (default: "Reply with one word: ok").
  --only <list>       Comma-separated subset of pi,omp,prime (default: all three).
  --timeout <sec>     Per-runtime timeout (default 90).
  --keep              Keep temp dirs and print their paths.
  --help, -h          Show this help.

A runtime with no installed binary yields an explicit SKIP row.
Requires: bun, jq, mktemp, timeout. Never touches real ~/.overload.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --extension) EXTENSION="$2"; shift 2;;
    --prompt)    PROMPT="$2"; shift 2;;
    --only)      ONLY="$2"; shift 2;;
    --timeout)   TIMEOUT="$2"; shift 2;;
    --keep)      KEEP=1; shift;;
    --help|-h)   usage; exit 0;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2;;
  esac
done

for dep in bun jq mktemp timeout; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "FAIL: missing dependency '$dep'" >&2
    exit 1
  fi
done

# Resolve extension.
if [[ -z "$EXTENSION" ]]; then
  if [[ -f "${REPO_ROOT}/src/extension/overload.ts" ]]; then
    EXTENSION="${REPO_ROOT}/src/extension/overload.ts"
  else
    EXTENSION="${SCRIPT_DIR}/overload-probe.ts"
  fi
fi
if [[ ! -f "$EXTENSION" ]]; then
  echo "FAIL: extension not found: $EXTENSION" >&2
  exit 1
fi

# Binary name for a V-2' runtime (prime ships as `prime-agent`).
get_bin() {
  case "$1" in
    pi)    echo "pi" ;;
    omp)   echo "omp" ;;
    prime) echo "prime-agent" ;;
    *)     echo "" ;;
  esac
}

# Run one runtime against the extension. Echoes machine-readable key=value lines
# (parsed by the caller). Runs inside a command substitution subshell, so its
# exports do not leak between runtimes.
run_runtime() {
  rt="$1"; bin="$2"
  work="$(mktemp -d -t overload-matrix-${rt}-XXXXXX)"
  probe_log="$work/probe.log"
  out="$work/stdout"; err="$work/stderr"

  # Env knobs consumed by overload-probe.ts (a real N1 extension manages its own
  # spool under ~/.overload; the probe writes to $OVERLOAD_SPOOL_ROOT instead).
  export OVERLOAD_SPOOL_ROOT="$work"
  export OVERLOAD_PROBE_LOG="$probe_log"
  export OVERLOAD_RUNTIME="$rt"
  export OVERLOAD_HOST="local"
  export OVERLOAD_SESSION="${rt}-matrix-0000"
  export OVERLOAD_EMITTER="${rt}-0-matrix000000"

  # All three runtimes accept: -e <ext> (load), -p <prompt> (print & exit),
  # --no-session (ephemeral). Context-file flags differ, so we use the common
  # subset only (V-2' flag compatibility).
  set +e
  timeout "$TIMEOUT" "$bin" -e "$EXTENSION" --no-session -p "$PROMPT" >"$out" 2>"$err"
  rc=$?
  set -e

  # Which SDK event names fired.
  events_fired=""
  if [[ -f "$probe_log" ]]; then
    events_fired="$(sort -u "$probe_log" | paste -sd, -)"
  fi

  # Validate every spool envelope against the frozen contract. Note the
  # validator prints its JSON summary even when it exits 1 (invalid found), so
  # we capture stdout and only fall back when empty (never append).
  set +e
  val_json="$( bun "${SCRIPT_DIR}/validate-envelope.ts" --spool "$work" 2>/dev/null )"
  set -e
  if [[ -z "$val_json" ]]; then val_json='{"valid":0,"invalid":0,"lines":0}'; fi
  val_json="$(printf '%s\n' "$val_json" | head -1)"
  val_valid="$(echo "$val_json" | jq -r '.valid // 0')"
  val_invalid="$(echo "$val_json" | jq -r '.invalid // 0')"
  envelope_ok="no"
  if [[ "$val_valid" -gt 0 && "$val_invalid" -eq 0 ]]; then envelope_ok="yes"; fi

  echo "RT_WORK=$work"
  echo "RT_RC=$rc"
  echo "RT_EVENTS=$events_fired"
  echo "RT_ENVELOPE=$envelope_ok"
  echo "RT_ENVLINES=${val_valid}valid/${val_invalid}invalid"
}

# Decide PASS/SKIP/FAIL per runtime and build the rows (plain indexed array).
ROWS=()
ALL_WORKS=""

for rt in $(echo "$ONLY" | tr ',' ' '); do
  bin="$(get_bin "$rt")"
  if [[ -z "$bin" ]] || ! command -v "$bin" >/dev/null 2>&1; then
    ROWS+=("$rt|SKIP|binary-absent (${bin:-unknown runtime})|n/a|n/a")
    continue
  fi

  run_out="$(run_runtime "$rt" "$bin")"

  rc=""; events=""; envok="no"; envlines="0valid/0invalid"; workdir=""
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then continue; fi
    case "$line" in
      RT_WORK=*)     workdir="${line#RT_WORK=}";;
      RT_RC=*)       rc="${line#RT_RC=}";;
      RT_EVENTS=*)   events="${line#RT_EVENTS=}";;
      RT_ENVELOPE=*) envok="${line#RT_ENVELOPE=}";;
      RT_ENVLINES=*) envlines="${line#RT_ENVLINES=}";;
    esac
  done <<<"$run_out"

  if [[ -n "$workdir" ]]; then
    ALL_WORKS="${ALL_WORKS}${workdir}
"
  fi

  verdict="FAIL"
  detail="no-events rc=${rc:-?}"
  if [[ "$envok" == "yes" ]]; then
    verdict="PASS"
    detail="events=${events:-none}"
  elif [[ -n "$events" ]]; then
    detail="events-fired-but-envelope-invalid (rc=${rc:-?})"
  fi
  ROWS+=("$rt|$verdict|$detail|$envok|$envlines")
done

# Emit the markdown matrix.
echo
echo "## V-2' behavior matrix"
echo
echo "Extension: \`$EXTENSION\`"
echo
echo "| runtime | result | detail | spool valid | envelopes |"
echo "|---|---|---|---|---|"
overall=0
for row in "${ROWS[@]}"; do
  rt="${row%%|*}"; rest="${row#*|}"
  verdict="${rest%%|*}"; rest="${rest#*|}"
  detail="${rest%%|*}"; rest="${rest#*|}"
  envok="${rest%%|*}"; envlines="${rest#*|}"
  printf "| %s | %s | %s | %s | %s |\n" "$rt" "$verdict" "$detail" "$envok" "$envlines"
  if [[ "$verdict" != "PASS" && "$verdict" != "SKIP" ]]; then overall=1; fi
done
echo
echo "_A row is PASS when the extension loads, the runtime fires lifecycle events,"
echo "and a contract-valid envelope appears in the spool. SKIP = binary absent._"
echo

if [[ "$KEEP" -eq 1 ]]; then
  echo "## kept temp dirs:"
  if [[ -n "$ALL_WORKS" ]]; then
    printf '%s' "$ALL_WORKS" | while IFS= read -r d; do
      if [[ -n "$d" ]]; then echo "  $d"; fi
    done
  fi
else
  if [[ -n "$ALL_WORKS" ]]; then
    printf '%s' "$ALL_WORKS" | while IFS= read -r d; do
      if [[ -n "$d" ]]; then rm -rf "$d"; fi
    done
  fi
fi

exit $overall
