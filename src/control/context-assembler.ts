import type { Database } from "bun:sqlite";
import { ensureControlSchema, getAttention, getWork } from "./store";
import type { Work } from "./types";
import {
  getProblemTree,
  listObjectsByProblem,
  type ContextCtype,
  type ContextObject,
  type ObjectVersion,
} from "./context-pool";
import { checkVisibility, type VisibilityLevel, type Purpose } from "./visibility-policy";
import { fetchOnDemand, beginFetchSession } from "./on-demand-fetcher";
import { reverifyBeforeAction } from "./context-propagation";

// ========== 类型 ==========

export type PackageType = "decision_view" | "agent_task" | "recovery";
export type ConsumerType = "decision_ui" | "agent_task" | "recovery";

export interface AssemblyBudget {
  max_bytes?: number;
  max_fetch_count?: number;
  deadline_ms?: number;
}

export interface TriggerEvidence {
  object_id: string;
  fact_subtype: string;
  summary: string;
  reference: string;
  revision: number;
  stale?: boolean;
}

export interface SceneEntry {
  reference: string;
  summary: string;
  jump_target?: string;
}

export interface PriorDecision {
  object_id: string;
  summary: string;
  revision: number;
}

export interface ArtifactRef {
  object_id: string;
  reference: string;
  content_hash: string;
}

export interface StaleObjectEntry {
  object_id: string;
  current_revision: number;
  linked_revision: number;
}

export interface DecisionViewPackage {
  package_type: "decision_view";
  consumer_id: string;
  work_id: string;
  problem_id?: string;
  conclusion: string;
  trigger: string;
  trigger_evidence: TriggerEvidence[];
  impact: string;
  recommendation: string | null;
  options: string[];
  owner: string;
  expires_at: number | null;
  scene_entry: SceneEntry | null;
  prior_decisions: PriorDecision[];
  artifacts: ArtifactRef[];
  effect_state: string;
  contract_revision: number;
  stale_objects: StaleObjectEntry[];
  budget_limited?: boolean;
}

export interface ObjectiveEntry {
  reference: string;
  summary: string;
  contract_revision: number;
}

export interface ConstraintsEntry {
  non_goals: string[];
  scope: Record<string, unknown>;
  budget: Record<string, unknown>;
  stop_conditions: Array<{ id: string; kind: string; description: string }>;
  human_only_effects?: string[];
  reference: string;
}

export interface RelevantFact {
  object_id: string;
  fact_subtype: string;
  summary: string;
  reference: string;
  revision: number;
  expires_at?: number;
}

export interface PriorDecisionWithOwner {
  object_id: string;
  summary: string;
  owner: string;
  revision: number;
}

export interface SceneCheckpoint {
  reference: string;
  session_reference?: string;
  checkpoint?: string;
}

export interface AgentTaskPackage {
  package_type: "agent_task";
  consumer_id: string;
  work_id: string;
  problem_id?: string;
  objective: ObjectiveEntry;
  constraints: ConstraintsEntry;
  relevant_facts: RelevantFact[];
  prior_decisions: PriorDecisionWithOwner[];
  artifacts: ArtifactRef[];
  scene_checkpoint: SceneCheckpoint | null;
  budget_limited?: boolean;
}

export type RecommendedAction = "resume_from_checkpoint" | "reconcile_first" | "escalate_to_human";

export interface ConfirmedEffect {
  description: string;
  ledger_reference?: string;
  content_hash?: string;
}

export interface IncompleteStep {
  description: string;
  reason?: string;
}

export interface RecoveryBudgetState {
  attempts: number;
  unknown_ticks: number;
  retry_budget_remaining: number;
}

export interface RecoveryPackage {
  package_type: "recovery";
  consumer_id: string;
  work_id: string;
  problem_id?: string;
  checkpoint_reference: string;
  session_reference: string;
  binding: Record<string, unknown>;
  confirmed_effects: ConfirmedEffect[];
  incomplete_steps: IncompleteStep[];
  unknown_items: IncompleteStep[];
  recovery_budget: RecoveryBudgetState;
  recommended_action: RecommendedAction;
  all_long: true;
}

