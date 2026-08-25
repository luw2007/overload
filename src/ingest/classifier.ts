import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Version 2 remains active: the drained-emitter fix adds reducer-produced
 *  evidence about a request mutation; it does not reinterpret the journal
 *  event by itself or introduce a new replay epoch. */
export const CLASSIFIER_VERSION = 2;

export type ClassifiableCurrent = {
  stable_id: string;
  state: string;
  origin: string;
  queue: string | null;
  q5_reason: string | null;
  /** True when this session has a commit or a bash/write/edit tool event. */
  has_change_evidence?: boolean;
  /** True when the current emitter_drained event orphaned a pending request. */
  orphaned_request?: boolean;
};

export type ClassifierEvent = {
  ingest_seq: number;
  at: number;
  kind: string;
  detail: Record<string, unknown>;
};

export type QueueTransition = {
  subject: string;
  queue: string;
  direction: "entered" | "left";
  at: number;
  source_seq: number;
  classifier_version: number;
};

/** §2.4a origin normalization: any non-empty lineage that is not literally
 *  "human" (e.g. "orca:wt-123", parent stable ids) proves an agent launch;
 *  empty/unknown is treated as agent for Q2 (loop-1 E8). */
function normalizeOrigin(raw: string | null | undefined): "agent" | "human" | "unknown" {
  if (!raw || raw === "unknown") return "unknown";
  return raw === "human" ? "human" : "agent";
}

function desiredQueue(current: ClassifiableCurrent, event: ClassifierEvent): { queue: string | null; reason: string | null } {
  let state = current.state;
  let reason = current.q5_reason;
  switch (event.kind) {
    case "working": state = "working"; reason = null; break;
    case "settled": state = "idle"; reason = null; break;
    case "decision_requested": state = "awaiting_human"; break;
    case "decision_resolved": state = "idle"; reason = null; break;
    case "session_ended": state = "done"; reason = null; break;
    case "session_vanished": state = "vanished"; reason = null; break;
    case "emitter_stalled": reason = "stalled"; break;
    case "turn_hung": reason = "turn_hung"; break;
    case "dead_connection": reason = "dead_connection"; break;
    case "emitter_dead": reason = "dead_incarnation"; break;
    case "telemetry_gap": reason = "telemetry_gap"; break;
    case "emitter_drained": if (current.orphaned_request === true) reason = "orphaned_request"; break;
  }
  if (reason) return { queue: "q5", reason };
  if (state === "done" && normalizeOrigin(current.origin) === "agent" && current.has_change_evidence === false) {
    return { queue: "q4", reason: null };
  }
  if (state === "done" && normalizeOrigin(current.origin) !== "human") return { queue: "q2", reason: null };
  if (state === "working" || state === "idle") return { queue: "q3", reason: null };
  return { queue: null, reason: null };
}

/** Pure classifier v1. It does not mutate current or write the database. */
export function classify(current: ClassifiableCurrent, event: ClassifierEvent): QueueTransition[] {
  const desired = desiredQueue(current, event).queue;
  if (desired === current.queue) return [];
  const base = { subject: current.stable_id, at: event.at, source_seq: event.ingest_seq, classifier_version: CLASSIFIER_VERSION };
  const transitions: QueueTransition[] = [];
  if (current.queue) transitions.push({ ...base, queue: current.queue, direction: "left" });
  if (desired) transitions.push({ ...base, queue: desired, direction: "entered" });
  return transitions;
}

export function queueAfter(current: ClassifiableCurrent, event: ClassifierEvent): { queue: string | null; q5_reason: string | null } {
  const desired = desiredQueue(current, event);
  return { queue: desired.queue, q5_reason: desired.reason };
}

/** Append the replay-visible activation source event to the local admin spool. */
export function appendClassifierActivated(version: number, at: number, home = homedir(), spoolRoot = join(home, ".overload", "spool")): void {
  let host = "local";
  try {
    const configured = readFileSync(join(home, ".overload", "host"), "utf8").trim();
    if (configured) host = configured;
  } catch { /* default local */ }
  const directory = join(spoolRoot, host, "overload-admin");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, `active-overload-admin-${version}.ndjson`);
  const envelope = {
    v: 1, at, host, runtime: "overload", session: "admin", emitter_id: "overload-admin",
    writer_id: "overload-admin", seq: version, kind: "classifier_activated",
    dropped_total: 0, write_error_total: 0, detail: { version },
  };
  appendFileSync(path, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
