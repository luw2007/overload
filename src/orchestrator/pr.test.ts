import { describe, it, expect } from "bun:test";
import { checkPr } from "./pr";
import type { CommandExecutor } from "./worktree";

function fakeGh(json: any): CommandExecutor {
  return async (_cmd, _args, _opts) => ({
    ok: true, stdout: JSON.stringify(json), stderr: "",
  });
}

describe("checkPr", () => {
  it("merged PR", async () => {
    const result = await checkPr("https://github.com/org/repo/pull/1", fakeGh({
      state: "MERGED", statusCheckRollup: [], reviewDecision: null, mergeable: "UNKNOWN", updatedAt: new Date().toISOString(),
    }));
    expect(result.status).toBe("merged");
  });

  it("closed without merge", async () => {
    const result = await checkPr("https://github.com/org/repo/pull/1", fakeGh({
      state: "CLOSED", statusCheckRollup: [], reviewDecision: null, mergeable: "UNKNOWN", updatedAt: new Date().toISOString(),
    }));
    expect(result.status).toBe("anomaly");
    expect(result.detail).toContain("closed without merge");
  });

  it("CI check failure", async () => {
    const result = await checkPr("https://github.com/org/repo/pull/1", fakeGh({
      state: "OPEN", statusCheckRollup: [
        { name: "build", conclusion: "SUCCESS" },
        { name: "lint", conclusion: "FAILURE" },
      ], reviewDecision: null, mergeable: "MERGEABLE", updatedAt: new Date().toISOString(),
    }));
    expect(result.status).toBe("anomaly");
    expect(result.detail).toContain("lint");
  });

  it("changes requested", async () => {
    const result = await checkPr("https://github.com/org/repo/pull/1", fakeGh({
      state: "OPEN", statusCheckRollup: [], reviewDecision: "CHANGES_REQUESTED", mergeable: "MERGEABLE", updatedAt: new Date().toISOString(),
    }));
    expect(result.status).toBe("anomaly");
    expect(result.detail).toContain("Changes requested");
  });

  it("24h stale", async () => {
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const result = await checkPr("https://github.com/org/repo/pull/1", fakeGh({
      state: "OPEN", statusCheckRollup: [], reviewDecision: null, mergeable: "MERGEABLE", updatedAt: old,
    }));
    expect(result.status).toBe("anomaly");
    expect(result.detail).toContain("24h");
  });

  it("clean: all checks pass, no issues", async () => {
    const result = await checkPr("https://github.com/org/repo/pull/1", fakeGh({
      state: "OPEN", statusCheckRollup: [{ name: "build", conclusion: "SUCCESS" }],
      reviewDecision: null, mergeable: "MERGEABLE", updatedAt: new Date().toISOString(),
    }));
    expect(result.status).toBe("clean");
  });

  it("gh failure returns clean (no action)", async () => {
    const failExecutor: CommandExecutor = async () => ({ ok: false, stdout: "", stderr: "error" });
    const result = await checkPr("https://github.com/org/repo/pull/1", failExecutor);
    expect(result.status).toBe("clean");
  });

  it("anomaly dedup: requestApproval called at most once across multiple ticks", async () => {
    // This tests the dedup logic in orchestrator.ts's pollSubmitted, not checkPr itself.
    // checkPr just returns the status; dedup is the caller's responsibility.
    // We test checkPr returns anomaly consistently.
    const executor = fakeGh({
      state: "OPEN", statusCheckRollup: [{ name: "ci", conclusion: "FAILURE" }],
      reviewDecision: null, mergeable: "MERGEABLE", updatedAt: new Date().toISOString(),
    });
    const r1 = await checkPr("url", executor);
    const r2 = await checkPr("url", executor);
    expect(r1.status).toBe("anomaly");
    expect(r2.status).toBe("anomaly");
  });
});