export type ContextPackage = DecisionViewPackage | AgentTaskPackage | RecoveryPackage;

export type AssemblyBlockedCode = "needs_context" | "forbidden" | "unavailable" | "stale_or_revoked";

export type AssemblyResult =
  | { ok: true; package: ContextPackage; budget_limited?: boolean }
  | { ok: false; blocked: true; reason: string; code: AssemblyBlockedCode };

// Recovery 聚合数据由 Execution 侧（T7）从 orchestrator DB 聚合后传入，Core 不直读 orchestrator DB。
export interface RecoveryAggregated {
  checkpoint_reference: string;
  session_reference: string;
  binding: Record<string, unknown>;
  confirmed_effects: ConfirmedEffect[];
  incomplete_steps: IncompleteStep[];
  unknown_items: IncompleteStep[];
  recovery_budget: RecoveryBudgetState;
  recommended_action: RecommendedAction;
  contract_revision?: number;
}

export interface GetContextPackageInput {
  consumer_type: ConsumerType;
  consumer_id: string;
  work_id: string;
  problem_id?: string;
  package_type: PackageType;
  actor: string;
  purpose?: string;
  channel?: string;
  target_model?: string;
  budget?: AssemblyBudget;
  db: Database;
  recovery_aggregated?: RecoveryAggregated;
}

// ========== 内部工具 ==========

type PoolEntry = { object: ContextObject; version: ObjectVersion; role: ContextCtype };

function blocked(reason: string, code: AssemblyBlockedCode): AssemblyResult {
  return { ok: false, blocked: true, reason, code };
}

// 服务端运行时主体：orchestrator 在服务器侧注入（非 LLM/用户可控），只允许装配
// server-side 包（agent_task），不允许打开人类 decision_view。
const RUNTIME_ACTOR = "orchestrator";

/**
 * 权限预检：进入 work 的上下文包。
 *
 * 安全红线：control_context_shares 是「对象级跨 work 引用授权」（A work 把某个
 * object@rev 共享给 B work），由 per-object 的 checkVisibility 逐对象判定。它**不是**
 * 「work 级入口授权」——一条 A→B 的 share 绝不能让任意 actor 打开 B 的整个上下文包。
 * 旧实现 `WHERE shared_with_work=? LIMIT 1` 仅凭 B 名下存在任意 share 即放行所有
 * actor（mallory 也能拿到 B 的 fact 摘要），已修复。
 *
 * shares 表无 actor 列，无法表达「针对某个 actor 的 work 级授权」，故入口 fail-closed：
 *   - decision_view（人类决策面）：actor 必须是该 work 的 decision_owner 本人。
 *   - agent_task（服务端运行时注入 prompt）：decision_owner 或服务器运行时主体。
 * 跨 work 可见对象在 projectEntry 层由 hasShare(object_id+revision+shared_with_work) 精确放行。
 */
function assertWorkAccess(
  db: Database,
  work_id: string,
  actor: string,
  package_type: "decision_view" | "agent_task" | "recovery",
): { ok: true; work: Work } | { ok: false } {
  const work = getWork(db, work_id);
  if (!work) return { ok: false };
  const owner = work.contract?.decision_owner ?? null;
  if (owner && actor === owner) return { ok: true, work };
  // 服务端运行时主体仅能装配 agent_task；人类 decision_view 不接受运行时主体。
  if (package_type === "agent_task" && actor === RUNTIME_ACTOR) return { ok: true, work };
  return { ok: false };
}

/** 按 work_id + 可选 problem_id 从 pool 选对象。无 problem_id 时聚合该 work 全部问题的对象。 */
function selectPoolObjects(db: Database, work_id: string, problem_id?: string): PoolEntry[] {
  if (problem_id) return listObjectsByProblem(db, problem_id);
  const problems = getProblemTree(db, work_id);
  const all: PoolEntry[] = [];
  for (const p of problems) all.push(...listObjectsByProblem(db, p.problem_id));
  return all;
}

type Projection =
  | { allowed: true; visibility: VisibilityLevel; summary: string }
  | { allowed: false };

