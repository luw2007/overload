import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, ensureControlSchema, openControl, upsertAttention } from "../control/store";
import { runNotificationCycle } from "./nudge";
import type { NotificationPolicy, NotificationSender } from "./nudge";
import { inspectNotificationShadow } from "./shadow-report";
import type { Contract } from "../control/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const contract: Contract = {
  objective: "ship",
  acceptance: [{ id: "check", kind: "check", description: "tests" }],
  non_goals: [],
  scope: { allowed_effects: ["write"] },
  budget: {},
  stop_conditions: [],
  decision_owner: "owner",
};

const shadowPolicy: NotificationPolicy = {
  mode: "shadow", primary_channel: "macos", owner_epoch: "phase-a-shadow-1", expires_soon_ms: 900_000, max_attempts: 3,
};
const refusingSender: NotificationSender = {
  channel: "macos",
  send: async () => { throw new Error("shadow mode must not send"); },
};

function control() {
  const d = new Database(":memory:");
  ensureControlSchema(d);
  return d;
}

function ledgerWithQ1(requestUid?: string) {
  const ledger = new Database(":memory:");
  ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
    CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
    CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
    CREATE VIEW journal_all AS SELECT * FROM journal;
    CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);`);
  if (requestUid) {
    ledger.query("INSERT INTO sessions VALUES ('s1','local')").run();
    ledger.query("INSERT INTO requests VALUES (?,'s1','decision','pending',?,'{}')").run(requestUid, 1_700_000_000_000);
  }
  return ledger;
}

function urgent(db: Database, itemId: string, now: number, expiresAt: number | null = null) {
  const work = createWork(db, { title: itemId, source: "test", source_id: itemId, contract }, now);
  return upsertAttention(db, {
    item_id: itemId, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now",
    conclusion: "Choose", trigger: "risk", impact: "impact", recommendation: null, options: ["continue"],
    owner: "owner", expires_at: expiresAt, source_link: null, approval_id: null, consumer_owner: null,
    contract_revision: work.revision, decision_mode: "human_only", evidence: {},
  }, now);
}

function shadowRow(db: Database, row: {
  id: string; subject: string; threshold: string; legacy: 0 | 1; candidate: 0 | 1;
  sourceKind: string; sourceId: string; at: number;
}): void {
  db.query(`INSERT INTO control_notification_shadow(comparison_id,subject,material_key,threshold,legacy_would_send,
    candidate_would_send,legacy_reason,candidate_reason,source_kind,source_id,item_id,item_revision,compared_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.subject, `${row.subject}:key`, row.threshold, row.legacy, row.candidate,
      "legacy", "candidate", row.sourceKind, row.sourceId, null, null, row.at,
    );
}

describe("notification shadow inspection", () => {
  test("reads what a real shadow cycle wrote: no findings, one visible Attention coverage gap", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-shadow-report-")); roots.push(root);
    const db = openControl(join(root, "control.db"));
    const ledger = ledgerWithQ1("r1");
    const now = 1_700_000_000_000;
    urgent(db, "native", now);

    expect(await runNotificationCycle({ ledger, control: db, policy: shadowPolicy, sender: refusingSender, now }))
      .toMatchObject({ sent: 0, shadowed: 2 });

    const inspection = inspectNotificationShadow(db);
    expect(inspection.compared).toBe(2);
    expect(inspection.false_negatives).toEqual([]);
    expect(inspection.duplicates).toEqual([]);
    expect(inspection.unlinked_attention).toEqual([
      { subject: "attention:native", threshold: "new_now", source_id: "native", item_id: "native", item_revision: 1, compared_at: now },
    ]);
    db.close(); ledger.close();
  });

  test("distinct thresholds for one source are reported as a duplicate group with their thresholds", async () => {
    const db = control();
    const ledger = ledgerWithQ1();
    const now = 1_700_000_000_000;
    urgent(db, "expiring", now, now + 600_000);

    await runNotificationCycle({ ledger, control: db, policy: shadowPolicy, sender: refusingSender, now });

    const inspection = inspectNotificationShadow(db);
    expect(inspection.compared).toBe(2);
    // §4.4 expects one source to cross several thresholds; the thresholds are returned so the
    // operator can separate that from a source genuinely covered twice.
    expect(inspection.duplicates).toEqual([
      { source_kind: "attention", source_id: "expiring", rows: 2, thresholds: ["expires_soon", "new_now"], subjects: ["attention:expiring"] },
    ]);
    expect(inspection.false_negatives).toEqual([]);
    db.close(); ledger.close();
  });

  test("a legacy-covered comparison the candidate would drop is reported as a false negative", () => {
    const db = control();
    // runNotificationCycle only writes a comparison row for a candidate that exists, so it always
    // records candidate_would_send=1; this is the shape the signal looks for if that ever changes.
    shadowRow(db, { id: "c1", subject: "q1:dropped", threshold: "new_now", legacy: 1, candidate: 0, sourceKind: "legacy_q1", sourceId: "dropped", at: 10 });
    shadowRow(db, { id: "c2", subject: "q1:kept", threshold: "new_now", legacy: 1, candidate: 1, sourceKind: "legacy_q1", sourceId: "kept", at: 11 });

    const inspection = inspectNotificationShadow(db);
    expect(inspection.compared).toBe(2);
    expect(inspection.false_negatives).toEqual([{
      subject: "q1:dropped", material_key: "q1:dropped:key", threshold: "new_now", source_kind: "legacy_q1",
      source_id: "dropped", legacy_reason: "legacy", candidate_reason: "candidate", compared_at: 10,
    }]);
    expect(inspection.duplicates).toEqual([]);
    expect(inspection.unlinked_attention).toEqual([]);
    db.close();
  });

  test("the same source under two subjects is reported as a duplicate group", () => {
    const db = control();
    shadowRow(db, { id: "c1", subject: "q1:twice", threshold: "new_now", legacy: 1, candidate: 1, sourceKind: "legacy_q1", sourceId: "twice", at: 10 });
    shadowRow(db, { id: "c2", subject: "hung:twice", threshold: "new_now", legacy: 1, candidate: 1, sourceKind: "legacy_q1", sourceId: "twice", at: 11 });

    expect(inspectNotificationShadow(db).duplicates).toEqual([
      { source_kind: "legacy_q1", source_id: "twice", rows: 2, thresholds: ["new_now", "new_now"], subjects: ["q1:twice", "hung:twice"] },
    ]);
    db.close();
  });

  test("an empty shadow table inspects clean", () => {
    const db = control();
    expect(inspectNotificationShadow(db)).toEqual({ compared: 0, false_negatives: [], duplicates: [], unlinked_attention: [] });
    db.close();
  });
});
