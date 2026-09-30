import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeLedger, scanOnce } from "./ingest";
import { archiveJournal, pruneJournalCapacity } from "./archive";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const DAY = 86_400_000;

test("archives only reduced events at seven and thirty days without losing history or replay protection", async () => {
  const now = 1_800_000_000_000;
  const root = await mkdtemp(join(tmpdir(), "overload-archive-"));
  const db = new Database(":memory:");
  try {
    initializeLedger(db);
    const add = db.query(`INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind,detail)
      VALUES ('local','pi-archive',?,?,'local:pi:one','pi-archive','heartbeat','{}')`);
    for (const [seq, at] of [[1, now - 31 * DAY], [2, now - 30 * DAY],
      [3, now - 7 * DAY], [4, now - 7 * DAY + 1], [5, now - 31 * DAY]]) add.run(seq, at);
    db.query("UPDATE reducer_cursor SET journal_seq=4 WHERE id=1").run();
    expect(archiveJournal(db, now)).toBe(3);
    expect(db.query("SELECT seq FROM journal ORDER BY seq").all()).toEqual([{ seq: 4 }, { seq: 5 }]);
    expect(db.query("SELECT seq FROM journal_7d").all()).toEqual([{ seq: 3 }]);
    expect(db.query("SELECT seq FROM journal_30d ORDER BY seq").all()).toEqual([{ seq: 1 }, { seq: 2 }]);
    expect(db.query("SELECT seq FROM journal_all ORDER BY seq").all()).toEqual([1, 2, 3, 4, 5].map((seq) => ({ seq })));

    const spool = join(root, "spool");
    const emitter = join(spool, "local", "pi-archive");
    await mkdir(emitter, { recursive: true });
    const replay = { v: 1, host: "local", runtime: "pi", session: "one", emitter_id: "pi-archive",
      writer_id: "pi-archive", seq: 1, at: now - 31 * DAY, kind: "heartbeat" };
    await writeFile(join(emitter, "active-pi-archive-1.ndjson"), JSON.stringify(replay) + "\n");
    expect((await scanOnce(db, spool)).inserted).toBe(0);
    expect(db.query("SELECT count(*) AS n FROM journal_all").get()).toEqual({ n: 5 });

    db.query("UPDATE reducer_cursor SET journal_seq=5 WHERE id=1").run();
    expect(archiveJournal(db, now)).toBe(1);
    expect(db.query("SELECT seq FROM journal").all()).toEqual([{ seq: 4 }]);
    expect(archiveJournal(db, now)).toBe(0);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function capacityLedger(rows: Array<[kind: string, table?: string]>, cursor: number) {
  const db = new Database(":memory:");
  initializeLedger(db);
  rows.forEach(([kind, table = "journal"], index) => {
    db.query(`INSERT INTO ${table}(ingest_seq,host,emitter_id,seq,at,stable_id,writer_id,kind,detail)
      VALUES (?,'local','pi-cap',?,?,'local:pi:one','pi-cap',?,'{}')`).run(index + 1, index + 1, index + 1, kind);
  });
  db.query("UPDATE reducer_cursor SET journal_seq=? WHERE id=1").run(cursor);
  return db;
}

test("capacity pruning removes reduced heartbeat noise before older state events", () => {
  const db = capacityLedger([
    ["heartbeat"], ["control_event"], ["tool_activity"], ["heartbeat"], ["heartbeat"],
  ], 4);
  try {
    expect(pruneJournalCapacity(db, 3)).toBe(2);
    expect(db.query("SELECT ingest_seq, kind FROM journal ORDER BY ingest_seq").all()).toEqual([
      { ingest_seq: 2, kind: "control_event" },
      { ingest_seq: 3, kind: "tool_activity" },
      { ingest_seq: 5, kind: "heartbeat" },
    ]);
    expect(pruneJournalCapacity(db, 2)).toBe(1);
    expect(db.query("SELECT ingest_seq FROM journal ORDER BY ingest_seq").all())
      .toEqual([{ ingest_seq: 3 }, { ingest_seq: 5 }]);
  } finally {
    db.close();
  }
});

/** control_event rows are read by consumers holding their own cursor in another
 * database (`effect_reconcile_cursor`) and are the target of `journal:<seq>`
 * evidence references, so they must not be preferred for deletion. */
test("capacity pruning spares reduced control events while any heartbeat is still droppable", () => {
  const db = capacityLedger([["control_event"], ["control_event"], ["heartbeat"]], 3);
  try {
    expect(pruneJournalCapacity(db, 2)).toBe(1);
    expect(db.query("SELECT kind FROM journal ORDER BY ingest_seq").all())
      .toEqual([{ kind: "control_event" }, { kind: "control_event" }]);
  } finally {
    db.close();
  }
});

/** The cheap proxy for `repro-prune-scale.ts`: the unbounded form deleted 2.3M
 * rows in one 34s transaction on a Mac-shaped ledger, locking out every other
 * writer well past the schema's 5s busy_timeout. Asserting the bound directly
 * keeps that regression caught without a multi-GB fixture. */
test("capacity pruning deletes at most one batch per call and converges across calls", () => {
  const db = capacityLedger(Array.from({ length: 40 }, () => ["heartbeat"] as [string]), 40);
  try {
    expect(pruneJournalCapacity(db, 10, 8)).toBe(8);
    expect(pruneJournalCapacity(db, 10, 8)).toBe(8);
    let guard = 0;
    while (pruneJournalCapacity(db, 10, 8) > 0) expect(++guard).toBeLessThan(10);
    expect(db.query("SELECT COUNT(*) n FROM journal_all").get()).toEqual({ n: 10 });
    expect(pruneJournalCapacity(db, 10, 8)).toBe(0);
  } finally {
    db.close();
  }
});

test("capacity pruning never deletes unprojected rows, spans all three tiers, and tolerates a zero or absent cursor", () => {
  const db = capacityLedger([
    ["heartbeat", "journal_30d"], ["control_event", "journal_30d"],
    ["heartbeat", "journal_7d"], ["control_event", "journal_7d"],
    ["heartbeat"], ["control_event"], ["tool_activity"],
  ], 5);
  try {
    // Excess is 4 but only ingest_seq <= 5 is projected, so seqs 6 and 7 survive.
    expect(pruneJournalCapacity(db, 3)).toBe(4);
    expect(db.query("SELECT COUNT(*) n FROM journal_all WHERE ingest_seq>5").get()).toEqual({ n: 2 });
    expect(db.query("SELECT COUNT(*) n FROM journal_30d").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM journal_7d").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }

  for (const cursor of [0, null]) {
    const empty = capacityLedger([["heartbeat"], ["control_event"]], 0);
    if (cursor === null) empty.query("DELETE FROM reducer_cursor").run();
    expect(pruneJournalCapacity(empty, 0)).toBe(0);
    expect(empty.query("SELECT COUNT(*) n FROM journal_all").get()).toEqual({ n: 2 });
    empty.close();
  }
});
