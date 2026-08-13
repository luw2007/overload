/**
 * §2.2 requests state machine — N3 reference implementation (P1 scope:
 * requests lifecycle only, as specified in N2-TASK.md).
 *
 * Contract (verbatim from §2.2):
 *   - state machine: pending → resolved | cancelled | timed_out | orphaned
 *   - idempotent transitions
 *   - out-of-order: terminal-before-pending → create row directly in terminal
 *     state (so a late decision_resolved arriving before its decision_requested
 *     still creates the row in resolved state)
 *   - orphaned is an INFERRED terminal; resolved/cancelled/timed_out are SOURCE
 *     terminals; any SOURCE terminal may override an INFERRED terminal
 *     (orphaned → {resolved,cancelled,timed_out}, backed by a source event,
 *     idempotent)
 *   - source terminals are mutually exclusive: resolved→cancelled REJECTED
 *   - duplicate same-state rows: harmless skip
 *
 * The reducer runs this inside the same transaction as reading the journal
 * batch + advancing reducer_cursor (§2.4b). Here we expose the per-event
 * transition function so tests can drive it directly.
 */
import { Database } from "bun:sqlite";
import type { RequestState } from "../../src/shared/types";

export type RequestStateP1 = Extract<
  RequestState,
  "pending" | "resolved" | "cancelled" | "timed_out" | "orphaned"
>;

export const SOURCE_TERMINALS: RequestStateP1[] = ["resolved", "cancelled", "timed_out"];
export const INFERRED_TERMINALS: RequestStateP1[] = ["orphaned"];
export const ALL_STATES: RequestStateP1[] = ["pending", ...SOURCE_TERMINALS, ...INFERRED_TERMINALS];

export type TransitionOutcome =
  | { ok: true; kind: "inserted" | "advanced" | "noop_same_state" }
  | { ok: false; kind: "rejected_source_conflict"; from: RequestStateP1; to: RequestStateP1 };

export interface RequestRow {
  request_uid: string;
  stable_id: string;
  writer_id: string;
  origin_emitter_id: string;
  request_id: string;
  kind: string;
  state: RequestStateP1;
  created_at: number;
  resolved_at: number | null;
}

export interface ApplyOpts {
  now?: number;
}

const selReq = "SELECT state FROM requests WHERE request_uid = ?";

/**
 * Apply a transition `to` for the given request identity. Implements the §2.2
 * rules exactly. Idempotent and safe under replay (the reducer may see the same
 * journal seq again after a crash).
 */
export function applyRequestTransition(
  db: Database,
  req: Omit<RequestRow, "state" | "resolved_at" | "created_at"> &
    Partial<Pick<RequestRow, "created_at">>,
  to: RequestStateP1,
  opts: ApplyOpts = {},
): TransitionOutcome {
  const now = opts.now ?? 1_700_000_000_000;
  const get = db.prepare(selReq);
  const existing = get.get(req.request_uid) as { state: RequestStateP1 } | null;

  if (!existing) {
    // No row yet: insert directly into `to` state. This handles BOTH the normal
    // pending-creation case AND the out-of-order terminal-first case.
    const resolvedAt = to !== "pending" ? now : null;
    db.prepare(
      `INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, resolved_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      req.request_uid,
      req.stable_id,
      req.writer_id,
      req.origin_emitter_id,
      req.request_id,
      req.kind,
      to,
      req.created_at ?? now,
      resolvedAt,
    );
    return { ok: true, kind: "inserted" };
  }

  const from = existing.state;

  // Same-state duplicate: idempotent skip.
  if (from === to) return { ok: true, kind: "noop_same_state" };

  // §2.4a: terminals are sticky. A late `pending` (decision_requested seen
  // after its terminal, e.g. transport reordering) CANNOT demote a terminal.
  // Only the orphaned→source override path can move out of a terminal.
  const fromIsTerminal = [...SOURCE_TERMINALS, ...INFERRED_TERMINALS].includes(from);
  if (fromIsTerminal && to === "pending") {
    return { ok: true, kind: "noop_same_state" };
  }

  // Source terminals are mutually exclusive.
  const fromIsSource = SOURCE_TERMINALS.includes(from);
  const toIsSource = SOURCE_TERMINALS.includes(to);
  if (fromIsSource && toIsSource) {
    return { ok: false, kind: "rejected_source_conflict", from, to };
  }

  // orphaned (inferred) → source terminal: ALLOWED (override inferred with source).
  // pending → anything: allowed.
  // source → orphaned: NOT allowed by §2.2 (source terminals are sticky; only
  // the inferred state can be overridden, not the other way). We treat source→
  // orphaned as rejected too (it's a source-vs-inferred conflict where source
  // wins — the existing source terminal is authoritative).
  if (fromIsSource && to === "orphaned") {
    // Source terminal already recorded; inferred orphan is stale. Keep source.
    return { ok: true, kind: "noop_same_state" };
  }

  // Allowed transition: pending→terminal, orphaned→source.
  const resolvedAt = to !== "pending" ? now : null;
  db.prepare(
    `UPDATE requests SET state = ?, resolved_at = COALESCE(resolved_at, ?) WHERE request_uid = ?`,
  ).run(to, resolvedAt, req.request_uid);
  return { ok: true, kind: "advanced" };
}

/** Convenience: read a request row by uid. */
export function getRequest(db: Database, request_uid: string): RequestRow | undefined {
  const r = db
    .prepare("SELECT * FROM requests WHERE request_uid = ?")
    .get(request_uid) as RequestRow | null;
  return r ?? undefined;
}

/**
 * Build the canonical request_uid = `<stable_id>#<writer_id>#<request_id>` (§2.2).
 */
export function requestUid(stable_id: string, writer_id: string, request_id: string): string {
  return `${stable_id}#${writer_id}#${request_id}`;
}
