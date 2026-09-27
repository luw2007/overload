import { describe, expect, test } from "bun:test";
import type { ConditionWait, GithubPrMergedCondition, PrBaseline } from "../../control/types";
import { createGithubPrAdapter, GithubPrObservationError, observeGithubPr, parseGithubPrUrl, type GhExecutor } from "./github-pr";

const T = 1_700_000_000_000;
const HOUR = 3_600_000;

type Call = { cmd: string; args: string[]; signal?: AbortSignal };

/** Injectable, network-free `gh` stand-in that records every invocation for argv-safety assertions
 * and for proving `ctx.signal` is threaded into the executor's `opts` for real child-process abort. */
function recordingExecutor(handler: (cmd: string, args: string[]) => { ok: boolean; stdout: string; stderr: string }): { executor: GhExecutor; calls: Call[] } {
  const calls: Call[] = [];
  const executor: GhExecutor = async (cmd, args, opts) => {
    calls.push({ cmd, args, signal: opts?.signal });
    return handler(cmd, args);
  };
  return { executor, calls };
}

/** `gh pr view --json ...` success-shaped stdout fixture; every field overridable per test. */
function ghResponse(overrides: Partial<{ number: number; state: string; mergedAt: string | null; updatedAt: string; url: string }> = {}): string {
  return JSON.stringify({
    number: 42,
    state: "OPEN",
    mergedAt: null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    url: "https://github.com/acme/widgets/pull/42",
    ...overrides,
  });
}

const identity: GithubPrMergedCondition["source"] = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42 };

function condition(source: GithubPrMergedCondition["source"] = identity): GithubPrMergedCondition {
  return { kind: "github_pr_merged", source };
}

function ctx(now = T) {
  return { now, signal: new AbortController().signal };
}

/** Full `ConditionWait` fixture with every field defaulted; tests override only what they assert on. */
function makeWait(baseline: PrBaseline, baselineGeneration: number, overrides: Partial<ConditionWait> = {}): ConditionWait & { condition: GithubPrMergedCondition; baseline: PrBaseline } {
  const base: ConditionWait & { condition: GithubPrMergedCondition; baseline: PrBaseline } = {
    wait_id: "wait-1", work_id: "work-1", item_id: "item-1",
    condition: condition(),
    source_identity: { provider: identity.provider, host: identity.host, owner: identity.owner, repo: identity.repo, number: identity.number },
    baseline_established_at: T,
    baseline, baseline_generation: baselineGeneration, source_generation: baselineGeneration,
    observed: { ...baseline }, observed_fingerprint: null, observed_generation: 1, unchanged_count: 0,
    last_observed_at: T, last_confirmed_at: T,
    state: "watching", state_reason: null,
    ready_at: null, ready_observation_fingerprint: null,
    deadline_at: T + 24 * HOUR, next_check_at: T + 300_000,
    transient_failures: 0, transient_budget: 3,
    last_error_kind: null, last_error_detail: null, retry_after_at: null,
    version: 1, actor: "owner", decision_owner: "owner",
    disposition: "redecide", resume_grant: null,
    disposition_state: null, disposition_claim_id: null, dispatch_id: null, disposition_detail: null,
    disposition_at: null, effect_observed_at: null,
    created_at: T, updated_at: T,
  };
  return { ...base, ...overrides };
}

