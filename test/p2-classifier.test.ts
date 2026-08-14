/**
 * test/p2-classifier.test.ts — queue predicates + transitions idempotency +
 * activation watermark against the FROZEN P2 contract (p2-freeze.md protocol 2,
 * tech-solution §2.4b/§2.4c).
 *
 * Two layers:
 *  - CONTRACT (always runs): drives the N8 reference classifier
 *    (test/lib/p2/classifier.ts) over the frozen DDL (test/lib/p2/schema.ts).
 *    Must pass BEFORE N5/N6/N7 merge.
 *  - REAL (explicit SKIP until the entry exists): end-to-end through the real
 *    src/ingest pipeline (ingest --once under an isolated HOME) + the q1/q2/
 *    zombie/health CLI surface, plus a frozen-DDL drift check on
 *    src/ingest/schema.sql. Activates once node/n5 lands.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openLedgerP2, FROZEN_P2_TABLES, FROZEN_P2_UNIQUES } from "./lib/p2/schema";
import {
  CLASSIFIER_VERSION,
  activateClassifier,
  activationWatermark,
  activeVersionAt,
  normalizeOrigin,
  queueForRequest,
  queueForSession,
  recordTransition,
  reduceClassifyPass,
} from "./lib/p2/classifier";
import { makeTempDir, cleanupTempDir, nextCounter } from "./lib/util";
import { appendActive } from "./lib/spool";
import { STALL_PROFILE_MS, type EventEnvelope, type Q5Reason } from "../src/shared/types";

const REPO = process.cwd();
const N5_CLASSIFIER = join(REPO, "src/ingest/classifier.ts");
const N5_INGEST = join(REPO, "src/ingest/ingest.ts");
const N5_CLI = join(REPO, "src/cli/overload.ts");
const HAS_N5 = existsSync(N5_CLASSIFIER) && existsSync(N5_INGEST) && existsSync(N5_CLI);

// ─── CONTRACT LAYER ─────────────────────────────────────────────────────────

let db: Database;
let root: string;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  root = makeTempDir(`n8-cls-${nextCounter()}`);
  db = openLedgerP2(join(root, "ledger.db"));
});
afterEach(() => {
  try { db.close(); } catch { /* */ }
  cleanupTempDir(root);
});

const FROZEN_Q5_REASONS: Q5Reason[] = ["stalled", "dead_incarnation", "telemetry_gap", "orphaned_request"];

function session(over: Partial<Parameters<typeof queueForSession>[0]["0"]> = {}) {
  return {
    stable_id: "local:pi:s1",
    state: "working" as const,
    origin: "unknown",
    last_heartbeat_at: NOW - 60_000,
    ...over,
  };
}

describe("contract: Q1 — requests.pending is the sole source", () => {
  test("pending → q1; every other request state never lands in q1", () => {
    expect(queueForRequest("pending").queue).toBe("q1");
    for (const state of ["resolved", "cancelled", "timed_out"] as const) {
      expect(queueForRequest(state).queue).not.toBe("q1");
      expect(queueForRequest(state).queue).toBeNull();
    }
  });

  test("orphaned requests are Q5 (orphaned_request), not q1", () => {
    const q = queueForRequest("orphaned");
    expect(q.queue).toBe("q5");
    expect(q.q5_reason).toBe("orphaned_request");
  });
});

describe("contract: Q2 — done ∧ origin ∈ {agent, unknown}", () => {
  test("done + agent origin → q2", () => {
    expect(queueForSession(session({ state: "done", origin: "agent@ws1" }), NOW).queue).toBe("q2");
  });
  test("done + unknown origin → q2 (unknown is treated as agent, §2.4a)", () => {
    expect(queueForSession(session({ state: "done", origin: "unknown" }), NOW).queue).toBe("q2");
    expect(queueForSession(session({ state: "done", origin: null }), NOW).queue).toBe("q2");
  });
  test("done + human origin → NOT q2 (Q4 closed until P4)", () => {
    expect(queueForSession(session({ state: "done", origin: "human" }), NOW).queue).toBeNull();
  });
  test("non-done sessions never enter q2", () => {
    for (const state of ["working", "idle", "awaiting_human", "vanished", "failed"] as const) {
      expect(queueForSession(session({ state, last_heartbeat_at: NOW }), NOW).queue).not.toBe("q2");
    }
  });
  test("normalizeOrigin: parent lineage ⇒ agent; 'human' stays human; empty ⇒ unknown", () => {
    expect(normalizeOrigin("agent@ws1")).toBe("agent");
    expect(normalizeOrigin("orca:wt-123")).toBe("agent");
    expect(normalizeOrigin("human")).toBe("human");
    expect(normalizeOrigin("unknown")).toBe("unknown");
    expect(normalizeOrigin(null)).toBe("unknown");
    expect(normalizeOrigin(undefined)).toBe("unknown");
  });
});

