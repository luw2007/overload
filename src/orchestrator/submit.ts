import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CommandExecutor } from "./worktree";
import type { Task } from "./store";

export type SubmitResult =
  | { ok: true; prUrl: string }
  | { ok: false; reason: "push_failed" | "tool_missing" };

/**
 * §3.8 submitted 路径, steps 1-5 in literal plan order:
 * 1. git push (with ls-remote idempotency check)
 * 2. gh pr list (check existing PR)
 * 3. gh pr create if needed
 * 4. Return prUrl
 * 5. gh missing -> tool_missing
 *
 * Per the plan, push happens FIRST. tool_missing is detected when gh
 * commands fail (exit 127 or "not found"), after push has already succeeded.
 */
export async function submitTask(
  task: Task,
  worktreeDir: string,
  artifactsDir: string,
  executor: CommandExecutor,
): Promise<SubmitResult> {
  const branch = task.branch;
  if (!branch) return { ok: false, reason: "push_failed" };

  // Step 1: idempotent push — ls-remote first, skip push if branch already on remote.
  const lsRemote = await executor("git", ["-C", worktreeDir, "ls-remote", "--heads", "origin", branch]);
  const alreadyPushed = lsRemote.ok && lsRemote.stdout.trim().length > 0;
  if (!alreadyPushed) {
    const push = await executor("git", ["-C", worktreeDir, "push", "-u", "origin", branch]);
    if (!push.ok) return { ok: false, reason: "push_failed" };
  }

  // Step 2-5: gh commands — detect tool_missing if gh is not installed.
  const ghCheck = await executor("which", ["gh"]);
  if (!ghCheck.ok) return { ok: false, reason: "tool_missing" };

  // Step 2: check existing PR.
  const prList = await executor("gh", ["pr", "list", "--head", branch, "--json", "url", "--limit", "1"]);
  if (!prList.ok) {
    if (isToolMissing(prList)) return { ok: false, reason: "tool_missing" };
    // gh failed for another reason — treat as push_failed since we can't create PR
    return { ok: false, reason: "push_failed" };
  }

  let prUrl: string | null = null;
  try {
    const parsed = JSON.parse(prList.stdout);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].url) {
      prUrl = parsed[0].url;
    }
  } catch { /* empty list or parse error — create new PR */ }

  if (prUrl) return { ok: true, prUrl };

  // Step 3: create PR.
  const bodyFile = join(artifactsDir, "pr-body.md");
  ensurePrBody(task, artifactsDir, bodyFile);

  const baseRef = task.base_ref;
  const title = task.title;
  const create = await executor("gh", [
    "pr", "create",
    "--base", baseRef,
    "--head", branch,
    "--title", title,
    "--body-file", bodyFile,
  ]);
  if (!create.ok) {
    if (isToolMissing(create)) return { ok: false, reason: "tool_missing" };
    return { ok: false, reason: "push_failed" };
  }

  // gh pr create prints the PR URL to stdout.
  prUrl = create.stdout.trim();
  if (!prUrl) return { ok: false, reason: "push_failed" };
  return { ok: true, prUrl };
}

/** Detect exit-code-127-like "command not found" from executor output. */
function isToolMissing(result: { ok: boolean; stderr: string }): boolean {
  const s = result.stderr.toLowerCase();
  return s.includes("not found") || s.includes("no such file");
}

/** Write a minimal pr-body.md from already-collected evidence artifacts. */
function ensurePrBody(task: Task, artifactsPath: string, bodyFile: string): void {
  if (existsSync(bodyFile)) return; // idempotent
  mkdirSync(artifactsPath, { recursive: true });
  const parts: string[] = [`## ${task.title}`, "", `Task: \`${task.task_id}\``];
  const commitsFile = join(artifactsPath, "commits.txt");
  if (existsSync(commitsFile)) {
    const commits = readFileSync(commitsFile, "utf8").trim();
    if (commits) parts.push("", "### Commits", "```", commits, "```");
  }
  const diffFile = join(artifactsPath, "diff.patch");
  if (existsSync(diffFile)) {
    const diff = readFileSync(diffFile, "utf8");
    const lines = diff.split("\n");
    const summary = lines.filter(l => l.startsWith("diff --git")).map(l => l.replace("diff --git ", "")).join("\n");
    if (summary) parts.push("", "### Changed files", "```", summary, "```");
  }
  writeFileSync(bodyFile, parts.join("\n") + "\n", { mode: 0o600 });
}
