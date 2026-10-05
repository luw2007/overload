import type { Database } from "bun:sqlite";
import { getAttention, getWork, openControl } from "../control/store";
import { getContextPackage } from "../control/context-assembler";
import { fetchOnDemand } from "../control/on-demand-fetcher";
import { getObjectVersion } from "../control/context-pool";
import type { VisibilityLevel } from "../control/visibility-policy";
import { getTask, openStore } from "../orchestrator/store";
import { determineRecoveryOutcome } from "../orchestrator/recovery-context";
import { ControlEventVerificationError, verifyControlOutboxEvent } from "../control/outbox";

const json = (value: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });

/** actor 必须由服务端可信调用上下文注入（plan §4.2）：从 options.actor 取，
 *  不读取请求头 / 请求体 / query。未配置可信身份时接口返回 501。
 *  purpose 固定为 decision_view，由服务端决定，不由客户端传。 */
const NOT_IMPLEMENTED = () =>
  json(
    { error: "not_implemented", message: "context routes require server-side actor identity; no trusted identity configured" },
    { status: 501 },
  );

/** blocked(needs_context/...) → HTTP 状态码。forbidden 不给摘要；unavailable 不造值。 */
function blockedStatus(code: string): number {
  if (code === "forbidden") return 403;
  if (code === "unavailable") return 404;
  return 409;
}

export interface ContextRouteOptions {
  controlPath?: string;
  orchestratorPath?: string;
  /** 服务端注入的可信 actor。未配置（undefined/空串）时两个端点均返回 501。
   *  不得从请求头 / body / query 取；正式部署应来自已认证 session/token 绑定。 */
  actor?: string;
}

export async function contextRoute(
  request: Request,
  url: URL,
  options: ContextRouteOptions,
): Promise<Response | null> {
  if (request.method !== "GET") return null;
  if (url.pathname === "/api/context/decision-package") return decisionPackage(request, url, options);
  if (url.pathname === "/api/context/recovery-review") return recoveryReview(url, options);
  if (url.pathname === "/api/context/decision-receipt") return decisionReceipt(url, options);
  if (url.pathname === "/api/context/fetch-full") return fetchFull(request, url, options);
  return null;
}

/** GET /api/context/decision-package?item_id=&work_id=[&problem_id=]
 *  返回 DecisionViewPackage。evidence 默认 short（summary_short + reference），
 *  不含 full 原文；long/full 由前端按需调 fetch-full。 */
function decisionPackage(request: Request, url: URL, options: ContextRouteOptions): Response {
  const actor = options.actor?.trim();
  if (!actor) return NOT_IMPLEMENTED();
  const itemId = url.searchParams.get("item_id");
  const workId = url.searchParams.get("work_id");
  if (!itemId || !workId) return json({ error: "invalid", message: "item_id and work_id are required" }, { status: 400 });
  const problemId = url.searchParams.get("problem_id") || undefined;
  const db = openControl(options.controlPath);
  try {
    const result = getContextPackage({
      consumer_type: "decision_ui",
      consumer_id: itemId,
      work_id: workId,
      ...(problemId ? { problem_id: problemId } : {}),
      package_type: "decision_view",
      actor,
      purpose: "decision_view",
      db,
    });
    if (result.ok) return json(result.package);
    return json({ blocked: true, code: result.code, reason: result.reason }, { status: blockedStatus(result.code) });
  } finally {
    db.close();
  }
}

