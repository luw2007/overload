/**
 * Envelope helpers — assert against the FROZEN contract in src/shared/types.ts.
 *
 * The EventEnvelope field set (names + types) is frozen. These helpers are the
 * N3 reference for: (a) building well-formed envelopes, and (b) validating that
 * a parsed line conforms to the contract exactly. N1's emitter and N3's tests
 * must agree on this shape.
 */
import {
  ENVELOPE_VERSION,
  type EventEnvelope,
  type EventKind,
  type HostId,
  type Runtime,
} from "../../src/shared/types";

/** Exact field list from EventEnvelope (types.ts), in declaration order. */
export const ENVELOPE_REQUIRED_FIELDS = [
  "v",
  "at",
  "host",
  "runtime",
  "session",
  "emitter_id",
  "writer_id",
  "seq",
  "kind",
  "dropped_total",
  "write_error_total",
] as const;

/** Optional field (detail). */
export const ENVELOPE_OPTIONAL_FIELDS = ["detail"] as const;

export const ALL_ENVELOPE_TOP_LEVEL_FIELDS = [
  ...ENVELOPE_REQUIRED_FIELDS,
  ...ENVELOPE_OPTIONAL_FIELDS,
] as const;

export const VALID_HOST_IDS: HostId[] = ["local", "devbox"];
export const VALID_RUNTIMES: Runtime[] = ["pi", "omp", "prime", "claude", "cmux"];

/** EventKind union from types.ts — frozen. */
export const VALID_EVENT_KINDS: readonly EventKind[] = [
  "session_started",
  "working",
  "settled",
  "decision_requested",
  "decision_resolved",
  "tool_activity",
  "heartbeat",
  "commit_observed",
  "session_ended",
  "events_dropped",
  "classifier_activated",
];

export type PrimitiveName =
  | "number"
  | "string"
  | "object"
  | "undefined"
  | "literal_1"
  | "enum_host"
  | "enum_runtime"
  | "enum_kind";

/** Field → expected primitive contract (mirrors types.ts types). */
export const ENVELOPE_FIELD_TYPES: Record<string, PrimitiveName> = {
  v: "literal_1",
  at: "number",
  host: "enum_host",
  runtime: "enum_runtime",
  session: "string",
  emitter_id: "string",
  writer_id: "string",
  seq: "number",
  kind: "enum_kind",
  dropped_total: "number",
  write_error_total: "number",
  detail: "object",
};

export interface EnvelopeValidationError {
  field: string;
  reason: string;
}

/**
 * Validate that `line` (a parsed object, e.g. from one NDJSON line) conforms
 * EXACTLY to the frozen envelope contract. Returns [] on success, a list of
 * structured violations otherwise.
 *
 * "Exactly" means:
 *  - all required fields present
 *  - no unknown top-level fields (the contract is narrow; detail is the only
 *    optional escape hatch and is itself an opaque Record)
 *  - types match types.ts
 *  - v === ENVELOPE_VERSION
 *  - host/runtime/kind ∈ frozen unions
 */
export function validateEnvelope(obj: unknown): EnvelopeValidationError[] {
  const errs: EnvelopeValidationError[] = [];
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return [{ field: "(root)", reason: "envelope must be a JSON object" }];
  }
  const o = obj as Record<string, unknown>;

  // Required presence.
  for (const f of ENVELOPE_REQUIRED_FIELDS) {
    if (!(f in o)) errs.push({ field: f, reason: "missing required field" });
  }

  // No unknown top-level fields.
  const allowed = new Set<string>(ALL_ENVELOPE_TOP_LEVEL_FIELDS);
  for (const k of Object.keys(o)) {
    if (!allowed.has(k)) errs.push({ field: k, reason: "unknown top-level field" });
  }

  // §2.1: seq is "Monotonic per-emitter, starts at 1" — must be a positive int.
  if (typeof o.seq === "number" && Number.isInteger(o.seq) && o.seq < 1) {
    errs.push({ field: "seq", reason: "seq must be a positive integer (>=1, starts at 1)" });
  }

  // Type / enum checks.
  for (const [field, expected] of Object.entries(ENVELOPE_FIELD_TYPES)) {
    if (!(field in o)) continue; // already reported
    const val = o[field];
    switch (expected) {
      case "literal_1":
        if (val !== ENVELOPE_VERSION)
          errs.push({ field, reason: `v must equal ENVELOPE_VERSION (${ENVELOPE_VERSION})` });
        break;
      case "number":
        if (typeof val !== "number" || !Number.isFinite(val) || !Number.isInteger(val))
          errs.push({ field, reason: "must be a finite integer number" });
        break;
      case "string":
        if (typeof val !== "string" || val.length === 0)
          errs.push({ field, reason: "must be a non-empty string" });
        break;
      case "object":
        if (val !== undefined && (typeof val !== "object" || val === null || Array.isArray(val)))
          errs.push({ field, reason: "must be a JSON object (Record) when present" });
        break;
      case "enum_host":
        if (!VALID_HOST_IDS.includes(val as HostId))
          errs.push({ field, reason: `host must be one of ${VALID_HOST_IDS.join("|")}` });
        break;
      case "enum_runtime":
        if (!VALID_RUNTIMES.includes(val as Runtime))
          errs.push({ field, reason: `runtime must be one of ${VALID_RUNTIMES.join("|")}` });
        break;
      case "enum_kind":
        if (!VALID_EVENT_KINDS.includes(val as EventKind))
          errs.push({ field, reason: `kind must be one of ${VALID_EVENT_KINDS.join("|")}` });
        break;
    }
  }
  return errs;
}

/**
 * Parse a single NDJSON line into an object and validate it. Throws on malformed
 * JSON; returns { obj, errors } otherwise so callers can assert on either.
 */
export function parseEnvelopeLine(line: string): { obj: unknown; errors: EnvelopeValidationError[] } {
  const obj = JSON.parse(line);
  return { obj, errors: validateEnvelope(obj) };
}

/** Build a well-formed envelope (for synthetic spools). */
export interface BuildEnvelopeOpts {
  at?: number;
  host?: HostId;
  runtime?: Runtime;
  session?: string;
  emitter_id: string;
  writer_id?: string;
  seq: number;
  kind?: EventKind;
  dropped_total?: number;
  write_error_total?: number;
  detail?: Record<string, unknown>;
}

export function buildEnvelope(o: BuildEnvelopeOpts): EventEnvelope {
  const writer_id = o.writer_id ?? o.emitter_id; // §2.1: pi/omp/prime writer ≡ emitter
  return {
    v: ENVELOPE_VERSION,
    at: o.at ?? 1_700_000_000_000 + o.seq,
    host: o.host ?? "local",
    runtime: o.runtime ?? "pi",
    session: o.session ?? "00000000-0000-4000-8000-000000000000",
    emitter_id: o.emitter_id,
    writer_id,
    seq: o.seq,
    kind: o.kind ?? "working",
    dropped_total: o.dropped_total ?? 0,
    write_error_total: o.write_error_total ?? 0,
    ...(o.detail !== undefined ? { detail: o.detail } : {}),
  };
}

/** Serialize an envelope to a single NDJSON line (no trailing newline). */
export function serializeEnvelope(e: EventEnvelope): string {
  return JSON.stringify(e);
}
