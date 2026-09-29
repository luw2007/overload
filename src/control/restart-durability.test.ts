// A15: the durable half of "版本不回退、凭据不重复消费、通知去重与预算保留" — everything that is only true if the
// state survives a process restart. Contract §5 invariant 8 ("a restart must not reset notification budgets") and
// §7 A15 name one restart/replay/out-of-order SQLite test; the receipt-uniqueness clause is already covered by
// src/decision-bot/mailbox-concurrency.test.ts, so this file carries the three clauses that were not:
//
//   1. notification claim and budget survive a close/reopen of control.db,
//   2. an older Attention revision never regresses applyControlEvent — file-backed and out-of-order,
//   3. Attention CAS keeps rejecting a pre-restart revision after a reopen.
//
// Every database here is file-backed and actually closed and reopened; an in-process handle proves nothing about
// restart. The ledger handle is deliberately kept open across the control reopen in the notification tests: what
// is under test is control.db's durability, not the ledger's.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeLedger } from "../ingest/ingest";
import type { NotificationDelivery, NotificationPolicy, NotificationSender } from "../notify/nudge";
import { runNotificationCycle } from "../notify/nudge";
import { controlPayloadHash } from "./outbox";
import { applyControlEvent } from "./projection";
import {
  ControlError,
  actOnAttention,
  createWork,
  getAttention,
  getAttentionMaterial,
  openControl,
  promoteWork,
  resolveAttention,
  upsertAttention,
} from "./store";
import type { AttentionItem, Contract } from "./types";

const NOW = 1_700_000_000_000;

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "overload-restart-")); roots.push(dir);
  return dir;
}

const contract: Contract = {
  objective: "decide",
  acceptance: [{ id: "a", kind: "check", description: "checked" }],
  non_goals: ["none"],
  scope: { cwd: "/tmp" },
  budget: {},
  stop_conditions: [],
  decision_owner: "owner",
};

