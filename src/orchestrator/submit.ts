import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandExecutor } from "./worktree";
import type { Task } from "./store";

type Step = {
  command: string;
  args: string[];
  ok: boolean;
  stdout: string;
  stderr: string;
};
export type SubmitResult =
  | {
      ok: true;
      prUrl: string;
      effects: { push: "confirmed" | "unknown"; pr: "confirmed" | "unknown" };
      steps: Step[];
    }
  | {
      ok: false;
      reason: "push_failed" | "tool_missing" | "pr_failed";
      effects: { push: "confirmed" | "unknown"; pr: "confirmed" | "unknown" };
      steps: Step[];
    };
export type SubmitBranchOptions = {
  cwd: string;
  branch: string;
  base_ref: string;
  title: string;
  bodyFile: string;
  artifactsDir?: string;
  executor: CommandExecutor;
};

/** Persist every external step. Branch presence alone is insufficient: remote HEAD
 * must equal local HEAD before a prior push is considered confirmed. */
export async function submitTask(
  task: Task,
  worktreeDir: string,
  artifactsDir: string,
  executor: CommandExecutor,
): Promise<SubmitResult> {
  const branch = task.branch;
  if (!branch)
    return {
      ok: false,
      reason: "push_failed",
      effects: { push: "unknown", pr: "unknown" },
      steps: [],
    };
  return submitBranch({
    cwd: worktreeDir,
    branch,
    base_ref: task.base_ref,
    title: task.title,
    bodyFile: join(artifactsDir, "pr-body.md"),
    artifactsDir,
    executor,
  });
}

export async function submitBranch(
  opts: SubmitBranchOptions,
): Promise<SubmitResult> {
  const { cwd, branch, base_ref, title, bodyFile, executor } = opts;
  const artifactsDir = opts.artifactsDir ?? dirname(bodyFile);
  const steps: Step[] = [];
  const run = async (command: string, args: string[]) => {
    const r = await executor(command, args, { cwd });
    steps.push({ command, args, ok: r.ok, stdout: r.stdout, stderr: r.stderr });
    return r;
  };
  const local = await run("git", ["rev-parse", "HEAD"]);
  if (!local.ok) return finish("push_failed", "unknown", "unknown");
  let remote = await run("git", ["ls-remote", "--heads", "origin", branch]);
  const remoteSha = remote.ok ? remote.stdout.trim().split(/\s+/)[0] : "";
  if (remoteSha !== local.stdout.trim()) {
    const push = await run("git", ["push", "-u", "origin", branch]);
    if (!push.ok) return finish("push_failed", "unknown", "unknown");
    remote = await run("git", ["ls-remote", "--heads", "origin", branch]);
    if (
      !remote.ok ||
      remote.stdout.trim().split(/\s+/)[0] !== local.stdout.trim()
    )
      return finish("push_failed", "unknown", "unknown");
  }
  const gh = await run("which", ["gh"]);
  if (!gh.ok) return finish("tool_missing", "confirmed", "unknown");
  const listed = await run("gh", [
    "pr",
    "list",
    "--head",
    branch,
    "--json",
    "url",
    "--limit",
    "1",
  ]);
  if (!listed.ok)
    return finish(
      isToolMissing(listed) ? "tool_missing" : "pr_failed",
      "confirmed",
      "unknown",
    );
  let url = "";
  try {
    url = JSON.parse(listed.stdout)[0]?.url ?? "";
  } catch {
    return finish("pr_failed", "confirmed", "unknown");
  }
  if (!url) {
    const created = await run("gh", [
      "pr",
      "create",
      "--base",
      base_ref,
      "--head",
      branch,
      "--title",
      title,
      "--body-file",
      bodyFile,
    ]);
    if (!created.ok)
      return finish(
        isToolMissing(created) ? "tool_missing" : "pr_failed",
        "confirmed",
        "unknown",
      );
    url =
      created.stdout
        .trim()
        .match(/https:\/\/[^\s]+/g)
        ?.at(-1) ?? "";
  }
  if (!url) return finish("pr_failed", "confirmed", "unknown");
  return finish(null, "confirmed", "confirmed", url);
  function finish(
    reason: "push_failed" | "tool_missing" | "pr_failed" | null,
    push: "confirmed" | "unknown",
    pr: "confirmed" | "unknown",
    prUrl = "",
  ): SubmitResult {
    mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(artifactsDir, "submit.json"),
      JSON.stringify({ at: Date.now(), effects: { push, pr }, steps }, null, 2),
      { mode: 0o600 },
    );
    return reason
      ? { ok: false, reason, effects: { push, pr }, steps }
      : { ok: true, prUrl, effects: { push, pr }, steps };
  }
}
function isToolMissing(r: { stderr: string; stdout: string }): boolean {
  return /not found|command not found|ENOENT/i.test(`${r.stdout}\n${r.stderr}`);
}
