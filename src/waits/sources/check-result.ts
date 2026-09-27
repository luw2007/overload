import { Database, SQLiteError } from "bun:sqlite";
import { accessSync, constants, statSync } from "node:fs";
import { controlPayloadHash } from "../../control/outbox";
import type {
  CheckBaseline, CheckNewResultCondition, ConditionWait, ObserveContext, WaitBaselineSnapshot, WaitErrorKind, WaitObservation, WaitSourceAdapter,
} from "../../control/types";
import { getCheckResults, getNextResultSetVersion, type CheckResult } from "../../orchestrator/anomaly-store";

type CheckWait = ConditionWait & { condition: CheckNewResultCondition; baseline: CheckBaseline };
type CheckSource = CheckNewResultCondition["source"];

// B-ORCH-CHECK-PK proof: the migrated durable key, and the non-empty Work column schema.sql declares.
const CHECK_RESULTS_KEY = "work_id,result_set_version,check_id";
const REQUIRED_WORK_ID = /\bwork_id\s+TEXT\s+NOT\s+NULL\s+CHECK\s*\(\s*work_id\s*<>\s*''\s*\)/i;
const RESULT_COLUMNS = "result_set_version,work_id,task_id,attempt_id,observed_at,check_id,status,fingerprint,check_def_version,evidence_ref";
const CHECK_STATUSES: readonly unknown[] = ["pass", "fail", "unknown", "not_run"];

/**
 * Classified source failure. `establishBaseline` throws it (wait creation fails closed); `observe` returns it
 * as a `{kind:'error'}` observation so the runner persists the category instead of treating it as quiet or ready.
 */
export class CheckSourceError extends Error {
  readonly error_kind: WaitErrorKind;
  constructor(error_kind: WaitErrorKind, detail: string) {
    super(detail);
    this.name = "CheckSourceError";
    this.error_kind = error_kind;
  }
}

function classify(error: unknown): unknown {
  if (error instanceof CheckSourceError || !(error instanceof SQLiteError)) return error;
  const code = typeof error.code === "string" ? error.code : "";
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return new CheckSourceError("transient", "orchestrator database is busy");
  // The file was just found readable, so this is not a missing source: a read-only open also fails when a WAL
  // database has no -shm index and no running writer to create it. Neither cause is proven, so it is `unknown`.
  if (code.startsWith("SQLITE_CANTOPEN")) return new CheckSourceError("unknown", "orchestrator database exists but cannot be opened read-only");
  if (code.startsWith("SQLITE_PERM") || code.startsWith("SQLITE_AUTH")) return new CheckSourceError("permission_denied", "orchestrator database access denied");
  if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) return new CheckSourceError("invalid_response", "orchestrator database is corrupt");
  if (code === "SQLITE_ERROR") return new CheckSourceError("configuration", `orchestrator database does not have the check-result schema: ${error.message.slice(0, 200)}`);
  return new CheckSourceError("unknown", `orchestrator database read failed (${code || "no code"})`);
}

/**
 * Without the migrated `(work_id,result_set_version,check_id)` key and a required non-empty Work ID,
 * result_set_version is not scoped to one Work and no row can be attributed; the adapter never
 * reads such a table compatibly and never migrates it (§6.2).
 */
function assertMigratedCheckResults(db: Database): void {
  const tables = db.query("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('attempt_check_results','attempt_signal_samples')")
    .all() as { name: string; sql: unknown }[];
  const results = tables.find((table) => table.name === "attempt_check_results");
  if (!results || !tables.some((table) => table.name === "attempt_signal_samples")) throw new CheckSourceError("source_missing", "orchestrator check-result tables not found");
  const columns = db.query("PRAGMA table_xinfo(attempt_check_results)").all() as { name: string; notnull: number; pk: number }[];
  const key = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name).join(",");
  const workId = columns.find((column) => column.name === "work_id");
  if (key !== CHECK_RESULTS_KEY || workId?.notnull !== 1 || typeof results.sql !== "string" || !REQUIRED_WORK_ID.test(results.sql)) {
    throw new CheckSourceError("configuration", `attempt_check_results is not migrated to a required-Work (${CHECK_RESULTS_KEY}) key`);
  }
}