/** A minimal ledger with the tables the notification collector reads; none of them hold candidates here. */
function emptyLedger(): Database {
  const ledger = new Database(":memory:");
  ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
    CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
    CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
    CREATE VIEW journal_all AS SELECT * FROM journal;
    CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);`);
  return ledger;
}

/** One urgent Attention card on an active Work — a `new_now` notification candidate. */
function urgentAttention(control: Database, id: string, now: number): AttentionItem {
  const work = createWork(control, { title: id, source: "test", source_id: id, candidate: true }, now);
  const active = promoteWork(control, work.work_id, work.revision, contract, "test activation", now);
  return upsertAttention(control, {
    item_id: id, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now",
    conclusion: "Choose", trigger: "risk", impact: "impact", recommendation: "approve",
    options: ["continue", "stop"], owner: "owner", expires_at: null, source_link: null, approval_id: null,
    consumer_owner: null, contract_revision: active.revision, decision_mode: "human_only",
    evidence: { decisive: "fact" },
  }, now);
}

class Sender implements NotificationSender {
  readonly channel = "macos" as const;
  calls: string[][] = [];
  constructor(private readonly deliveries: NotificationDelivery[] = []) {}
  async send(candidates: readonly { subject: string }[]) {
    this.calls.push(candidates.map((candidate) => candidate.subject));
    return this.deliveries.shift() ?? { outcome: "sent" as const };
  }
}

const policy = (owner_epoch = "owner-v1", max_attempts = 3): NotificationPolicy =>
  ({ mode: "send", primary_channel: "macos", owner_epoch, expires_soon_ms: 900_000, max_attempts });

function notifications(control: Database): Array<Record<string, unknown>> {
  return control.query("SELECT subject,threshold,owner_epoch,outcome,attempt_count,next_attempt_at FROM control_notifications ORDER BY created_at,threshold").all() as Array<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------------------------------------------
// 1. Notification uniqueness and budget across a restart.

test("A15 a sent notification claim survives a restart and is not re-sent under the same owner epoch", async () => {
  const dir = root();
  const path = join(dir, "control.db");
  const ledger = emptyLedger();
  let control = openControl(path);
  const sender = new Sender();

  urgentAttention(control, "restart-once", NOW);
  expect(await runNotificationCycle({ ledger, control, policy: policy(), sender, now: NOW })).toMatchObject({ claimed: 1, sent: 1 });
  const before = notifications(control);
  expect(before).toEqual([{ subject: "attention:restart-once", threshold: "new_now", owner_epoch: "owner-v1", outcome: "sent", attempt_count: 1, next_attempt_at: null }]);

  // Restart: the control database is closed and reopened from disk.
  control.close();
  control = openControl(path);

  expect(await runNotificationCycle({ ledger, control, policy: policy(), sender, now: NOW + 60_000 })).toMatchObject({ claimed: 0, sent: 0 });
  expect(sender.calls).toEqual([["attention:restart-once"]]); // the sender was not called a second time
  // The claim row is the same one, not a duplicate, and its attempt budget was not rewound to zero.
  expect(notifications(control)).toEqual(before);
  control.close(); ledger.close();
});

test("A15 an exhausted notification retry budget is not reset by a restart", async () => {
  const dir = root();
  const path = join(dir, "control.db");
  const ledger = emptyLedger();
  let control = openControl(path);
  // Two attempts allowed, three failures queued: if a restart rewound the budget the third would go out.
  const sender = new Sender([
    { outcome: "failed", error: "offline" },
    { outcome: "failed", error: "still offline" },
    { outcome: "failed", error: "must never be reached" },
  ]);

  urgentAttention(control, "restart-budget", NOW);
  expect(await runNotificationCycle({ ledger, control, policy: policy("owner-v1", 2), sender, now: NOW })).toMatchObject({ claimed: 1, failed: 1 });
  expect(control.query("SELECT outcome,attempt_count FROM control_notifications").get()).toMatchObject({ outcome: "failed", attempt_count: 1 });

  control.close();
  control = openControl(path);

  // The retry that the surviving next_attempt_at allows is attempt 2 — the last one the budget covers.
  expect(await runNotificationCycle({ ledger, control, policy: policy("owner-v1", 2), sender, now: NOW + 60_000 })).toMatchObject({ claimed: 1, failed: 1 });
  expect(control.query("SELECT outcome,attempt_count,error,next_attempt_at FROM control_notifications").get())
    .toMatchObject({ outcome: "failed", attempt_count: 2, error: "still offline", next_attempt_at: null });

  control.close();
  control = openControl(path);

  // After a second restart the budget is still spent: no claim, no third send, still exactly one row.
  expect(await runNotificationCycle({ ledger, control, policy: policy("owner-v1", 2), sender, now: NOW + 3_600_000 })).toMatchObject({ claimed: 0, failed: 0 });
  expect(sender.calls).toHaveLength(2);
  expect(notifications(control)).toEqual([{ subject: "attention:restart-budget", threshold: "new_now", owner_epoch: "owner-v1", outcome: "failed", attempt_count: 2, next_attempt_at: null }]);
  control.close(); ledger.close();
});

// ---------------------------------------------------------------------------------------------------------------
// 2. Non-regressing Attention projection, file-backed and out of order.

function attentionEvent(revision: number, overrides: Partial<AttentionItem> = {}, eventId = `event-${revision}`): Record<string, unknown> {
  const attention = {
    item_id: "ooo", work_id: "w", revision, state: "open", effect_state: "not_started", urgency: "inbox",
    conclusion: `conclusion at revision ${revision}`, trigger: "t", impact: "i", recommendation: null,
    options: [], owner: "owner", expires_at: null, defer_until: null, acknowledged_at: null, source_link: null,
    approval_id: null, consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {},
    created_at: 1, updated_at: revision, ...overrides,
  };
  const payload = { attention };
  // Distinct event_id per revision: the dedup table must not be what stops the older one from applying.
  return { event_id: eventId, payload_hash: controlPayloadHash(payload), payload };
}

function projected(ledger: Database): Record<string, unknown> | null {
  return ledger.query("SELECT revision,conclusion,event_id FROM control_attention WHERE item_id='ooo'").get() as Record<string, unknown> | null;
}

test("A15 an older Attention revision never regresses the projection, out of order and across a restart", () => {
  const dir = root();
  const path = join(dir, "ledger.db");
  let ledger = new Database(path);
  initializeLedger(ledger);

  // Out of order within one process: revision 2 arrives first, revision 1 after it.
  applyControlEvent(ledger, attentionEvent(2), 10);
  applyControlEvent(ledger, attentionEvent(1), 11);
  expect(projected(ledger)).toEqual({ revision: 2, conclusion: "conclusion at revision 2", event_id: "event-2" });
  // The late event is still recorded as applied, so it is never retried as a stuck delivery.
  expect(ledger.query("SELECT event_id FROM applied_control_events ORDER BY event_id").all()).toEqual([{ event_id: "event-1" }, { event_id: "event-2" }]);

  // Restart: close and reopen the ledger file.
  ledger.close();
  ledger = new Database(path);
  initializeLedger(ledger);

  // An event the restarted process has never seen before (new event_id, so dedup cannot be what saves us),
  // carrying a revision older than what is already on disk.
  applyControlEvent(ledger, attentionEvent(1, { conclusion: "replayed after restart", updated_at: 99 }, "event-1-redelivered"), 12);
  expect(projected(ledger)).toEqual({ revision: 2, conclusion: "conclusion at revision 2", event_id: "event-2" });
  // Forward motion still works after the restart.
  applyControlEvent(ledger, attentionEvent(3), 13);
  expect(projected(ledger)).toEqual({ revision: 3, conclusion: "conclusion at revision 3", event_id: "event-3" });
  ledger.close();
});

// ---------------------------------------------------------------------------------------------------------------
// 3. Attention CAS across a restart.

test("A15 Attention CAS still rejects a pre-restart revision after control.db is reopened", () => {
  const dir = root();
  const path = join(dir, "control.db");
  let control = openControl(path);

  const item = urgentAttention(control, "cas-restart", NOW);
  const preRestartRevision = item.revision;
  const acked = actOnAttention(control, item.item_id, preRestartRevision, "ack", {}, "owner", NOW + 1_000);
  expect(acked.revision).toBe(preRestartRevision + 1);

  control.close();
  control = openControl(path);

  const fingerprint = getAttentionMaterial(control, item.item_id)!.fingerprint;
  expect(getAttention(control, item.item_id)).toMatchObject({ revision: acked.revision, state: "open" });

  // The revision the caller was holding before the restart is stale, and the restart did not amnesty it.
  // Presentation actions refuse it as a plain conflict...
  let staleAct: unknown;
  try {
    actOnAttention(control, item.item_id, preRestartRevision, "defer", { defer_until: NOW + 100_000 }, "owner", NOW + 2_000);
  } catch (error) { staleAct = error; }
  expect(staleAct).toBeInstanceOf(ControlError);
  expect(staleAct).toMatchObject({ code: "conflict", message: "stale attention revision" });
  expect(getAttention(control, item.item_id)).toMatchObject({ revision: acked.revision, defer_until: null });

  // ...and the decision path refuses it as stale_attention, carrying the post-restart state the caller must re-read.
  let staleResolve: unknown;
  try {
    resolveAttention(control, item.item_id, { attention_revision: preRestartRevision, material_fingerprint: fingerprint, selected_option: "continue" }, "owner", NOW + 3_000);
  } catch (error) { staleResolve = error; }
  expect(staleResolve).toBeInstanceOf(ControlError);
  expect((staleResolve as ControlError).details).toMatchObject({
    code: "stale_attention", expected_revision: preRestartRevision, current_revision: acked.revision, current_state: "open",
  });
  expect(getAttention(control, item.item_id)).toMatchObject({ revision: acked.revision, state: "open" });

  // The post-restart revision, with the fingerprint that also survived the restart, is accepted.
  expect(resolveAttention(control, item.item_id, { attention_revision: acked.revision, material_fingerprint: fingerprint, selected_option: "continue" }, "owner", NOW + 4_000))
    .toMatchObject({ item_id: item.item_id, state: "resolved" });
  control.close();
});
