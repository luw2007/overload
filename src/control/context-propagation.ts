import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { ControlError, ensureControlSchema, enqueueControlEvent, getWork } from "./store";
import { getObject, getObjectVersion, getProblem, type ObjectVersion } from "./context-pool";
import type { AttentionDecisionInput, AttentionItem } from "./types";
import { resolveAttentionDecision, actOnAttention } from "./store";

// ========== 失效传播 ==========

/**
 * 对象更新版本后，标记所有直接引用该对象的问题为 stale。
 * 只更新直接引用方（problem_objects 中的 problem），不递归更新子问题。
 * 发出 context.updated 事件。
 */
export function markObjectUpdated(db: Database, objectId: string, newRevision: number, nowTs = Date.now()): void {
  ensureControlSchema(db);
  if (!objectId) throw new ControlError("invalid", "objectId is required");
  if (!Number.isSafeInteger(newRevision) || newRevision < 1) throw new ControlError("invalid", "newRevision must be a positive integer");

  const tx = db.transaction(() => {
    // 查找所有直接引用该对象的问题
    const refs = db.query(
      "SELECT problem_id FROM control_context_problem_objects WHERE object_id=?",
    ).all(objectId) as Array<{ problem_id: string }>;

    const problemIds = refs.map((r) => r.problem_id);
    // 更新每个直接引用方的 updated_at（标记 stale，不新增 stale 列）
    for (const pid of problemIds) {
      db.query("UPDATE control_context_problems SET updated_at=? WHERE problem_id=?").run(nowTs, pid);
    }

    // 发出 context.updated 事件
    enqueueControlEvent(db, {
      entity_id: objectId,
      entity_version: newRevision,
      kind: "context.updated",
      payload: {
        object_id: objectId,
        new_revision: newRevision,
        stale_problem_ids: problemIds,
      },
    }, nowTs);
  });
  tx.immediate();
}

// ========== stale 检测 ==========

export type StaleObject = {
  object_id: string;
  current_revision: number;
  linked_revision: number;
};

/**
 * 检查该问题关联的对象是否有新版本（problem_objects 锁定的 revision < objects 当前 revision）。
 * sinceRevision 可选：只检查该 revision 之后是否有更新。
 */
