# Overload launchd jobs

These definitions assume the checkout is at `~/ai/overload` and Bun is at
`~/.bun/bin/bun`. Edit the plist command strings first if either path differs.
Nothing in this directory installs itself.

The four jobs are:

- `works.earendil.overload.ingest`: keepalive ingest loop.
- `works.earendil.overload.notifier`: keepalive macOS notification sink.
- `works.earendil.overload.maintenance`: 60-second recon + watchdog interval.
- `works.earendil.overload.pull`: 60-second devbox spool pull (`src/pull/pull.ts --once`).

The watchdog depends on the ingest loop touching
`~/.overload/ingest.heartbeat`; it does not create that heartbeat itself.

## Install

Run from the repository root:

```sh
mkdir -p "$HOME/Library/LaunchAgents"
cp launchd/works.earendil.overload.ingest.plist "$HOME/Library/LaunchAgents/"
cp launchd/works.earendil.overload.notifier.plist "$HOME/Library/LaunchAgents/"
cp launchd/works.earendil.overload.maintenance.plist "$HOME/Library/LaunchAgents/"
cp launchd/works.earendil.overload.pull.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.notifier.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
```

## Uninstall

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.notifier.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist"
rm -f "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.notifier.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
```
