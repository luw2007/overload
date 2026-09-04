import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_VERSION, queueAfter } from "../ingest/classifier";
import { reduceJournal } from "../ingest/reducer";
import { ackAll, jumpTo, printQ4 } from "./overload";

const roots: string[] = [];
const SCHEMA_SQL = readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const done = { ingest_seq: 9, at: 99, kind: "session_ended", detail: {} };
const base = { stable_id: "local:pi:read-only", state: "done", origin: "agent", queue: "q3", q5_reason: null };

describe("classifier v2 Q4", () => {
  test("auto-verifies only done agent sessions with zero change evidence", () => {
    expect(CLASSIFIER_VERSION).toBe(2);
    expect(queueAfter({ ...base, has_change_evidence: false }, done).queue).toBe("q4");
    expect(queueAfter({ ...base, has_change_evidence: true }, done).queue).toBe("q2");
  });

  test("never auto-verifies unknown, human, or unfinished sessions", () => {
    expect(queueAfter({ ...base, origin: "unknown", has_change_evidence: false }, done).queue).toBe("q2");
    expect(queueAfter({ ...base, origin: "human", has_change_evidence: false }, done).queue).toBeNull();
    expect(queueAfter({ ...base, state: "idle", has_change_evidence: false }, { ...done, kind: "settled" }).queue).toBe("q3");
  });
});
describe("classifier handoff routing", () => {
  test("settled blocked handoff enters Inbox q5", () => {
    const event = { ...done, kind: "settled", detail: { handoff: { path: "/tmp/HANDOFF.md", status: "blocked", uncertainties: 0 } } };
    expect(queueAfter({ ...base, queue: "q3", q5_reason: null }, event)).toEqual({ queue: "q5", q5_reason: "handoff_blocked" });
  });

  test("settled complete or missing handoff stays q3 and clears prior handoff reason", () => {
    const complete = { ...done, kind: "settled", detail: { handoff: { path: "/tmp/HANDOFF.md", status: "complete", uncertainties: 0 } } };
    const missing = { ...done, kind: "settled", detail: {} };
    expect(queueAfter({ ...base, queue: "q5", q5_reason: "handoff_blocked" }, complete)).toEqual({ queue: "q3", q5_reason: null });
    expect(queueAfter({ ...base, queue: "q5", q5_reason: "handoff_blocked" }, missing)).toEqual({ queue: "q3", q5_reason: null });
  });
});

describe("reducer Q4 projection", () => {
  test("projects read-only agent completion to q4 and a bash session to q2", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, origin TEXT)");
    db.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT, queue TEXT, q5_reason TEXT, origin TEXT, last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER, last_progress_at INTEGER, frozen INTEGER DEFAULT 0)");
    db.run("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, at INTEGER, stable_id TEXT, writer_id TEXT, emitter_id TEXT, kind TEXT, detail TEXT)");
    db.run("CREATE TABLE reducer_cursor(id INTEGER PRIMARY KEY, journal_seq INTEGER)");
    db.run("CREATE TABLE requests(request_uid TEXT PRIMARY KEY, stable_id TEXT, writer_id TEXT, origin_emitter_id TEXT, request_id TEXT, kind TEXT, state TEXT, created_at INTEGER, resolved_at INTEGER, detail TEXT)");
    db.run("CREATE TABLE queue_transitions(subject TEXT, queue TEXT, direction TEXT, at INTEGER, source_seq INTEGER, classifier_version INTEGER, UNIQUE(subject,queue,direction,source_seq,classifier_version))");
    for (const id of ["read-only", "changed"]) {
      db.run("INSERT INTO sessions VALUES (?, 'agent')", [id]);
      db.run("INSERT INTO journal VALUES (?, ?, ?, 'writer', 'emitter', 'session_started', ?)", [id === "read-only" ? 1 : 3, 1, id, JSON.stringify({ origin: "agent" })]);
    }
    db.run("INSERT INTO journal VALUES (2, 2, 'read-only', 'writer', 'emitter', 'session_ended', '{}')");
    db.run("INSERT INTO journal VALUES (4, 2, 'changed', 'writer', 'emitter', 'tool_activity', ?)", [JSON.stringify({ tool: "bash" })]);
    db.run("INSERT INTO journal VALUES (5, 3, 'changed', 'writer', 'emitter', 'session_ended', '{}')");
    expect(reduceJournal(db)).toBe(5);
    expect(db.query("SELECT stable_id, queue FROM current ORDER BY stable_id").all()).toEqual([
      { stable_id: "changed", queue: "q2" }, { stable_id: "read-only", queue: "q4" },
    ]);
    db.close();
  });
});

