import type { Database } from "bun:sqlite";
import type { Checkpoint } from "./checkpoint";

/**
 * How long a launched checkpoint stays leased when its resumed runtime never reports `session_started`. Wait recovery's
 * effect window (`RECOVERY_EFFECT_WINDOW_MS`) is this same span: a launch unproven by then is `unknown`, never retried.
 */
export const LAUNCH_LEASE_TTL_MS = 120_000;

/** The control database that holds launch leases, with the clock that both acquisition and the gate read. */
export type LaunchLeases = { db: Database; now: () => number };

// Additive control-DB table, created on first acquisition; readers tolerate its absence.
const LEASE_SCHEMA = `CREATE TABLE IF NOT EXISTS resume_launch_leases(
  runtime TEXT NOT NULL, file TEXT NOT NULL, stable_id TEXT NOT NULL, holder TEXT NOT NULL,
  acquired_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(runtime, file))`;

/** Latest ingested `session_started` of the checkpoint's local runtime session; a later one releases the lease. */
function latestStart(ledger: Database, cp: Checkpoint): number | null {
  const row = ledger.query(`SELECT max(j.at) at FROM journal j JOIN sessions s ON s.stable_id=j.stable_id
    WHERE j.kind='session_started' AND s.host='local' AND s.runtime=? AND s.session=?`).get(cp.runtime, cp.session) as { at: number | null } | null;
  return row?.at ?? null;
}

/**
 * A launch of this checkpoint (runtime + session file) is in flight: a lease is unexpired and no `session_started`
 * has been ingested since it was taken. Read-only; a control DB without the table holds no lease.
 */
export function launchInFlight(ledger: Database, leases: LaunchLeases, cp: Checkpoint): boolean {
  if (!leases.db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='resume_launch_leases'").get()) return false;
  const lease = leases.db.query("SELECT acquired_at, expires_at FROM resume_launch_leases WHERE runtime=? AND file=?")
    .get(cp.runtime, cp.file) as { acquired_at: number; expires_at: number } | null;
  if (!lease || lease.expires_at <= leases.now()) return false;
  const started = latestStart(ledger, cp);
  return started === null || started < lease.acquired_at;
}

/**
 * Takes the launch lease for this checkpoint in one INSERT…ON CONFLICT: it lands only when no lease exists, the
 * existing one has expired, or a `session_started` was ingested at or after it was taken. Returns whether this caller
 * holds it; exactly one of any number of concurrent callers (Web resume, wait dispatch, other processes) wins.
 */
export function acquireLaunchLease(ledger: Database, leases: LaunchLeases, cp: Checkpoint, stableId: string, holder: string): boolean {
  leases.db.exec(LEASE_SCHEMA);
  const now = leases.now();
  const started = latestStart(ledger, cp);
  const landed = leases.db.query(`INSERT INTO resume_launch_leases(runtime, file, stable_id, holder, acquired_at, expires_at) VALUES(?,?,?,?,?,?)
    ON CONFLICT(runtime, file) DO UPDATE SET stable_id=excluded.stable_id, holder=excluded.holder, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at
    WHERE resume_launch_leases.expires_at<=excluded.acquired_at OR resume_launch_leases.acquired_at<=?`)
    .run(cp.runtime, cp.file, stableId, holder, now, now + LAUNCH_LEASE_TTL_MS, started ?? Number.MIN_SAFE_INTEGER);
  return landed.changes === 1;
}
