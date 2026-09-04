import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeLedger } from "./ingest";
import { reduceJournal } from "./reducer";

function fixture(): Database {
  const db = new Database(":memory:");
  initializeLedger(db);
  return db;
}

function insertEvent(db: Database, seq: number, kind: string, stableId: string, detail: Record<string, unknown>, host = "devbox", emitter = "recon-1"): void {
  db.query(`INSERT INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(host, emitter, seq, 1_700_000_000_000 + seq, stableId, emitter, kind, JSON.stringify(detail));
}

describe("decision resolution outcomes", () => {
  test.each([
    ["absent", {}],
    ["unrecognized", { state: "blocked_by_policy" }],
  ])("%s outcome stays pending and records an anomaly", (_label, outcome) => {
    const db = fixture();
    insertEvent(db, 1, "decision_requested", "devbox:pi:x", { request_id: "req-1" }, "devbox", "pi-1");
    insertEvent(db, 2, "decision_resolved", "devbox:pi:x", { request_id: "req-1", ...outcome }, "devbox", "pi-1");

    reduceJournal(db);

    expect(db.query("SELECT state, resolved_at FROM requests WHERE request_id='req-1'").get()).toEqual({ state: "pending", resolved_at: null });
    expect(db.query("SELECT state FROM current WHERE stable_id='devbox:pi:x'").get()).toEqual({ state: "awaiting_human" });
    expect(db.query("SELECT stable_id, emitter_id, from_seq, reason FROM coverage_gaps").all()).toEqual([
      { stable_id: "devbox:pi:x", emitter_id: "pi-1", from_seq: 2, reason: "unrecognized_decision_outcome" },
    ]);
    db.close();
  });

  test.each([
    ["resolved", { state: "resolved" }, "resolved"],
    ["cancelled", { state: "cancelled" }, "cancelled"],
    ["timed_out", { state: "timed_out" }, "timed_out"],
    ["error", { error: true }, "cancelled"],
  ])("preserves %s mapping", (_label, outcome, expected) => {
    const db = fixture();
    insertEvent(db, 1, "decision_requested", "devbox:pi:x", { request_id: "req-1" }, "devbox", "pi-1");
    insertEvent(db, 2, "decision_resolved", "devbox:pi:x", { request_id: "req-1", ...outcome }, "devbox", "pi-1");

    reduceJournal(db);

    expect(db.query("SELECT state FROM requests WHERE request_id='req-1'").get()).toEqual({ state: expected });
    expect(db.query("SELECT COUNT(*) AS count FROM coverage_gaps").get()).toEqual({ count: 0 });
    db.close();
  });

  test("re-reduction does not duplicate an unrecognized-outcome anomaly", () => {
    const db = fixture();
    insertEvent(db, 1, "decision_requested", "devbox:pi:x", { request_id: "req-1" }, "devbox", "pi-1");
    insertEvent(db, 2, "decision_resolved", "devbox:pi:x", { request_id: "req-1", outcome: "newer_state" }, "devbox", "pi-1");

    reduceJournal(db);
    db.query("UPDATE reducer_cursor SET journal_seq=0 WHERE id=1").run();
    reduceJournal(db);

    expect(db.query("SELECT state, resolved_at FROM requests WHERE request_id='req-1'").get()).toEqual({ state: "pending", resolved_at: null });
    expect(db.query("SELECT reason, COUNT(*) AS count FROM coverage_gaps GROUP BY reason").all()).toEqual([
      { reason: "unrecognized_decision_outcome", count: 1 },
    ]);
    db.close();
  });
});

describe("detail stable_id host authority", () => {
  test("session_vanished cannot target another host", () => {
    const db = fixture();
    db.query(`INSERT INTO current(stable_id, writer_id, state, origin) VALUES
      ('local:pi:x', 'pi-1', 'working', 'user'), ('devbox:recon:scanner', 'recon-1', 'working', 'unknown')`).run();
    insertEvent(db, 1, "session_vanished", "devbox:recon:scanner", { stable_id: "local:pi:x", platform: "pi" });

    reduceJournal(db);

    expect(db.query("SELECT state FROM current WHERE stable_id='local:pi:x'").get()).toEqual({ state: "working" });
    expect(db.query("SELECT state FROM current WHERE stable_id='devbox:recon:scanner'").get()).toEqual({ state: "vanished" });
    expect(db.query("SELECT COUNT(*) AS count FROM coverage_gaps").get()).toEqual({ count: 1 });
    db.close();
  });

  test("session_vanished still targets another session on same host", () => {
    const db = fixture();
    db.query(`INSERT INTO current(stable_id, writer_id, state, origin) VALUES ('devbox:pi:x', 'pi-1', 'working', 'user')`).run();
    insertEvent(db, 1, "session_vanished", "devbox:recon:scanner", { stable_id: "devbox:pi:x", platform: "pi" });

    reduceJournal(db);

    expect(db.query("SELECT state FROM current WHERE stable_id='devbox:pi:x'").get()).toEqual({ state: "vanished" });
    expect(db.query("SELECT COUNT(*) AS count FROM coverage_gaps").get()).toEqual({ count: 0 });
    db.close();
  });

  test("attachment_observed cannot target another host", () => {
    const db = fixture();
    insertEvent(db, 1, "attachment_observed", "devbox:recon:scanner", {
      stable_id: "local:pi:x", platform: "herdr", binding: "thread-1",
    });

    reduceJournal(db);

    expect(db.query("SELECT * FROM attachments WHERE stable_id='local:pi:x'").get()).toBeNull();
    expect(db.query("SELECT stable_id, platform, binding FROM attachments").get()).toEqual({
      stable_id: "devbox:recon:scanner", platform: "herdr", binding: "thread-1",
    });
    expect(db.query("SELECT COUNT(*) AS count FROM coverage_gaps").get()).toEqual({ count: 1 });
    db.close();
  });

  test("local recon (overload admin emitter) still marks a devbox session vanished", () => {
    const db = fixture();
    db.query(`INSERT INTO current(stable_id, writer_id, state, origin) VALUES ('devbox:pi:x', 'pi-1', 'working', 'user')`).run();
    insertEvent(db, 1, "session_vanished", "local:overload:admin", { stable_id: "devbox:pi:x", platform: "pi" }, "local", "overload-recon-1");

    reduceJournal(db);

    expect(db.query("SELECT state FROM current WHERE stable_id='devbox:pi:x'").get()).toEqual({ state: "vanished" });
    expect(db.query("SELECT COUNT(*) AS count FROM coverage_gaps").get()).toEqual({ count: 0 });
    expect(db.query("SELECT COUNT(*) AS count FROM current WHERE stable_id='local:overload:admin'").get()).toEqual({ count: 0 });
    db.close();
  });

  test("a devbox emitter claiming to be admin cannot target local", () => {
    const db = fixture();
    db.query(`INSERT INTO current(stable_id, writer_id, state, origin) VALUES ('local:pi:x', 'pi-1', 'working', 'user')`).run();
    insertEvent(db, 1, "session_vanished", "devbox:overload:admin", { stable_id: "local:pi:x", platform: "pi" });

    reduceJournal(db);

    expect(db.query("SELECT state FROM current WHERE stable_id='local:pi:x'").get()).toEqual({ state: "working" });
    expect(db.query("SELECT COUNT(*) AS count FROM coverage_gaps").get()).toEqual({ count: 1 });
    db.close();
  });
});