describe("command argv safety", () => {
  test("gh is invoked as an exact argv array, never a shell string", async () => {
    const { executor, calls } = recordingExecutor(() => ({ ok: true, stdout: ghResponse(), stderr: "" }));
    await observeGithubPr(identity, executor, ctx());
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe("gh");
    expect(calls[0].args).toEqual(["pr", "view", "42", "--repo", "acme/widgets", "--json", "number,state,mergedAt,updatedAt,url"]);
    for (const arg of calls[0].args) expect(typeof arg).toBe("string");
  });

  test("shell metacharacters in owner/repo travel as one literal argv element, never interpreted", async () => {
    const hostile = { ...identity, owner: "acme; rm -rf /", repo: "widgets`touch pwned`" };
    const { executor, calls } = recordingExecutor(() => ({ ok: false, stderr: "gh: Not Found (HTTP 404)", stdout: "" }));
    await expect(observeGithubPr(hostile, executor, ctx())).rejects.toBeInstanceOf(GithubPrObservationError);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toHaveLength(7);
    expect(calls[0].args[4]).toBe("acme; rm -rf /" + "/" + "widgets`touch pwned`");
  });

  test("unsupported host never reaches the executor at all", async () => {
    const { executor, calls } = recordingExecutor(() => ({ ok: true, stdout: ghResponse(), stderr: "" }));
    await expect(observeGithubPr({ ...identity, host: "github.enterprise.internal" }, executor, ctx())).rejects.toMatchObject({ error_kind: "unsupported_provider" });
    expect(calls).toHaveLength(0);
  });

  test("ctx.signal is passed through to the executor's opts so an abort-aware executor can kill the gh child", async () => {
    const { executor, calls } = recordingExecutor(() => ({ ok: true, stdout: ghResponse(), stderr: "" }));
    const controller = new AbortController();
    await observeGithubPr(identity, executor, { now: T, signal: controller.signal });
    expect(calls).toHaveLength(1);
    expect(calls[0].signal).toBe(controller.signal);
  });
});

describe("identity parse/normalization", () => {
  test("parses provider/host/owner/repo/number from a pull URL", () => {
    expect(parseGithubPrUrl("https://github.com/Acme/Widgets/pull/42")).toEqual({ provider: "github", host: "github.com", owner: "Acme", repo: "Widgets", number: 42 });
  });
  test("rejects non-pull paths, non-https, and malformed URLs", () => {
    expect(parseGithubPrUrl("https://github.com/acme/widgets/issues/42")).toBeNull();
    expect(parseGithubPrUrl("http://github.com/acme/widgets/pull/42")).toBeNull();
    expect(parseGithubPrUrl("not a url")).toBeNull();
    expect(parseGithubPrUrl("https://github.com/acme/widgets/pull/abc")).toBeNull();
  });

  test("rule 2 + rule 3: response number and url must both exactly match the requested identity", async () => {
    const numberMismatch = recordingExecutor(() => ({ ok: true, stdout: ghResponse({ number: 99 }), stderr: "" }));
    await expect(observeGithubPr(identity, numberMismatch.executor, ctx())).rejects.toMatchObject({ error_kind: "identity_mismatch" });

    const urlMismatch = recordingExecutor(() => ({ ok: true, stdout: ghResponse({ url: "https://github.com/other/repo/pull/42" }), stderr: "" }));
    await expect(observeGithubPr(identity, urlMismatch.executor, ctx())).rejects.toMatchObject({ error_kind: "identity_mismatch" });
  });

  test("owner/repo case-insensitive round-trip still succeeds", async () => {
    const { executor } = recordingExecutor(() => ({ ok: true, stdout: ghResponse({ url: "https://github.com/Acme/Widgets/pull/42" }), stderr: "" }));
    const snapshot = await observeGithubPr(identity, executor, ctx());
    expect(snapshot.owner).toBe("acme");
    expect(snapshot.repo).toBe("widgets");
  });
});

describe("B01: repeated observation of an unchanged PR stays quiet across restarts", () => {
  test("same OPEN state twice — no readiness, generation pinned, fingerprint unchanged", async () => {
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "OPEN", mergedAt: null }), stderr: "" })).executor);
    const baseline: PrBaseline = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42, state: "OPEN", merged_at: null, updated_at: "2026-01-01T00:00:00.000Z", observed_at: T };
    const established = await adapter.establishBaseline(condition(), ctx(T));
    expect(established.baseline_generation).toBe(T); // open PR: baseline generation is the sample time, not a merge time
    const wait = makeWait(baseline, established.baseline_generation, { observed_fingerprint: established.fingerprint, source_generation: established.baseline_generation });

    const first = await adapter.observe(wait, ctx(T + HOUR));
    expect(first.kind).toBe("same");
    if (first.kind !== "same") throw new Error("unreachable");
    expect(first.source_generation).toBe(established.baseline_generation);
    expect(first.fingerprint).toBe(established.fingerprint);

    // Simulate a maintenance restart: brand-new adapter instance (no adapter-local state to lose), same wait row.
    const restarted = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "OPEN", mergedAt: null }), stderr: "" })).executor);
    const second = await restarted.observe(wait, ctx(T + 2 * HOUR));
    expect(second.kind).toBe("same");
    if (second.kind !== "same") throw new Error("unreachable");
    expect(second.source_generation).toBe(established.baseline_generation);
  });
});

