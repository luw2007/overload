#!/usr/bin/env bash
# test/harness/p2-injections.sh — P2 six-injection acceptance (N8).
#
# The six scenarios from docs/contracts/p2-freeze.md "验收（六注入）":
#   1. synthetic decision_requested without resolve
#        → Q1 shows the request + the initial notification row is sent (file sink)
#   2. kill -9 a fake emitter, run recon
#        → emitter_dead → emitter_drained (grace short/aged) → request
#          orphaned_request + coverage_gaps tail row
#   3. live platform agent with no spool writer (fake herdr snapshot)
#        → telemetry_gap event + Q5 row; repeated passes → NO storm
#   4. platform CLI unreachable (fake herdr rc=1)
#        → exactly one incident row; attached session frozen=1; recovery
#          backfills closed_at and unfreezes; ZERO per-session findings derived
#          from the source while it is out
#   5. kill notifier between the two delivery steps
#        → restart retries the stale attempting row → sent; still exactly ONE
#          initial row (UNIQUE backstop)
#   6. file sink forced to fail ×6
#        → attempt_at deltas follow SINK_BACKOFF_MIN (1/5/15/15/15 min);
#          6th failure → failed_permanent; `overload q1` pins it on top
#
# Isolation: every scenario runs under its OWN mktemp HOME; platform CLIs are
# tiny fake scripts echoing the captured JSON shapes (probe findings §1-§3);
# the ledger/spool/sink all live under the temp dir. Real ~/.overload and real
# herdr/orca/cmux are NEVER touched.
#
# Time control without waiting: recon gets OVERLOAD_DRAIN_GRACE_MS=2000
# exported (honored if the implementation exposes it) AND every grace/stall
# window is satisfied by crafting aged event timestamps (gen-p2-spool
# --age-ms); notifier backoff gates are aged via attempt_at updates.
#
# Pre-merge contract: scenarios whose implementation entries are absent SKIP
# explicitly (P1-matrix style); overall RESULT is PASS unless something FAILed
# (--strict additionally treats SKIPs as failures, for post-merge CI).
#
# Usage:
#   test/harness/p2-injections.sh [--only 1,2,3,4,5,6] [--keep] [--strict]
#                                 [--ingest <path>] [--recon <path>]
#                                 [--notifier <path>] [--cli <path>]
#
# Requires: bun, sqlite3, mktemp. Written for bash 3.2 (no assoc arrays).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

ONLY="1,2,3,4,5,6"
KEEP=0
STRICT=0
INGEST="${REPO_ROOT}/src/ingest/ingest.ts"
RECON="${REPO_ROOT}/src/recon/recon.ts"
NOTIFIER="${REPO_ROOT}/src/notify/notifier.ts"
CLI="${REPO_ROOT}/src/cli/overload.ts"
CLASSIFIER="${REPO_ROOT}/src/ingest/classifier.ts"

usage() {
  cat <<'EOF'
test/harness/p2-injections.sh — P2 six-injection acceptance harness

Runs the six frozen injections under isolated fake HOMEs with fake platform
CLIs. Each scenario prints a PASS/FAIL/SKIP line; final RESULT summarizes.

Usage:
  test/harness/p2-injections.sh [--only 1,2,3,4,5,6] [--keep] [--strict]
                                [--ingest <path>] [--recon <path>]
                                [--notifier <path>] [--cli <path>]

Options:
  --only <list>     Comma-separated subset of scenarios (default all).
  --keep            Keep per-scenario temp dirs (prints their paths).
  --strict          SKIP also counts as failure (post-merge CI mode).
  --ingest/--recon/--notifier/--cli <path>
                    Entry overrides (default the src/ paths). A scenario SKIPs
                    with an explicit line if a required entry is absent.
  --help, -h        Show this help.

Requires: bun, sqlite3, mktemp. Never touches real ~/.overload or platform CLIs.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)     ONLY="$2"; shift 2;;
    --keep)     KEEP=1; shift;;
    --strict)   STRICT=1; shift;;
    --ingest)   INGEST="$2"; shift 2;;
    --recon)    RECON="$2"; shift 2;;
    --notifier) NOTIFIER="$2"; shift 2;;
    --cli)      CLI="$2"; shift 2;;
    --help|-h)  usage; exit 0;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 2;;
  esac
done

