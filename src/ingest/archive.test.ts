import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { initializeLedger, scanOnce } from "./ingest";
import { archiveJournal } from "./archive";
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
