#!/usr/bin/env bash
# test/harness/crash-injection.sh — P1 crash-injection acceptance (N3-TASK #4).
#
# Two scenarios, both over a temp spool root (never real ~/.overload):
#
#   A. kill -9 the ingest MID-BATCH, restart, assert NO LOSS / NO DUP.
#      (transaction atomicity per §2.1: one txn = journal inserts + cursor
#       advance; crash either commits a file fully or not at all.)
#
#   B. kill -9 a fake emitter MID-ACTIVE-FILE; assert its COMPLETE lines remain
#      ingestable (dead-emitter tail reachable, §2.1 — active file is in the
#      transport set; a partial trailing line is left for a later pass).
#
# Idempotency/dedup is provided by the journal UNIQUE(host, emitter_id, seq).
#
# Usage:
#   test/harness/crash-injection.sh [--ingest <path>] [--count <n>] [--keep]
#
#   --ingest <path>  Ingest entry (default: src/ingest/ingest.ts if present,
#                    else test/harness/ingest-once.ts which uses the N3
#                    reference ingest).
#   --count <n>      Synthetic spool size (default 5000).
#   --keep           Keep the temp dir for inspection (print its path).
#
# Requires: bun, sqlite3, mktemp. Exits 0 on PASS, 1 on FAIL, 2 on usage error.
set -euo pipefail

COUNT=5000
KEEP=0
INGEST_ENTRY=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat <<'EOF'
test/harness/crash-injection.sh — P1 crash-injection acceptance

Runs two crash-injection scenarios against a temp spool + ledger:
  A. kill -9 ingest mid-batch, restart  → no loss / no dup (txn atomicity)
  B. kill -9 emitter mid-active-file    → complete lines still ingestable

Usage:
  test/harness/crash-injection.sh [--ingest <path>] [--count <n>] [--keep]

Options:
  --ingest <path>  Ingest entry to drive (default: src/ingest/ingest.ts if it
                   exists, else the bundled N3 reference at test/harness/ingest-once.ts).
  --count <n>      Number of synthetic events (default 5000).
  --keep           Keep the temp dir and print its path.
  --help, -h       Show this help.

Requires: bun, sqlite3, mktemp. Never touches real ~/.overload.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ingest) INGEST_ENTRY="$2"; shift 2;;
    --count)  COUNT="$2"; shift 2;;
    --keep)   KEEP=1; shift;;
    --help|-h) usage; exit 0;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2;;
  esac
done

for dep in bun sqlite3 mktemp; do
  command -v "$dep" >/dev/null 2>&1 || { echo "FAIL: missing dependency '$dep'" >&2; exit 1; }
done

# Resolve ingest entry.
if [[ -z "$INGEST_ENTRY" ]]; then
  if [[ -f "${REPO_ROOT}/src/ingest/ingest.ts" ]]; then
    INGEST_ENTRY="${REPO_ROOT}/src/ingest/ingest.ts"
  else
    INGEST_ENTRY="${SCRIPT_DIR}/ingest-once.ts"
  fi
fi
[[ -f "$INGEST_ENTRY" ]] || { echo "FAIL: ingest entry not found: $INGEST_ENTRY" >&2; exit 1; }

# The ingest-once adapter accepts --spool/--ledger/--entry. N2's real ingest.ts
# is driven via that same adapter (it forwards --once --spool --ledger).
INGEST_RUN=( bun "${SCRIPT_DIR}/ingest-once.ts" --entry "$INGEST_ENTRY" )

WORK="$(mktemp -d -t overload-crash-XXXXXX)"
SPOOL="$WORK"
LEDGER="$WORK/ledger.db"
EMITTER_A="pi-1000-aaaaaaaa"
EMITTER_B="pi-2000-bbbbbbbb"

