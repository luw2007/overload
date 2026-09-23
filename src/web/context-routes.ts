import type { Database } from "bun:sqlite";
import { openControl } from "../control/store";
import { getContextPackage } from "../control/context-assembler";
import { fetchOnDemand } from "../control/on-demand-fetcher";
import { getObjectVersion } from "../control/context-pool";
import type { VisibilityLevel } from "../control/visibility-policy";

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
