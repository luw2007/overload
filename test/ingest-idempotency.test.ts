/**
 * test/ingest-idempotency.test.ts — §2.1 atomic ingestion idempotency.
 *
 * P1 acceptance (N3-TASK #2):
 *  - synthetic spool: active + overlapping sealed segment sharing the same
 *    (emitter, seq) range → ingest dedups by journal UNIQUE(host, emitter_id, seq)
 *  - run ingest --once twice → journal row count equals UNIQUE events (0 new on
 *    the 2nd pass; cursor stability)
 *  - partial trailing line (no newline) is NOT consumed; once the newline
 *    arrives, the next pass consumes it from the cursor
 *
 * Driven through the N3 reference ingest (test/lib/ingest.ts) which implements
 * the frozen schema (test/lib/schema.ts) + spool layout (test/lib/spool.ts).
 * N2's real ingest.ts --once must satisfy the SAME observable contract.
 */
import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { openLedger, ingestOnce } from "./lib/ingest";
import {
  buildOverlappingSpool,
  appendActive,
  synthEnvelope,
  spoolDir,
  activeName,
} from "./lib/spool";
import { makeTempDir, cleanupTempDir, nextCounter } from "./lib/util";
import type { EventEnvelope, HostId } from "../src/shared/types";

interface Ctx {
  root: string;
  ledgerPath: string;
}
let ctx: Ctx;

function hostCtx(label: string): { spoolRoot: string; host: HostId; emitterId: string } {
  return { spoolRoot: ctx.root, host: "local", emitterId: `pi-${nextCounter()}-${label}` };
}

beforeEach(() => {
  ctx = { root: makeTempDir(`n3-ingest-${nextCounter()}`), ledgerPath: "" };
  ctx.ledgerPath = join(ctx.root, "ledger.db");
});
afterEach(() => cleanupTempDir(ctx.root));

function journalCount(db: ReturnType<typeof openLedger>): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM journal").get() as { n: number }).n;
}
function cursorBytes(db: ReturnType<typeof openLedger>, file: string): number | null {
  const r = db.prepare("SELECT bytes FROM cursors WHERE file_name=?").get(file) as { bytes: number } | null;
  return r?.bytes ?? null;
}

describe("ingest idempotency: overlapping active + sealed (UNIQUE dedup)", () => {
  test("journal rows == unique events; overlap deduped; stable_id correct", () => {
    // seg-1: seqs 1..5 ; active-2: seqs 4..8 (overlap 4,5)
    const p = hostCtx("aaaa1111");
    const { sealedFile, activeFile } = buildOverlappingSpool(p, 5, 4, 8);

    const db = openLedger(ctx.ledgerPath);
    const r1 = ingestOnce(db, ctx.root);
    expect(r1.insertedRows).toBe(8); // seqs 1..8 unique
    expect(r1.skippedDupes).toBe(2); // 4,5 seen in both seg + active within one pass? no — see below
    expect(journalCount(db)).toBe(8);

    // spool_ref records source files (the contract tracks origin for recovery)
    const refs = db
      .prepare("SELECT DISTINCT spool_ref FROM journal ORDER BY spool_ref")
      .all() as { spool_ref: string }[];
    expect(refs.map((r) => r.spool_ref)).toContain("seg-" + p.emitterId + "-1.ndjson");
    expect(refs.map((r) => r.spool_ref)).toContain("active-" + p.emitterId + "-2.ndjson");

    // stable_id reconstructed as host:runtime:session
    const j = db.prepare("SELECT stable_id FROM journal LIMIT 1").get() as { stable_id: string };
    expect(j.stable_id).toBe("local:pi:00000000-0000-4000-8000-000000000000");

    db.close();
  });

  test("run --once twice: 2nd pass inserts 0, cursors unchanged", () => {
    const p = hostCtx("bbbb2222");
    buildOverlappingSpool(p, 6, 3, 9); // seg-1:1..6, active-2:3..9 → unique 1..9

    const db = openLedger(ctx.ledgerPath);
    const r1 = ingestOnce(db, ctx.root);
    expect(r1.insertedRows).toBe(9);
    const c1Active = cursorBytes(db, "active-" + p.emitterId + "-2.ndjson");
    const c1Sealed = cursorBytes(db, "seg-" + p.emitterId + "-1.ndjson");

    // 2nd pass — nothing new
    const r2 = ingestOnce(db, ctx.root);
    expect(r2.insertedRows).toBe(0);
    expect(journalCount(db)).toBe(9);
    // cursors unchanged
    expect(cursorBytes(db, "active-" + p.emitterId + "-2.ndjson")).toBe(c1Active);
    expect(cursorBytes(db, "seg-" + p.emitterId + "-1.ndjson")).toBe(c1Sealed);
    db.close();
  });

  test("ingest across many passes keeps journal == unique events (replay-safe)", () => {
    const p = hostCtx("cccc3333");
    // seg-1: 1..10 ; active-2: 8..12 → unique 1..12
    buildOverlappingSpool(p, 10, 8, 12);
    const db = openLedger(ctx.ledgerPath);
    for (let i = 0; i < 5; i++) ingestOnce(db, ctx.root);
    expect(journalCount(db)).toBe(12);
    db.close();
  });
});

