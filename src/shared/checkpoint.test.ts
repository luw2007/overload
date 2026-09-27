import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listingSnapshotProbe, probeCheckpoint, resumeArgv, type Checkpoint } from "./checkpoint";

const roots: string[] = [];
function tempRoots(): Record<"pi" | "omp", string> {
  const base = mkdtempSync(join(tmpdir(), "overload-checkpoint-"));
  roots.push(base);
  return { pi: join(base, "pi"), omp: join(base, "omp") };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function writeSession(root: string, dir: string, name: string, lines: unknown[], tail = "\n"): string {
  mkdirSync(join(root, dir), { recursive: true });
  const file = join(root, dir, name);
  writeFileSync(file, lines.map((line) => typeof line === "string" ? line : JSON.stringify(line)).join("\n") + tail);
  return file;
}

const header = (id: string, cwd: string) => ({ type: "session", version: 3, id, timestamp: "2026-09-26T09:19:34.234Z", cwd });

describe("probeCheckpoint", () => {
  test("a single pi session file with matching header and intact tail is a checkpoint", () => {
    const sessionRoots = tempRoots();
    const file = writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_sess-1.jsonl", [header("sess-1", "/repo"), { type: "message", id: "e1", parentId: null }, { type: "message", id: "e2", parentId: "e1" }]);
    const result = probeCheckpoint({ runtime: "pi", session: "sess-1", cwd: "/repo" }, { sessionRoots });
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.checkpoint).toMatchObject({ runtime: "pi", session: "sess-1", cwd: "/repo", file, header_id: "sess-1", last_entry_id: "e2" });
    expect(result.checkpoint.byte_len).toBe(Bun.file(file).size);
    expect(result.checkpoint.mtime_ms).toBeGreaterThan(0);
  });

  test("omp header may follow a leading title line; header-only file has no last entry", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.omp, "-repo", "2026-09-26T09-19-34-234Z_omp-1.jsonl", [{ type: "title", v: 1, title: "t", pad: "   " }, header("omp-1", "/repo")]);
    const result = probeCheckpoint({ runtime: "omp", session: "omp-1", cwd: "/repo" }, { sessionRoots });
    expect(result).toMatchObject({ valid: true, checkpoint: { runtime: "omp", header_id: "omp-1", last_entry_id: null } });
  });

  test("a random fallback id with no session file behind it is no_session_file", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_real.jsonl", [header("real", "/repo")]);
    expect(probeCheckpoint({ runtime: "pi", session: "0b7a1c9e-random-fallback", cwd: "/repo" }, { sessionRoots })).toEqual({ valid: false, reason: "no_session_file" });
  });

  test("a missing session root is no_session_file", () => {
    expect(probeCheckpoint({ runtime: "omp", session: "x", cwd: "/repo" }, { sessionRoots: tempRoots() })).toEqual({ valid: false, reason: "no_session_file" });
  });

  test("a file whose name contains the id but whose header names another id is not proof", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_sess-1.jsonl", [header("other", "/repo")]);
    expect(probeCheckpoint({ runtime: "pi", session: "sess-1", cwd: "/repo" }, { sessionRoots })).toEqual({ valid: false, reason: "no_session_file" });
  });

  test("two files carrying the same header id are ambiguous", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_dup.jsonl", [header("dup", "/repo")]);
    writeSession(sessionRoots.pi, "--other--", "2026-09-27T09-19-34-234Z_dup.jsonl", [header("dup", "/repo")]);
    expect(probeCheckpoint({ runtime: "pi", session: "dup", cwd: "/repo" }, { sessionRoots })).toEqual({ valid: false, reason: "ambiguous_session_file" });
  });

  test("a header cwd different from the recorded cwd is cwd_mismatch", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.omp, "-elsewhere", "2026-09-26T09-19-34-234Z_s.jsonl", [header("s", "/elsewhere"), { type: "message", id: "e1" }]);
    expect(probeCheckpoint({ runtime: "omp", session: "s", cwd: "/repo" }, { sessionRoots })).toEqual({ valid: false, reason: "cwd_mismatch" });
  });

  test("a last line cut mid-write is truncated_tail", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_s.jsonl", [header("s", "/repo"), { type: "message", id: "e1" }, '{"type":"message","id":"e2","content":"hal'], "");
    expect(probeCheckpoint({ runtime: "pi", session: "s", cwd: "/repo" }, { sessionRoots })).toEqual({ valid: false, reason: "truncated_tail" });
  });

  test("a complete last line longer than one read chunk is still read whole", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_s.jsonl", [header("s", "/repo"), { type: "message", id: "big", content: "é".repeat(200_000) }], "\n\n");
    expect(probeCheckpoint({ runtime: "pi", session: "s", cwd: "/repo" }, { sessionRoots })).toMatchObject({ valid: true, checkpoint: { last_entry_id: "big" } });
  });

  test("runtimes other than pi and omp are unsupported", () => {
    expect(probeCheckpoint({ runtime: "claude", session: "s", cwd: "/repo" }, { sessionRoots: tempRoots() })).toEqual({ valid: false, reason: "unsupported_runtime" });
  });
});

describe("listingSnapshotProbe", () => {
  test("gives every row of a list the same verdict as probeCheckpoint, and the next request sees new session files", () => {
    const sessionRoots = tempRoots();
    writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_sess-1.jsonl", [header("sess-1", "/repo"), { type: "message", id: "e1" }]);
    writeSession(sessionRoots.pi, "--repo--", "2026-09-26T09-19-34-234Z_dup.jsonl", [header("dup", "/repo")]);
    writeSession(sessionRoots.pi, "--other--", "2026-09-27T09-19-34-234Z_dup.jsonl", [header("dup", "/repo")]);
    writeSession(sessionRoots.omp, "-elsewhere", "2026-09-26T09-19-34-234Z_s.jsonl", [header("s", "/elsewhere")]);
    const rows = [
      { runtime: "pi", session: "sess-1", cwd: "/repo" },
      { runtime: "pi", session: "dup", cwd: "/repo" },
      { runtime: "pi", session: "random-fallback", cwd: "/repo" },
      { runtime: "omp", session: "s", cwd: "/repo" },
      { runtime: "omp", session: "", cwd: "/repo" },
      { runtime: "claude", session: "c", cwd: "/repo" },
    ];
    const probe = listingSnapshotProbe({ sessionRoots });
    expect(rows.map((row) => probe(row))).toEqual(rows.map((row) => probeCheckpoint(row, { sessionRoots })));

    writeSession(sessionRoots.omp, "-repo", "2026-09-28T09-19-34-234Z_late.jsonl", [header("late", "/repo"), { type: "message", id: "e1" }]);
    expect(listingSnapshotProbe({ sessionRoots })({ runtime: "omp", session: "late", cwd: "/repo" })).toMatchObject({ valid: true, checkpoint: { header_id: "late", last_entry_id: "e1" } });
  });
});

describe("resumeArgv", () => {
  const base: Checkpoint = { runtime: "pi", session: "sess-1", cwd: "/repo", file: "/root/--repo--/x_sess-1.jsonl", header_id: "sess-1", last_entry_id: "e1", byte_len: 10, mtime_ms: 1 };
  test("pi reopens the exact session file, never --session-id", () => {
    expect(resumeArgv(base)).toEqual(["pi", "--session", "/root/--repo--/x_sess-1.jsonl"]);
  });
  test("omp resumes the proven file path, never re-resolving an id prefix", () => {
    expect(resumeArgv({ ...base, runtime: "omp" })).toEqual(["omp", "--resume=/root/--repo--/x_sess-1.jsonl"]);
  });
});
