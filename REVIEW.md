# P1 Merge Review — Overload (attempt n4-a1-4A431468)

Reviewed: `git log --oneline ea54f7b..HEAD` (N1 extension, N2 ingest/ledger/CLI, N3
acceptance suite, merged onto `node/n4`) and `git diff ea54f7b..HEAD -- src test`.
Cross-checked against `docs/contracts/p1-freeze.md`,
`docs/plans/overload-20260813-tech-solution.md` §2.1/2.2/2.4b/§2.7/§3, and
`.dispatch/N1-TASK.md`, `.dispatch/N2-TASK.md`, `.dispatch/N3-TASK.md`.

Verification performed: `bun test` (37/37 pass), `test/harness/crash-injection.sh`
(PASS A+B, real ingest process killed mid-batch via SIGKILL),
`test/harness/matrix-v2p.sh` against real `pi`/`omp`/`prime-agent` binaries (all
PASS, valid envelopes observed), manual `--once` idempotency + `overload show`
smoke against a hand-built spool, manual permission/symlink probes.

---

## BLOCKER

### B1. `decision_resolved` never carries `state`/`outcome` → reducer defaults every resolution to `resolved`, silently masking `cancelled`/`timed_out`
- `src/extension/overload.ts:418-426` — `tool_execution_end` handler for the
  `ask` tool emits `decision_resolved` with only `request_id`, optional
  `selected`, and optional `error: true`. It never sets a `state` or `outcome`
  field in `detail`.
- `src/ingest/reducer.ts:33-37` (`terminalState`) — reads
  `detail.state ?? detail.outcome`; if neither is a member of
  `SOURCE_TERMINALS` (`resolved|cancelled|timed_out`), it **silently defaults
  to `"resolved"`**.
- Net effect: every real `ask` resolution from the shipped N1 extension —
  including a user-cancelled or timed-out decision (`event.isError === true`)
  — is recorded in `requests.state` as `resolved`. `reducer.ts` does not even
  look at the `error` flag N1 does emit.
- This directly violates §2.2's state machine, whose entire purpose is
  distinguishing `resolved | cancelled | timed_out | orphaned`. Because N1 and
  N2 were developed against the frozen envelope/DDL contract but never against
  each other's concrete `detail` payload shape, this integration bug is
  invisible to both N1's and N2's own unit/smoke tests (N2's tests hand-craft
  `decision_resolved` events with an explicit `state` field that the real
  extension never produces — see `src/ingest/ingest.test.ts:68`). Confirmed
  via `overload show` smoke: a hand-crafted `decision_resolved` without
  `state` lands as `resolved` in the ledger (see reproduction in reducer.ts
  logic; `terminalState({})` → `"resolved"`).
- Fix: either N1 must emit `detail.state` (mapping `error` → `timed_out` or
  `cancelled` as appropriate) or N2's reducer must treat `isError`/absence of
  an explicit terminal as a distinct case rather than defaulting to the
  "success" terminal. p1-freeze.md does not pin the `detail` field name, but
  the current default silently converts unknown/error outcomes into the most
  optimistic state, which is the opposite of the "damage must be visible"
  principle running through §2.3/§2.4b.

---

## MAJOR

### M1. `on()` wrapper's try/catch does not protect async handlers — violates "zero throw from handlers" (§3, N1-TASK)
- `src/extension/overload.ts:344-357` — the `on()` helper wraps every handler:
  ```ts
  pi.on(event, (value, ctx) => {
    try { return handler(value, ctx) } catch { /* never throw */ }
  })
  ```
  This only catches a **synchronous** throw from calling `handler(...)`. Both
  `session_start` (`overload.ts:359`) and `session_shutdown`
  (`overload.ts:432`) are declared `async (event, ctx) => {...}`. Calling an
  `async` function never throws synchronously — any exception inside becomes
  a *rejected Promise* returned by `handler(value, ctx)`. The `try/catch`
  therefore does nothing for these two handlers; a rejection becomes an
  unhandled promise rejection propagated back into the host via
  `pi.on`'s callback return value, not swallowed as intended.
- `session_start` mitigates this partially with its own internal `try/catch`
  around the `await`ed section, but the pre-`try` statements
  (`ctx?.sessionManager?.getSessionId?.()`, `String(ctx?.cwd || process.cwd())`)
  are unguarded, and `session_shutdown` has **no internal try/catch at all**
  around `emit("session_ended", ...)` — only `spool.flushAndSeal()` is
  defended with `.catch(() => {})`.