/** 对单个 pool 对象做 visibility ladder 投影。无权限/unknown/full 源不可取 → allowed:false（不返回摘要）。 */
function projectEntry(db: Database, args: {
  actor: string;
  work_id: string;
  problem_id?: string;
  entry: PoolEntry;
  purpose: Purpose;
  channel?: string;
  target_model?: string;
  requested: VisibilityLevel;
  budget?: AssemblyBudget;
}): Projection {
  const { entry } = args;
  const vis = checkVisibility({
    db,
    actor: args.actor,
    work_id: args.work_id,
    problem_id: args.problem_id,
    object: entry.object,
    version: entry.version,
    purpose: args.purpose,
    channel: args.channel,
    target_model: args.target_model,
    requested_level: args.requested,
  });
  if (!vis.allowed) return { allowed: false };
  if (vis.visibility === "hide") return { allowed: false };

  if (vis.visibility === "full") {
    const fetch = fetchOnDemand({
      reference: entry.version.reference,
      visibility: "full",
      actor: args.actor,
      work_id: args.work_id,
      problem_id: args.problem_id,
      purpose: args.purpose,
      channel: args.channel,
      target_model: args.target_model,
      budget: args.budget,
      version_pin: { object_id: entry.object.object_id, revision: entry.version.revision },
      db,
    });
    if ("blocked" in fetch) return { allowed: false };
    return { allowed: true, visibility: vis.visibility, summary: fetch.payload };
  }
  if (vis.visibility === "long") {
    return { allowed: true, visibility: vis.visibility, summary: entry.version.summary_long ?? entry.version.summary_short ?? "" };
  }
  return { allowed: true, visibility: vis.visibility, summary: entry.version.summary_short ?? "" };
}

/** 构建 stale 映射：problem_objects 锁定版本 < objects 当前版本即为 stale。 */
function buildStaleMap(entries: PoolEntry[]): Map<string, StaleObjectEntry> {
  const map = new Map<string, StaleObjectEntry>();
  for (const e of entries) {
    if (e.version.revision < e.object.revision) {
      map.set(e.object.object_id, {
        object_id: e.object.object_id,
        current_revision: e.object.revision,
        linked_revision: e.version.revision,
      });
    }
  }
  return map;
}

// ========== 包类型 1: DecisionViewPackage ==========

export function assembleDecisionView(db: Database, input: GetContextPackageInput): AssemblyResult {
  ensureControlSchema(db);
  const access = assertWorkAccess(db, input.work_id, input.actor, "decision_view");
  if (!access.ok) return blocked("actor is not decision owner and has no valid share", "forbidden");

  const item = getAttention(db, input.consumer_id);
  if (!item) return blocked("attention item not found", "needs_context");

  // 必需字段：conclusion/trigger/impact/options/owner（attention 行 NOT NULL，行存在即可读）。
  if (!item.conclusion || !item.trigger || !item.impact || !item.options?.length || !item.owner) {
    return blocked("required decision field unavailable", "needs_context");
  }

  const purpose: Purpose = (input.purpose ?? input.package_type) as Purpose;
  const entries = selectPoolObjects(db, input.work_id, input.problem_id);
  const staleMap = buildStaleMap(entries);
  const budget: AssemblyBudget = input.budget ?? { max_bytes: 2048 };

  const trigger_evidence: TriggerEvidence[] = [];
  const prior_decisions: PriorDecision[] = [];
  const artifacts: ArtifactRef[] = [];
  let scene_entry: SceneEntry | null = null;

  for (const entry of entries) {
    const { object, version, role } = entry;
    if (role === "fact" && object.fact_subtype) {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "short", budget,
      });
      if (!proj.allowed) continue;
      trigger_evidence.push({
        object_id: object.object_id,
        fact_subtype: object.fact_subtype,
        summary: proj.summary,
        reference: version.reference,
        revision: version.revision,
        ...(staleMap.has(object.object_id) ? { stale: true } : {}),
      });
    } else if (role === "decision") {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "short", budget,
      });
      if (!proj.allowed) continue;
      prior_decisions.push({
        object_id: object.object_id,
        summary: proj.summary,
        revision: version.revision,
      });
    } else if (role === "artifact") {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "short", budget,
      });
      if (!proj.allowed) continue;
      artifacts.push({
        object_id: object.object_id,
        reference: version.reference,
        content_hash: version.content_hash,
      });
    } else if (role === "scene") {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "short", budget,
      });
      if (!proj.allowed) continue;
      scene_entry = {
        reference: version.reference,
        summary: proj.summary,
        jump_target: item.source_link ?? version.reference,
      };
    }
  }

  const pkg: DecisionViewPackage = {
    package_type: "decision_view",
    consumer_id: input.consumer_id,
    work_id: input.work_id,
    ...(input.problem_id ? { problem_id: input.problem_id } : {}),
    conclusion: item.conclusion,
    trigger: item.trigger,
    trigger_evidence,
    impact: item.impact,
    recommendation: item.recommendation,
    options: item.options,
    owner: item.owner,
    expires_at: item.expires_at,
    scene_entry,
    prior_decisions,
    artifacts,
    effect_state: item.effect_state,
    contract_revision: item.contract_revision,
    stale_objects: [...staleMap.values()],
  };

  applyDecisionViewBudget(pkg, budget.max_bytes);
  return { ok: true, package: pkg, ...(pkg.budget_limited ? { budget_limited: true } : {}) };
}

