import { defaultCommandExecutor } from "../../orchestrator/worktree";
import { controlPayloadHash } from "../../control/outbox";
import type {
  GithubPrMergedCondition,
  ObserveContext,
  PrBaseline,
  WaitBaselineSnapshot,
  WaitErrorKind,
  WaitObservation,
  WaitSourceAdapter,
} from "../../control/types";

/**
 * Widened executor shape: structurally compatible with the shared `CommandExecutor` (so
 * `defaultCommandExecutor` stays directly assignable and `../../orchestrator/worktree` is
 * untouched), but lets a caller's abort-aware executor receive `ctx.signal` and actually kill the
 * `gh` child process (TERM→KILL) instead of only detaching from a settled-but-still-running one.
 */
export type GhExecutor = (cmd: string, args: string[], opts?: { cwd?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * §6.1 GitHub PR merged provider (docs/plans/overload-20260926-phaseB-contract.md).
 * Read-only observation of one PR's merge state via `gh pr view <number> --repo <owner>/<repo>
 * --json number,state,mergedAt,updatedAt,url`, run as an argv array through the injected
 * `GhExecutor` (never a shell string). This module never writes any control/Attention/Work
 * state and never starts execution — the runner and create-service (§5.3) own every `ConditionWait`
 * mutation; adapters only observe.
 */

export type GithubPrSnapshot = {
  provider: "github";
  host: string;
  owner: string;
  repo: string;
  number: number;
  state: "OPEN" | "CLOSED" | "MERGED";
  merged_at: string | null;
  updated_at: string;
  url: string;
  observed_at: number;
};

/** Thrown by `observeGithubPr` carrying the exact §6.1/§7.2.6 error classification. */
export class GithubPrObservationError extends Error {
  readonly error_kind: WaitErrorKind;
  readonly retry_after_at?: number;
  constructor(error_kind: WaitErrorKind, detail: string, retry_after_at?: number) {
    super(detail);
    this.name = "GithubPrObservationError";
    this.error_kind = error_kind;
    this.retry_after_at = retry_after_at;
  }
}

const MAX_DETAIL_LEN = 200;

// gh/GitHub token prefixes (classic PAT, OAuth, user-to-server, server-to-server, refresh token,
// fine-grained PAT) plus generic bearer/authorization header leakage. The bounded truncation in
// `sanitizeDetail` below is the second, independent safeguard: "detail 必须脱敏且有界，不保存
// token/完整 stderr" (§6.1) requires both redaction of known secret shapes AND a hard length cap.
const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/gi,
  /github_pat_[A-Za-z0-9_]{20,}/gi,
  /bearer\s+[A-Za-z0-9._-]{10,}/gi,
  /authorization:\s*\S+/gi,
];

function sanitizeDetail(raw: string): string {
  let text = raw;
  for (const pattern of TOKEN_PATTERNS) text = text.replace(pattern, "[redacted]");
  text = text.replace(/\s+/g, " ").trim();
  if (!text) text = "gh pr view failed";
  return text.length > MAX_DETAIL_LEN ? `${text.slice(0, MAX_DETAIL_LEN)}\u2026(truncated)` : text;
}

/** Best-effort extraction of a genuine provider-given retry hint; absent a trustworthy hint the
 * caller must fall back to its own bounded backoff (§7.2.6) — this function never invents one. */
function parseRetryAfterAt(raw: string, now: number): number | undefined {
  const header = raw.match(/retry-after\s*:?\s*(\d+)/i);
  if (header) return now + Number(header[1]) * 1000;
  const phrase = raw.match(/retry\s+after\s+(\d+)\s*(seconds?|secs?|s\b|minutes?|mins?|m\b)?/i);
  if (phrase) {
    const value = Number(phrase[1]);
    const unit = (phrase[2] ?? "s").toLowerCase();
    const seconds = unit.startsWith("m") ? value * 60 : value;
    return now + seconds * 1000;
  }
  const resets = raw.match(/resets?\s+at\s+([0-9T:.\-+Z]+)/i);
  if (resets) {
    const parsed = Date.parse(resets[1]);
    if (!Number.isNaN(parsed) && parsed > now) return parsed;
  }
  return undefined;
}

/**
 * §6.1: "认证/授权为 permission_denied（直接 unavailable），不可支持 host 为 unsupported_provider
 * （直接 unavailable），429/明确临时网络为 transient/rate-limit；无法可靠分类为 unknown，不能当
 * 未合并。" Order matters: rate-limit phrasing is checked first because GitHub's secondary-rate-limit
 * and abuse-detection responses also carry HTTP 403, which would otherwise match the permission check.
 */
function classifyGhFailure(stderr: string, stdout: string, now: number): GithubPrObservationError {
  const raw = `${stderr}\n${stdout}`.trim();
  const text = raw.toLowerCase();
  const detail = sanitizeDetail(raw);

  if (/rate limit|too many requests|\b429\b|secondary rate limit|abuse detection/.test(text)) {
    return new GithubPrObservationError("rate_limited", detail, parseRetryAfterAt(raw, now));
  }
  if (/not authenticated|bad credentials|authentication failed|requires authentication|\b401\b|\b403\b|permission denied|resource not accessible|\b404\b/.test(text)) {
    return new GithubPrObservationError("permission_denied", detail);
  }
  if (/could not resolve host|connection refused|timed? ?out|network is unreachable|econnreset|econnrefused|socket hang up|dial tcp|\b50[234]\b|service unavailable|tls handshake/.test(text)) {
    return new GithubPrObservationError("transient", detail);
  }
  return new GithubPrObservationError("unknown", detail);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses a `gh` PR `url` field back into a normalized identity for the §6.1 rule-3 round-trip check. */
export function parseGithubPrUrl(url: string): { provider: "github"; host: string; owner: string; repo: string; number: number } | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== "https:") return null;
  const parts = parsed.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length < 4 || parts[2] !== "pull") return null;
  const number = Number(parts[3]);
  if (!Number.isSafeInteger(number) || number <= 0) return null;
  return { provider: "github", host: parsed.hostname.toLowerCase(), owner: parts[0], repo: parts[1], number };
}

/** Races the executor call against `ctx.signal` so the returned promise settles promptly on abort
 * (no left-behind detached wait); killing the underlying child process is the executor's own concern. */
async function runGh(executor: GhExecutor, args: string[], ctx: ObserveContext): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  ctx.signal.throwIfAborted();
  const aborted = new Promise<never>((_, reject) => {
    ctx.signal.addEventListener("abort", () => reject(ctx.signal.reason ?? new Error("aborted")), { once: true });
  });
  return Promise.race([executor("gh", args, { signal: ctx.signal }), aborted]);
}

/**
 * §6.1 low-level observation: exact argv (no shell), then the five verification rules in order —
 * host support, response `number` equality, response `url` round-trip identity, and (by the caller,
 * which has the baseline/prior generation) the merged-timestamp readiness comparison. Throws a typed
 * `GithubPrObservationError` for every failure path; never returns a snapshot that hasn't passed rules
 * 1–3, and never treats an unclassifiable failure as "not merged".
 */
export async function observeGithubPr(
  identity: GithubPrMergedCondition["source"],
  executor: GhExecutor,
  ctx: ObserveContext,
): Promise<GithubPrSnapshot> {
  if (identity.provider !== "github") {
    throw new GithubPrObservationError("unsupported_provider", `unsupported provider: ${sanitizeDetail(String(identity.provider))}`);
  }
  // §6.1 rule 1: GitHub Enterprise (or any non-github.com host) is not implemented in this version;
  // fail closed instead of silently querying github.com on the caller's behalf.
  if (identity.host !== "github.com") {
    throw new GithubPrObservationError("unsupported_provider", `unsupported host: ${sanitizeDetail(identity.host)}`);
  }

  const result = await runGh(executor, [
    "pr", "view", String(identity.number),
    "--repo", `${identity.owner}/${identity.repo}`,
    "--json", "number,state,mergedAt,updatedAt,url",
  ], ctx);
  ctx.signal.throwIfAborted();

  if (!result.ok) throw classifyGhFailure(result.stderr, result.stdout, ctx.now);

  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new GithubPrObservationError("invalid_response", "gh pr view returned invalid JSON");
  }
  if (!isPlainObject(data)) throw new GithubPrObservationError("invalid_response", "gh pr view returned a non-object response");

  const { number, state, mergedAt, updatedAt, url } = data;
  if (typeof number !== "number" || !Number.isSafeInteger(number)) {
    throw new GithubPrObservationError("invalid_response", "response is missing a valid numeric number field");
  }
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    throw new GithubPrObservationError("invalid_response", "response has an unrecognized state field");
  }
  if (mergedAt !== null && typeof mergedAt !== "string") {
    throw new GithubPrObservationError("invalid_response", "response mergedAt is neither null nor a string");
  }
  if (mergedAt !== null && Number.isNaN(Date.parse(mergedAt))) {
    throw new GithubPrObservationError("invalid_response", "response mergedAt is not a valid timestamp");
  }
  if (typeof updatedAt !== "string" || !updatedAt || Number.isNaN(Date.parse(updatedAt))) {
    throw new GithubPrObservationError("invalid_response", "response is missing a valid updatedAt timestamp");
  }
  if (typeof url !== "string" || !url) {
    throw new GithubPrObservationError("invalid_response", "response is missing a url field");
  }

  // §6.1 rule 2: the response's own `number` must match exactly what was requested.
  if (number !== identity.number) {
    throw new GithubPrObservationError("identity_mismatch", `gh returned PR #${number}, requested #${identity.number}`);
  }

  // §6.1 rule 3: round-trip the response `url` back into a normalized identity and require an exact
  // match; this is the read-back proof that `--repo` actually targeted the intended owner/repo.
  const parsedUrl = parseGithubPrUrl(url);
  if (
    !parsedUrl ||
    parsedUrl.host !== identity.host ||
    parsedUrl.owner.toLowerCase() !== identity.owner.toLowerCase() ||
    parsedUrl.repo.toLowerCase() !== identity.repo.toLowerCase() ||
    parsedUrl.number !== identity.number
  ) {
    throw new GithubPrObservationError("identity_mismatch", "gh response url does not match the requested owner/repo/number");
  }

  return {
    provider: "github",
    host: identity.host,
    owner: identity.owner,
    repo: identity.repo,
    number: identity.number,
    state,
    merged_at: mergedAt,
    updated_at: updatedAt,
    url,
    observed_at: ctx.now,
  };
}