describe("contract: Q3 — working/idle ∧ heartbeat not expired", () => {
  test("working with fresh heartbeat → q3", () => {
    expect(queueForSession(session({ state: "working" }), NOW).queue).toBe("q3");
  });
  test("idle with fresh heartbeat → q3", () => {
    expect(queueForSession(session({ state: "idle" }), NOW).queue).toBe("q3");
  });
  test(`heartbeat older than STALL_PROFILE_MS.narrow (${STALL_PROFILE_MS.narrow}ms) → NOT q3`, () => {
    const stale = session({ state: "working", last_heartbeat_at: NOW - STALL_PROFILE_MS.narrow - 1 });
    expect(queueForSession(stale, NOW).queue).toBeNull(); // limbo until recon confirms
  });
  test("fresh heartbeat exactly at the boundary is still fresh", () => {
    const edge = session({ state: "working", last_heartbeat_at: NOW - (STALL_PROFILE_MS.narrow - 1) });
    expect(queueForSession(edge, NOW).queue).toBe("q3");
  });
  test("terminal states never enter q3 regardless of heartbeat", () => {
    expect(queueForSession(session({ state: "done", last_heartbeat_at: NOW }), NOW).queue).toBe("q2");
  });
});

describe("contract: Q5 — four mutually exclusive reasons", () => {
  test("the frozen Q5Reason vocabulary is exactly the four reasons", () => {
    expect(FROZEN_Q5_REASONS.sort()).toEqual(
      ["stalled", "dead_incarnation", "telemetry_gap", "orphaned_request"].sort(),
    );
  });

  test("each single evidence source maps to its own reason", () => {
    const stale = { last_heartbeat_at: NOW - STALL_PROFILE_MS.narrow - 1 };
    expect(queueForSession(session(stale), NOW, { dead_incarnation: true }))
      .toEqual({ queue: "q5", q5_reason: "dead_incarnation" });
    expect(queueForSession(session(stale), NOW, { telemetry_gap: true }))
      .toEqual({ queue: "q5", q5_reason: "telemetry_gap" });
    expect(queueForSession(session(stale), NOW, { stalled: true }))
      .toEqual({ queue: "q5", q5_reason: "stalled" });
    expect(queueForRequest("orphaned")).toEqual({ queue: "q5", q5_reason: "orphaned_request" });
  });

  test("simultaneous evidence still yields EXACTLY ONE reason (dead > gap > stalled)", () => {
    const stale = { last_heartbeat_at: NOW - STALL_PROFILE_MS.narrow - 1 };
    const all = queueForSession(session(stale), NOW, {
      dead_incarnation: true,
      telemetry_gap: true,
      stalled: true,
    });
    expect(all.queue).toBe("q5");
    expect([all.q5_reason]).toEqual(["dead_incarnation"]);
    expect(FROZEN_Q5_REASONS).toContain(all.q5_reason!);

    const gapAndStall = queueForSession(session(stale), NOW, { telemetry_gap: true, stalled: true });
    expect(gapAndStall.q5_reason).toBe("telemetry_gap");
  });

  test("telemetry_gap is authoritative even while the heartbeat looks fresh (§2.3)", () => {
    const q = queueForSession(session({ last_heartbeat_at: NOW }), NOW, { telemetry_gap: true });
    expect(q).toEqual({ queue: "q5", q5_reason: "telemetry_gap" });
  });

  test("terminal states are sticky — recon evidence never moves done/vanished", () => {
    for (const state of ["done", "vanished"] as const) {
      const q = queueForSession(session({ state, origin: "human" }), NOW, {
        dead_incarnation: true,
        telemetry_gap: true,
        stalled: true,
      });
      expect(q.queue).not.toBe("q5");
    }
  });

  test("an unconfirmed heartbeat expiry records NOTHING (no guess without recon)", () => {
    expect(queueForSession(session({ last_heartbeat_at: NOW - 10 * STALL_PROFILE_MS.narrow }), NOW).queue).toBeNull();
  });
});