/** 预算超限：降级/裁剪非必需数组，标 budget_limited；必需字段（conclusion/trigger/impact/options/owner）不动。 */
function applyDecisionViewBudget(pkg: DecisionViewPackage, maxBytes?: number): void {
  if (maxBytes === undefined) return;
  if (estimatePackageSize(pkg) <= maxBytes) return;
  pkg.budget_limited = true;
  // 渐进裁剪可选数组，直到达标；必需字段不裁剪。
  let guard = 0;
  while (estimatePackageSize(pkg) > maxBytes && guard++ < 100) {
    if (pkg.trigger_evidence.length > 2) {
      pkg.trigger_evidence.length = Math.ceil(pkg.trigger_evidence.length / 2);
    } else if (pkg.prior_decisions.length > 1) {
      pkg.prior_decisions.length = Math.floor(pkg.prior_decisions.length / 2);
    } else if (pkg.artifacts.length > 1) {
      pkg.artifacts.length = Math.floor(pkg.artifacts.length / 2);
    } else if (pkg.scene_entry !== null) {
      pkg.scene_entry = null;
    } else {
      break;
    }
  }
}

// ========== 包类型 2: AgentTaskPackage ==========

function assembleObjectiveField(
  entries: PoolEntry[],
  db: Database,
  input: GetContextPackageInput,
  work: Work,
  purpose: Purpose,
): { objective: ObjectiveEntry } | { missing: true } {
  const poolObjective = entries.find((e) => e.object.ctype === "objective");
  if (poolObjective) {
    const proj = projectEntry(db, {
      actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
      entry: poolObjective, purpose, channel: input.channel, target_model: input.target_model,
      requested: "long", budget: input.budget,
    });
    if (proj.allowed) {
      return {
        objective: {
          reference: poolObjective.version.reference,
          summary: proj.summary,
          contract_revision: work.revision,
        },
      };
    }
  }
  // 回退：从 contract 直接构造
  if (work.contract?.objective) {
    return {
      objective: {
        reference: `contract:${work.work_id}@${work.revision}`,
        summary: work.contract.objective,
        contract_revision: work.revision,
      },
    };
  }
  return { missing: true };
}

