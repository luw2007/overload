# Overload launchd jobs

The `.plist` files in this directory are **reference templates only** — they
contain placeholder paths and are not installed directly. The real plists are
generated with absolute paths by `scripts/install-launchd.sh`, which also
creates the `app.overload.*` labels and writes them to
`~/Library/LaunchAgents`.

The four active jobs are:

- `app.overload.ingest`: keepalive ingest loop.
- `app.overload.maintenance`: 60-second recon + watchdog interval.
- `app.overload.pull`: 60-second remote spool pull (`src/pull/pull.ts --once`).
- `app.overload.web`: keepalive web dashboard server (`src/web/server.ts`, binds `127.0.0.1`).

The optional `app.overload.orchestrator` job is installed only with
`scripts/install-launchd.sh --with-orchestrator`; it is not part of default
setup.

When the Now zone (pending decisions + hung turns) transitions from empty to
non-empty, the maintenance job emits one aggregated macOS notification via
`osascript`. No per-event notifications are sent while Now remains non-empty.
Inspect Q1 in the loopback dashboard for details.

The watchdog depends on the ingest loop touching
`~/.overload/ingest.heartbeat`; it does not create that heartbeat itself.

## Install

Run from repository root:

```sh
scripts/install-launchd.sh --install
```

Pass `--project-dir /path/to/overload` if running from outside the checkout.
Pass `--with-orchestrator` to include the optional orchestrator job. The
installer locates `bun` on `PATH` and writes absolute paths into the generated
plists.

## Uninstall

```sh
scripts/install-launchd.sh --uninstall
```

The installer also unloads and removes any leftover jobs from older reverse-DNS
label prefixes (`*.overload.*.plist`) left by previous installs.
