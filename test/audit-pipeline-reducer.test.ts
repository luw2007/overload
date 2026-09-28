/**
 * test/audit-pipeline-reducer.test.ts — audit backfill for reducer stories whose
 * r2 evidence pointed at the N8 reference impl or "green suite" but shipped no
 * real assertion through src/ingest/reducer.ts. Isolated tmp DB + spool.
 *
 * Covers: RED-09 recon writer projection, RED-10 writer arbitration,
 * RED-16 session-end orphaning.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeLedger, scanOnce } from "../src/ingest/ingest";

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ov-redact-"));
  roots.push(root);
  const spool = join(root, "spool");
  const emitterDir = join(spool, "local", "em-one");
  await mkdir(emitterDir, { recursive: true });
  const db = new Database(join(root, "ledger.db"));
  initializeLedger(db);
  return { root, spool, emitterDir, db };
}

function ev(seq: number, kind: string, over: Record<string, unknown> = {}) {
  return {
    v: 1, at: 1_700_000_000_000 + seq, host: "local", runtime: "pi", session: "sess-1",
    emitter_id: "em-one", writer_id: "em-one", seq, kind, dropped_total: 0, write_error_total: 0,
    detail: {}, ...over,
  };
}

describe("RED-10 writer arbitration", () => {
  test("foreign-writer non-start events are ignored; a new writer session_started adopts writer and resets to idle", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      ev(1, "session_started", { writer_id: "writer-A", detail: { pid: 1 } }),
      ev(2, "working", { writer_id: "writer-A" }),
      ev(3, "working", { writer_id: "writer-B" }), // foreign, not a start → ignored
      ev(4, "session_started", { writer_id: "writer-B", detail: { pid: 2, parent: "agent" } }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "active-em-one-0.ndjson"), batch);
    await scanOnce(db, spool);
    const row = db.query("SELECT writer_id, state FROM current").get() as { writer_id: string; state: string };
    expect(row).toEqual({ writer_id: "writer-B", state: "idle" });
    db.close();
  });
});

describe("RED-09 recon finding preserves the subject's writer_id", () => {
  test("an admin-emitter recon finding does not overwrite current.writer_id", async () => {
    const { spool, emitterDir, db } = await fixture();
    await writeFile(join(emitterDir, "active-em-one-0.ndjson"), [
      ev(1, "session_started", { writer_id: "writer-A", detail: { pid: 1 } }),
      ev(2, "working", { writer_id: "writer-A" }),
    ].map(JSON.stringify).join("\n") + "\n");
    // Recon findings are emitted by a separate admin emitter under its own dir.
    const reconDir = join(spool, "local", "overload-recon");
    await mkdir(reconDir, { recursive: true });
    const stalled = {
      v: 1, at: 1_700_000_000_003, host: "local", runtime: "overload", session: "admin",
      emitter_id: "overload-recon", writer_id: "overload-recon", seq: 1, kind: "emitter_stalled",
      dropped_total: 0, write_error_total: 0, detail: { stable_id: "local:pi:sess-1", platform: "pi", silent_ms: 1234 },
    };
    await writeFile(join(reconDir, "active-overload-recon-0.ndjson"), JSON.stringify(stalled) + "\n");
    await scanOnce(db, spool);
    const row = db.query("SELECT writer_id, queue, q5_reason FROM current").get() as { writer_id: string; queue: string; q5_reason: string | null };
    expect(row.writer_id).toBe("writer-A"); // not overwritten by overload-recon
    expect(row).toMatchObject({ queue: "q5", q5_reason: "stalled" });
    db.close();
  });
});

describe("RED-16 session-end orphans that writer's pending requests", () => {
  test("session_ended sets the writer's pending request to orphaned with resolved_at", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      ev(1, "session_started", { detail: { pid: 1 } }),
      ev(2, "decision_requested", { detail: { request_id: "ask-1" } }),
      ev(3, "session_ended"),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "active-em-one-0.ndjson"), batch);
    await scanOnce(db, spool);
    const req = db.query("SELECT state, resolved_at FROM requests WHERE request_id='ask-1'").get() as { state: string; resolved_at: number | null };
    expect(req.state).toBe("orphaned");
    expect(req.resolved_at).toBe(1_700_000_000_003);
    db.close();
  });
});
