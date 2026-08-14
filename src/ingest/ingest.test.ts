import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeLedger, scanOnce } from "./ingest";
import { reduceJournal } from "./reducer";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "overload-ingest-"));
  roots.push(root);
  const spool = join(root, "spool");
  const emitterDir = join(spool, "local", "pi-42-bootabcd");
  await mkdir(emitterDir, { recursive: true });
  const db = new Database(join(root, "ledger.db"));
  initializeLedger(db);
  return { root, spool, emitterDir, db };
}

function event(seq: number, kind: string, detail: Record<string, unknown> = {}) {
  return {
    v: 1, at: 1_700_000_000_000 + seq, host: "local", runtime: "pi",
    session: "session-1", emitter_id: "pi-42-bootabcd", writer_id: "pi-42-bootabcd",
    seq, kind, dropped_total: 0, write_error_total: 0, detail,
  };
}

describe("atomic spool ingestion", () => {
  test("consumes only newline-terminated valid envelopes and resumes by byte cursor", async () => {
    const { spool, emitterDir, db } = await fixture();
    const file = join(emitterDir, "active-pi-42-bootabcd-0.ndjson");
    const first = JSON.stringify(event(1, "session_started", { pid: 42, proc_boot_id: "bootabcdefgh", cwd: "/repo", branch: "main", origin: "agent" }));
    const second = JSON.stringify(event(2, "heartbeat"));
    await writeFile(file, `${first}\n${second}`);

    expect((await scanOnce(db, spool)).inserted).toBe(1);
    expect((db.query("SELECT count(*) AS n FROM journal").get() as { n: number }).n).toBe(1);
    expect((db.query("SELECT bytes FROM cursors").get() as { bytes: number }).bytes).toBe(Buffer.byteLength(first) + 1);

    await writeFile(file, `${first}\n${second}\n`);
    expect((await scanOnce(db, spool)).inserted).toBe(1);
    expect((await scanOnce(db, spool)).inserted).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM journal").get() as { n: number }).n).toBe(2);
    db.close();
  });

  test("deduplicates overlap from active and sealed files", async () => {
    const { spool, emitterDir, db } = await fixture();
    const line = `${JSON.stringify(event(1, "heartbeat"))}\n`;
    await writeFile(join(emitterDir, "active-pi-42-bootabcd-0.ndjson"), line);
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), line);

    expect((await scanOnce(db, spool)).inserted).toBe(1);
    expect((db.query("SELECT count(*) AS n FROM journal").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("request reducer", () => {
  test("handles pending, terminal-first, idempotency, and source override of orphaned", async () => {
    const { spool, emitterDir, db } = await fixture();
    const firstBatch = [
      event(1, "decision_resolved", { request_id: "terminal-first", state: "timed_out", answer: "late" }),
      event(2, "decision_requested", { request_id: "pending", request_kind: "choice", prompt: "Pick" }),
      event(3, "decision_requested", { request_id: "inferred", request_kind: "confirm" }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), firstBatch);
    await scanOnce(db, spool);

    // Simulate the P2 inference transition, then prove a later source terminal overrides it.
    db.query("UPDATE requests SET state='orphaned' WHERE request_id='inferred'").run();
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-1.ndjson"), `${JSON.stringify(event(4, "decision_resolved", { request_id: "inferred", state: "resolved", answer: "yes" }))}\n`);
    expect((await scanOnce(db, spool)).inserted).toBe(1);
    expect(reduceJournal(db)).toBe(0);
    const states = db.query("SELECT request_id, state FROM requests ORDER BY request_id").all() as Array<{request_id: string; state: string}>;
    expect(states).toEqual([
      { request_id: "inferred", state: "resolved" },
      { request_id: "pending", state: "pending" },
      { request_id: "terminal-first", state: "timed_out" },
    ]);
    db.close();
  });
});
