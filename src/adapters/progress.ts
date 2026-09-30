import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import type { ChannelAddress, RuntimeEvent } from "./types";

// Progress store and pure projection (fast-channel §5.3/§6/§7). Nothing here talks to Feishu: it
// computes the desired view from persisted rows and records it. Sending is stage D.

export type ProgressViewState =
 | "queued"
 | "running"
 | "waiting_decision"
 | "stale"
 | "completed"
 | "failed"
 | "cancelled"
 | "unknown";
export type ProgressView = {
 state: ProgressViewState;
 title: string;
 summary: string;
 activeTool: string | null;
 completedTools: number;
 lastActivityAt: number | null;
 terminal: boolean;
};
export type ProgressRow = {
 turn_id: string;
 conversation_id: string;
 channel_instance_id: string;
 message_id: string | null;
 create_state: "none" | "sending" | "sent" | "unknown" | "failed";
 create_uuid: string;
 view_state: ProgressViewState;
 desired_version: number;
 sent_version: number;
 desired_hash: string | null;
 desired_view_json: string | null;
 last_activity_at: number | null;
 last_activity_label: string | null;
 completed_tool_count: number;
 last_patch_at: number | null;
 patch_count: number;
 next_at: number;
 attempts: number;
 degraded: 0 | 1;
 reason: string | null;
 created_at: number;
 updated_at: number;
};
export type ProgressTurn = { state: string; reason: string | null; created_at: number };
export type ProgressContext = { now: number; openDecision: boolean };

export const CREATE_DELAY_MS = 10_000;
export const STALE_AFTER_MS = 120_000;
export const ACTIVITY_BUCKET_MS = 30_000;

const TERMINAL_VIEWS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "unknown"]);
const TERMINAL_TURNS: ReadonlySet<string> = new Set(["completed", "failed", "unknown"]);
const STARTED = "tool_started:";
const FINISHED = "tool_finished:";

// Tool names reach a user-visible card, so only short generic identifiers pass; anything else is "tool".
export function safeToolName(name: unknown): string {
 return typeof name === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(name) ? name : "tool";
}

// Keys sorted at every depth, so two objects that differ only in key order serialise identically.
export function canonicalJson(value: unknown): string {
 if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
 if (value && typeof value === "object") {
  const object = value as Record<string, unknown>;
  return (
   "{" +
   Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => JSON.stringify(key) + ":" + canonicalJson(object[key]))
    .join(",") +
   "}"
  );
 }
 return JSON.stringify(value) ?? "null";
}
export function progressViewHash(view: ProgressView): string {
 return createHash("sha256").update(canonicalJson(view)).digest("hex");
}

