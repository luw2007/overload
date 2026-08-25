import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { queryHung } from "./queries";

const NOW = 1_755_000_000_000;
const HOUR = 3_600_000;


describe("queryHung", () => {
  function hungFixture(): Database {
    const db = new Database(":memory:");
    db.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, state TEXT, queue TEXT, q5_reason TEXT, last_event_at INTEGER, last_progress_at INTEGER)");
    db.run("CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT)");
    db.run("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, kind TEXT, detail TEXT)");
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
    db.run("INSERT INTO journal VALUES (1,'dead_connection',?)",
      [JSON.stringify({ stable_id: "local:omp:a", local: "192.168.1.5:55373", peer: "192.168.1.20:20128" })]);

    const rows = queryHung(db, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stable_id: "local:omp:a", q5_reason: "dead_connection", binding: "surface-9" });
    expect(rows[0]!.hung_ms).toBe(2 * HOUR);
    expect(rows[0]!.detail).toMatchObject({ local: "192.168.1.5:55373" });
  });
});
