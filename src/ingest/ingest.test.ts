import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeLedger, scanOnce } from "./ingest";
import { reduceJournal } from "./reducer";
import { CLASSIFIER_VERSION, classify } from "./classifier";

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

describe("P2 reducer and classifier", () => {
  test("classifier is pure and emits deterministic queue changes", () => {
    const before = { stable_id: "local:pi:s", state: "idle", origin: "unknown", queue: "q3", q5_reason: null };
    const event = { ingest_seq: 9, at: 99, kind: "session_ended", detail: {} };
    expect(CLASSIFIER_VERSION).toBe(1);
    expect(classify(before, event)).toEqual([
      { subject: "local:pi:s", queue: "q3", direction: "left", at: 99, source_seq: 9, classifier_version: 1 },
      { subject: "local:pi:s", queue: "q2", direction: "entered", at: 99, source_seq: 9, classifier_version: 1 },
    ]);
    expect(before).toEqual({ stable_id: "local:pi:s", state: "idle", origin: "unknown", queue: "q3", q5_reason: null });
  });

  test("tracks state, terminal stickiness, precedence, attachments, and idempotent transitions", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "session_started", { pid: 42, parent: "agent" }),
      event(2, "working"),
      event(3, "emitter_stalled", { stable_id: "local:pi:session-1", emitter_id: "pi-42-bootabcd" }),
      event(4, "settled"),
      event(5, "attachment_observed", { stable_id: "local:pi:session-1", platform: "orca", binding: "wt-7" }),
      event(6, "session_ended"),
      event(7, "working"),
      event(8, "session_vanished", { stable_id: "local:pi:session-1", platform: "pi" }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);
    await scanOnce(db, spool);

    expect(db.query("SELECT state, origin, queue, q5_reason FROM current").get()).toEqual({ state: "done", origin: "agent", queue: "q2", q5_reason: null });
    expect(db.query("SELECT platform, binding, valid FROM attachments").get()).toEqual({ platform: "orca", binding: "wt-7", valid: 1 });
    const count = (db.query("SELECT count(*) n FROM queue_transitions").get() as { n: number }).n;
    db.query("UPDATE reducer_cursor SET journal_seq=0 WHERE id=1").run();
    reduceJournal(db);
    expect((db.query("SELECT count(*) n FROM queue_transitions").get() as { n: number }).n).toBe(count);
    db.close();
  });

  test("projects attributable telemetry gaps and ignores unattributable gaps", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "session_started"),
      event(2, "working"),
      event(3, "telemetry_gap", { stable_id: "local:pi:session-1", platform: "pi" }),
      event(4, "telemetry_gap", { platform: "herdr", native_id: "unbound" }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);
    await scanOnce(db, spool);
    expect(db.query("SELECT stable_id, state, queue, q5_reason FROM current").all()).toEqual([
      { stable_id: "local:pi:session-1", state: "working", queue: "q5", q5_reason: "telemetry_gap" },
    ]);
    db.close();
  });

  test("freezes runtime and attachment-bound sessions during incidents", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "session_started"),
      event(2, "working"),
      event(3, "attachment_observed", { stable_id: "local:pi:session-1", platform: "herdr", binding: "thread-1" }),
      event(4, "source_outage", { source: "herdr" }),
      event(5, "session_vanished", { stable_id: "local:pi:session-1", platform: "herdr" }),
      event(6, "source_recovered", { source: "herdr" }),
      event(7, "session_vanished", { stable_id: "local:pi:session-1", platform: "herdr" }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);
    await scanOnce(db, spool);
    expect(db.query("SELECT state, frozen FROM current").get()).toEqual({ state: "vanished", frozen: 0 });
    expect(db.query("SELECT source, closed_at FROM incidents").get()).toEqual({ source: "herdr", closed_at: event(6, "x").at });
    db.close();
  });

  test("enqueues initial notification atomically and orphans only when emitter is drained", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "session_started"),
      event(2, "decision_requested", { request_id: "ask-1" }),
      event(3, "emitter_dead", { stable_id: "local:pi:session-1", emitter_id: "pi-42-bootabcd" }),
      event(4, "emitter_drained", { stable_id: "local:pi:session-1", emitter_id: "pi-42-bootabcd" }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);
    await scanOnce(db, spool);
    expect(db.query("SELECT state FROM requests WHERE request_id='ask-1'").get()).toEqual({ state: "orphaned" });
    expect(db.query("SELECT kind, state, reminder_seq FROM notifications").get()).toEqual({ kind: "initial", state: "pending", reminder_seq: 0 });
    expect(db.query("SELECT emitter_id, reason, to_at FROM coverage_gaps").get()).toEqual({ emitter_id: "pi-42-bootabcd", reason: "emitter_drained", to_at: event(4, "x").at });
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

  test("errored resolution without explicit state lands as cancelled, not resolved (review B1)", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "decision_requested", { request_id: "ask-err" }),
      // Real N1 error payload shape: no state field, error flag only.
      event(2, "decision_resolved", { request_id: "ask-err", error: true }),
      event(3, "decision_requested", { request_id: "ask-ok" }),
      event(4, "decision_resolved", { request_id: "ask-ok", state: "resolved", selected: "yes" }),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);
    await scanOnce(db, spool);
    const states = db.query("SELECT request_id, state FROM requests ORDER BY request_id").all() as Array<{request_id: string; state: string}>;
    expect(states).toEqual([
      { request_id: "ask-err", state: "cancelled" },
      { request_id: "ask-ok", state: "resolved" },
    ]);
    db.close();
  });
});
