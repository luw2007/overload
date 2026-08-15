# P4 Review — cmux ingestion, classifier v2 Q4, digest, attrib, approval gate v0

Attempt: `n19-a1-E918FB2E`. Scope: `git diff 615abdd..HEAD -- src scripts` against
`docs/contracts/p4-freeze.md` protocols 12–15 (tech-solution §2.9/§2.4c/§2.6/§2.1).

**Time-boxed review (hard 25min budget, exceeded to ~32min on explicit instruction to
finalize).** Priorities 1–5 from the task were investigated in order; findings below are
committed incrementally per that priority order. See "NOT REVIEWED" at the end for gaps.

Files in diff: `src/ingest/cmux.ts`(+test), `src/ingest/reducer.ts`, `src/ingest/classifier.ts`,
`src/ingest/ingest.ts`(+test), `src/ingest/schema.sql`, `src/digest/digest.ts`(+test),
`src/attrib/report.ts`(+test), `src/extension/overload.ts`, `src/cli/overload.ts`(+test),
`scripts/install-claude-hooks.sh`.

All discovered `*.test.ts` for the touched modules were run (`bun test`): 23 pass, 0 fail.

---

## BLOCKER

### B1 — Q4 change-evidence derivation has a false-negative window: rate-limited `tool_activity` can silently drop the only signal a mutating tool call happened

`src/extension/overload.ts:474-479`:

```ts
on("tool_call", (event) => {
  const now = Date.now()
  if (now - lastToolActivity >= TOOL_ACTIVITY_INTERVAL_MS) {   // 5_000ms, line 17
    lastToolActivity = now
    emit("tool_activity", { tool: truncateUtf8(event?.toolName || "unknown", 80) })
  }
  ...
```

`tool_activity` emission is throttled globally to **at most once per 5 seconds, regardless
of which tool fired it**. The throttle gate is keyed only on wall-clock time since the last
*any*-tool emission — it has no special case for change-capable tools (`bash`/`write`/`edit`).

`src/ingest/reducer.ts:40-49` (`hasChangeEvidence`) and `src/ingest/classifier.ts:56-58`
(the Q4 predicate) depend entirely on a `tool_activity` (or `commit_observed`) journal row
whose `detail.tool`/`detail.tool_name` matches `/^(bash|write|edit)$/i` to mark a session as
having change evidence. If a session's tool-call sequence within any 5s window starts with a
read-only tool (`read`/`grep`/`find`/`ls`) and is followed — inside that same window — by a
`write`/`edit`/`bash` call, the mutating call's `tool_activity` is suppressed by the throttle:
only the first tool name in the window is ever recorded. Multiple mutating tool calls in quick
succession (a very common agentic pattern) collapse to a single `tool_activity` row, or none
at all if a read-only call happens to win the race.

The only unthrottled change signal is `commit_observed`, emitted from
`on("tool_result", ...)` (`overload.ts` ~line 468) **only after a `bash` tool call**, by
diffing `git rev-parse HEAD` before/after. This catches `git commit` but does **not** catch
`write`/`edit` tool mutations that are never committed, nor bash-based file mutations that
don't result in a HEAD change (e.g. `rm`, `mv`, uncommitted `git add`).

Net effect: a session that used `write`/`edit`, or bash file mutations without a commit, can
be classified `has_change_evidence: false` and auto-verified into **Q4** — the exact queue
that protocol 13 defines as "冻结，最保守" (frozen, most conservative: zero change evidence
implies the session is safe to skip review). This breaks that guarantee. Q4 is presented to
users as "you don't need to look at this"; a false negative here means real changes can go
unreviewed.

