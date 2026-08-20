import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { formatAttention, queryAttention } from "./queries";

const NOW = 1_755_000_000_000;
const HOUR = 3_600_000;

function fixture(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE notifications(request_uid TEXT, kind TEXT, state TEXT, sent_at INTEGER)");
  db.run("CREATE TABLE requests(request_uid TEXT, stable_id TEXT, state TEXT, created_at INTEGER)");
  db.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, queue TEXT)");
  return db;
}

describe("queryAttention", () => {
  test("empty ledger reports zero load and no average wait", () => {
    const view = queryAttention(fixture(), NOW);
    expect(view).toEqual({
      interruptions_24h: 0,
      refocus_cost_min: 0,
      pending_decisions: 0,
      pending_decision_avg_wait_ms: null,
      open_contexts: 0,
    });
    expect(formatAttention(view)).toBe("interruptions(24h)=0 (~0min refocus) · pending decisions=0 avg_wait=- · open contexts=0");
  });

  test("counts initial-notification episodes inside the trailing 24h and prices them", () => {
    const db = fixture();
    db.run("INSERT INTO notifications VALUES ('r1','initial','sent',?)", [NOW - HOUR]);
    db.run("INSERT INTO notifications VALUES ('r1b','initial','sent',?)", [NOW - HOUR + 60_000]); // burst: same episode as r1
    db.run("INSERT INTO notifications VALUES ('r1','reminder','sent',?)", [NOW - HOUR + 120_000]); // nag, not a new interruption
    db.run("INSERT INTO notifications VALUES ('r2','initial','sent',?)", [NOW - 23 * HOUR]);
    db.run("INSERT INTO notifications VALUES ('r3','initial','sent',?)", [NOW - 25 * HOUR]); // outside window
    db.run("INSERT INTO notifications VALUES ('r4','initial','pending',NULL)"); // undelivered
    db.run("INSERT INTO notifications VALUES ('r5','initial','failed_permanent',NULL)");
    const view = queryAttention(db, NOW, 20);
    expect(view.interruptions_24h).toBe(2);
    expect(view.refocus_cost_min).toBe(40);
    expect(queryAttention(db, NOW, 5).refocus_cost_min).toBe(10);
  });

  test("averages wait over pending decisions only", () => {
    const db = fixture();
    db.run("INSERT INTO requests VALUES ('r1','s1','pending',?)", [NOW - 2 * HOUR]);
    db.run("INSERT INTO requests VALUES ('r2','s2','pending',?)", [NOW - 4 * HOUR]);
    db.run("INSERT INTO requests VALUES ('r3','s3','resolved',?)", [NOW - 90 * HOUR]);
    const view = queryAttention(db, NOW);
    expect(view.pending_decisions).toBe(2);
    expect(view.pending_decision_avg_wait_ms).toBe(3 * HOUR);
  });

  test("open contexts dedupe sessions across pending asks and q2/q5, ignoring q3/q4", () => {
    const db = fixture();
    db.run("INSERT INTO requests VALUES ('r1','s1','pending',?)", [NOW - HOUR]);
    db.run("INSERT INTO current VALUES ('s1','q2')"); // same session as r1 → counted once
    db.run("INSERT INTO current VALUES ('s2','q5')");
    db.run("INSERT INTO current VALUES ('s3','q3')"); // running: not a human context
    db.run("INSERT INTO current VALUES ('s4','q4')"); // auto-verified: no human attention
    expect(queryAttention(db, NOW).open_contexts).toBe(2);
  });
});
