import type { Database } from "bun:sqlite";
import { getConditionWait } from "../control/store";
import type { ConditionWait } from "../control/types";

/**
 * Failure budget for maintenance disposition work (pending redecisions/dispatches and in-flight recovery effects).
 * A row whose processing fails with anything but CAS contention is backed off instead of being retried at the head of
 * the oldest-first list every round, and is parked after `DISPOSITION_FAILURE_BUDGET` failures at the same wait
 * version, so a poison row can neither loop forever nor starve newer rows. Counts reset when the wait's version moves.
 */
export const DISPOSITION_FAILURE_BUDGET = 3;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
const ERROR_MAX = 400;

// Additive control-DB table owned by this module; created on first use.
const FAILURE_SCHEMA = `CREATE TABLE IF NOT EXISTS wait_disposition_failures(
  wait_id TEXT PRIMARY KEY, wait_version INTEGER NOT NULL, failures INTEGER NOT NULL, last_error TEXT NOT NULL,
  failed_at INTEGER NOT NULL, retry_at INTEGER NOT NULL, parked_at INTEGER)`;

/**
 * Oldest-first waits in `states` that are not backed off or parked at their current version. The exclusion is in SQL,
 * so `limit` rows of healthy work are returned however many failing rows are older.
 */
export function listDispositionWork(control: Database, states: readonly string[], now: number, limit: number): ConditionWait[] {
  control.exec(FAILURE_SCHEMA);
  const rows = control.query(`SELECT w.wait_id FROM control_waits w
    WHERE w.disposition_state IN (${states.map(() => "?").join(",")})
      AND NOT EXISTS (SELECT 1 FROM wait_disposition_failures f
        WHERE f.wait_id=w.wait_id AND f.wait_version=w.version AND (f.parked_at IS NOT NULL OR f.retry_at>?))
    ORDER BY w.updated_at, w.wait_id LIMIT ?`).all(...states, now, limit) as Array<{ wait_id: string }>;
  return rows.map((row) => getConditionWait(control, row.wait_id)).filter((wait): wait is ConditionWait => wait !== null);
}

/** Counts one failure of `wait` at its version and schedules its backoff; `parked` once the budget is spent. */
export function recordDispositionFailure(control: Database, wait: ConditionWait, error: string, now: number): { failures: number; parked: boolean } {
  control.exec(FAILURE_SCHEMA);
  return control.transaction(() => {
    const { failures } = control.query(`INSERT INTO wait_disposition_failures(wait_id, wait_version, failures, last_error, failed_at, retry_at)
      VALUES(?,?,1,?,?,?) ON CONFLICT(wait_id) DO UPDATE SET
        failures=CASE WHEN wait_version=excluded.wait_version THEN failures+1 ELSE 1 END,
        wait_version=excluded.wait_version, last_error=excluded.last_error, failed_at=excluded.failed_at, parked_at=NULL
      RETURNING failures`).get(wait.wait_id, wait.version, error.slice(0, ERROR_MAX), now, now) as { failures: number };
    const parked = failures >= DISPOSITION_FAILURE_BUDGET;
    control.query("UPDATE wait_disposition_failures SET retry_at=?, parked_at=? WHERE wait_id=?")
      .run(now + Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS), parked ? now : null, wait.wait_id);
    return { failures, parked };
  }).immediate();
}
