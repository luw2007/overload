# Operations

## LaunchAgents

Install supported services from any checkout location:

```sh
scripts/install-launchd.sh --install
```

The installer writes four user LaunchAgents: ingest, maintenance, pull, and web. It derives absolute paths for the current checkout and `bun`, so moving or upgrading the checkout requires a reinstall:

```sh
scripts/install-launchd.sh --uninstall
scripts/install-launchd.sh --project-dir /absolute/path/to/overload --install
```

Preview affected files without changing the system:

```sh
scripts/install-launchd.sh --dry-run
```

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

`scripts/setup.sh [--dry-run]` runs `install-launchd.sh` and
`install-extension.sh` in one pass.

## Diagnosis

```sh
bun src/cli/overload.ts q1
bun src/cli/overload.ts hung
bun src/cli/overload.ts doctor
```

Every list command writes rows to stdout and headings to stderr, so a selection
can be filtered and piped straight back into `ack`, which takes any number of
request uids and exits non-zero if one of them matched nothing:

```sh
bun src/cli/overload.ts q1 2>/dev/null | cut -f1 | xargs bun src/cli/overload.ts ack
```

`jump <stable_id|request_uid>` focuses the recorded terminal from the shell, the
same action the dashboard's 打开 button performs. It accepts either id because a
pending decision is addressed as a request while a hung turn has no request to
jump from. A session with no recorded binding reports that nothing was ever
observed rather than a failed attempt.

The watchdog relies on `~/.overload/ingest.heartbeat`. Service stdout and stderr are in `/tmp/overload-*.{log,err}`. An unavailable remote source or integration becomes a visible incident; do not delete ledger rows to clear it.

Recon checks process liveness directly for sessions owned by its own host and
uses `remote_probe_cmd` for other ledger hosts. The default SSH command maps
exit `0` to alive and emits exit `3` only after the remote shell successfully
checks both `kill -0` and `ps` and proves the pid absent. OpenSSH connection or
authentication failures (normally exit `255`), timeouts, and every other exit
are unknown, never dead. Remote-probe failures are aggregated per host as
`source_outage` (`host_probe:<host>`) and produce one `source_recovered` when
the probe works again. A dead emitter is drained only after recon checks the
pulled spool tree for that incarnation's host, `spool/<host>/<emitter>`.

`doctor` is a read-only checklist (never installs or fixes anything): ledger
reachability, pi/omp extension presence, the four LaunchAgent states,
ingest/pull heartbeat freshness, whether recorded session activity is
actually live (cross-checked against `telemetry_gap` evidence — the
signature of a missing extension), and `~/.overload` permissions. Each line
is `OK`, `WARN`, or `FAIL`; the command exits 1 if anything is `FAIL`.

`health` reports open incidents plus coverage and telemetry gaps as counts of
distinct affected subjects, not of repeated finding events. Inspect pending
decisions in the loopback dashboard; Overload emits no macOS notifications.

`hung` (and the dashboard's 卡死 tab) lists sessions whose turn stopped
advancing while the process kept heartbeating. Liveness and progress are
separate clocks: heartbeat only proves the process is alive, so a turn is
judged by `last_progress_at`, which moves on `working`, `tool_activity`,
`settled`, and `decision_requested`. Two reasons are reported. `turn_hung`
means progress froze past `turn_hang_ms`. `dead_connection` means recon also
found an established socket bound to an address this host no longer owns —
the signature of a VPN or Wi-Fi change that stranded an in-flight model
request; that connection can never complete, so the turn must be cancelled
and retried. A lost host address shortens the grace period to one minute, so
such turns surface within about a minute instead of after `turn_hang_ms`.

`turn_hang_ms` is tunable against evidence rather than taste, because a
`turn_hung` finding can be falsified after the fact: if the flagged session
emitted progress later, the turn was thinking, not hung. Re-measure before
changing it:

```sh
sqlite3 ~/.overload/ledger.db "
SELECT round(json_extract(h.detail,'\$.hung_ms')/60000.0,0) hung_min,
  CASE WHEN EXISTS (SELECT 1 FROM journal j
    WHERE j.stable_id=json_extract(h.detail,'\$.stable_id')
      AND j.ingest_seq>h.ingest_seq
      AND j.kind IN ('tool_activity','settled','working'))
  THEN 'resumed (false positive)' ELSE 'never resumed' END verdict,
  count(*) FROM journal h WHERE h.kind='turn_hung' GROUP BY 1,2 ORDER BY 1;"
```

`dead_connection` cannot be tuned this way and should not be: it reports
socket evidence, not elapsed time. It stays at a one-minute grace.

Every session id in the dashboard is a link into the 会话 tab's drill-down:
state and queue, the three clocks, incarnation pids, pending asks, and the
recent event timeline with heartbeats removed, so the top row is what the turn
last actually did. The list itself is capped at the 100 most recently active
sessions — it is a launchpad for drill-down, not an inventory. `overload show
<stable_id>` prints the same view.

The ingest loop sweeps the spool once an hour. A file is removed only when it
belongs to this host, is older than `spool_retention_ms`, and its cursor
already covers every byte; an unsealed `active-` file additionally requires
its emitter process to be gone, because a live writer still holds that
descriptor. The journal is the history, so removing consumed transport bytes
loses nothing. Scans stay flat regardless of spool size for the same reason:
a file whose cursor equals its size is never opened.

To remove services without deleting history, run `scripts/install-launchd.sh --uninstall`. To reset history, first stop services, then remove `~/.overload/` deliberately.