/** Read-only inspection. It never changes task state, creates a receipt, or launches a runner. */
function recoveryReview(url: URL, options: ContextRouteOptions): Response {
  const actor = options.actor?.trim();
  if (!actor) return NOT_IMPLEMENTED();
  const itemId = url.searchParams.get("item_id");
  const expected = Number(url.searchParams.get("attention_revision"));
  if (!itemId || !Number.isSafeInteger(expected) || expected < 1) return json({ error: "invalid", message: "item_id and attention_revision are required" }, { status: 400 });
  const control = openControl(options.controlPath);
  try {
    const item = getAttention(control, itemId);
    if (!item) return json({ error: "not_found" }, { status: 404 });
    const work = getWork(control, item.work_id);
    if (work?.contract?.decision_owner !== actor || item.owner !== actor) return json({ error: "forbidden" }, { status: 403 });
    if (item.revision !== expected || item.state !== "open" || work.revision !== item.contract_revision) return json({ error: "stale_review", message: "Review the current attention and contract before returning to the task." }, { status: 409 });
    const taskId = item.evidence.task_id;
    const kind = item.evidence.kind;
    if (item.consumer_owner !== "orchestrator" || typeof taskId !== "string" || !taskId
      || typeof kind !== "string" || !["context.pending", "context.recovery_jump", "context.recovery_package", "context.recovery_reconcile", "context.recovery_blocked"].includes(kind)) {
      return json({ error: "invalid", message: "not a context review item" }, { status: 400 });
    }
    const tasks = openStore(options.orchestratorPath);
    try {
      const task = getTask(tasks, taskId);
      if (!task || task.work_id !== item.work_id) return json({ error: "not_found", message: "Original task is unavailable; no new task was created." }, { status: 404 });
      if (task.contract_revision !== work.revision || (typeof item.evidence.attempt_id === "string" && item.evidence.attempt_id !== task.attempt_id)) {
        return json({ error: "stale_review", message: "The task attempt or contract has changed. Refresh the original item." }, { status: 409 });
      }
      const outcome = task.attempt_id ? determineRecoveryOutcome({
        controlDb: control, orchestratorDb: tasks, work_id: item.work_id,
        task_id: task.task_id, attempt_id: task.attempt_id, actor,
      }) : { type: "blocked", reason: "No runner attempt has started.", code: "not_started" };
      return json({ item_id: item.item_id, attention_revision: item.revision, contract_revision: work.revision,
        task: { task_id: task.task_id, title: task.title, state: task.state, attempt_id: task.attempt_id,
          repo: task.repo, worktree: task.worktree, branch: task.branch, stable_id: task.stable_id,
          blocked_reason: task.blocked_reason, terminal_reason: task.terminal_reason },
        outcome, execution_authorized: false,
      });
    } finally { tasks.close(); }
  } finally { control.close(); }
}
/** Historical facts only: a missing retained snapshot is unavailable, never reconstructed from today's contract. */
function decisionReceipt(url: URL, options: ContextRouteOptions): Response {
  const actor = options.actor?.trim();
  if (!actor) return NOT_IMPLEMENTED();
  const itemId = url.searchParams.get("item_id");
  if (!itemId) return json({ error: "invalid", message: "item_id is required" }, { status: 400 });
  const db = openControl(options.controlPath);
  try {
    const item = getAttention(db, itemId);
    if (!item) return json({ error: "not_found" }, { status: 404 });
    if (getWork(db, item.work_id)?.contract?.decision_owner !== actor || item.owner !== actor) return json({ error: "forbidden" }, { status: 403 });
    type RecordedReceipt = { receipt_id: string; answer: string; actor: string; consumed_at: number; applied_at: number | null; outcome: string | null; target_version: string };
    const hasMailbox = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='decision_receipts'").get();
    const receipt = hasMailbox && item.approval_id && item.consumer_owner
      ? db.query(`SELECT receipt_id,answer,actor,consumed_at,applied_at,outcome,target_version FROM decision_receipts
          WHERE consumer_owner=? AND approval_id=? ORDER BY consumed_at DESC,receipt_id DESC LIMIT 1`)
        .get(item.consumer_owner, item.approval_id) as RecordedReceipt | null : null;
    const selected = receipt?.answer ?? (typeof item.evidence.selected_option === "string" ? item.evidence.selected_option : null);
    const decidedAt = receipt?.consumed_at ?? (typeof item.evidence.decided_at === "number" ? item.evidence.decided_at : null);
    let summary: Record<string, unknown> | null = null;
    if (decidedAt !== null) {
      const snapshotRow = db.query(`SELECT * FROM control_outbox WHERE item_id=? AND created_at<=?
        AND kind IN ('attention.created','attention.updated','attention.applying')
        ORDER BY created_at DESC,entity_version DESC LIMIT 1`).get(item.item_id, decidedAt) as Record<string, unknown> | null;
      if (snapshotRow) try {
        const verified = verifyControlOutboxEvent(db, snapshotRow);
        const snapshot = verified.payload.attention;
        if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
          const facts = snapshot as Record<string, unknown>;
          if (facts.item_id === item.item_id && facts.work_id === item.work_id
            && typeof facts.conclusion === "string" && typeof facts.trigger === "string" && typeof facts.impact === "string"
            && typeof facts.contract_revision === "number") {
            summary = { conclusion: facts.conclusion, trigger: facts.trigger, impact: facts.impact,
              recommendation: facts.recommendation, contract_revision: facts.contract_revision, source_link: facts.source_link };
          }
        }
      } catch (error) {
        if (!(error instanceof ControlEventVerificationError)) throw error;
      }
    }
    const hasObservations = !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='receipt_effect_observations'").get();
    const effects = receipt && hasObservations ? db.query(`SELECT tool_call_id,state,evidence,observed_at
      FROM receipt_effect_observations WHERE receipt_id=? ORDER BY observed_at,tool_call_id`).all(receipt.receipt_id) : [];
    return json({ item_id: item.item_id, conclusion: item.conclusion, state: item.state, effect_state: item.effect_state,
      effect_detail: item.effect_detail, owner: item.owner, updated_at: item.updated_at,
      decision: { selected_option: selected, decided_at: decidedAt, actor: receipt?.actor ?? (typeof item.evidence.decision_actor === "string" ? item.evidence.decision_actor : null),
        reason: typeof item.evidence.decision_reason === "string" ? item.evidence.decision_reason : null,
        summary, context_status: summary ? "recorded" : "unavailable" },
      receipt, effects, evidence: item.evidence, source_link: item.source_link,
    });
  } finally { db.close(); }
}


