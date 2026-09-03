import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, openStore, transition } from "./store";
import { ensureWorktree, gcWorktree, gcCandidates, type CommandExecutor } from "./worktree";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function scripted(handlers: Record<string, (args: string[]) => { ok: boolean; stdout: string; stderr: string }>): CommandExecutor {
  return async (cmd, args) => {
    const key = args[2] ?? "";
    const handler = handlers[key];
    if (!handler) throw new Error(`unscripted git ${key}`);
    return handler(args);
  };
}

describe("ensureWorktree (mocked executor)", () => {
  test("reuses an existing worktree listed by `git worktree list --porcelain`", async () => {
    const dir = "/root/task-1";
    const exec = scripted({ worktree: (args) => args[3] === "list" ? { ok: true, stdout: `worktree ${dir}\nHEAD abc\nbranch refs/heads/task-branch\n\n`, stderr: "" } : (() => { throw new Error("worktree add should not be called"); })() });
    const result = await ensureWorktree("/repo", "task-1", "task-branch", "HEAD", "/root", exec);
    expect(result).toEqual({ dir, created: false });
  });

  test("reuses an existing branch when the worktree dir is absent", async () => {
    const calls: string[][] = [];
    const exec: CommandExecutor = async (cmd, args) => {
      calls.push(args);
      if (args[3] === "list") return { ok: true, stdout: "", stderr: "" };
      if (args[2] === "show-ref") return { ok: true, stdout: "", stderr: "" };
      if (args[2] === "worktree" && args[3] === "add") return { ok: true, stdout: "", stderr: "" };
      throw new Error(`unscripted ${args.join(" ")}`);
    };
    const result = await ensureWorktree("/repo", "task-2", "existing-branch", "HEAD", "/root", exec);
    expect(result).toEqual({ dir: "/root/task-2", created: true });
    // No -b flag: reuses the existing branch instead of erroring.
    expect(calls.at(-1)).toEqual(["-C", "/repo", "worktree", "add", "/root/task-2", "existing-branch"]);
  });

  test("creates a new branch + worktree when neither exists", async () => {
    const calls: string[][] = [];
    const exec: CommandExecutor = async (cmd, args) => {
      calls.push(args);
      if (args[3] === "list") return { ok: true, stdout: "", stderr: "" };
      if (args[2] === "show-ref") return { ok: false, stdout: "", stderr: "" };
      if (args[2] === "worktree" && args[3] === "add") return { ok: true, stdout: "", stderr: "" };
      throw new Error(`unscripted ${args.join(" ")}`);
    };
    const result = await ensureWorktree("/repo", "task-3", "new-branch", "main", "/root", exec);
    expect(result).toEqual({ dir: "/root/task-3", created: true });
    expect(calls.at(-1)).toEqual(["-C", "/repo", "worktree", "add", "/root/task-3", "-b", "new-branch", "main"]);
  });

  test("throws with git's stderr when worktree add fails", async () => {
    const exec: CommandExecutor = async (cmd, args) => {
      if (args[3] === "list") return { ok: true, stdout: "", stderr: "" };
      if (args[2] === "show-ref") return { ok: false, stdout: "", stderr: "" };
      return { ok: false, stdout: "", stderr: "fatal: not a git repository" };
    };
    await expect(ensureWorktree("/notrepo", "task-4", "b", "HEAD", "/root", exec)).rejects.toThrow("fatal: not a git repository");
  });
});