describe("B02: ready observation is idempotent under replay/concurrency/stale replays", () => {
  test("a genuinely later merge timestamp is ready, with source_generation = Date.parse(mergedAt)", async () => {
    const mergedAt = new Date(T + HOUR).toISOString();
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "MERGED", mergedAt }), stderr: "" })).executor);
    const baseline: PrBaseline = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42, state: "OPEN", merged_at: null, updated_at: "2026-01-01T00:00:00.000Z", observed_at: T };
    const wait = makeWait(baseline, T, { source_generation: T });

    const obs = await adapter.observe(wait, ctx(T + 2 * HOUR));
    expect(obs.kind).toBe("ready");
    if (obs.kind !== "ready") throw new Error("unreachable");
    expect(obs.source_generation).toBe(Date.parse(mergedAt));
  });

  test("replaying the exact same source event twice concurrently yields two identical ready observations", async () => {
    const mergedAt = new Date(T + HOUR).toISOString();
    const { executor, calls } = recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "MERGED", mergedAt }), stderr: "" }));
    const adapter = createGithubPrAdapter(executor);
    const baseline: PrBaseline = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42, state: "OPEN", merged_at: null, updated_at: "2026-01-01T00:00:00.000Z", observed_at: T };
    const wait = makeWait(baseline, T, { source_generation: T });

    const [a, b] = await Promise.all([adapter.observe(wait, ctx(T + 2 * HOUR)), adapter.observe(wait, ctx(T + 2 * HOUR))]);
    expect(calls).toHaveLength(2);
    expect(a).toEqual(b);
  });

  test("once the wait's persisted source_generation already reflects this merge, the same event no longer re-triggers ready", async () => {
    const mergedAt = new Date(T + HOUR).toISOString();
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "MERGED", mergedAt }), stderr: "" })).executor);
    const baseline: PrBaseline = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42, state: "OPEN", merged_at: null, updated_at: "2026-01-01T00:00:00.000Z", observed_at: T };
    const firstWait = makeWait(baseline, T, { source_generation: T });
    const readyObs = await adapter.observe(firstWait, ctx(T + HOUR));
    expect(readyObs.kind).toBe("ready");
    if (readyObs.kind !== "ready") throw new Error("unreachable");

    // Simulates the runner having already recorded the ready transition: persisted source_generation
    // and observed_fingerprint both caught up to that exact observation.
    const advancedWait = makeWait(baseline, T, { source_generation: readyObs.source_generation, observed_fingerprint: readyObs.fingerprint });
    const obs = await adapter.observe(advancedWait, ctx(T + 3 * HOUR));
    expect(obs.kind).toBe("same");
  });

  test("an out-of-order older merge timestamp than the persisted generation never reads as ready", async () => {
    const olderMergedAt = new Date(T - HOUR).toISOString();
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "MERGED", mergedAt: olderMergedAt }), stderr: "" })).executor);
    const baseline: PrBaseline = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42, state: "OPEN", merged_at: null, updated_at: "2026-01-01T00:00:00.000Z", observed_at: T };
    const wait = makeWait(baseline, T, { source_generation: T }); // baseline/current generation T > olderMergedAt

    const obs = await adapter.observe(wait, ctx(T + HOUR));
    expect(obs.kind).not.toBe("ready");
  });
});