// ── journal-driven mini-reducer: transitions idempotency + watermark ──

type JRow = {
  ingest_seq?: number;
  at?: number;
  stable_id: string;
  writer_id?: string;
  emitter_id?: string;
  runtime?: string;
  kind: string;
  detail?: Record<string, unknown> | null;
};

function seedJournal(rows: JRow[]): void {
  let seq = 0;
  db.query("DELETE FROM journal").run();
  for (const r of rows) {
    seq += 1;
    db.query(
      `INSERT INTO journal(ingest_seq, host, emitter_id, seq, at, stable_id, writer_id, kind, detail)
       VALUES(?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      r.ingest_seq ?? seq,
      r.emitter_id ?? r.writer_id ?? "pi-1-aaaa0001",
      seq,
      r.at ?? NOW + seq,
      r.stable_id,
      r.writer_id ?? r.emitter_id ?? "pi-1-aaaa0001",
      r.kind,
      r.detail === undefined || r.detail === null ? null : JSON.stringify(r.detail),
    );
  }
}

const SID_A = "local:pi:aaaaaaaa-0000-4000-8000-00000000000a";
const SID_B = "local:pi:bbbbbbbb-0000-4000-8000-00000000000b";

function lifecycleStanza(stableId: string, emitter: string, extra: JRow[] = []): JRow[] {
  return [
    { stable_id: stableId, emitter_id: emitter, kind: "session_started", detail: { cwd: `/w/${stableId}` } },
    { stable_id: stableId, emitter_id: emitter, kind: "working" },
    { stable_id: stableId, emitter_id: emitter, kind: "heartbeat" },
    ...extra,
  ];
}

describe("contract: transitions idempotent on re-reduce (UNIQUE 5-tuple)", () => {
  test("re-running the same journal range inserts ZERO new transitions", () => {
    seedJournal([
      ...lifecycleStanza(SID_B, "pi-2-bbbb0002", [
        { stable_id: SID_B, emitter_id: "pi-2-bbbb0002", kind: "settled" },
        { stable_id: SID_B, emitter_id: "pi-2-bbbb0002", kind: "session_ended" },
      ]),
      ...lifecycleStanza(SID_A, "pi-1-aaaa0001", [
        { stable_id: SID_A, emitter_id: "pi-1-aaaa0001", kind: "decision_requested", detail: { request_id: "ask-1" } },
      ]),
    ]);
    const first = reduceClassifyPass(db, { now: NOW });
    expect(first.newTransitions).toBeGreaterThan(0);
    const count = () => (db.query("SELECT COUNT(*) AS n FROM queue_transitions").get() as { n: number }).n;
    const afterFirst = count();

    const second = reduceClassifyPass(db, { now: NOW });
    expect(second.newTransitions).toBe(0);
    expect(count()).toBe(afterFirst);

    // Replay NEVER clears derived tables (§2.4b): a third pass is also a no-op.
    reduceClassifyPass(db, { now: NOW });
    expect(count()).toBe(afterFirst);
  });

  test("recordTransition directly: identical 5-tuple inserts once, differs in any component insert again", () => {
    expect(recordTransition(db, { subject: "s", queue: "q1", direction: "entered", at: 1, source_seq: 1 })).toBe(true);
    expect(recordTransition(db, { subject: "s", queue: "q1", direction: "entered", at: 2, source_seq: 1 })).toBe(false);
    expect(recordTransition(db, { subject: "s", queue: "q1", direction: "left", at: 3, source_seq: 1 })).toBe(true);
    expect(recordTransition(db, { subject: "s", queue: "q2", direction: "entered", at: 4, source_seq: 1 })).toBe(true);
    expect(recordTransition(db, { subject: "s", queue: "q1", direction: "entered", at: 5, source_seq: 2 })).toBe(true);
    expect(recordTransition(db, { subject: "s", queue: "q1", direction: "entered", at: 6, source_seq: 2, classifier_version: 2 })).toBe(true);
  });
});

describe("contract: classifier_activations watermark respected", () => {
  test("activation is idempotent — repeated runs keep exactly one row per version", () => {
    expect(activateClassifier(db, { activated_at_journal_seq: 0, activated_at: NOW })).toBe(true);
    expect(activateClassifier(db, { activated_at_journal_seq: 0, activated_at: NOW + 5 })).toBe(false);
    const n = (db.query("SELECT COUNT(*) AS n FROM classifier_activations").get() as { n: number }).n;
    expect(n).toBe(1);
    expect(activationWatermark(db)).toBe(0);
  });

  test("activeVersionAt: rows at/below the watermark belong to the earlier version", () => {
    activateClassifier(db, { version: 1, activated_at_journal_seq: 10, activated_at: NOW });
    expect(activeVersionAt(db, 9)).toBe(0);
    expect(activeVersionAt(db, 10)).toBe(1);
    expect(activeVersionAt(db, 11)).toBe(1);
  });

  test("reduce pass classifies only journal rows AFTER the activation watermark", () => {
    seedJournal([
      ...lifecycleStanza(SID_B, "pi-2-bbbb0002", [
        { stable_id: SID_B, emitter_id: "pi-2-bbbb0002", kind: "session_ended" },
      ]),
      ...lifecycleStanza(SID_A, "pi-1-aaaa0001"),
    ]);
    // Rows 1..4 are SID_B's full lifecycle (ending session_ended), 5..7 SID_A.
    // Activate v1 at seq 4: SID_B predates the classifier → its rows are NOT
    // re-classified under v1 (no q2 entry), only rows 5..7 are processed.
    activateClassifier(db, { activated_at_journal_seq: 4, activated_at: NOW });
    const res = reduceClassifyPass(db, { now: NOW });
    expect(res.processed).toBe(3); // only rows 5..7
    const minSeq = (db.query("SELECT MIN(source_seq) AS m FROM queue_transitions").get() as { m: number | null }).m;
    expect(minSeq).toBeGreaterThan(4);
    // And SID_B (done, unknown origin) never entered q2 under v1.
    const q2 = (db.query(
      "SELECT COUNT(*) AS n FROM queue_transitions WHERE subject=? AND queue='q2'",
    ).get(SID_B) as { n: number }).n;
    expect(q2).toBe(0);
  });
});

describe("contract: emitter_drained orphaning (protocol 3)", () => {
  test("drained orphans ONLY that emitter's pending requests + writes the coverage gap tail", () => {
    const EM = "pi-3-cccc0003";
    seedJournal([
      ...lifecycleStanza(SID_A, EM, [
        { stable_id: SID_A, emitter_id: EM, kind: "decision_requested", detail: { request_id: "ask-9" } },
      ]),
      // A pending request from ANOTHER emitter must NOT be orphaned.
      ...lifecycleStanza(SID_B, "pi-4-dddd0004", [
        { stable_id: SID_B, emitter_id: "pi-4-dddd0004", kind: "decision_requested", detail: { request_id: "ask-other" } },
      ]),
      {
        stable_id: SID_A,
        emitter_id: "overload-99-99999999",
        runtime: "overload",
        kind: "emitter_drained",
        detail: { emitter_id: EM, stable_id: SID_A },
        at: NOW + 60_000,
      },
    ]);
    reduceClassifyPass(db, { now: NOW + 60_000 });

    const orphaned = db.query(
      "SELECT request_uid FROM requests WHERE state='orphaned'",
    ).all() as Array<{ request_uid: string }>;
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0]!.request_uid).toContain("#ask-9");

    // Q5 orphaned_request transition recorded, q1 left.
    const leftQ1 = (db.query(
      "SELECT COUNT(*) AS n FROM queue_transitions WHERE subject=? AND queue='q1' AND direction='left'",
    ).get(orphaned[0]!.request_uid) as { n: number }).n;
    expect(leftQ1).toBe(1);
    const enteredQ5 = (db.query(
      "SELECT COUNT(*) AS n FROM queue_transitions WHERE subject=? AND queue='q5' AND direction='entered'",
    ).get(orphaned[0]!.request_uid) as { n: number }).n;
    expect(enteredQ5).toBe(1);

    // coverage_gaps tail: [last ingested seq at, drained at].
    const gap = db.query(
      "SELECT * FROM coverage_gaps WHERE emitter_id=?",
    ).get(EM) as { stable_id: string; from_seq: number; to_at: number; reason: string } | undefined;
    expect(gap).toBeDefined();
    expect(gap!.from_seq).toBe(4); // emitter's own last journal seq (4 events)
    expect(gap!.to_at).toBe(NOW + 60_000);
    expect(gap!.reason).toBe("orphaned_request");
    // The other emitter's request is untouched.
    const other = db.query(
      "SELECT state FROM requests WHERE request_id='ask-other'",
    ).get() as { state: string };
    expect(other.state).toBe("pending");
  });
});

// ─── REAL LAYER (explicit SKIP until node/n5 lands) ─────────────────────────

test("entry inventory: which P2 implementation entries exist on this tree", () => {
  console.log(
    `[n8] real-layer entries: src/ingest/classifier.ts=${existsSync(N5_CLASSIFIER)} ` +
      `src/ingest/ingest.ts=${existsSync(N5_INGEST)} src/cli/overload.ts=${existsSync(N5_CLI)} ` +
      `(real-layer tests ${HAS_N5 ? "ACTIVE" : "SKIPPED until N5 merges"})`,
  );
  expect(true).toBe(true);
});

describe.skipIf(!HAS_N5)("real: N5 classifier via ingest --once + CLI surface", () => {
  let home: string;
  let ledgerPath: string;
  let spoolRoot: string;

  beforeEach(() => {
    home = makeTempDir(`n8-cls-real-${nextCounter()}`);
    spoolRoot = join(home, ".overload", "spool");
    ledgerPath = join(home, ".overload", "ledger.db");
  });
  afterEach(() => cleanupTempDir(home));

  function env(
    emitter: string,
    session: string,
    seq: number,
    kind: string,
    detail?: Record<string, unknown>,
    at = Date.now() - 30_000 + seq * 1000,
  ): EventEnvelope {
    return {
      v: 1,
      at,
      host: "local",
      runtime: "pi",
      session,
      emitter_id: emitter,
      writer_id: emitter,
      seq,
      kind,
      dropped_total: 0,
      write_error_total: 0,
      ...(detail ? { detail } : {}),
    } as EventEnvelope;
  }

  async function runIngest(): Promise<number> {
    const proc = Bun.spawn(["bun", N5_INGEST, "--once"], {
      cwd: REPO,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    return proc.exitCode;
  }

  async function runCli(sub: string): Promise<{ code: number; out: string }> {
    const proc = Bun.spawn(["bun", N5_CLI, sub], {
      cwd: REPO,
      env: { ...process.env, HOME: home, OVERLOAD_LEDGER_PATH: ledgerPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    return { code: proc.exitCode, out };
  }

  test("q1 from a pending request; q2 for done+unknown; initial row same-txn; idempotent re-reduce", async () => {
    const EM_A = "pi-7001-beef0001";
    const EM_B = "pi-7002-face0002";
    const SS_A = "11111111-0000-4000-8000-00000000000a";
    const SS_B = "22222222-0000-4000-8000-00000000000b";
    appendActive({ spoolRoot, host: "local", emitterId: EM_A }, 1, [
      env(EM_A, SS_A, 1, "session_started", { pid: 7001, proc_boot_id: "beef0001", cwd: join(home, "projA"), branch: "main", parent: "agent@ws1" }),
      env(EM_A, SS_A, 2, "working"),
      env(EM_A, SS_A, 3, "heartbeat"),
      env(EM_A, SS_A, 4, "decision_requested", { request_id: "ask-real-1", request_kind: "decision" }),
    ]);
    appendActive({ spoolRoot, host: "local", emitterId: EM_B }, 1, [
      env(EM_B, SS_B, 1, "session_started", { pid: 7002, proc_boot_id: "face0002", cwd: join(home, "projB"), branch: "main" }),
      env(EM_B, SS_B, 2, "working"),
      env(EM_B, SS_B, 3, "settled"),
      env(EM_B, SS_B, 4, "session_ended"),
    ]);

    expect(await runIngest()).toBe(0);

    const reqUid = `local:pi:${SS_A}#${EM_A}#ask-real-1`;
    const ldb = new Database(ledgerPath);
    try {
      // Q1 source of truth: the pending request.
      const req = ldb.query("SELECT state FROM requests WHERE request_uid=?").get(reqUid) as
        | { state: string }
        | undefined;
      expect(req?.state).toBe("pending");

      // Protocol 4 enqueue side: initial notification row exists, atomically.
      const initial = ldb.query(
        "SELECT kind, reminder_seq, state FROM notifications WHERE request_uid=? AND kind='initial'",
      ).all(reqUid) as Array<{ kind: string; reminder_seq: number; state: string }>;
      expect(initial).toHaveLength(1);
      expect(initial[0]!.reminder_seq).toBe(0);

      // Activation watermark: v1 exactly once.
      const acts = ldb.query("SELECT version FROM classifier_activations").all() as Array<{ version: number }>;
      expect(acts.filter((a) => a.version === 1)).toHaveLength(1);

      // done ∧ unknown origin → q2 transition recorded for session B.
      const q2 = ldb.query(
        "SELECT COUNT(*) AS n FROM queue_transitions WHERE subject=? AND queue='q2' AND direction='entered'",
      ).get(`local:pi:${SS_B}`) as { n: number };
      expect(q2.n).toBe(1);

      const transitionsAfterFirst = (ldb.query("SELECT COUNT(*) AS n FROM queue_transitions").get() as { n: number }).n;
      ldb.close();

      // Second pass with no new events: zero new transitions, one activation.
      expect(await runIngest()).toBe(0);
      const ldb2 = new Database(ledgerPath);
      expect((ldb2.query("SELECT COUNT(*) AS n FROM queue_transitions").get() as { n: number }).n)
        .toBe(transitionsAfterFirst);
      expect((ldb2.query("SELECT COUNT(*) AS n FROM classifier_activations").get() as { n: number }).n).toBe(1);

      // Re-reduce from scratch (replay): cursor reset, reprocess — UNIQUE
      // 5-tuple keeps transitions stable, derived tables never cleared.
      ldb2.query("UPDATE reducer_cursor SET journal_seq=0 WHERE id=1").run();
      ldb2.close();
      expect(await runIngest()).toBe(0);
      const ldb3 = new Database(ledgerPath);
      expect((ldb3.query("SELECT COUNT(*) AS n FROM queue_transitions").get() as { n: number }).n)
        .toBe(transitionsAfterFirst);
      expect((ldb3.query("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n).toBe(1);
      expect((ldb3.query("SELECT COUNT(*) AS n FROM notifications WHERE kind='initial'").get() as { n: number }).n).toBe(1);
      ldb3.close();
    } finally {
      try { ldb.close(); } catch { /* */ }
    }

    // CLI surface (protocol 8).
    const q1 = await runCli("q1");
    expect(q1.code).toBe(0);
    expect(q1.out).toContain(reqUid);
    const q2 = await runCli("q2");
    expect(q2.code).toBe(0);
    expect(q2.out).toContain(SS_B);
    for (const sub of ["zombie", "health"]) {
      const r = await runCli(sub);
      expect(r.code).toBe(0);
    }
  }, 60_000);
});

describe.skipIf(!HAS_N5)("real: frozen P2 DDL drift check on src/ingest/schema.sql", () => {
  test("every frozen P2 table/column/UNIQUE key is present verbatim", () => {
    const sql = readFileSync(join(REPO, "src/ingest/schema.sql"), "utf8");
    const norm = sql.replace(/\s+/g, " ");
    for (const [table, cols] of Object.entries(FROZEN_P2_TABLES)) {
      const re = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`, "i");
      expect(re.test(norm)).toBe(true);
      for (const col of cols) {
        const colRe = new RegExp(`\\b${col}\\b`);
        expect(colRe.test(norm)).toBe(true);
      }
    }
    for (const [table, uniques] of Object.entries(FROZEN_P2_UNIQUES)) {
      for (const u of uniques) {
        const compact = `UNIQUE(${u.join(",")})`.replace(/\s+/g, "");
        const compactAlt = `UNIQUE (${u.join(",")})`.replace(/\s+/g, "");
        expect(norm.replace(/\s+/g, "").includes(compact) || norm.replace(/\s+/g, "").includes(compactAlt))
          .toBe(true);
        void table;
      }
    }
  });
});
