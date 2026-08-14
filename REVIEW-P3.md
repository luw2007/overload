# P3 Code Review — attempt n13-a1-4DCA3C09

Reviewer: N13 (P3 code reviewer). Hard budget: 25 minutes, breadth-first, static
read only — no test/harness execution was performed (and per task scope,
`src/test/scripts` were not modified).

Scope reviewed:
- **Scope A** — `git diff e4d72d3..HEAD -- src scripts` against
  `docs/contracts/p3-freeze.md` protocols 9 (devbox puller, `src/pull/**`,
  `scripts/deploy-devbox.sh`) and 10 (claude hooks, `src/hooks/claude/**`,
  `scripts/install-claude-hooks.sh`), plus the notify_sink threading change in
  `src/ingest/ingest.ts` / `src/ingest/reducer.ts` and the one-line m6 change
  in `scripts/maintenance.sh`.
- **Scope B** — carryover from `REVIEW-P2.md` "areas not reviewed": cmux
  generation/ABA dual-fingerprint logic in `src/ingest/ingest.ts` vs
  tech-solution §2.9.

Diff stat: 9 files changed, 718 insertions(+), 11 deletions(-) (`scripts/deploy-devbox.sh`,
`scripts/install-claude-hooks.sh`, `scripts/maintenance.sh`,
`src/hooks/claude/overload-hook.sh`, `src/hooks/claude/smoke.sh`,
`src/ingest/ingest.ts`, `src/ingest/reducer.ts`, `src/pull/pull.test.ts`,
`src/pull/pull.ts`).

---

## BLOCKER

### B1 — Claude PermissionRequest hook does not observe the real async decision and blocks synchronously up to `OVERLOAD_PERMISSION_TIMEOUT_SECONDS` (default 30s)
`src/hooks/claude/overload-hook.sh:124-141`

Protocol 10 (p3-freeze.md §"协议 10") requires: "写 `decision_requested{...}`；等待
决策输出（claude 原生流程）后写 `decision_resolved{request_id, state}`" — i.e. the
hook is supposed to *wait for* Claude's native decision output and then record
it. The implementation instead re-inspects the **same** `$payload` variable
that was captured once at the top of the script (`payload=$(cat)`, line ~9),
looking for `.permission_decision // .decision // .permission_response.behavior
// .hookSpecificOutput.decision.behavior` (line 125-127). A `PermissionRequest`
hook invocation's stdin JSON is emitted *before* the user/agent has resolved
the permission — there is no mechanism shown here (polling a file, a second
hook invocation correlated by `request_id`, IPC, etc.) that lets this process
observe the actual resolution that happens after it returns. Consequently:

- In the realistic case (decision fields absent from the initial payload),
  the script always falls into the `sleep "$timeout_seconds"` branch
  (line 132) and unconditionally records `state=timed_out` — every real
  permission decision is misreported as a timeout, defeating protocol 10's
  purpose (decision_resolved should carry the real outcome).
- Worse, the hook **blocks its own process for up to 30s** doing nothing but
  sleeping. Per the hook's own header comment and p3-freeze.md, "hook 永不
  阻塞/破坏 claude 本体" (hook must never block/break Claude itself). If
  Claude Code invokes `PermissionRequest` hooks synchronously as part of
  granting/denying the tool call (the common hook architecture), this adds a
  mandatory ~30s stall to every real permission prompt — a direct violation
  of the no-block guarantee the fail-open design elsewhere in the script
  otherwise respects carefully (spool-unwritable → exit 0, etc.).
- The `smoke.sh` test only exercises the case where `permission_decision` is
  already present *in the initiating payload* (`session-response` case), so
  it does not catch this — it validates the code path that is unlikely to
  occur in real usage, not the default/likely one (`session-timeout` case,
  which is asserted to time out, but that's presented as if it's a
  legitimate "no decision yet" scenario rather than the systemic case).

