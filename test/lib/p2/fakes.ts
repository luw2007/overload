/**
 * Fake platform CLIs + ledger fixtures for P2 recon/outbox tests.
 *
 * Shapes captured verbatim from docs/research/overload-20260813-probe-findings.md:
 *  - herdr: `herdr agent list --json` → {"result":{"agents":[{terminal_id,
 *    agent_status, pane_id, tab_id, workspace_id, cwd, revision,
 *    state_change_seq}]}}
 *  - orca: `orca worktree ps --json` → [{worktreeInstanceId, worktreeId,
 *    workspaceStatus, status, unread, lastOutputAt, parentWorktreeId, path, …}]
 *  - cmux: `~/.cmuxterm/<agent>-hook-sessions.json` → session→workspace mapping
 *    (an empty mapping `{}` = cmux present but unused).
 *
 * The scripts are tiny `sh` stubs under a temp dir; they never touch real
 * platform state.
 */
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** Write an executable fake CLI that prints the given stdout (rc 0). */
export function makeFakeCli(dir: string, name: string, stdout: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat <<'OVERLOAD_FAKE_EOF'\n${stdout}\nOVERLOAD_FAKE_EOF\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Write an executable fake CLI that fails (rc 1, platform unreachable). */
export function makeFailingCli(dir: string, name: string, rc = 1): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "fake ${name}: unreachable" >&2\nexit ${rc}\n`);
  chmodSync(path, 0o755);
  return path;
}

/** Write a fake CLI emitting unparseable garbage on stdout with rc 0. */
export function makeGarbageCli(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\nprintf 'herdr(1.2.3) truncation noise {not json'\n`);
  chmodSync(path, 0o755);
  return path;
}

export function herdrAgentsJson(agents: Array<Record<string, unknown>>): string {
  return JSON.stringify({ result: { agents } });
}

export function herdrAgent(
  terminal_id: string,
  cwd: string,
  agent_status = "working",
): Record<string, unknown> {
  return {
    terminal_id,
    agent_status,
    pane_id: "%5",
    tab_id: "tab-1",
    workspace_id: "ws-1",
    cwd,
    revision: 1,
    state_change_seq: 1,
  };
}

export function orcaWorktreesJson(worktrees: Array<Record<string, unknown>>): string {
  return JSON.stringify(worktrees);
}

export function orcaWorktree(
  worktreeInstanceId: string,
  path: string,
  opts: { parentWorktreeId?: string | null; status?: string; workspaceStatus?: string } = {},
): Record<string, unknown> {
  return {
    worktreeInstanceId,
    worktreeId: `wt-${worktreeInstanceId.slice(0, 8)}`,
    workspaceStatus: opts.workspaceStatus ?? "in-progress",
    status: opts.status ?? "active",
    unread: 0,
    lastActivityAt: 1_800_000_000_000,
    lastOutputAt: 1_800_000_000_000,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    parentWorktreeId: opts.parentWorktreeId ?? null,
    childWorktreeIds: [],
    comment: null,
    preview: "",
    path,
  };
}

/** A minimal, parseable cmux hook-sessions file (no sessions). */
export function makeCmuxSessionsFile(path: string): string {
  writeFileSync(path, "{}\n");
  return path;
}

/** A malformed cmux hook-sessions file (must read as source outage). */
export function makeBadCmuxSessionsFile(path: string): string {
  writeFileSync(path, "{not json\n");
  return path;
}