/** One read-only snapshot of the orchestrator DB: every read shares one deferred transaction; nothing is written. */
function readOrchestrator<T>(orchestratorPath: string, read: (db: Database) => T): T {
  let db: Database | null = null;
  try {
    try {
      if (!statSync(orchestratorPath).isFile()) throw new CheckSourceError("source_missing", "orchestrator database is not a file");
      accessSync(orchestratorPath, constants.R_OK);
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (error instanceof CheckSourceError) throw error;
      if (code === "ENOENT" || code === "ENOTDIR") throw new CheckSourceError("source_missing", "orchestrator database not found");
      if (code === "EACCES" || code === "EPERM") throw new CheckSourceError("permission_denied", "orchestrator database access denied");
      throw new CheckSourceError("unknown", `orchestrator database is not accessible (${typeof code === "string" ? code : "no code"})`);
    }
    const orchestrator = new Database(orchestratorPath, { readonly: true });
    db = orchestrator;
    return orchestrator.transaction(() => {
      assertMigratedCheckResults(orchestrator);
      return read(orchestrator);
    })() as T;
  } catch (error) {
    throw classify(error);
  } finally {
    db?.close();
  }
}

/** Highest result_set_version this Work has allocated across samples and results (0 when none). */
function workResultSetVersion(db: Database, workId: string): number {
  const version = getNextResultSetVersion(db, workId) - 1;
  if (!Number.isSafeInteger(version) || version < 0) throw new CheckSourceError("invalid_response", "work result_set_version is malformed");
  return version;
}

function resultRow(row: Record<string, unknown>, source: CheckSource): CheckResult {
  const text = (value: unknown) => value === null || typeof value === "string";
  if (row.work_id !== source.work_id || !Number.isSafeInteger(row.result_set_version) || (row.result_set_version as number) < 0
    || typeof row.task_id !== "string" || typeof row.attempt_id !== "string" || typeof row.check_id !== "string"
    || !Number.isSafeInteger(row.observed_at) || (row.observed_at as number) < 0 || !CHECK_STATUSES.includes(row.status)
    || !text(row.fingerprint) || !text(row.check_def_version) || !text(row.evidence_ref)) {
    throw new CheckSourceError("invalid_response", `check result row at result_set_version ${String(row.result_set_version)} is malformed`);
  }
  return row as CheckResult;
}

/** The exact check identity every fingerprint carries. */
function identity(source: CheckSource) {
  return {
    work_id: source.work_id, task_id: source.task_id, attempt_id: source.attempt_id,
    check_id: source.check_id, check_def_version: source.check_def_version,
  };
}

