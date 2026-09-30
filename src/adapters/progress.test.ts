import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureAdapterSchema } from "./store";
import {
 beginProgressCreate,
 canonicalJson,
 computeProgressView,
 ensureProgressRow,
 getProgress,
 listDueProgress,
 markProgressCreated,
 markProgressCreateFailed,
 markProgressDegraded,
 markProgressPatched,
 openRuntimeDecision,
 progressCreateAllowed,
 progressViewHash,
 projectProgress,
 recordProgressActivity,
 repairProgressOnStart,
 reprojectAll,
 safeToolName,
 type ProgressView,
} from "./progress";
import type { RuntimeEvent } from "./types";

const T0 = 1_700_000_000_000;
const ADDRESS = { instanceId: "feishu-main", tenantId: "t", chatId: "oc_1" };

function fixture(state = "running", reason: string | null = null) {
 const db = new Database(":memory:");
 db.exec("PRAGMA foreign_keys=ON");
 ensureAdapterSchema(db);
 db.run("INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES('c1','b',?,'o',?)", [
  JSON.stringify(ADDRESS),
  T0,
 ]);
 db.run("INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,reason,created_at) VALUES('t1','c1',1,'x',?,?,?)", [
  state,
  reason,
  T0,
 ]);
 return db;
}
const setTurn = (db: Database, state: string, reason: string | null = null) =>
 db.run("UPDATE conversation_turns SET state=?,reason=? WHERE id='t1'", [state, reason]);
let n = 0;
const tool = (kind: "tool_started" | "tool_finished", toolName = "bash"): RuntimeEvent => ({
 eventId: "e" + ++n,
 sessionId: "s",
 turnId: "t1",
 kind,
 toolName,
});
const ctx = (now: number, openDecision = false) => ({ now, openDecision });
const project = (db: Database, now: number, openDecision = false) => projectProgress(db, "t1", ctx(now, openDecision));

test("invariant 1: a turn gets one progress row however often it is ensured", () => {
 const db = fixture();
 ensureProgressRow(db, "t1", T0);
 ensureProgressRow(db, "t1", T0 + 5);
 expect((db.query("SELECT COUNT(*) n FROM channel_progress").get() as { n: number }).n).toBe(1);
 expect(() =>
  db.run("INSERT INTO channel_progress(turn_id,conversation_id,channel_instance_id,create_uuid,created_at,updated_at) VALUES('t1','c1','i','u',0,0)"),
 ).toThrow();
 expect(ensureProgressRow(db, "missing", T0)).toBeNull();
});

test("invariant 2: create_uuid is generated once and never changes", () => {
 const db = fixture();
 const first = ensureProgressRow(db, "t1", T0)!.create_uuid;
 recordProgressActivity(db, tool("tool_started"), T0 + 1);
 project(db, T0 + 2);
 ensureProgressRow(db, "t1", T0 + 3);
 expect(getProgress(db, "t1")!.create_uuid).toBe(first);
 expect(first.length).toBeGreaterThan(8);
});

test("invariant 3: desired_version only grows", () => {
 const db = fixture();
 const seen: number[] = [];
 project(db, T0);
 seen.push(getProgress(db, "t1")!.desired_version);
 recordProgressActivity(db, tool("tool_started"), T0 + 1000);
 project(db, T0 + 1000);
 seen.push(getProgress(db, "t1")!.desired_version);
 recordProgressActivity(db, tool("tool_finished"), T0 + 2000);
 project(db, T0 + 2000);
 seen.push(getProgress(db, "t1")!.desired_version);
 expect(seen).toEqual([1, 2, 3]);
 expect(() => db.run("UPDATE channel_progress SET desired_version=-1")).toThrow();
});

