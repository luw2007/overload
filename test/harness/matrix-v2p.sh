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
# HOME contract (fixed after owner verification on the merged tree):
# the REAL extension (src/extension/overload.ts) writes to ~/.overload/spool
# resolved from HOME. Each runtime is therefore invoked with HOME=<temp dir>
# (binaries resolve via PATH, so path resolution is unaffected) and the spool is
# asserted under <temp>/.overload/spool. The bundled V-2' probe extension
# (test/harness/overload-probe.ts) instead writes to $OVERLOAD_SPOOL_ROOT — that
# env var is exported ONLY in probe mode.
#
# Event recording: probe mode logs exact SDK event names (probe.log); real-
# extension mode derives the fired lifecycle events from the emitted envelope
# kinds (session_started/working/settled/session_ended...).
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
prompt under a fake HOME, assert a contract-valid spool envelope appears, and
record which lifecycle events fired. Outputs a markdown matrix to stdout.

Usage:
  test/harness/matrix-v2p.sh [--extension <path>] [--prompt <t>] [--keep]
                             [--only pi,omp,prime] [--timeout 90]

Options:
  --extension <path>  Extension to load (default: src/extension/overload.ts if it
                      exists, else test/harness/overload-probe.ts).
                      The real extension is invoked with HOME=<temp dir> and its
                      spool asserted under <temp>/.overload/spool; the probe uses
                      OVERLOAD_SPOOL_ROOT (probe mode only).
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

# Resolve extension (absolute) and decide real-vs-probe mode.
if [[ -z "$EXTENSION" ]]; then
  if [[ -f "${REPO_ROOT}/src/extension/overload.ts" ]]; then
    EXTENSION="${REPO_ROOT}/src/extension/overload.ts"
  else
    EXTENSION="${SCRIPT_DIR}/overload-probe.ts"
  fi
else
  case "$EXTENSION" in
    /*) ;;
    *)  EXTENSION="${REPO_ROOT}/${EXTENSION}";;
  esac
fi
if [[ ! -f "$EXTENSION" ]]; then
  echo "FAIL: extension not found: $EXTENSION" >&2
  exit 1
fi

N1_EXT="${REPO_ROOT}/src/extension/overload.ts"
if [[ "$EXTENSION" == "$N1_EXT" ]]; then
  REAL_EXT=1   # real extension: spool under $HOME/.overload/spool
else
  REAL_EXT=0   # probe: spool under $OVERLOAD_SPOOL_ROOT
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
# (parsed by the caller). Runs inside a command-substitution subshell, so its
# exports do not leak between runtimes.
run_runtime() {
  rt="$1"; bin="$2"
  work="$(mktemp -d -t overload-matrix-${rt}-XXXXXX)"
  probe_log="$work/probe.log"
  out="$work/stdout"; err="$work/stderr"

  # Probe-mode env knobs (a real extension resolves ~/.overload from HOME and
  # ignores these).
  if [[ "$REAL_EXT" -eq 0 ]]; then
    export OVERLOAD_SPOOL_ROOT="$work"
    export OVERLOAD_PROBE_LOG="$probe_log"
    export OVERLOAD_RUNTIME="$rt"
    export OVERLOAD_HOST="local"
    export OVERLOAD_SESSION="${rt}-matrix-0000"
    export OVERLOAD_EMITTER="${rt}-0-matrix000000"
  else
    # Real extension must resolve exclusively from HOME; do not let ambient
    # probe variables mask a broken ~/.overload path.
    unset OVERLOAD_SPOOL_ROOT OVERLOAD_PROBE_LOG OVERLOAD_RUNTIME OVERLOAD_HOST OVERLOAD_SESSION OVERLOAD_EMITTER
  fi

  # Invoke the runtime under a fake HOME so the real extension resolves
  # ~/.overload -> <work>/.overload. Binaries come from PATH (unaffected by
  # HOME). --no-extensions keeps ambient discovery out; explicit -e still loads.
  real_home="${HOME:-/tmp}"
  HOME="$work"; export HOME
  set +e
  timeout "$TIMEOUT" "$bin" --no-extensions -e "$EXTENSION" --no-session -p "$PROMPT" >"$out" 2>"$err"
  rc=$?
  set -e
  HOME="$real_home"; export HOME

  # Locate the spool to validate: real extension -> <work>/.overload/spool;
  # probe -> <work>/spool. If the expected tree has no ndjson, fall back to the
  # other location (covers forced --extension entries that resolve HOME).
  if [[ "$REAL_EXT" -eq 1 ]]; then
    spool_parent="$work/.overload"
  else
    spool_parent="$work"
  fi
  # Real mode is strict: only $work/.overload/spool is accepted. For a forced
  # non-default extension, prefer probe layout but recognize HOME-resolving
  # behavior too (useful for compatibility probes).
  if [[ "$REAL_EXT" -eq 0 ]]; then
    if ! find "$spool_parent/spool" -name '*.ndjson' -type f 2>/dev/null | head -n 1 | grep -q .; then
      if find "$work/.overload/spool" -name '*.ndjson' -type f 2>/dev/null | head -n 1 | grep -q .; then
        spool_parent="$work/.overload"
      else
        spool_parent="$work"
      fi
    fi
  fi
  case "$spool_parent" in
    "$work/.overload") spool_rel=".overload/spool";;
    *)                 spool_rel="spool";;
  esac

  # Record which lifecycle events fired.
  events_fired=""
  event_src=""
  if [[ -f "$probe_log" ]] && [[ -s "$probe_log" ]]; then
    # Probe mode: exact SDK event names.
    events_fired="$(sort -u "$probe_log" | paste -sd, -)"
    event_src="sdk-events"
  fi
  if [[ -z "$events_fired" ]]; then
    # Real-extension mode: derive from emitted envelope kinds. Empty/missing
    # spool is a matrix FAIL later, not a shell-abort under pipefail.
    set +e
    events_fired="$(find "$spool_parent/spool" -name '*.ndjson' -type f -exec cat {} + 2>/dev/null \
                    | grep -oE '"kind": ?"[a-z_]+"' \
                    | sed -e 's/"kind": *//' -e 's/"//g' \
                    | sort -u | paste -sd, -)"
    set -e
    event_src="kinds"
  fi

  # Validate every spool envelope against the frozen contract. The validator
  # prints its JSON summary even when it exits 1 (invalid found), so we capture
  # stdout and only fall back when empty (never append).
  set +e
  val_json="$( bun "${SCRIPT_DIR}/validate-envelope.ts" --spool "$spool_parent" 2>/dev/null )"
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
  echo "RT_EVENTSRC=$event_src"
  echo "RT_ENVELOPE=$envelope_ok"
  echo "RT_ENVLINES=${val_valid}valid/${val_invalid}invalid"
  echo "RT_SPOOL=$spool_rel"
}

