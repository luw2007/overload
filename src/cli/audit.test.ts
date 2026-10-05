import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { audit } from "./audit";
import { initializeLedger } from "../ingest/ingest";
import { applyControlEvent } from "../control/projection";
import { controlPayloadHash } from "../control/outbox";

/** Seed actual control envelopes and project them through the reducer's projection function. */
function seedDb(...rows: Array<{ ace_at: number; event_id: string; item_id: string; revision?: number; state: string; effect_state: string; updated_at: number; event_kind?: string; feedback?: { useful: 0 | 1; revision: number } }>): Database {
  const db = new Database(":memory:");
  initializeLedger(db);
  rows.forEach((r, index) => {
    const attention = {
      item_id: r.item_id, work_id: "w", revision: r.revision ?? r.feedback?.revision ?? 1,
      state: r.state, effect_state: r.effect_state, effect_detail: null, urgency: "inbox", owner: "o",
      conclusion: "c", trigger: "t", impact: "i", recommendation: null, options: [],
      expires_at: null, defer_until: null, acknowledged_at: r.state === "open" ? 50 : null,
      source_link: null, approval_id: null, consumer_owner: null, contract_revision: 1,
      decision_mode: "human_only", evidence: {}, created_at: r.ace_at, updated_at: r.updated_at,
    };
    const payload = { attention };
    const event = {
      event_id: r.event_id,
      event_kind: r.event_kind ?? (attention.revision === 1 && r.state === "open" ? "attention.created"
        : r.state === "resolved" ? "attention.resolved"
        : r.state === "superseded" ? "attention.superseded"
        : r.state === "applying" ? "attention.applying" : "attention.updated"),
      payload_hash: controlPayloadHash(payload), payload,
    };
    db.query(`INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind,detail)
      VALUES ('local','control',?,?,'control','control','control_event',?)`)
      .run(index + 1, r.ace_at, JSON.stringify(event));
    applyControlEvent(db, event, r.ace_at);
    if (r.feedback) db.query("INSERT INTO control_attention_feedback VALUES (?,?,?,?,?,?)")
      .run(`${r.item_id}-fb-${r.feedback.revision}`, r.item_id, r.feedback.revision, r.feedback.useful, "noise", r.ace_at);
  });
  return db;
}