test("invariant 4: sent_version advances only on confirmed success, via CAS", () => {
 const db = fixture();
 project(db, T0);
 expect(getProgress(db, "t1")!.sent_version).toBe(0);
 expect(beginProgressCreate(db, "t1", T0)).toBe(true);
 expect(beginProgressCreate(db, "t1", T0)).toBe(false);
 expect(getProgress(db, "t1")!.sent_version).toBe(0);
 expect(markProgressPatched(db, "t1", 1, T0)).toBe(false); // not created yet
 expect(markProgressCreated(db, "t1", "om_1", 5, T0)).toBe(false); // beyond desired_version
 expect(markProgressCreated(db, "t1", "om_1", 1, T0)).toBe(true);
 expect(markProgressCreated(db, "t1", "om_2", 1, T0)).toBe(false); // second confirmation is a no-op
 const row = getProgress(db, "t1")!;
 expect([row.create_state, row.sent_version, row.message_id]).toEqual(["sent", 1, "om_1"]);
 // a failed create never advances it
 const db2 = fixture();
 project(db2, T0);
 beginProgressCreate(db2, "t1", T0);
 markProgressCreateFailed(db2, "t1", "failed", "boom", T0);
 expect(getProgress(db2, "t1")!.sent_version).toBe(0);
 // PATCH: stale version is rejected, sent_version never goes backwards
 recordProgressActivity(db, tool("tool_started"), T0 + 1000);
 project(db, T0 + 1000);
 expect(markProgressPatched(db, "t1", 2, T0 + 1000)).toBe(true);
 expect(markProgressPatched(db, "t1", 1, T0 + 1000)).toBe(false);
 expect(getProgress(db, "t1")!.sent_version).toBe(2);
 expect(getProgress(db, "t1")!.patch_count).toBe(1);
});

test("invariant 5: an unchanged view does not bump desired_version", () => {
 const db = fixture();
 expect(project(db, T0)).toEqual({ changed: true, version: 1 });
 expect(project(db, T0 + 1)).toEqual({ changed: false, version: 1 });
 expect(project(db, T0 + 2)).toEqual({ changed: false, version: 1 });
 // same tool re-reported within the same activity bucket still changes only when the view text does
 recordProgressActivity(db, tool("tool_started"), T0 + 1000);
 expect(project(db, T0 + 1000).changed).toBe(true);
 expect(project(db, T0 + 1000).changed).toBe(false);
 expect(getProgress(db, "t1")!.desired_version).toBe(2);
});

test("invariant 5: hash is independent of key order", () => {
 const a: ProgressView = { state: "running", title: "t", summary: "s", activeTool: null, completedTools: 1, lastActivityAt: 5, terminal: false };
 const b = JSON.parse(
  '{"terminal":false,"lastActivityAt":5,"completedTools":1,"activeTool":null,"summary":"s","title":"t","state":"running"}',
 ) as ProgressView;
 expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
 expect(canonicalJson(a)).toBe(canonicalJson(b));
 expect(progressViewHash(a)).toBe(progressViewHash(b));
 expect(canonicalJson({ z: { b: 1, a: [{ y: 1, x: 2 }] }, a: undefined })).toBe('{"z":{"a":[{"x":2,"y":1}],"b":1}}');
 expect(progressViewHash({ ...a, completedTools: 2 })).not.toBe(progressViewHash(a));
});

test("invariant 6: degraded rows stop advancing and are never due", () => {
 const db = fixture();
 project(db, T0 + 20_000);
 expect(listDueProgress(db, T0 + 20_000).map((r) => r.turn_id)).toEqual(["t1"]);
 expect(markProgressDegraded(db, "t1", "patch_budget", T0)).toBe(true);
 recordProgressActivity(db, tool("tool_started"), T0 + 21_000);
 expect(project(db, T0 + 21_000)).toEqual({ changed: false, version: 1 });
 setTurn(db, "completed");
 expect(project(db, T0 + 22_000)).toEqual({ changed: false, version: 1 });
 expect(listDueProgress(db, T0 + 22_000)).toEqual([]);
 expect(beginProgressCreate(db, "t1", T0)).toBe(false);
 expect(markProgressPatched(db, "t1", 1, T0)).toBe(false);
});