function assembleConstraintsField(
  entries: PoolEntry[],
  db: Database,
  input: GetContextPackageInput,
  work: Work,
  purpose: Purpose,
): { constraints: ConstraintsEntry } | { missing: true } {
  const poolConstraints = entries.find((e) => e.object.ctype === "constraints");
  if (poolConstraints) {
    const proj = projectEntry(db, {
      actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
      entry: poolConstraints, purpose, channel: input.channel, target_model: input.target_model,
      requested: "long", budget: input.budget,
    });
    if (proj.allowed) {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = proj.summary ? (JSON.parse(proj.summary) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      const scoped = (parsed?.scope ?? {}) as Record<string, unknown>;
      return {
        constraints: {
          non_goals: Array.isArray(parsed?.non_goals) ? (parsed!.non_goals as string[]) : [],
          scope: typeof scoped === "object" && scoped !== null ? scoped : {},
          budget: (parsed?.budget ?? {}) as Record<string, unknown>,
          stop_conditions: Array.isArray(parsed?.stop_conditions)
            ? (parsed!.stop_conditions as ConstraintsEntry["stop_conditions"])
            : [],
          ...(Array.isArray(parsed?.human_only_effects)
            ? { human_only_effects: parsed!.human_only_effects as string[] }
            : {}),
          reference: poolConstraints.version.reference,
        },
      };
    }
  }
  // 回退：从 contract 直接构造
  if (work.contract) {
    return {
      constraints: {
        non_goals: work.contract.non_goals ?? [],
        scope: work.contract.scope ?? {},
        budget: work.contract.budget ?? {},
        stop_conditions: work.contract.stop_conditions ?? [],
        ...(work.contract.scope?.human_only_effects
          ? { human_only_effects: work.contract.scope.human_only_effects }
          : {}),
        reference: `contract:${work.work_id}@${work.revision}`,
      },
    };
  }
  return { missing: true };
}

export function assembleAgentTask(db: Database, input: GetContextPackageInput): AssemblyResult {
  ensureControlSchema(db);
  const access = assertWorkAccess(db, input.work_id, input.actor, "agent_task");
  if (!access.ok) return blocked("actor is not decision owner and has no valid share", "forbidden");
  const work = access.work;

  const purpose: Purpose = (input.purpose ?? input.package_type) as Purpose;
  const budget: AssemblyBudget = input.budget ?? { max_bytes: 8192 };
  const entries = selectPoolObjects(db, input.work_id, input.problem_id);

  const objectiveResult = assembleObjectiveField(entries, db, input, work, purpose);
  if ("missing" in objectiveResult) return blocked("objective unavailable (no pool object and no contract)", "needs_context");

  const constraintsResult = assembleConstraintsField(entries, db, input, work, purpose);
  if ("missing" in constraintsResult) return blocked("constraints unavailable (no pool object and no contract)", "needs_context");

  const relevant_facts: RelevantFact[] = [];
  const prior_decisions: PriorDecisionWithOwner[] = [];
  const artifacts: ArtifactRef[] = [];
  let scene_checkpoint: SceneCheckpoint | null = null;

  for (const entry of entries) {
    const { object, version, role } = entry;
    if (role === "fact" && object.fact_subtype) {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "short", budget,
      });
      if (!proj.allowed) continue;
      relevant_facts.push({
        object_id: object.object_id,
        fact_subtype: object.fact_subtype,
        summary: proj.summary,
        reference: version.reference,
        revision: version.revision,
        ...(version.expires_at ? { expires_at: version.expires_at } : {}),
      });
    } else if (role === "decision") {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "short", budget,
      });
      if (!proj.allowed) continue;
      prior_decisions.push({
        object_id: object.object_id,
        summary: proj.summary,
        owner: work.contract?.decision_owner ?? input.actor,
        revision: version.revision,
      });
    } else if (role === "artifact") {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "short", budget,
      });
      if (!proj.allowed) continue;
      artifacts.push({
        object_id: object.object_id,
        reference: version.reference,
        content_hash: version.content_hash,
      });
    } else if (role === "scene") {
      const proj = projectEntry(db, {
        actor: input.actor, work_id: input.work_id, problem_id: input.problem_id,
        entry, purpose, channel: input.channel, target_model: input.target_model,
        requested: "long", budget,
      });
      if (!proj.allowed) continue;
      scene_checkpoint = {
        reference: version.reference,
        ...(proj.summary ? { checkpoint: proj.summary } : {}),
      };
    }
  }

  const pkg: AgentTaskPackage = {
    package_type: "agent_task",
    consumer_id: input.consumer_id,
    work_id: input.work_id,
    ...(input.problem_id ? { problem_id: input.problem_id } : {}),
    objective: objectiveResult.objective,
    constraints: constraintsResult.constraints,
    relevant_facts,
    prior_decisions,
    artifacts,
    scene_checkpoint,
  };

  applyAgentTaskBudget(pkg, budget.max_bytes);
  return { ok: true, package: pkg, ...(pkg.budget_limited ? { budget_limited: true } : {}) };
}