export function isStale(db: Database, problemId: string, sinceRevision?: number): boolean {
  ensureControlSchema(db);
  const rows = db.query(`
    SELECT po.object_id, po.revision AS linked_revision, o.revision AS current_revision
    FROM control_context_problem_objects po
    JOIN control_context_objects o ON o.object_id = po.object_id
    WHERE po.problem_id = ?
  `).all(problemId) as Array<{ object_id: string; linked_revision: number; current_revision: number }>;

  for (const row of rows) {
    if (row.linked_revision < row.current_revision) {
      if (sinceRevision === undefined || row.linked_revision < sinceRevision) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 返回该问题下所有已出新版的关联对象列表。
 */
export function getStaleObjects(db: Database, problemId: string): StaleObject[] {
  ensureControlSchema(db);
  const rows = db.query(`
    SELECT po.object_id, po.revision AS linked_revision, o.revision AS current_revision
    FROM control_context_problem_objects po
    JOIN control_context_objects o ON o.object_id = po.object_id
    WHERE po.problem_id = ? AND po.revision < o.revision
    ORDER BY po.object_id
  `).all(problemId) as Array<{ object_id: string; linked_revision: number; current_revision: number }>;

  return rows.map((r) => ({
    object_id: r.object_id,
    current_revision: r.current_revision,
    linked_revision: r.linked_revision,
  }));
}

// ========== 三入口同步复验 ==========

export type ReverifyEntry = "consume_decision" | "start_controlled_action" | "resume_from_checkpoint";

export type ReverifyResult =
  | { allowed: true }
  | { allowed: false; reason: string; code: "stale_or_revoked" | "permission_denied" | "evidence_mismatch" };

export type ReverifyInput = {
  entry: ReverifyEntry;
  work_id: string;
  actor: string;
  item_id?: string;
  contract_revision?: number;
  required_evidence_version?: number;
  problem_id?: string;
  /** 被授权对象（跨 work share 校验所需）。actor 非 decision_owner 时必填。 */
  object_id?: string;
  /** 被授权对象版本；"latest" 传对象当前 revision。与 object_id 绑定校验。 */
  revision?: number;
};

/**
 * 三入口同步复验：权限 + contract/policy 版本 + 证据版本。
 * 三项同时检查，任一失败即拒绝。只读检查，不修改状态。
 */
export function reverifyBeforeAction(db: Database, input: ReverifyInput): ReverifyResult {
  ensureControlSchema(db);
  const work = getWork(db, input.work_id);
  if (!work) {
    return { allowed: false, reason: "work not found", code: "permission_denied" };
  }

  // 1. 当前权限：actor 是否仍有有效 grant
  const decisionOwner = work.contract?.decision_owner;
  let hasPermission = false;
  if (decisionOwner && input.actor === decisionOwner) {
    hasPermission = true;
  } else {
    // 跨 work share 授权：必须精确绑定 object_id + revision + shared_with_work。
    // 旧实现 `WHERE shared_with_work=? LIMIT 1` 不绑对象——A work 的任意 share 即可
    // 授权 B work 对象。现改为 fail-closed：无法定位被授权对象即不授权。
    if (!input.object_id || !Number.isSafeInteger(input.revision) || input.revision < 1) {
      return {
        allowed: false,
        reason: "actor is not decision_owner; share authorization requires bound object_id and revision",
        code: "permission_denied",
      };
    }
    const shareRow = db.query(
      "SELECT 1 FROM control_context_shares WHERE object_id=? AND revision=? AND shared_with_work=?",
    ).get(input.object_id, input.revision, input.work_id) as { 1?: number } | null;
    if (shareRow) hasPermission = true;
  }
  if (!hasPermission) {
    return { allowed: false, reason: "actor no longer has valid grant", code: "permission_denied" };
  }

  // 2. contract/policy 版本一致性
  if (input.contract_revision !== undefined) {
    if (work.revision !== input.contract_revision) {
      return { allowed: false, reason: "contract revision mismatch", code: "stale_or_revoked" };
    }
  }

  // 3. required_evidence_version：证据是否仍有效（未被 purged）
  if (input.required_evidence_version !== undefined) {
    if (input.problem_id) {
      // 检查该问题关联的对象是否已被 purge
      const purgedRow = db.query(`
        SELECT 1
        FROM control_context_problem_objects po
        JOIN control_context_objects o ON o.object_id = po.object_id
        WHERE po.problem_id = ? AND o.purged_at IS NOT NULL
        LIMIT 1
      `).get(input.problem_id) as { 1?: number } | null;
      if (purgedRow) {
        return { allowed: false, reason: "evidence has been purged", code: "evidence_mismatch" };
      }
    }
    // 如果没有 problem_id，无法定位具体证据对象，跳过此项检查
  }

  return { allowed: true };
}

/**
 * 在 immediate 事务内执行复验 + 动作。复验失败抛 ControlError，事务回滚。
 */
export function withReverify<T>(db: Database, input: ReverifyInput, action: () => T): T {
  const tx = db.transaction(() => {
    const result = reverifyBeforeAction(db, input);
    if (!result.allowed) {
      throw new ControlError("blocked", `${result.code}: ${result.reason}`);
    }
    return action();
  });
  return tx.immediate() as T;
}

// ========== consumeDecision 集成 ==========

export type ConsumeDecisionInput = {
  work_id: string;
  actor: string;
  item_id: string;
  expected_revision: number;
  decision: AttentionDecisionInput;
  contract_revision?: number;
  problem_id?: string;
  required_evidence_version?: number;
  object_id?: string;
  revision?: number;
};

/**
 * 决策消费前同步复验，通过后才执行原消费逻辑。
 * 复验失败 → 拒绝消费，标 blocked(stale_or_revoked)，不静默继续。
 */
export function consumeDecisionWithReverify(db: Database, input: ConsumeDecisionInput): AttentionItem {
  return withReverify(db, {
    entry: "consume_decision",
    work_id: input.work_id,
    actor: input.actor,
    item_id: input.item_id,
    contract_revision: input.contract_revision,
    required_evidence_version: input.required_evidence_version,
    problem_id: input.problem_id,
    object_id: input.object_id,
    revision: input.revision,
  }, () => {
    return actOnAttention(db, input.item_id, input.expected_revision, "resolve", {
      selected_option: input.decision.selected_option,
      reason: input.decision.reason,
      replacement_contract: input.decision.replacement_contract,
      expected_contract_revision: input.decision.expected_contract_revision,
      affected_cards: input.decision.affected_cards,
    }, input.actor);
  });
}
