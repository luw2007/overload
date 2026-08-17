# Overload launchd jobs

These definitions assume the checkout is at `~/ai/overload` and Bun is at
`~/.bun/bin/bun`. Edit the plist command strings first if either path differs.
Nothing in this directory installs itself.

The five active jobs are:

- `works.earendil.overload.ingest`: keepalive ingest loop.
- `works.earendil.overload.notifier`: keepalive macOS notification sink.
- `works.earendil.overload.maintenance`: 60-second recon + watchdog interval.
- `works.earendil.overload.pull`: 60-second devbox spool pull (`src/pull/pull.ts --once`).
- `works.earendil.overload.web`: keepalive web dashboard server (`src/web/server.ts`, binds `127.0.0.1`).

**`works.earendil.overload.island`: ⚠️ UNAVAILABLE — do not install.** The native
Island panel (`native/island/`) has an open, unresolved rendering BLOCKER: the
panel goes fully transparent after the first hover-expand→collapse cycle (see
`docs/plans/overload-20260816-island-web-design.md` §7 risk #4 and
`docs/feature-stories.csv` row `ISL-01`). The plist file exists in this
directory for when the bug is fixed, but is intentionally excluded from the
install/uninstall commands below — do not `cp`/`bootstrap` it.

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
cp launchd/works.earendil.overload.web.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.notifier.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.web.plist"
```

## Uninstall

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.web.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.notifier.plist"
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist"
rm -f "$HOME/Library/LaunchAgents/works.earendil.overload.web.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.maintenance.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.notifier.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.ingest.plist" \
  "$HOME/Library/LaunchAgents/works.earendil.overload.pull.plist"
```

## Island (blocked — not installed)

Once `ISL-01` is fixed and re-verified, install it the same way:

```sh
cp launchd/works.earendil.overload.island.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/works.earendil.overload.island.plist"
```
