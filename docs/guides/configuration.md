# Configuration

All configuration is optional JSON at `~/.overload/config.json`. Invalid or missing values fall back to the implementation defaults and are reported by the relevant process.
An explicitly injected `OVERLOAD_CONFIG_PATH` must remain readable: a missing file seals the extension's bash/write/edit gate rather than reverting to optional default configuration. Only an absent default `~/.overload/config.json` is inert.

Required channel sessions carry server-selected `requiredApprovalGate: true` and a canonical `approvalRoot` through start, broker metadata, and restore. The broker injects `OVERLOAD_REQUIRED_APPROVAL_GATE=1` and `OVERLOAD_RUNTIME_APPROVAL_ROOT` only for these sessions, clearing inherited authority for ordinary sessions. Required starts reject existing metadata with a different config path, root, or missing required flag. At session load the extension independently revalidates the file: missing, malformed, absent or disabled gates seal all bash/write/edit calls. Required gates need nonempty canonical `allowed_write_roots` and `require_approval_write_paths` contained in the server root, approval paths covering every allowed root, and the literal `.*` in `block_bash_patterns` to deny all bash. A bash approval-only rule is insufficient. This catches a file weakened after daemon validation; ordinary unmarked legacy configurations retain their optional gate behavior.

Reconnect and restore receive the current server-selected policy for the conversation, not authorization inferred from old broker metadata. Before submitting another turn to an existing session (including a still-live broker or cached handle), and before spawning a replacement, required metadata must have `requiredApprovalGate: true` and exactly match the current canonical config file and approval root; the current strict config is revalidated using the same runtime policy check. A successful live socket connection is continuity evidence, not approval authority. Legacy metadata without these fields, missing current authority, ordinary-to-required transitions, or config/root rotation is refused before submission rather than silently migrated or downgraded; queued messages are retained and the channel receives the policy error. Resolve the previous process safely, then explicitly start a fresh session under the current policy when needed; do not hand-edit historical metadata to grant authority. Ordinary sessions without a required gate retain their existing reconnect and restore semantics. Runtimes without policy validation remain compatible only for ordinary sessions.


| Key | Consumer | Meaning |
| --- | --- | --- |
| `scan_interval_ms` | ingest | Spool scan interval; default `2000`. |
| `reducer_batch_size` | ingest | Maximum journal rows per reducer transaction; default `500`. |
| `cmux_workstream_path` | ingest | cmux workstream file; default `~/.cmuxterm/workstream.jsonl`. |
| `prune_interval_ms` | ingest | How often consumed spool bytes are swept; default `3600000`. |
| `spool_retention_ms` | ingest | How long a fully consumed spool file is kept before the sweep removes it; default `86400000`. Only this host's tree is swept — a pulled tree is a mirror and rsync would refetch it. |
| `journal_max_rows` | ingest | Maximum rows retained across the hot and archive journal tables; default `1000000`. Capacity pruning never deletes unprojected rows, discards the oldest projected `heartbeat` rows first, and removes at most one bounded batch per pass so a large backlog cannot hold a long write lock. |
| `web_port` | web | Loopback dashboard TCP port, integer `1..65535`; resolved as `web_port` > `OVERLOAD_WEB_PORT` > `4870`. Out-of-range config or environment values are reported and ignored. Prefer this key: it is the only one the extension also reads when it resolves the control-plane port, and a LaunchAgent never sees the environment variable. The dashboard's main surface is Now / Inbox / Done Attention; Q1–Q5 are internal classifications reachable only from the diagnosis pages. |
| `runner_instructions` | orchestrator | Standing project rules appended to every runner brief, as a string or array of strings; default none. They are placed after the contract and the evidence gate and are explicitly subordinate to both, so they cannot license a child to skip committing or to push. Bounded at 20 entries and 4000 characters total; the excess is dropped with a log line. |
| `approval_gate.enabled` | extension | Enables action gate; default `false`. Missing or disabled gate is inert. |
| `approval_gate.block_bash_patterns` | extension | Regex patterns that always deny bash; optional, and win over approval rules. |
| `approval_gate.block_write_paths` | extension | Path prefixes that always deny write/edit; optional, and win over approval rules. |
| `approval_gate.require_approval_bash_patterns` | extension | Regex patterns requiring human approve/deny via loopback mailbox; optional. |
| `approval_gate.require_approval_write_paths` | extension | Path prefixes requiring human approve/deny; optional. |
| `approval_gate.allowed_write_roots` | extension | Optional array of absolute, existing canonical directory paths. When present, write/edit paths resolve relative to the tool context cwd, including missing targets via their nearest existing ancestor. Outside roots (including symlink and sibling-prefix escapes) or unresolvable paths are denied; every inside write/edit requires approval regardless of `require_approval_write_paths`. An empty array denies all writes. Invalid enabled configuration fails closed for bash/write/edit. Omission preserves legacy prefix semantics. |
| `approval_gate.timeout_ms` | extension | Human approval timeout; default `1800000`. Timeout denies. |
| `recon_interval_ms` | recon | Reconciliation interval. |
| `drain_grace_ms` | recon | Delay before orphaning a dead emitter's pending requests. |
| `stall_profile_ms` | recon | Silence threshold for a session that is still in `working` state; default `1800000`. Idle sessions are silent by design and are never stalled. |
| `turn_hang_ms` | recon | A `working` turn with no progress event (heartbeat excluded) for this long is reported as `turn_hung`; default `3600000`. Lower it and you start flagging long thinking: measured on this ledger, a 20-minute bound was false 10 times out of 15. |
| `command_timeout_ms` | recon | External adapter and remote process-probe command timeout. |
| `remote_probe_cmd` | recon | Command template used to check process liveness on a non-local ledger host. Recon runs it once per host, substituting validated `{host}` and a comma-separated `{pids}` list (legacy `{pid}` receives the same list). Exit `0` and exit `1` are both resolved answers and must print the live PIDs on stdout — exit `1` with no output means every probed PID is gone, which is what `ps -p` reports. Every other exit or a timeout is unknown, never dead. |

