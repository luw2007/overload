import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ackRequest, queryHealth, queryHung, queryJumpTarget, querySession } from "./queries";

const NOW = 1_755_000_000_000;
const HOUR = 3_600_000;

function sessionFixture(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, origin TEXT, runtime TEXT, created_at INTEGER, cwd TEXT, branch TEXT, first_seen_at INTEGER)");
  db.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, state TEXT, queue TEXT, q5_reason TEXT, last_event_at INTEGER, last_heartbeat_at INTEGER, last_progress_at INTEGER)");
  db.run("CREATE TABLE session_hosts(stable_id TEXT, app TEXT, session_id TEXT)");
  db.run("CREATE TABLE attachments(stable_id TEXT, binding TEXT, observed_at INTEGER, valid INTEGER)");
  db.run("CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER)");
  db.run("CREATE TABLE requests(stable_id TEXT, request_uid TEXT, kind TEXT, created_at INTEGER, resolved_at INTEGER, detail TEXT, state TEXT)");
  db.run("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, stable_id TEXT, at INTEGER, emitter_id TEXT, writer_id TEXT, kind TEXT, detail TEXT)");
  return db;
}

describe("ackRequest", () => {
  test("uses a distinct acked terminal without rewriting source cancellation", () => {
    const db = sessionFixture();
    db.run("INSERT INTO requests(request_uid, state) VALUES ('local-ack', 'pending'), ('source-cancel', 'cancelled')");

    expect(ackRequest(db, "local-ack").changes).toBe(1);
    expect(db.query("SELECT request_uid, state FROM requests ORDER BY request_uid").all()).toEqual([
      { request_uid: "local-ack", state: "acked" },
      { request_uid: "source-cancel", state: "cancelled" },
    ]);
  });
});

describe("queryJumpTarget", () => {
  test("surfaces only the latest session-start probe failure when no binding exists", () => {
    const db = sessionFixture();
    db.run("ALTER TABLE sessions ADD COLUMN host TEXT");
    db.run("ALTER TABLE attachments ADD COLUMN platform TEXT");
    db.run("ALTER TABLE session_hosts ADD COLUMN tty TEXT");
    db.run("INSERT INTO sessions(stable_id) VALUES ('failed'), ('no-host')");
    db.run(`INSERT INTO journal(ingest_seq, stable_id, kind, detail) VALUES
      (1, 'failed', 'session_started', '{"host_probe_error":"ps_failed"}'),
      (2, 'failed', 'session_started', '{"host_probe_error":"ps_timeout"}'),
      (3, 'no-host', 'session_started', '{}')`);

    expect(queryJumpTarget(db, "failed")?.host_probe_error).toBe("ps_timeout");
    expect(queryJumpTarget(db, "no-host")?.host_probe_error).toBeNull();
  });

  test("leaves an existing binding unaffected", () => {
    const db = sessionFixture();
    db.run("ALTER TABLE sessions ADD COLUMN host TEXT");
    db.run("ALTER TABLE attachments ADD COLUMN platform TEXT");
    db.run("ALTER TABLE session_hosts ADD COLUMN tty TEXT");
    db.run("INSERT INTO sessions(stable_id, origin) VALUES ('bound', 'pi')");
    db.run("INSERT INTO session_hosts(stable_id, app, session_id) VALUES ('bound', 'cmux', 'surface-1')");
    db.run(`INSERT INTO journal(ingest_seq, stable_id, kind, detail) VALUES
      (1, 'bound', 'session_started', '{"host_probe_error":"ps_failed"}')`);

    expect(queryJumpTarget(db, "bound")).toEqual({
      host: null,
      source: "host",
      platform: "cmux",
      binding: "surface-1",
      tty: null,
      host_probe_error: null,
    });
  });
});

