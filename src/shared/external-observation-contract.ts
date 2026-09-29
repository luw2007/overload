import { createHash } from "node:crypto";

/**
 * Immutable input from a separately operated observer.  It is evidence only:
 * routing it must never grant the observer permission to decide, resume, or
 * create a Work.
 */
export type ExternalObservationKind = "live" | "historical" | "recovery";

export interface ExternalObservationInput {
  source_id: string;
  source_event_id: string;
  observation_revision: number;
  work_id: string | null;
  kind: ExternalObservationKind;
  subject: string;
  /** Canonical source material retained by Overload; its SHA-256 is required. */
  summary: string;
  content_hash: string;
  observed_at: string;
  urgency?: "now" | "inbox";
  deep_link?: string | null;
  recovery_of?: {
    source_id: string;
    source_event_id: string;
    observation_revision: number;
  } | null;
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_SOURCE_ID = 200;
const MAX_EVENT_ID = 500;
const MAX_SUBJECT = 500;
const MAX_SUMMARY = 8 * 1024;
const MAX_LINK = 2 * 1024;

function requiredString(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function validRevision(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value as number;
}

/** The sole canonical-source rule for this contract: UTF-8 bytes of summary. */
export function externalObservationContentHash(summary: string): string {
  return createHash("sha256").update(summary).digest("hex");
}

/** Stable identity across replay and across collector processes. */
export function externalObservationIdempotencyKey(
  sourceId: string,
  sourceEventId: string,
  observationRevision: number,
): string {
  return createHash("sha256")
    .update(`${sourceId}\0${sourceEventId}\0${observationRevision}`)
    .digest("hex");
}

/**
 * Validates the untrusted envelope before it reaches either Attention or the
 * context pool.  A bad external hash is rejected rather than being stored as
 * evidence that can never be re-read through the normal source handler.
 */
export function validateExternalObservationInput(value: unknown): asserts value is ExternalObservationInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("external observation must be an object");
  }
  const input = value as Record<string, unknown>;
  requiredString(input.source_id, "source_id", MAX_SOURCE_ID);
  requiredString(input.source_event_id, "source_event_id", MAX_EVENT_ID);
  validRevision(input.observation_revision, "observation_revision");
  if (input.work_id !== null && (typeof input.work_id !== "string" || !input.work_id.trim() || input.work_id.length > 500)) {
    throw new Error("invalid work_id");
  }
  if (input.kind !== "live" && input.kind !== "historical" && input.kind !== "recovery") {
    throw new Error("invalid kind");
  }
  requiredString(input.subject, "subject", MAX_SUBJECT);
  const summary = requiredString(input.summary, "summary", MAX_SUMMARY);
  if (typeof input.content_hash !== "string" || !HEX64.test(input.content_hash)) {
    throw new Error("invalid content_hash");
  }
  if (input.content_hash !== externalObservationContentHash(summary)) {
    throw new Error("content_hash does not match summary");
  }
  if (typeof input.observed_at !== "string" || Number.isNaN(Date.parse(input.observed_at))) {
    throw new Error("invalid observed_at");
  }
  if (input.urgency !== undefined && input.urgency !== "now" && input.urgency !== "inbox") {
    throw new Error("invalid urgency");
  }
  if (input.deep_link !== undefined && input.deep_link !== null
    && (typeof input.deep_link !== "string" || !input.deep_link.trim() || input.deep_link.length > MAX_LINK)) {
    throw new Error("invalid deep_link");
  }
  const recovery = input.recovery_of;
  if (input.kind === "recovery") {
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) {
      throw new Error("recovery_of is required for recovery");
    }
    const r = recovery as Record<string, unknown>;
    requiredString(r.source_id, "recovery_of.source_id", MAX_SOURCE_ID);
    requiredString(r.source_event_id, "recovery_of.source_event_id", MAX_EVENT_ID);
    validRevision(r.observation_revision, "recovery_of.observation_revision");
  } else if (recovery !== undefined && recovery !== null) {
    throw new Error("recovery_of is only valid for recovery");
  }
}