describe("gcWorktree (mocked executor)", () => {
  function store() {
    const d = mkdtempSync(join(tmpdir(), "gc-"));
    dirs.push(d);
    return openStore(join(d, "db"));
  }

  test("only reports (never deletes) a dirty worktree", async () => {
    const db = store();
    const task = addTask(db, "t", "/repo", "0000000000000000000000000000000000000000");
    db.run("UPDATE tasks SET state='done',worktree=? WHERE task_id=?", ["/wt/dirty", task.task_id]);
    const exec: CommandExecutor = async (cmd, args) => args[2] === "status" ? { ok: true, stdout: " M file\n", stderr: "" } : { ok: true, stdout: "", stderr: "" };
    const result = await gcWorktree(db, task.task_id, false, "/root", exec);
    expect(result).toEqual({ deleted: false, reason: "dirty" });
    db.close();
  });

  test("dryRun never deletes even when clean and terminal", async () => {
    const db = store();
    const task = addTask(db, "t", "/repo", "0000000000000000000000000000000000000000");
    db.run("UPDATE tasks SET state='done',worktree=? WHERE task_id=?", ["/wt/clean", task.task_id]);
    let removeCalled = false;
    const exec: CommandExecutor = async (cmd, args) => {
      if (args[2] === "status") return { ok: true, stdout: "", stderr: "" };
      if (args[2] === "worktree" && args[3] === "remove") { removeCalled = true; return { ok: true, stdout: "", stderr: "" }; }
      return { ok: true, stdout: "", stderr: "" };
    };
    const result = await gcWorktree(db, task.task_id, true, "/root", exec);
    expect(result).toEqual({ deleted: false, reason: "dry_run" });
    expect(removeCalled).toBeFalse();
    db.close();
  });

  test("refuses to delete a non-terminal task's worktree", async () => {
    const db = store();
    const task = addTask(db, "t", "/repo", "0000000000000000000000000000000000000000"); // state=queued
    const exec: CommandExecutor = async () => ({ ok: true, stdout: "", stderr: "" });
    const result = await gcWorktree(db, task.task_id, false, "/root", exec);
    expect(result).toEqual({ deleted: false, reason: "not_terminal" });
    db.close();
  });

  test("refuses to delete while a live pid holds the worktree", async () => {
    const db = store();
    const task = addTask(db, "t", "/repo", "0000000000000000000000000000000000000000");
    db.run("UPDATE tasks SET state='failed',worktree=?,runner_pid=? WHERE task_id=?", ["/wt/live", 999, task.task_id]);
    const exec: CommandExecutor = async () => ({ ok: true, stdout: "", stderr: "" });
    const result = await gcWorktree(db, task.task_id, false, "/root", exec, (pid) => pid === 999);
    expect(result).toEqual({ deleted: false, reason: "live_process" });
    db.close();
  });

  test("deletes a clean, terminal, no-live-pid worktree with --apply (dryRun=false)", async () => {
    const db = store();
    const task = addTask(db, "t", "/repo", "0000000000000000000000000000000000000000");
    db.run("UPDATE tasks SET state='abandoned',worktree=? WHERE task_id=?", ["/wt/clean2", task.task_id]);
    const calls: string[][] = [];
    const exec: CommandExecutor = async (cmd, args) => {
      calls.push(args);
      if (args[2] === "status") return { ok: true, stdout: "", stderr: "" };
      if (args[2] === "worktree" && args[3] === "remove") return { ok: true, stdout: "", stderr: "" };
      return { ok: true, stdout: "", stderr: "" };
    };
    const result = await gcWorktree(db, task.task_id, false, "/root", exec, () => false);
    expect(result).toEqual({ deleted: true });
    expect(calls.at(-1)).toEqual(["-C", "/repo", "worktree", "remove", "/wt/clean2"]);
    db.close();
  });

  test("gcCandidates only considers terminal tasks", async () => {
    const db = store();
    const running = addTask(db, "running-task", "/repo", "0000000000000000000000000000000000000000");
    transition(db, running.task_id, "human_abandon"); // -> abandoned, terminal
    const queued = addTask(db, "queued-task", "/repo2", "0000000000000000000000000000000000000000"); // stays queued, not terminal
    const exec: CommandExecutor = async (cmd, args) => args[2] === "status" ? { ok: true, stdout: "", stderr: "" } : { ok: true, stdout: "", stderr: "" };
    const results = await gcCandidates(db, true, "/root", exec, () => false);
    expect(results.map((r) => r.task_id)).toEqual([running.task_id]);
    expect(results.map((r) => r.task_id)).not.toContain(queued.task_id);
    db.close();
  });
});