describe("querySession", () => {
  test("merges addressed events with recon findings that point at the session", () => {
    const db = sessionFixture();
    const target = "local:omp:session-a";
    db.run("INSERT INTO sessions VALUES (?, 'local', 'omp', ?, '/tmp', 'main', ?)", [target, NOW, NOW]);
    db.run("INSERT INTO session_hosts VALUES (?, 'cmux', 'surface-7')", [target]);
    db.run("INSERT INTO journal VALUES (2, ?, ?, 'omp', 'writer', 'heartbeat', '{}')", [target, NOW + 1]);
    db.run("INSERT INTO journal VALUES (3, 'local:overload:session-a', ?, 'recon', 'recon', 'turn_hung', ?)",
      [NOW + 2, JSON.stringify({ stable_id: target, reason: "no progress" })]);
    // This row matches both predicates and must still appear only once.
    db.run("INSERT INTO journal VALUES (4, ?, ?, 'recon', 'recon', 'dead_connection', ?)",
      [target, NOW + 3, JSON.stringify({ stable_id: target })]);
    db.run("INSERT INTO journal VALUES (5, 'local:overload:other', ?, 'recon', 'recon', 'turn_hung', ?)",
      [NOW + 4, JSON.stringify({ stable_id: "local:omp:other" })]);
    db.run("INSERT INTO journal VALUES (6, ?, ?, 'omp', 'writer', 'model_output', '{}')", [target, NOW + 5]);
    db.run("INSERT INTO journal VALUES (7, ?, ?, 'omp', 'writer', 'heartbeat', '{}')", [target, NOW + 6]);

    const detail = querySession(db, target, 3);

    expect(detail?.session.app).toBe("cmux");
    expect(detail?.events.map((event) => event.ingest_seq)).toEqual([6, 4, 3]);
    expect(detail?.events[2]).toMatchObject({
      kind: "turn_hung",
      detail: { stable_id: target, reason: "no progress" },
    });
  });
  test("exposes latest settled handoff fields", () => {
    const db = sessionFixture();
    const target = "local:pi:handoff";
    db.run("INSERT INTO sessions VALUES (?, 'local', 'pi', ?, '/repo', 'main', ?)", [target, NOW, NOW]);
    db.run("INSERT INTO current VALUES (?, 'idle', 'q5', 'handoff_blocked', ?, ?, ?)", [target, NOW + 2, NOW + 2, NOW + 2]);
    db.run("INSERT INTO journal VALUES (1, ?, ?, 'pi', 'writer', 'settled', ?)", [target, NOW + 1, JSON.stringify({ handoff: { path: "/repo/HANDOFF.md", status: "blocked", uncertainties: 2, next_owner: "ops", task: "finish" } })]);
    expect(querySession(db, target)?.session.handoff).toEqual({ path: "/repo/HANDOFF.md", status: "blocked", uncertainties: 2, next_owner: "ops", task: "finish" });
  });
});

describe("queryHealth", () => {
  test("counts only recent gaps while keeping old open incidents", () => {
    const db = new Database(":memory:");
    db.run("CREATE TABLE incidents(source TEXT, opened_at INTEGER, closed_at INTEGER, detail TEXT)");
    db.run("CREATE TABLE coverage_gaps(stable_id TEXT, emitter_id TEXT, from_at INTEGER)");
    db.run("CREATE TABLE journal(at INTEGER, kind TEXT, detail TEXT)");
    const now = Date.now();
    const recent = now - HOUR;
    const stale = now - 25 * HOUR;

    db.run("INSERT INTO incidents VALUES ('recon', ?, NULL, '{}')", [stale]);
    db.run("INSERT INTO coverage_gaps VALUES ('recent-session', 'emitter', ?)", [recent]);
    db.run("INSERT INTO coverage_gaps VALUES ('stale-session', 'emitter', ?)", [stale]);
    db.run("INSERT INTO journal VALUES (?, 'telemetry_gap', ?)", [recent, JSON.stringify({ native_id: "recent-terminal" })]);
    db.run("INSERT INTO journal VALUES (?, 'telemetry_gap', ?)", [stale, JSON.stringify({ native_id: "stale-terminal" })]);

    expect(queryHealth(db)).toMatchObject({
      open_incidents: [{ source: "recon", opened_at: stale }],
      coverage_gaps: 1,
      telemetry_gaps: 1,
    });
  });
});

describe("queryHung", () => {
  function hungFixture(): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, state TEXT, queue TEXT, q5_reason TEXT, last_event_at INTEGER, last_progress_at INTEGER)");
    db.run("CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT)");
    db.run("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, stable_id TEXT, kind TEXT, detail TEXT)");
    db.run("CREATE TABLE session_hosts(stable_id TEXT, app TEXT, session_id TEXT)");
    db.run("CREATE TABLE attachments(stable_id TEXT, platform TEXT, binding TEXT, observed_at INTEGER, valid INTEGER)");
    return db;
  }

  test("reports hung age and the finding evidence, ignoring other q5 reasons", () => {
    const db = hungFixture();
    db.run("INSERT INTO sessions VALUES ('local:omp:a','local')");
    db.run("INSERT INTO current VALUES ('local:omp:a','working','q5','dead_connection',?,?)", [NOW, NOW - 2 * HOUR]);
    db.run("INSERT INTO current VALUES ('local:pi:b','idle','q5','stalled',?,?)", [NOW, NOW]);
    db.run("INSERT INTO session_hosts VALUES ('local:omp:a','cmux','surface-9')");
    db.run("INSERT INTO journal VALUES (1,'local:omp:a','dead_connection',?)",
      [JSON.stringify({ stable_id: "local:omp:a", local: "192.168.1.5:55373", peer: "192.168.1.20:20128" })]);

    const rows = queryHung(db, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stable_id: "local:omp:a", q5_reason: "dead_connection", binding: "surface-9" });
    expect(rows[0]!.hung_ms).toBe(2 * HOUR);
    expect(rows[0]!.detail).toMatchObject({ local: "192.168.1.5:55373" });
  });
});

test("HungRow declares the complete hung payload including resume capability", () => {
  const source = readFileSync(join(import.meta.dir, "queries.ts"), "utf8");
  const declaration = source.match(/export type HungRow = \{[^}]+\}/s)?.[0];
  expect(declaration).toContain("resume_capability?: ResumeCapability | null");
});
