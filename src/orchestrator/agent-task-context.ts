import type { Database } from "bun:sqlite";
import {
  getContextPackage,
  type AgentTaskPackage,
  type AssemblyResult,
} from "../control/context-assembler";

// ========== 类型 ==========

export interface AgentTaskContextInput {
  /** control DB（只读调用 assembler） */
  db: Database;
  /** orchestrator DB（预留，当前 T6 不直读） */
  orchestratorDb: Database;
  work_id: string;
  task_id: string;
  problem_id?: string;
  /** 服务端注入（orchestrator 身份） */
  actor: string;
  target_model?: string;
  /** 任务 scope 条件，决定哪些 constraints/facts 相关 */
  scope_filter?: {
    cwd?: string;
    repo?: string;
    allowed_effects?: string[];
  };
}

export type AgentTaskContextResult =
  | { ok: true; package: AgentTaskPackage; system_prompt_injection: string }
  | { ok: false; blocked: boolean; reason: string; code: string };

// ========== scope 过滤 ==========

/**
 * 简单 scope 匹配：fact 的 reference 或 summary 包含 scope 关键词。
 * 本专项不做语义匹配。
 */
function factMatchesScope(
  fact: { reference: string; summary: string },
  scope: NonNullable<AgentTaskContextInput["scope_filter"]>,
): boolean {
  const haystack = `${fact.reference} ${fact.summary}`.toLowerCase();
  const keywords: string[] = [];
  if (scope.cwd) keywords.push(scope.cwd.toLowerCase());
  if (scope.repo) keywords.push(scope.repo.toLowerCase());
  if (scope.allowed_effects) keywords.push(...scope.allowed_effects.map((e) => e.toLowerCase()));
  if (keywords.length === 0) return true; // 无 scope 条件 → 全部保留
  return keywords.some((kw) => haystack.includes(kw));
}

function filterFactsByScope(pkg: AgentTaskPackage, scope: AgentTaskContextInput["scope_filter"]): AgentTaskPackage {
  if (!scope) return pkg;
  return {
    ...pkg,
    relevant_facts: pkg.relevant_facts.filter((f) =>
      factMatchesScope({ reference: f.reference, summary: f.summary }, scope),
    ),
  };
}

// ========== 系统提示注入 ==========

function buildSystemPromptInjection(pkg: AgentTaskPackage): string {
  const lines: string[] = [];
  lines.push("=== OVERLOAD CONTEXT ===");
  lines.push(`Objective: ${pkg.objective.summary}`);
  lines.push(`Contract revision: ${pkg.objective.contract_revision}`);
  lines.push(`Non-goals: ${pkg.constraints.non_goals.join(", ") || "(none)"}`);
  lines.push(`Scope: ${JSON.stringify(pkg.constraints.scope)}`);
  lines.push(`Budget: ${JSON.stringify(pkg.constraints.budget)}`);
  lines.push(
    `Stop conditions: ${pkg.constraints.stop_conditions
      .map((c) => `- [${c.kind}] ${c.description}`)
      .join("\n") || "(none)"}`,
  );
  lines.push(
    `Human-only effects: ${pkg.constraints.human_only_effects?.join(", ") || "none"}`,
  );
  lines.push(
    `Relevant facts: ${pkg.relevant_facts
      .map((f) => `- [${f.fact_subtype}] ${f.summary} (${f.reference} rev${f.revision})`)
      .join("\n") || "(none)"}`,
  );
  lines.push(
    `Prior decisions: ${pkg.prior_decisions
      .map((d) => `- ${d.summary} (rev${d.revision})`)
      .join("\n") || "(none)"}`,
  );
  lines.push(
    `Artifacts: ${pkg.artifacts
      .map((a) => `- ${a.reference} (hash: ${a.content_hash.slice(0, 12)})`)
      .join("\n") || "(none)"}`,
  );
  lines.push(`Checkpoint: ${pkg.scene_checkpoint?.reference || "none"}`);
  lines.push("=== END OVERLOAD CONTEXT ===");
  return lines.join("\n");
}

// ========== 主入口 ==========

export function buildAgentTaskContext(
  input: AgentTaskContextInput,
): AgentTaskContextResult {
  // 显式兼容模式：OVERLOAD_CONTEXT_ASSEMBLY_ENABLED=false 时返回 disabled，
  // orchestrator 检测 code==="disabled" 后走 base prompt 旧路径。
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") {
    return { ok: false, blocked: false, reason: "context assembly disabled", code: "disabled" };
  }
  const result: AssemblyResult = getContextPackage({
    consumer_type: "agent_task",
    consumer_id: input.task_id,
    work_id: input.work_id,
    ...(input.problem_id ? { problem_id: input.problem_id } : {}),
    package_type: "agent_task",
    actor: input.actor,
    ...(input.target_model ? { target_model: input.target_model } : {}),
    db: input.db,
  });

  if (!result.ok) {
    return { ok: false, blocked: true, reason: result.reason, code: result.code };
  }

  if (result.package.package_type !== "agent_task") {
    return {
      ok: false,
      blocked: true,
      reason: "unexpected package type",
      code: "needs_context",
    };
  }

  const filtered = filterFactsByScope(result.package, input.scope_filter);
  const systemPromptInjection = buildSystemPromptInjection(filtered);

  return {
    ok: true,
    package: filtered,
    system_prompt_injection: systemPromptInjection,
  };
}
