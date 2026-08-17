# Operations

## LaunchAgents

Install supported services from any checkout location:

```sh
scripts/install-launchd.sh --install
```

The installer writes five user LaunchAgents: ingest, notifier, maintenance, pull, and web. It derives absolute paths for the current checkout and `bun`, so moving or upgrading the checkout requires a reinstall:

```sh
scripts/install-launchd.sh --uninstall
scripts/install-launchd.sh --project-dir /absolute/path/to/overload --install
```

Preview affected files without changing the system:

```sh
scripts/install-launchd.sh --dry-run
```

The experimental Island panel is intentionally excluded.

## Extension

`src/extension/overload.ts` must be present in each pi-family runtime's
extension directory to emit lifecycle telemetry. Install or remove it for
the local pi/omp runtimes with:

```sh
scripts/install-extension.sh --install
scripts/install-extension.sh --uninstall
```

Restart the runtime after installing; extensions load at process start
only. Prime is intentionally excluded — its extension-directory convention
is unverified. For a devbox, use `scripts/deploy-devbox.sh` instead (scp
over SSH rather than a local copy).

`scripts/setup.sh [--dry-run]` runs `install-launchd.sh`,
`install-extension.sh`, and (best-effort, skipped without `jq`)
`install-claude-hooks.sh` in one pass.

## Health and diagnosis

```sh
bun src/cli/overload.ts health
bun src/cli/overload.ts q1
bun src/cli/overload.ts doctor
```

The watchdog relies on `~/.overload/ingest.heartbeat`. Service stdout and stderr are in `/tmp/overload-*.{log,err}`. An unavailable remote source or integration becomes a visible incident; do not delete ledger rows to clear it.

`doctor` is a read-only checklist (never installs or fixes anything): ledger
reachability, pi/omp extension presence, all five LaunchAgent states,
ingest/pull heartbeat freshness, whether recorded session activity is
actually live (cross-checked against `telemetry_gap` evidence — the
signature of a missing extension), and `~/.overload` permissions. Each line
is `OK`, `WARN`, or `FAIL`; the command exits 1 if anything is `FAIL`.

## Backup and reset

Stop the LaunchAgents before copying `~/.overload/ledger.db` and spool data. SQLite WAL state matters, so copy `ledger.db`, `ledger.db-wal`, and `ledger.db-shm` together when present. Retain sealed NDJSON segments as the source-event replay record.

To remove services without deleting history, run `scripts/install-launchd.sh --uninstall`. To reset history, first stop services, then remove `~/.overload/` deliberately.