test("invariant 7: a late tool event cannot revive a final view", () => {
 const db = fixture();
 recordProgressActivity(db, tool("tool_started"), T0 + 1000);
 project(db, T0 + 1000);
 setTurn(db, "completed");
 project(db, T0 + 2000);
 const final = getProgress(db, "t1")!;
 expect(final.view_state).toBe("completed");
 expect(recordProgressActivity(db, tool("tool_finished"), T0 + 3000)).toBe(false);
 expect(recordProgressActivity(db, tool("tool_started"), T0 + 3000)).toBe(false);
 project(db, T0 + 3000);
 const after = getProgress(db, "t1")!;
 expect(after.view_state).toBe("completed");
 expect(after.completed_tool_count).toBe(final.completed_tool_count);
 expect(after.desired_version).toBe(final.desired_version);
 expect(JSON.parse(after.desired_view_json!).terminal).toBe(true);
});

test("invariant 7: a late event is ignored even before the terminal view is projected", () => {
 const db = fixture();
 recordProgressActivity(db, tool("tool_started"), T0 + 1000);
 setTurn(db, "failed");
 expect(recordProgressActivity(db, tool("tool_finished"), T0 + 2000)).toBe(false);
 project(db, T0 + 2000);
 expect(getProgress(db, "t1")!.view_state).toBe("failed");
});

test("invariant 8: sending becomes unknown on start and is never re-created", () => {
 const db = fixture();
 project(db, T0 + 20_000);
 const uuid = getProgress(db, "t1")!.create_uuid;
 expect(beginProgressCreate(db, "t1", T0 + 20_000)).toBe(true);
 expect(repairProgressOnStart(db, T0 + 30_000)).toBe(1);
 const row = getProgress(db, "t1")!;
 expect([row.create_state, row.reason, row.create_uuid]).toEqual(["unknown", "create_receipt_lost", uuid]);
 expect(repairProgressOnStart(db, T0 + 31_000)).toBe(0);
 expect(beginProgressCreate(db, "t1", T0 + 31_000)).toBe(false);
 expect(listDueProgress(db, T0 + 31_000)).toEqual([]);
 expect(markProgressCreated(db, "t1", "om_x", 1, T0)).toBe(false);
});

test("§7.1 queued: no card before 10s, one after, none when silent or already final", () => {
 const db = fixture("queued");
 const view = computeProgressView(ensureProgressRow(db, "t1", T0)!, { state: "queued", reason: null, created_at: T0 }, ctx(T0 + 1));
 expect(view.state).toBe("queued");
 expect(view.summary).toBe("正在等待前序任务");
 expect(view.summary).not.toMatch(/\d/); // no invented queue position
 const q = { state: "queued", created_at: T0 };
 expect(progressCreateAllowed(q, T0 + 9_999, false)).toBe(false);
 expect(progressCreateAllowed(q, T0 + 10_000, false)).toBe(true);
 expect(progressCreateAllowed(q, T0 + 10_000, true)).toBe(false);
 expect(progressCreateAllowed({ state: "completed", created_at: T0 }, T0 + 60_000, false)).toBe(false);
 project(db, T0 + 1);
 expect(listDueProgress(db, T0 + 9_999)).toEqual([]);
 expect(listDueProgress(db, T0 + 10_000).length).toBe(1);
 expect(listDueProgress(db, T0 + 10_000, () => true)).toEqual([]);
 setTurn(db, "completed");
 project(db, T0 + 5_000);
 expect(listDueProgress(db, T0 + 60_000)).toEqual([]);
});