describe("B03: a PR merged before the wait existed never fires ready for that same fact", () => {
  test("baseline sampled after the merge — the identical mergedAt observed again stays quiet", async () => {
    const mergeTime = T - HOUR; // the PR was merged before the wait's baseline was even sampled
    const mergedAt = new Date(mergeTime).toISOString();
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "MERGED", mergedAt }), stderr: "" })).executor);

    const established = await adapter.establishBaseline(condition(), ctx(T)); // establishBaseline observes the already-merged PR
    expect(established.baseline.merged_at).toBe(mergedAt);
    expect(established.baseline_generation).toBe(mergeTime); // baseline generation = merge time, not the sample time

    const wait = makeWait(established.baseline, established.baseline_generation, { observed_fingerprint: established.fingerprint, source_generation: established.baseline_generation, created_at: T + 1000 });
    const obs = await adapter.observe(wait, ctx(T + HOUR));
    expect(obs.kind).toBe("same"); // NOT ready: mergedAt is not strictly later than baseline's own merged_at
  });

  test("baseline established while OPEN requires the merge to be strictly later than the baseline sample time", async () => {
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "OPEN", mergedAt: null }), stderr: "" })).executor);
    const established = await adapter.establishBaseline(condition(), ctx(T));
    expect(established.baseline.merged_at).toBeNull();
    expect(established.baseline_generation).toBe(T); // null merged_at: baseline generation falls back to observed_at

    // A merge timestamp equal to (not later than) the baseline sample time must not ready.
    const notLaterAdapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "MERGED", mergedAt: new Date(T).toISOString() }), stderr: "" })).executor);
    const wait = makeWait(established.baseline, established.baseline_generation, { observed_fingerprint: established.fingerprint, source_generation: established.baseline_generation });
    const obs = await notLaterAdapter.observe(wait, ctx(T + HOUR));
    expect(obs.kind).not.toBe("ready");
  });
});

describe("B04: error classification is exact and never conflated with an unmerged PR", () => {
  test("401/403 auth failures classify as permission_denied", async () => {
    const cases = ["gh: Bad credentials (HTTP 401)", "gh: Resource not accessible by integration (HTTP 403)", "gh: Not Found (HTTP 404)"];
    for (const stderr of cases) {
      const { executor } = recordingExecutor(() => ({ ok: false, stderr, stdout: "" }));
      await expect(observeGithubPr(identity, executor, ctx())).rejects.toMatchObject({ error_kind: "permission_denied" });
    }
  });

  test("non-github.com host classifies as unsupported_provider without ever calling gh", async () => {
    const { executor, calls } = recordingExecutor(() => ({ ok: true, stdout: ghResponse(), stderr: "" }));
    await expect(observeGithubPr({ ...identity, host: "github.enterprise.example" }, executor, ctx())).rejects.toMatchObject({ error_kind: "unsupported_provider" });
    expect(calls).toHaveLength(0);
  });

  test("429/rate-limit failures classify as rate_limited and parse a genuine Retry-After hint", async () => {
    const withHeader = recordingExecutor(() => ({ ok: false, stderr: "gh: API rate limit exceeded for user ID 123. (HTTP 403) Retry-After: 120", stdout: "" }));
    const now = T;
    const errWithHeader = await observeGithubPr(identity, withHeader.executor, ctx(now)).catch((e) => e);
    expect(errWithHeader).toBeInstanceOf(GithubPrObservationError);
    expect(errWithHeader.error_kind).toBe("rate_limited");
    expect(errWithHeader.retry_after_at).toBe(now + 120_000);

    const withPhrase = recordingExecutor(() => ({ ok: false, stderr: "You have exceeded a secondary rate limit. Please retry after 2 minutes.", stdout: "" }));
    const errWithPhrase = await observeGithubPr(identity, withPhrase.executor, ctx(now)).catch((e) => e);
    expect(errWithPhrase.error_kind).toBe("rate_limited");
    expect(errWithPhrase.retry_after_at).toBe(now + 120_000);

    const withoutHint = recordingExecutor(() => ({ ok: false, stderr: "gh: API rate limit exceeded for user ID 123. (HTTP 403)", stdout: "" }));
    const errWithoutHint = await observeGithubPr(identity, withoutHint.executor, ctx(now)).catch((e) => e);
    expect(errWithoutHint.error_kind).toBe("rate_limited");
    expect(errWithoutHint.retry_after_at).toBeUndefined();
  });

  test("network failures classify as transient", async () => {
    const cases = ["gh: could not resolve host: api.github.com", "dial tcp: connection refused", "gh: the request timed out", "gh: 503 Service Unavailable"];
    for (const stderr of cases) {
      const { executor } = recordingExecutor(() => ({ ok: false, stderr, stdout: "" }));
      await expect(observeGithubPr(identity, executor, ctx())).rejects.toMatchObject({ error_kind: "transient" });
    }
  });

  test("unclassifiable failures are unknown, never treated as an unmerged PR", async () => {
    const { executor } = recordingExecutor(() => ({ ok: false, stderr: "gh: something completely unexpected happened", stdout: "" }));
    await expect(observeGithubPr(identity, executor, ctx())).rejects.toMatchObject({ error_kind: "unknown" });
  });

  test("malformed or semantically invalid JSON responses classify as invalid_response", async () => {
    const malformed = recordingExecutor(() => ({ ok: true, stdout: "not json", stderr: "" }));
    await expect(observeGithubPr(identity, malformed.executor, ctx())).rejects.toMatchObject({ error_kind: "invalid_response" });

    const array = recordingExecutor(() => ({ ok: true, stdout: "[]", stderr: "" }));
    await expect(observeGithubPr(identity, array.executor, ctx())).rejects.toMatchObject({ error_kind: "invalid_response" });

    const badState = recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "DRAFT" }), stderr: "" }));
    await expect(observeGithubPr(identity, badState.executor, ctx())).rejects.toMatchObject({ error_kind: "invalid_response" });

    const badMergedAt = recordingExecutor(() => ({ ok: true, stdout: JSON.stringify({ number: 42, state: "MERGED", mergedAt: "not-a-date", updatedAt: "2026-01-01T00:00:00.000Z", url: "https://github.com/acme/widgets/pull/42" }), stderr: "" }));
    await expect(observeGithubPr(identity, badMergedAt.executor, ctx())).rejects.toMatchObject({ error_kind: "invalid_response" });

    const missingUpdatedAt = recordingExecutor(() => ({ ok: true, stdout: JSON.stringify({ number: 42, state: "OPEN", mergedAt: null, url: "https://github.com/acme/widgets/pull/42" }), stderr: "" }));
    await expect(observeGithubPr(identity, missingUpdatedAt.executor, ctx())).rejects.toMatchObject({ error_kind: "invalid_response" });
  });

  test("error detail is bounded and redacts embedded credentials, never storing the raw stderr", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const longStderr = `gh: Bad credentials (HTTP 401) using token ${token} ` + "x".repeat(500);
    const { executor } = recordingExecutor(() => ({ ok: false, stderr: longStderr, stdout: "" }));
    const error = await observeGithubPr(identity, executor, ctx()).catch((e) => e);
    expect(error).toBeInstanceOf(GithubPrObservationError);
    expect(error.message.length).toBeLessThan(250);
    expect(error.message).not.toContain(token);
    expect(error.message.length).toBeLessThan(longStderr.length);
  });
});

