# Overload launchd jobs

These definitions assume the checkout is at `~/ai/overload` and Bun is at
`~/.bun/bin/bun`. Edit the plist command strings first if either path differs.
Nothing in this directory installs itself.

The four active jobs are:

- `works.earendil.overload.ingest`: keepalive ingest loop.
- `works.earendil.overload.maintenance`: 60-second recon + watchdog interval.
- `works.earendil.overload.pull`: 60-second devbox spool pull (`src/pull/pull.ts --once`).
- `works.earendil.overload.web`: keepalive web dashboard server (`src/web/server.ts`, binds `127.0.0.1`).

When the Now zone (pending decisions + hung turns) transitions from empty to non-empty, the maintenance job emits one aggregated macOS notification via `osascript`. No per-event notifications are sent while Now remains non-empty. Inspect Q1 in the loopback dashboard for details.

The watchdog depends on the ingest loop touching
`~/.overload/ingest.heartbeat`; it does not create that heartbeat itself.

## Install

Run from the repository root:

mkdir -p "$HOME/Library/LaunchAgents"
cp launchd/works.earendil.overload.ingest.plist "$HOME/Library/LaunchAgents/"
cp launchd/works.earendil.overload.maintenance.plist "$HOME/Library/LaunchAgents/"
cp launchd/works.earendil.overload.pull.plist "$HOME/Library/LaunchAgents/"
cp launchd/works.earendil.overload.web.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.web.plist"
```

## Uninstall

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.web.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist"
rm -f "$HOME/Library/LaunchAgents/works.earendil.overload.web.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"

The installer also stops and removes any legacy `works.earendil.overload.notifier` job.
```