describe("control metrics — event flow vs current snapshot stock", () => {
  test("one applied open→resolved lifecycle counts both transitions while snapshot retains only resolved", () => {
    // Distinct applied event envelopes retain both historical states; snapshot keeps only e2.
    const db = seedDb(
      { ace_at: 100, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "unknown", updated_at: 100 },
      { ace_at: 150, event_id: "e2", item_id: "i1", revision: 2, state: "resolved", effect_state: "succeeded", updated_at: 150 },
    );
    const report = audit(db, { sample: 0, sinceMs: 200, now: 200 });
    const c = report.control;
    expect(c.projectedEvents).toBe(2);
    expect(c.openedFlow).toBe(1);
    expect(c.resolvedFlow).toBe(1);
    expect(c.applyingFlow).toBe(0);
    expect(c.supersededFlow).toBe(0);
    // Stock reflects the latest snapshot (resolved).
    expect(c.currentOpen).toBe(0);
    expect(c.currentResolved).toBe(1);
    expect(c.currentApplying).toBe(0);
    expect(c.currentSuperseded).toBe(0);
    expect(c.coverageMissing).toBe(0);
  });

  test("effect state change alone does not open a new item or mark flow as resolved", () => {
    // Effect observation changes on the second revision; state stays open.
    const db = seedDb(
      { ace_at: 100, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "not_started", updated_at: 100 },
      { ace_at: 120, event_id: "e2", item_id: "i1", revision: 2, state: "open", effect_state: "failed", updated_at: 120 },
    );
    const report = audit(db, { sample: 0, sinceMs: 200, now: 200 });
    const c = report.control;
    expect(c.openedFlow).toBe(1);
    expect(c.resolvedFlow).toBe(0);
    expect(c.coverageMissing).toBe(0);
    // Current stock: one open item
    expect(c.currentOpen).toBe(1);
    expect(c.currentResolved).toBe(0);
    // Effects reflect the last snapshot's effect_state
    expect(c.effectsFailed).toBe(1);
    expect(c.effectsNotStarted).toBe(0);
  });

  test("pre-window open item resolved during window counts in resolvedFlow only", () => {
    // Item i1 was opened before the audit window (event e1 at t=50) and then resolved
    // inside the window (event e2 at t=150). Cutoff = now - 100, so cutoff = 100.
    const db = seedDb(
      { ace_at: 50, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "unknown", updated_at: 50 },
      { ace_at: 150, event_id: "e2", item_id: "i1", revision: 2, state: "resolved", effect_state: "succeeded", updated_at: 150 },
    );
    const report = audit(db, { sample: 0, sinceMs: 100, now: 200 });
    const c = report.control;
    // projectedEvents only counts applied events inside the window
    expect(c.projectedEvents).toBe(1);
    // Only the window event (e2) drives flow counts → resolvedFlow=1.
    expect(c.openedFlow).toBe(0);
    expect(c.resolvedFlow).toBe(1);
    expect(c.coverageMissing).toBe(0);
    // Current stock at now=200: i1 is resolved
    expect(c.currentOpen).toBe(0);
    expect(c.currentResolved).toBe(1);
  });

  test("pre-window open item (never touched in window) shows up in stock, not in flow", () => {
    const db = seedDb(
      { ace_at: 50, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "unknown", updated_at: 50 },
    );
    const report = audit(db, { sample: 0, sinceMs: 100, now: 200 });
    const c = report.control;
    // No applied events in the window
    expect(c.projectedEvents).toBe(0);
    expect(c.openedFlow).toBe(0);
    expect(c.resolvedFlow).toBe(0);
    // Stock still reflects the item's current (unchanged) open state
    expect(c.currentOpen).toBe(1);
    expect(c.currentResolved).toBe(0);
  });

  test("duplicate journal publication of one applied business event counts once", () => {
    const db = seedDb(
      { ace_at: 100, event_id: "dup-event", item_id: "i1", revision: 1, state: "open", effect_state: "not_started", updated_at: 100 },
    );
    const envelope = db.query("SELECT detail FROM journal WHERE kind='control_event'").get() as { detail: string };
    db.query(`INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind,detail)
      VALUES ('local','control',2,110,'control','control','control_event',?)`).run(envelope.detail);
    const result = db.query("INSERT OR IGNORE INTO applied_control_events VALUES (?,?,?)")
      .run("dup-event", controlPayloadHash(JSON.parse(envelope.detail).payload), 110);
    expect(result.changes).toBe(0);
    const c = audit(db, { sample: 0, sinceMs: 200, now: 200 }).control;
    expect(c.projectedEvents).toBe(1);
    expect(c.openedFlow).toBe(1);
    expect(c.coverageMissing).toBe(0);
  });

  test("material projection of the same revision does not open the item twice", () => {
    const db = seedDb(
      { ace_at: 100, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "not_started", updated_at: 100 },
      { ace_at: 110, event_id: "material", item_id: "i1", revision: 1, state: "open", effect_state: "not_started", updated_at: 100, event_kind: "attention.material_projected" },
    );
    const c = audit(db, { sample: 0, sinceMs: 200, now: 200 }).control;
    expect(c.projectedEvents).toBe(2);
    expect(c.openedFlow).toBe(1);
    expect(c.coverageMissing).toBe(0);
  });

  test("missing coverage is explicit rather than fabricated to zero", () => {
    // An applied receipt without retained payload history cannot establish a state.
    const db = new Database(":memory:");
    initializeLedger(db);
    db.query("INSERT INTO applied_control_events VALUES (?,?,?)").run("e1", "h", 100);
    const report = audit(db, { sample: 0, sinceMs: 200, now: 200 });
    const c = report.control;
    expect(c.projectedEvents).toBe(1);
    expect(c.coverageMissing).toBe(1);
    expect(c.openedFlow).toBe(0);
    expect(c.resolvedFlow).toBe(0);
  });

  test("missing prior event payload remains a coverage gap despite a current snapshot", () => {
    const db = seedDb(
      { ace_at: 100, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "not_started", updated_at: 100 },
    );
    db.query("DELETE FROM journal WHERE kind='control_event'").run();
    const c = audit(db, { sample: 0, sinceMs: 200, now: 200 }).control;
    expect(c.projectedEvents).toBe(1);
    expect(c.coverageMissing).toBe(1);
    expect(c.openedFlow).toBe(0);
    expect(c.currentOpen).toBe(1);
  });

  test("feedback counts current item/revision pairs without duplicates or delimiter collisions", () => {
    const db = seedDb(
      { ace_at: 100, event_id: "a1", item_id: "a:b", revision: 1, state: "open", effect_state: "not_started", updated_at: 100 },
      { ace_at: 110, event_id: "a2", item_id: "a:b", revision: 2, state: "resolved", effect_state: "succeeded", updated_at: 110, feedback: { useful: 1, revision: 2 } },
      { ace_at: 120, event_id: "b1", item_id: "a", revision: 1, state: "open", effect_state: "unknown", updated_at: 120 },
      { ace_at: 130, event_id: "c1", item_id: "other", revision: 1, state: "open", effect_state: "unknown", updated_at: 130 },
    );
    db.query("INSERT INTO control_attention_feedback VALUES (?,?,?,?,?,?)")
      .run("dup-a2", "a:b", 2, 1, null, 140);
    db.query("INSERT INTO control_attention_feedback VALUES (?,?,?,?,?,?)")
      .run("a1-feedback", "a:b", 1, 0, null, 150);
    db.query("INSERT INTO control_attention_feedback VALUES (?,?,?,?,?,?)")
      .run("ineligible", "orphan", 9, 1, null, 160);
    const c = audit(db, { sample: 0, sinceMs: 200, now: 200 }).control;
    expect(c.feedbackUseful).toBe(1);
    expect(c.feedbackNotUseful).toBe(0);
    expect(c.feedbackUnmeasured).toBe(2);
  });

  test("conflicting feedback on one revision does not reduce another item's unmeasured count", () => {
    const db = seedDb(
      { ace_at: 100, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "unknown", updated_at: 100, feedback: { useful: 1, revision: 1 } },
      { ace_at: 110, event_id: "e2", item_id: "i2", revision: 1, state: "open", effect_state: "unknown", updated_at: 110 },
    );
    db.query("INSERT INTO control_attention_feedback VALUES (?,?,?,?,?,?)")
      .run("contradiction", "i1", 1, 0, null, 120);
    const c = audit(db, { sample: 0, sinceMs: 200, now: 200 }).control;
    expect(c.feedbackUseful).toBe(0);
    expect(c.feedbackNotUseful).toBe(0);
    expect(c.feedbackUnmeasured).toBe(2);
  });

  test("feedbackUnmeasured default when no feedback table exists", () => {
    const db = seedDb(
      { ace_at: 100, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "unknown", updated_at: 100 },
    );
    db.exec("DROP TABLE control_attention_feedback");
    const report = audit(db, { sample: 0, sinceMs: 200, now: 200 });
    const c = report.control;
    expect(c.feedbackUseful).toBe(0);
    expect(c.feedbackNotUseful).toBe(0);
    expect(c.feedbackUnmeasured).toBe(1);
  });

  test("acknowledgedOnly counts items that are open but have been acked", () => {
    const db = seedDb(
      { ace_at: 100, event_id: "e1", item_id: "i1", revision: 1, state: "open", effect_state: "unknown", updated_at: 100 },
      { ace_at: 120, event_id: "e2", item_id: "i2", revision: 1, state: "resolved", effect_state: "succeeded", updated_at: 120 },
    );
    const report = audit(db, { sample: 0, sinceMs: 200, now: 200 });
    const c = report.control;
    expect(c.acknowledgedOnly).toBe(1);
    expect(c.currentOpen).toBe(1);
  });

  test("no control-projection tables → empty metrics, no crash", () => {
    const db = new Database(":memory:");
    // Minimal ledger (no control tables) — audit.ts still queries sessions
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, host TEXT, emitter_id TEXT, seq INTEGER, at INTEGER, stable_id TEXT, writer_id TEXT, kind TEXT, detail TEXT, spool_ref TEXT);
      CREATE TABLE journal_7d AS SELECT * FROM journal WHERE 0;
      CREATE TABLE journal_30d AS SELECT * FROM journal WHERE 0;
      CREATE VIEW journal_all AS SELECT * FROM journal UNION ALL SELECT * FROM journal_7d UNION ALL SELECT * FROM journal_30d;
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, origin TEXT, cwd TEXT, branch TEXT, created_at INTEGER, first_seen_at INTEGER);
      CREATE TABLE requests(request_uid TEXT PRIMARY KEY, stable_id TEXT, writer_id TEXT, origin_emitter_id TEXT, request_id TEXT, kind TEXT, state TEXT, created_at INTEGER, resolved_at INTEGER, detail TEXT);
      CREATE TABLE current(stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT, queue TEXT, q5_reason TEXT, origin TEXT, last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER, last_progress_at INTEGER);
      CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER, PRIMARY KEY(stable_id, writer_id));
      CREATE TABLE reducer_cursor(id INTEGER PRIMARY KEY CHECK(id=1), journal_seq INTEGER NOT NULL);
      CREATE TABLE cursors(file_name TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
    `);
    const report = audit(db, { sample: 0, sinceMs: 200, now: 200 });
    const c = report.control;
    expect(c.projectedEvents).toBe(0);
    expect(c.openedFlow).toBe(0);
    expect(c.resolvedFlow).toBe(0);
    expect(c.currentOpen).toBe(0);
    expect(c.currentResolved).toBe(0);
    expect(c.coverageMissing).toBe(0);
  });
});

describe("selected-session history query respects SQLite variable limit", () => {
  test("query chunks stable_id IN (...) to stay under SQLite 999 var limit", () => {
    const db = new Database(":memory:");
    initializeLedger(db);
    // Insert 1200 sessions with qualifying journal rows (decision_requested gated=true)
    for (let i = 0; i < 1200; i++) {
      const sid = `sess-${i.toString().padStart(4, "0")}`;
      // sessions columns: stable_id, host, runtime, session, origin, cwd, branch, created_at, first_seen_at (9 values)
      db.query("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)").run(sid, "h", null, null, "unknown", null, null, null, 50);
      // journal columns: ingest_seq, host, emitter_id, seq, at, stable_id, writer_id, kind, detail, spool_ref (10 values)
      db.query("INSERT INTO journal VALUES (?,?,?,?,?,?,?,?,?,?)").run(i + 1, "h", "em", i + 1, 1900, sid, "w", "decision_requested", JSON.stringify({ gated: true, request_id: `r${i}`, rule: "R1" }), null);
    }
    const report = audit(db, { sample: 0, sinceMs: 200, now: 2000 });
    expect(report.sessions).toHaveLength(1200);
    expect(report.gatedRequested).toBe(1200);
    expect(report.sessions.every(session => session.decisions.requested === 1)).toBe(true);
  });
});