/** Semantic fingerprint over verified identity + state + mergedAt only — never updatedAt/poll time
 * (§6.1 rule 4), so a plain metadata refresh never looks like a real change. Reused identically by
 * `establishBaseline` and `observe` so an unchanged PR always round-trips to the same fingerprint. */
function semanticFingerprint(snapshot: Pick<GithubPrSnapshot, "provider" | "host" | "owner" | "repo" | "number" | "state" | "merged_at">): string {
  return controlPayloadHash({
    provider: snapshot.provider,
    host: snapshot.host,
    owner: snapshot.owner,
    repo: snapshot.repo,
    number: snapshot.number,
    state: snapshot.state,
    merged_at: snapshot.merged_at,
  });
}

/**
 * §5.3/§6.1 production adapter. Pure observation only: it never calls any `control` store mutation,
 * never touches Attention/Work, and never starts execution — the runner/create-service are the sole
 * mutation owners. `executor` defaults to the real `gh` CLI via the shared `defaultCommandExecutor`,
 * but every test must inject a deterministic fake so this module never touches the network.
 */
export function createGithubPrAdapter(executor: GhExecutor = defaultCommandExecutor): WaitSourceAdapter<GithubPrMergedCondition, PrBaseline> {
  return {
    kind: "github_pr_merged",

    async establishBaseline(condition, ctx): Promise<WaitBaselineSnapshot<PrBaseline>> {
      const snapshot = await observeGithubPr(condition.source, executor, ctx);
      const baseline: PrBaseline = {
        provider: snapshot.provider,
        host: snapshot.host,
        owner: snapshot.owner,
        repo: snapshot.repo,
        number: snapshot.number,
        state: snapshot.state,
        merged_at: snapshot.merged_at,
        updated_at: snapshot.updated_at,
        observed_at: snapshot.observed_at,
      };
      // §6.1 rule 4 / §5.1: baseline generation is the merge timestamp when the PR is already merged
      // at baseline time, otherwise the baseline sample time itself — never a poll/updatedAt time.
      const baseline_generation = baseline.merged_at ? Date.parse(baseline.merged_at) : baseline.observed_at;
      return {
        baseline,
        baseline_generation,
        fingerprint: semanticFingerprint(snapshot),
        established_at: snapshot.observed_at,
      };
    },

    async observe(wait, ctx): Promise<WaitObservation> {
      let snapshot: GithubPrSnapshot;
      try {
        snapshot = await observeGithubPr(wait.condition.source, executor, ctx);
      } catch (error) {
        if (error instanceof GithubPrObservationError) {
          return {
            kind: "error",
            error_kind: error.error_kind,
            detail: error.message,
            observed_at: ctx.now,
            ...(error.retry_after_at !== undefined ? { retry_after_at: error.retry_after_at } : {}),
          };
        }
        throw error;
      }

      const fingerprint = semanticFingerprint(snapshot);
      // §7.2.5: ready requires the candidate generation to be strictly greater than both the fixed
      // baseline generation and the current persisted high-water mark (they are equal pre-ready for
      // this source, per §6.1 rule 5, but both are checked to stay correct under any future change).
      const priorGeneration = Math.max(wait.baseline_generation, wait.source_generation);
      const candidateGeneration = snapshot.merged_at ? Date.parse(snapshot.merged_at) : NaN;
      const isReady = snapshot.state === "MERGED" && snapshot.merged_at !== null && !Number.isNaN(candidateGeneration) && candidateGeneration > priorGeneration;

      if (isReady) {
        return { kind: "ready", observed: { ...snapshot }, fingerprint, source_generation: candidateGeneration, observed_at: ctx.now };
      }
      // §6.1 rule 5: before a valid later merge timestamp exists, the source generation stays pinned
      // at the wait's current persisted high-water mark; it never advances on updatedAt/poll time.
      if (fingerprint === wait.observed_fingerprint) {
        return { kind: "same", observed: { ...snapshot }, fingerprint, source_generation: wait.source_generation, observed_at: ctx.now };
      }
      return { kind: "changed_not_ready", observed: { ...snapshot }, fingerprint, source_generation: wait.source_generation, observed_at: ctx.now };
    },
  };
}