### recon CLI flags（覆盖配置）
- `--herdr-cmd <path>`：覆盖 herdr 可执行文件路径
- `--orca-cmd <path>`：覆盖 orca 可执行文件路径
- `--cmux-sessions-file <path>`：覆盖 cmux sessions 文件路径

### audit CLI flags
- `--since <dur>`：时间窗，后缀 `ms|s|m|h|d`（如 `7d`、`24h`、`30m`、`5000ms`）；裸数字按毫秒。见 `src/cli/audit.ts:113`。

### Manage（外部 Session 纳管与交接）
- `manage.freshness_ms`：交接前置门禁的新鲜度阈值，默认 120,000 ms（2 分钟）；超过该时长无事件的 running 执行判 stale，禁止同目录续跑。

## Session view window (env var)

`sessions`, the Inbox (`q2`), the Done/archive surface, and the `zombie` view show only sessions whose last event falls within the last 30 days. History is filtered, never deleted: old sessions stay in the journal and are reachable through `show <stable_id>`, `jump`, and the closeout workflow.

| Env var | Default | Meaning |
| --- | --- | --- |
| `OVERLOAD_SESSION_WINDOW_DAYS` | `30` | Session-view lookback in days. Any non-positive or unparseable value falls back to 30. |

Not windowed, by design: Q1 pending requests (decisions waiting on you), `hung` turns (currently stuck), open incidents, explicit single-session lookups (`show`), and write operations.

Remote pull settings are command-line flags to `src/pull/pull.ts`: `--remote`, `--remote-spool`, `--dest`, `--ssh-cmd`, `--rsync-cmd`, `--fail-threshold`, and `--timeout-ms`. Run `bun src/pull/pull.ts --once` with invalid input to print the accepted contract.

The host identity is a separate file: `~/.overload/host`, containing exactly `local` or `devbox`. It is an operator topology label, not a hostname. Most public single-machine installations need no host file.

## Manager (read-only attention steward)

`/manager`, `POST /api/manager/ask` and `overload manager ask "<question>"` answer "what should I decide first, why, and what can wait" from a bounded, redacted evidence snapshot. The manager runs through the same restricted `pi --no-tools` runner as the decision bot: no shell, no writes, no repository reads. It never approves, executes or reprioritizes anything.

```json
{
  "manager": {
    "model": "provider/model-name",
    "timeout_ms": 90000,
    "max_output_bytes": 262144,
    "stale_after_ms": 86400000
  }
}
```

`OVERLOAD_MANAGER_MODEL` overrides `manager.model`. Without a model every ask is stored as `unavailable` (`manager_model_not_configured`); no answer is fabricated. Only one turn runs at a time (a second ask returns `409 manager_busy` until the running turn finishes or exceeds `timeout_ms`). A failed turn is recorded as `本轮未完成：<reason>。不会自动重放。` and is never retried automatically.

```sh
bun src/cli/overload.ts manager ask "现在我该先决什么？"
bun src/cli/overload.ts manager turns [limit]
bun src/cli/overload.ts manager context
bun src/cli/overload.ts manager read attention|follow_up|works|waits|sessions|done|targets [cursor]
```

## Advanced: Restricted Decision Bot (default frozen)

The automatic Decision Bot is frozen out of the default product entry and main UI. The settings below exist only for operators who explicitly enable advanced automatic decisions. The human mailbox, human answers, and `decision-bot takeover` work without enabling the bot at all.

Decision bot stays off unless `decision_bot.enabled` is explicitly `true`. Even
then, no target is authorized unless one exact rule matches. Example for one
extension command and one orchestrator repository:

```json
{
  "decision_bot": {
    "enabled": true,
    "model": "provider/model-name",
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
bun src/cli/overload.ts decision-bot takeover extension <approval_id> <answer>   # common: human takeover, no bot needed
bun src/cli/overload.ts decision-bot takeover orchestrator <approval_id> <answer> # common: human takeover, no bot needed
bun src/cli/overload.ts decision-bot status   # diagnostic/maintenance only
bun src/cli/overload.ts decision-bot once     # diagnostic/maintenance only
bun src/cli/overload.ts decision-bot run      # diagnostic/maintenance only
bun src/cli/overload.ts decision-bot disable  # diagnostic/maintenance only
bun src/cli/overload.ts decision-bot enable   # diagnostic/maintenance only
```

Only `takeover` is part of ordinary use: it records a human answer for an active
target and invalidates pending bot proposals; use one displayed choice, and it
requires no bot enabled. The rest are diagnostic/maintenance for an operator who
has opted the bot in: `once` performs one bounded poll; `run` polls in
foreground. `disable` persists a mailbox-level stop and invalidates unconsumed
bot proposals. `enable` only clears that persisted stop: it does **not** set
`decision_bot.enabled`, create rules, or grant authority.

Consumed receipt is decision linearization point. Human answer committed before
consume wins; answer after consume receives `already_consumed` and cannot
retract an effect. If extension loses consume response or dies after receipt
creation, execution is `unknown` and is not automatically retried. Bot is a
same-UID workflow boundary, not an OS security sandbox.