function bucketText(elapsedMs: number): string {
 const seconds = Math.floor(Math.max(0, elapsedMs) / ACTIVITY_BUCKET_MS) * 30;
 if (seconds === 0) return "刚刚";
 return seconds < 60 ? `${seconds} 秒前` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? " 30 秒" : ""}前`;
}

// Pure: reads only the row, the turn's persisted state and the caller-supplied clock/decision flag.
export function computeProgressView(
 row: Pick<ProgressRow, "last_activity_at" | "last_activity_label" | "completed_tool_count">,
 turn: ProgressTurn,
 ctx: ProgressContext,
): ProgressView {
 const label = row.last_activity_label;
 const activeTool = label?.startsWith(STARTED) ? label.slice(STARTED.length) : null;
 const base = {
  activeTool: null as string | null,
  completedTools: row.completed_tool_count,
  lastActivityAt: row.last_activity_at,
 };
 const terminal = (state: ProgressViewState, title: string, summary: string): ProgressView => ({
  ...base,
  state,
  title,
  summary,
  terminal: true,
 });
 const live = (state: ProgressViewState, title: string, summary: string, tool: string | null): ProgressView => ({
  ...base,
  state,
  title,
  summary,
  activeTool: tool,
  terminal: false,
 });
 if (turn.state === "completed") return terminal("completed", "已完成", "本轮已结束。");
 if (turn.state === "failed") return terminal("failed", "执行失败", "本轮执行失败。");
 if (turn.state === "unknown") {
  if (turn.reason === "cancelled_effects_unconfirmed")
   return terminal("cancelled", "已取消", "已取消；取消前及后台副作用未确认，现场保持隔离。");
  return terminal("unknown", "结果未知", "结果未知，保留现场，不自动重跑。");
 }
 if (turn.state === "queued") return live("queued", "排队中", "正在等待前序任务", null);
 if (turn.state === "blocked" && ctx.openDecision)
  return live("waiting_decision", "等待决策", "等待你在下方决策卡中处理", null);
 // null only for rows that predate the seed; those are never stale.
 const idle = row.last_activity_at === null ? 0 : ctx.now - row.last_activity_at;
 if (row.last_activity_at !== null && idle >= STALE_AFTER_MS) {
  const tail = activeTool ? `；工具 ${activeTool} 尚未结束` : "";
  return live(
   "stale",
   "疑似卡住",
   `超过 2 分钟没有新活动，任务可能卡住；可取消或稍后查看。${tail}`,
   activeTool,
  );
 }
 const cancelling = turn.state === "cancelling";
 const parts = [cancelling ? "正在取消" : "正在处理"];
 if (activeTool) parts.push(`正在使用 ${activeTool}`);
 parts.push(`已完成 ${row.completed_tool_count} 个工具`);
 if (row.last_activity_at !== null) parts.push(`最近活动 ${bucketText(idle)}`);
 return live("running", cancelling ? "正在取消" : "正在处理", parts.join("；"), activeTool);
}

// The card is only worth creating once the turn has outlived the queue-latency noise, and never for a
// silent turn or one that is already final.
export function progressCreateAllowed(
 turn: Pick<ProgressTurn, "state" | "created_at">,
 now: number,
 silent: boolean,
): boolean {
 return !silent && !TERMINAL_TURNS.has(turn.state) && now - turn.created_at >= CREATE_DELAY_MS;
}

const getRow = (db: Database, turnId: string) =>
 db.query("SELECT * FROM channel_progress WHERE turn_id=?").get(turnId) as ProgressRow | null;
export const getProgress = getRow;

// last_activity_at is seeded with the turn's creation time so a turn that never emits a tool event still
// has a staleness baseline. Invariants 1 and 2: turn_id is the primary key and create_uuid is written once, by INSERT OR IGNORE.
export function ensureProgressRow(db: Database, turnId: string, now: number): ProgressRow | null {
 const turn = db
  .query(
   "SELECT t.conversation_id, t.created_at, c.address FROM conversation_turns t JOIN conversations c ON c.id=t.conversation_id WHERE t.id=?",
  )
  .get(turnId) as { conversation_id: string; created_at: number; address: string } | null;
 if (!turn) return null;
 const address = JSON.parse(turn.address) as ChannelAddress;
 db.run(
  "INSERT OR IGNORE INTO channel_progress(turn_id,conversation_id,channel_instance_id,create_uuid,last_activity_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
  [turnId, turn.conversation_id, address.instanceId, randomUUID(), turn.created_at, now, now],
 );
 return getRow(db, turnId);
}

// Caller dedupes on event id (recordRuntimeEvent inserts into channel_runtime_events first).
export function recordProgressActivity(db: Database, event: RuntimeEvent, now: number): boolean {
 if (event.kind !== "tool_started" && event.kind !== "tool_finished") return false;
 if (!event.turnId) return false;
 return db
  .transaction(() => {
   const turn = db.query("SELECT state FROM conversation_turns WHERE id=?").get(event.turnId) as {
    state: string;
   } | null;
   if (!turn || TERMINAL_TURNS.has(turn.state)) return false;
   const row = ensureProgressRow(db, event.turnId, now);
   // Invariant 7: a final view is never pulled back to a running one by a late tool event.
   if (!row || TERMINAL_VIEWS.has(row.view_state)) return false;
   const name = safeToolName(event.toolName);
   const finished = event.kind === "tool_finished";
   return (
    db.run(
     "UPDATE channel_progress SET last_activity_at=MAX(COALESCE(last_activity_at,0),?),last_activity_label=?,completed_tool_count=completed_tool_count+?,updated_at=? WHERE turn_id=?",
     [now, (finished ? FINISHED : STARTED) + name, finished ? 1 : 0, now, event.turnId],
    ).changes > 0
   );
  })
  .immediate();
}

export type ProjectResult = { changed: boolean; version: number };

// Invariants 3, 5, 6, 7. The version bump is a compare-and-swap on the version we read, so two
// projectors racing on one row cannot both bump it from the same base.
export function projectProgress(
 db: Database,
 turnId: string,
 ctx: ProgressContext,
): ProjectResult | null {
 return db
  .transaction(() => {
   const row = ensureProgressRow(db, turnId, ctx.now);
   if (!row) return null;
   const same = { changed: false, version: row.desired_version };
   if (row.degraded) return same;
   if (TERMINAL_VIEWS.has(row.view_state)) return same;
   const turn = db
    .query("SELECT state,reason,created_at FROM conversation_turns WHERE id=?")
    .get(turnId) as ProgressTurn;
   const view = computeProgressView(row, turn, ctx);
   const hash = progressViewHash(view);
   if (hash === row.desired_hash) return same;
   const bumped = db.run(
    "UPDATE channel_progress SET desired_version=desired_version+1,desired_hash=?,desired_view_json=?,view_state=?,updated_at=? WHERE turn_id=? AND desired_version=?",
    [hash, canonicalJson(view), view.state, ctx.now, turnId, row.desired_version],
   );
   return bumped.changes
    ? { changed: true, version: row.desired_version + 1 }
    : same;
  })
  .immediate();
}

// Rows with something to send: a card not yet created (and allowed to be), or a created card behind
// its desired version. Degraded rows are never due; unknown/failed/sending creates are never retried.
export function listDueProgress(
 db: Database,
 now: number,
 silentTurn: (turnId: string) => boolean = () => false,
 limit = 50,
): ProgressRow[] {
 const rows = db
  .query(
   "SELECT p.*,t.state turn_state,t.created_at turn_created_at FROM channel_progress p JOIN conversation_turns t ON t.id=p.turn_id WHERE p.degraded=0 AND p.desired_version>p.sent_version AND p.next_at<=? AND p.create_state IN ('none','sent') ORDER BY p.next_at,p.turn_id",
  )
  .all(now) as (ProgressRow & { turn_state: string; turn_created_at: number })[];
 const due: ProgressRow[] = [];
 for (const { turn_state, turn_created_at, ...row } of rows) {
  if (
   row.create_state === "none" &&
   !progressCreateAllowed({ state: turn_state, created_at: turn_created_at }, now, silentTurn(row.turn_id))
  )
   continue;
  due.push(row);
  if (due.length >= limit) break;
 }
 return due;
}

// --- CAS transitions. Each is one conditional UPDATE; the affected-row count is the answer. ---

export function beginProgressCreate(db: Database, turnId: string, now: number): boolean {
 return (
  db.run(
   "UPDATE channel_progress SET create_state='sending',attempts=attempts+1,updated_at=? WHERE turn_id=? AND create_state='none' AND degraded=0",
   [now, turnId],
  ).changes > 0
 );
}
// Invariant 4: sent_version advances only here and in markProgressPatched, and only to a version
// that desired_version has already reached.
export function markProgressCreated(
 db: Database,
 turnId: string,
 messageId: string,
 version: number,
 now: number,
): boolean {
 return (
  db.run(
   "UPDATE channel_progress SET create_state='sent',message_id=?,sent_version=?,attempts=0,next_at=0,reason=NULL,updated_at=? WHERE turn_id=? AND create_state='sending' AND sent_version<? AND desired_version>=?",
   [messageId, version, now, turnId, version, version],
  ).changes > 0
 );
}
export function markProgressCreateFailed(
 db: Database,
 turnId: string,
 state: "failed" | "unknown",
 reason: string,
 now: number,
): boolean {
 return (
  db.run(
   "UPDATE channel_progress SET create_state=?,reason=?,updated_at=? WHERE turn_id=? AND create_state='sending'",
   [state, reason, now, turnId],
  ).changes > 0
 );
}
export function markProgressPatched(
 db: Database,
 turnId: string,
 version: number,
 now: number,
): boolean {
 return (
  db.run(
   "UPDATE channel_progress SET sent_version=?,last_patch_at=?,patch_count=patch_count+1,attempts=0,next_at=0,reason=NULL,updated_at=? WHERE turn_id=? AND create_state='sent' AND degraded=0 AND sent_version<? AND desired_version>=?",
   [version, now, now, turnId, version, version],
  ).changes > 0
 );
}
export function markProgressRetry(
 db: Database,
 turnId: string,
 attempts: number,
 nextAt: number,
 reason: string,
 now: number,
): boolean {
 return (
  db.run(
   "UPDATE channel_progress SET attempts=attempts+1,next_at=?,reason=?,updated_at=? WHERE turn_id=? AND attempts=?",
   [nextAt, reason, now, turnId, attempts],
  ).changes > 0
 );
}
export function markProgressDegraded(db: Database, turnId: string, reason: string, now: number): boolean {
 return (
  db.run(
   "UPDATE channel_progress SET degraded=1,reason=?,updated_at=? WHERE turn_id=? AND degraded=0",
   [reason, now, turnId],
  ).changes > 0
 );
}

// Invariant 8: a create that was in flight when the process died has an unknown outcome. It becomes
// 'unknown' and stays that way; nothing re-creates the card (the create_uuid stays stable regardless).
export function repairProgressOnStart(db: Database, now: number): number {
 return db.run(
  "UPDATE channel_progress SET create_state='unknown',reason='create_receipt_lost',updated_at=? WHERE create_state='sending'",
  [now],
 ).changes;
}

// Restart recovery: recompute the desired view of every progress row still open, from the database alone.
export function reprojectAll(db: Database, now: number, openDecision: (turnId: string) => boolean): number {
 const rows = db.query("SELECT turn_id FROM channel_progress WHERE degraded=0").all() as { turn_id: string }[];
 let changed = 0;
 for (const { turn_id } of rows)
  if (projectProgress(db, turn_id, { now, openDecision: openDecision(turn_id) })?.changed) changed++;
 return changed;
}

// An open runtime decision is one not yet dispatched back to the runtime.
export function openRuntimeDecision(db: Database, turnId: string): boolean {
 return !!db
  .query("SELECT 1 FROM runtime_decisions WHERE turn_id=? AND dispatch_state='pending' LIMIT 1")
  .get(turnId);
}
