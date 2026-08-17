# Integrations

## pi, omp, and prime-agent

`src/extension/overload.ts` uses the compatible pi-family extension API. Install it in the relevant runtime extension directory. It writes lifecycle, ask, heartbeat, tool-activity, and commit-observation events to the local spool.

The extension is observational. Its optional local pre-tool denylist is disabled by default; Overload never remotely approves or resumes an agent.

## Claude Code

Use `scripts/install-claude-hooks.sh`. It merges only marker-owned Overload hook entries into `~/.claude/settings.json`, keeps a `.bak` before the first change, and removes only those entries with `--uninstall`.

Claude hook events may record pending permission requests, but the hook has no durable response channel. A local Q1 acknowledgement does not decide the Claude permission prompt.

## cmux, herdr, and orca

Recon and jump support depend on the installed CLI/file contracts for these tools. A missing CLI or unavailable source is surfaced as a source incident rather than treated as an empty session list.

The dashboard's **Open** action may focus a local terminal through `herdr`, `cmux`, or `orca`. If it cannot, the UI falls back to copying the opaque attachment binding. Treat bindings as identifiers, not commands to paste into a shell.

## Remote spool pull

The optional pull job copies a remote spool through SSH and `rsync`. Configure the remote, spool path, destination, command paths, failure threshold, and timeout in `~/.overload/config.json`; see [configuration.md](configuration.md). The stock `scripts/deploy-devbox.sh` is an operator-specific helper, not a public installation path.
