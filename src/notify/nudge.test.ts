import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, openControl, promoteWork, resolveAttentionDecision, upsertAttention } from "../control/store";
import type { NotificationDelivery, NotificationEnvironment, NotificationPolicy, NotificationSender } from "./nudge";
import { collectNotificationCandidates, nudgeOnce, notificationCapability, runNotificationCycle } from "./nudge";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overload-notify-")); roots.push(root);
  const control = openControl(join(root, "control.db"));
  const ledger = new Database(":memory:");
  ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
    CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
    CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
    CREATE VIEW journal_all AS SELECT * FROM journal;
    CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);`);
  return { control, ledger };
}

function attention(control: Database, id: string, now: number, material?: string, generation = 1, expiresAt: number | null = null, identity: { approvalId?: string; requestUid?: string; stableId?: string } = {}) {
  const work = createWork(control, { title: id, source: "test", source_id: id, candidate: true }, now);
  const active = promoteWork(control, work.work_id, work.revision, { objective: "decide", acceptance: [{ id: "a", kind: "check", description: "checked" }], non_goals: ["none"], scope: { cwd: "/tmp" }, budget: {}, stop_conditions: [], decision_owner: "owner" }, "test activation", now);
  const item = upsertAttention(control, { item_id: id, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now", conclusion: "Choose", trigger: "risk", impact: "impact", recommendation: "approve", options: ["approve", "stop"], owner: "owner", expires_at: expiresAt, source_link: null, approval_id: identity.approvalId ?? null, consumer_owner: identity.approvalId ? "extension" : null, contract_revision: active.revision, decision_mode: "human_only", evidence: { decisive: "fact", ...(identity.requestUid || identity.stableId ? { notification_bindings: { ...(identity.requestUid ? { request_uid: identity.requestUid } : {}), ...(identity.stableId ? { stable_id: identity.stableId } : {}) } } : {}) } }, now);
  if (material !== undefined || generation !== 1) {
    const fingerprint = material ?? `generation-${generation}`;
    control.query("UPDATE control_attention_material SET material_key=?,fingerprint=?,generation=? WHERE item_id=?")
      .run(`attention:${id}:${fingerprint}`, fingerprint, generation, id);
  }
  return item;
}

function pendingQ1(ledger: Database, requestUid: string, stableId: string, detail: Record<string, unknown> = {}): void {
  ledger.query("INSERT OR IGNORE INTO sessions VALUES (?,?)").run(stableId, "local");
  ledger.query("INSERT INTO requests VALUES (?,?,?,'pending',?,?)").run(requestUid, stableId, "decision", 1_700_000_000_000, JSON.stringify(detail));
}

let journalId = 0;
function hung(ledger: Database, stableId: string, detail: Record<string, unknown> = {}): void {
  ledger.query("INSERT OR IGNORE INTO sessions VALUES (?,?)").run(stableId, "local");
  ledger.query("INSERT INTO current VALUES (?,'turn_hung','working',?,?)").run(stableId, 1_699_999_000_000, 1_699_999_000_000);
  ledger.query("INSERT INTO journal VALUES (?,?,'turn_hung',?)").run(++journalId, stableId, JSON.stringify({ stable_id: stableId, ...detail }));
}

class Sender implements NotificationSender {
  readonly channel = "macos" as const;
  calls: string[][] = [];
  constructor(private readonly deliveries: NotificationDelivery[] = [{ outcome: "sent" }]) {}
  async send(candidates: readonly { subject: string }[]) {
    this.calls.push(candidates.map((candidate) => candidate.subject));
    return this.deliveries.shift() ?? { outcome: "sent" as const };
  }
}
const policy = (mode: "shadow" | "send" = "send", owner_epoch = "owner-v1", max_attempts = 3): NotificationPolicy => ({ mode, primary_channel: "macos", owner_epoch, expires_soon_ms: 900_000, max_attempts });

describe("notificationCapability", () => {
  test("reports actual supported and unsupported platforms", () => {
    expect(notificationCapability("darwin")).toEqual({ available: true, platform: "darwin", reason: null });
    expect(notificationCapability("linux")).toEqual({ available: false, platform: "linux", reason: "macOS notifications unavailable on this platform" });
  });
});

describe("notification projection and durable claims", () => {
  test("A01/A03 uses material identity, not attention revision or prose", async () => {
    const { control, ledger } = fixture(); const now = 1_700_000_000_000;
    const first = attention(control, "i1", now); const sender = new Sender();
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now })).sent).toBe(1);
    upsertAttention(control, { ...first, expected_revision: first.revision, trigger: "Same trigger, rephrased", evidence: { heartbeat: 2 } }, now + 1);
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 1 })).claimed).toBe(0);
    expect(sender.calls).toHaveLength(1);
    control.close(); ledger.close();
  });

  test("urgent Attention is a new_now candidate without a decision-package fetch", () => {
    const { control, ledger } = fixture();
    const now = 1_700_000_000_000;
    const item = attention(control, "native", now);
    expect(control.query("SELECT generation FROM control_attention_material WHERE item_id=?").get(item.item_id)).toEqual({ generation: 1 });
    expect(collectNotificationCandidates(ledger, control, now, 900_000)).toContainEqual(expect.objectContaining({
      subject: "attention:native",
      item_id: "native",
      threshold: "new_now",
    }));
    control.close(); ledger.close();
  });

  test("A02 aggregates a genuinely new Now item without requiring Now to drain", async () => {
    const { control, ledger } = fixture(); const now = 1_700_000_000_000; const sender = new Sender();
    attention(control, "old", now, "fp-old");
    await runNotificationCycle({ ledger, control, policy: policy(), sender, now });
    attention(control, "new", now + 1, "fp-new");
    const result = await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 1 });
    expect(result).toMatchObject({ claimed: 1, sent: 1 });
    expect(sender.calls[1]).toEqual(["attention:new"]);
    control.close(); ledger.close();
  });

  test("A04 claims material and expiry thresholds once", async () => {
    const { control, ledger } = fixture(); const now = 1_700_000_000_000; const sender = new Sender();
    attention(control, "i1", now, "fp-one", 1, now + 600_000);
    await runNotificationCycle({ ledger, control, policy: policy(), sender, now });
    expect(control.query("SELECT threshold FROM control_notifications ORDER BY threshold").all()).toEqual([{ threshold: "expires_soon" }, { threshold: "new_now" }]);
    control.query("UPDATE control_attention_material SET material_key=?,fingerprint=?,generation=2 WHERE item_id='i1'").run("attention:i1:fp-two", "fp-two");
    await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 700_000 });
    expect(control.query("SELECT threshold FROM control_notifications ORDER BY created_at,threshold").all()).toEqual([{ threshold: "expires_soon" }, { threshold: "new_now" }, { threshold: "expired" }, { threshold: "material_change" }]);
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 800_000 })).claimed).toBe(0);
    control.close(); ledger.close();
  });

  test("A04 a real risk change through upsertAttention claims material_change exactly once", async () => {
    const { control, ledger } = fixture(); const now = 1_700_000_000_000; const sender = new Sender();
    // No hand-written material row: the fingerprint here is the one the store derives from the card.
    const item = attention(control, "risk", now);
    const material = () => control.query("SELECT material_key,generation FROM control_attention_material WHERE item_id='risk'")
      .get() as { material_key: string; generation: number };
    const first = material();
    expect(first.generation).toBe(1);
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now })).sent).toBe(1);

    const changed = upsertAttention(control, { ...item, expected_revision: item.revision, impact: "data loss is now certain" }, now + 1);
    const second = material();
    expect(second.generation).toBe(2);
    expect(second.material_key).not.toBe(first.material_key);

    expect(await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 2 })).toMatchObject({ claimed: 1, sent: 1 });
    expect(control.query("SELECT threshold,material_key,item_revision FROM control_notifications WHERE subject='attention:risk' ORDER BY created_at").all()).toEqual([
      { threshold: "new_now", material_key: first.material_key, item_revision: item.revision },
      { threshold: "material_change", material_key: second.material_key, item_revision: changed.revision },
    ]);
    // The same changed basis must not interrupt a second time.
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 3 })).claimed).toBe(0);
    expect(sender.calls).toEqual([["attention:risk"], ["attention:risk"]]);
    control.close(); ledger.close();
  });

  test("A14 an ordinary completion claims nothing further", async () => {
    const { control, ledger } = fixture(); const now = 1_700_000_000_000; const sender = new Sender();
    const item = attention(control, "completed", now, "fp-completed");
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now })).sent).toBe(1);

    const resolved = resolveAttentionDecision(control, item.item_id, item.revision, { selected_option: "stop" }, now + 1, "owner");
    expect(resolved).toMatchObject({ state: "resolved", effect_state: "succeeded" });

    expect(await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 2 })).toMatchObject({ claimed: 0, sent: 0 });
    expect(control.query("SELECT threshold FROM control_notifications WHERE subject='attention:completed'").all()).toEqual([{ threshold: "new_now" }]);
    expect(sender.calls).toHaveLength(1);
    control.close(); ledger.close();
  });

  test("A16 persists bounded failures and never blindly retries unknown delivery", async () => {
    const { control, ledger } = fixture(); const now = 1_700_000_000_000;
    attention(control, "failed", now, "fp-failed");
    const failed = new Sender([{ outcome: "failed", error: "offline" }, { outcome: "failed", error: "still offline" }]);
    await runNotificationCycle({ ledger, control, policy: policy("send", "owner-v1", 2), sender: failed, now });
    expect((await runNotificationCycle({ ledger, control, policy: policy("send", "owner-v1", 2), sender: failed, now: now + 60_000 })).failed).toBe(1);
    expect((await runNotificationCycle({ ledger, control, policy: policy("send", "owner-v1", 2), sender: failed, now: now + 1_000_000 })).claimed).toBe(0);
    expect(control.query("SELECT outcome,attempt_count,error,next_attempt_at FROM control_notifications").get()).toMatchObject({ outcome: "failed", attempt_count: 2, error: "still offline", next_attempt_at: null });
    attention(control, "unknown", now, "fp-unknown");
    const unknown = new Sender([{ outcome: "unknown", error: "receipt lost" }]);
    await runNotificationCycle({ ledger, control, policy: policy(), sender: unknown, now });
    await runNotificationCycle({ ledger, control, policy: policy(), sender: unknown, now: now + 9_000_000 });
    expect(unknown.calls).toHaveLength(1);
    expect(control.query("SELECT outcome,attempt_count FROM control_notifications WHERE item_id='unknown'").get()).toEqual({ outcome: "unknown", attempt_count: 1 });
    control.close(); ledger.close();
  });
  test("A17 converges exact native and legacy identities while preserving unrelated sources", async () => {
    const { control, ledger } = fixture();
    const now = 1_700_000_000_000;
    const approvalId = "stable#writer#tool";
    attention(control, "native", now, "fp-native", 1, null, { approvalId });
    pendingQ1(ledger, approvalId, "session-linked", { approval_id: approvalId });
    pendingQ1(ledger, "unrelated", "session-unrelated", { approval_id: "other-approval" });
    hung(ledger, "hung-linked", { approval_id: approvalId });
    hung(ledger, "hung-unrelated", { approval_id: "different-approval" });

    const projected = collectNotificationCandidates(ledger, control, now);
    expect(projected.map(({ subject }) => subject).sort()).toEqual([
      "attention:native",
      "hung:hung-unrelated",
      "q1:unrelated",
    ]);
    const sender = new Sender();
    expect(await runNotificationCycle({ ledger, control, policy: policy("send", "cutover-linked"), sender, now })).toMatchObject({ claimed: 3, sent: 3 });
    expect(sender.calls).toEqual([["attention:native", "q1:unrelated", "hung:hung-unrelated"]]);
    expect(control.query("SELECT source_kind,approval_id FROM control_notifications WHERE subject='attention:native'").get()).toEqual({ source_kind: "attention", approval_id: approvalId });
    control.close(); ledger.close();
  });

  test("A17 does not infer correlation from request, session, or prose without an authoritative binding", () => {
    const { control, ledger } = fixture();
    const now = 1_700_000_000_000;
    attention(control, "native", now, "fp-native", 1, null, { approvalId: "native-approval" });
    pendingQ1(ledger, "same-looking-request", "same-looking-session", { request_id: "same-looking-request", summary: "Choose" });
    hung(ledger, "same-looking-session", { request_id: "same-looking-request", summary: "Choose" });
    expect(collectNotificationCandidates(ledger, control, now).map(({ subject }) => subject).sort()).toEqual([
      "attention:native",
      "hung:same-looking-session",
      "q1:same-looking-request",
    ]);
    control.close(); ledger.close();
  });

  test("A17 uses the registered approval target request/session binding without parsing IDs", () => {
    const { control, ledger } = fixture();
    const now = 1_700_000_000_000;
    attention(control, "bound", now, "fp-bound", 1, null, { approvalId: "opaque-approval" });
    control.exec(`CREATE TABLE approval_targets(
      consumer_owner TEXT NOT NULL, approval_id TEXT NOT NULL, request_uid TEXT, stable_id TEXT,
      PRIMARY KEY(consumer_owner, approval_id)
    )`);
    control.query("INSERT INTO approval_targets VALUES ('extension','opaque-approval','ledger-request','ledger-session')").run();
    pendingQ1(ledger, "ledger-request", "q1-session");
    hung(ledger, "ledger-session");
    expect(collectNotificationCandidates(ledger, control, now).map(({ subject }) => subject)).toEqual(["attention:bound"]);
    control.close(); ledger.close();
  });

  test("ack is seen-only: it neither suppresses new_now nor a later material_change", async () => {
    const { control, ledger } = fixture();
    const now = 1_700_000_000_000;
    const item = attention(control, "acknowledged", now, "fp-one");
    control.query("UPDATE control_attention SET acknowledged_at=? WHERE item_id=?").run(now + 1, item.item_id);
    const sender = new Sender();
    expect(await runNotificationCycle({ ledger, control, policy: policy("send", "ack-seen-only"), sender, now: now + 2 })).toMatchObject({ claimed: 1, sent: 1 });
    control.query("UPDATE control_attention_material SET material_key=?,fingerprint=?,generation=2 WHERE item_id=?")
      .run("attention:acknowledged:fp-two", "fp-two", item.item_id);
    expect(await runNotificationCycle({ ledger, control, policy: policy("send", "ack-seen-only"), sender, now: now + 3 })).toMatchObject({ claimed: 1, sent: 1 });
    expect(control.query("SELECT threshold FROM control_notifications WHERE item_id=? ORDER BY created_at").all(item.item_id)).toEqual([
      { threshold: "new_now" },
      { threshold: "material_change" },
    ]);
    control.close(); ledger.close();
  });


  test("A17 shadow compares without sending; legacy Q1/hung and Attention share the owner claim table", async () => {
    const { control, ledger } = fixture();
    const now = 1_700_000_000_000;
    attention(control, "i1", now, "fp-one");
    pendingQ1(ledger, "r1", "s1");
    hung(ledger, "s2");
    const sender = new Sender();
    const projected = collectNotificationCandidates(ledger, control, now);
    expect(projected.map((candidate) => candidate.subject).sort()).toEqual(["attention:i1", "hung:s2", "q1:r1"]);
    const shadow = await runNotificationCycle({ ledger, control, policy: policy("shadow", "shadow-v1"), sender, now });
    expect(shadow).toMatchObject({ sent: 0, shadowed: 3 });
    expect(sender.calls).toHaveLength(0);
    expect(control.query("SELECT count(*) count FROM control_notification_shadow").get()).toEqual({ count: 3 });
    const send = await runNotificationCycle({ ledger, control, policy: policy("send", "cutover-v2"), sender, now: now + 1 });
    expect(send).toMatchObject({ claimed: 3, sent: 3 });
    expect(sender.calls).toHaveLength(1);
    const feishuSender = { channel: "feishu" as const, send: async () => ({ outcome: "sent" as const }) };
    await expect(runNotificationCycle({ ledger, control, policy: { ...policy("send", "cutover-v2"), primary_channel: "macos" }, sender: feishuSender, now: now + 2 })).rejects.toThrow("not primary");
    control.close(); ledger.close();
  });

  test("A17 a second primary channel cannot re-claim what the first already sent in the same epoch", async () => {
    const { control, ledger } = fixture();
    const now = 1_700_000_000_000;
    attention(control, "shared", now, "fp-shared");
    const macos = new Sender();
    expect(await runNotificationCycle({ ledger, control, policy: policy("send", "shared-epoch"), sender: macos, now })).toMatchObject({ claimed: 1, sent: 1 });

    // Same owner epoch, other primary channel: channel is not part of the claim identity, so the
    // durable row already written by macOS must leave nothing for Feishu to claim.
    const feishuCalls: string[][] = [];
    const feishu: NotificationSender = {
      channel: "feishu",
      send: async (candidates) => { feishuCalls.push(candidates.map(({ subject }) => subject)); return { outcome: "sent" }; },
    };
    const second = await runNotificationCycle({
      ledger, control, policy: { ...policy("send", "shared-epoch"), primary_channel: "feishu" }, sender: feishu, now: now + 1,
    });

    expect(second).toMatchObject({ claimed: 0, sent: 0 });
    expect(feishuCalls).toEqual([]);
    expect(macos.calls).toEqual([["attention:shared"]]);
    expect(control.query("SELECT channel,outcome,attempt_count FROM control_notifications WHERE subject='attention:shared'").all())
      .toEqual([{ channel: "macos", outcome: "sent", attempt_count: 1 }]);
    control.close(); ledger.close();
  });
});

describe("nudgeOnce compatibility and cutover policy", () => {
  test("default shadow keeps legacy as sole sender and records linked native coverage", async () => {
    const { control, ledger } = fixture();
    const root = roots.at(-1)!;
    attention(control, "shadow-linked", 1_700_000_000_000, "fp-shadow", 1, null, { approvalId: "r1" });
    ledger.close();
    control.close();
    const ledgerPath = join(root, "ledger.db");
    const fileLedger = new Database(ledgerPath);
    fileLedger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
      CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
      CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
      CREATE VIEW journal_all AS SELECT * FROM journal;
      CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);
      INSERT INTO sessions VALUES ('s1','local');
      INSERT INTO requests VALUES ('r1','s1','decision','pending',1700000000000,'{"approval_id":"r1"}');`);
    fileLedger.close();
    const sent: string[] = [];
    const deps = { ledgerPath, controlPath: join(root, "control.db"), statePath: join(root, "nudge.state"), notify: async (message: string) => { sent.push(message); }, env: {} satisfies NotificationEnvironment };
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: true });
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: false });
    expect(sent).toHaveLength(1);
    const recorded = openControl(deps.controlPath);
    expect(recorded.query("SELECT outcome,owner_epoch,attempt_count,subject FROM control_notifications").all()).toEqual([
      { outcome: "shadowed", owner_epoch: "phase-a-shadow-1", attempt_count: 0, subject: "attention:shadow-linked" },
    ]);
    expect(recorded.query("SELECT legacy_would_send,candidate_would_send FROM control_notification_shadow").get()).toEqual({ legacy_would_send: 1, candidate_would_send: 1 });
    recorded.close();
  });

  test("default shadow records an unlinked coverage gap while legacy remains sole sender", async () => {
    const { control, ledger } = fixture();
    ledger.close();
    control.close();
    const root = roots.at(-1)!;
    const ledgerPath = join(root, "ledger.db");
    const fileLedger = new Database(ledgerPath);
    fileLedger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
      CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
      CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
      CREATE VIEW journal_all AS SELECT * FROM journal;
      CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);
      INSERT INTO sessions VALUES ('s1','local');
      INSERT INTO requests VALUES ('r1','s1','decision','pending',1700000000000,'{}');`);
    fileLedger.close();
    const sent: string[] = [];
    const deps = { ledgerPath, controlPath: join(root, "control.db"), statePath: join(root, "nudge.state"), notify: async (message: string) => { sent.push(message); }, env: {} satisfies NotificationEnvironment };
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: true });
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: false });
    expect(sent).toHaveLength(1);
    const recorded = openControl(deps.controlPath);
    expect(recorded.query("SELECT outcome,owner_epoch,attempt_count,subject FROM control_notifications").all()).toEqual([
      { outcome: "shadowed", owner_epoch: "phase-a-shadow-1", attempt_count: 0, subject: "q1:r1" },
    ]);
    recorded.close();
  });

  test("shadow recorder failure cannot suppress or duplicate the legacy sender", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-notify-shadow-failure-")); roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const ledger = new Database(ledgerPath);
    ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
      CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
      CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
      CREATE VIEW journal_all AS SELECT * FROM journal;
      CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);
      INSERT INTO sessions VALUES ('s1','local');
      INSERT INTO requests VALUES ('r1','s1','decision','pending',1700000000000,'{}');`);
    ledger.close();
    const sent: string[] = [];
    const previousError = console.error;
    console.error = () => {};
    try {
      const result = await nudgeOnce({
        ledgerPath,
        controlPath: join(root, "control.db"),
        statePath: join(root, "nudge.state"),
        notify: async (message) => { sent.push(message); },
        env: { OVERLOAD_NOTIFICATION_EXPIRES_SOON_MS: "invalid" },
      });
      expect(result).toEqual({ count: 1, notified: true });
      expect(sent).toHaveLength(1);
    } finally {
      console.error = previousError;
    }
  });

  test("wrapper honors configured owner, primary, epoch, expiry window, and attempt budget", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-notify-config-")); roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const ledger = new Database(ledgerPath);
    ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
      CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
      CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
      CREATE VIEW journal_all AS SELECT * FROM journal;
      CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);
      INSERT INTO sessions VALUES ('s1','local');
      INSERT INTO requests VALUES ('r1','s1','decision','pending',1700000000000,'{}');`);
    ledger.close();
    const controlPath = join(root, "control.db");
    const configuredControl = openControl(controlPath);
    const now = Date.now();
    attention(configuredControl, "expires-later", now, "fp-expires", 1, now + 10_000);
    configuredControl.close();
    const sent: string[][] = [];
    const sender: NotificationSender = {
      channel: "feishu",
      send: async (candidates) => { sent.push(candidates.map(({ subject }) => subject)); return { outcome: "failed", error: "offline" }; },
    };
    const env: NotificationEnvironment = {
      OVERLOAD_NOTIFICATION_MODE: "send",
      OVERLOAD_NOTIFICATION_PRIMARY: "feishu",
      OVERLOAD_NOTIFICATION_OWNER: "maintenance",
      OVERLOAD_NOTIFICATION_OWNER_EPOCH: "cutover-config-v1",
      OVERLOAD_NOTIFICATION_EXPIRES_SOON_MS: "9999",
      OVERLOAD_NOTIFICATION_MAX_ATTEMPTS: "1",
    };
    const deps = { ledgerPath, controlPath, statePath: join(root, "nudge.state"), notify: async () => { throw new Error("legacy sender ran during cutover"); }, sender, env };
    expect(await nudgeOnce({ ...deps, cycleOwner: "not-maintenance" })).toEqual({ count: 1, notified: false });
    expect(sent).toHaveLength(0);
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: false });
    expect(sent).toEqual([["attention:expires-later", "attention:expires-later", "q1:r1"]]);
    const recorded = openControl(controlPath);
    expect(recorded.query("SELECT channel,owner_epoch,outcome,attempt_count,next_attempt_at,threshold FROM control_notifications ORDER BY threshold").all()).toEqual([
      { channel: "feishu", owner_epoch: "cutover-config-v1", outcome: "failed", attempt_count: 1, next_attempt_at: null, threshold: "expires_soon" },
      { channel: "feishu", owner_epoch: "cutover-config-v1", outcome: "failed", attempt_count: 1, next_attempt_at: null, threshold: "new_now" },
      { channel: "feishu", owner_epoch: "cutover-config-v1", outcome: "failed", attempt_count: 1, next_attempt_at: null, threshold: "new_now" },
    ]);
    recorded.close();
  });

  test("send cutover delivers a correlated native/Q1 source once", async () => {
    const { control, ledger } = fixture();
    const root = roots.at(-1)!;
    attention(control, "cutover-linked", 1_700_000_000_000, "fp-cutover", 1, null, { approvalId: "r-linked" });
    ledger.close();
    control.close();
    const ledgerPath = join(root, "ledger.db");
    const fileLedger = new Database(ledgerPath);
    fileLedger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
      CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
      CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
      CREATE VIEW journal_all AS SELECT * FROM journal;
      CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);
      INSERT INTO sessions VALUES ('s-linked','local');
      INSERT INTO requests VALUES ('r-linked','s-linked','decision','pending',1700000000000,'{"approval_id":"r-linked"}');`);
    fileLedger.close();
    const sent: string[] = [];
    const deps = {
      ledgerPath,
      controlPath: join(root, "control.db"),
      statePath: join(root, "nudge.state"),
      notify: async (message: string) => { sent.push(message); },
      env: {
        OVERLOAD_NOTIFICATION_MODE: "send",
        OVERLOAD_NOTIFICATION_PRIMARY: "macos",
        OVERLOAD_NOTIFICATION_OWNER: "maintenance",
        OVERLOAD_NOTIFICATION_OWNER_EPOCH: "linked-cutover-v1",
      } satisfies NotificationEnvironment,
    };
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: true });
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: false });
    expect(sent).toHaveLength(1);
    const recorded = openControl(deps.controlPath);
    expect(recorded.query("SELECT subject,source_kind,outcome FROM control_notifications").all()).toEqual([
      { subject: "attention:cutover-linked", source_kind: "attention", outcome: "sent" },
    ]);
    recorded.close();
  });

  test("macOS send cutover disables legacy newline state and sends once through durable claims", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-notify-macos-cutover-")); roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const ledger = new Database(ledgerPath);
    ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
      CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
      CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
      CREATE VIEW journal_all AS SELECT * FROM journal;
      CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);
      INSERT INTO sessions VALUES ('s1','local');
      INSERT INTO requests VALUES ('r1','s1','decision','pending',1700000000000,'{}');`);
    ledger.close();
    const sent: string[] = [];
    const statePath = join(root, "nudge.state");
    const deps = {
      ledgerPath,
      controlPath: join(root, "control.db"),
      statePath,
      notify: async (message: string) => { sent.push(message); },
      env: {
        OVERLOAD_NOTIFICATION_MODE: "send",
        OVERLOAD_NOTIFICATION_PRIMARY: "macos",
        OVERLOAD_NOTIFICATION_OWNER: "maintenance",
        OVERLOAD_NOTIFICATION_OWNER_EPOCH: "macos-cutover-v1",
      } satisfies NotificationEnvironment,
    };
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: true });
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: false });
    expect(sent).toHaveLength(1);
    expect(() => readFileSync(statePath, "utf8")).toThrow();
  });
});
