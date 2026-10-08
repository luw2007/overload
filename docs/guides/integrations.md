# Integrations

## Channel startup safety

Managed channel deployment must opt in explicitly; ordinary authorization entries do not acquire a strict approval policy implicitly. Set `OVERLOAD_REQUIRED_RUNTIME_CONFIG_CHATS` to a comma-separated list of chat IDs and `OVERLOAD_RUNTIME_APPROVAL_ROOT` to an absolute, existing server-owned directory. There is no historical `/tmp` root fallback. Startup validates configuration before opening a channel or starting a runtime.

Every authorization entry for a required chat must supply `runtimeConfigPath`. Its JSON must enable `approval_gate`, provide nonempty `require_approval_write_paths` and `allowed_write_roots`, and include the exact `.*` rule in `block_bash_patterns` (all bash is banned). Both root lists must name canonical absolute existing directories inside the server approval root, using directory boundaries rather than string prefixes. Approval write roots must cover every allowed write root. Missing, malformed, disabled, escaping, or conflicting per-chat configurations fail startup closed. Config file aliases are resolved to their canonical file path; two entries for a chat must agree on that path. Non-required chats retain general approval-gate semantics, including absent/disabled gates and optional rules; strict deployment constraints are not imposed on them.

When a stopped conversation is restored, the daemon passes its current per-chat policy through the runtime restore interface. Required sessions restore only when persisted strict metadata matches the current canonical config path and approval root, and the current config passes strict validation before any replacement spawn. Legacy metadata missing the required flag/config/root and policy rotations are rejected, with queued messages retained and a runtime-unavailable response. There is no automatic authority migration: after safely resolving the old process, explicitly start a new session under the current policy instead of editing broker metadata. Ordinary non-required runtime restore behavior is unchanged.

The daemon acquires an OS `flock` lock for the case-sensitive, trimmed Feishu app ID before starting work. App IDs accept ASCII letters, digits, `_`, and `-`. Locks require Linux and use the fixed OS per-UID namespace `/run/user/<uid>/overload-channel-locks`, not `userInfo().homedir` or any deployment directory. `HOME`, `XDG_RUNTIME_DIR`, `TMPDIR`, database paths, and instance overrides cannot select another lock namespace; there is no public lock-root override or fallback to `/tmp`. Non-Linux platforms fail closed explicitly.

