# N27 adversarial review — N26 jump execution

## 1. Command injection / shell safety — PASS

- `src/web/jump.ts:11-13` gives the executor a command plus an argument array and invokes `Bun.spawn([command, ...args])`; there is no shell string and no `shell` option.
- `src/web/jump.ts:72-78` places the ledger `binding` in one argv element for herdr and one deeplink argv element for `open`. Shell metacharacters, whitespace, or option-looking text cannot create another argv element.
- `src/web/jump.ts:83-106` uses fixed argv arrays for all three Orca calls. The ledger-derived path is contained in the single `path:${path}` selector element, and the parsed handle is contained in the single value element following `--terminal`.
- `src/web/server.ts:91-94` obtains the executor input from `queryJumpTarget`; no request-path text is forwarded as a command or argument.

## 2. Timeout enforcement — PASS

- `src/web/jump.ts:9-24` sets the bound to 5000 ms, races `process.exited` against an actual timer, kills a timed-out process with signal 9, and returns a failed result rather than continuing to await it.
- Every invocation supplies that bound explicitly: herdr at `src/web/jump.ts:73`, cmux `open` at `src/web/jump.ts:78`, and Orca steps 1/2/3 at `src/web/jump.ts:83,95,106`.
- `src/web/jump.ts:111-113` also converts executor throws into a bounded failure response at the dispatcher boundary.

## 3. Orca chain correctness — PASS

- Step 1 and step 2 command failures return immediately at `src/web/jump.ts:84,96`; step 3 cannot be reached after either failure.
- Worktree JSON is parsed under `try/catch`, accepts only array/envelope rows, requires an object with a non-empty string `worktreeInstanceId` equal to the binding and a non-empty string `path`, and otherwise stops at `src/web/jump.ts:85-93`.
- Terminal JSON is likewise shape-checked and requires a non-empty string handle/id/terminalId before switching (`src/web/jump.ts:97-106`); malformed JSON, non-object rows, absent arrays, empty arrays, and missing/wrong-typed fields degrade to `{opened:false}`.
- `src/web/jump.test.ts:30-42` verifies the exact three-hop success chain; `src/web/jump.test.ts:45-54` verifies no step 3 after step 2 failure; `src/web/jump.test.ts:56-60` verifies malformed worktree JSON stops after step 1.

## 4. Platform/binding gating — PASS

- `src/web/jump.ts:70` returns before dispatch when `binding` is null or empty.
- Only exact platform matches enter executors (`src/web/jump.ts:72,77,82`); null and unknown platforms reach the non-executing return at `src/web/jump.ts:110`.
- `src/web/jump.test.ts:63-70` supplies missing binding, null platform, and unknown platform and proves the fake executor received zero calls.

## 5. Test quality — MINOR

- The tests inject `fake.exec` into every `performJump` call (`src/web/jump.test.ts:19,26,37,52,59,66-68`); the fake only records argv and returns scripted values (`src/web/jump.test.ts:6-12`). No test can invoke real `herdr`, `orca`, `open`, or a cmux process.
- Terminal evidence: `bun test src/web/jump.test.ts` completed with **6 pass, 0 fail, 14 expect() calls** in 41 ms.
- Coverage gaps: the suite does not exercise `defaultExecutor` timeout/kill behavior, Orca step-1 failure, malformed terminal-list JSON/shape, missing terminal handle, or step-3 failure. The implementation handles these paths, but the security-sensitive timeout contract and several abort edges are established only by inspection.

## 6. `queryQ1` platform field — PASS

- `src/shared/queries.ts:61-66` leaves the existing selected expressions, `FROM`, pending filter, and ordering unchanged and adds only a scalar `platform` projection using the same latest-valid-attachment criterion as `binding`.
- `src/shared/queries.ts:67` retains the same detail parsing and numeric-to-boolean conversion for all rows.
- `src/web/server.ts:82` removes the internal `platform` field from `/api/q1`, preserving the existing API row shape.
- Terminal evidence: `bun test src/web/server.test.ts` completed with **4 pass, 0 fail, 12 expect() calls**. In particular, `src/web/server.test.ts:59-75` checks every pre-existing Q1 API field and value, including host, parsed detail, failed, and binding.

## 7. Design fidelity — PASS

- Exact implementations match the grounded mechanisms: `herdr agent focus <binding>` at `src/web/jump.ts:72-74`; Orca worktree-id → `path:` selector → terminal handle → switch at `src/web/jump.ts:82-107`; and `open cmux://workspace/<binding>` at `src/web/jump.ts:77-79`.
- Missing binding, unknown/null platform, parse/lookup misses, and command failures return `{opened:false}` paths (`src/web/jump.ts:60-61,70,74,79,84,93,96,104,107,110-113`). No `open -a`, empty-terminal, SSH, or generic application fallback exists.

ALIGN
