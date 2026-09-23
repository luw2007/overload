# Integrations

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

The extension is primarily observational. Its optional `approval_gate` is disabled by default; block rules deny locally, while require-approval rules pause bash/write/edit until a human answers through the loopback answers mailbox. Approve falls through to normal execution and command rewrites; deny or timeout blocks. Overload does not resume agents it did not launch; the mailbox is the only human-to-agent answer channel.

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

The optional pull job copies a remote spool through SSH and `rsync`. Configure the remote, spool path, destination, command paths, failure threshold, and timeout in `~/.overload/config.json`; see [configuration.md](configuration.md). `scripts/deploy-devbox.sh` installs the pi/omp extension onto a reachable remote host over SSH; set `OVERLOAD_REMOTE` (and optionally `OVERLOAD_HOST_ID`) to target a host other than the default.
