import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCheckpoint } from "./checkpoint";
import { LAUNCH_LEASE_TTL_MS, type LaunchLeases } from "./launch-lease";
import { inspectResume, resumeSession, type CheckpointProbe } from "./resume";

function ledger(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, origin TEXT, cwd TEXT, branch TEXT, created_at INTEGER, first_seen_at INTEGER);
    CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, at INTEGER, stable_id TEXT, writer_id TEXT, emitter_id TEXT, kind TEXT, detail TEXT);
    CREATE VIEW journal_all AS SELECT * FROM journal;
  `);
  return db;
}

type Incarnation = { writer?: string; domain?: "process" | "lifecycle"; pid?: number | null; ended?: boolean };

function insertSession(db: Database, row: { stable_id: string; host?: string; runtime?: string; session?: string | null; origin?: string | null; cwd?: string | null; incarnations?: Incarnation[] }): void {
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    row.stable_id, row.host ?? "local", row.runtime ?? "pi", row.session === undefined ? "sess" : row.session, row.origin ?? null, row.cwd === undefined ? "/repo" : row.cwd, "main", 1, 1,
  ]);
  for (const [index, incarnation] of (row.incarnations ?? []).entries()) {
    const writer = incarnation.writer ?? `writer-${index}`;
    db.run("INSERT INTO session_incarnations VALUES (?, ?, ?, ?, 'boot', 1, 1)", [row.stable_id, writer, incarnation.domain ?? "process", incarnation.pid === undefined ? 4242 : incarnation.pid]);
    if (incarnation.ended) db.run("INSERT INTO journal(at, stable_id, writer_id, emitter_id, kind) VALUES (2, ?, ?, 'emitter', 'session_ended')", [row.stable_id, writer]);
  }
}

/** A fresh control DB per call: no lease is held unless the test shares one. */
const leases = (now = () => 1000): LaunchLeases => ({ db: new Database(":memory:"), now });

const dead = () => false;
const alive = (pid: number) => pid === 4242;
const terminated: Incarnation[] = [{ pid: 4242, ended: true }];
const validCheckpoint: CheckpointProbe = (input) => ({ valid: true, checkpoint: { ...input, file: `/sessions/${input.session}.jsonl`, header_id: input.session, last_entry_id: "e1", byte_len: 10, mtime_ms: 1 } });

const tempDirs: string[] = [];
afterAll(() => { for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** A real probe over temp session roots holding one intact session file per given (runtime, session, cwd). */
function diskProbe(files: Array<{ runtime: "pi" | "omp"; session: string; cwd: string }> = []): { probe: CheckpointProbe; fileOf: (session: string) => string } {
  const base = mkdtempSync(join(tmpdir(), "overload-resume-"));
  tempDirs.push(base);
  const sessionRoots = { pi: join(base, "pi"), omp: join(base, "omp") };
  const paths: Record<string, string> = {};
  for (const { runtime, session, cwd } of files) {
    mkdirSync(join(sessionRoots[runtime], "project"), { recursive: true });
    paths[session] = join(sessionRoots[runtime], "project", `2026-09-26T09-19-34-234Z_${session}.jsonl`);
    writeFileSync(paths[session], `${JSON.stringify({ type: "session", version: 3, id: session, cwd })}\n${JSON.stringify({ type: "message", id: "e1" })}\n`);
  }
  return { probe: (input) => probeCheckpoint(input, { sessionRoots }), fileOf: (session) => paths[session] };
}

function countingExecutor() {
  const calls: Array<{ command: string; args: string[] }> = [];
  return { calls, executor: async (command: string, args: string[]) => { calls.push({ command, args }); return { ok: true }; } };
}

describe("inspectResume: one conservative liveness and checkpoint gate (Phase B §8.5, §12.4–12.5)", () => {
  const cases: Array<{ name: string; session: Parameters<typeof insertSession>[1]; probe?: (pid: number) => boolean; checkpoint?: CheckpointProbe; expected: unknown }> = [
    { name: "live process", session: { stable_id: "s", incarnations: [{ pid: 4242 }] }, probe: alive, expected: { resumable: false, state: "unsupported", reason: "process_alive" } },
    { name: "live orchestrator runner still reports process_alive first", session: { stable_id: "s", origin: "orch:task:abc:attempt-2", incarnations: [{ pid: 4242 }] }, probe: alive,
      expected: { resumable: false, state: "unsupported", reason: "process_alive" } },
    { name: "orchestrator-owned, even when terminated", session: { stable_id: "s", origin: "orch:task:abc:attempt-1", incarnations: terminated }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unsupported", reason: "orchestrator_owned" } },
    { name: "remote host", session: { stable_id: "s", host: "remote", origin: "agent", incarnations: terminated }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unsupported", reason: "remote_host_unsupported" } },
    { name: "unsupported runtime", session: { stable_id: "s", runtime: "claude", incarnations: terminated }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unsupported", reason: "runtime_unsupported" } },
    { name: "missing runtime session id", session: { stable_id: "s", session: null, incarnations: terminated }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unsupported", reason: "missing_session_id" } },
    { name: "missing cwd", session: { stable_id: "s", cwd: null, incarnations: terminated }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unsupported", reason: "missing_cwd" } },
    { name: "no incarnation recorded", session: { stable_id: "s" }, checkpoint: validCheckpoint, expected: { resumable: false, state: "unknown", reason: "liveness_unknown" } },
    { name: "dead pid without session_ended", session: { stable_id: "s", incarnations: [{ pid: 4242 }] }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unknown", reason: "liveness_unknown" } },
    { name: "pid still visible after session_ended", session: { stable_id: "s", incarnations: terminated }, probe: alive, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unknown", reason: "liveness_unknown" } },
    { name: "lifecycle-only incarnation without session_ended", session: { stable_id: "s", incarnations: [{ domain: "lifecycle", pid: null }] }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unknown", reason: "liveness_unknown" } },
    { name: "one incarnation ended, a newer one has no termination evidence", session: { stable_id: "s", incarnations: [{ pid: 4242, ended: true }, { pid: 5151 }] }, checkpoint: validCheckpoint,
      expected: { resumable: false, state: "unknown", reason: "liveness_unknown" } },
    { name: "terminated local pi whose recorded id is a random fallback with no session file", session: { stable_id: "s", session: "0b7a-random-fallback", incarnations: terminated },
      checkpoint: diskProbe().probe, expected: { resumable: false, state: "unknown", reason: "no_session_file" } },
    { name: "terminated local omp whose session file names another cwd", session: { stable_id: "s", runtime: "omp", session: "omp-1", incarnations: terminated },
      checkpoint: diskProbe([{ runtime: "omp", session: "omp-1", cwd: "/elsewhere" }]).probe, expected: { resumable: false, state: "unknown", reason: "cwd_mismatch" } },
    { name: "terminated local pi whose checkpoint probe reports a truncated tail", session: { stable_id: "s", incarnations: terminated }, checkpoint: () => ({ valid: false, reason: "truncated_tail" }),
      expected: { resumable: false, state: "unknown", reason: "truncated_tail" } },
    { name: "terminated local pi with an ambiguous session id", session: { stable_id: "s", incarnations: terminated }, checkpoint: () => ({ valid: false, reason: "ambiguous_session_file" }),
      expected: { resumable: false, state: "unknown", reason: "ambiguous_session_file" } },
    { name: "terminated local pi with an intact session file", session: { stable_id: "s", origin: "agent", incarnations: [{ pid: 4242, ended: true }, { domain: "lifecycle", pid: null, ended: true }] },
      checkpoint: diskProbe([{ runtime: "pi", session: "sess", cwd: "/repo" }]).probe, expected: { resumable: true, runtime: "pi" } },
  ];
  for (const c of cases) {
    test(c.name, async () => {
      const db = ledger();
      insertSession(db, c.session);
      expect(inspectResume(db, "s", c.probe ?? dead, c.checkpoint)).toEqual(c.expected);
      // The launch path reads the same gate: only a resumable capability ever reaches the executor.
      const { calls, executor } = countingExecutor();
      const result = await resumeSession(db, "s", leases(), executor, c.probe ?? dead, c.checkpoint);
      const resumable = (c.expected as { resumable: boolean }).resumable;
      expect(result).toEqual(resumable ? { resumed: true } : { resumed: false, reason: (c.expected as { reason: string }).reason });
      expect(calls).toHaveLength(resumable ? 1 : 0);
      db.close();
    });
  }

  test("the checkpoint probe sees the recorded runtime, session and cwd", () => {
    const db = ledger();
    insertSession(db, { stable_id: "s", runtime: "omp", session: "omp-session", cwd: "/repo/omp", incarnations: terminated });
    const seen: unknown[] = [];
    inspectResume(db, "s", dead, (checkpoint) => { seen.push(checkpoint); return validCheckpoint(checkpoint); });
    expect(seen).toEqual([{ runtime: "omp", session: "omp-session", cwd: "/repo/omp" }]);
    db.close();
  });
});

describe("resumeSession launch", () => {
  test("pi relaunches the probed session file in a new cmux workspace", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:ok", runtime: "pi", session: "sess-1", cwd: "/repo", incarnations: terminated });
    const { probe, fileOf } = diskProbe([{ runtime: "pi", session: "sess-1", cwd: "/repo" }]);
    const { calls, executor } = countingExecutor();
    expect(await resumeSession(db, "local:pi:ok", leases(), executor, dead, probe)).toEqual({ resumed: true });
    expect(calls).toEqual([{ command: "cmux", args: ["new-workspace", "--cwd", "/repo", "--command", `'pi' '--session' '${fileOf("sess-1")}'`, "--focus", "true"] }]);
    db.close();
  });

  test("omp resumes the proven file path (not an id prefix) with every argv element shell-quoted", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:omp:ok", runtime: "omp", session: "sess'quote", cwd: "/repo", incarnations: terminated });
    const { calls, executor } = countingExecutor();
    const diskOmp = diskProbe([{ runtime: "omp", session: "sess'quote", cwd: "/repo" }]);
    expect(await resumeSession(db, "local:omp:ok", leases(), executor, dead, diskOmp.probe)).toEqual({ resumed: true });
    expect(calls).toEqual([{ command: "cmux", args: ["new-workspace", "--cwd", "/repo", "--command", `'omp' '--resume=${diskOmp.fileOf("sess'quote").replaceAll("'", "'\\''")}'`, "--focus", "true"] }]);
    db.close();
  });

  test("a random fallback session id never reaches the executor", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:ghost", runtime: "pi", session: "0b7a-random-fallback", cwd: "/repo", incarnations: terminated });
    const { calls, executor } = countingExecutor();
    expect(await resumeSession(db, "local:pi:ghost", leases(), executor, dead, diskProbe().probe)).toEqual({ resumed: false, reason: "no_session_file" });
    expect(calls).toEqual([]);
    db.close();
  });

  test("reports a failed launch instead of success", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:ok", incarnations: terminated });
    expect(await resumeSession(db, "local:pi:ok", leases(), async () => ({ ok: false, error: "workspace refused" }), dead, validCheckpoint)).toEqual({ resumed: false, reason: "workspace refused" });
    db.close();
  });

  test("returns null for an unknown stable id", async () => {
    const db = ledger();
    expect(await resumeSession(db, "local:pi:nope", leases(), async () => ({ ok: true }), dead, validCheckpoint)).toBeNull();
    db.close();
  });
});

