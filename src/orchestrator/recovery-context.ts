import type { Database } from "bun:sqlite";
import {
  assembleRecovery,
  type ConfirmedEffect,
  type IncompleteStep,
  type RecoveryBudgetState,
  type RecoveryPackage,
  type RecommendedAction,
} from "../control/context-assembler";
import { getTask, getRecovery, events } from "./store";
import type { Task } from "./store";

// ========== 类型 ==========

export type RuntimeState = "live" | "terminated" | "unknown" | "queued";

export type RecoveryOutcome =
  | { type: "recovery_package"; package: RecoveryPackage }
  | { type: "jump"; reason: string; jump_target: string }
  | { type: "reconcile"; reason: string }
  | { type: "blocked"; reason: string; code: string };

interface RecoveryInput {
  controlDb: Database;
  orchestratorDb: Database;
  work_id: string;
  task_id: string;
  attempt_id: string;
  actor: string;
  problem_id?: string;
}

// ========== runtime state 判定 ==========

type TaskEventRow = {
  id: number;
  task_id: string;
  at: number;
  from_state: string | null;
  to_state: string;
  event: string;
  detail: string | null;
};

function taskEventRows(db: Database, taskId: string): TaskEventRow[] {
  return db
    .query("SELECT id, task_id, at, from_state, to_state, event, detail FROM task_events WHERE task_id=? ORDER BY id")
    .all(taskId) as TaskEventRow[];
}