describe("closed-without-merge does not masquerade as an error or as merged", () => {
  test("CLOSED state observes as changed_not_ready/same, never ready and never error", async () => {
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: true, stdout: ghResponse({ state: "CLOSED", mergedAt: null }), stderr: "" })).executor);
    const baseline: PrBaseline = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42, state: "OPEN", merged_at: null, updated_at: "2026-01-01T00:00:00.000Z", observed_at: T };
    const wait = makeWait(baseline, T, { observed_fingerprint: "different-fingerprint-from-open-state", source_generation: T });
    const obs = await adapter.observe(wait, ctx(T + HOUR));
    expect(obs.kind).toBe("changed_not_ready");
  });
});

describe("adapter.observe surfaces classified errors as WaitObservation, never throws them", () => {
  test("a gh failure inside adapter.observe returns kind:'error' with the exact classification", async () => {
    const adapter = createGithubPrAdapter(recordingExecutor(() => ({ ok: false, stderr: "gh: Bad credentials (HTTP 401)", stdout: "" })).executor);
    const baseline: PrBaseline = { provider: "github", host: "github.com", owner: "acme", repo: "widgets", number: 42, state: "OPEN", merged_at: null, updated_at: "2026-01-01T00:00:00.000Z", observed_at: T };
    const wait = makeWait(baseline, T, { source_generation: T });
    const obs = await adapter.observe(wait, ctx(T + HOUR));
    expect(obs.kind).toBe("error");
    if (obs.kind !== "error") throw new Error("unreachable");
    expect(obs.error_kind).toBe("permission_denied");
    expect(obs.retry_after_at).toBeUndefined();
  });
});

describe("ctx.signal", () => {
  test("an already-aborted signal short-circuits before the gh call", async () => {
    const { executor, calls } = recordingExecutor(() => ({ ok: true, stdout: ghResponse(), stderr: "" }));
    const controller = new AbortController();
    controller.abort();
    await expect(observeGithubPr(identity, executor, { now: T, signal: controller.signal })).rejects.toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});