describe("ensureWorktree (real git, scratch repo)", () => {
  test("is idempotent across two calls against a real repo", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-repo-"));
    dirs.push(repo);
    const root = mkdtempSync(join(tmpdir(), "wt-root-"));
    dirs.push(root);
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    run(["init", "-q"]);
    run(["config", "user.email", "a@a.com"]);
    run(["config", "user.name", "a"]);
    Bun.spawnSync(["bash", "-c", "echo x > f"], { cwd: repo });
    run(["add", "f"]);
    run(["commit", "-q", "-m", "init"]);

    const first = await ensureWorktree(repo, "real-task", "real-branch", "HEAD", root);
    expect(first.created).toBeTrue();
    expect(first.dir).toBe(join(root, "real-task"));

    const second = await ensureWorktree(repo, "real-task", "real-branch", "HEAD", root);
    expect(second).toEqual({ dir: join(root, "real-task"), created: false });

    const listed = Bun.spawnSync(["git", "-C", repo, "worktree", "list", "--porcelain"]);
    expect(listed.stdout.toString()).toContain(`worktree ${join(root, "real-task")}`);
  });

  test("reuses an existing branch across two different task ids (real repo)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-repo2-"));
    dirs.push(repo);
    const root = mkdtempSync(join(tmpdir(), "wt-root2-"));
    dirs.push(root);
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    run(["init", "-q"]);
    run(["config", "user.email", "a@a.com"]);
    run(["config", "user.name", "a"]);
    Bun.spawnSync(["bash", "-c", "echo x > f"], { cwd: repo });
    run(["add", "f"]);
    run(["commit", "-q", "-m", "init"]);

    await ensureWorktree(repo, "task-a", "shared-branch", "HEAD", root);
    // Remove the worktree dir but leave the branch behind, simulating a restart after manual cleanup.
    Bun.spawnSync(["git", "-C", repo, "worktree", "remove", join(root, "task-a")]);

    const second = await ensureWorktree(repo, "task-b", "shared-branch", "HEAD", root);
    expect(second).toEqual({ dir: join(root, "task-b"), created: true });
  });

  test("gcWorktree deletes a real clean terminal worktree and leaves a dirty one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "wt-repo3-"));
    dirs.push(repo);
    const root = mkdtempSync(join(tmpdir(), "wt-root3-"));
    dirs.push(root);
    const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    run(["init", "-q"]);
    run(["config", "user.email", "a@a.com"]);
    run(["config", "user.name", "a"]);
    Bun.spawnSync(["bash", "-c", "echo x > f"], { cwd: repo });
    run(["add", "f"]);
    run(["commit", "-q", "-m", "init"]);

    const d = mkdtempSync(join(tmpdir(), "gc-store-"));
    dirs.push(d);
    const db = openStore(join(d, "db"));
    const head = run(["rev-parse", "HEAD"]).stdout.toString().trim();
    const cleanTask = addTask(db, "clean", repo, head);
    const dirtyTask = addTask(db, "dirty", repo, head);
    await ensureWorktree(repo, cleanTask.task_id, "clean-branch", "HEAD", root);
    const dirtyWt = (await ensureWorktree(repo, dirtyTask.task_id, "dirty-branch", "HEAD", root)).dir;
    Bun.spawnSync(["bash", "-c", `echo y > ${join(dirtyWt, "untracked")}`]);
    db.run("UPDATE tasks SET state='done',worktree=? WHERE task_id=?", [join(root, cleanTask.task_id), cleanTask.task_id]);
    db.run("UPDATE tasks SET state='done',worktree=? WHERE task_id=?", [dirtyWt, dirtyTask.task_id]);

    const cleanResult = await gcWorktree(db, cleanTask.task_id, false, root, undefined, () => false);
    expect(cleanResult).toEqual({ deleted: true });
    const dirtyResult = await gcWorktree(db, dirtyTask.task_id, false, root, undefined, () => false);
    expect(dirtyResult).toEqual({ deleted: false, reason: "dirty" });
    db.close();

    const listed = Bun.spawnSync(["git", "-C", repo, "worktree", "list", "--porcelain"]);
    expect(listed.stdout.toString()).not.toContain(join(root, cleanTask.task_id));
    expect(listed.stdout.toString()).toContain(join(root, dirtyTask.task_id));
  });
});