function parseDetail(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function hasEvent(rows: TaskEventRow[], eventName: string): boolean {
  return rows.some((r) => r.event === eventName);
}

function hasUnconsumedApproval(db: Database, taskId: string): boolean {
  const row = db
    .query("SELECT 1 FROM approvals WHERE task_id=? AND consumed_at IS NULL LIMIT 1")
    .get(taskId) as { 1?: number } | null;
  return !!row;
}

function determineRuntimeState(task: Task, rows: TaskEventRow[]): RuntimeState {
  // queued: 新排队，尚未启动
  if (task.state === "queued") return "queued";

  // done/failed/abandoned: 终态（编排层面已终态，无论事件）
  if (task.state === "done" || task.state === "failed" || task.state === "abandoned") {
    return "terminated";
  }

  // awaiting_human: 不能仅凭 state 判定 terminated。
  // 有 runner_exit/runner_dead 事件 → runner 已退出，可视为 terminated。
  // 无 exit 事件 → 可能是 live blocked-on-ask，交回调用方判断 approval。
  if (task.state === "awaiting_human") {
    if (hasEvent(rows, "runner_exit") || hasEvent(rows, "runner_dead")) return "terminated";
    // 无 exit 事件但有 pid/stable_id → 可能 live
    if (task.runner_pid != null || task.stable_id != null) return "live";
    return "unknown";
  }

  // submitted: 外部 CI 结果未知，不得仅凭 state 判定 terminated。
  // 有 runner_exit 事件 → runner 已退出；否则 liveness 不可判。
  if (task.state === "submitted") {
    if (hasEvent(rows, "runner_exit") || hasEvent(rows, "runner_dead")) return "unknown";
    return "unknown";
  }

  // starting / running: 进程可能活着
  if (task.state === "starting" || task.state === "running") {
    // 有 pid 或 stable_id → 已绑定，视为 live
    if (task.runner_pid != null || task.stable_id != null) return "live";
    // 无 pid 无 stable_id → 刚 claim 未 spawn，活性不可判
    return "unknown";
  }

  // blocked: 可能是 liveness_unknown 或 spawn_fail 等
  // 如果有 runner_dead / runner_exit 事件 → terminated
  if (hasEvent(rows, "runner_dead") || hasEvent(rows, "runner_exit")) return "terminated";
  // 否则活性不可判
  return "unknown";
}

// ========== checkpoint 提取 ==========

function extractCheckpoint(rows: TaskEventRow[]): string | null {
  // 从 task_events detail 中找 checkpoint 引用
  for (let i = rows.length - 1; i >= 0; i--) {
    const detail = parseDetail(rows[i].detail);
    if (typeof detail.checkpoint_reference === "string" && detail.checkpoint_reference) {
      return detail.checkpoint_reference as string;
    }
    if (typeof detail.checkpoint === "string" && detail.checkpoint) {
      return detail.checkpoint as string;
    }
  }
  return null;
}

// ========== runner 恢复支持 ==========

function runnerSupportsRecovery(rows: TaskEventRow[]): boolean {
  // 有 session_bound 事件 → pi runtime 已绑定 → 支持恢复
  // （当前 orchestrator 唯一 runtime 是 pi，spawnRunner → buildPiRunnerInvocation）
  return hasEvent(rows, "session_bound");
}

// ========== 恢复数据聚合 ==========

function aggregateConfirmedEffects(rows: TaskEventRow[]): ConfirmedEffect[] {
  const effects: ConfirmedEffect[] = [];
  for (const row of rows) {
    const detail = parseDetail(row.detail);
    if (row.event === "push_pr_ok" && typeof detail.pr_url === "string") {
      effects.push({
        description: `Pushed branch and created PR: ${detail.pr_url}`,
        ledger_reference: `orchestrator:task_event:${row.id}`,
      });
    } else if (row.event === "ci_merged") {
      effects.push({
        description: "CI merged successfully",
        ledger_reference: `orchestrator:task_event:${row.id}`,
      });
    } else if (row.event === "runner_exit" && detail.evidence_complete === true) {
      effects.push({
        description: "Runner exited with complete evidence",
        ledger_reference: `orchestrator:task_event:${row.id}`,
      });
    }
  }
  return effects;
}

function aggregateIncompleteSteps(task: Task, rows: TaskEventRow[]): IncompleteStep[] {
  const steps: IncompleteStep[] = [];
  // 从 task_events 序列推断 checkpoint 之后未完成的步骤
  if (task.state === "awaiting_human") {
    steps.push({ description: "Human approval pending for verified changes" });
  }
  if (task.state === "submitted" && !task.pr_url) {
    steps.push({ description: "Push/PR not yet completed", reason: "submission in progress" });
  }
  // 检查是否有未完成的 CI 检查
  for (const row of rows) {
    if (row.event === "ci_observation_failed") {
      const detail = parseDetail(row.detail);
      steps.push({
        description: `CI observation failed: ${detail.reason ?? "unknown"}`,
        reason: "ci_observation_failed",
      });
    }
  }
  return steps;
}

function aggregateUnknownItems(rows: TaskEventRow[]): IncompleteStep[] {
  const items: IncompleteStep[] = [];
  for (const row of rows) {
    const detail = parseDetail(row.detail);
    if (row.event === "runner_exit" && detail.evidence_complete === false) {
      items.push({
        description: `Runner exited with incomplete evidence: ${detail.reason ?? "unknown"}`,
        reason: "evidence_incomplete",
      });
    } else if (row.event === "runner_dead") {
      items.push({
        description: "Runner process died",
        reason: "runner_crash",
      });
    } else if (row.event === "liveness_unknown") {
      items.push({
        description: "Liveness could not be determined",
        reason: "liveness_unknown",
      });
    } else if (row.event === "ci_observation_failed") {
      items.push({
        description: `CI state could not be observed: ${detail.reason ?? "unknown"}`,
        reason: "ci_observation_failed",
      });
    }
  }
  return items;
}

function aggregateRecoveryBudget(
  db: Database,
  task: Task,
  rows: TaskEventRow[],
): RecoveryBudgetState {
  // attempts: 统计 runner_dead / runner_exit(incomplete) 次数
  let attempts = 0;
  for (const row of rows) {
    const detail = parseDetail(row.detail);
    if (row.event === "runner_dead") attempts++;
    if (row.event === "runner_exit" && detail.evidence_complete === false) attempts++;
  }
  // unknown_ticks: 从 task_recovery 取
  const recovery = getRecovery(db, task.task_id);
  const unknownTicks = recovery?.unknown_ticks ?? 0;
  return {
    attempts,
    unknown_ticks: unknownTicks,
    retry_budget_remaining: task.retry_budget,
  };
}

// ========== recommended_action 判定 ==========

function determineRecommendedAction(
  checkpoint: string,
  confirmedEffects: ConfirmedEffect[],
  unknownItems: IncompleteStep[],
  budget: RecoveryBudgetState,
): RecommendedAction {
  // 预算耗尽或多次失败 → escalate
  if (budget.retry_budget_remaining <= 0) return "escalate_to_human";
  if (budget.attempts >= 3) return "escalate_to_human";
  // unknown_items 多或效果不确定 → reconcile_first
  if (unknownItems.length >= 2) return "reconcile_first";
  // 有 checkpoint + 有 confirmed_effects + unknown_items 少 → resume
  if (checkpoint && confirmedEffects.length > 0 && unknownItems.length <= 1) {
    return "resume_from_checkpoint";
  }
  // 默认
  return "reconcile_first";
}

// ========== 主入口 ==========

export function determineRecoveryOutcome(input: RecoveryInput): RecoveryOutcome {
  const task = getTask(input.orchestratorDb, input.task_id);
  if (!task) {
    return { type: "blocked", reason: "task not found", code: "not_found" };
  }

  const rows = taskEventRows(input.orchestratorDb, input.task_id);

  // 1. runtime state 判定
  const runtimeState = determineRuntimeState(task, rows);

  if (runtimeState === "queued") {
    return { type: "blocked", reason: "task is queued, not yet started", code: "not_terminated" };
  }

  // live + blocked_on_ask → jump，不产恢复包
  if (runtimeState === "live") {
    if (hasUnconsumedApproval(input.orchestratorDb, input.task_id)) {
      const jumpTarget = task.stable_id
        ? `cmux://workspace/${task.stable_id}`
        : `task://${task.task_id}`;
      return {
        type: "jump",
        reason: "live process blocked on human ask",
        jump_target: jumpTarget,
      };
    }
    return {
      type: "blocked",
      reason: "process is live and running, no recovery needed",
      code: "not_terminated",
    };
  }

  // liveness unknown → reconcile，不 spawn 不恢复
  if (runtimeState === "unknown") {
    return {
      type: "reconcile",
      reason: "liveness unknown: reconcile four sources first",
    };
  }

  // runtimeState === "terminated" → 继续检查条件 2、3

  // 2. checkpoint 有效性
  const checkpoint = extractCheckpoint(rows);
  if (!checkpoint) {
    return { type: "blocked", reason: "no valid checkpoint found", code: "no_checkpoint" };
  }

  // 3. runner 恢复支持
  if (!runnerSupportsRecovery(rows)) {
    return {
      type: "blocked",
      reason: "runtime does not support recovery",
      code: "runner_unsupported",
    };
  }

  // terminated 的 failure/unknown 结局不得自动归档（此处不调用归档逻辑，仅装配恢复包）
  // 聚合恢复数据
  const confirmedEffects = aggregateConfirmedEffects(rows);
  const incompleteSteps = aggregateIncompleteSteps(task, rows);
  const unknownItems = aggregateUnknownItems(rows);
  const budget = aggregateRecoveryBudget(input.orchestratorDb, task, rows);
  const recommendedAction = determineRecommendedAction(
    checkpoint,
    confirmedEffects,
    unknownItems,
    budget,
  );

  const sessionReference = task.stable_id ?? `task:${task.task_id}:${input.attempt_id}`;
  const binding: Record<string, unknown> = {
    task_id: task.task_id,
    attempt_id: input.attempt_id,
    repo: task.repo,
    branch: task.branch,
    worktree: task.worktree,
  };

  // 调用 Core assembleRecovery
  const result = assembleRecovery(input.controlDb, {
    consumer_type: "recovery",
    consumer_id: input.attempt_id,
    work_id: input.work_id,
    ...(input.problem_id ? { problem_id: input.problem_id } : {}),
    package_type: "recovery",
    actor: input.actor,
    db: input.controlDb,
    recovery_aggregated: {
      checkpoint_reference: checkpoint,
      session_reference: sessionReference,
      binding,
      confirmed_effects: confirmedEffects,
      incomplete_steps: incompleteSteps,
      unknown_items: unknownItems,
      recovery_budget: budget,
      recommended_action: recommendedAction,
      ...(task.contract_revision != null ? { contract_revision: task.contract_revision } : {}),
    },
  });

  if (!result.ok) {
    if (result.code === "stale_or_revoked") {
      return { type: "blocked", reason: result.reason, code: "stale_or_revoked" };
    }
    if (result.code === "forbidden") {
      return { type: "blocked", reason: result.reason, code: "forbidden" };
    }
    return { type: "blocked", reason: result.reason, code: result.code };
  }

  if (result.package.package_type !== "recovery") {
    return { type: "blocked", reason: "unexpected package type", code: "needs_context" };
  }

  return { type: "recovery_package", package: result.package };
}
