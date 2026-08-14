import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_VERSION, queueAfter } from "../ingest/classifier";
import { reduceJournal } from "../ingest/reducer";
import { printQ4 } from "./overload";

const roots: string[] = [];
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

describe("reducer Q4 projection", () => {
  test("projects read-only agent completion to q4 and a bash session to q2", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, origin TEXT)");
    db.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT, queue TEXT, q5_reason TEXT, origin TEXT, last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER, frozen INTEGER DEFAULT 0)");
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
  test("prints auto-verified read-only sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = new Database(join(root, "ledger.db"));
    db.run("CREATE TABLE current(stable_id TEXT, origin TEXT, last_event_at INTEGER, queue TEXT)");
    db.run("INSERT INTO current VALUES ('local:pi:read-only', 'agent', 1700000000000, 'q4')");
    const lines: string[] = [];
    printQ4(db, (line) => lines.push(line));
    expect(lines.join("\n")).toContain("Q4 auto-verified read-only sessions:");
    expect(lines.join("\n")).toContain("local:pi:read-only\tagent");
    db.close();
  });
});