**Impact**: telemetry for every live PermissionRequest is wrong (`timed_out`
instead of the real outcome), and — if this hook is wired synchronously into
Claude's permission flow as configured by the installer's `matcher:"*"` hook
entry (`scripts/install-claude-hooks.sh` — `addhook("PermissionRequest"; "*")`)
— every real permission prompt gains a blocking delay of up to
`OVERLOAD_PERMISSION_TIMEOUT_SECONDS`. This needs a design fix (e.g. actually
wait for/consume the real resolution channel Claude provides, or drop the
`sleep` and make PermissionRequest lifecycle-only/request-side, resolving via
a *second*, separate hook invocation keyed by `request_id`) before this can be
accepted as implementing §2.8/protocol 10.

---

## MAJOR

### M1 — rsync/ssh args built from config values with no `--`-separator guard against leading-dash argument injection
`src/pull/pull.ts:42-51`, `src/pull/pull.ts:195-198`

`remote`, `remote_spool`, and `dest` are all attacker/operator-configurable via
`--remote`, `--remote-spool`, `--dest` (contract explicitly calls these out as
test-injectable, and `dest`/`remote` are equally config-driven). They are
spliced into the rsync/ssh argv as **positional** arguments with no `--`
separator:

```
["-a", "--out-format=%n|%l", "--include=*/", "--include=seg-*.ndjson",
 "--include=active-*.ndjson", "--exclude=*", source, dest]
```

If `source` or `dest` (derived from `remote`/`remote_spool`/`dest` config)
begins with `-`, rsync/ssh will interpret it as an option rather than a path
(classic rsync/ssh argument-injection pattern, distinct from shell injection —
`Bun.spawn` correctly avoids a shell here, so this is *not* shell injection,
but it is still argument injection into the target binary). Given the launchd
plist and deploy flow read `remote`/`dest` from local config/CLI rather than
untrusted network input, exploitability is limited to local
misconfiguration/an already-compromised local config file, but the contract
explicitly asks this to be checked ("rsync/ssh 注入安全") and there is
currently no defense (no `--` before positional args, no leading-`-` rejection
in `loadConfig`). Recommend inserting a literal `"--"` before `source`/`dest`
in the rsync argv (rsync supports `--`) and rejecting `remote`/`dest` values
that start with `-` in `loadConfig`.

### M2 — Outage-emit / state-file-persist is not atomic together, opening a duplicate-`source_outage` window on crash
`src/pull/pull.ts:58-64` (catch branch) vs `sourceOutageOpen()` at `src/pull/pull.ts:75-85`

On the failure path: `state.failures++` → if threshold reached and
`!state.outage_reported && !this.sourceOutageOpen()` → `emit("source_outage")`
→ `state.outage_reported = true` → `saveState(state)`. If the process is
killed/crashes **after** `emit()` durably fsyncs the admin-spool line but
**before** `saveState()` renames the new state file into place, the next
invocation reads the *old* on-disk state (`outage_reported` still false), and
`sourceOutageOpen()` will also return `false` if ingest has not yet consumed
the just-written admin-spool file (ingest runs on a separate 2s-poll cycle —
there's no synchronization forcing it to run between pull attempts). That
combination re-satisfies the emit condition and produces a **second**
`source_outage{source:"devbox"}` event for the same continuous outage,
violating the protocol-9 acceptance criterion ("恰 1 条 source_outage(devbox)").
This is a narrow race (crash in a ~sub-millisecond window between two fsync'd
writes) but the acceptance test explicitly checks for exactly-once emission,
so it's worth hardening — e.g. write the state file (or at least
`outage_reported`) atomically *before* calling `emit()`, or use a single
transactional marker.

