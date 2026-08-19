# Integrations

## pi, omp, and prime-agent

`src/extension/overload.ts` uses the compatible pi-family extension API. Install it in the relevant runtime extension directory. It writes lifecycle, ask, heartbeat, tool-activity, and commit-observation events to the local spool.

The extension is observational. Its optional local pre-tool denylist is disabled by default; Overload never remotely approves or resumes an agent.

When a session's bash tool spawns another agent CLI (`pi`, `omp`,
`prime-agent`, `claude`) as a simple command, the extension prefixes
`OVERLOAD_PARENT=<stable_id>` so the child records this session as its
parent. Compound commands (pipes, substitution, quoting wrappers) are
never rewritten; dispatch templates own env injection there.

## Claude Code

Use `scripts/install-claude-hooks.sh`. It merges only marker-owned Overload hook entries into `~/.claude/settings.json`, keeps a `.bak` before the first change, and removes only those entries with `--uninstall`.

Claude hook events may record pending permission requests, but the hook has no durable response channel. A local Q1 acknowledgement does not decide the Claude permission prompt.

On session start the hook records parent lineage when available: a subagent
transcript path (`…/<parent-session>/subagents/agent-*.jsonl`) yields the
parent Claude session's stable id, else a non-empty `OVERLOAD_PARENT`
environment value is recorded verbatim.

## Terminal hosts and Recon platforms

The pi-family extension records a local cmux host at session start when `CMUX_SURFACE_ID` is available, retaining its opaque surface ID and `/dev/tty` fallback. The dashboard uses that host target before any Recon attachment, so direct pi/OMP sessions launched in cmux do not depend on a cwd match.

Recon still discovers Orca, HerdR, and cmux platform sessions. Those attachment bindings are external-platform evidence used for liveness and outage handling; they are separate from terminal hosts and remain the dashboard fallback when no host context exists.

The dashboard's **Open** action focuses a local cmux host pane by its opaque surface ID. Sessions without a supported, precise target show `暂无可跳转目标`; the UI does not present a nonfunctional Open action. Treat all identifiers as opaque.

Orca worktrees carrying `parentWorktreeId` contribute `orca:<id>` lineage:
a session whose origin is still `unknown` at attachment time adopts it as
its origin, so agent-spawned worktrees classify as agent work.

## Remote spool pull

The optional pull job copies a remote spool through SSH and `rsync`. Configure the remote, spool path, destination, command paths, failure threshold, and timeout in `~/.overload/config.json`; see [configuration.md](configuration.md). The stock `scripts/deploy-devbox.sh` is an operator-specific helper, not a public installation path.
