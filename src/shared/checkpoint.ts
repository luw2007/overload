import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Runtime checkpoint probe (Phase B §8.4.4). A recorded runtime session id is only proof of a resumable checkpoint when
 * exactly one session file under the runtime's session root carries it as its header id, that header names the recorded
 * cwd, and the file's last non-empty line is complete JSON. The extension may record a random fallback id that no
 * runtime ever wrote, so absence of a file is never treated as "resume will create it".
 */
export type Checkpoint = { runtime: "pi" | "omp"; session: string; cwd: string; file: string; header_id: string; last_entry_id: string | null; byte_len: number; mtime_ms: number };
export type CheckpointResult =
  | { valid: true; checkpoint: Checkpoint }
  | { valid: false; reason: "no_session_file" | "ambiguous_session_file" | "cwd_mismatch" | "truncated_tail" | "unreadable" | "unsupported_runtime" };

type Runtime = Checkpoint["runtime"];
type Invalid = Extract<CheckpointResult, { valid: false }>;

const HEAD_BYTES = 64 * 1024;
const TAIL_CHUNK = 64 * 1024;

export const defaultSessionRoots = (): Record<Runtime, string> => ({
  pi: join(homedir(), ".pi", "agent", "sessions"),
  omp: join(homedir(), ".omp", "agent", "sessions"),
});

/**
 * Candidates are the `*.jsonl` files one level under the runtime root (per-cwd directories; nested subagent session
 * directories are not top-level resumable sessions) whose file name contains the session id — both runtimes name files
 * `<timestamp>_<session id>.jsonl` — and the header is then read to prove the id instead of trusting the name.
 */
export function probeCheckpoint(input: { runtime: string; session: string; cwd: string }, deps?: { sessionRoots?: Record<"pi" | "omp", string> }): CheckpointResult {
  return probeListed(input, listRoot, deps);
}

/**
 * A probe for one list response. Each runtime root is listed once, on first use, and reused for every later row;
 * `probeCheckpoint` would re-list every per-cwd directory for every row, so a 100-row list costs ~100k stat/readdir
 * syscalls, and the launchd web job runs at Background I/O priority. Create one per request: a snapshot never outlives it.
 */
export function listingSnapshotProbe(deps?: { sessionRoots?: Record<"pi" | "omp", string> }): (input: { runtime: string; session: string; cwd: string }) => CheckpointResult {
  const listings = new Map<string, RootListing>();
  const list = (root: string): RootListing => {
    let listing = listings.get(root);
    if (!listing) { listing = listRoot(root); listings.set(root, listing); }
    return listing;
  };
  return (input) => probeListed(input, list, deps);
}

/** Per-cwd directories of a runtime root with their `*.jsonl` names; an unlistable per-cwd directory is skipped. */
type RootListing = Array<{ dir: string; names: string[] }> | Invalid;
function listRoot(root: string): RootListing {
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { valid: false, reason: "no_session_file" } : { valid: false, reason: "unreadable" };
  }
  const listing: Array<{ dir: string; names: string[] }> = [];
  for (const dir of projectDirs) {
    const names = sessionFileNames(dir);
    if (names) listing.push({ dir, names });
  }
  return listing;
}

function probeListed(input: { runtime: string; session: string; cwd: string }, list: (root: string) => RootListing, deps?: { sessionRoots?: Record<"pi" | "omp", string> }): CheckpointResult {
  if (input.runtime !== "pi" && input.runtime !== "omp") return { valid: false, reason: "unsupported_runtime" };
  const runtime: Runtime = input.runtime;
  const { session, cwd } = input;
  if (!session) return { valid: false, reason: "no_session_file" };
  const listing = list((deps?.sessionRoots ?? defaultSessionRoots())[runtime]);
  if (!Array.isArray(listing)) return listing;

  const matches: Array<{ file: string; header: { id: string; cwd: unknown } }> = [];
  let unreadable = false;
  for (const { dir, names } of listing) {
    for (const name of names) {
      if (!name.endsWith(".jsonl") || !name.includes(session)) continue;
      const file = join(dir, name);
      const header = readHeader(file);
      if (header === "unreadable") { unreadable = true; continue; }
      if (header?.id === session) matches.push({ file, header });
    }
  }
  if (matches.length > 1) return { valid: false, reason: "ambiguous_session_file" };
  if (matches.length === 0) return { valid: false, reason: unreadable ? "unreadable" : "no_session_file" };
  const [{ file, header }] = matches;
  if (header.cwd !== cwd) return { valid: false, reason: "cwd_mismatch" };

  const tail = readTail(file);
  if ("reason" in tail) return tail;
  return {
    valid: true,
    checkpoint: { runtime, session, cwd, file, header_id: header.id, last_entry_id: tail.lastEntryId, byte_len: tail.size, mtime_ms: tail.mtimeMs },
  };
}