Before creating the lock directory, the daemon validates each ancestor (`/run`, `/run/user`, and `/run/user/<uid>`): each must be a directory, not a symbolic link (`lstat`), canonical (`realpath(path) === path`), owned by the expected user (`root` for `/run` and `/run/user`, the daemon's UID for `/run/user/<uid>`), and must not be group- or world-writable (`(mode & 0o022) === 0`). A canonical mount at `/run` or `/run/user` is permitted, but symbolic links or path aliases fail closed. The lock directory `/run/user/<uid>/overload-channel-locks` is created private with mode `0700` owned by the user, and lock files (`<app_id>.lock`) are created regular, single-link, mode `0600`, opened with `O_NOFOLLOW`.

The lock directory is managed under the systemd-logind user runtime directory lifecycle (`/run/user/<uid>`). Because logind tears down this runtime directory when user sessions end, headless or unattended boot services must have systemd user lingering enabled (`loginctl enable-linger <user>`). The `flock` lock exists only for the lifetime of the daemon process: parent exit or pipe close releases the lock, and locks are not durable across reboot. Lock files are never unlinked on release because replacing an inode would allow concurrent holders. Competing consumers fail startup nonblockingly.

Verify prerequisites with preflight commands before starting the daemon:

```bash
# Check systemd user linger and runtime path
loginctl show-user $(id -u) -p Linger -p RuntimePath -p State

# Validate ancestor ownership, permissions, and symlink status
stat -c '%F %u %a %n' /run /run/user /run/user/$(id -u)
test "$(readlink -f /run)" = "/run"
test "$(readlink -f /run/user)" = "/run/user"
test "$(readlink -f /run/user/$(id -u))" = "/run/user/$(id -u)"
```

Consumers of the same app must share the OS runtime directory: do not isolate them in unshared mount namespaces where `/run/user/<uid>` diverges. Never remove the namespace directory or replace/delete its lock inodes while any holder exists. Cut over all consumers together to this fixed namespace; old home-based or `/tmp`-based locking code does not contend with it, and protection is not retroactive.

For a fresh independent deployment, provision a new private runtime JSON and authorization file; do not overwrite a legacy deployment's files. Use canonical paths obtained from the deployment filesystem, not the example path verbatim:

```json
{
  "web_port": 14870,
  "approval_gate": {
    "enabled": true,
    "allowed_write_roots": ["/absolute/canonical/deployment/acceptance-repo"],
    "require_approval_write_paths": ["/absolute/canonical/deployment/acceptance-repo"],
    "block_bash_patterns": [".*"]
  }
}
```

Set `OVERLOAD_RUNTIME_APPROVAL_ROOT` to that canonical repository directory, `OVERLOAD_REQUIRED_RUNTIME_CONFIG_CHATS` to the explicitly authorized chat, and that authorization row's `runtimeConfigPath` to the new JSON file. Keep the daemon and runtime extension release consistent; the required policy is server-injected and persisted on new sessions/restores. Existing live legacy sessions are not upgraded by editing configuration. Keep this deployment stopped until the operator has reconciled every known app consumer and any unidentifiable consumer; the lock does not retroactively exclude old code.

## Contract-bound multi-agent coordinator

Add `workId` only to the authorized conversation entry that shall coordinate an existing active, operator-approved Work. The contract must identify the runtime repository, explicit allowed effects (`read` for scout, `write` for ship), a retry limit, and acceptance criteria. `OVERLOAD_COORDINATOR_PORT` defaults to loopback `4891`. Entries without `workId` remain ordinary private tasks in the same conversation database; an existing conversation cannot be rebound to a different Work. Run one channel daemon/websocket consumer for the app, routing the dedicated test group and production private conversations through their explicit `appId`/`instanceId`/`tenantId`/`userId`/`chatId` entries.

The root pi session receives only read/search tools and four bound tools: `coordinator_dispatch`, `coordinator_status`, `coordinator_review`, `coordinator_deliver`. The daemon drives the existing orchestrator with owned pi workers in isolated worktrees; no cmux installation is required for coordinator workers. Scout workers have read-only tools and persist their final text as a report. Ship workers make local committed changes and supply `orchestrator.check`; push and merge are not automatic.

Actionable worker transitions durably enqueue a root-session wakeup exactly once; ordinary progress does not invoke a model. Successful supervisor wakeups are not forwarded as chat noise. Reviews pin the child attempt, current contract, artifact paths and content hashes. Local reviewed children release repository occupancy, but only final operator acceptance completes the root Work. Final acceptance/rejection is available through the original channel card and Web decision route. Evidence is rechecked before delivery; worker self-report alone is insufficient.

Broker metadata now records broker and child process identities. Automatic recovery requires both recorded identities to be dead; missing legacy evidence or a surviving child fails closed. Terminated owned sessions restore the same session file; unknown turns are never automatically resubmitted. This mode does not upgrade existing live brokers in place.

## Feishu channel and owned pi runtime

Run `bun install` once, then `bun src/adapters/daemon.ts`. The daemon uses the official `@larksuiteoapi/node-sdk` WebSocket long connection; no public inbound port or webhook reverse proxy is required. Set `FEISHU_APP_FILE` to a mode-0600 JSON file containing exactly `{ "app_id": "cli_…", "app_secret": "…" }`, or set `FEISHU_APP_ID` and `FEISHU_APP_SECRET` directly. Set `FEISHU_INSTANCE_ID`, `OVERLOAD_RUNTIME_CWD`, and `OVERLOAD_CHANNEL_AUTH_FILE`. The authorization file is a JSON array of `{ "instanceId": "…", "tenantId": "…", "userId": "…", "ownerId": "…" }` mappings. Keep credentials outside the repository.

Each authorization entry also requires `appId` and `chatId`. Authorization matches the configured application, instance, tenant, user, and chat together; it does not authorize the same user in other chats. Unknown senders receive an access-denied reply rather than being silently enrolled or forwarded to the Agent.

The built-in registry selects `feishu` and `pi` by default; override only with `OVERLOAD_CHANNEL` and `OVERLOAD_RUNTIME` when another built-in choice exists. Group messages require an explicit bot mention; direct messages are accepted. Each root message binds its own thread. The same `OVERLOAD_ANSWERS_PATH` is used by the channel daemon and Web control database. Select the actual pi provider/model with `OVERLOAD_PI_PROVIDER` and `OVERLOAD_PI_MODEL`; pi owns provider credentials.

`Conversations` displays durable queued turns; sending text never approves a request or steers an active turn. Send `/cancel` in the bound conversation to request cancellation; pending native approvals are closed first, the runtime cancellation result is retained, and no turn is automatically retried. Native select/confirm requests create existing control attention items, consume human mailbox receipts, and update the original Feishu card. Unknown sends are not automatically retried. Temporary known delivery errors have five attempts. The owned Unix-socket broker preserves a running pi process across control reconnection; channel shutdown detaches, not terminates the Agent.

Pi completion is determined by `agent_settled`, not prompt acceptance or a single `agent_end`. Native confirmation can precede prompt acceptance; decision delivery remains active during that wait. `/cancel` keeps subsequent turns fenced as unknown until effects are inspected; Runtime idle is not proof that detached processes stopped. `PiRuntime.shutdown(reference)` explicitly terminates the owned pi child; closing a session handle only detaches the control connection.

Native select/confirm receipts verify answer delivery and subsequent runtime completion, not arbitrary tool effects or business acceptance. The existing Overload extension's HTTP `approval_gate` remains a separate protocol; do not treat native UI confirmation as proof that those tool approvals have been delivered through Feishu. Runtime input/editor requests currently remain unknown rather than silently fabricating answers.

Deployment acceptance remains separate: SDK construction and local fake-credential failures do not establish real tenant connectivity, event subscriptions, card callback permissions, or successful model execution. Real verification requires a Feishu self-built app configured for persistent WebSocket event/callback subscription, IM message and card-action permissions, an authorized tenant/user mapping, and credentials provisioned in `FEISHU_APP_FILE`. Input/editor dialogs remain unknown rather than exposed as structured approvals; no successful continuation is claimed for these dialogs.

## pi, omp, and prime-agent

`src/extension/overload.ts` uses the compatible pi-family extension API. Install it in the relevant runtime extension directory. It writes lifecycle, ask, heartbeat, tool-activity, and commit-observation events to the local spool.

The extension is observational except for two write-back paths. First, it always registers an answerable `ask` tool: on omp it overrides the built-in `ask`, on pi it sits beside the bundled `ask_user` (a same-name extension tool would stop pi from starting). The terminal dialog keeps the built-in semantics — multi-select, `header`, `recommended`, "Other" free text, Esc cancels the ask — and for a single-question, single-choice ask the terminal races the loopback answers mailbox: the first answer wins, and a Decide-page answer unblocks the agent. Multi-select and multi-question asks stay terminal-only. Restart the runtime after `scripts/install-extension.sh --install`; a running process keeps the previous extension code. Second, its optional `approval_gate` is disabled by default; block rules deny locally, while require-approval rules pause bash/write/edit until a human answers through the loopback answers mailbox. Approve falls through to normal execution and command rewrites; deny or timeout blocks. Overload does not resume agents it did not launch; the mailbox is the only human-to-agent answer channel.

When a session's bash tool spawns another agent CLI (`pi`, `omp`,
`prime-agent`, `claude`) as a simple command, the extension prefixes
`OVERLOAD_PARENT=<stable_id>` so the child records this session as its
parent. Compound commands (pipes, substitution, quoting wrappers) are
never rewritten; dispatch templates own env injection there.