/** GET /api/context/fetch-full?object_id=&revision=&work_id=[&problem_id=][&visibility=short|long|full]
 *  visibility=long → summary_long；visibility=full → 调权威源取原文。
 *  权限检查在 fetchOnDemand 内部执行：无权限 403，源不可用 404（不造值）。 */
function fetchFull(request: Request, url: URL, options: ContextRouteOptions): Response {
  const actor = options.actor?.trim();
  if (!actor) return NOT_IMPLEMENTED();
  const objectId = url.searchParams.get("object_id");
  const revisionRaw = url.searchParams.get("revision");
  const workId = url.searchParams.get("work_id");
  if (!objectId || !revisionRaw || !workId) {
    return json({ error: "invalid", message: "object_id, revision and work_id are required" }, { status: 400 });
  }
  const revision = Number(revisionRaw);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    return json({ error: "invalid", message: "revision must be a positive integer" }, { status: 400 });
  }
  const visibilityParam = (url.searchParams.get("visibility") || "full") as VisibilityLevel;
  if (visibilityParam !== "short" && visibilityParam !== "long" && visibilityParam !== "full") {
    return json({ error: "invalid", message: "visibility must be short|long|full" }, { status: 400 });
  }
  const problemId = url.searchParams.get("problem_id") || undefined;
  const db = openControl(options.controlPath) as Database;
  try {
    const version = getObjectVersion(db, objectId, revision);
    if (!version) return json({ error: "unavailable", reason: "object version not found" }, { status: 404 });
    const result = fetchOnDemand({
      reference: version.reference,
      visibility: visibilityParam,
      actor,
      work_id: workId,
      ...(problemId ? { problem_id: problemId } : {}),
      purpose: "decision_view",
      version_pin: { object_id: objectId, revision },
      db,
    });
    if ("blocked" in result) {
      if (result.code === "forbidden") return json({ error: "forbidden", reason: result.reason }, { status: 403 });
      if (result.code === "unavailable") return json({ error: "unavailable", reason: result.reason }, { status: 404 });
      return json({ error: result.code, reason: result.reason }, { status: 409 });
    }
    return json({
      payload: result.payload,
      visibility: result.visibility,
      content_hash: result.content_hash,
      ...(result.budget_limited ? { budget_limited: true } : {}),
    });
  } finally {
    db.close();
  }
}