- This is a real structural gap against the explicit N1-TASK requirement
  "handler 零同步 IO 零 throw" / "never throw out of an extension handler,"
  even though no concrete crash was reproduced in manual smoke testing
  (handler bodies are currently simple enough not to throw). Should be fixed
  before this is trusted as a defensive guarantee, not just an empirical one.

---

## MINOR

### N1. `mkdir(..., {recursive:true})` follows symlinks; only the final file open uses `O_NOFOLLOW`
- `src/extension/overload.ts:160-161` and `src/ingest/ingest.ts:61-63` both
  create `~/.overload/...` directories via `mkdir(path, {recursive:true, mode:
  0o700})` followed by `chmod(path, 0o700)`. Verified experimentally: if
  `~/.overload` is a pre-existing symlink to another directory, `mkdir`
  transparently follows it and the extension/ingest will happily create and
  `chmod 0700` the **symlink target**, with no `O_NOFOLLOW`-equivalent guard.
  Contrast with `src/ingest/ingest.ts:65` (`lstat().isSymbolicLink()` check
  before opening `ledger.db`) and the extension's active-file writer
  (`overload.ts:219`, uses `O_NOFOLLOW`), both of which correctly reject
  symlinks at the leaf. §2.7 calls for `O_NOFOLLOW` / path-component
  validation generally; the directory-creation path is the one gap. Low
  severity given `~/.overload` is user-owned and single-tenant, but worth
  closing for defense in depth (e.g., `lstat` each path component before
  `mkdir`, matching the ledger-file precedent already in the same file).