function applyAgentTaskBudget(pkg: AgentTaskPackage, maxBytes?: number): void {
  if (maxBytes === undefined) return;
  if (estimatePackageSize(pkg) <= maxBytes) return;
  pkg.budget_limited = true;
  let guard = 0;
  while (estimatePackageSize(pkg) > maxBytes && guard++ < 100) {
    if (pkg.relevant_facts.length > 2) {
      pkg.relevant_facts.length = Math.ceil(pkg.relevant_facts.length / 2);
    } else if (pkg.prior_decisions.length > 1) {
      pkg.prior_decisions.length = Math.floor(pkg.prior_decisions.length / 2);
    } else if (pkg.artifacts.length > 1) {
      pkg.artifacts.length = Math.floor(pkg.artifacts.length / 2);
    } else {
      break;
    }
  }
}

// ========== 包类型 3: RecoveryPackage ==========

export function assembleRecovery(db: Database, input: GetContextPackageInput): AssemblyResult {
  ensureControlSchema(db);
  const agg = input.recovery_aggregated;
  if (!agg) return blocked("recovery aggregated data is required from Execution side", "needs_context");

  // 必需字段：checkpoint_reference / work_id / consumer_id(attempt_id)
  if (!agg.checkpoint_reference || !agg.checkpoint_reference.trim()) {
    return blocked("checkpoint_reference is required", "needs_context");
  }
  if (!input.work_id || !input.consumer_id) {
    return blocked("work_id and attempt_id are required", "needs_context");
  }

  // 入口复验：恢复前同步复验当前安全约束（权限 + contract 版本 + 证据）。
  const reverify = reverifyBeforeAction(db, {
    entry: "resume_from_checkpoint",
    work_id: input.work_id,
    actor: input.actor,
    contract_revision: agg.contract_revision,
    problem_id: input.problem_id,
  });
  if (!reverify.allowed) {
    if (reverify.code === "permission_denied") return blocked(reverify.reason, "forbidden");
    return blocked(reverify.reason, "stale_or_revoked");
  }

  const pkg: RecoveryPackage = {
    package_type: "recovery",
    consumer_id: input.consumer_id,
    work_id: input.work_id,
    ...(input.problem_id ? { problem_id: input.problem_id } : {}),
    checkpoint_reference: agg.checkpoint_reference,
    session_reference: agg.session_reference,
    binding: agg.binding ?? {},
    confirmed_effects: agg.confirmed_effects ?? [],
    incomplete_steps: agg.incomplete_steps ?? [],
    unknown_items: agg.unknown_items ?? [],
    recovery_budget: agg.recovery_budget,
    recommended_action: agg.recommended_action,
    all_long: true,
  };
  return { ok: true, package: pkg };
}

// ========== 主入口 ==========

export function getContextPackage(input: GetContextPackageInput): AssemblyResult {
  // context.assembly_enabled 开关：设为 "false" 时不读不写
  if (process.env.OVERLOAD_CONTEXT_ASSEMBLY_ENABLED === "false") {
    return blocked("context assembly disabled", "unavailable");
  }
  // 每次装配开始：重置取数预算计时/计数，避免跨请求污染。
  beginFetchSession();
  switch (input.package_type) {
    case "decision_view":
      return assembleDecisionView(input.db, input);
    case "agent_task":
      return assembleAgentTask(input.db, input);
    case "recovery":
      return assembleRecovery(input.db, input);
    default:
      return blocked(`unknown package_type: ${input.package_type}`, "needs_context");
  }
}

// ========== 辅助函数 ==========

/** 估算渲染文本字节数（JSON.stringify 近似）。 */
export function estimatePackageSize(pkg: ContextPackage): number {
  return Buffer.byteLength(JSON.stringify(pkg), "utf8");
}