/**
 * Shell-free argv that reopens exactly the probed file. pi selects by file (`pi --session-id` would create a missing
 * session); omp's `--resume` takes an ID prefix or a path (`omp --help`), so the proven path is passed, never re-resolved.
 */
export function resumeArgv(cp: Checkpoint): string[] {
  return cp.runtime === "pi" ? ["pi", "--session", cp.file] : ["omp", `--resume=${cp.file}`];
}

/**
 * Directory listings are memoised per directory mtime: adding, removing or renaming a session file bumps the
 * directory's mtime, so a cached listing is only reused while the set of names is unchanged. This keeps list
 * endpoints (one probe per row across thousands of files) from re-reading every directory on every row.
 */
const listingCache = new Map<string, { mtimeMs: number; names: string[] }>();
function sessionFileNames(dir: string): string[] | null {
  try {
    const { mtimeMs } = statSync(dir);
    const cached = listingCache.get(dir);
    if (cached?.mtimeMs === mtimeMs) return cached.names;
    const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    listingCache.set(dir, { mtimeMs, names });
    return names;
  } catch { return null; }
}

/** Header = first `type:"session"` record; omp may precede it with a rewritten-in-place `type:"title"` line. */
function readHeader(file: string): { id: string; cwd: unknown } | null | "unreadable" {
  let text: string;
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      text = buffer.subarray(0, readSync(fd, buffer, 0, HEAD_BYTES, 0)).toString("utf8");
    } finally { closeSync(fd); }
  } catch { return "unreadable"; }
  const lines = text.split("\n");
  // The final segment may be cut by the read window; only complete lines are parsed.
  if (text.length === HEAD_BYTES) lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const record = parseJson(line);
    if (!record || typeof record !== "object") return "unreadable";
    const { type, id, cwd } = record as { type?: unknown; id?: unknown; cwd?: unknown };
    if (type === "title") continue;
    return type === "session" && typeof id === "string" ? { id, cwd } : null;
  }
  return null;
}

/** Reads backwards until the last non-empty line is whole, then requires it to parse as JSON. */
function readTail(file: string): { lastEntryId: string | null; size: number; mtimeMs: number } | Invalid {
  let fd: number;
  try { fd = openSync(file, "r"); } catch { return { valid: false, reason: "unreadable" }; }
  try {
    const stat = fstatSync(fd);
    const size = stat.size;
    let start = size;
    let text = "";
    while (true) {
      const next = Math.max(0, start - TAIL_CHUNK);
      const buffer = Buffer.alloc(start - next);
      readSync(fd, buffer, 0, buffer.length, next);
      start = next;
      text = buffer.toString("latin1") + text;
      const trimmed = text.replace(/[\r\n\t ]+$/, "");
      if (trimmed && (trimmed.lastIndexOf("\n") >= 0 || start === 0)) {
        const lastLine = Buffer.from(trimmed.slice(trimmed.lastIndexOf("\n") + 1), "latin1").toString("utf8");
        const record = parseJson(lastLine);
        if (!record || typeof record !== "object") return { valid: false, reason: "truncated_tail" };
        const { type, id } = record as { type?: unknown; id?: unknown };
        return { lastEntryId: type !== "session" && typeof id === "string" ? id : null, size, mtimeMs: stat.mtimeMs };
      }
      if (start === 0) return { valid: false, reason: "truncated_tail" };
    }
  } catch {
    return { valid: false, reason: "unreadable" };
  } finally { closeSync(fd); }
}

function parseJson(line: string): unknown {
  try { return JSON.parse(line); } catch { return undefined; }
}
