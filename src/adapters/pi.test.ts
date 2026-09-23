import { expect, test } from "bun:test";
import { buildPiRunnerInvocation } from "./pi";

test("buildPiRunnerInvocation wraps pi prompt in cmux new-workspace with parent origin", () => {
  const inv = buildPiRunnerInvocation("task-1", "attempt-2", "/worktree", "/tmp/prompt.txt");
  expect(inv.command).toBe("cmux");
  expect(inv.args).toContain("new-workspace");
  expect(inv.args).toContain("--cwd");
  expect(inv.args).toContain("/worktree");
  const command = inv.args[inv.args.indexOf("--command") + 1];
  expect(command).toContain("OVERLOAD_PARENT='orch:task:task-1:attempt-2'");
  expect(command).toContain("OVERLOAD_ORCH_TASK='task-1'");
  expect(command).toContain("pi -p '@/tmp/prompt.txt'");
});