test("§7.2 running: safe tool name and finished count; no text_delta", () => {
 const db = fixture();
 recordProgressActivity(db, tool("tool_started", "bash"), T0 + 1000);
 project(db, T0 + 1000);
 let view = JSON.parse(getProgress(db, "t1")!.desired_view_json!) as ProgressView;
 expect(view).toMatchObject({ state: "running", activeTool: "bash", completedTools: 0 });
 recordProgressActivity(db, tool("tool_finished", "bash"), T0 + 2000);
 recordProgressActivity(db, tool("tool_started", "/etc/passwd; rm -rf"), T0 + 3000);
 project(db, T0 + 3000);
 view = JSON.parse(getProgress(db, "t1")!.desired_view_json!);
 expect(view).toMatchObject({ activeTool: "tool", completedTools: 1, lastActivityAt: T0 + 3000 });
 expect(view.summary).toContain("已完成 1 个工具");
 const output = { eventId: "o", sessionId: "s", turnId: "t1", kind: "output", text: "SECRET-DELTA" } as const;
 expect(recordProgressActivity(db, output, T0 + 4000)).toBe(false);
 expect(JSON.stringify(getProgress(db, "t1"))).not.toContain("SECRET-DELTA");
 expect([safeToolName("read"), safeToolName("Bash"), safeToolName(""), safeToolName(undefined), safeToolName("a".repeat(40))]).toEqual(["read", "tool", "tool", "tool", "tool"]);
});

test("§7.3 waiting_decision: blocked + open decision; no decision fields on the view", () => {
 const db = fixture("blocked");
 db.run("INSERT INTO runtime_decisions(item_id,conversation_id,turn_id,request_id) VALUES('i1','c1','t1','r1')");
 expect(openRuntimeDecision(db, "t1")).toBe(true);
 project(db, T0 + 1000, openRuntimeDecision(db, "t1"));
 const view = JSON.parse(getProgress(db, "t1")!.desired_view_json!) as ProgressView;
 expect(view.state).toBe("waiting_decision");
 expect(view.summary).toBe("等待你在下方决策卡中处理");
 expect(Object.keys(view).sort()).toEqual(["activeTool", "completedTools", "lastActivityAt", "state", "summary", "terminal", "title"]);
 expect(getProgress(db, "t1")!.message_id).toBeNull(); // never borrows a decision card message id
 // blocked without an open decision is not waiting_decision
 db.run("UPDATE runtime_decisions SET dispatch_state='accepted'");
 expect(computeProgressView(getProgress(db, "t1")!, { state: "blocked", reason: null, created_at: T0 }, ctx(T0 + 1000, openRuntimeDecision(db, "t1"))).state).toBe("running");
});

test("§7.4 stale: 120s without activity, 30s buckets, tool named", () => {
 const db = fixture();
 recordProgressActivity(db, tool("tool_started", "bash"), T0);
 const row = () => getProgress(db, "t1")!;
 const turn = { state: "running", reason: null, created_at: T0 };
 expect(computeProgressView(row(), turn, ctx(T0 + 119_999)).state).toBe("running");
 const stale = computeProgressView(row(), turn, ctx(T0 + 120_000));
 expect(stale.state).toBe("stale");
 expect(stale.terminal).toBe(false);
 expect(stale.summary).toContain("超过 2 分钟没有新活动，任务可能卡住；可取消或稍后查看。");
 expect(stale.summary).toContain("工具 bash 尚未结束");
 // running-view text only changes per 30s bucket, so projection is idempotent inside one
 project(db, T0 + 1_000);
 const v = row().desired_version;
 project(db, T0 + 29_000);
 expect(row().desired_version).toBe(v);
 project(db, T0 + 31_000);
 expect(row().desired_version).toBe(v + 1);
 project(db, T0 + 125_000);
 expect(JSON.parse(row().desired_view_json!).state).toBe("stale");
 // new activity pulls it back
 recordProgressActivity(db, tool("tool_finished", "bash"), T0 + 126_000);
 project(db, T0 + 126_000);
 expect(JSON.parse(row().desired_view_json!).state).toBe("running");
});

