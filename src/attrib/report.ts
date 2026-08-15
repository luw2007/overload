import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_SINCE_MS = 24 * 60 * 60_000;
const WINDOW_PADDING_MS = 5 * 60_000;

export type AttribGrade = "trailer" | "head_observed" | "window_correlated" | "unattributed";

export type AttribReport = {
  rows: Array<{
    sha: string;
    repo: string;
    at: number;
    grade: AttribGrade;
    stable_id?: string;
  }>;
  universe: string[];
};

type Commit = { sha: string; repo: string; at: number; trailer?: string };
type SessionCwd = { stable_id: string; cwd: string | null; origin: string | null };
type ObservedCommit = { stable_id: string; detail: string | null };
type ActivityRow = { stable_id: string; first_at: number; last_at: number };
type ActivityWindow = ActivityRow & { repo: string };

/**
 * Build a read-only commit attribution report from the ledger and local git
 * repositories. Invalid or unavailable repository paths are omitted rather
 * than making the entire report unavailable.
 */
export async function generateAttribReport(
  db: Database,
  opts: { sinceMs?: number; repos?: string[] },
): Promise<AttribReport> {
  const sinceMs = validSince(opts.sinceMs);
  const sinceAt = Date.now() - sinceMs;
  const sessionCwds = db.query("SELECT stable_id, cwd, origin FROM sessions WHERE cwd IS NOT NULL").all() as SessionCwd[];
  const configuredRepos = await loadConfiguredRepos();
  const candidates = [
    ...sessionCwds.map((session) => session.cwd),
    ...(opts.repos ?? []),
    ...configuredRepos,
  ].filter((path): path is string => typeof path === "string" && path.length > 0);

  const rootsByCandidate = new Map<string, string | null>();
  await Promise.all(candidates.map(async (candidate) => {
    rootsByCandidate.set(candidate, await repositoryRoot(candidate));
  }));
  const universe = [...new Set([...rootsByCandidate.values()].filter((root): root is string => root !== null))].sort();

  const sessionRepos = new Map<string, string>();
  for (const session of sessionCwds) {
    if (!session.cwd || session.origin !== "agent") continue;
    const root = rootsByCandidate.get(session.cwd) ?? null;
    if (root) sessionRepos.set(session.stable_id, root);
  }

  const [commitsByRepo, observed, windows] = await Promise.all([
    Promise.all(universe.map((repo) => enumerateCommits(repo, sinceAt))),
    Promise.resolve(observedCommits(db)),
    Promise.resolve(activityWindows(db, sessionRepos)),
  ]);
  const rows = commitsByRepo.flat().map((commit) => gradeCommit(commit, observed, windows));
  rows.sort((a, b) => b.at - a.at || a.repo.localeCompare(b.repo) || a.sha.localeCompare(b.sha));
  return { rows, universe };
}

function validSince(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : DEFAULT_SINCE_MS;
}

async function loadConfiguredRepos(): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(homedir(), ".overload", "config.json"), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const repos = (parsed as Record<string, unknown>).attrib_repos;
    return Array.isArray(repos) ? repos.filter((repo): repo is string => typeof repo === "string" && repo.length > 0) : [];
  } catch {
    return [];
  }
}

async function repositoryRoot(path: string): Promise<string | null> {
  const result = await git(["-C", path, "rev-parse", "--show-toplevel"]);
  return result.ok ? result.stdout.trim() || null : null;
}

async function enumerateCommits(repo: string, sinceAt: number): Promise<Commit[]> {
  // NUL-delimited fields avoid ambiguity from trailer text and unusual paths.
  const format = "%H%x00%at%x00%(trailers:key=Overload-Session,valueonly,separator=%x1f)%x00";
  const result = await git([
    "-C", repo, "log", `--since=${new Date(sinceAt).toISOString()}`, `--format=${format}`,
  ]);
  if (!result.ok) return [];
  const fields = result.stdout.split("\0");
  const commits: Commit[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]!.trimStart();
    const seconds = Number(fields[index + 1]);
    const trailers = fields[index + 2]!.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(sha) || !Number.isFinite(seconds)) continue;
    const trailer = trailers.split("\x1f").map((value) => value.trim()).find(Boolean);
    commits.push({ sha, repo, at: seconds * 1_000, ...(trailer ? { trailer } : {}) });
  }
  return commits;
}

function observedCommits(db: Database): Map<string, string> {
  const rows = db.query("SELECT stable_id, detail FROM journal WHERE kind='commit_observed'").all() as ObservedCommit[];
  const observed = new Map<string, string>();
  for (const row of rows) {
    try {
      const detail = JSON.parse(row.detail ?? "{}") as Record<string, unknown>;
      if (typeof detail.sha === "string" && detail.sha.length > 0 && !observed.has(detail.sha)) {
        observed.set(detail.sha, row.stable_id);
      }
    } catch {
      // Malformed historical detail is not attribution evidence.
    }
  }
  return observed;
}

function activityWindows(db: Database, sessionRepos: Map<string, string>): ActivityWindow[] {
  const rows = db.query(`SELECT stable_id, MIN(at) AS first_at, MAX(at) AS last_at
    FROM journal GROUP BY stable_id`).all() as ActivityRow[];
  return rows.flatMap((row) => {
    const repo = sessionRepos.get(row.stable_id);
    return repo ? [{ ...row, repo }] : [];
  });
}

function gradeCommit(commit: Commit, observed: Map<string, string>, windows: ActivityWindow[]): AttribReport["rows"][number] {
  if (commit.trailer) {
    return { ...baseRow(commit), grade: "trailer", stable_id: trailerStableId(commit.trailer) };
  }
  const observedStableId = observed.get(commit.sha);
  if (observedStableId) {
    return { ...baseRow(commit), grade: "head_observed", stable_id: observedStableId };
  }

  const correlated = windows
    .filter((window) => window.repo === commit.repo
      && commit.at >= window.first_at - WINDOW_PADDING_MS
      && commit.at <= window.last_at + WINDOW_PADDING_MS)
    .map((window) => ({
      window,
      overlap: Math.max(0,
        Math.min(window.last_at + WINDOW_PADDING_MS, commit.at + WINDOW_PADDING_MS)
        - Math.max(window.first_at - WINDOW_PADDING_MS, commit.at - WINDOW_PADDING_MS)),
    }))
    .sort((a, b) => b.overlap - a.overlap || a.window.stable_id.localeCompare(b.window.stable_id))[0];
  if (correlated) {
    return { ...baseRow(commit), grade: "window_correlated", stable_id: correlated.window.stable_id };
  }
  return { ...baseRow(commit), grade: "unattributed" };
}

function baseRow(commit: Commit): { sha: string; repo: string; at: number } {
  return { sha: commit.sha, repo: commit.repo, at: commit.at };
}

function trailerStableId(value: string): string {
  const separator = value.indexOf("#");
  return (separator === -1 ? value : value.slice(0, separator)).trim();
}

async function git(argv: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    // Review P4 m5: bounded like the extension's execGit — a hung network
    // mount must not wedge the on-demand report.
    const proc = Bun.spawn(["git", ...argv], { stdout: "pipe", stderr: "pipe", timeout: 5_000, killSignal: "SIGKILL" });
    const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { ok: exitCode === 0, stdout };
  } catch {
    return { ok: false, stdout: "" };
  }
}