### Handoff packet

When an agent finishes a run it may leave a `HANDOFF.md` in the session's
working directory. The extension reads it on `agent_end` and attaches a
summary to the `settled` event; Overload never writes or edits the file.
Only a file modified during the current run counts, so a stale packet from
an earlier session in the same directory is ignored.

The parser looks for these lines, in any order, each as `KEY: value` (a
dash or em-dash also works as the separator):

```
TASK: one line describing the work
STATUS: complete | partial | blocked
NEXT_OWNER: who should pick this up
UNCERTAINTIES:
- one open question per line
- the block ends at the next KEY line or the end of the file
```

`STATUS` values other than the three above are recorded as `unknown`.
`UNCERTAINTIES` is counted, not quoted; the card shows the number and the
file path so the reader opens the packet only when the count is non-zero.
Other sections (`OUTPUT`, `SOURCES`, `DECISIONS`, prose) are left for the
human and not parsed.

A `partial` or `blocked` status, or any uncertainty, routes the session to
Inbox with reason `handoff_blocked`; that reason survives session exit
because the exit does not make the decision. A `complete` packet with no
uncertainties is archived silently.

## Claude Code

Claude Code sessions are observed only through cmux's workstream file. The
dedicated Claude Code hook was removed: it could record a permission request
but had no durable response channel, so a local Q1 acknowledgement never
decided the prompt.



