import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ControlError, ensureControlSchema } from "./store";

// ========== 类型 ==========

export type ContextCtype = "objective" | "constraints" | "fact" | "decision" | "artifact" | "scene";
export type FactSubtype = "code_state" | "test_result" | "external_state" | "observation_evidence";
export type Sensitivity = "unknown" | "clean" | "suspected" | "confirmed_secret";
export type ProblemState = "open" | "resolved" | "superseded";
export type PinPurpose = "decision_evidence" | "recovery_checkpoint" | "other";
export type SourceType = "contract" | "attention" | "artifact" | "ledger_event" | "orchestrator" | "extension";

export type Problem = {
  problem_id: string;
  work_id: string;
  parent_problem_id: string | null;
  root_problem_id: string;
  title: string;
  state: ProblemState;
  revision: number;
  created_at: number;
  updated_at: number;
};

export type ContextObject = {
  object_id: string;
  work_id: string;
  primary_problem_id: string | null;
  ctype: ContextCtype;
  fact_subtype: FactSubtype | null;
  revision: number;
  purged_at: string | null;
  tombstone_reason: string | null;
  created_at: number;
  updated_at: number;
};

export type ObjectVersion = {
  object_id: string;
  revision: number;
  reference: string;
  source_type: SourceType;
  sensitivity: Sensitivity;
  shareable: number;
  expires_at: number | null;
  staleness_ms: number | null;
  collected_at: number | null;
  derived_from: string | null;
  summary_short: string | null;
  summary_long: string | null;
  content_hash: string;
  created_at: number;
};

export type ProblemObjectLink = {
  problem_id: string;
  object_id: string;
  revision: number;
  role: ContextCtype;
  created_at: number;
};

export type Pin = {
  pin_id: string;
  object_id: string;
  revision: number;
  pinned_by: string;
  purpose: PinPurpose;
  expires_at: number | null;
  created_at: number;
};

export type Share = {
  share_id: string;
  object_id: string;
  revision: number;
  shared_with_work: string;
  granted_by: string;
  granted_at: number;
};

// ========== 工具函数 ==========

export function now(): number {
  return Date.now();
}

