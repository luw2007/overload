# N2 Report — ATTEMPT_ID n2-a2-EDB602BC

## Delivered

- Added `resume_capability` to `/api/hung` rows and `/api/zombie` group rows using the existing `inspectResume` seam.
- Added `POST /api/closeout/:stable_id`, including 404 handling, Q2 exclusion, and Archive inclusion with `closed_out: true` only for explicitly closed rows (the field is absent otherwise).
- Added `POST /api/answer/:request_uid` validation and atomic private answer-file writes.
- Added the bounded dashboard CSS hooks requested by N2.
- Added server tests covering resume capability, close-out behavior, answer endpoint status/file semantics, and optional-table compatibility on a fresh readonly ledger.
- Audit fix: `queryQ2` and `queryArchive` probe `sqlite_master` once per call. When `closeouts` is absent, both preserve pre-N2 behavior without attempting DDL, including on readonly CLI connections.

## Persistence and resolution decisions

- `closeouts` DDL is additive and lives in `src/web/server.ts`; `startWebServer()` synchronously runs idempotent `CREATE TABLE IF NOT EXISTS closeouts(...)` before serving queries.
- Answers resolve to `OVERLOAD_ANSWERS_DIR` when set, otherwise `~/.overload/answers`. The directory is enforced as mode `0700`; answer files are written to a mode-`0600` temporary sibling and atomically renamed.
- Truth-boundary tradeoff: the ledger is normally ingest-owned, but close-out is an explicit operator decision and follows the existing server-side acknowledgement precedent by writing this narrow additive table directly. No classifier/reducer or existing table semantics were changed.

## Verification

- `bun test src/web/server.test.ts test/queries-q1.test.ts` — 24 pass, 0 fail.
- `git diff --check` — clean.