### N2. `requests.kind` always defaults to the literal string `"decision"`
- `src/ingest/reducer.ts:69-72` reads `detail.request_kind` or `detail.kind`
  from the journal event to populate `requests.kind`, but N1's extension
  (`overload.ts:401-410`) never sets either field on `decision_requested` —
  only `request_id`. Every request row's `kind` column is therefore always
  `"decision"` in practice. Not contract-breaking (p1-freeze.md doesn't pin
  this field's producer), and `overload show` still renders correctly, but
  it's dead code/an unused extension point until N1 (or a later phase) starts
  populating it. Flagging as a minor scope-alignment note, not a defect.

### N3. `schema.sql` (`PRAGMA synchronous = FULL`) vs. test reference schema (`test/lib/schema.ts`, `PRAGMA synchronous = NORMAL` + `busy_timeout=5000`) diverge
- `src/ingest/schema.sql:2` uses `synchronous = FULL`; the N3 reference schema
  used to validate contract shape (`test/lib/schema.ts`) uses `NORMAL` and
  adds `busy_timeout`. Both satisfy "WAL; batch+cursor same transaction," and
  N2's schema.sql is the frozen-DDL-conformant one actually shipped, so this
  is not a defect in the merged tree — just an inconsistency between the
  authoritative schema and the test harness's independently-authored replica
  that's worth reconciling so `test/lib/schema.ts` doesn't silently drift from
  the real one in later phases (P2 will add tables here).

---

## Contract conformance — confirmed correct

- **Envelope fields**: `src/shared/types.ts` DDL and `EventEnvelope` shape
  match `p1-freeze.md` verbatim; `src/ingest/schema.sql` is byte-for-byte the
  frozen DDL. `test/envelope.test.ts` (16 tests) validates field
  names/types/unions/seq monotonicity/counter presence exhaustively — all
  pass.
- **UNIQUE dedup / idempotency**: `journal` UNIQUE(host, emitter_id, seq)
  enforced; `--once` run twice inserts 0 new rows (verified live); active+seg
  overlap dedup verified both in `src/ingest/ingest.test.ts` and manually.
- **Transaction atomicity**: `scanOnce` batches all journal inserts + cursor
  advance in one `db.transaction(...).immediate()`
  (`src/ingest/ingest.ts:98-107`); `reduceJournal` does the same for
  requests + `reducer_cursor` (`src/ingest/reducer.ts:44-63`).
  `test/harness/crash-injection.sh` SIGKILLs the **actual** `ingest.ts`
  process mid-batch (not a stub) and confirms exact row count after restart
  and a stable 3rd idempotent pass — reran live, PASS.
- **Request state machine incl. orphaned override**: pending→resolved,
  duplicate-resolve idempotency, terminal-before-pending (out-of-order),
  `orphaned→{resolved,cancelled,timed_out}` override, and
  source-terminal-mutual-exclusion (`resolved→cancelled` rejected) are all
  correctly implemented in `src/ingest/reducer.ts:66-95` and independently
  reproduced with a standalone probe script against the real reducer (not
  just N3's parallel reference in `test/lib/requests.ts`). The *transition
  logic itself* is correct — see BLOCKER B1 for the separate issue that real
  N1 events never reach the `cancelled`/`timed_out` branches of this
  otherwise-correct machine.
- **0600/0700**: verified live — `~/.overload` dir tree is `drwx------`,
  `ledger.db`/`-wal`/`-shm` and spool `.ndjson` files are `-rw-------`,
  independent of ambient umask (extension and ingest both explicitly
  `chmod` after `mkdir`/`open`).
- **Secret scrubbing**: `scrub()` in `src/extension/overload.ts:72-76`
  redacts common token/key patterns (`sk-`, `ghp_`, `github_pat_`, `xox*`,
  and `key|token|password|authorization=`) before truncation; applied inside
  `truncateUtf8`, so all `detail` text passes through it.
- **UTF-8 safe truncation**: `truncateUtf8` (extension) and
  `truncateUtf8Safe`/`truncateStringLeaves` (N3 reference,
  `test/lib/utf8.ts`) both truncate by codepoint, never splitting multi-byte
  sequences; extensively unit-tested (ASCII/2/3/4-byte boundaries, `≤500B`
  rule) — all pass.
- **No throw from handlers / bounded queue**: write queue is bounded at 1000
  (`WRITE_QUEUE_LIMIT`, `overload.ts:15,172-173`) with overflow routed to the
  resident `dropped_total` counter rather than throwing or blocking; directory
  init failure disables the writer with a single `warn-once`
  (`overload.ts:281-289`). See MAJOR M1 for the one real gap (async handler
  rejections bypass the intended catch-all).
- **V-2' behavior matrix**: reran `test/harness/matrix-v2p.sh` live against
  installed `pi`, `omp`, and `prime-agent` binaries — all three PASS with
  contract-valid envelopes and the expected lifecycle kinds observed
  (`session_started`/`session_ended` for `pi`; plus `working`/`settled` for
  `omp`/`prime`, consistent with each runtime's event surface).

## Scope cuts vs. task specs — none found undisclosed

- N1-TASK's 7 numbered requirements are all implemented (lease/lifecycle
  events, decision request/resolve, heartbeat/tool_activity sampling,
  commit_observed, conservative trailer injection, spool writer with
  counters/truncation/warn-once, host_id resolution). Trailer injection regex
  correctly rejects shell metacharacters (`overload.ts:410-414`).
- N2-TASK's schema/ingest/reducer/CLI deliverables are all present; queues and
  notifications are explicitly and correctly left as extension points only
  (`src/ingest/reducer.ts:41-43` comment), matching N2-TASK's stated P1 scope
  — not a silent cut, it's declared in-code and in the task spec.
- N3-TASK's 5 deliverables (envelope/idempotency/requests tests + crash and
  matrix harnesses) are all present, runnable, and pass against the merged
  N1+N2 tree, not just N3's own reference implementations.
- `docs/**` and `.dispatch/**` are untouched by any worker commit (`git diff
  --stat ea54f7b..HEAD -- . ':!src' ':!test'` shows changes only from the
  owner's pre-dispatch freeze commit, none from N1/N2/N3 branches) — no
  boundary violations.

## Summary

1 BLOCKER (B1: N1↔N2 `decision_resolved` outcome-field mismatch collapses
`cancelled`/`timed_out` into `resolved`), 1 MAJOR (M1: async handler
try/catch is ineffective), 3 MINOR (symlink-following `mkdir`, unused
`request_kind` field, schema pragma drift between prod and test reference).
Core contract mechanics (envelope, DDL, UNIQUE dedup, transaction atomicity,
orphaned-override state machine, security posture, bounded queue) are solid
and independently reverified live against the real binaries/processes, not
just the checked-in test suite. B1 should block merge until resolved since it
silently corrupts a core P1 acceptance signal (accurate request outcomes);
M1 and the MINORs are fix-forward candidates.
