# Configuration

All configuration is optional JSON at `~/.overload/config.json`. Invalid or missing values fall back to the implementation defaults and are reported by the relevant process.

| Key | Consumer | Meaning |
| --- | --- | --- |
| `scan_interval_ms` | ingest | Spool scan interval; default `2000`. |
| `reducer_batch_size` | ingest | Maximum journal rows per reducer transaction; default `500`. |
| `cmux_workstream_path` | ingest | cmux workstream file; default `~/.cmuxterm/workstream.jsonl`. |
| `prune_interval_ms` | ingest | How often consumed spool bytes are swept; default `3600000`. |
| `spool_retention_ms` | ingest | How long a fully consumed spool file is kept before the sweep removes it; default `86400000`. Only this host's tree is swept — a pulled tree is a mirror and rsync would refetch it. |
| `web_port` | web | Loopback dashboard port; default `4870`. |
| `approval_gate.enabled` | extension | Enables action gate; default `false`. Missing or disabled gate is inert. |
| `approval_gate.block_bash_patterns` | extension | Regex patterns that always deny bash; optional, and win over approval rules. |
| `approval_gate.block_write_paths` | extension | Path prefixes that always deny write/edit; optional, and win over approval rules. |
| `approval_gate.require_approval_bash_patterns` | extension | Regex patterns requiring human approve/deny via loopback mailbox; optional. |
| `approval_gate.require_approval_write_paths` | extension | Path prefixes requiring human approve/deny; optional. |
| `approval_gate.timeout_ms` | extension | Human approval timeout; default `1800000`. Timeout denies. |
| `recon_interval_ms` | recon | Reconciliation interval. |
| `drain_grace_ms` | recon | Delay before orphaning a dead emitter's pending requests. |
| `stall_profile_ms` | recon | Silence threshold for a session that is still in `working` state; default `1800000`. Idle sessions are silent by design and are never stalled. |
| `turn_hang_ms` | recon | A `working` turn with no progress event (heartbeat excluded) for this long is reported as `turn_hung`; default `3600000`. Lower it and you start flagging long thinking: measured on this ledger, a 20-minute bound was false 10 times out of 15. |
| `command_timeout_ms` | recon | External adapter and remote process-probe command timeout. |
| `remote_probe_cmd` | recon | Command template used to check process liveness on a non-local ledger host. The default uses batch-mode SSH with a five-second connection timeout. `{host}` and `{pid}` are substituted only after recon validates the host as a safe component and the pid as a positive integer. The command contract is exit `0` = alive, exit `3` = proven absent, and every other exit or timeout = unknown (never dead). |

Remote pull settings are command-line flags to `src/pull/pull.ts`: `--remote`, `--remote-spool`, `--dest`, `--ssh-cmd`, `--rsync-cmd`, `--fail-threshold`, and `--timeout-ms`. Run `bun src/pull/pull.ts --once` with invalid input to print the accepted contract.

The host identity is a separate file: `~/.overload/host`, containing exactly `local` or `devbox`. It is an operator topology label, not a hostname. Most public single-machine installations need no host file.

## Restricted decision bot

Decision bot stays off unless `decision_bot.enabled` is explicitly `true`. Even
then, no target is authorized unless one exact rule matches. Example for one
extension command and one orchestrator repository:

```json
{
  "decision_bot": {
    "enabled": true,
    "model": "codex_gpt/gpt-5.6-sol",
    "timeout_ms": 60000,
    "max_output_bytes": 262144,
    "rules": [
      {
        "id": "release-one-exact-push",
        "consumer_owner": "extension",
        "gate": "action",
        "effect": "push",
        "answers": ["approve"],
        "cwd": "/Users/me/src/example",
        "command": "git push origin refs/heads/release"
      },
      {
        "id": "approve-one-repo-ready-gate",
        "consumer_owner": "orchestrator",
        "gate": "ready",
        "effect": "push_and_create_pr",
        "answers": ["approve"],
        "repo": "/Users/me/src/example"
      }
    ]
  }
}
```

Values are exact, not glob or substring matches. Extension rules require exact
`cwd` plus exact `command` or `path`; orchestrator rules require exact `repo`.
`gate`, `effect`, `consumer_owner`, and proposed answer must also match. A
`ready` approval is consequential: `approve` permits push and PR creation, not
merely acknowledgement. Start with narrower rules or no rules.

```sh
bun src/cli/overload.ts decision-bot status
bun src/cli/overload.ts decision-bot once
bun src/cli/overload.ts decision-bot run
bun src/cli/overload.ts decision-bot disable
bun src/cli/overload.ts decision-bot enable
bun src/cli/overload.ts decision-bot takeover extension <approval_id> <answer>
bun src/cli/overload.ts decision-bot takeover orchestrator <approval_id> <answer>
```

`once` performs one bounded poll; `run` polls in foreground. `disable` persists
a mailbox-level stop and invalidates unconsumed bot proposals. `enable` only
clears that persisted stop: it does **not** set `decision_bot.enabled`, create
rules, or grant authority. `takeover` records a human answer for an active
target and invalidates pending bot proposals; use one displayed choice.

Consumed receipt is decision linearization point. Human answer committed before
consume wins; answer after consume receives `already_consumed` and cannot
retract an effect. If extension loses consume response or dies after receipt
creation, execution is `unknown` and is not automatically retried. Bot is a
same-UID workflow boundary, not an OS security sandbox.
