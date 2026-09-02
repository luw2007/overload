import { describe, it, expect, beforeEach } from "bun:test";
import { submitTask } from "./submit";
import type { Task } from "./store";
import type { CommandExecutor } from "./worktree";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    task_id: "test-task-1", title: "Test PR", repo: "/tmp/fake", base_ref: "main",
    worktree: "/tmp/fake-wt", branch: "overload/task-test-1", state: "submitted",
    attempt_id: null, owner_instance: null, lease_expires_at: null, heartbeat_at: null,
    runner_pid: null, runner_boot_id: null, retry_budget: 2, stable_id: null,
    pr_url: null, blocked_reason: null, terminal_reason: null,
    created_at: Date.now(), updated_at: Date.now(), ...overrides,
  };
}

type Call = { cmd: string; args: string[] };

function makeFakeExecutor(responses: Record<string, { ok: boolean; stdout: string; stderr: string }>): { executor: CommandExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const executor: CommandExecutor = async (cmd, args, _opts) => {
    calls.push({ cmd, args: [...args] });
    // Match by command + first meaningful arg
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, response] of Object.entries(responses)) {
      if (key.includes(pattern)) return response;
    }
    return { ok: true, stdout: "", stderr: "" };
  };
  return { executor, calls };
}

describe("submitTask", () => {
  let artifactsDir: string;
  beforeEach(() => { artifactsDir = mkdtempSync(join(tmpdir(), "submit-test-")); });

  it("push + create PR: happy path", async () => {
    const { executor, calls } = makeFakeExecutor({
      "ls-remote": { ok: true, stdout: "", stderr: "" }, // no remote branch yet
      "push": { ok: true, stdout: "", stderr: "" },
      "which gh": { ok: true, stdout: "/usr/bin/gh\n", stderr: "" },
      "pr list": { ok: true, stdout: "[]", stderr: "" }, // no existing PR
      "pr create": { ok: true, stdout: "https://github.com/org/repo/pull/42\n", stderr: "" },
    });
    const task = makeTask();
    const result = await submitTask(task, "/tmp/fake-wt", artifactsDir, executor);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prUrl).toBe("https://github.com/org/repo/pull/42");
    // Verify pr-body.md was written
    expect(existsSync(join(artifactsDir, "pr-body.md"))).toBe(true);
    // Verify push was called
    expect(calls.some(c => c.cmd === "git" && c.args.includes("push"))).toBe(true);
  });

  it("idempotent: skips push when remote branch already exists", async () => {
    const { executor, calls } = makeFakeExecutor({
      "ls-remote": { ok: true, stdout: "abc123\trefs/heads/overload/task-test-1\n", stderr: "" },
      "which gh": { ok: true, stdout: "/usr/bin/gh\n", stderr: "" },
      "pr list": { ok: true, stdout: '[{"url":"https://github.com/org/repo/pull/99"}]', stderr: "" },
    });
    const result = await submitTask(makeTask(), "/tmp/fake-wt", artifactsDir, executor);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prUrl).toBe("https://github.com/org/repo/pull/99");
    // push should NOT be called
    expect(calls.some(c => c.cmd === "git" && c.args.includes("push"))).toBe(false);
  });

  it("existing PR found: skips create", async () => {
    const { executor, calls } = makeFakeExecutor({
      "ls-remote": { ok: true, stdout: "abc123\trefs/heads/overload/task-test-1\n", stderr: "" },
      "which gh": { ok: true, stdout: "/usr/bin/gh\n", stderr: "" },
      "pr list": { ok: true, stdout: '[{"url":"https://github.com/org/repo/pull/55"}]', stderr: "" },
    });
    const result = await submitTask(makeTask(), "/tmp/fake-wt", artifactsDir, executor);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.prUrl).toBe("https://github.com/org/repo/pull/55");
    // gh pr create should NOT be called
    expect(calls.some(c => c.cmd === "gh" && c.args.includes("create"))).toBe(false);
  });

  it("tool_missing: gh not installed", async () => {
    const { executor } = makeFakeExecutor({
      "ls-remote": { ok: true, stdout: "", stderr: "" },
      "push": { ok: true, stdout: "", stderr: "" },
      "which gh": { ok: false, stdout: "", stderr: "gh not found" },
    });
    const result = await submitTask(makeTask(), "/tmp/fake-wt", artifactsDir, executor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("tool_missing");
  });

  it("push_fail: non-fast-forward", async () => {
    const { executor } = makeFakeExecutor({
      "ls-remote": { ok: true, stdout: "", stderr: "" },
      "push": { ok: false, stdout: "", stderr: "non-fast-forward" },
    });
    const result = await submitTask(makeTask(), "/tmp/fake-wt", artifactsDir, executor);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("push_failed");
  });

  it("pr-body.md includes evidence from artifacts", async () => {
    writeFileSync(join(artifactsDir, "commits.txt"), "abc123 initial commit\ndef456 second commit\n");
    writeFileSync(join(artifactsDir, "diff.patch"), "diff --git a/foo.ts b/foo.ts\n+hello\n");
    const { executor } = makeFakeExecutor({
      "ls-remote": { ok: true, stdout: "abc\trefs/heads/overload/task-test-1\n", stderr: "" },
      "which gh": { ok: true, stdout: "/usr/bin/gh\n", stderr: "" },
      "pr list": { ok: true, stdout: "[]", stderr: "" },
      "pr create": { ok: true, stdout: "https://github.com/org/repo/pull/1\n", stderr: "" },
    });
    await submitTask(makeTask(), "/tmp/fake-wt", artifactsDir, executor);
    const body = readFileSync(join(artifactsDir, "pr-body.md"), "utf8");
    expect(body).toContain("Commits");
    expect(body).toContain("initial commit");
    expect(body).toContain("Changed files");
  });
});