function evaluate(db: Database, wait: CheckWait, now: number): WaitObservation {
  const source = wait.condition.source;
  const highWater = Math.max(wait.baseline.result_set_version, wait.source_generation);
  const workVersion = workResultSetVersion(db, source.work_id);
  // result_set_version only grows within a Work; a lower maximum means the source was replaced or truncated.
  if (workVersion < highWater) throw new CheckSourceError("invalid_response", `work result_set_version ${workVersion} regressed below ${highWater}`);
  // Only the exact work/task/attempt/check strictly after the high-water mark can be new. Other Works, tasks,
  // attempts or checks, and replayed or out-of-order versions at or below the mark, are never read.
  const rows = (db.query(`SELECT ${RESULT_COLUMNS} FROM attempt_check_results
    WHERE work_id=? AND task_id=? AND attempt_id=? AND check_id=? AND result_set_version>? ORDER BY result_set_version DESC`)
    .all(source.work_id, source.task_id, source.attempt_id, source.check_id, highWater) as Record<string, unknown>[])
    .map((row) => resultRow(row, source));
  // The latest exact-definition result is the current fact; a different definition never maps onto this one.
  const result = rows.find((row) => row.check_def_version === source.check_def_version);
  if (result) {
    const version = result.result_set_version;
    // One producer writes one result set; a version shared by different task/attempt/sample writers is a content conflict.
    const results = getCheckResults(db, source.work_id, version).map((row) => resultRow(row, source));
    const samples = db.query("SELECT task_id,attempt_id FROM attempt_signal_samples WHERE work_id=? AND result_set_version=?")
      .all(source.work_id, version) as { task_id: unknown; attempt_id: unknown }[];
    if (results.some((row) => row.task_id !== result.task_id || row.attempt_id !== result.attempt_id || row.observed_at !== result.observed_at)
      || samples.some((row) => row.task_id !== result.task_id || row.attempt_id !== result.attempt_id)) {
      throw new CheckSourceError("invalid_response", `result_set_version ${version} holds conflicting writers`);
    }
    const facts = { ...identity(source), result_set_version: version, status: result.status, result_fingerprint: result.fingerprint, evidence_ref: result.evidence_ref };
    return { kind: "ready", observed: { ...facts, result_observed_at: result.observed_at }, fingerprint: controlPayloadHash(facts), source_generation: version, observed_at: now };
  }
  // A NULL/empty/'unknown' definition cannot prove it is (or is not) the awaited definition.
  const unproven = rows.find((row) => row.check_def_version === null || row.check_def_version === "" || row.check_def_version === "unknown");
  if (unproven) throw new CheckSourceError("invalid_response", `check result at result_set_version ${unproven.result_set_version} has no exact check definition`);
  const facts = { ...identity(source), result_set_version: highWater };
  const fingerprint = controlPayloadHash(facts);
  const same = fingerprint === wait.observed_fingerprint && highWater === wait.source_generation;
  return { kind: same ? "same" : "changed_not_ready", observed: { ...facts, work_result_set_version: workVersion }, fingerprint, source_generation: highWater, observed_at: now };
}

/**
 * Read-only `check_new_result` source (§6.2). Every call opens the orchestrator DB read-only and closes it;
 * it never runs `orchestrator.check`, writes a sample, migrates, or calls a model. The baseline is the Work's
 * current highest result_set_version; ready requires a row for the exact work/task/attempt/check/definition at
 * a strictly later version than both the baseline and the persisted source generation, and that version is
 * the ready generation — a new result set is ready even when its status and fingerprint repeat.
 */
export function createCheckResultAdapter(deps: { orchestratorPath: string }): WaitSourceAdapter<CheckNewResultCondition, CheckBaseline> {
  const { orchestratorPath } = deps;
  return {
    kind: "check_new_result",
    async establishBaseline(condition: CheckNewResultCondition, ctx: ObserveContext): Promise<WaitBaselineSnapshot<CheckBaseline>> {
      ctx.signal.throwIfAborted();
      const source = condition.source;
      const sampled = readOrchestrator(orchestratorPath, (db) => {
        const version = workResultSetVersion(db, source.work_id);
        const last = db.query(`SELECT ${RESULT_COLUMNS} FROM attempt_check_results
          WHERE work_id=? AND task_id=? AND attempt_id=? AND check_id=? AND check_def_version=? ORDER BY result_set_version DESC LIMIT 1`)
          .get(source.work_id, source.task_id, source.attempt_id, source.check_id, source.check_def_version) as Record<string, unknown> | null;
        return { version, observedAt: last ? resultRow(last, source).observed_at : null };
      });
      ctx.signal.throwIfAborted();
      return {
        baseline: {
          attempt_id: source.attempt_id, check_id: source.check_id, check_def_version: source.check_def_version,
          result_set_version: sampled.version, observed_at: sampled.observedAt,
        },
        baseline_generation: sampled.version,
        fingerprint: controlPayloadHash({ ...identity(source), result_set_version: sampled.version }),
        established_at: ctx.now,
      };
    },
    async observe(wait: CheckWait, ctx: ObserveContext): Promise<WaitObservation> {
      ctx.signal.throwIfAborted();
      let observation: WaitObservation;
      try {
        observation = readOrchestrator(orchestratorPath, (db) => evaluate(db, wait, ctx.now));
      } catch (error) {
        if (!(error instanceof CheckSourceError)) throw error;
        observation = { kind: "error", error_kind: error.error_kind, detail: error.message, observed_at: ctx.now };
      }
      ctx.signal.throwIfAborted();
      return observation;
    },
  };
}
