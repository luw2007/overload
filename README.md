# Overload

Overload is a local-first macOS attention control plane for agent work. It compresses agent lifecycle noise into a small set of timely, actionable human decisions. The unit of user work is an Attention item, split into **Now** (act now), **Inbox** (batch later), and **Done** (decided or archived). The Feishu channel projects the same Attention items as cards, and card decisions write back to the local authoritative state — Feishu is an I/O channel, not the source of truth. Append-only SQLite telemetry, classification, stale-session detection, and the loopback dashboard serve that goal.

It is designed for a single operator managing local and SSH-reachable agent sessions. It is not a hosted service or a multi-user control plane. The ingest path is one-way: telemetry only, never a channel back into an agent. Two opt-in paths do write back, and both are disabled until you turn them on. The pi-family extension's `approval_gate` pauses a matching bash/write/edit call in any session that installed the extension and waits for a human answer from the loopback answers mailbox. The optional `src/orchestrator/` module launches its own `pi` children and gates them the same way. Both surface as ordinary Now decisions. These gates are a **workflow** boundary, not a security boundary: on a single-UID machine any same-UID process can bypass them. Product and engineering decisions follow [AGENTS.md](AGENTS.md).

On runtimes exposing an abort signal to extensions, cancelling an approval wait interrupts polling and requests version-checked closure of the mailbox target before returning. Closed targets reject late answers and consumption. If closure cannot be confirmed (including an already-consumed approval), the tool remains blocked and cancellation is reported as unconfirmed; an approval receipt is not evidence that execution succeeded. HTTP waits are bounded. Runtime cancellation does not roll back earlier effects or guarantee termination of detached processes.

## Status

The supported v0 surface is the Bun/SQLite ingest pipeline, CLI, recon, pull, and loopback dashboard. The operator works Now / Inbox / Done Attention items. Pending decisions are read from the dashboard; when the Now zone goes from empty to non-empty, the maintenance job emits one aggregated macOS notification (`osascript`), never per-event. The automatic Decision Bot and the Orchestrator are optional advanced features, off by default.
## Requirements

- macOS 13+ for the supported launchd workflow
- Optional integrations as needed: pi, omp, or prime-agent; Claude Code; `cmux`; `herdr`; `orca`; SSH and `rsync` for a remote spool

The dashboard listens exclusively on `127.0.0.1:4870`. Do not proxy or bind it to a shared network without adding authentication and reviewing the security boundary.

## Quick start

```sh
cd /path/to/overload
bun test
scripts/setup.sh --install
bun src/cli/overload.ts doctor
open http://127.0.0.1:4870
```

`scripts/setup.sh` composes the standalone installers below; each also runs
on its own and accepts `--dry-run` to preview without changing the system:

```sh
scripts/install-launchd.sh --install     # ingest, maintenance, pull, web LaunchAgents
scripts/install-extension.sh --install   # pi/omp lifecycle telemetry; restart the runtime after
```

The optional orchestrator LaunchAgent (`src/orchestrator/`) is installed only
with `scripts/install-launchd.sh --install --with-orchestrator`.

No installer sets up a prime-agent extension (its extension-directory
convention is unverified; see docs/guides/integrations.md).

Confirm the install at any time, including after a `bun` upgrade or moved
checkout:

```sh
bun src/cli/overload.ts doctor
```

See [docs/guides/integrations.md](docs/guides/integrations.md) for adapter-specific behavior and [docs/guides/operations.md](docs/guides/operations.md) for lifecycle management.

## Commands

The user-facing commands operate on Attention items (Now / Inbox / Done):

```sh
bun src/cli/overload.ts now                 # items needing a decision now
bun src/cli/overload.ts inbox               # items that can wait; batch later
bun src/cli/overload.ts done                # decided or archived
bun src/cli/overload.ts attention <id>                 # inspect one card
bun src/cli/overload.ts attention <id> ack|defer|resolve
bun src/cli/overload.ts works
bun src/cli/overload.ts candidates|candidate <id>
bun src/cli/overload.ts work create|revise|redirect|stop
bun src/cli/overload.ts mgmt scan|works|show|track
bun src/cli/overload.ts context purge --actor <id>
bun src/cli/overload.ts sessions
bun src/cli/overload.ts jump <stable_id|request_uid>
bun src/cli/overload.ts ack <request_uid>...
bun src/cli/overload.ts doctor
bun src/cli/overload.ts audit

# 诊断命令（内部分类）：q1 | q4 | hung | zombie | health
```

