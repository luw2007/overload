# Integrations

## pi, omp, and prime-agent

`src/extension/overload.ts` uses the compatible pi-family extension API. Install it in the relevant runtime extension directory. It writes lifecycle, ask, heartbeat, tool-activity, and commit-observation events to the local spool.

The extension is primarily observational. Its optional local pre-tool denylist (`approval_gate` in the session config) can block or modify bash commands matching configured patterns, but it is disabled by default, deterministic, and never waits for a remote decision. Overload never remotely approves or resumes an agent it did not launch; the optional `src/orchestrator/` module's human gates are scoped to processes it started and are a workflow boundary, not a security boundary.

When a session's bash tool spawns another agent CLI (`pi`, `omp`,
`prime-agent`, `claude`) as a simple command, the extension prefixes
`OVERLOAD_PARENT=<stable_id>` so the child records this session as its
parent. Compound commands (pipes, substitution, quoting wrappers) are
never rewritten; dispatch templates own env injection there.

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

The optional pull job copies a remote spool through SSH and `rsync`. Configure the remote, spool path, destination, command paths, failure threshold, and timeout in `~/.overload/config.json`; see [configuration.md](configuration.md). The stock `scripts/deploy-devbox.sh` is an operator-specific helper, not a public installation path.