// Real git integration test: verify the exact git argv is syntactically correct.
describe("submitTask real git integration", () => {
  it("push idempotency: ls-remote detects remote branch", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "submit-real-"));
    const bare = join(tmp, "remote.git");
    const work = join(tmp, "work");
    const artifactsPath = join(tmp, "artifacts");
    mkdirSync(artifactsPath, { recursive: true });

    // Create a bare remote and a working clone
    execSync(`git init --bare ${bare}`);
    execSync(`git clone ${bare} ${work}`);
    execSync(`git -C ${work} config user.email test@test.com`);
    execSync(`git -C ${work} config user.name test`);
    execSync(`git -C ${work} checkout -b main`);
    execSync(`git -C ${work} commit --allow-empty -m "init"`);
    execSync(`git -C ${work} push -u origin main`);

    // Create a branch and push it
    const branch = "overload/task-real-test";
    execSync(`git -C ${work} checkout -b ${branch}`);
    execSync(`git -C ${work} commit --allow-empty -m "feature"`);
    execSync(`git -C ${work} push -u origin ${branch}`);

    // Now use the REAL defaultCommandExecutor from worktree.ts
    const { defaultCommandExecutor } = await import("./worktree");

    // Wrap to track calls
    const calls: Call[] = [];
    const trackingExecutor: CommandExecutor = async (cmd, args, opts) => {
      calls.push({ cmd, args: [...args] });
      return defaultCommandExecutor(cmd, args, opts);
    };

    // gh is not available in test, so we only test up to the push idempotency check.
    // ls-remote should find the branch and skip push.
    const lsResult = await trackingExecutor("git", ["-C", work, "ls-remote", "--heads", "origin", branch]);
    expect(lsResult.ok).toBe(true);
    expect(lsResult.stdout).toContain(`refs/heads/${branch}`);

    // Also verify push argv is correct against real git (just syntax, will be no-op since already pushed)
    const pushResult = await trackingExecutor("git", ["-C", work, "push", "-u", "origin", branch]);
    expect(pushResult.ok).toBe(true);
  });
});
