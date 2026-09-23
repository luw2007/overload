import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { inspectResume, resumeSession } from "./resume";

function ledger(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, origin TEXT, cwd TEXT, branch TEXT, created_at INTEGER, first_seen_at INTEGER);
    CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, at INTEGER, stable_id TEXT, writer_id TEXT, emitter_id TEXT, kind TEXT, detail TEXT);
  `);
  return db;
}

function insertSession(db: Database, row: { stable_id: string; host?: string; runtime?: string; session?: string; origin?: string | null; cwd?: string; pid?: number }): void {
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
    row.stable_id, row.host ?? "local", row.runtime ?? "pi", row.session ?? "sess", row.origin ?? null, row.cwd ?? "/repo", "main", 1, 1,
  ]);
  if (row.pid != null) {
    db.run("INSERT INTO session_incarnations VALUES (?, ?, 'process', ?, 'boot', 1, 1)", [row.stable_id, "writer", row.pid]);
  }
}

const dead = () => false;
const alive = (pid: number) => pid === 4242;

describe("inspectResume orchestrator_owned guard (plan §3.10)", () => {
  test("orch: origin is never resumable, even with a dead process", () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:orch1", origin: "orch:task:abc:attempt-1" });
    expect(inspectResume(db, "local:pi:orch1", dead)).toEqual({ resumable: false, reason: "orchestrator_owned" });
    db.close();
  });

  test("orch: origin wins over process_alive check ordering but process_alive still short-circuits first", () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:orch2", origin: "orch:task:abc:attempt-2", pid: 4242 });
    // process_alive is checked before origin — a live orchestrator runner still reports process_alive, not orchestrator_owned.
    expect(inspectResume(db, "local:pi:orch2", alive)).toEqual({ resumable: false, reason: "process_alive" });
    db.close();
  });

  test("null origin is unaffected: falls through to normal resumable result", () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:plain", origin: null });
    expect(inspectResume(db, "local:pi:plain", dead)).toEqual({ resumable: true, runtime: "pi" });
    db.close();
  });

  test("non-orch origin is unaffected: falls through to normal resumable result", () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:agent", origin: "agent" });
    expect(inspectResume(db, "local:pi:agent", dead)).toEqual({ resumable: true, runtime: "pi" });
    db.close();
  });

  test("no regression on remote_host_unsupported for non-orch origin", () => {
    const db = ledger();
    insertSession(db, { stable_id: "remote:pi:agent", host: "remote", origin: "agent" });
    expect(inspectResume(db, "remote:pi:agent", dead)).toEqual({ resumable: false, reason: "remote_host_unsupported" });
    db.close();
  });
});

describe("resumeSession launch", () => {
  test("launches cmux new-workspace with the quoted session and returns resumed", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:ok", runtime: "pi", session: "sess'quote", cwd: "/repo" });
    const calls: Array<{ command: string; args: string[] }> = [];
    const fakeExec = async (command: string, args: string[]) => { calls.push({ command, args }); return { ok: true }; };

    const result = await resumeSession(db, "local:pi:ok", fakeExec, dead);
    expect(result).toEqual({ resumed: true });
    expect(calls[0].command).toBe("cmux");
    expect(calls[0].args).toEqual(["new-workspace", "--cwd", "/repo", "--command", "pi --resume='sess'\\''quote'", "--focus", "true"]);
    db.close();
  });

  test("refuses to launch when the process is still alive", async () => {
    const db = ledger();
    insertSession(db, { stable_id: "local:pi:alive", runtime: "pi", session: "sess", pid: 4242 });
    let called = 0;
    const fakeExec = async () => { called++; return { ok: true }; };

    const result = await resumeSession(db, "local:pi:alive", fakeExec, alive);
    expect(result).toEqual({ resumed: false, reason: "process_alive" });
    expect(called).toBe(0);
    db.close();
  });

  test("returns null for an unknown stable id", async () => {
    const db = ledger();
    expect(await resumeSession(db, "local:pi:nope", async () => ({ ok: true }), dead)).toBeNull();
    db.close();
  });
});