### M3 — Scope B: tech-solution §2.9 cmux generation/ABA dual-fingerprint logic does not exist anywhere in the tree
Searched `src/ingest/ingest.ts`, `src/ingest/reducer.ts`, `src/ingest/schema.sql`
and the rest of `src/` for `source_generations`, `generation_uuid`, `head_fp`,
`fp_len`, `cursor_tail_fp`, `dev_inode`, and `workstream.jsonl` consumption —
none exist outside of `docs/plans/overload-20260813-tech-solution.md` itself.
`REVIEW-P2.md`'s "areas not reviewed" section lists this as unreviewed
carryover code ("cmux generation/ABA double-fingerprint logic, §2.9") implying
it was expected to exist by that point; it does not, at `HEAD` (`af914e8`) or
in any ancestor commit (`git log --all -p -- src/ingest/schema.sql | grep
generation` is empty). Cross-checking `docs/contracts/p1-freeze.md`/`p2-freeze.md`/
`p3-freeze.md`, none of the three frozen-scope protocols assign an owner to
`workstream.jsonl` ingestion or `source_generations` — cmux only appears as a
**reconciliation** input (`~/.cmuxterm/*-hook-sessions.json`, owned by N6/P2)
and as a documented non-goal at the architecture level
(`docs/plans/...tech-solution.md:16` "非目标（v1）... cmux pi Feed 桥" and
`:123` "v1 不消费 `cmux events` 流（单源）"). So this is most likely a genuine
**scope descope** that was never walked back into a contract update, rather
than a regression introduced by this diff — but it means the §2.9 dual-
fingerprint ABA-closure design (the "双指纹闭合 ABA" the tech-solution
explicitly hardened against R5-B4) has no corresponding implementation or
acceptance coverage anywhere in the delivered system. Flagging for owner
decision: either formally cut §2.9 from scope (update the ledger/tech-solution
non-goals list explicitly), or schedule it as unimplemented work — it should
not keep silently rolling forward as "unreviewed carryover."

---

## MINOR

### m1 — `commandWords()` splitting `--ssh-cmd`/`--rsync-cmd` on whitespace can't express quoted arguments
`src/pull/pull.ts:132-136`

`command.trim().split(/\s+/)` means a configured `--ssh-cmd "/opt/custom ssh"
-F /path with spaces` cannot be expressed (the path-with-spaces case breaks).
Low impact (test-only injection point per contract; real usage is `ssh`/
`rsync` with no arguments), but worth a doc note or `env`-array style config
if it ever needs to carry flags.

### m2 — `install-claude-hooks.sh` `.bak` is overwritten on every settings-changing run, not just the first
`scripts/install-claude-hooks.sh:81-84`

