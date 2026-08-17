import { describe, expect, test } from "bun:test";
import { defaultExecutor, performJump, type Executor } from "./jump";

type ScriptedResult = Awaited<ReturnType<Executor>>;

function scripted(results: ScriptedResult[]) {
  const calls: Array<{ command: string; args: string[]; timeoutMs?: number }> = [];
  const exec: Executor = async (command, args, timeoutMs) => {
    calls.push({ command, args, timeoutMs });
    return results.shift() ?? { ok: true };
  };
  return { calls, exec };
}

describe("performJump", () => {
  test("focuses a herdr terminal by binding", async () => {
    const fake = scripted([{ ok: true }]);

    expect(await performJump({ platform: "herdr", binding: "terminal-7", host: "local" }, fake.exec)).toEqual({ opened: true });
    expect(fake.calls).toEqual([{ command: "herdr", args: ["agent", "focus", "terminal-7"], timeoutMs: 5000 }]);
  });

  test("opens a cmux workspace deeplink", async () => {
    const fake = scripted([{ ok: true }]);

    expect(await performJump({ platform: "cmux", binding: "workspace-42", host: null }, fake.exec)).toEqual({ opened: true });
    expect(fake.calls).toEqual([{ command: "open", args: ["cmux://workspace/workspace-42"], timeoutMs: 5000 }]);
  });

  test("resolves an orca worktree to its first terminal handle", async () => {
    const fake = scripted([
      { ok: true, stdout: JSON.stringify({ worktrees: [{ worktreeInstanceId: "other", path: "/other" }, { worktreeInstanceId: "wt-9", path: "/repo" }] }) },
      { ok: true, stdout: JSON.stringify({ terminals: [{ handle: "terminal:abc" }] }) },
      { ok: true },
    ]);

    expect(await performJump({ platform: "orca", binding: "wt-9", host: "local" }, fake.exec)).toEqual({ opened: true });
    expect(fake.calls).toEqual([
      { command: "orca", args: ["worktree", "ps", "--json"], timeoutMs: 5000 },
      { command: "orca", args: ["terminal", "list", "--worktree", "path:/repo", "--json"], timeoutMs: 5000 },
      { command: "orca", args: ["terminal", "switch", "--terminal", "terminal:abc"], timeoutMs: 5000 },
    ]);
  });

  test("aborts the orca chain after a mid-chain failure", async () => {
    const fake = scripted([
      { ok: true, stdout: JSON.stringify([{ worktreeInstanceId: "wt-9", path: "/repo" }]) },
      { ok: false, error: "orca unavailable" },
      { ok: true },
    ]);

    expect(await performJump({ platform: "orca", binding: "wt-9", host: null }, fake.exec)).toEqual({ opened: false, error: "orca unavailable" });
    expect(fake.calls).toHaveLength(2);
  });

  test("returns a short error for malformed orca output", async () => {
    const fake = scripted([{ ok: true, stdout: "not-json" }]);

    expect(await performJump({ platform: "orca", binding: "wt-9", host: null }, fake.exec)).toEqual({ opened: false, error: "orca worktree not found" });
    expect(fake.calls).toHaveLength(1);
  });

  test("does not execute for unknown platforms or missing bindings", async () => {
    const fake = scripted([]);

    expect(await performJump({ platform: "unknown", binding: "value", host: null }, fake.exec)).toEqual({ opened: false });
    expect(await performJump({ platform: null, binding: "value", host: null }, fake.exec)).toEqual({ opened: false });
    expect(await performJump({ platform: "herdr", binding: null, host: null }, fake.exec)).toEqual({ opened: false });
    expect(fake.calls).toEqual([]);
  });

  test("aborts before any lookup when the orca worktree-list command itself fails", async () => {
    const fake = scripted([{ ok: false, error: "orca: command not found" }]);

    expect(await performJump({ platform: "orca", binding: "wt-9", host: null }, fake.exec)).toEqual({ opened: false, error: "orca: command not found" });
    expect(fake.calls).toHaveLength(1);
  });

  test("stops after step 2 on malformed terminal-list JSON", async () => {
    const fake = scripted([
      { ok: true, stdout: JSON.stringify([{ worktreeInstanceId: "wt-9", path: "/repo" }]) },
      { ok: true, stdout: "not-json" },
    ]);

    expect(await performJump({ platform: "orca", binding: "wt-9", host: null }, fake.exec)).toEqual({ opened: false, error: "orca terminal not found" });
    expect(fake.calls).toHaveLength(2);
  });

  test("stops after step 2 when no terminal entry carries a usable handle field", async () => {
    const fake = scripted([
      { ok: true, stdout: JSON.stringify([{ worktreeInstanceId: "wt-9", path: "/repo" }]) },
      { ok: true, stdout: JSON.stringify({ terminals: [{ notAHandle: "x" }] }) },
    ]);

    expect(await performJump({ platform: "orca", binding: "wt-9", host: null }, fake.exec)).toEqual({ opened: false, error: "orca terminal not found" });
    expect(fake.calls).toHaveLength(2);
  });

  test("surfaces the underlying error when the final orca switch call fails", async () => {
    const fake = scripted([
      { ok: true, stdout: JSON.stringify([{ worktreeInstanceId: "wt-9", path: "/repo" }]) },
      { ok: true, stdout: JSON.stringify({ terminals: [{ handle: "terminal:abc" }] }) },
      { ok: false, error: "no such terminal" },
    ]);

    expect(await performJump({ platform: "orca", binding: "wt-9", host: null }, fake.exec)).toEqual({ opened: false, error: "no such terminal" });
    expect(fake.calls).toHaveLength(3);
  });
});

describe("defaultExecutor", () => {
  test("kills a hung process and returns a failure within the timeout bound, not the process's own duration", async () => {
    const start = Date.now();
    // `sleep 5` would hang far longer than the 150ms bound below if the kill didn't fire.
    const result = await defaultExecutor("sleep", ["5"], 150);
    const elapsed = Date.now() - start;

    expect(result).toEqual({ ok: false, error: "command timed out" });
    expect(elapsed).toBeLessThan(1000);
  });

  test("reports a non-zero exit as a failure with the first stderr line", async () => {
    const result = await defaultExecutor("sh", ["-c", "echo boom 1>&2; exit 1"]);

    expect(result.ok).toBe(false);
    expect(result.error).toBe("boom");
  });

  test("returns a graceful failure for a nonexistent command instead of throwing", async () => {
    const result = await defaultExecutor("overload-jump-nonexistent-binary-xyz", []);

    expect(result).toEqual({ ok: false, error: "command unavailable" });
  });
});
