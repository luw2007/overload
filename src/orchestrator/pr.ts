import type { CommandExecutor } from "./worktree";

export type PrStatus = { status: "merged" | "anomaly" | "clean"; detail?: string };

/**
 * §3.8 CI recon: `gh pr view <url> --json statusCheckRollup,reviewDecision,mergeable`.
 * merged → "merged". check FAILURE / CHANGES_REQUESTED / 24h stale → "anomaly". else "clean".
 */
export async function checkPr(prUrl: string, executor: CommandExecutor): Promise<PrStatus> {
  const result = await executor("gh", [
    "pr", "view", prUrl,
    "--json", "state,statusCheckRollup,reviewDecision,mergeable,updatedAt",
  ]);
  if (!result.ok) return { status: "clean", detail: "gh pr view failed" };

  let data: any;
  try { data = JSON.parse(result.stdout); } catch { return { status: "clean", detail: "parse error" }; }

  // Merged check
  if (data.state === "MERGED") return { status: "merged" };

  // Closed without merge
  if (data.state === "CLOSED") return { status: "anomaly", detail: "PR closed without merge" };

  // Check failures
  const checks: any[] = data.statusCheckRollup ?? [];
  const failed = checks.filter((c: any) => c.conclusion === "FAILURE" || c.conclusion === "ERROR" || c.conclusion === "CANCELLED");
  if (failed.length > 0) {
    const names = failed.map((c: any) => c.name || c.context || "unknown").join(", ");
    return { status: "anomaly", detail: `CI checks failed: ${names}` };
  }

  // Review decision
  if (data.reviewDecision === "CHANGES_REQUESTED") {
    return { status: "anomaly", detail: "Changes requested by reviewer" };
  }

  // 24h stale check
  if (data.updatedAt) {
    const updated = new Date(data.updatedAt).getTime();
    if (!isNaN(updated) && Date.now() - updated > 24 * 3600 * 1000) {
      return { status: "anomaly", detail: "No state change for 24h" };
    }
  }

  return { status: "clean" };
}
