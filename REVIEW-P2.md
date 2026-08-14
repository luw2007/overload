# P2 Code Review — ATTEMPT_ID=n9-a1-3F4E6125

Scope: `git diff 456b8b9..HEAD -- src scripts launchd` (reducer/classifier/queues,
recon daemon, notifier/outbox, watchdog) against `docs/contracts/p2-freeze.md`
protocols 1-8 and tech-solution §2.2/§2.4/§2.5.

**NOTE — time-boxed review.** This pass covered reducer.ts, classifier.ts,
recon.ts, notifier.ts, ingest.ts (P2 additions), schema.sql, cli/overload.ts,
watchdog.sh/maintenance.sh, launchd plists, and the relevant test suites
(src/*.test.ts, test/lib/p2/*, test/p2-*.test.ts, test/harness/p2-injections.sh).
The hard 25-minute budget was exceeded before a full second pass (cmux
generation/ABA code in ingest.ts's non-P2 portion, extension.ts, and
attribution/§2.6 code were not reviewed). Findings below are graded by
confidence; items I could not fully verify are marked accordingly rather than
asserted as blockers.

---

## BLOCKER

None found with high confidence in the time available. The core atomicity
requirements I was able to verify hold:

- **Reducer batch transaction (protocol 1/4, §2.4b, §2.5)**: `reduceJournal()`
  in `src/ingest/reducer.ts:38-51` wraps the entire read-journal → apply-events
  → advance-cursor sequence in one `db.transaction(...).immediate()`. Every
  `applyEvent` call (current/requests/queue_transitions/notifications writes)
  for the whole batch happens inside that same transaction, and
  `reducer_cursor` is only advanced at the end. A crash mid-batch rolls back
  everything — no "cursor advanced, notification missing" window. The
  `decision_requested` path (`reducer.ts:158-165`) inserts the `requests` row
  and the `notifications(initial, pending, reminder_seq=0)` row back-to-back
  inside that same transaction — protocol 4's same-txn requirement is met.
- **`emitter_drained` orphan + coverage_gaps**: `orphanDrainedEmitter`
  (`reducer.ts:171-178`) is called from `applyRequestEvent`, itself inside the
  batch transaction — orphaning and the coverage_gaps tail row are atomic with
  each other and with the cursor advance.
- **Notifier claim/complete**: `claimNext`/`markSent`/`markFailed`/
  `enqueueReminders` in `src/notify/notifier.ts` each wrap their
  read-then-write in `db.transaction(...).immediate()`. `claimNext` selects
  the candidate row and flips it to `attempting` inside one transaction
  (`notifier.ts:37-48`), so two concurrent notifier processes cannot both
  claim the same row (SQLite `immediate()` takes the write lock up front).
- **Backoff arithmetic**: `SINK_BACKOFF_MIN = [1,5,15,15,15]` (frozen, from
  `shared/types.ts`) is consumed correctly in `markFailed`
  (`notifier.ts:81-89`): failures 1-5 reschedule at `now + backoff*60_000`
  with `retry_count` incremented; failure 6 (`failures >= MAX_FAILURES` where
  `MAX_FAILURES = SINK_BACKOFF_MIN.length + 1 = 6`) sets
  `failed_permanent`. This exactly matches the `notifier.test.ts` "backs off
  five failures and makes the sixth permanent" case and the frozen backoff
  schedule.

---

## MAJOR

1. **Incident freeze uses an over-broad/asymmetric `LIKE` clause that can
   freeze unrelated sessions on a `cmux` outage — `src/ingest/reducer.ts:73-78`**
   ```ts
   db.query(`UPDATE current SET frozen=1 WHERE stable_id LIKE ? OR stable_id IN
     (SELECT stable_id FROM attachments WHERE platform=? AND valid=1)`)
     .run(`%:${source}:%`, source);
   ```
   `stable_id = <host_id>:<runtime>:<session-uuid>`. For `source ∈
   {herdr, orca}` the `LIKE '%:herdr:%'` / `LIKE '%:orca:%'` branch can never
   match any real stable_id (runtime is always `pi|omp|prime|claude|cmux`), so
   it's dead code there — freeze correctly falls back to the
   attachments-based join. But `source = "cmux"` is *also* a valid `Runtime`
   value, so `LIKE '%:cmux:%'` matches **every** cmux-runtime session
   regardless of whether it has an `attachments` row for platform `cmux` —
   i.e. a `cmux` source outage freezes all cmux sessions unconditionally, not
   just attachment-bound ones. This is inconsistent with protocol 6's
   "受影响 session 冻结标记" (which ties freezing to the outage's observed
   scope) and with the symmetric `frozen=0` unfreeze on `source_recovered`
   using the same pattern (so it self-heals, but the over-freeze window is
   still an observable protocol deviation). Recommend dropping the `LIKE`
   branch entirely and freezing purely via the `attachments` join (or an
   explicit `runtime=source` check with a documented rationale for treating
   cmux differently than herdr/orca).

2. **Freeze is not applied to sessions attached *after* an outage is already
   open — `src/ingest/reducer.ts:69-78` vs. `applyAttachment` (`reducer.ts:82-88`)**
   `applyIncident` only runs (and sets `frozen=1`) at the moment the
   `source_outage` event itself is reduced, over the attachments known *at
   that instant*. If an `attachment_observed` event for the same platform
   arrives later while the incident is still open (e.g. recon binds a new
   session to `herdr` mid-outage), `applyAttachment` does not re-check
   `isIncidentOpen` and never sets `frozen=1` for that newly-bound session.
   Combined with the `RECON_EVENTS`-during-open-incident suppression in
   `applySessionEvent` (`reducer.ts:99`), a session attached mid-outage can
   end up neither frozen nor receiving any further recon-derived state
   updates — a silent gap rather than the explicit freeze the contract
   promises. Recommend: `applyAttachment` should also set `frozen=1` when
   `isIncidentOpen(db, platform)` is true for the newly-observed platform.

3. **Recon dedup queries assume ingest has already caught up — race on
   process restart (`src/recon/recon.ts` `wasDead`/`wasDrained`/
   `sourceOutageOpen`/`sessionStillVanished`/`latestTelemetryGapAt`)**
   All of recon's "have I already reported this?" checks
   (`hasJournalFinding`, `sourceOutageOpen`, etc.) read the `journal` table
   directly, i.e. they only see findings that ingest has *already ingested*
   from recon's own admin-spool output. Within one long-lived recon process
   this is backstopped by the in-memory `deadReported`/`drained`/`outages`/
   `gaps`/`vanished` sets, but those sets are empty after every recon process
   restart (each restart also mints a *new* `emitterId` via `randomUUID()`,
   so the admin-spool journal identity changes but the *target's*
   `emitter_id`/`native_id` in `detail` — which the dedup queries key on — do
   not). If ingest lags behind the 60s recon interval (e.g. ingest is down,
   or `maintenance.sh` runs recon back-to-back without ingest having run
   between them, which is exactly the launchd topology: `recon.ts --once`
   then `watchdog.sh`, with the separate `ingest` launchd job on its own
   2s-poll cadence but no ordering guarantee against `maintenance.sh`), a
   restarted recon can legitimately re-emit `emitter_dead`/`emitter_drained`/
   `source_outage`/`telemetry_gap` for a condition it (or a prior instance)
   already reported but ingest hasn't consumed yet. The resulting duplicate
   admin-spool lines are individually idempotent-safe on the *ingest* side
   only insofar as downstream effects are idempotent (`orphanDrainedEmitter`
   uses `UPDATE ... WHERE state='pending'`, safe; `coverage_gaps` insert is
   **not** deduplicated — a second `emitter_drained` for the same emitter
   after ingest catches up would insert a second `coverage_gaps` row with a
   different `to_at`). This is a real, if narrow, double-reporting window
   inherent to the read-through-journal dedup design; flagging as MAJOR
   because `coverage_gaps` duplication directly affects the health/telemetry
   surface. Not fully verified end-to-end within the time budget — recommend
   N6/N5 pair review this specifically against the six-injection harness
   scenario 2 (kill -9 + restart timing).

---

## MINOR

4. **`scripts/watchdog.sh` heartbeat file is never written by anything in
   this diff.** `launchd/README.md:13-14` and `scripts/watchdog.sh:2,5`
   explicitly document/expect `~/.overload/ingest.heartbeat` to be touched by
   the ingest loop ("The ingest loop (owned by N5) must touch this
   heartbeat"), but `git diff 456b8b9..HEAD -- src/ingest/ingest.ts` shows no
   write to that path (or any heartbeat file) anywhere in `ingest.ts`. As
   shipped, `watchdog.sh` will always see `heartbeat_mtime=0` and alarm
   ("Overload ingest heartbeat is missing") even when ingest is healthy and
   running. This looks like a cross-module contract gap between N5 (owns
   `src/ingest/**`) and N7 (owns `scripts/**`) rather than a bug purely in
   the reviewed N7 code, but it means protocol 7's watchdog is currently
   non-functional / permanently false-positive on a fresh install. Flag for
   the integration owner; not blocking this review's scope (`src/ingest/**`
   is N5-owned) but worth surfacing since it silently breaks §2.4/protocol 7
   acceptance.

5. **`applyIncident`'s `source_outage` INSERT OR IGNORE keys off
   `(source, opened_at)` (schema UNIQUE) but re-open detection is a separate
   `isIncidentOpen` query — `reducer.ts:71-72`.** Benign in the single-writer
   reducer-transaction model, but if two `source_outage` events for the same
   source landed in the same journal at the same `at` timestamp (e.g. a
   coarse clock or synthetic/backfilled data), the second would be silently
   ignored by the UNIQUE constraint while `isIncidentOpen` already returned
   true and skipped the insert anyway — redundant but not incorrect. No
   action needed, noting only because it was adjacent to MAJOR #1/#2.

6. **`maintenance.sh` runs recon and watchdog sequentially in one launchd
   job, but recon failures are only surfaced via `recon_status` exit code —
   `scripts/maintenance.sh`.** If `bun … recon.ts --once` throws before
   `runOnce()` returns (e.g. the ledger file is missing/corrupt), the
   nonzero exit is captured and eventually returned by `maintenance.sh`, but
   there is no distinct alerting path for "recon itself is broken" versus
   "watchdog detected a stale heartbeat" — both surface only as a launchd
   job exit code with no osascript notification for the recon-specific
   failure (only `watchdog.sh` calls `osascript`). Acceptable for v1 given
   §2.4c's `telemetry_gap`/`source_outage` are the primary user-facing
   signals, but recon-process-crash itself is a silent failure mode absent
   from the health report. Not verified whether `overload health` surfaces
   recon-process liveness at all — out of scope for this pass.

---

## Scope cuts vs. contract — not found

I did not find evidence of a *silent* scope cut (i.e., a protocol requirement
quietly dropped without a comment/test acknowledging it) in the code paths I
reviewed. `Q4` is correctly left closed (`classifier.ts` `desiredQueue` never
produces `q4`), `session_vanished` is gated on a complete snapshot per
protocol 6 (`recon.ts` only calls the vanished check from within
`reconcileSource`, which is only invoked on a successful `commandSnapshot`),
and the six-injection harness (`test/harness/p2-injections.sh`) exercises all
six contract scenarios including scenario 4's per-session-freeze/incident
zero-storm assertion. I was not able to run the harness or the full test
suite within the time budget — this review is based on static reading only.

---

## Areas not reviewed (time budget exceeded)

- `src/ingest/ingest.ts` non-P2 portions (cmux generation/ABA double-fingerprint
  logic, §2.9) and `src/extension/overload.ts` (§2.1/§2.3 emitter-side).
- `src/cli/overload.ts` full read path beyond a skim (q1/q2/zombie/health
  queries look structurally sound but weren't traced against every edge
  case, e.g. `zombie()`'s exclusion of `orphaned_request` from the `current`
  loop plus separate `requests` query for orphaned rows — looked correct on
  read but not test-verified here).
- §2.6 commit attribution (out of this diff's file list regardless).
- Running `bun test` / the six-injection harness to confirm the above
  findings empirically rather than by static read.