for dep in bun sqlite3 mktemp; do
  if ! command -v "$dep" >/dev/null 2>&1; then
    echo "FAIL: missing dependency '$dep'" >&2
    exit 1
  fi
done

# ── bookkeeping ──────────────────────────────────────────────────────────────
RESULTS=()   # lines "N|VERDICT|detail"
KEPT_DIRS=""
PASS_N=0; FAIL_N=0; SKIP_N=0

record() { # <num> <verdict> <detail>
  RESULTS+=("$1|$2|$3")
  if [[ "$2" == "PASS" ]]; then PASS_N=$((PASS_N+1));
  elif [[ "$2" == "FAIL" ]]; then FAIL_N=$((FAIL_N+1));
  else SKIP_N=$((SKIP_N+1)); fi
  printf '%s %s: %s\n' "$2" "$1" "$3"
}

now_ms() { bun -e 'console.log(Date.now())'; }

# entry() — 0 if all listed paths exist; else echo the first missing one.
entry_missing() {
  for p in "$@"; do
    [[ -f "$p" ]] || { echo "$p"; return 0; }
  done
  echo ""
}

# ── shared per-scenario helpers (each scenario sets WORK/STATE/LEDGER) ──────

q() { sqlite3 "$LEDGER" "$1"; }

new_home() { # sets WORK/STATE/SPOOL/LEDGER
  WORK="$(mktemp -d -t overload-p2-s$1-XXXXXX)"
  STATE="$WORK/.overload"
  SPOOL="$STATE"                # gen-p2-spool writes <root>/spool/...
  LEDGER="$STATE/ledger.db"
  KEPT_DIRS="${KEPT_DIRS}${WORK}\n"
  mkdir -p "$STATE"
}