Lower-level queue diagnostics (`q1`, `q4`, `hung`, `zombie`, `health`) are internal classifications for maintenance, not the primary interface. The shell equivalent of the dashboard's multi-select Ack is `q1 2>/dev/null | cut -f1 | xargs ... ack`.

Q1 **Ack** changes only Overload's local request state to `acked`; it never answers or unblocks the originating agent. Decisions that carry an answer (approve/deny on a registered gate) submit through the card button or a human takeover (below). Plain asks without an answer consumer remain jump/deep-link-only.

`audit` is a read-only, deterministic report over recent journal evidence. It
shows gated decisions, consequential tool classes, captured `HANDOFF.md`
status, human-wait dwell, pass rate, repeated failure patterns, and suggested
approval rules. `--sample N` limits the most recently active sessions (`0`
means all); `--since` accepts a duration such as `7d`, `24h`, or milliseconds.
Settled handoffs with `partial` or `blocked` status, or non-zero
`uncertainties`, remain in the Inbox for human follow-up; complete,
zero-uncertainty handoffs are archived normally.

To record a human answer to a gated target without enabling any bot:

```sh
bun src/cli/overload.ts decision-bot takeover extension <approval_id> <answer>
```

The automatic decision bot itself is a frozen advanced feature. See
[Advanced / optional features](#advanced--optional-features) and
[decision bot configuration](docs/guides/configuration.md#advanced-restricted-decision-bot-default-frozen).

## Data and privacy

Overload stores runtime state under `~/.overload/`, including a SQLite ledger and NDJSON spool. Depending on enabled adapters, this can contain local working directories, branch names, session summaries, request metadata, tool activity, commit SHAs, and terminal bindings.

The project redacts common token patterns before writing events. That is damage reduction, not a complete DLP guarantee. Keep `~/.overload/`, logs, and raw event payloads private; do not attach them to public issues.

## Architecture

```text
agent extensions / cmux workstream / recon
                         │
                         ▼
             ~/.overload/spool/*.ndjson
                         │
                         ▼
          ingest + reducer → ~/.overload/ledger.db
                         │
               ┌─────────┴───────────┐
               ▼                     ▼
              CLI      loopback dashboard (Now / Inbox / Done Attention)
```

The ledger is append-only at the source-event layer; current queues are derived projections. The loopback dashboard and CLI read the same Attention data. The Feishu channel projects the same Attention items as cards and posts card answers back; it is an input/output channel, never authoritative state — the local control DB is. The Orchestrator (`src/orchestrator/`) is an optional producer of Now decisions, installed only with `--with-orchestrator`.

## Uninstall

```sh
scripts/install-launchd.sh --uninstall
scripts/install-extension.sh --uninstall
```

Uninstalling services preserves `~/.overload/`. Remove that directory manually only when you intend to discard local history.

## Advanced / optional features

These are not part of the default product surface. They exist, are kept compatible with existing data, but are off until explicitly configured.

### Automatic Decision Bot (frozen by default)

The automatic Decision Bot is frozen out of the default product entry and main UI. It only runs after an explicit `decision_bot` object in `~/.overload/config.json` contains a model and exact rules; each rule must bind `consumer_owner`, gate, effect, allowed answers, and exact repo/cwd plus command or path scope. It runs `pi` ephemerally with no tools, extensions, skills, prompt templates, context files, or saved session, treats output as an untrusted proposal, and revalidates policy and source state at consume time. Human answers committed before consume win; after a receipt is consumed the API returns a conflict rather than claiming retroactive cancellation. This is a same-UID workflow boundary, not an OS sandbox.

The human mailbox, human answers, and `decision-bot takeover` work without enabling the bot. The bot's own lifecycle commands (`run`, `once`, `status`, `enable`, `disable`) are diagnostic/maintenance only. See [configuration](docs/guides/configuration.md#advanced-restricted-decision-bot-default-frozen).

### Orchestrator

`src/orchestrator/` launches its own `pi` children and gates them as ordinary Now decisions. It ships in source but is not installed, run, or depended on by default; the optional LaunchAgent is written only with `scripts/install-launchd.sh --install --with-orchestrator`.

## License

[MIT](LICENSE), copyright © 2026 luw2007.

## Security and contributions

Read [SECURITY.md](SECURITY.md) before reporting vulnerabilities and [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.