## Terminal hosts and Recon platforms

The pi-family extension records a local cmux host at session start when `CMUX_SURFACE_ID` is available, retaining its opaque surface ID and `/dev/tty` fallback. The dashboard uses that host target before any Recon attachment, so direct pi/OMP sessions launched in cmux do not depend on a cwd match.

Recon still discovers Orca, HerdR, and cmux platform sessions. Those attachment bindings are external-platform evidence used for liveness and outage handling; they are separate from terminal hosts and remain the dashboard fallback when no host context exists.

The dashboard's **Open** action focuses a local cmux host pane by its opaque surface ID. Sessions without a supported, precise target show `暂无可跳转目标`; the UI does not present a nonfunctional Open action. Treat all identifiers as opaque.

Orca worktrees carrying `parentWorktreeId` contribute `orca:<id>` lineage:
a session whose origin is still `unknown` at attachment time adopts it as
its origin, so agent-spawned worktrees classify as agent work.

## Remote spool pull

The optional pull job copies a remote spool through SSH and `rsync`. Configure the remote, spool path, destination, command paths, failure threshold, and timeout as CLI flags to `src/pull/pull.ts` (see [configuration.md](configuration.md)). `scripts/deploy-devbox.sh` installs the pi/omp extension onto a reachable remote host over SSH; set `OVERLOAD_REMOTE` (and optionally `OVERLOAD_HOST_ID`) to target a host other than the default.

## Context handoff

The owner (or the Manager) can forward context to a live pi/omp/prime session as a `collaboration_brief_v0` (`POST /api/handoff`). Receiver semantics:

- It is **not a priority change** and **not an interruption**: the create receipt always reports `priority_changed:false, todo_created:false, execution_interrupted:false`. The current turn is never blocked.
- On `before_agent_start` the Overload extension fetches `GET /api/handoff/pending?target_kind=session&target_id=<stable_id>` (1500 ms deadline, failures silent), attaches unseen briefs to the prompt as context, and marks them read. The `handoff_inbox` tool lists them on demand.
- The receiving agent decides itself with `handoff_ack {request_id, decision: adopt|defer|reject|no_change, reason}`; a `defer` may later be re-acknowledged.
- `handoff_conclude {request_id, kind: decision|conclusion, text}` records one immutable conclusion, which is queued back to the origin (`GET /api/handoff/returns?destination_kind=manager_conversation&destination_id=owner`, or `attention_item` + item id). A second conclusion is rejected with 409.
- Unconcluded requests expire after 7 days. Inspect with `overload handoff list [state]` / `overload handoff show <id>`.