# Decide PASS/SKIP/FAIL per runtime and build the rows (plain indexed array).
ROWS=()
ALL_WORKS=""

for rt in $(echo "$ONLY" | tr ',' ' '); do
  bin="$(get_bin "$rt")"
  if [[ -z "$bin" ]] || ! command -v "$bin" >/dev/null 2>&1; then
    ROWS+=("$rt|SKIP|binary-absent (${bin:-unknown runtime})|n/a|n/a|n/a")
    continue
  fi

  run_out="$(run_runtime "$rt" "$bin")"

  rc=""; events=""; eventsrc=""; envok="no"; envlines="0valid/0invalid"; spoolrel=""; workdir=""
  while IFS= read -r line; do
    if [[ -z "$line" ]]; then continue; fi
    case "$line" in
      RT_WORK=*)     workdir="${line#RT_WORK=}";;
      RT_RC=*)       rc="${line#RT_RC=}";;
      RT_EVENTS=*)   events="${line#RT_EVENTS=}";;
      RT_EVENTSRC=*) eventsrc="${line#RT_EVENTSRC=}";;
      RT_ENVELOPE=*) envok="${line#RT_ENVELOPE=}";;
      RT_ENVLINES=*) envlines="${line#RT_ENVLINES=}";;
      RT_SPOOL=*)    spoolrel="${line#RT_SPOOL=}";;
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
    detail="${eventsrc:-events}=${events:-none}"
  elif [[ -n "$events" ]]; then
    detail="events-fired-but-envelope-invalid (rc=${rc:-?})"
  fi
  ROWS+=("$rt|$verdict|$detail|$envok|$envlines|$spoolrel")
done

# Emit the markdown matrix.
echo
echo "## V-2' behavior matrix"
echo
echo "Extension: \`$EXTENSION\` (mode: $(if [[ "$REAL_EXT" -eq 1 ]]; then echo real; else echo probe; fi), HOME-isolated)"
echo
echo "| runtime | result | detail | spool valid | envelopes | spool root |"
echo "|---|---|---|---|---|---|"
overall=0
for row in "${ROWS[@]}"; do
  rt="${row%%|*}"; rest="${row#*|}"
  verdict="${rest%%|*}"; rest="${rest#*|}"
  detail="${rest%%|*}"; rest="${rest#*|}"
  envok="${rest%%|*}"; rest="${rest#*|}"
  envlines="${rest%%|*}"; spoolrel="${rest#*|}"
  printf "| %s | %s | %s | %s | %s | %s |\n" "$rt" "$verdict" "$detail" "$envok" "$envlines" "$spoolrel"
  if [[ "$verdict" != "PASS" && "$verdict" != "SKIP" ]]; then overall=1; fi
done
echo
echo "_A row is PASS when the extension loads under the fake HOME, the runtime"
echo "fires lifecycle events, and a contract-valid envelope appears in the spool"
echo "(real extension: \$HOME/.overload/spool; probe: \$OVERLOAD_SPOOL_ROOT)."
echo "SKIP = binary absent._"
echo

if [[ "$KEEP" -eq 1 ]]; then
  echo "## kept temp dirs (fake HOMEs):"
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