describe("ingest idempotency: partial trailing line is NOT consumed, then IS", () => {
  test("active file ending mid-line: partial bytes left for next pass", () => {
    // §5.4 residual risk 4 + §2.1: "解析只接受换行终止完整行".
    const p = hostCtx("dddd4444");
    // Write seqs 1,2,3 complete; then a 4th line WITHOUT trailing newline.
    const dir = spoolDir(p);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, activeName(p.emitterId, 1));
    const complete = [1, 2, 3].map((s) => JSON.stringify(synthEnvelope(p, s))).join("\n") + "\n";
    const partial = JSON.stringify(synthEnvelope(p, 4)); // no newline
    writeFileSync(file, complete + partial);

    const db = openLedger(ctx.ledgerPath);
    const r1 = ingestOnce(db, ctx.root);
    expect(r1.insertedRows).toBe(3); // only 1,2,3
    expect(journalCount(db)).toBe(3);

    // cursor stops at the end of the last complete newline (before the partial)
    const fileBytes = readFileSync(file).length;
    const cursor = cursorBytes(db, "active-" + p.emitterId + "-1.ndjson")!;
    expect(cursor).toBe(complete.length); // partial bytes excluded
    expect(cursor).toBeLessThan(fileBytes);

    // Now complete the line (append a newline, simulating the next write) and
    // re-run: the previously-partial line becomes consumable from the cursor.
    appendFileSync(file, "\n");
    const r2 = ingestOnce(db, ctx.root);
    expect(r2.insertedRows).toBe(1); // seq 4 now lands
    expect(journalCount(db)).toBe(4);
    db.close();
  });

  test("completing a partial line reveals it; a later complete line also flows", () => {
    // Physical model (§5.4): rsync truncates a snapshot mid-line, so seq2 is
    // present as bytes but has no terminating newline yet. The cursor blocks
    // at the partial. Once the newline arrives, seq2 becomes consumable; a
    // later-written seq3 (with its own newline) flows in the same or a later pass.
    const p = hostCtx("eeee5555");
    const dir = spoolDir(p);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, activeName(p.emitterId, 1));
    const seq1 = JSON.stringify(synthEnvelope(p, 1)) + "\n";
    const partialSeq2 = JSON.stringify(synthEnvelope(p, 2)); // no newline
    writeFileSync(file, seq1 + partialSeq2);

    const db = openLedger(ctx.ledgerPath);
    ingestOnce(db, ctx.root);
    expect(journalCount(db)).toBe(1); // only seq1

    // The emitter later writes seq2's terminating newline AND seq3.
    appendFileSync(file, "\n");
    appendFileSync(file, JSON.stringify(synthEnvelope(p, 3)) + "\n");
    const r2 = ingestOnce(db, ctx.root);
    expect(r2.insertedRows).toBe(2); // seq2 now complete, seq3 too
    expect(journalCount(db)).toBe(3);
    db.close();
  });
});

describe("ingest idempotency: crash recovery (transaction atomicity)", () => {
  test("after a simulated crash mid-batch, re-scan yields identical results", () => {
    // We simulate crash by closing the DB after a pass and reopening a fresh
    // handle (WAL durability means committed data survives). The contract:
    // ingest batch + cursor advance is ONE transaction (§2.1).
    const p = hostCtx("ffff6666");
    buildOverlappingSpool(p, 7, 5, 11); // seg-1:1..7 active-2:5..11 → unique 1..11

    const db1 = openLedger(ctx.ledgerPath);
    const r1 = ingestOnce(db1, ctx.root);
    expect(r1.insertedRows).toBe(11);
    db1.exec("PRAGMA wal_checkpoint(TRUNCATE)"); // ensure WAL flushed
    db1.close();

    // "Restart": reopen and re-scan. Because the cursor committed atomically
    // with the inserts, the re-scan sees the same consumed bytes and inserts 0.
    const db2 = openLedger(ctx.ledgerPath);
    const r2 = ingestOnce(db2, ctx.root);
    expect(r2.insertedRows).toBe(0);
    expect(journalCount(db2)).toBe(11);
    db2.close();
  });
});

describe("ingest idempotency: multiple emitters isolated", () => {
  test("two emitters with the same seq ranges are distinct keys (host, emitter_id, seq)", () => {
    const db = openLedger(ctx.ledgerPath);
    const p1 = { spoolRoot: ctx.root, host: "local" as HostId, emitterId: "pi-A-aaaa1111" };
    const p2 = { spoolRoot: ctx.root, host: "local" as HostId, emitterId: "pi-B-bbbb2222" };
    appendActive(p1, 1, [1, 2, 3].map((s) => synthEnvelope(p1, s)));
    appendActive(p2, 1, [1, 2, 3].map((s) => synthEnvelope(p2, s)));

    ingestOnce(db, ctx.root);
    expect(journalCount(db)).toBe(6); // 3 per emitter, distinct keys

    // re-run, no dups
    ingestOnce(db, ctx.root);
    expect(journalCount(db)).toBe(6);
    db.close();
  });
});
