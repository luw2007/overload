/**
 * Overload P1 frozen contract — owner-authored, workers consume READ-ONLY.
 * Any change requires owner re-planning; do not edit in worker branches.
 * Source of truth: docs/plans/overload-20260813-tech-solution.md §2.1/§2.2.
 */

export const ENVELOPE_VERSION = 1;

/** From ~/.overload/host config file; never hostname. */
export type HostId = "local" | "devbox";

export type Runtime = "pi" | "omp" | "prime" | "claude" | "cmux" | "overload"; // "overload" = admin/recon self-events

/** <host_id>:<runtime>:<session-uuid> */
export type StableId = string;

/** <runtime>-<pid>-<proc_boot_id first 8> — one file, one emitter. */
export type EmitterId = string;

/** Incarnation lease id. pi/omp/prime: === emitter_id. claude: `claude-<session-uuid>`. */
export type WriterId = string;

export type EventKind =
  | "session_started"      // + lease: pid, proc_boot_id; cwd, branch, parent
  | "working"              // agent_start/turn_start (throttled: no resend on unchanged state)
  | "settled"              // agent_end/agent_settled (+ last assistant text ≤500B, UTF-8-safe pre-serialization truncation)
  | "decision_requested"   // ask tool_call; request_id = SDK toolCallId
  | "decision_resolved"    // ask tool_execution_end (+ state: resolved|cancelled, selected option)
  | "tool_activity"        // sampled heartbeat payload (≥5s interval)
  | "heartbeat"            // ≤60s in working state (turn timer covers long model calls)
  | "commit_observed"      // HEAD change after bash tool_result: {sha, repo}
  | "session_ended"        // session_shutdown
  | "events_dropped"       // {n} from resident counter
  | "classifier_activated" // admin spool only: {version}
  // ── P2 reconciliation findings (admin spool, runtime="overload", emitter=recon process) ──
  | "emitter_dead"         // {emitter_id, stable_id, pid, verified: "kill0"|"comm_mismatch"|"lease"}
  | "emitter_drained"      // {emitter_id, stable_id} — verified dead + 5min grace + ingest cursors at EOF for all its files; SOLE trigger for orphaning
  | "emitter_stalled"      // {emitter_id, stable_id, silent_ms} — heartbeat silence beyond profile ∧ pid alive
  | "telemetry_gap"        // {platform, native_id, cwd?} — live agent process observed with no/silent spool writer
  | "session_vanished"     // {stable_id, platform} — ONLY after a COMPLETE platform snapshot proves absence
  | "source_outage"        // {source} — platform CLI/host unreachable (aggregated: one event per outage start)
  | "source_recovered"     // {source}
  | "attachment_observed"; // {stable_id, platform, binding} — jump-target binding refresh

// ── P2 state vocabulary (frozen) ──
export type SessionState = "working" | "idle" | "awaiting_human" | "done" | "failed" | "vanished";
export type QueueName = "q1" | "q2" | "q3" | "q5";           // Q4 closed until P4
export type Q5Reason = "stalled" | "dead_incarnation" | "telemetry_gap" | "orphaned_request";
export type NotificationState = "pending" | "attempting" | "sent" | "failed_permanent";
export type NotificationKind = "initial" | "reminder";
/** Retry backoff for sink failures (minutes), then failed_permanent. */
export const SINK_BACKOFF_MIN = [1, 5, 15, 15, 15] as const;
export const REMINDER_INTERVAL_MS = 15 * 60_000;
export const DRAIN_GRACE_MS = 5 * 60_000;
export const ATTEMPTING_RETRY_GRACE_MS = 30_000;
/** Heartbeat-silence profiles (§2.4): narrow default, wide for long tasks. */
export const STALL_PROFILE_MS = { narrow: 30 * 60_000, wide: 120 * 60_000 } as const;

export interface EventEnvelope {
  v: typeof ENVELOPE_VERSION;
  /** Source-machine wall clock ms (display only; ordering is ingest seq). */
  at: number;
  host: HostId;
  runtime: Runtime;
  /** session uuid (not prefixed) */
  session: string;
  emitter_id: EmitterId;
  writer_id: WriterId;
  /** Monotonic per-emitter, starts at 1. */
  seq: number;
  kind: EventKind;
  /** Monotonic cumulative counters carried on EVERY event (R5-B2). */
  dropped_total: number;
  write_error_total: number;
  /** Kind-specific narrow payload; NEVER full tool payloads; secrets scrubbed. */
  detail?: Record<string, unknown>;
}

/** Spool layout (0700 dirs / 0600 files):
 *  ~/.overload/spool/<host_id>/<emitter_id>/active-<emitter_id>-<n>.ndjson
 *  sealed by rename → seg-<emitter_id>-<n>.ndjson  (30s | 1MB | process exit, first wins)
 *  Paths never reused; cursors keyed by unique filename.
 */
export const SPOOL_ROOT = "~/.overload/spool";
export const SEGMENT_MAX_AGE_MS = 30_000;
export const SEGMENT_MAX_BYTES = 1_048_576;
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const WRITE_QUEUE_LIMIT = 1000;

export type RequestState = "pending" | "resolved" | "cancelled" | "timed_out" | "orphaned";

/** request_uid = `${stable_id}#${writer_id}#${request_id}` */
export type RequestUid = string;

/** Journal event identity: UNIQUE(host, emitter_id, seq). Dedup basis for
 *  transport overlap (active + sealed), replay, and recovery. */
export interface JournalKey {
  host: HostId;
  emitter_id: EmitterId;
  seq: number;
}