describe("launch lease: one launch per checkpoint (review MAJOR-1)", () => {
  test("two concurrent resumes launch exactly once; the gate reports launch_in_flight until session_started or TTL", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:ok", incarnations: terminated });
    let now = 1000;
    const shared = { db: new Database(":memory:"), now: () => now };
    const { calls, executor } = countingExecutor();
    const results = await Promise.all([
      resumeSession(db, "local:pi:ok", shared, executor, dead, validCheckpoint),
      resumeSession(db, "local:pi:ok", shared, executor, dead, validCheckpoint),
    ]);
    expect(results).toEqual([{ resumed: true }, { resumed: false, reason: "launch_in_flight" }]);
    expect(calls).toHaveLength(1);
    expect(inspectResume(db, "local:pi:ok", dead, validCheckpoint, shared)).toEqual({ resumable: false, state: "unknown", reason: "launch_in_flight" });
    // Without the control DB (list endpoints before it exists) the lease is invisible, never an error.
    expect(inspectResume(db, "local:pi:ok", dead, validCheckpoint, leases())).toEqual({ resumable: true, runtime: "pi" });

    // The resumed runtime's session_started releases the lease (its later session_ended makes it terminated again).
    now = 5000;
    db.run("INSERT INTO journal(at, stable_id, writer_id, emitter_id, kind) VALUES (4000, 'local:pi:ok', 'writer-0', 'emitter', 'session_started')");
    expect(inspectResume(db, "local:pi:ok", dead, validCheckpoint, shared)).toEqual({ resumable: true, runtime: "pi" });
    expect(await resumeSession(db, "local:pi:ok", shared, executor, dead, validCheckpoint)).toEqual({ resumed: true });
    expect(calls).toHaveLength(2);

    // No session_started this time: the lease holds until its TTL, then a retry may launch again.
    now += LAUNCH_LEASE_TTL_MS - 1;
    expect(await resumeSession(db, "local:pi:ok", shared, executor, dead, validCheckpoint)).toEqual({ resumed: false, reason: "launch_in_flight" });
    now += 1;
    expect(await resumeSession(db, "local:pi:ok", shared, executor, dead, validCheckpoint)).toEqual({ resumed: true });
    expect(calls).toHaveLength(3);
    db.close();
  });

  test("a failed launch keeps the lease: the runtime may have started anyway", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:ok", incarnations: terminated });
    const shared = leases();
    expect(await resumeSession(db, "local:pi:ok", shared, async () => ({ ok: false, error: "workspace refused" }), dead, validCheckpoint)).toEqual({ resumed: false, reason: "workspace refused" });
    const { calls, executor } = countingExecutor();
    expect(await resumeSession(db, "local:pi:ok", shared, executor, dead, validCheckpoint)).toEqual({ resumed: false, reason: "launch_in_flight" });
    expect(calls).toEqual([]);
    db.close();
  });
});