function sha256Prefix(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

export function problemId(work_id: string, parent_problem_id: string | null, title: string): string {
  return sha256Prefix(work_id + (parent_problem_id ?? "") + title);
}

export function objectId(work_id: string, ctype: ContextCtype, canonical_key: string): string {
  return sha256Prefix(work_id + ctype + canonical_key);
}

const CTYPES: readonly ContextCtype[] = ["objective", "constraints", "fact", "decision", "artifact", "scene"];
const FACT_SUBTYPES: readonly FactSubtype[] = ["code_state", "test_result", "external_state", "observation_evidence"];

function isCtype(value: unknown): value is ContextCtype {
  return typeof value === "string" && (CTYPES as readonly string[]).includes(value);
}

// ========== row 映射 ==========

function problemFrom(row: Record<string, unknown>): Problem {
  return {
    problem_id: row.problem_id as string,
    work_id: row.work_id as string,
    parent_problem_id: row.parent_problem_id as string | null,
    root_problem_id: row.root_problem_id as string,
    title: row.title as string,
    state: row.state as ProblemState,
    revision: row.revision as number,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function objectFrom(row: Record<string, unknown>): ContextObject {
  return {
    object_id: row.object_id as string,
    work_id: row.work_id as string,
    primary_problem_id: row.primary_problem_id as string | null,
    ctype: row.ctype as ContextCtype,
    fact_subtype: row.fact_subtype as FactSubtype | null,
    revision: row.revision as number,
    purged_at: row.purged_at as string | null,
    tombstone_reason: row.tombstone_reason as string | null,
    created_at: row.created_at as number,
    updated_at: row.updated_at as number,
  };
}

function versionFrom(row: Record<string, unknown>): ObjectVersion {
  return {
    object_id: row.object_id as string,
    revision: row.revision as number,
    reference: row.reference as string,
    source_type: row.source_type as SourceType,
    sensitivity: row.sensitivity as Sensitivity,
    shareable: row.shareable as number,
    expires_at: row.expires_at as number | null,
    staleness_ms: row.staleness_ms as number | null,
    collected_at: row.collected_at as number | null,
    derived_from: row.derived_from as string | null,
    summary_short: row.summary_short as string | null,
    summary_long: row.summary_long as string | null,
    content_hash: row.content_hash as string,
    created_at: row.created_at as number,
  };
}

// ========== 问题树 ==========

export function getProblem(db: Database, problem_id: string): Problem | null {
  ensureControlSchema(db);
  const row = db.query("SELECT * FROM control_context_problems WHERE problem_id=?").get(problem_id) as Record<string, unknown> | null;
  return row ? problemFrom(row) : null;
}

export function getProblemTree(db: Database, work_id: string): Problem[] {
  ensureControlSchema(db);
  const rows = db.query("SELECT * FROM control_context_problems WHERE work_id=? ORDER BY created_at, problem_id").all(work_id) as Record<string, unknown>[];
  return rows.map(problemFrom);
}

export function createProblem(
  db: Database,
  input: { work_id: string; parent_problem_id?: string | null; title: string; root_problem_id?: string | null },
  nowTs = now(),
): Problem {
  ensureControlSchema(db);
  if (typeof input.work_id !== "string" || !input.work_id.trim()) throw new ControlError("invalid", "work_id is required");
  if (typeof input.title !== "string" || !input.title.trim()) throw new ControlError("invalid", "title is required");
  const parent_id = input.parent_problem_id ?? null;
  const new_id = problemId(input.work_id, parent_id, input.title);

  const tx = db.transaction(() => {
    if (getProblem(db, new_id)) throw new ControlError("conflict", "problem already exists");
    let root_problem_id: string;
    if (parent_id === null) {
      root_problem_id = new_id;
      if (input.root_problem_id !== undefined && input.root_problem_id !== null && input.root_problem_id !== new_id) {
        throw new ControlError("invalid", "root_problem_id mismatch on root problem");
      }
    } else {
      const parent = getProblem(db, parent_id);
      if (!parent) throw new ControlError("not_found", "parent problem not found");
      if (parent.work_id !== input.work_id) throw new ControlError("conflict", "cross-work parent is not allowed");
      root_problem_id = parent.root_problem_id;
      if (input.root_problem_id !== undefined && input.root_problem_id !== null && input.root_problem_id !== root_problem_id) {
        throw new ControlError("conflict", "root_problem_id mismatch with parent");
      }
      // 环检测：向上遍历 parent 链，遇新节点自身或重复节点（链中已有环）即拒绝。
      const visited = new Set<string>();
      let cursor: string | null = parent_id;
      while (cursor !== null) {
        if (cursor === new_id) throw new ControlError("conflict", "cyclic problem tree");
        if (visited.has(cursor)) throw new ControlError("conflict", "cyclic problem tree");
        visited.add(cursor);
        const node = getProblem(db, cursor);
        cursor = node ? node.parent_problem_id : null;
      }
    }
    const problem: Problem = {
      problem_id: new_id,
      work_id: input.work_id,
      parent_problem_id: parent_id,
      root_problem_id,
      title: input.title,
      state: "open",
      revision: 1,
      created_at: nowTs,
      updated_at: nowTs,
    };
    db.query("INSERT INTO control_context_problems(problem_id,work_id,parent_problem_id,root_problem_id,title,state,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(problem.problem_id, problem.work_id, problem.parent_problem_id, problem.root_problem_id, problem.title, problem.state, problem.revision, problem.created_at, problem.updated_at);
    return problem;
  });
  return tx.immediate() as Problem;
}

export function resolveProblem(db: Database, problem_id: string, expectedRevision: number, nowTs = now()): Problem {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new ControlError("invalid", "expected revision must be a positive integer");
  const tx = db.transaction(() => {
    const existing = getProblem(db, problem_id);
    if (!existing) throw new ControlError("not_found", "problem not found");
    if (existing.revision !== expectedRevision) throw new ControlError("conflict", "stale problem revision");
    if (existing.state !== "open") throw new ControlError("conflict", "problem is not open");
    const changed = db.query("UPDATE control_context_problems SET state='resolved', revision=?, updated_at=? WHERE problem_id=? AND revision=? AND state='open'")
      .run(existing.revision + 1, nowTs, problem_id, expectedRevision);
    if (!changed.changes) throw new ControlError("conflict", "stale problem revision");
    return getProblem(db, problem_id)!;
  });
  return tx.immediate() as Problem;
}

// ========== 对象与版本 ==========

export function getObject(db: Database, object_id: string): ContextObject | null {
  ensureControlSchema(db);
  const row = db.query("SELECT * FROM control_context_objects WHERE object_id=?").get(object_id) as Record<string, unknown> | null;
  return row ? objectFrom(row) : null;
}

export function getObjectVersion(db: Database, object_id: string, revision: number): ObjectVersion | null {
  ensureControlSchema(db);
  const row = db.query("SELECT * FROM control_context_object_versions WHERE object_id=? AND revision=?").get(object_id, revision) as Record<string, unknown> | null;
  return row ? versionFrom(row) : null;
}

export function getLatestVersion(db: Database, object_id: string): ObjectVersion | null {
  ensureControlSchema(db);
  const obj = getObject(db, object_id);
  if (!obj) return null;
  return getObjectVersion(db, object_id, obj.revision);
}

type CreateObjectInput = {
  work_id: string;
  ctype: ContextCtype;
  fact_subtype?: FactSubtype | null;
  primary_problem_id?: string | null;
  object_canonical_key: string;
  reference: string;
  source_type: SourceType;
  sensitivity?: Sensitivity;
  shareable?: number;
  content_hash: string;
  summary_short?: string | null;
  summary_long?: string | null;
  expires_at?: number | null;
  staleness_ms?: number | null;
  collected_at?: number | null;
  derived_from?: string | null;
};

export function createObject(db: Database, input: CreateObjectInput, nowTs = now()): ContextObject {
  ensureControlSchema(db);
  if (typeof input.work_id !== "string" || !input.work_id.trim()) throw new ControlError("invalid", "work_id is required");
  if (!isCtype(input.ctype)) throw new ControlError("invalid", "invalid ctype");
  if (typeof input.object_canonical_key !== "string" || !input.object_canonical_key.trim()) throw new ControlError("invalid", "object_canonical_key is required");
  if (typeof input.reference !== "string" || !input.reference.trim()) throw new ControlError("invalid", "reference is required");
  if (typeof input.content_hash !== "string" || !input.content_hash.trim()) throw new ControlError("invalid", "content_hash is required");
  // ctype='fact' 必须有 fact_subtype；非 fact 必须为 null。
  if (input.ctype === "fact") {
    if (typeof input.fact_subtype !== "string" || !(FACT_SUBTYPES as readonly string[]).includes(input.fact_subtype)) {
      throw new ControlError("invalid", "fact requires fact_subtype");
    }
  } else if (input.fact_subtype !== undefined && input.fact_subtype !== null) {
    throw new ControlError("invalid", "fact_subtype is only allowed on fact objects");
  }
  const sensitivity: Sensitivity = input.sensitivity ?? "unknown";
  const shareable = input.shareable ?? 0;
  if (sensitivity === "confirmed_secret" && shareable !== 0) throw new ControlError("invalid", "confirmed_secret objects cannot be shareable");

  const object_id = objectId(input.work_id, input.ctype, input.object_canonical_key);
  const tx = db.transaction(() => {
    if (getObject(db, object_id)) throw new ControlError("conflict", "object already exists");
    if (input.primary_problem_id != null && !getProblem(db, input.primary_problem_id)) throw new ControlError("not_found", "primary problem not found");
    db.query(`INSERT INTO control_context_objects(object_id,work_id,primary_problem_id,ctype,fact_subtype,revision,purged_at,tombstone_reason,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(object_id, input.work_id, input.primary_problem_id ?? null, input.ctype, input.ctype === "fact" ? input.fact_subtype : null, 1, null, null, nowTs, nowTs);
    db.query(`INSERT INTO control_context_object_versions(object_id,revision,reference,source_type,sensitivity,shareable,expires_at,staleness_ms,collected_at,derived_from,summary_short,summary_long,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(object_id, 1, input.reference, input.source_type, sensitivity, shareable, input.expires_at ?? null, input.staleness_ms ?? null, input.collected_at ?? null, input.derived_from ?? null, input.summary_short ?? null, input.summary_long ?? null, input.content_hash, nowTs);
    return getObject(db, object_id)!;
  });
  return tx.immediate() as ContextObject;
}

const VERSION_PATCH_FIELDS = ["reference", "source_type", "sensitivity", "shareable", "content_hash", "summary_short", "summary_long", "expires_at", "staleness_ms", "collected_at", "derived_from"] as const;
type VersionPatch = Partial<Pick<ObjectVersion, typeof VERSION_PATCH_FIELDS[number]>>;

export function updateObject(db: Database, input: { object_id: string; expectedRevision: number; patch: VersionPatch }, nowTs = now()): ObjectVersion {
  ensureControlSchema(db);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new ControlError("invalid", "expected revision must be a positive integer");
  const tx = db.transaction(() => {
    const obj = getObject(db, input.object_id);
    if (!obj) throw new ControlError("not_found", "object not found");
    if (obj.revision !== input.expectedRevision) throw new ControlError("conflict", "stale object revision");
    const current = getObjectVersion(db, input.object_id, obj.revision)!;
    const next: ObjectVersion = {
      ...current,
      ...input.patch,
      object_id: obj.object_id,
      revision: obj.revision + 1,
      created_at: nowTs,
    };
    if (next.sensitivity === "confirmed_secret" && next.shareable !== 0) throw new ControlError("invalid", "confirmed_secret objects cannot be shareable");
    // CAS：更新 objects 表头指针，revision 不匹配则冲突。
    const bumped = db.query("UPDATE control_context_objects SET revision=?, updated_at=? WHERE object_id=? AND revision=?")
      .run(next.revision, nowTs, obj.object_id, input.expectedRevision);
    if (!bumped.changes) throw new ControlError("conflict", "stale object revision");
    db.query(`INSERT INTO control_context_object_versions(object_id,revision,reference,source_type,sensitivity,shareable,expires_at,staleness_ms,collected_at,derived_from,summary_short,summary_long,content_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(next.object_id, next.revision, next.reference, next.source_type, next.sensitivity, next.shareable, next.expires_at, next.staleness_ms, next.collected_at, next.derived_from, next.summary_short, next.summary_long, next.content_hash, next.created_at);
    return next;
  });
  return tx.immediate() as ObjectVersion;
}

// ========== 关联 ==========

export function listObjectsByProblem(db: Database, problem_id: string): Array<{ object: ContextObject; version: ObjectVersion; role: ContextCtype }> {
  ensureControlSchema(db);
  const rows = db.query(`
    SELECT o.*, v.revision AS v_revision, v.reference, v.source_type, v.sensitivity, v.shareable, v.expires_at AS v_expires_at,
           v.staleness_ms, v.collected_at, v.derived_from, v.summary_short, v.summary_long, v.content_hash, v.created_at AS v_created_at,
           po.role
    FROM control_context_problem_objects po
    JOIN control_context_objects o ON o.object_id = po.object_id
    JOIN control_context_object_versions v ON v.object_id = po.object_id AND v.revision = po.revision
    WHERE po.problem_id = ?
    ORDER BY po.created_at, po.object_id`).all(problem_id) as Record<string, unknown>[];
  return rows.map((row) => {
    const object = objectFrom(row);
    const version = versionFrom({
      ...row,
      revision: row.v_revision,
      expires_at: row.v_expires_at,
      created_at: row.v_created_at,
    });
    return { object, version, role: row.role as ContextCtype };
  });
}

export function linkProblemObject(
  db: Database,
  input: { problem_id: string; object_id: string; revision?: number; role: ContextCtype },
  nowTs = now(),
): void {
  ensureControlSchema(db);
  if (input.revision === undefined || input.revision === null || !Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new ControlError("invalid", "revision is required");
  }
  if (!isCtype(input.role)) throw new ControlError("invalid", "invalid role");
  const revision: number = input.revision;
  const tx = db.transaction(() => {
    const problem = getProblem(db, input.problem_id);
    if (!problem) throw new ControlError("not_found", "problem not found");
    const object = getObject(db, input.object_id);
    if (!object) throw new ControlError("not_found", "object not found");
    const version = getObjectVersion(db, input.object_id, revision);
    if (!version) throw new ControlError("not_found", "object version not found");
    // 跨 work 关联必须有显式 share 记录且版本匹配。
    if (problem.work_id !== object.work_id) {
      const share = db.query("SELECT 1 FROM control_context_shares WHERE object_id=? AND revision=? AND shared_with_work=?")
        .get(input.object_id, revision, problem.work_id) as { 1?: number } | null;
      if (!share) throw new ControlError("conflict", "cross-work link requires a matching share");
    }
    db.query("INSERT INTO control_context_problem_objects(problem_id,object_id,revision,role,created_at) VALUES (?,?,?,?,?)")
      .run(input.problem_id, input.object_id, revision, input.role, nowTs);
  });
  tx.immediate();
}

export function unlinkProblemObject(db: Database, problem_id: string, object_id: string, role: ContextCtype): void {
  ensureControlSchema(db);
  db.query("DELETE FROM control_context_problem_objects WHERE problem_id=? AND object_id=? AND role=?").run(problem_id, object_id, role);
}
