# Overload

Overload is a local-first macOS attention control plane for agent work. It turns agent lifecycle noise into a small set of timely, actionable human decisions, preserves the original context, and lets work resume after a decision. Append-only SQLite telemetry, classification, stale-session detection, and the loopback dashboard serve that goal.

It is designed for a single operator managing local and SSH-reachable agent sessions. It is not a hosted service or a multi-user control plane. The ingest path is one-way: telemetry only, never a channel back into an agent. Two opt-in paths do write back, and both are disabled until you turn them on. The pi-family extension's `approval_gate` pauses a matching bash/write/edit call in any session that installed the extension and waits for a human answer from the loopback answers mailbox. The optional `src/orchestrator/` module launches its own `pi` children and gates them the same way. Both surface as ordinary Now decisions. These gates are a **workflow** boundary, not a security boundary: on a single-UID machine any same-UID process can bypass them. Product and engineering decisions follow [AGENTS.md](AGENTS.md).

## Status

The supported v0 surface is the Bun/SQLite ingest pipeline, CLI, recon, pull, and loopback dashboard. Pending decisions are read from the dashboard; when the Now zone goes from empty to non-empty, the maintenance job emits one aggregated macOS notification (`osascript`), never per-event.
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
convention is unverified; see docs/integrations.md).

Confirm the install at any time, including after a `bun` upgrade or moved
checkout:

```sh
bun src/cli/overload.ts doctor
```

See [docs/integrations.md](docs/integrations.md) for adapter-specific behavior and [docs/operations.md](docs/operations.md) for lifecycle management.

## Commands

```sh
bun src/cli/overload.ts sessions
bun src/cli/overload.ts q1
bun src/cli/overload.ts hung
bun src/cli/overload.ts jump <stable_id|request_uid>
bun src/cli/overload.ts ack <request_uid>...
bun src/cli/overload.ts doctor
bun src/cli/overload.ts audit
bun src/cli/overload.ts audit --sample 20 --since 24h
```

`audit` is a read-only, deterministic report over recent journal evidence. It
shows gated decisions, consequential tool classes, captured `HANDOFF.md`
status, human-wait dwell, pass rate, repeated failure patterns, and suggested
approval rules. `--sample N` limits the most recently active sessions (`0`
means all); `--since` accepts a duration such as `7d`, `24h`, or milliseconds.
Settled handoffs with `partial` or `blocked` status, or non-zero
`uncertainties`, remain in the Inbox for human follow-up; complete,
zero-uncertainty handoffs are archived normally.

The CLI covers the same decision path as the dashboard: list what needs a human,
reach that terminal, and acknowledge. Rows go to stdout and headings to stderr,
so `q1 2>/dev/null | cut -f1 | xargs ... ack` is the shell equivalent of the
dashboard's multi-select 批量 Ack.

Q1 **Ack** changes only Overload's local request state to `acked`. Pending
decisions are shown in the loopback dashboard; it does not emit macOS
notifications or approve, deny, answer, resume, or otherwise unblock the
originating agent.

The CLI covers the same decision path as the dashboard: list what needs a human,
reach that terminal, and acknowledge. Rows go to stdout and headings to stderr,
so `q1 2>/dev/null | cut -f1 | xargs ... ack` is the shell equivalent of the
dashboard's multi-select 批量 Ack.

Q1 **Ack** changes only Overload's local request state to `acked`. Pending decisions are shown in the loopback dashboard; it does not emit macOS notifications or approve, deny, answer, resume, or otherwise unblock the originating agent.

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
              CLI            loopback dashboard
```

The ledger is append-only at the source-event layer; current queues are derived projections.

## Uninstall

```sh
scripts/install-launchd.sh --uninstall
scripts/install-extension.sh --uninstall
```

Uninstalling services preserves `~/.overload/`. Remove that directory manually only when you intend to discard local history.

## License

[MIT](LICENSE), copyright © 2026 luw2007.

## Security and contributions

Read [SECURITY.md](SECURITY.md) before reporting vulnerabilities and [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.
