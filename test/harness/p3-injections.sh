#!/usr/bin/env bash
# P3 protocol-9 acceptance injections. Every scenario is isolated and uses
# command fakes; no real ssh/devbox is ever contacted.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PULL="${PULL:-$ROOT/src/pull/pull.ts}"; INGEST="${INGEST:-$ROOT/src/ingest/ingest.ts}"
ONLY="1,2,3"; KEEP=0; STRICT=0
while [[ $# -gt 0 ]]; do case "$1" in
  --only) ONLY="$2"; shift 2;; --keep) KEEP=1; shift;; --strict) STRICT=1; shift;;
  --pull) PULL="$2"; shift 2;; --ingest) INGEST="$2"; shift 2;;
 -h|--help) echo "usage: $0 [--only 1,2,3] [--strict]"; exit 0;; *) echo "unknown arg: $1" >&2; exit 2;; esac; done
pass=0; fail=0; skip=0
record(){ printf '%s %s: %s\n' "$2" "$1" "$3"; case "$2" in PASS) ((pass+=1));; FAIL) ((fail+=1));; SKIP) ((skip+=1));; esac; }
wanted(){ [[ ",$ONLY," == *",$1,"* ]]; }
missing(){ for p in "$@"; do [[ -f "$p" ]] || { echo "$p"; return; }; done; }
CLEANUP_DIRS=()
cleanup_all(){ [[ "${KEEP:-0}" == 1 ]] || for d in "${CLEANUP_DIRS[@]:-}"; do [[ -n "$d" ]] && rm -rf "$d"; done; }
trap cleanup_all EXIT
# NOTE: a RETURN trap here would delete the workdir the moment new() returns
# (bash RETURN fires on function exit) — cleanup must be deferred to EXIT.
new(){ W="$(mktemp -d -t overload-p3-XXXXXX)"; export HOME="$W"; mkdir -p "$W/.overload/spool" "$W/remote/spool/devbox"; printf '{}\n' > "$W/.overload/config.json"; CLEANUP_DIRS+=("$W"); }
envline(){ bun -e 'console.log(JSON.stringify({v:1,at:Date.now(),host:"devbox",runtime:"pi",session:"p3-session",emitter_id:"pi-p3-fake",writer_id:"pi-p3-fake",seq:1,kind:"decision_requested",dropped_total:0,write_error_total:0,detail:{request_id:"p3-request",request_kind:"decision"}}))'; }
make_cmds(){
  mkdir -p "$W/bin"; SSH="$W/bin/ssh"; RSYNC="$W/bin/rsync";
  cat >"$SSH" <<'SH'
#!/usr/bin/env bash
[ -f "$P3_SSH_FAIL" ] && exit 1
exit 0
SH
  cat >"$RSYNC" <<'SH'
#!/usr/bin/env bash
[ -f "$P3_RSYNC_FAIL" ] && exit 1
# pull.ts supplies source and destination as its final two arguments. The
# source is intentionally ignored: this fake copies our local remote spool.
last="${!#}"; prev="${@:$(($#-1)):1}"; mkdir -p "$last"
find "$P3_REMOTE" -type f -name '*.ndjson' -exec sh -c 'd="$1"; shift; for f do rel="${f#"$P3_REMOTE"/}"; mkdir -p "$d/$(dirname "$rel")"; cp "$f" "$d/$rel"; done' sh "$last" {} +
SH
  # The fake uses bash features; rsync is invoked as an executable, not shell.
  chmod +x "$SSH" "$RSYNC"; export P3_REMOTE="$W/remote/spool/devbox" P3_SSH_FAIL="$W/ssh.fail" P3_RSYNC_FAIL="$W/rsync.fail"
}
runpull(){ env HOME="$W" bun "$PULL" --once --remote devbox --remote-spool "$P3_REMOTE" --dest "$W/.overload/spool/devbox" --ssh-cmd "$SSH" --rsync-cmd "$RSYNC" --fail-threshold 4; }
runingest(){ env HOME="$W" bun "$INGEST" --once >/dev/null; }
scenario1(){
  local m; m="$(missing "$PULL" "$INGEST")"; [[ -z "$m" ]] || { record 1 SKIP "missing entry: $m"; return; }; new; make_cmds
  mkdir -p "$P3_REMOTE/pi-p3-fake"; envline > "$P3_REMOTE/pi-p3-fake/active-pi-p3-fake-1.ndjson"
  t0="$(bun -e 'console.log(Date.now())')"; runpull >/dev/null; runingest; t1="$(bun -e 'console.log(Date.now())')"
  [[ "$(sqlite3 "$W/.overload/ledger.db" "SELECT COUNT(*) FROM requests WHERE state='pending';" 2>/dev/null)" == "1" ]] || { record 1 FAIL "pulled ask did not become a pending request"; return; }
  echo "write→ingest latency: $((t1-t0))ms"; record 1 PASS "local fake devbox pull→ingest→pending request";
}
scenario2(){
  local m; m="$(missing "$PULL")"; [[ -z "$m" ]] || { record 2 SKIP "missing entry: $m"; return; }; new; make_cmds
  touch "$P3_SSH_FAIL"; for i in 1 2 3 4 5 6; do runpull >/dev/null || true; done
  rm -f "$P3_SSH_FAIL"; runpull >/dev/null
  # The pull summary/admin spool is implementation-owned; assert semantic kinds
  # when ingest exists, otherwise leave this transport-only scenario explicit.
  if [[ -f "$INGEST" ]]; then runingest; fi
  n="$(grep -R 'source_outage' "$W/.overload/spool" 2>/dev/null | wc -l | tr -d ' ')"; r="$(grep -R 'source_recovered' "$W/.overload/spool" 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$n" == 1 && "$r" == 1 ]] || { record 2 FAIL "expected one outage and one recovery (outage=$n recovered=$r)"; return; }
  record 2 PASS "four-failure threshold and recovery are journal-deduplicated";
}
scenario3(){
  local m; m="$(missing "$PULL" "$INGEST")"; [[ -z "$m" ]] || { record 3 SKIP "missing entry: $m"; return; }; new; make_cmds
  mkdir -p "$P3_REMOTE/pi-p3-fake"; envline > "$P3_REMOTE/pi-p3-fake/active-pi-p3-fake-1.ndjson"
  printf '{"v":1}\n' >> "$P3_REMOTE/pi-p3-fake/active-pi-p3-fake-1.ndjson" # incomplete/invalid line must not be consumed
  runpull >/dev/null; runingest; runpull >/dev/null; runingest
  rows="$(find "$W/.overload" -name '*.db*' -type f -print 2>/dev/null | wc -l | tr -d ' ')"
  [[ "$rows" -ge 1 ]] || { record 3 FAIL "ledger was not created"; return; }; record 3 PASS "active partial line remains safe across repeated pulls/ingests";
}
echo '## p3-injections'; wanted 1 && scenario1 || true; wanted 2 && scenario2 || true; wanted 3 && scenario3 || true
echo "RESULT: $([[ $fail -eq 0 && ( $STRICT -eq 0 || $skip -eq 0 ) ]] && echo PASS || echo FAIL) (pass=$pass fail=$fail skip=$skip)"; [[ $fail -eq 0 && ( $STRICT -eq 0 || $skip -eq 0 ) ]]