describe("overload q4", () => {
  test("keeps rows on the data sink and the heading off it", () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = new Database(join(root, "ledger.db"));
    db.run("CREATE TABLE current(stable_id TEXT, origin TEXT, last_event_at INTEGER, queue TEXT)");
    db.run("INSERT INTO current VALUES ('local:pi:read-only', 'agent', 1700000000000, 'q4')");
    const rows: string[] = []; const headings: string[] = [];
    printQ4(db, (line) => rows.push(line), (line) => headings.push(line));
    // A heading on stdout becomes a bogus id the moment the list is piped into `ack`.
    expect(rows).toEqual(["local:pi:read-only\tagent\t2023-11-14T22:13:20.000Z"]);
    expect(headings).toEqual(["Q4 auto-verified read-only sessions:"]);
    db.close();
  });
});

function ledgerWithRequest(root: string): Database {
  const db = new Database(join(root, "ledger.db"));
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO sessions(stable_id, host, origin, runtime, created_at, cwd, branch, first_seen_at) VALUES ('local:pi:one', 'local', 'agent', 'pi', 1, '/tmp', NULL, 1)");
  db.run("INSERT INTO session_hosts(stable_id, app, session_id, tty, observed_at) VALUES ('local:pi:one', 'cmux', 'surface-uuid', 'ttys001', 1)");
  db.run("INSERT INTO requests(request_uid, stable_id, kind, state, created_at, resolved_at, detail) VALUES ('local:pi:one#e#r1', 'local:pi:one', 'decision', 'pending', 5, NULL, NULL)");
  db.run("INSERT INTO requests(request_uid, stable_id, kind, state, created_at, resolved_at, detail) VALUES ('local:pi:one#e#r2', 'local:pi:one', 'decision', 'pending', 6, NULL, NULL)");
  db.run("INSERT INTO sessions(stable_id, host, origin, runtime, created_at, cwd, branch, first_seen_at) VALUES ('local:pi:unbound', 'local', 'agent', 'pi', 1, '/tmp', NULL, 1)");
  return db;
}

describe("overload ack", () => {
  test("acks every uid it is given, matching the web bulk selection", () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = ledgerWithRequest(root);
    ackAll(db, ["local:pi:one#e#r1", "local:pi:one#e#r2"]);
    expect(db.query("SELECT state FROM requests ORDER BY request_uid").all()).toEqual([{ state: "acked" }, { state: "acked" }]);
    expect(process.exitCode ?? 0).toBe(0);
    db.close();
  });

  test("a uid that matched nothing does not exit 0 and read as done", () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = ledgerWithRequest(root);
    try {
      ackAll(db, ["local:pi:one#e#r1", "no-such-request"]);
      expect(process.exitCode).toBe(1);
      // The real uid still lands: a bad neighbour must not veto a valid ack.
      expect(db.query("SELECT state FROM requests WHERE request_uid='local:pi:one#e#r1'").get()).toEqual({ state: "acked" });
    } finally { process.exitCode = 0; db.close(); }
  });
});

describe("overload jump", () => {
  test("resolves a request uid to its session and jumps to the recorded binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = ledgerWithRequest(root);
    const seen: Array<Record<string, unknown>> = [];
    await jumpTo(db, "local:pi:one#e#r1", async (target) => { seen.push(target as Record<string, unknown>); return { opened: true }; });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ source: "host", platform: "cmux", binding: "surface-uuid" });
    expect(process.exitCode ?? 0).toBe(0);
    db.close();
  });

  test("accepts a stable id directly because a hung turn has no request to jump from", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = ledgerWithRequest(root);
    let called = false;
    await jumpTo(db, "local:pi:one", async () => { called = true; return { opened: true }; });
    expect(called).toBe(true);
    db.close();
  });

  test("a target that did not respond fails loudly instead of reporting success", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = ledgerWithRequest(root);
    try {
      await jumpTo(db, "local:pi:one", async () => ({ opened: false, error: "target terminal not found (may have closed)" }));
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = 0; db.close(); }
  });

  test("an unknown id never reaches the jump executor", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = ledgerWithRequest(root);
    let called = false;
    try {
      await jumpTo(db, "local:pi:missing", async () => { called = true; return { opened: true }; });
      expect(called).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = 0; db.close(); }
  });

  test("a session with no recorded binding is nothing-to-try, not a failed attempt", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = ledgerWithRequest(root);
    let called = false;
    try {
      // performJump would also return opened:false here, but "never observed a terminal"
      // and "the terminal did not answer" are different facts and must not share a message.
      await jumpTo(db, "local:pi:unbound", async () => { called = true; return { opened: false }; });
      expect(called).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally { process.exitCode = 0; db.close(); }
  });
});
