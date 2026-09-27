import { Database, SQLiteError } from "bun:sqlite";
import { ControlEventVerificationError, controlPayloadHash, verifyControlOutboxEvent, type VerifiedControlOutboxEvent } from "../../control/outbox";
import { CONTROL_SCHEMA_VERSION } from "../../control/store";
import type {
  ConditionWait, ObserveContext, WaitBaselineSnapshot, WaitErrorKind, WaitObservation, WaitSourceAdapter, Work, WorkBaseline, WorkCompletedCondition,
} from "../../control/types";

type WorkWait = ConditionWait & { condition: WorkCompletedCondition; baseline: WorkBaseline };
type WorkRow = { work_id: string; state: Work["state"]; revision: number };

const WORK_STATES: readonly unknown[] = ["candidate", "active", "stopped", "completed"];

/**
 * A classified source failure. `observe` returns it as an error observation; `establishBaseline` throws
 * it (same `error_kind` shape as the PR adapter's error) so the create caller maps it to a response.
 */
export class WorkSourceError extends Error {
  constructor(readonly error_kind: WaitErrorKind, message: string) { super(message); this.name = "WorkSourceError"; }
}

function classify(error: unknown): unknown {
  if (error instanceof WorkSourceError) return error;
  if (error instanceof ControlEventVerificationError) return new WorkSourceError("invalid_response", error.message);
  if (!(error instanceof SQLiteError)) return error;
  const code = typeof error.code === "string" ? error.code : "";
  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) return new WorkSourceError("transient", "control database is busy");
  if (code.startsWith("SQLITE_CANTOPEN")) return new WorkSourceError("source_missing", "control database cannot be opened");
  if (code.startsWith("SQLITE_PERM") || code.startsWith("SQLITE_AUTH")) return new WorkSourceError("permission_denied", "control database access denied");
  if (code.startsWith("SQLITE_CORRUPT") || code.startsWith("SQLITE_NOTADB")) return new WorkSourceError("invalid_response", "control database is corrupt");
  if (code === "SQLITE_ERROR") return new WorkSourceError("configuration", `control database is not readable as control v${CONTROL_SCHEMA_VERSION}: ${error.message.slice(0, 200)}`);
  return new WorkSourceError("unknown", `control database read failed (${code || "no code"})`);
}

/**
 * One read-only snapshot of the control DB. Store getters are deliberately not used: they run
 * `ensureControlSchema`, which may migrate or backfill (a write). The connection is `readonly`, the
 * reads share one deferred transaction, and a schema this adapter was not written for is `configuration`.
 */
function readControl<T>(controlPath: string, read: (db: Database) => T): T {
  let db: Database | null = null;
  try {
    db = new Database(controlPath, { readonly: true });
    const control = db;
    return control.transaction(() => {
      const meta = control.query("SELECT name FROM sqlite_master WHERE type='table' AND name='control_schema_meta'").get()
        ? control.query("SELECT version FROM control_schema_meta WHERE id=1").get() as { version: unknown } | null
        : null;
      if (meta?.version !== CONTROL_SCHEMA_VERSION) {
        throw new WorkSourceError("configuration", `control schema version ${String(meta?.version ?? "missing")} is not ${CONTROL_SCHEMA_VERSION}`);
      }
      return read(control);
    })() as T;
  } catch (error) {
    throw classify(error);
  } finally {
    db?.close();
  }
}

function readWork(db: Database, workId: string, role: string): WorkRow | null {
  const row = db.query("SELECT work_id,state,revision FROM control_works WHERE work_id=?").get(workId) as Record<string, unknown> | null;
  if (!row) return null;
  if (row.work_id !== workId || !WORK_STATES.includes(row.state) || typeof row.revision !== "number" || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new WorkSourceError("invalid_response", `${role} work row is malformed`);
  }
  return { work_id: workId, state: row.state as Work["state"], revision: row.revision };
}

/** The dependency and prerequisite facts every Work observation fingerprints; poll time is excluded. */
function sourceFacts(condition: WorkCompletedCondition, prerequisite: WorkRow) {
  return {
    prerequisite_work_id: condition.source.prerequisite_work_id, dependency_revision: condition.source.dependency_revision,
    work_revision: prerequisite.revision, state: prerequisite.state,
  };
}

/**
 * The authoritative completion transition for exactly this prerequisite revision: the single
 * `work.completed` outbox row, verified by the shared control verifier (producer, canonical payload
 * hash, enqueue identity), whose envelope and `payload.work` name this Work, revision and `completed`.
 */
