# macOS deployment runbook

First deployment of an Overload checkout to a Mac. Derived by reading `scripts/setup.sh`,
`scripts/install-launchd.sh`, `scripts/install-extension.sh`, `scripts/maintenance.sh`,
`src/cli/doctor.ts` and `src/notify/nudge.ts` — not from prior deployment experience. Nobody
has run this sequence on a Mac yet; every claim below cites the file it came from so a
surprise can be traced.

Day-to-day operation is [operations](operations.md); tunables are
[configuration](configuration.md). This file covers only the first install, its verification
and its rollback.

> **Notification mode stays `shadow`.** Installing must not perform the §6 cutover. The default
> is `shadow` and the installers set nothing that could change it — see
> [Notification mode](#5-notification-mode) for the proof.

## 1. Prerequisites

### Hard requirements — the install stops without these

| What | Checked by | Failure |
|---|---|---|
| macOS with `launchctl` | `install-launchd.sh:49` | **Loud.** `launchctl is required (macOS only)`, exit 1 |
| `bun` on `PATH` | `install-launchd.sh:50` | **Loud.** `bun is required; install it before running this script`, exit 1 |
| A real checkout | `install-launchd.sh:40-41` | **Loud.** `not an Overload checkout: <dir>`, exit 2 — requires both `src/ingest/ingest.ts` and `scripts/maintenance.sh` |
| `src/extension/overload.ts` present | `install-extension.sh:34` | **Loud.** `missing extension: <path>`, exit 1 |

`bun`'s resolved absolute path is baked into every plist (`install-launchd.sh:51`, `:84`), so
**moving the checkout or replacing bun requires a reinstall**, not a restart.

**bun version: nothing enforces one.** `package.json` has no `engines` field and no script
checks a version. The integrated tree was verified on **bun 1.4.2**. A too-old bun therefore
fails at daemon runtime, not at install time — check `bun --version` yourself first.

### Runtime dependency

`@larksuiteoapi/node-sdk@1.73.3` is the only entry in `package.json` dependencies. Run
`bun install` in the checkout.

**None of the four installed LaunchAgents need it.** Only `src/adapters/feishu.ts` imports the
SDK; `ingest`, `pull`, `recon`, `waits/cli` and `notify/nudge` never reach `src/adapters/`, and
`src/web/server.ts` imports only `src/adapters/store.ts`, which has no SDK import. The SDK
matters if you run the Feishu adapter daemon (`src/adapters/daemon.ts`, not a LaunchAgent), and
it matters for the test suite — `src/adapters/feishu.test.ts` fails at module load without
`node_modules` and reports as one failing file rather than N skipped tests.

### Test-only, not deploy

**Python 3 with `playwright` and a Chromium browser** is needed *only to run the test suite on
the Mac*. No deploy-time check uses it: `src/web/ui-regression.test.ts`,
`src/web/ask-answer-card.test.ts` and `src/web/waits.test.ts` spawn
`python3 -c <script>` with `from playwright.sync_api import sync_playwright`. There is **no
skip guard** — the probe throws `browser probe failed (<code>): <stderr>`, so it fails loudly,
but it fails the suite rather than skipping. If you do not intend to run `bun test` on the Mac,
you do not need Playwright.

### Directories

| Path | Created by | Mode |
|---|---|---|
| `~/Library/LaunchAgents` | `install-launchd.sh:105` (`mkdir -p`) | umask default |
| `~/.overload/logs` | `install-launchd.sh:105` (`mkdir -p`) | umask default |
| `~/.overload` | **`ingest` at first run**, `src/ingest/ingest.ts:84-85` | `0700`, forced |
| `~/.overload/ledger.db` | `ingest`, `src/ingest/ingest.ts:91-95` | `0600`, forced |
| `~/.pi/agent/extensions`, `~/.omp/agent/extensions` | `install-extension.sh:46-47` | `0700` |

The installer does **not** set `0700` on `~/.overload` — `ingest` does, on its first run. So
`doctor`'s `permissions:dir` / `permissions:db` checks can only pass after ingest has started
once. A `WARN` there immediately after install is expected, not a defect.

Service logs: `/tmp/overload-{ingest,maintenance,pull,web}.{log,err}`
(`install-launchd.sh:87-88`). Only the optional orchestrator logs into `~/.overload/logs/`.

### Environment variables — read this before setting any

**The plists set exactly two: `OVERLOAD_ROOT` and `OVERLOAD_BUN`** (`install-launchd.sh:84`).
launchd agents do not inherit your login shell environment, so **anything you export in
`.zshrc` never reaches the daemons.** Every other variable takes its compiled-in default. To
change one for a service you must edit its plist and re-bootstrap; that is a deliberate
configuration change, not a deployment step.

Defaults as they will actually apply on a fresh install:

| Variable | Default in the daemons | Source |
|---|---|---|
| `OVERLOAD_ROOT` | the checkout dir | set by installer |
| `OVERLOAD_BUN` | absolute path to `bun` | set by installer |
| `OVERLOAD_LEDGER_PATH` | `~/.overload/ledger.db` | `src/cli/overload.ts:25`, `src/cli/doctor.ts:31` |
| `OVERLOAD_ANSWERS_PATH` | `~/.overload/orchestrator-answers.db` | `src/web/server.ts` `startWebServer`, `src/waits/cli.ts:30`, `src/cli/mgmt.ts:9` |
| `OVERLOAD_WEB_PORT` | unset → `4870`, unless `config.json` sets `web_port` | `src/web/server.ts` `loadWebConfig` (see below) |
| `OVERLOAD_NOTIFICATION_MODE` | **`shadow`** | `src/notify/nudge.ts:304`, `:382` |
| `OVERLOAD_NOTIFICATION_PRIMARY` | `macos` | `src/notify/nudge.ts:306` |
| `OVERLOAD_NOTIFICATION_OWNER` | `maintenance` | `src/notify/nudge.ts:292`, `:308` |
| `OVERLOAD_NOTIFICATION_OWNER_EPOCH` | `phase-a-shadow-1` | `src/notify/nudge.ts:293`, `:314` |
| `OVERLOAD_NOTIFICATION_EXPIRES_SOON_MS` | `900000` | `src/notify/nudge.ts:322` |
| `OVERLOAD_NOTIFICATION_MAX_ATTEMPTS` | `3` | `src/notify/nudge.ts:323` |
| `OVERLOAD_CONDITION_WAITS` | unset → observer **disabled** | `scripts/maintenance.sh:91-92` |
| `OVERLOAD_RECON_TIMEOUT_MS` | `45000` | `scripts/maintenance.sh:11` |
| `OVERLOAD_OBSERVER_TIMEOUT_MS` | `5000`, hard-capped at 5000 | `scripts/maintenance.sh:16-22` |
| `OVERLOAD_ACTOR` | unset | `src/cli/overload.ts:83` |

`OVERLOAD_ACTOR` is an operator concern, not a service one: `attention … resolve` on a
context-bearing or owner-bearing item exits 1 with
`error: context decision requires --actor or OVERLOAD_ACTOR` (`src/cli/overload.ts:90-93`), and
`context purge` always requires it (`:113-114`). Pass `--actor` or export it in your own shell.

**The web port: `config.json` first, `OVERLOAD_WEB_PORT` second.** `loadWebConfig`
(`src/web/server.ts`) resolves the dashboard port as `web_port` from
`~/.overload/config.json` > `OVERLOAD_WEB_PORT` > `4870`, and `startWebServer` binds
`127.0.0.1` only. Neither an unusable env value (non-numeric, empty, `0`, negative,
fractional) nor an unreadable or invalid `config.json` stops the listener: each is reported
once per process on stderr and the next source in the chain wins —
`overload web: ignoring invalid OVERLOAD_WEB_PORT "abc"` from `envPort`,
`overload web: ignoring invalid config <path>` from `warnInvalidConfig`. Under launchd that
stderr is `/tmp/overload-web.err` and nowhere else.

**Prefer `config.json` on this deploy**, for two reasons:

- **launchd never sees the environment variable.** The plists carry only `OVERLOAD_ROOT` and
  `OVERLOAD_BUN` (`install-launchd.sh:84`), so exporting `OVERLOAD_WEB_PORT` in your shell does
  not move the dashboard the `web` agent runs. It moves a `bun src/web/server.ts` you start by
  hand, which is what the fallback is for.
- **The extension only reads `config.json`.** `loadApprovalGate` in
  `src/extension/overload.ts` takes the control-plane port from `web_port` and never looks at
  the environment. Move the port with the env var alone and the extension keeps posting
  answerable-ask and approval-gate traffic to `127.0.0.1:4870` while the dashboard listens
  elsewhere.

`src/adapters/daemon.ts` also reads `OVERLOAD_WEB_PORT`, for the adapter daemon's own
dashboard. That is a separate process from the `web` LaunchAgent and not part of this install.

## 2. Command sequence

```sh
bun --version                     # 1. expect >= 1.4.2; nothing enforces this
cd /absolute/path/to/overload
bun install                       # 2. the one runtime dependency
sh scripts/setup.sh --dry-run     # 3. preview, changes nothing
sh scripts/setup.sh               # 4. the install
# 5. restart pi and omp so they load the extension
# 6. wait ~60s for the first maintenance and pull ticks
bun src/cli/overload.ts doctor    # 7. verify
```

**2 — `bun install`.** Correct: `+ @larksuiteoapi/node-sdk@1.73.3` on a cold cache, or
`Checked 52 installs across 53 packages (no changes)` when already present.

**3 — dry run.** Prints the labels and paths it *would* touch, then exits 0 without requiring
`launchctl` or `bun` (`install-launchd.sh:45-47`, `:94-103`). Six lines on a Mac: four agents
plus two extension targets. Any `remove-legacy …` lines are leftover `works.*.overload.*.plist`
jobs from an older prefix that the real run will boot out and delete
(`install-launchd.sh:98-101`, `:107-111`) — expected on an upgrade, suspicious on a virgin Mac.

**4 — install.** `setup.sh` composes the two installers in order (`setup.sh:31-32`). Correct
output, in order:

```
Installed Overload LaunchAgents from /absolute/path/to/overload
installed Overload extension for pi and omp (restart each runtime to load it)

Setup complete. Verify with:
  bun /absolute/path/to/overload/src/cli/overload.ts doctor
```

`setup.sh` runs under `set -eu`, so a failure in `install-launchd.sh` stops before the
extension step. Four `launchctl bootstrap` calls happen silently
(`install-launchd.sh:112-118`); `bootstrap` printing anything is a problem.

There is **no `--with-orchestrator` path through `setup.sh`** — it always passes a bare
`--install` (`setup.sh:28`). To include the optional orchestrator agent, run
`scripts/install-launchd.sh --with-orchestrator --install` directly instead of step 4.

**5 — restart pi/omp.** The extension is copied, not hot-loaded (`install-extension.sh:48-51`).
Until both runtimes restart, no session telemetry is emitted and `doctor`'s
`telemetry:liveness` will not go OK.

**6 — wait.** `maintenance` and `pull` are `StartInterval` 60s jobs (`install-launchd.sh:73-74`).
`heartbeat:ingest` fails above 30s old and `heartbeat:pull` warns above 90s
(`src/cli/doctor.ts:53-54`). Running `doctor` immediately after install reports failures that
resolve themselves within about a minute.

## 3. Verification — what `doctor` does and does not check

`bun src/cli/overload.ts doctor` runs twelve independent read-only checks
(`src/cli/doctor.ts:152-165`) and exits 1 if **any** is `FAIL`. `WARN` does not affect the exit
code. A healthy first install, once ingest has run and the runtimes have restarted:

```
[OK] ledger: /Users/<you>/.overload/ledger.db
[OK] extension:pi: /Users/<you>/.pi/agent/extensions/overload.ts
[OK] extension:omp: /Users/<you>/.omp/agent/extensions/overload.ts
[OK] launchd:ingest: running
[OK] launchd:web: running
[OK] launchd:maintenance: last run succeeded
[OK] launchd:pull: last run succeeded
[OK] heartbeat:ingest: 3s old
[OK] heartbeat:pull: 41s old
[OK] telemetry:liveness: last session event 2m ago
[OK] permissions:dir: 0700
[OK] permissions:db: 0600
```

Acceptable variations on a brand-new install: `launchd:maintenance` / `launchd:pull` as
`loaded, not yet run` (`:100-101`), and `telemetry:liveness` as `WARN … no session events
recorded (no corroborating activity evidence — may just be idle)` until an agent session
actually runs. That WARN becomes a `FAIL` when `telemetry_gap` rows prove a live agent process
was seen but emitted nothing — that specific message means the extension is missing or the
runtime was not restarted (`:126-131`).

### What `doctor` does not cover

Checked deliberately against `runDoctor`; each of these is a real blind spot on this deploy.

- **Notification configuration and shadow output.** Nothing in `doctor` reads any
  `OVERLOAD_NOTIFICATION_*` variable or the `control_notification_shadow` table. See the silent
  failure in §5. The table itself is readable with `bun run src/notify/shadow-report.ts`, which
  prints one JSON line (`compared`, `false_negatives`, `duplicates`, `unlinked_attention`) over
  the control database and writes nothing but the idempotent schema ensure. That is the
  contract's §6 step 2 inspection, not a deploy check — useful once shadow rows exist, not on
  the day of install.
- **That the web server answers.** It checks launchd `state = running` (`:88-93`), never an HTTP
  request to the dashboard port (`4870` by default). A process that is up but failing every
  request reports `OK`.
- **The orchestrator agent.** Not in `KEEPALIVE_LABELS` (`:52`) and not given an interval check,
  so even a `--with-orchestrator` install leaves it entirely unverified.
- **The Feishu adapter daemon.** Not a LaunchAgent at all; outside `doctor`'s model.
- **The control database.** `checkLedger` opens `ledger.db` only (`:63-71`). A missing or corrupt
  `~/.overload/orchestrator-answers.db` — which the web surface, waits and mgmt all use — is not
  detected.
- **`config.json` validity.** An invalid file — and an unusable `OVERLOAD_WEB_PORT` — is
  ignored with one stderr line at server start (`warnInvalidConfig` / `envPort` in
  `src/web/server.ts`); `doctor` never looks, so a typo'd `web_port` shows up only as the
  dashboard being on `4870` and as a line in `/tmp/overload-web.err`.
- **bun's version.**
- **Extension freshness.** `checkExtension` only stats for existence (`:73-78`), so a stale copy
  from a previous checkout reports `OK`. After upgrading, rerun
  `scripts/install-extension.sh --install` rather than trusting this check.

## 4. Rollback

```sh
sh scripts/install-launchd.sh --uninstall     # boots out and removes all five plists
sh scripts/install-extension.sh --uninstall   # removes both extension copies
# restart pi and omp to drop the already-loaded extension
```

`--uninstall` iterates `all_labels`, so it removes the orchestrator plist too whether or not it
was installed, plus any legacy `works.*.overload.*.plist`
(`install-launchd.sh:59`, `:107-111`, `:121-125`). Expect `Removed Overload LaunchAgents` and
`removed Overload extension for pi and omp`.

**`setup.sh` has no `--uninstall`** — it accepts only `--dry-run` and `--help`
(`setup.sh:19-24`). There is no single-command rollback; call both installers.

### What rollback leaves behind

Nothing in either uninstall path touches state. All of this survives and will be reused by a
later reinstall:

- `~/.overload/ledger.db` and its `-wal` / `-shm` sidecars
- `~/.overload/orchestrator-answers.db` — the control database: works, contracts, attention,
  mailbox, notification shadow rows
- `~/.overload/config.json`, `nudge.state` (`src/notify/nudge.ts:425`),
  `watchdog.state` (`scripts/watchdog.sh:6`)
- `~/.overload/ingest.heartbeat`, `~/.overload/pull.heartbeat`, `~/.overload/logs/`
- `/tmp/overload-*.log` and `/tmp/overload-*.err`
- `~/.pi/agent/extensions/` and `~/.omp/agent/extensions/` themselves — only the `overload.ts`
  file inside each is removed

To reset to a genuinely clean state you must remove `~/.overload` by hand. **That destroys the
Phase A shadow data**, which A17 needs; take a copy first.

## 5. Notification mode

**Confirmed from the code: a fresh install runs in `shadow`, and nothing in the install path
can change that.**

Three independent facts:

1. `OVERLOAD_NOTIFICATION_MODE` defaults to `"shadow"` when unset —
   `src/notify/nudge.ts:304` and `:382`, both `env.OVERLOAD_NOTIFICATION_MODE ?? "shadow"`.
2. The installers never set it. The only `EnvironmentVariables` written into any plist are
   `OVERLOAD_ROOT` and `OVERLOAD_BUN` (`install-launchd.sh:84`), and neither `setup.sh` nor
   `install-extension.sh` writes environment anywhere.
3. launchd agents do not inherit the login shell, so even
   `export OVERLOAD_NOTIFICATION_MODE=send` in `.zshrc` would not reach the `maintenance` job
   that runs `nudge` (`scripts/maintenance.sh:99`).

The value is also fail-closed rather than fail-open: only `shadow` and `send` are accepted, and
anything else throws (`nudge.ts:305`). `OVERLOAD_NOTIFICATION_OWNER_EPOCH` is required *only*
when mode is `send` (`:311-312`); in shadow it defaults to `phase-a-shadow-1` (`:293`, `:314`).
Cutover is therefore a deliberate two-variable edit to the maintenance plist, which is what the
owner-gated §6 procedure is for. **Do not perform it as part of this deploy.**

> **Silent failure worth knowing.** `scripts/maintenance.sh:99` runs
> `"$BUN" "${ROOT}/src/notify/nudge.ts" || true` — nudge is best-effort and never fails the
> maintenance job. A rejected `OVERLOAD_NOTIFICATION_MODE` value throws (`nudge.ts:305`), the
> `|| true` swallows it, `maintenance` still exits 0, and `doctor` reports
> `[OK] launchd:maintenance: last run succeeded`. The only evidence is
> `/tmp/overload-maintenance.err`. **After any notification-configuration change, read that file
> — `doctor` will not tell you.**

## 6. What the Linux dry run proves, and what it cannot

Validated in the integration worktree on Linux:

```
$ sh scripts/setup.sh --dry-run
note: launchctl not found; the real run requires macOS
install app.overload.ingest /home/luwei.will/Library/LaunchAgents/app.overload.ingest.plist
install app.overload.maintenance /home/luwei.will/Library/LaunchAgents/app.overload.maintenance.plist
install app.overload.pull /home/luwei.will/Library/LaunchAgents/app.overload.pull.plist
install app.overload.web /home/luwei.will/Library/LaunchAgents/app.overload.web.plist
install /home/luwei.will/.pi/agent/extensions/overload.ts
install /home/luwei.will/.omp/agent/extensions/overload.ts
$ echo $?
0
```

Exit 0, with the missing-`launchctl` note on stderr. (`note: bun not found` would be a second
line; bun is present here.)

**Proved:** argument parsing in both scripts, the checkout validation, that `setup.sh` composes
the two installers in the documented order, the exact label set and target paths, and that the
off-macOS preview path works at all — that last is t-0005's fix; before it, `--dry-run` exited 1
off macOS.

**Not proved, and unverifiable from Linux:**

- **No plist is written or parsed.** The dry run returns at `install-launchd.sh:102`, before
  `write_plist` ever runs. XML escaping, the generated schedule keys and `plutil -lint`
  (`:91`, itself conditional on `plutil` existing) are untested by it. `test/launchd-contract.test.ts`
  does parse plists on Linux with its own reader, keeping `plutil` as a macOS-only agreement
  check — but it reads the checked-in `launchd/*.plist` **templates**, which are not the files
  `write_plist` generates (the templates go through `/bin/sh -lc` and `$OVERLOAD_BUN`, the
  generated ones name bun's absolute path directly). A green suite says nothing about the plist
  that actually lands in `~/Library/LaunchAgents`.
- **No `launchctl` call happens.** `bootstrap`, `bootout`, and the `launchctl print` parsing
  that every `doctor` launchd check depends on (`src/cli/doctor.ts:80-86`) are entirely
  unexercised. This is the largest untested surface in the deploy.
- **The printed paths are string interpolation, not validation.** `$HOME/Library/LaunchAgents`
  is printed on a Linux box where it does not exist. A correct-looking dry run says nothing
  about the destination being real or writable.
- **`bun`'s absolute path is not resolved.** `bun_path` is only computed on the non-dry branch
  (`:50-51`), so the value that ends up in the plists is never previewed.
- **Nothing about runtime.** Whether the agents stay up, whether ingest creates `~/.overload`
  at `0700`, whether macOS notifications are permitted for the shadow-mode path, and whether
  `doctor` returns OK are all first observable on the Mac.

Treat the first Mac install as the real test. Run `doctor`, then read
`/tmp/overload-maintenance.err` and `/tmp/overload-ingest.err` before declaring it healthy.