cleanup() {
  if [[ "$KEEP" -eq 1 ]]; then
    echo "# kept temp dir: $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

q() { sqlite3 "$LEDGER" "$1"; }
jq_count() { jq -r '.insertedRows // empty' 2>/dev/null || echo "ERR"; }

echo "## crash-injection: ingest entry = $INGEST_ENTRY"
echo "## temp dir = $WORK"
echo

# ----------------------------------------------------------------------------
# Scenario A: kill -9 ingest mid-batch, restart → no loss / no dup.
# ----------------------------------------------------------------------------
echo "### A. kill -9 ingest mid-batch, restart (no loss/no dup)"
# Generate a large spool (segment > a single txn batch so a crash is realistic).
bun "${SCRIPT_DIR}/gen-spool.ts" --spool "$SPOOL" --emitter "$EMITTER_A" --count "$COUNT" >/dev/null

# Start ingest in the background and kill -9 it as soon as it has begun. Because
# the reference ingest commits per-file atomically, the kill may land before any
# commit or after the file's commit — either way the DB is consistent.
( "${INGEST_RUN[@]}" --spool "$SPOOL" --ledger "$LEDGER" >/dev/null 2>&1 ) &
PID=$!
# Give it a moment to start, then SIGKILL. If it already finished, the kill is a
# no-op (reaping still fine).
sleep 0.05 || true
if kill -0 "$PID" 2>/dev/null; then
  kill -9 "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  echo "# killed ingest (pid $PID) mid-batch"
else
  echo "# ingest finished before kill (small/fast batch) — restart path still exercised"
fi

# Restart ingest to completion (may run 1+ times; dedup guarantees stability).
RES=$( "${INGEST_RUN[@]}" --spool "$SPOOL" --ledger "$LEDGER" )
ROWS_A=$(q "SELECT COUNT(*) FROM journal WHERE emitter_id='$EMITTER_A';")
echo "# journal rows after restart: $ROWS_A (expected $COUNT)"
echo "# ingest summary: $RES"

A_PASS=1
if [[ "$ROWS_A" -ne "$COUNT" ]]; then
  echo "FAIL A: expected $COUNT rows, got $ROWS_A"; A_PASS=0
fi

# Idempotency: a 3rd pass inserts nothing.
RES3=$( "${INGEST_RUN[@]}" --spool "$SPOOL" --ledger "$LEDGER" )
ROWS_A2=$(q "SELECT COUNT(*) FROM journal WHERE emitter_id='$EMITTER_A';")
if [[ "$ROWS_A2" -ne "$COUNT" ]]; then
  echo "FAIL A (idempotency): 3rd pass changed row count to $ROWS_A2"; A_PASS=0
fi
echo "# idempotent 3rd pass: rows still $ROWS_A2"

# ----------------------------------------------------------------------------
# Scenario B: kill -9 emitter mid-active-file; complete lines still ingestable.
# ----------------------------------------------------------------------------
echo
echo "### B. kill -9 emitter mid-active-file (dead-emitter tail reachable)"
# The emitter wrote M complete lines then was killed mid-write of line M+1
# (which appears as a partial trailing line — no newline). Ingest must consume
# the M complete lines (the dead emitter's tail is NOT stranded — §2.1).
EMIT_COMPLETE=200
bun "${SCRIPT_DIR}/gen-spool.ts" --spool "$SPOOL" --emitter "$EMITTER_B" \
    --count "$EMIT_COMPLETE" --partial >/dev/null
# Simulate the emitter being SIGKILLed (no process to kill; the partial line in
# the file is the evidence of the interrupted write).
echo "# emitter $EMITTER_B killed mid-line; $EMIT_COMPLETE complete + 1 partial"

RES_B=$( "${INGEST_RUN[@]}" --spool "$SPOOL" --ledger "$LEDGER" )
ROWS_B=$(q "SELECT COUNT(*) FROM journal WHERE emitter_id='$EMITTER_B';")
echo "# journal rows for dead emitter: $ROWS_B (expected $EMIT_COMPLETE; partial excluded)"
echo "# ingest summary: $RES_B"

B_PASS=1
if [[ "$ROWS_B" -ne "$EMIT_COMPLETE" ]]; then
  echo "FAIL B: expected $EMIT_COMPLETE complete lines ingested, got $ROWS_B"; B_PASS=0
fi

# Cursor for this active file must point at the end of the last COMPLETE line,
# i.e. strictly before EOF (the partial bytes remain unconsumed).
FILE_B="active-${EMITTER_B}-1.ndjson"
CUR_BYTES=$(q "SELECT bytes FROM cursors WHERE file_name='$FILE_B';")
FILE_SIZE=$(wc -c < "$SPOOL/spool/local/$EMITTER_B/$FILE_B" | tr -d ' ')
if [[ -z "$CUR_BYTES" || -z "$FILE_SIZE" ]]; then
  echo "FAIL B: cursor/file size missing (cursor=$CUR_BYTES size=$FILE_SIZE)"; B_PASS=0
elif [[ "$CUR_BYTES" -ge "$FILE_SIZE" ]]; then
  echo "FAIL B: cursor ($CUR_BYTES) consumed partial bytes (size=$FILE_SIZE)"; B_PASS=0
else
  echo "# cursor at $CUR_BYTES / $FILE_SIZE bytes (partial trailing line correctly excluded)"
fi

echo
if [[ "$A_PASS" -eq 1 && "$B_PASS" -eq 1 ]]; then
  echo "RESULT: PASS (A=$A_PASS B=$B_PASS)"
  exit 0
else
  echo "RESULT: FAIL (A=$A_PASS B=$B_PASS)"
  exit 1
fi
