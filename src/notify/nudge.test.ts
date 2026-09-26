import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWork, openControl, promoteWork, upsertAttention } from "../control/store";
import type { NotificationDelivery, NotificationEnvironment, NotificationPolicy, NotificationSender } from "./nudge";
import { collectNotificationCandidates, nudgeOnce, notificationCapability, runNotificationCycle } from "./nudge";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overload-notify-")); roots.push(root);
  const control = openControl(join(root, "control.db"));
  // Notification tests tolerate a pre-v6 store while the v6 migration lands concurrently.
  control.exec(`CREATE TABLE IF NOT EXISTS control_attention_material(item_id TEXT PRIMARY KEY,material_key TEXT NOT NULL,fingerprint TEXT NOT NULL,generation INTEGER NOT NULL,inputs TEXT NOT NULL,computed_at INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS control_attention_material_key ON control_attention_material(material_key);
    CREATE TABLE IF NOT EXISTS control_notifications(notification_id TEXT PRIMARY KEY,subject TEXT NOT NULL,material_key TEXT NOT NULL,threshold TEXT NOT NULL,channel TEXT NOT NULL,outcome TEXT NOT NULL,owner_epoch TEXT NOT NULL,work_id TEXT,item_id TEXT,item_revision INTEGER,approval_id TEXT,receipt_id TEXT,outbox_event_id TEXT,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,reason TEXT NOT NULL,attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER,error TEXT,created_at INTEGER NOT NULL,attempted_at INTEGER,completed_at INTEGER,UNIQUE(subject,material_key,threshold,owner_epoch));
    CREATE TABLE IF NOT EXISTS control_notification_shadow(comparison_id TEXT PRIMARY KEY,subject TEXT NOT NULL,material_key TEXT NOT NULL,threshold TEXT NOT NULL,legacy_would_send INTEGER NOT NULL,candidate_would_send INTEGER NOT NULL,legacy_reason TEXT NOT NULL,candidate_reason TEXT NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,item_id TEXT,item_revision INTEGER,compared_at INTEGER NOT NULL,UNIQUE(subject,material_key,threshold));`);
  const ledger = new Database(":memory:");
  ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
    CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
    CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
    CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);`);
  return { control, ledger };
}

function attention(control: Database, id: string, now: number, material: string, generation = 1, expiresAt: number | null = null) {
  const work = createWork(control, { title: id, source: "test", source_id: id, candidate: true }, now);
  const active = promoteWork(control, work.work_id, work.revision, { objective: "decide", acceptance: [{ id: "a", kind: "check", description: "checked" }], non_goals: ["none"], scope: { cwd: "/tmp" }, budget: {}, stop_conditions: [], decision_owner: "owner" }, "test activation", now);
  const item = upsertAttention(control, { item_id: id, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now", conclusion: "Choose", trigger: "risk", impact: "impact", recommendation: "approve", options: ["approve", "stop"], owner: "owner", expires_at: expiresAt, source_link: null, approval_id: null, consumer_owner: null, contract_revision: active.revision, decision_mode: "human_only", evidence: { decisive: "fact" } }, now);
  control.query("INSERT OR REPLACE INTO control_attention_material VALUES (?,?,?,?,?,?)").run(id, `attention:${id}:${material}`, material, generation, "{}", now);
  return item;
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
    const first = attention(control, "i1", now, "fp-one"); const sender = new Sender();
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now })).sent).toBe(1);
    upsertAttention(control, { ...first, expected_revision: first.revision, conclusion: "Same decision, rephrased" }, now + 1);
    expect((await runNotificationCycle({ ledger, control, policy: policy(), sender, now: now + 1 })).claimed).toBe(0);
    expect(sender.calls).toHaveLength(1);
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

  test("A17 shadow compares without sending; legacy Q1/hung and Attention share the owner claim table", async () => {
    const { control, ledger } = fixture(); const now = 1_700_000_000_000; attention(control, "i1", now, "fp-one");
    ledger.query("INSERT INTO sessions VALUES (?,?)").run("s1", "local");
    ledger.query("INSERT INTO requests VALUES (?,?,?,?,?,?)").run("r1", "s1", "decision", "pending", now, "{}");
    ledger.query("INSERT INTO current VALUES (?,?,?,?,?)").run("s2", "turn_hung", "working", now - 1000, now);
    const sender = new Sender();
    const projected = collectNotificationCandidates(ledger, control, now);
    expect(projected.map((candidate) => candidate.subject).sort()).toEqual(["attention:i1", "hung:s2", "q1:r1"]);
    const shadow = await runNotificationCycle({ ledger, control, policy: policy("shadow", "shadow-v1"), sender, now });
    expect(shadow).toMatchObject({ sent: 0, shadowed: 3 }); expect(sender.calls).toHaveLength(0);
    expect(control.query("SELECT count(*) count FROM control_notification_shadow").get()).toEqual({ count: 3 });
    const send = await runNotificationCycle({ ledger, control, policy: policy("send", "cutover-v2"), sender, now: now + 1 });
    expect(send).toMatchObject({ claimed: 3, sent: 3 }); expect(sender.calls).toHaveLength(1);
    const feishuSender = { channel: "feishu" as const, send: async () => ({ outcome: "sent" as const }) };
    await expect(runNotificationCycle({ ledger, control, policy: { ...policy("send", "cutover-v2"), primary_channel: "macos" }, sender: feishuSender, now: now + 2 })).rejects.toThrow("not primary");
    control.close(); ledger.close();
  });
});

describe("nudgeOnce compatibility and cutover policy", () => {
  test("default shadow records comparison while legacy newline sender remains sole sender", async () => {
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
      CREATE TABLE current(stable_id TEXT PRIMARY KEY,q5_reason TEXT,state TEXT,last_progress_at INTEGER,last_event_at INTEGER);
      INSERT INTO sessions VALUES ('s1','local');
      INSERT INTO requests VALUES ('r1','s1','decision','pending',1700000000000,'{}');`);
    fileLedger.close();
    const sent: string[] = [];
    const deps = {
      ledgerPath,
      controlPath: join(root, "control.db"),
      statePath: join(root, "nudge.state"),
      notify: async (message: string) => { sent.push(message); },
      env: {} satisfies NotificationEnvironment,
    };
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: true });
    expect(await nudgeOnce(deps)).toEqual({ count: 1, notified: false });
    expect(sent).toHaveLength(1);
    const recorded = openControl(deps.controlPath);
    expect(recorded.query("SELECT outcome,owner_epoch,attempt_count FROM control_notifications").all()).toEqual([
      { outcome: "shadowed", owner_epoch: "phase-a-shadow-1", attempt_count: 0 },
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

  test("macOS send cutover disables legacy newline state and sends once through durable claims", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-notify-macos-cutover-")); roots.push(root);
    const ledgerPath = join(root, "ledger.db");
    const ledger = new Database(ledgerPath);
    ledger.exec(`CREATE TABLE requests(request_uid TEXT PRIMARY KEY,stable_id TEXT,kind TEXT,state TEXT,created_at INTEGER,detail TEXT);
      CREATE TABLE sessions(stable_id TEXT PRIMARY KEY,host TEXT);
      CREATE TABLE session_hosts(stable_id TEXT,session_id TEXT,app TEXT);
      CREATE TABLE attachments(stable_id TEXT,binding TEXT,platform TEXT,valid INTEGER,observed_at INTEGER);
      CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY,stable_id TEXT,kind TEXT,detail TEXT);
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
