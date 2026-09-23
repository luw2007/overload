import { Database } from "bun:sqlite";
import type { ContextCtype, ContextObject, ObjectVersion } from "./context-pool";

// ========== 类型 ==========

export type VisibilityLevel = "hide" | "short" | "long" | "full";

export type VisibilityResult =
  | { allowed: true; visibility: VisibilityLevel; reason?: string }
  | { allowed: false; reason: string; code: "unauthorized" | "forbidden" | "unavailable" };

export type Purpose = "decision_view" | "agent_task" | "recovery" | "audit";

// ========== 常量 ==========

const RUNTIME_WHITELIST = new Set(["pi", "omp", "prime", "claude", "cmux"]);

// 外部 URL 白名单（默认空 = 拒绝所有 http/https）。
const HTTP_WHITELIST = new Set<string>();

const LEVEL_ORDER: Record<VisibilityLevel, number> = {
  hide: 0,
  short: 1,
  long: 2,
  full: 3,
};

// sensitivity 允许的最高级别。confirmed_secret 在 grant 后不额外降级。
const SENSITIVITY_CAP: Record<string, VisibilityLevel> = {
  confirmed_secret: "full",
  suspected: "short",
  clean: "full",
};

// ========== reference 合法性 ==========

export function isAuthoritativeReference(reference: string): boolean {
  if (typeof reference !== "string" || !reference.trim()) return false;
  // journal:<seq>
  if (/^journal:\d+$/.test(reference)) return true;
  // orchestrator:submit_result:<id>
  if (/^orchestrator:submit_result:.+/.test(reference)) return true;
  // orchestrator:task_event:<id>
  if (/^orchestrator:task_event:\d+$/.test(reference)) return true;
  // git:<repo>@<sha>
  if (/^git:.+@[0-9a-f]{7,40}$/.test(reference)) return true;
  // artifact:<id>@<version>
  if (/^artifact:.+@.+/.test(reference)) return true;
  // contract:<work_id>@<rev>
  if (/^contract:.+@\d+$/.test(reference)) return true;
  // attention:<item_id>@<rev>
  if (/^attention:.+@\d+$/.test(reference)) return true;
  // http/https — 白名单
  if (/^https?:\/\//.test(reference)) {
    for (const allowed of HTTP_WHITELIST) {
      if (reference.startsWith(allowed)) return true;
    }
    return false;
  }
  return false;
}

// ========== grant 查询 ==========

export function hasValidGrant(
  db: Database,
  objectId: string,
  revision: number,
  workId: string,
): boolean {
  const row = db
    .query(
      "SELECT 1 FROM control_context_shares WHERE object_id=? AND revision=? AND shared_with_work=?",
    )
    .get(objectId, revision, workId) as { 1?: number } | null;
  return !!row;
}

// ========== 默认可见性 ==========

export function defaultVisibility(ctype: ContextCtype, _purpose: string): VisibilityLevel {
  switch (ctype) {
    case "objective":
    case "constraints":
    case "scene":
      return "long";
    case "fact":
    case "decision":
    case "artifact":
      return "short";
    default:
      return "short";
  }
}

// ========== 权限预检主函数 ==========

export function checkVisibility(input: {
  db: Database;
  actor: string;
  work_id: string;
  problem_id?: string;
  object: ContextObject;
  version: ObjectVersion;
  purpose: Purpose;
  channel?: string;
  target_model?: string;
  requested_level?: VisibilityLevel;
}): VisibilityResult {
  // 1. reference 合法性
  if (!isAuthoritativeReference(input.version.reference)) {
    return { allowed: false, code: "unavailable", reason: "invalid reference" };
  }

  // 2. actor 身份校验
  if (typeof input.actor !== "string" || !input.actor.trim()) {
    return { allowed: false, code: "unauthorized", reason: "actor identity required" };
  }

  // 3. sensitivity 门控
  const sensitivity = input.version.sensitivity;
  if (sensitivity === "confirmed_secret") {
    if (!hasValidGrant(input.db, input.object.object_id, input.version.revision, input.work_id)) {
      return { allowed: false, code: "forbidden", reason: "confirmed_secret requires grant" };
    }
  } else if (sensitivity === "unknown") {
    return { allowed: false, code: "unavailable", reason: "sensitivity unknown" };
  }

  // 4. target_model 白名单
  if (input.target_model !== undefined && input.target_model !== "") {
    if (!RUNTIME_WHITELIST.has(input.target_model)) {
      return { allowed: false, code: "forbidden", reason: "target_model not whitelisted" };
    }
  }

  // 5. 跨 work 引用
  if (input.object.work_id !== input.work_id) {
    if (input.version.shareable !== 1) {
      return { allowed: false, code: "forbidden", reason: "cross-work reference not shared" };
    }
    if (!hasValidGrant(input.db, input.object.object_id, input.version.revision, input.work_id)) {
      return { allowed: false, code: "forbidden", reason: "cross-work reference not shared" };
    }
  }

  // 6. 决定可见性级别
  const cap = SENSITIVITY_CAP[sensitivity] ?? "short";
  let level = input.requested_level ?? defaultVisibility(input.object.ctype, input.purpose);

  if (LEVEL_ORDER[level] > LEVEL_ORDER[cap]) {
    if (sensitivity === "suspected" && level === "full") {
      return {
        allowed: true,
        visibility: "short",
        reason: "suspected requires human confirmation for full",
      };
    }
    level = cap;
  }

  return { allowed: true, visibility: level };
}