The usage text says "The first install/update in each invocation writes
`<settings>.bak`" but the code takes a fresh backup (`cp -p "$settings"
"$settings.bak"`) any time `$settings` differs from the computed `$tmp`,
including on `--uninstall` runs. In practice this means `.bak` always reflects
the *immediately prior* state rather than the pre-Overload original, so a
second `install` → `uninstall` sequence loses the true pre-Overload backup
(overwritten by the installed-state backup). Given `--uninstall` is
marker-scoped and non-destructive to unrelated keys, this is low risk, but the
usage string over-promises; either fix the doc string or preserve a "first
seen" backup name.

### m3 — `overload-hook.sh` `chmod 700` touches shared parent directories every invocation
`src/hooks/claude/overload-hook.sh:58`

`chmod 700 "$spool_root" "$spool_root/$host"` runs on every single hook
invocation (every lifecycle event, every permission request), re-asserting
permissions on directories shared across all emitters for that host. This is
idempotent and matches the 0700 contract, so not a correctness bug, but it's
an avoidable syscall pair per hook invocation across a fleet of concurrent
Claude sessions (mkdir+chmod races are also harmless here since all are
setting the same mode), and if directory ownership/mode were ever
intentionally loosened by an operator for another reason, this silently
clobbers it back. Note-only; no action required unless perf becomes an issue.

---

## Verified clean (no findings)

- **notify_sink threading** (`src/ingest/ingest.ts`, `src/ingest/reducer.ts`):
  `IngestConfig.notify_sink` → `loadConfig` → `scanOnce(..., notifySink)` →
  `reduceJournal(db, batchSize, notifySink)` → `applyEvent(..., notifySink)` →
  `applyRequestEvent(..., notifySink)` → `INSERT INTO notifications(...,
  sink, ...)` is threaded consistently end to end with a sane default
  (`"osascript"`) at every call site; no dropped parameter, no stale default
  reintroduced partway through the chain.
- **`scripts/maintenance.sh` m6 change**: recon non-zero exit now fires an
  `osascript` notification without swallowing/altering `recon_status` (still
  captured via `$?` inside the `||` block and later exit-code logic
  unaffected) — matches the "一行修改，注明 review m6" contract note and does
  not interact with the watchdog exit path below it.
- **Puller journal-dedup design intent** (`src/pull/pull.ts`): each pull
  process mints a fresh `emitterId` (`overload-pull-<pid>-<8hex>`) and only
  ever writes `seq=1` per process, so cross-run dedup correctly relies on the
  local state file + `sourceOutageOpen()` journal check (not on the
  `journal(host,emitter_id,seq)` UNIQUE constraint, which by design can't
  dedupe across distinct emitter ids) — see M2 above for the one crash-window
  gap in that design, but the overall approach is sound and matches
  `pull.test.ts`'s two dedup assertions.
- **`--delete` omission / transfer include-list** (`src/pull/pull.ts:48-50`):
  rsync invocation correctly omits `--delete` (contract: "仅新增/增长文件
  ...禁 `--delete`") and scopes the include list to `seg-*.ndjson` /
  `active-*.ndjson` only, confirmed by `pull.test.ts`'s "preserves unrelated
  files" test.
- **Hook fail-open discipline** (`src/hooks/claude/overload-hook.sh`): every
  filesystem operation (`mkdir`, `chmod`, the initial `: >"$active"`, and each
  `write_event`) is guarded with `|| exit 0` / `|| return 1`, and the EXIT
  trap correctly discards a zero-byte `active` file rather than sealing an
  empty segment — matches "spool 不可写则静默退出 0" and is exercised by
  `smoke.sh`'s not-a-directory case.
- **`deploy-devbox.sh`**: idempotent, `--dry-run` supported and gated
  correctly, no interpolation of untrusted data into the remote shell
  command strings (both `ssh ... '...'` blocks are static literals; `$REMOTE`
  itself is a fixed local constant `devbox`, not attacker-controlled), matches
  "脚本只准备，不自动对 prime 部署."

---

## Not reviewed (time budget)

- No `bun test` or `test/harness/p3-injections.sh` / `smoke.sh` execution —
  findings above (especially B1 and M2) are from static reading only and
  should be confirmed/refuted by actually running the harnesses.
- `src/pull/pull.test.ts` was read for behavior confirmation but its
  assertions were not executed in this session.
- Did not trace `src/notify/notifier.ts` or `src/cli/overload.ts` (unchanged
  in this diff, out of Scope A's file list, and not re-litigated from
  REVIEW-P2.md).
- Did not re-verify the P2-era `reducer.ts` findings already closed in
  `e3c3ef0` (M1/M2/M3/m4) or m5 (no action) — only the notify_sink threading
  delta on top of that state.
- `launchd/works.earendil.overload.pull.plist` was not inspected (not in the
  Scope A diff's changed-file list; `git diff --stat` shows no changes to it
  since `e4d72d3`).
- Did not verify the actual JSON key names Claude Code emits for a resolved
  `PermissionRequest` (i.e., whether `.permission_response.behavior` /
  `.hookSpecificOutput.decision.behavior` are real fields Claude ever sends on
  a *later* correlated invocation) — B1's fix direction assumes no such
  channel is wired up in the current single-invocation model; if Claude Code
  actually re-invokes hooks per-event with a correlating `request_id` and this
  script simply isn't listening for the second invocation, that would sharpen
  (not change) the finding.

---

## Summary

| Severity | Count |
|---|---|
| BLOCKER | 1 (B1 — PermissionRequest hook blocks + never observes real decision) |
| MAJOR | 3 (M1 rsync/ssh arg-injection guard missing, M2 outage-emit/state-persist race, M3 §2.9 cmux ABA unimplemented) |
| MINOR | 3 (m1 ssh/rsync cmd quoting, m2 install-hooks backup semantics, m3 redundant chmod) |