The acceptance matrix (protocol 13 / freeze doc verification #2, and
`src/cli/overload.test.ts`'s "reducer Q4 projection" test) only exercises the single-event
case (one `tool_activity{tool:"bash"}` row, or none) and does not construct a burst of tool
calls inside one 5s window, so this gap is not caught by current tests.

**Suggested fix direction** (not applied — src/test are frozen for this reviewer): either (a)
emit `tool_activity` unthrottled specifically when `toolName` is a change-capable tool
(bypass the rate limit for `bash`/`write`/`edit`, keep the throttle only for cosmetic/heartbeat
purposes), or (b) track "has any change-capable tool been called this run" as a boolean
in-memory flag in the extension and always flush it at `settle()`/`session_ended`, independent
of the 5s sampling cadence.

---

## MAJOR

### M1 — `digest --llm pi` has no timeout/abort on the `pi -p` subprocess; a hung LLM call blocks digest generation indefinitely, contradicting the documented fail-open contract

`src/digest/digest.ts:39-45`:

```ts
async function compressWithPi(raw: string, model: string): Promise<string> {
  try {
    const process = Bun.spawn(["pi", "-p", "--no-session", "--no-tools", "--model", model, ...],
      { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const output = oneLine(await new Response(process.stdout).text());
    return await process.exited === 0 && output ? output : raw;
  } catch { return raw; }
}
```

(Verified operator precedence is correct: `await` binds tighter than `===`, so this parses
as `((await process.exited) === 0 && output) ? output : raw` — the fallback-to-raw logic
itself is correct for explicit failure/empty-output cases.)

However there is no `timeout` option on `Bun.spawn` (unlike `execGit` in
`src/extension/overload.ts` which sets `timeout: 1500`) and no `AbortController`. If the `pi`
subprocess hangs (network stall to the LLM provider, provider outage, etc.), both
`new Response(process.stdout).text()` and `process.exited` await indefinitely — there is no
`catch`-reachable path for a hang, only for a thrown/rejected spawn or a clean non-zero exit.
Because `readItems()` produces up to 50 items and `compressWithPi` is awaited **sequentially
in a `for` loop** (`generateDigest`, the `if (options.llm === "pi")` block), a single stuck
item can hang `overload digest --llm pi` forever. Protocol 13 explicitly promises
"LLM 只读...无写权限、失败回退 raw 预览" (fail-open to raw on failure) — a hang is a failure
mode this promise doesn't cover; test coverage explicitly excludes this path
("测试只测 none 模式；llm 模式 owner 冒烟"), so it's real but latent risk.

### M2 — cmux dual-fingerprint ABA closure is now implemented and tested (closes REVIEW-P3.md M3 / N9-carryover) — reported as resolved, not a new defect

`src/ingest/cmux.ts:63-72` implements the double-fingerprint contract from tech-solution
§2.9/R5-B4: `changed` is computed from `dev_inode` mismatch, `size < cursor_bytes`
regression, `head_fp` mismatch (first-line anchor), **and** `cursor_tail_fp` mismatch
(re-read of the line immediately preceding the persisted cursor). All four conditions are
required to *not* fire for the scan to be treated as a continuation of the same generation;
any single mismatch forces a new `generation_uuid`, cursor reset to 0, and the old generation
row is `retired=1`. This matches the frozen protocol text closely, including "旧代际标
retired=1" and the journal identity mapping `emitter_id='cmux-'+generation_uuid`,
`seq=byte_start` reusing `UNIQUE(host, emitter_id, seq)`.

`src/ingest/cmux.test.ts` includes a same-first-line truncate-and-regrow test
("detects truncate-and-regrow ABA with the same first line using cursor tail fingerprint")
that specifically exercises the case the tech-solution called out as the reason a *single*
head-fingerprint is insufficient (R5-B4). It passes. I did not find a correctness defect in
this logic during this review; flagging as **resolved**, not blocking. See MINOR m1/m2 below
for smaller residual notes on this module.

---

## MINOR

### m1 — cmux terminal-status enumeration is probe-derived and will silently strand unknown terminal statuses as pending forever
`src/ingest/cmux.ts:16-17` (`RESOLVED_STATUSES`/`CANCELLED_STATUSES`) and `translate()`
(~line 145-156): any `status` key not in either set returns `null` (row skipped, no
`decision_resolved` emitted). This is consistent with the module's own comment
("kind 分布实测…宁可不发…也不误终止" applied to lifecycle, and generally conservative-skip
for actionable kinds too), and is explicitly documented as probe-based, but means a
never-before-seen terminal status value (e.g., a new cmux release) leaves the request
permanently `pending` in Q1 with no operator-visible signal that the terminal mapping is
stale, beyond it just never resolving. Worth an owner follow-up to alert if unknown status
keys are observed at all (even just a counter), rather than silent skip.

### m2 — dead `'tool_call'` kind in the reducer's change-evidence query
`src/ingest/reducer.ts:44`: `WHERE stable_id=? AND ingest_seq<=? AND kind IN
('commit_observed','tool_call','tool_activity')`. The extension's `Kind` union
(`src/extension/overload.ts:22-25`) never emits a `"tool_call"` journal kind — only
`tool_activity`. This branch of the `IN` clause is therefore currently unreachable/dead. Not
a correctness bug (harmless no-op), but it reads as if two independent evidence channels
exist when only one (`tool_activity`, subject to B1's throttle) does; worth cleaning up or
documenting why it's there (e.g., anticipating a future source that does emit `tool_call`).

### m3 — approval gate: single bad regex disables the entire gate, not just the offending rule, and can also warn spuriously on a fully-disabled gate
`src/extension/overload.ts:loadApprovalGate()` (~lines 331-361): `gate.block_bash_patterns`
and `gate.block_write_paths` shape-validation runs (and can throw) **before** the
`if (!gate.enabled) return` check. A malformed `block_bash_patterns` array in a config with
`enabled: false` still produces a `warn-once` and calls `warnAndDisableGate`, even though the
gate was already going to be inert. Separately, `bash.map((source) => new RegExp(source))`
is inside the same outer `try`, so one invalid pattern in a list of N disables all N rules
(matches protocol 15's "门自身故障...门整体禁用" wording literally, so this is arguably
correct per contract — flagging only the enabled:false-warns-anyway edge case as a minor
surprise, not a violation).

### m4 — no ReDoS/hang guard on admin-supplied `block_bash_patterns` regexes at match time
`src/extension/overload.ts:gateRule()` (~lines 363-378): `rule.pattern.test(event.input.command)`
runs synchronously with no length cap or timeout. A pathological pattern (accidental
catastrophic backtracking) in `~/.overload/config.json` would hang the host's `tool_call`
event loop on every subsequent bash call while `enabled: true`, which is the opposite of the
"零开销放行 / 无干扰优先" intent for the common case, though this requires local, authorized
control of `config.json` (not a remote-attacker surface) — low severity, self-inflicted-config
risk only.

### m5 — `git log` subprocess in attrib has no timeout, unlike its sibling `execGit` in the extension
`src/attrib/report.ts:git()` (~line 190): `Bun.spawn(["git", ...argv], {...})` has no
`timeout`/`AbortController`, whereas `src/extension/overload.ts:execGit` sets
`{ timeout: 1500 }`. A slow/hung filesystem (network-mounted repo) could hang
`generateAttribReport`'s `Promise.all` over `universe.map(enumerateCommits)` indefinitely.
Low impact since `attrib`/`digest`-attrib-path is a read-only, on-demand CLI command, not a
resident daemon, but worth aligning with the extension's existing pattern.

---

## Priority (3) attrib git subprocess arg safety — reviewed, no issues found

All `git` invocations in `src/attrib/report.ts` go through `Bun.spawn(["git", ...argv], ...)`
with `argv` built as array elements (`-C`, `path`, `log`, `--since=...`, `--format=...`),
never through a shell (`sh -c`) and never via string concatenation into a single command
string. Repo paths (from `sessions.cwd`, `opts.repos`, or `config.attrib_repos`) are passed
as discrete argv entries, so shell metacharacters in a path cannot cause injection; a
non-existent/non-repo path just makes `git -C <path> rev-parse --show-toplevel` fail
(`ok:false`), which is handled by filtering it out of `universe`/`rows` (see
`report.test.ts`'s "tolerates a non-repository cwd" test, passing). `sha` values are further
validated with `/^[0-9a-f]{40,64}$/i` before being trusted. No blocker/major found here beyond
m5 above (timeout).

---

## NOT REVIEWED (time-boxed cutoff)

- `scripts/install-claude-hooks.sh` diff in this range (further refinement of the `.bak`
  first-write-only semantics already reviewed under P3 M3/m2) — not re-audited line-by-line
  in this pass; it is N14-owned per the P3 freeze doc, out of this attempt's stated P4 scope
  (cmux/classifier/digest/attrib/gate), and the diff is a small, self-contained doc+condition
  change (`[ -f "$settings" ] && [ ! -e "$settings.bak" ]`).
- `test/harness/p4-injections.sh` — only skimmed for scenario names/pass criteria, not
  executed or deeply audited against protocols 12–15.
- Full `src/cli/overload.ts` command surface beyond `q4`/`digest`/`attrib` argument parsing
  (`sessions`, `show`, `q1`, `q2`, `zombie`, `health`) — these predate this diff except for
  the `q4`/`digest --llm`/`attrib --since` argument-validation additions in `main()`, which
  were read but not exhaustively fuzzed for the CLI arg-parsing branch conditions.
  `src/cli/overload.test.ts` covers the new Q4 CLI path; the digest/attrib CLI wiring itself
  (`main()`'s `validDigest`/`validAttrib` branches) has no dedicated test in this diff.
  Deferred — not investigated further this pass.
- Commit message mentions "add git execution boundary proposal" — if this refers to a
  docs-only file outside `src`/`scripts`, it was not located/read in this pass (out of the
  stated `-- src scripts` diff scope, but flagging the mention for owner follow-up in case it
  implies a contract change relevant to `src/attrib/report.ts` or `src/extension/overload.ts`
  git subprocess boundaries).
- `src/ingest/schema.sql` `source_generations` DDL — read and cross-checked against
  `cmux.ts` usage (columns match), but not reviewed for migration/upgrade safety on an
  existing populated ledger (e.g., pre-P4 databases without this table — `CREATE TABLE IF
  NOT EXISTS` should be safe, but ledger backup/restore interaction per tech-solution §2.7
  ("cmux 代际游标随备份恢复后按 §2.9 去重") was not independently verified).
- Reducer changes to `applySessionEvent`/`hasChangeEvidence` beyond the Q4 predicate path
  (interaction with `frozen`/incident logic, `RECON_EVENTS`, writer-precedence guards) were
  read for context but not independently re-derived/re-verified beyond confirming existing
  P2/P3 tests still pass unmodified.
- Full diff of `src/ingest/ingest.test.ts` / `src/attrib/report.test.ts` /
  `src/digest/digest.test.ts` / `src/ingest/cmux.test.ts` / `src/cli/overload.test.ts` beyond
  the excerpts read above — all were executed (`bun test`, 23 pass / 0 fail) but not every
  assertion was manually cross-checked against the frozen contract text.

---

## Summary

| Severity | Count |
|---|---|
| BLOCKER | 1 (B1 — Q4 `tool_activity` throttle can suppress the only change-evidence signal for `write`/`edit`/uncommitted-bash mutations, allowing sessions with real changes into Q4 auto-verified) |
| MAJOR | 2 (M1 — digest `--llm pi` subprocess has no timeout, can hang indefinitely, violating fail-open contract; M2 — cmux dual-fingerprint ABA closure reviewed and found correctly implemented/tested, reported for visibility not as a defect) |
| MINOR | 5 (m1 unknown cmux terminal status strands requests silently; m2 dead `tool_call` kind in reducer query; m3 gate warns on already-disabled malformed config; m4 no ReDoS/hang guard on admin gate regexes; m5 no timeout on attrib's git subprocess) |

Priority order requested: (1) cmux dual-fingerprint — reviewed, resolved (M2, informational).
(2) gate v0 fail-open/pattern-compile safety — reviewed, minor findings only (m3, m4).
(3) attrib git subprocess arg safety — reviewed, no injection issues found (m5 timeout only).
(4) digest tmp+rename atomicity — reviewed, atomicity itself is correct; LLM fail-open has a
real hang gap (M1). (5) Q4 change-evidence derivation — reviewed, **BLOCKER** found (B1).
