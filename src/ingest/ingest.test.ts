import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeLedger, readCompleteLines, scanOnce } from "./ingest";
import { reduceJournal } from "./reducer";
import { CLASSIFIER_VERSION, classify, queueAfter } from "./classifier";
import { ackRequest } from "../shared/queries";

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

describe("ledger schema migrations", () => {
  test("fresh schema does not recreate the retired request reminder column", async () => {
    const schema = await readFile(new URL("./schema.sql", import.meta.url), "utf8");
    expect(schema).not.toContain("next_reminder_at");

    const db = new Database(":memory:");
    initializeLedger(db);
    const columns = db.query("PRAGMA table_info(requests)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "next_reminder_at")).toBe(false);
    db.close();
  });

  test("drops the retired current frozen column from existing ledgers", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE current(
      stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT NOT NULL,
      queue TEXT, q5_reason TEXT, origin TEXT NOT NULL DEFAULT 'unknown',
      last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER,
      last_progress_at INTEGER, frozen INTEGER DEFAULT 0)`);

    initializeLedger(db);

    const columns = db.query("PRAGMA table_info(current)").all() as Array<{ name: string }>;
    expect(columns.some((column) => column.name === "frozen")).toBe(false);
    db.close();
  });
});

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

  test("does not reopen a file whose cursor already covers it", async () => {
    const { spool, emitterDir, db } = await fixture();
    const file = join(emitterDir, "seg-pi-42-bootabcd-0.ndjson");
    await writeFile(file, `${JSON.stringify(event(1, "heartbeat"))}\n`);
    await scanOnce(db, spool);

    // Read permission is removed after the cursor reaches EOF: a scan that
    // still opened consumed files would fail here instead of skipping them.
    await chmod(file, 0o000);
    try {
      expect((await scanOnce(db, spool)).files).toBe(0);
    } finally {
      await chmod(file, 0o600);
    }
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

  test("tolerates a spool file that vanishes between discovery and read (seal race)", async () => {
    // The emitter can rename active-*.ndjson -> seg-*.ndjson (seal) between
    // discoverSpoolFiles listing a path and readCompleteLines opening it.
    // Regression: this used to throw ENOENT and crash the whole scanOnce
    // batch, losing every other file's inserts collected in the same tick.
    const { spool, emitterDir, db } = await fixture();
    await writeFile(join(emitterDir, "active-pi-42-bootabcd-0.ndjson"), `${JSON.stringify(event(1, "heartbeat"))}\n`);
    await rm(join(emitterDir, "active-pi-42-bootabcd-0.ndjson"));

    expect(await readCompleteLines(join(emitterDir, "active-pi-42-bootabcd-0.ndjson"), "local/pi-42-bootabcd/active-pi-42-bootabcd-0.ndjson", 0)).toBeNull();
    expect(await scanOnce(db, spool)).toEqual({ files: 0, inserted: 0 });
    db.close();
  });

  test("stores the incarnation pid from the nested session_started lease (loop-1 E1)", async () => {
    const { spool, emitterDir, db } = await fixture();
    const line = JSON.stringify(event(1, "session_started", {
      lease: { pid: 4242, proc_boot_id: "bootfeedface" }, cwd: "/repo",
    }));
    await writeFile(join(emitterDir, "active-pi-42-bootabcd-0.ndjson"), `${line}\n`);
    await scanOnce(db, spool);
    expect(db.query("SELECT pid, proc_boot_id FROM session_incarnations").get())
      .toEqual({ pid: 4242, proc_boot_id: "bootfeedface" });
    db.close();
  });

  test("q2 accepts done sessions with lineage origins, not just the literal 'agent' (loop-1 E8)", () => {
    const done = { ingest_seq: 9, at: 9, kind: "session_ended", detail: {} };
    for (const origin of ["agent", "unknown", "orca:wt-123", "local:pi:parent-session"]) {
      const current = { stable_id: "local:pi:s", state: "idle", origin, queue: "q3", q5_reason: null };
      expect(queueAfter({ ...current, state: "done" }, done).queue).toBe("q2");
    }
    const human = { stable_id: "local:pi:s", state: "done", origin: "human", queue: null, q5_reason: null };
    expect(queueAfter(human, done).queue).toBeNull();
  });
});

describe("P2 reducer and classifier", () => {
  test("classifier is pure and emits deterministic queue changes", () => {
    const before = { stable_id: "local:pi:s", state: "idle", origin: "unknown", queue: "q3", q5_reason: null };
    const event = { ingest_seq: 9, at: 99, kind: "session_ended", detail: {} };
    expect(CLASSIFIER_VERSION).toBe(2);
    expect(classify(before, event)).toEqual([
      { subject: "local:pi:s", queue: "q3", direction: "left", at: 99, source_seq: 9, classifier_version: 2 },
      { subject: "local:pi:s", queue: "q2", direction: "entered", at: 99, source_seq: 9, classifier_version: 2 },
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

    // v2: agent-origin done session with zero change evidence is read-only → q4 (was q2 under v1).
    expect(db.query("SELECT state, origin, queue, q5_reason FROM current").get()).toEqual({ state: "done", origin: "agent", queue: "q4", q5_reason: null });
    expect(db.query("SELECT platform, binding, valid FROM attachments").get()).toEqual({ platform: "orca", binding: "wt-7", valid: 1 });
    const count = (db.query("SELECT count(*) n FROM queue_transitions").get() as { n: number }).n;
    db.query("UPDATE reducer_cursor SET journal_seq=0 WHERE id=1").run();
    reduceJournal(db);
    expect((db.query("SELECT count(*) n FROM queue_transitions").get() as { n: number }).n).toBe(count);
    db.close();
  });

  test("separates the progress clock from the heartbeat clock and keeps recon findings off last_event_at", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "session_started", { pid: 42, parent: "agent" }),
      event(2, "working"),
      event(3, "tool_activity", { tool: "bash" }),
      event(4, "heartbeat"),
      event(5, "heartbeat"),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);
    await scanOnce(db, spool);

    const beat = db.query("SELECT last_event_at, last_heartbeat_at, last_progress_at FROM current").get() as Record<string, number>;
    // Heartbeats prove liveness only: the progress clock stays at tool_activity.
    expect(beat.last_heartbeat_at).toBe(1_700_000_000_005);
    expect(beat.last_progress_at).toBe(1_700_000_000_003);
    expect(beat.last_event_at).toBe(1_700_000_000_005);

    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-1.ndjson"),
      JSON.stringify(event(6, "turn_hung", { stable_id: "local:pi:session-1", emitter_id: "pi-42-bootabcd", hung_ms: 1_200_000 })) + "\n");
    await scanOnce(db, spool);

    const hung = db.query("SELECT queue, q5_reason, last_event_at, last_progress_at FROM current").get() as Record<string, unknown>;
    expect(hung).toMatchObject({ queue: "q5", q5_reason: "turn_hung" });
    // An observation about the session must not look like activity by it.
    expect(hung.last_event_at).toBe(1_700_000_000_005);
    expect(hung.last_progress_at).toBe(1_700_000_000_003);
    db.close();
  });
  test("projects session-start host context without creating an external attachment", async () => {
    const { spool, emitterDir, db } = await fixture();
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), `${JSON.stringify(event(1, "session_started", {
      host: { app: "Ghostty", session_id: "terminal-1", tty: "/dev/ttys003" },
    }))}\n`);

    await scanOnce(db, spool);

    expect(db.query("SELECT app, session_id, tty FROM session_hosts").get())
      .toEqual({ app: "Ghostty", session_id: "terminal-1", tty: "/dev/ttys003" });
    expect(db.query("SELECT count(*) n FROM attachments").get()).toEqual({ n: 0 });
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
    expect(db.query("SELECT stable_id, writer_id, state, queue, q5_reason FROM current").all()).toEqual([
      { stable_id: "local:pi:session-1", writer_id: "pi-42-bootabcd", state: "working", queue: "q5", q5_reason: "telemetry_gap" },
    ]);
    db.close();
  });

  test("gates recon findings while their source incident is open", async () => {
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
    expect(db.query("SELECT state FROM current").get()).toEqual({ state: "vanished" });
    expect(db.query("SELECT source, closed_at FROM incidents").get()).toEqual({ source: "herdr", closed_at: event(6, "x").at });
    db.close();
  });

  test("labels a drained emitter only when it actually orphans a pending request", async () => {
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
    expect(db.query("SELECT queue, q5_reason FROM current").get()).toEqual({ queue: "q5", q5_reason: "orphaned_request" });
    expect(db.query("SELECT emitter_id, reason, to_at FROM coverage_gaps").get()).toEqual({ emitter_id: "pi-42-bootabcd", reason: "emitter_drained", to_at: event(4, "x").at });

    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-1.ndjson"),
      `${JSON.stringify(event(5, "emitter_drained", { stable_id: "local:pi:session-1", emitter_id: "pi-42-bootabcd" }))}\n`);
    await scanOnce(db, spool);
    expect(db.query("SELECT queue, q5_reason FROM current").get()).toEqual({ queue: "q5", q5_reason: "orphaned_request" });
    db.close();
  });

  test("does not label a drained emitter with no pending request as a zombie", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "session_started"),
      event(2, "emitter_drained", { stable_id: "local:pi:session-1", emitter_id: "pi-42-bootabcd" }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);
    await scanOnce(db, spool);

    expect(db.query("SELECT queue, q5_reason FROM current").get()).toEqual({ queue: "q3", q5_reason: null });
    db.close();
  });
});

describe("request reducer", () => {
  test("cmux settle orphans only cmux pending requests", async () => {
    const { spool, emitterDir, db } = await fixture();
    const cmuxAsk = { ...event(1, "decision_requested", { request_id: "cmux-ask" }), runtime: "cmux" };
    const cmuxSettle = { ...event(2, "settled"), runtime: "cmux" };
    const piAsk = event(3, "decision_requested", { request_id: "pi-ask" });
    const piSettle = event(4, "settled");
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"),
      [cmuxAsk, cmuxSettle, piAsk, piSettle].map(JSON.stringify).join("\n") + "\n");

    await scanOnce(db, spool);

    expect(db.query("SELECT request_id, state FROM requests ORDER BY request_id").all()).toEqual([
      { request_id: "cmux-ask", state: "orphaned" },
      { request_id: "pi-ask", state: "pending" },
    ]);
    db.close();
  });

  test("decision resolution returns an awaiting session to idle without losing request terminal state", async () => {
    const { spool, emitterDir, db } = await fixture();
    const batch = [
      event(1, "session_started"),
      event(2, "decision_requested", { request_id: "ask-1" }),
      event(3, "decision_resolved", { request_id: "ask-1", state: "resolved" }),
    ].map(JSON.stringify).join("\n") + "\n";
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"), batch);

    await scanOnce(db, spool);

    expect(db.query("SELECT state, queue FROM current").get()).toEqual({ state: "idle", queue: "q3" });
    expect(db.query("SELECT state FROM requests WHERE request_id='ask-1'").get()).toEqual({ state: "resolved" });
    db.close();
  });

  test("source resolution overrides a local acked terminal", async () => {
    const { spool, emitterDir, db } = await fixture();
    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-0.ndjson"),
      `${JSON.stringify(event(1, "decision_requested", { request_id: "acked-then-resolved" }))}\n`);
    await scanOnce(db, spool);
    const request = db.query("SELECT request_uid FROM requests WHERE request_id='acked-then-resolved'").get() as { request_uid: string };

    expect(ackRequest(db, request.request_uid).changes).toBe(1);
    expect(db.query("SELECT state FROM requests WHERE request_uid=?").get(request.request_uid)).toEqual({ state: "acked" });

    await writeFile(join(emitterDir, "seg-pi-42-bootabcd-1.ndjson"),
      `${JSON.stringify(event(2, "decision_resolved", { request_id: "acked-then-resolved", state: "resolved", answer: "yes" }))}\n`);
    await scanOnce(db, spool);

    expect(db.query("SELECT state FROM requests WHERE request_uid=?").get(request.request_uid)).toEqual({ state: "resolved" });
    db.close();
  });

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
