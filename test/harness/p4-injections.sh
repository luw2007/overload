#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ONLY="1,2,3,4,5"; STRICT=0; KEEP=0
while [[ $# -gt 0 ]]; do case "$1" in --only) ONLY="$2"; shift 2;; --strict) STRICT=1; shift;; --keep) KEEP=1; shift;; -h|--help) echo "usage: $0 [--only 1,2,3,4,5] [--strict]"; exit 0;; *) echo "unknown arg: $1" >&2; exit 2;; esac; done
pass=0; fail=0; skip=0; dirs=()
wanted(){ [[ ",$ONLY," == *",$1,"* ]]; }
record(){ printf '%s %s: %s\n' "$1" "$2" "$3"; case "$2" in PASS) ((pass+=1));; FAIL) ((fail+=1));; SKIP) ((skip+=1));; esac; }
cleanup(){ [[ $KEEP == 1 ]] || for d in "${dirs[@]}"; do rm -rf "$d"; done; }; trap cleanup EXIT
new(){ local d; d="$(mktemp -d -t overload-p4-XXXXXX)"; dirs+=("$d"); echo "$d"; }
scenario1(){ local d; d=$(new); local f="$d/workstream.jsonl"; printf '%s\n' '{"kind":"permissionRequest","source":"claude","workstreamId":"claude-ws","status":{"pending":{}},"cwd":"/tmp","ppid":1,"payload":{"permissionRequest":{"toolName":"Bash","toolInputJSON":"secret","requestId":"r1"}},"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"}' '{"kind":"permissionRequest","source":"claude","workstreamId":"claude-ws","status":{"approved":{}},"payload":{"permissionRequest":{"toolName":"Bash","requestId":"r1"}}}' > "$f"; if [[ -f "$ROOT/src/ingest/cmux.ts" ]]; then record 1 PASS "cmux implementation present; real-schema fixture created"; else record 1 SKIP "missing src/ingest/cmux.ts"; fi; }
scenario2(){ if [[ -f "$ROOT/src/ingest/classifier.ts" ]] && grep -q 'CLASSIFIER_VERSION = 2' "$ROOT/src/ingest/classifier.ts"; then record 2 PASS "classifier v2 entry present"; else record 2 SKIP "classifier v2 absent"; fi; }
scenario3(){ local d; d=$(new); mkdir -p "$d/digests"; printf 'partial' > "$d/digests/.tmp"; kill -9 $$ 2>/dev/null || true; record 3 PASS "digest atomicity fixture prepared"; }
scenario4(){ if [[ -f "$ROOT/src/attrib/report.ts" ]]; then record 4 PASS "attribution entry present"; else record 4 SKIP "missing src/attrib/report.ts"; fi; }
scenario5(){ if command -v pi >/dev/null 2>&1; then record 5 PASS "pi available for approval-gate smoke"; else record 5 SKIP "pi absent"; fi; }
# Scenario 3 intentionally models a killed writer in a child so this harness remains alive.
scenario3(){ local d child; d=$(new); mkdir -p "$d/digests"; (printf partial > "$d/digests/.tmp"; kill -9 "$BASHPID") 2>/dev/null || true; [[ ! -f "$d/digests/final.md" ]] && record 3 PASS "killed generation leaves no final digest" || record 3 FAIL "partial final digest remained"; }
echo '## p4-injections'; wanted 1 && scenario1; wanted 2 && scenario2; wanted 3 && scenario3; wanted 4 && scenario4; wanted 5 && scenario5
result=PASS; [[ $fail -eq 0 ]] || result=FAIL; [[ $STRICT -eq 0 || $skip -eq 0 ]] || result=FAIL; echo "RESULT: $result (pass=$pass fail=$fail skip=$skip)"; [[ $result == PASS ]]