function completionEvent(db: Database, prerequisiteWorkId: string, revision: number): VerifiedControlOutboxEvent {
  const invalid = (reason: string): never => { throw new WorkSourceError("invalid_response", `prerequisite revision ${revision}: ${reason}`); };
  const rows = db.query("SELECT * FROM control_outbox WHERE entity_id=? AND entity_version=? AND kind='work.completed'")
    .all(prerequisiteWorkId, revision) as Record<string, unknown>[];
  if (rows.length === 0) invalid("completed without an authoritative work.completed event");
  if (rows.length > 1) invalid("more than one work.completed event");
  const event = verifyControlOutboxEvent(db, rows[0]!);
  if (event.kind !== "work.completed" || event.entity_id !== prerequisiteWorkId || event.entity_version !== revision
    || event.work_id !== prerequisiteWorkId || event.item_id !== null) invalid("work.completed envelope does not name this prerequisite");
  const work = event.payload.work;
  if (!work || typeof work !== "object" || Array.isArray(work)) return invalid("work.completed payload has no work snapshot");
  const snapshot = work as Record<string, unknown>;
  if (snapshot.work_id !== prerequisiteWorkId || snapshot.revision !== revision || snapshot.state !== "completed") {
    invalid("work.completed payload does not match the completed prerequisite");
  }
  return event;
}

function evaluate(db: Database, wait: WorkWait, now: number): WaitObservation {
  const { prerequisite_work_id: prerequisiteWorkId, dependency_revision: dependencyRevision } = wait.condition.source;
  const configuration = (reason: string): never => { throw new WorkSourceError("configuration", reason); };
  if (!readWork(db, wait.work_id, "waiting")) configuration("waiting work no longer exists");
  const edge = db.query("SELECT revision,state FROM control_work_dependencies WHERE work_id=? AND prerequisite_work_id=?")
    .get(wait.work_id, prerequisiteWorkId) as { revision: unknown; state: unknown } | null;
  if (!edge) return configuration("dependency edge no longer exists");
  if (typeof edge.revision !== "number" || !Number.isSafeInteger(edge.revision) || (edge.state !== "active" && edge.state !== "revoked")) {
    throw new WorkSourceError("invalid_response", "dependency edge row is malformed");
  }
  if (edge.state !== "active") configuration(`dependency edge was revoked (revision ${edge.revision})`);
  if (edge.revision !== dependencyRevision) configuration(`dependency edge revision ${edge.revision} is not the waited revision ${dependencyRevision}`);
  const prerequisite = readWork(db, prerequisiteWorkId, "prerequisite");
  if (!prerequisite) throw new WorkSourceError("source_missing", "prerequisite work no longer exists");
  // Work revisions only grow; a revision below what this wait already recorded is a replaced or corrupted source.
  const highWater = Math.max(wait.baseline.work_revision, wait.source_generation);
  if (prerequisite.revision < highWater) throw new WorkSourceError("invalid_response", `prerequisite revision ${prerequisite.revision} regressed below ${highWater}`);
  const facts = sourceFacts(wait.condition, prerequisite);
  if (prerequisite.state === "completed" && prerequisite.revision > highWater) {
    const event = completionEvent(db, prerequisiteWorkId, prerequisite.revision);
    const readyFacts = { ...facts, completion_event_id: event.event_id };
    return { kind: "ready", observed: { ...readyFacts, observed_at: now }, fingerprint: controlPayloadHash(readyFacts), source_generation: prerequisite.revision, observed_at: now };
  }
  // Not a newer completion (still open, stopped, or completed at/below the baseline): quiet, never ready.
  const fingerprint = controlPayloadHash(facts);
  const same = fingerprint === wait.observed_fingerprint && prerequisite.revision === wait.source_generation;
  return { kind: same ? "same" : "changed_not_ready", observed: { ...facts, observed_at: now }, fingerprint, source_generation: prerequisite.revision, observed_at: now };
}

/**
 * Read-only `work_completed` source (§6.3). Every call opens the control DB read-only and closes it.
 * Ready requires the exact current active dependency edge and a prerequisite that is `completed` at a
 * revision strictly newer than the baseline and persisted source generation, proven by its own verified
 * `work.completed` outbox event. Stopped/archive/session exit/Attention/check facts are never read here.
 */
export function createWorkCompleteAdapter(deps: { controlPath: string }): WaitSourceAdapter<WorkCompletedCondition, WorkBaseline> {
  const { controlPath } = deps;
  return {
    kind: "work_completed",
    async establishBaseline(condition: WorkCompletedCondition, ctx: ObserveContext): Promise<WaitBaselineSnapshot<WorkBaseline>> {
      ctx.signal.throwIfAborted();
      const prerequisite = readControl(controlPath, (db) => {
        const row = readWork(db, condition.source.prerequisite_work_id, "prerequisite");
        if (!row) throw new WorkSourceError("source_missing", "prerequisite work not found");
        return row;
      });
      ctx.signal.throwIfAborted();
      const facts = sourceFacts(condition, prerequisite);
      return { baseline: { ...facts, observed_at: ctx.now }, baseline_generation: prerequisite.revision, fingerprint: controlPayloadHash(facts), established_at: ctx.now };
    },
    async observe(wait: WorkWait, ctx: ObserveContext): Promise<WaitObservation> {
      ctx.signal.throwIfAborted();
      let observation: WaitObservation;
      try {
        observation = readControl(controlPath, (db) => evaluate(db, wait, ctx.now));
      } catch (error) {
        if (!(error instanceof WorkSourceError)) throw error;
        observation = { kind: "error", error_kind: error.error_kind, detail: error.message, observed_at: ctx.now };
      }
      ctx.signal.throwIfAborted();
      return observation;
    },
  };
}
