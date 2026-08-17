# Overload

Overload is a local-first macOS control plane for agent work: it records agent lifecycle events in an append-only SQLite ledger, surfaces pending human decisions, detects stale sessions, and provides a loopback dashboard.

It is designed for a single operator managing local and SSH-reachable agent sessions. It is not a hosted service, a multi-user control plane, or an upstream-agent approval system.

## Status

The supported v0 surface is the Bun/SQLite ingest pipeline, CLI, notifications, recon, pull, and loopback dashboard. The native Swift Island panel is included as experimental source only and **must not be installed**: its hover collapse path has a known rendering defect.

## Requirements

- macOS 13+ for the supported launchd and notification workflow
- [Bun](https://bun.sh/)
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
on its own and accepts `--dry-run` to preview without changing the system
(`install-claude-hooks.sh` has no `--dry-run`; it is idempotent and only
ever touches its own marker-owned hook entries):

```sh
scripts/install-launchd.sh --install     # ingest, notifier, maintenance, pull, web LaunchAgents
scripts/install-extension.sh --install   # pi/omp lifecycle telemetry; restart the runtime after
scripts/install-claude-hooks.sh          # Claude Code hooks
```

None of the installers ever set up the experimental Island panel or a
prime-agent extension (its extension-directory convention is unverified;
see docs/integrations.md).

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
bun src/cli/overload.ts health
bun src/cli/overload.ts doctor
bun src/cli/overload.ts digest
```

Q1 **Ack** changes only Overload's local request state to `cancelled`, stopping its notifications. It does not approve, deny, answer, resume, or otherwise unblock the originating agent.

## Data and privacy

Overload stores runtime state under `~/.overload/`, including a SQLite ledger and NDJSON spool. Depending on enabled adapters, this can contain local working directories, branch names, session summaries, request metadata, tool activity, commit SHAs, and terminal bindings.

The project redacts common token patterns before writing events. That is damage reduction, not a complete DLP guarantee. Keep `~/.overload/`, digests, logs, and raw event payloads private; do not attach them to public issues.

## Architecture

```text
agent extensions / Claude hooks / cmux workstream / recon
                         │
                         ▼
             ~/.overload/spool/*.ndjson
                         │
                         ▼
          ingest + reducer → ~/.overload/ledger.db
                         │
               ┌─────────┼───────────┐
               ▼         ▼           ▼
         notifications  CLI    loopback dashboard
```

The ledger is append-only at the source-event layer; current queues and notifications are derived projections.

## Uninstall

```sh
scripts/install-launchd.sh --uninstall
scripts/install-extension.sh --uninstall
scripts/install-claude-hooks.sh --uninstall  # if installed
```

Uninstalling services preserves `~/.overload/`. Remove that directory manually only when you intend to discard local history.

## License

[MIT](LICENSE), copyright © 2026 luw2007.

## Security and contributions

Read [SECURITY.md](SECURITY.md) before reporting vulnerabilities and [CONTRIBUTING.md](CONTRIBUTING.md) before submitting changes.