test("§7.5 terminal authority map", () => {
 const cases: [string, string | null, string, boolean][] = [
  ["completed", null, "completed", false],
  ["failed", "x", "failed", false],
  ["unknown", null, "unknown", false],
  ["unknown", "owner_lost_before_receipt", "unknown", false],
  ["unknown", "cancelled_effects_unconfirmed", "cancelled", true],
 ];
 for (const [state, reason, expected, effects] of cases) {
  const db = fixture(state, reason);
  project(db, T0 + 1000);
  const row = getProgress(db, "t1")!;
  const view = JSON.parse(row.desired_view_json!) as ProgressView;
  expect([view.state, view.terminal, row.view_state]).toEqual([expected, true, expected]);
  expect(view.summary.includes("副作用未确认")).toBe(effects);
 }
 const db = fixture("cancelling", "operator_cancel_requested");
 const view = computeProgressView(ensureProgressRow(db, "t1", T0)!, { state: "cancelling", reason: "operator_cancel_requested", created_at: T0 }, ctx(T0 + 1000));
 expect(view.terminal).toBe(false);
});

test("stage C gate: desired view is recomputed identically from the database after a restart", () => {
 const path = `/tmp/progress-${crypto.randomUUID()}.db`;
 const a = new Database(path);
 a.exec("PRAGMA foreign_keys=ON");
 ensureAdapterSchema(a);
 a.run("INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES('c1','b',?,'o',?)", [JSON.stringify(ADDRESS), T0]);
 for (const [id, state, reason] of [["t1", "running", null], ["t2", "completed", null], ["t3", "unknown", "cancelled_effects_unconfirmed"], ["t4", "queued", null]] as const)
  a.run("INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,reason,created_at) VALUES(?,'c1',?,'x',?,?,?)", [id, Number(id.slice(1)), state, reason, T0]);
 recordProgressActivity(a, tool("tool_started"), T0 + 500);
 recordProgressActivity(a, tool("tool_finished"), T0 + 900);
 for (const id of ["t1", "t2", "t3", "t4"]) projectProgress(a, id, ctx(T0 + 1000));
 const snapshot = () => a.query("SELECT turn_id,desired_version,desired_hash,desired_view_json,create_uuid FROM channel_progress ORDER BY turn_id").all();
 const before = snapshot();
 a.close();
 const b = new Database(path);
 b.exec("PRAGMA foreign_keys=ON");
 ensureAdapterSchema(b);
 expect(repairProgressOnStart(b, T0 + 2000)).toBe(0);
 expect(reprojectAll(b, T0 + 1000, () => false)).toBe(0); // nothing drifted
 expect(b.query("SELECT turn_id,desired_version,desired_hash,desired_view_json,create_uuid FROM channel_progress ORDER BY turn_id").all()).toEqual(before);
 // and a row whose desired view was lost is rebuilt to the same view
 const t1 = JSON.parse((before[0] as { desired_view_json: string }).desired_view_json);
 b.run("UPDATE channel_progress SET desired_hash=NULL,desired_view_json=NULL WHERE turn_id='t1'");
 reprojectAll(b, T0 + 1000, () => false);
 expect(JSON.parse(getProgress(b, "t1")!.desired_view_json!)).toEqual(t1);
 b.close();
});

test("computeProgressView is pure: same inputs give same output and mutate nothing", () => {
 const db = fixture();
 recordProgressActivity(db, tool("tool_started"), T0 + 100);
 const row = getProgress(db, "t1")!;
 const turn = { state: "running", reason: null, created_at: T0 };
 const frozenRow = JSON.stringify(row);
 const frozenTurn = JSON.stringify(turn);
 const first = computeProgressView(row, turn, ctx(T0 + 5000));
 const second = computeProgressView(row, turn, ctx(T0 + 5000));
 expect(canonicalJson(second)).toBe(canonicalJson(first));
 expect(JSON.stringify(row)).toBe(frozenRow);
 expect(JSON.stringify(turn)).toBe(frozenTurn);
 expect(db.query("SELECT COUNT(*) n FROM channel_progress WHERE desired_version>0").get()).toEqual({ n: 0 });
});