cleanup_work() {
  if [[ "$KEEP" -eq 1 ]]; then
    echo "# kept temp dir: $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}

run_ingest() { # one --once pass against the scenario HOME
  env HOME="$WORK" bun "$INGEST" --once >/dev/null
}

# Fake platform CLIs. herdr is mode-driven: a MODE file present → rc 1.
make_fakes() { # sets FAKE_DIR, HERDR, ORCA, CMUX
  FAKE_DIR="$WORK/fakes"
  mkdir -p "$FAKE_DIR"
  CMUX="$FAKE_DIR/cmux-sessions.json"
  printf '{}\n' > "$CMUX"
  HERDR="$FAKE_DIR/herdr"
  cat > "$HERDR" <<SH
#!/bin/sh
# fake herdr agent list --json (probe findings §1 shape); MODE file = outage
if [ -f "\$FAKE_DIR/herdr.down" ]; then
  echo "fake herdr: unreachable" >&2
  exit 1
fi
cat <<'EOF'
{"result":{"agents":[{"terminal_id":"$HERDR_TID","agent_status":"$HERDR_STATUS","pane_id":"%5","tab_id":"tab-1","workspace_id":"ws-1","cwd":"$HERDR_CWD","revision":1,"state_change_seq":1}]}}
EOF
SH
  chmod +x "$HERDR"
  ORCA="$FAKE_DIR/orca"
  cat > "$ORCA" <<'SH'
#!/bin/sh
# fake orca worktree ps --json (probe findings §2 shape): no worktrees
echo '[]'
SH
  chmod +x "$ORCA"
}

herdr_down() { touch "$FAKE_DIR/herdr.down"; }
herdr_up()   { rm -f "$FAKE_DIR/herdr.down"; }

run_recon() { # one --once pass with fully injected sources; never real CLIs
  env HOME="$WORK" OVERLOAD_DRAIN_GRACE_MS=2000 \
    bun "$RECON" --once \
      --herdr-cmd "$HERDR" \
      --orca-cmd "$ORCA" \
      --cmux-sessions-file "$CMUX" \
      --ledger "$LEDGER" \
      --spool "$STATE/spool" >/dev/null
}

run_notifier() { # <sink-spec>
  env HOME="$WORK" bun "$NOTIFIER" --once --ledger "$LEDGER" --sink "$1" >/dev/null
}

run_cli() { # <subcommand> — echoes stdout
  env HOME="$WORK" OVERLOAD_LEDGER_PATH="$LEDGER" bun "$CLI" "$1" 2>/dev/null
}

# Count admin-spool envelope lines (parsed, robust to whitespace): spool_count <kind> [<detail k=v>...]
spool_count() {
  local args=(--spool "$STATE/spool" --kind "$1" --runtime overload)
  shift
  local kv
  for kv in "$@"; do args+=(--detail "$kv"); done
  bun "${SCRIPT_DIR}/spool-grep.ts" "${args[@]}" | sed -n '1p' \
    | bun -e 'const d = await Bun.stdin.text(); console.log(JSON.parse(d).count)'
}

# Count journal rows: journal_count <kind> [<SQL LIKE pattern for detail>]
journal_count() {
  local pat="${2:-%}"
  q "SELECT COUNT(*) FROM journal WHERE kind='$1' AND detail LIKE '$pat';"
}

gen() { # passthrough to gen-p2-spool with scenario spool
  bun "${SCRIPT_DIR}/gen-p2-spool.ts" --spool "$SPOOL" "$@" >/dev/null
}

# ── SCENARIO 1 — ask unanswered → Q1 + initial sent ─────────────────────────
scenario_1() {
  local missing
  missing="$(entry_missing "$CLASSIFIER" "$NOTIFIER" "$INGEST" "$CLI")"
  if [[ -n "$missing" ]]; then record 1 SKIP "missing entry: $missing"; return; fi

  new_home 1
  local sid="11111111-0000-4000-8000-000000000001"
  local emit="pi-3001-beef0001"
  local sink="$WORK/sink1.out"
  local ok=1

  gen --runtime pi --emitter "$emit" --session "$sid" \
    --events "session_started:pid=3001,proc_boot_id=beef0001,cwd=$WORK/proj1,branch=main,parent=agent@ws1; working; heartbeat; decision_requested:request_id=ask-1,request_kind=decision"
  run_ingest

  local uid="local:pi:${sid}#${emit}#ask-1"
  [[ "$(q "SELECT COUNT(*) FROM requests WHERE request_uid='$uid' AND state='pending';")" == "1" ]] || { record 1 FAIL "request not pending after ingest"; cleanup_work; return; }
  [[ "$(q "SELECT COUNT(*) FROM notifications WHERE request_uid='$uid' AND kind='initial';")" == "1" ]] || { record 1 FAIL "initial notification row missing (same-txn enqueue)"; cleanup_work; return; }

  # Normalize the row's sink to the CLI sink spec (robust to sink-matching
  # implementations; delivery semantics are the assertion target).
  q "UPDATE notifications SET sink='file:$sink' WHERE request_uid='$uid';" >/dev/null
  run_notifier "file:$sink"

  [[ "$(q "SELECT COUNT(*) FROM notifications WHERE request_uid='$uid' AND kind='initial' AND state='sent';")" == "1" ]] || { record 1 FAIL "initial row not sent after notifier pass"; cleanup_work; return; }
  [[ "$(grep -c . "$sink" 2>/dev/null || echo 0)" == "1" ]] || { record 1 FAIL "file sink did not record exactly one line"; cleanup_work; return; }
  grep -q "$uid" "$sink" || { record 1 FAIL "sink line missing request_uid"; cleanup_work; return; }

  local out
  out="$(run_cli q1)" || ok=0
  if [[ "$ok" -ne 1 ]] || ! grep -q "$uid" <<<"$out"; then
    record 1 FAIL "q1 CLI did not list the pending request"
  else
    record 1 PASS "q1 lists pending ask; initial notification row sent via file sink"
  fi
  cleanup_work
}

# ── SCENARIO 2 — kill -9 fake emitter → dead → drained → orphan + gap ───────
scenario_2() {
  local missing
  missing="$(entry_missing "$RECON" "$CLASSIFIER" "$INGEST" "$CLI")"
  if [[ -n "$missing" ]]; then record 2 SKIP "missing entry: $missing"; return; fi

  new_home 2
  local sid="22222222-0000-4000-8000-000000000002"
  # A REAL process whose pid lands in session_started detail (kill-0 target).
  sleep 600 &
  local victim=$!
  local emit="pi-${victim}-cafe0002"
  gen --runtime pi --emitter "$emit" --session "$sid" --age-ms 400000 \
    --events "session_started:pid=${victim},proc_boot_id=cafe0002,cwd=$WORK/proj2,branch=main; working; heartbeat; decision_requested:request_id=ask-2,request_kind=decision"
  run_ingest # consumes to EOF → cursors==size (drain gate input)

  local uid="local:pi:${sid}#${emit}#ask-2"
  [[ "$(q "SELECT COUNT(*) FROM requests WHERE request_uid='$uid' AND state='pending';")" == "1" ]] || { record 2 FAIL "request not pending before kill"; kill -9 "$victim" 2>/dev/null || true; cleanup_work; return; }

  kill -9 "$victim" 2>/dev/null || true
  wait "$victim" 2>/dev/null || true

  make_fakes; HERDR_TID="herdr-none"; HERDR_STATUS="idle"; HERDR_CWD="$WORK/nowhere"

  run_recon
  local drained
  drained="$(spool_count emitter_drained)"
  if [[ "$drained" -lt 1 ]]; then
    # Grace measured from first dead-observation: give the (short) window a
    # moment and take a second pass before failing.
    sleep 2
    run_recon
    drained="$(spool_count emitter_drained)"
  fi
  [[ "$(spool_count emitter_dead)" -ge 1 ]] || { record 2 FAIL "recon never emitted emitter_dead after kill -9"; cleanup_work; return; }
  [[ "$drained" -eq 1 ]] || { record 2 FAIL "expected exactly 1 emitter_drained, got $drained"; cleanup_work; return; }

  run_ingest # journal the findings; reducer applies the drained trigger

  [[ "$(q "SELECT state FROM requests WHERE request_uid='$uid';")" == "orphaned" ]] || { record 2 FAIL "pending request not orphaned on emitter_drained"; cleanup_work; return; }
  local gaps
  gaps="$(q "SELECT COUNT(*) FROM coverage_gaps WHERE emitter_id='$emit' AND to_at IS NOT NULL;")"
  [[ "$gaps" -ge 1 ]] || { record 2 FAIL "coverage_gaps tail row missing"; cleanup_work; return; }
  [[ "$(journal_count emitter_drained)" -eq 1 ]] || { record 2 FAIL "drained storm in journal"; cleanup_work; return; }

  local out
  out="$(run_cli zombie)" || true
  if grep -q "$uid" <<<"$out" && grep -q "orphaned_request" <<<"$out"; then
    record 2 PASS "kill -9 → emitter_dead → drained → orphaned_request + coverage_gaps; zombie groups it"
  else
    record 2 FAIL "zombie CLI missing the orphaned request / reason"
  fi
  cleanup_work
}

# ── SCENARIO 3 — live agent, no spool writer → telemetry_gap, no storm ──────
scenario_3() {
  local missing
  missing="$(entry_missing "$RECON" "$CLASSIFIER" "$INGEST" "$CLI")"
  if [[ -n "$missing" ]]; then record 3 SKIP "missing entry: $missing"; return; fi

  new_home 3
  local sid="33333333-0000-4000-8000-000000000003"
  # claude runtime ⇒ lifecycle liveness domain ⇒ no kill-0 probing; the
  # session is silent (aged beyond the stall profile) with no live writer.
  gen --runtime claude --emitter claude-777-fac30003 --writer "claude-$sid" --session "$sid" --age-ms 3000000 \
    --events "session_started:pid=777,proc_boot_id=fac30003,cwd=$WORK/proj3,branch=main; working"

  make_fakes; HERDR_TID="herdr-gap3"; HERDR_STATUS="working"; HERDR_CWD="$WORK/proj3"
  run_ingest # journal the synthetic session before recon joins its cwd

  run_recon; run_ingest
  local n1
  n1="$(journal_count telemetry_gap '%herdr-gap3%')"
  [[ "$n1" -eq 1 ]] || { record 3 FAIL "expected 1 telemetry_gap after first pass, got $n1"; cleanup_work; return; }

  # Anti-storm: repeated recon passes within the rate-limit window.
  run_recon; run_ingest
  run_recon; run_ingest
  local n3
  n3="$(journal_count telemetry_gap '%herdr-gap3%')"
  [[ "$n3" -eq 1 ]] || { record 3 FAIL "telemetry_gap storm: $n3 events after 3 passes"; cleanup_work; return; }

  local row
  row="$(q "SELECT queue || '/' || q5_reason FROM current WHERE stable_id='local:claude:$sid';")"
  if [[ "$row" == "q5/telemetry_gap" ]]; then
    local out
    out="$(run_cli zombie)" || true
    if grep -q "telemetry_gap" <<<"$out"; then
      record 3 PASS "telemetry_gap once (3 passes), session in Q5/telemetry_gap, zombie groups it"
    else
      record 3 FAIL "zombie CLI missing telemetry_gap group"
    fi
  else
    record 3 FAIL "current not q5/telemetry_gap (got: ${row:-none})"
  fi
  cleanup_work
}

# ── SCENARIO 4 — platform CLI outage → single incident, frozen, recovery ────
scenario_4() {
  local missing
  missing="$(entry_missing "$RECON" "$CLASSIFIER" "$INGEST" "$CLI")"
  if [[ -n "$missing" ]]; then record 4 SKIP "missing entry: $missing"; return; fi

  new_home 4
  local sid="44444444-0000-4000-8000-000000000004"
  gen --runtime claude --emitter claude-888-fac40004 --writer "claude-$sid" --session "$sid" --age-ms 60000 \
    --events "session_started:pid=888,proc_boot_id=fac40004,cwd=$WORK/proj4,branch=main; working"
  make_fakes; HERDR_TID="herdr-t4"; HERDR_STATUS="idle"; HERDR_CWD="$WORK/proj4"
  run_ingest

  # Phase A — attachment: herdr joins the session by cwd.
  run_recon; run_ingest
  local attached
  attached="$(q "SELECT COUNT(*) FROM attachments WHERE stable_id='local:claude:$sid' AND platform='herdr';")"
  [[ "$attached" -ge 1 ]] || { record 4 FAIL "attachment_observed did not bind the session"; cleanup_work; return; }
  local per_session_before
  per_session_before="$(q "SELECT COUNT(*) FROM journal WHERE kind IN ('telemetry_gap','session_vanished','attachment_observed') AND detail LIKE '%herdr%';")"

  # Phase B — outage: fake herdr rc=1.
  herdr_down
  run_recon; run_ingest
  run_recon; run_ingest
  local incidents outages per_session_after frozen
  incidents="$(q "SELECT COUNT(*) FROM incidents WHERE source='herdr';")"
  outages="$(journal_count source_outage '%herdr%')"
  per_session_after="$(q "SELECT COUNT(*) FROM journal WHERE kind IN ('telemetry_gap','session_vanished','attachment_observed') AND detail LIKE '%herdr%';")"
  [[ "$incidents" -eq 1 && "$outages" -eq 1 ]] || { record 4 FAIL "expected single incident/outage event, got incidents=$incidents outages=$outages"; cleanup_work; return; }
  [[ "$(q "SELECT COUNT(*) FROM incidents WHERE source='herdr' AND closed_at IS NULL;")" == "1" ]] || { record 4 FAIL "incident not open during outage"; cleanup_work; return; }
  [[ "$per_session_after" -eq "$per_session_before" ]] || { record 4 FAIL "per-session herdr findings emitted during outage ($per_session_before → $per_session_after)"; cleanup_work; return; }
  frozen="$(q "SELECT frozen FROM current WHERE stable_id='local:claude:$sid';")"
  [[ "$frozen" == "1" ]] || { record 4 FAIL "attached session not frozen during outage (frozen=${frozen:-none})"; cleanup_work; return; }

  # Phase C — recovery.
  herdr_up
  run_recon; run_ingest
  [[ "$(journal_count source_recovered '%herdr%')" -eq 1 ]] || { record 4 FAIL "source_recovered missing after CLI recovery"; cleanup_work; return; }
  [[ "$(q "SELECT COUNT(*) FROM incidents WHERE source='herdr' AND closed_at IS NOT NULL;")" == "1" ]] || { record 4 FAIL "closed_at not backfilled on recovery"; cleanup_work; return; }
  frozen="$(q "SELECT frozen FROM current WHERE stable_id='local:claude:$sid';")"
  [[ "$frozen" == "0" ]] || { record 4 FAIL "session still frozen after recovery (frozen=$frozen)"; cleanup_work; return; }
  [[ "$(journal_count session_vanished '%herdr%')" -eq 0 ]] || { record 4 FAIL "session_vanished must never fire from an out/incomplete source"; cleanup_work; return; }
  record 4 PASS "one incident, zero per-session findings while out, frozen 1→0, closed_at backfilled"
  cleanup_work
}

# ── SCENARIO 5 — kill notifier between the two delivery steps ───────────────
scenario_5() {
  local missing
  missing="$(entry_missing "$NOTIFIER" "$CLASSIFIER" "$INGEST")"
  if [[ -n "$missing" ]]; then record 5 SKIP "missing entry: $missing"; return; fi

  new_home 5
  local sid="55555555-0000-4000-8000-000000000005"
  local emit="pi-5005-beef0005"
  local sink="$WORK/sink5.out"
  gen --runtime pi --emitter "$emit" --session "$sid" \
    --events "session_started:pid=5005,proc_boot_id=beef0005,cwd=$WORK/proj5,branch=main; working; decision_requested:request_id=ask-5,request_kind=decision"
  run_ingest
  local uid="local:pi:${sid}#${emit}#ask-5"
  q "UPDATE notifications SET sink='file:$sink' WHERE request_uid='$uid';" >/dev/null

  # Try a REAL crash between the two steps: a FIFO sink with no reader blocks
  # the notifier after "txn mark attempting". If the notifier does not block
  # (implementation detail), fall back to crafting the exact persisted state
  # of that crash window — semantically identical, fully deterministic.
  local real_kill=0 fifo="$WORK/blocking.fifo" bgpid state
  if command -v mkfifo >/dev/null 2>&1 && mkfifo "$fifo" 2>/dev/null; then
    env HOME="$WORK" bun "$NOTIFIER" --once --ledger "$LEDGER" --sink "file:$fifo" >/dev/null 2>&1 &
    bgpid=$!
    local i
    for i in 1 2 3 4 5 6; do
      sleep 0.5
      state="$(q "SELECT state FROM notifications WHERE request_uid='$uid';")"
      [[ "$state" == "attempting" ]] && break
      kill -0 "$bgpid" 2>/dev/null || break
    done
    if [[ "$state" == "attempting" ]] && kill -0 "$bgpid" 2>/dev/null; then
      kill -9 "$bgpid" 2>/dev/null || true
      wait "$bgpid" 2>/dev/null || true
      real_kill=1
      # Crash evidence: the attempting row survived the kill.
      [[ "$(q "SELECT state FROM notifications WHERE request_uid='$uid';")" == "attempting" ]] \
        || { record 5 FAIL "attempting row did not persist across kill -9"; cleanup_work; return; }
    else
      kill "$bgpid" 2>/dev/null || true
      wait "$bgpid" 2>/dev/null || true
    fi
  fi
  # Normalize to the crash-window state: attempting, older than the retry
  # grace (ATTEMPTING_RETRY_GRACE_MS = 30s), no retries burned.
  local stale=$(( $(now_ms) - 60000 ))
  q "UPDATE notifications SET state='attempting', attempt_at=$stale, retry_count=0 WHERE request_uid='$uid';" >/dev/null

  run_notifier "file:$sink"

  [[ "$(q "SELECT state FROM notifications WHERE request_uid='$uid';")" == "sent" ]] || { record 5 FAIL "stale attempting row not retried to sent"; cleanup_work; return; }
  [[ "$(grep -c . "$sink" 2>/dev/null || echo 0)" == "1" ]] || { record 5 FAIL "sink file missing the retried delivery"; cleanup_work; return; }
  [[ "$(q "SELECT COUNT(*) FROM notifications WHERE request_uid='$uid' AND kind='initial';")" == "1" ]] || { record 5 FAIL "duplicate initial rows after crash+restart"; cleanup_work; return; }
  if [[ "$real_kill" -eq 1 ]]; then
    record 5 PASS "real kill -9 between the two steps → attempting retried to sent, single initial row"
  else
    record 5 PASS "crafted crash-window state (attempting > grace) → retried to sent, single initial row"
  fi
  cleanup_work
}

# ── SCENARIO 6 — file sink forced to fail ×6 → backoff → failed_permanent ───
scenario_6() {
  local missing
  missing="$(entry_missing "$NOTIFIER" "$CLASSIFIER" "$INGEST" "$CLI")"
  if [[ -n "$missing" ]]; then record 6 SKIP "missing entry: $missing"; return; fi

  new_home 6
  local sid="66666666-0000-4000-8000-000000000006"
  local emit="pi-6006-beef0006"
  gen --runtime pi --emitter "$emit" --session "$sid" \
    --events "session_started:pid=6006,proc_boot_id=beef0006,cwd=$WORK/proj6,branch=main; working; decision_requested:request_id=ask-6a,request_kind=decision; decision_requested:request_id=ask-6b,request_kind=decision"
  run_ingest
  local uid_a="local:pi:${sid}#${emit}#ask-6a"
  local uid_b="local:pi:${sid}#${emit}#ask-6b"

  local ro="$WORK/ro"
  mkdir -p "$ro" && chmod 500 "$ro"
  q "UPDATE notifications SET sink='file:$ro/sink.out' WHERE request_uid IN ('$uid_a','$uid_b');" >/dev/null
  # Keep the second request's initial row out of the failing loop; it stays
  # pending as the contrast row for the q1 pinning assertion.
  q "UPDATE notifications SET attempt_at=$(( $(now_ms) + 600000 )) WHERE request_uid='$uid_b';" >/dev/null

  local backoffs=(60000 300000 900000 900000 900000)
  local i t0 t1 att rc_ok=1
  for i in 1 2 3 4 5 6; do
    t0="$(now_ms)"
    run_notifier "file:$ro/sink.out"
    t1="$(now_ms)"
    att="$(q "SELECT attempt_at FROM notifications WHERE request_uid='$uid_a';")"
    if [[ "$i" -le 5 ]]; then
      local b="${backoffs[$((i-1))]}"
      if [[ "$(q "SELECT state FROM notifications WHERE request_uid='$uid_a';")" != "pending" ]] \
         || [[ "$(q "SELECT retry_count FROM notifications WHERE request_uid='$uid_a';")" != "$i" ]] \
         || [[ -z "$att" ]] || [[ "$att" -lt $((t0 + b)) ]] || [[ "$att" -gt $((t1 + b + 2000)) ]]; then
        record 6 FAIL "failure #$i: state/retry_count/attempt_at backoff wrong (attempt_at=${att:-null}, expected window $((t0+b))..$((t1+b)))"
        chmod 700 "$ro"; cleanup_work; return
      fi
      q "UPDATE notifications SET attempt_at=$(( $(now_ms) - 1000 )) WHERE request_uid='$uid_a';" >/dev/null
    else
      if [[ "$(q "SELECT state FROM notifications WHERE request_uid='$uid_a';")" != "failed_permanent" ]]; then
        record 6 FAIL "6th failure did not move the row to failed_permanent"
        chmod 700 "$ro"; cleanup_work; return
      fi
    fi
  done
  chmod 700 "$ro"
  [[ -e "$ro/sink.out" ]] && { record 6 FAIL "failing sink unexpectedly created output"; cleanup_work; return; }

  q "UPDATE notifications SET attempt_at=NULL WHERE request_uid='$uid_b';" >/dev/null
  local out line_a line_b
  out="$(run_cli q1)" || true
  line_a="$(grep -n "$uid_a" <<<"$out" | head -1 | cut -d: -f1)"
  line_b="$(grep -n "$uid_b" <<<"$out" | head -1 | cut -d: -f1)"
  if [[ -n "$line_a" && -n "$line_b" && "$line_a" -lt "$line_b" ]]; then
    record 6 PASS "backoff 1/5/15/15/15min honored; failed_permanent on 6th; q1 pins failed on top"
  else
    record 6 FAIL "q1 pinning wrong (failed line=${line_a:-absent}, pending line=${line_b:-absent})"
  fi
  cleanup_work
}

# ── run ──────────────────────────────────────────────────────────────────────
echo "## p2-injections: six-injection acceptance (freeze table)"
echo "## entries: ingest=$INGEST recon=$RECON notifier=$NOTIFIER cli=$CLI classifier=$CLASSIFIER"
echo

want() { [[ ",$ONLY," == *",$1,"* ]]; }

want 1 && scenario_1 || true
want 2 && scenario_2 || true
want 3 && scenario_3 || true
want 4 && scenario_4 || true
want 5 && scenario_5 || true
want 6 && scenario_6 || true

echo
for row in "${RESULTS[@]}"; do
  IFS='|' read -r n verdict detail <<<"$row"
  printf '%s %s: %s\n' "$verdict" "$n" "$detail"
done

echo
if [[ "$FAIL_N" -eq 0 && ( "$STRICT" -eq 0 || "$SKIP_N" -eq 0 ) ]]; then
  echo "RESULT: PASS (pass=$PASS_N fail=$FAIL_N skip=$SKIP_N)"
  exit 0
else
  echo "RESULT: FAIL (pass=$PASS_N fail=$FAIL_N skip=$SKIP_N)"
  exit 1
fi
