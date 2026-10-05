import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { queryHung, queryQ1 } from "../shared/queries";
import { enqueueControlEvent, getAttention, listAttention, openControl } from "../control/store";
import type { AttentionItem } from "../control/types";

export type NotificationChannel = "macos" | "feishu";
export type NotificationThreshold = "new_now" | "material_change" | "expires_soon" | "expired";
export type NotificationOutcome = "shadowed" | "pending" | "sent" | "failed" | "unknown" | "suppressed";
export type NotificationMode = "shadow" | "send";

export type NotificationCandidate = {
  subject: string;
  material_key: string;
  threshold: NotificationThreshold;
  source_kind: "attention" | "legacy_q1" | "legacy_hung";
  source_id: string;
  reason: string;
  work_id?: string;
  item_id?: string;
  item_revision?: number;
  approval_id?: string;
  receipt_id?: string;
  outbox_event_id?: string;
};
export type NotificationPolicy = {
  mode: NotificationMode;
  primary_channel: NotificationChannel;
  owner_epoch: string;
  expires_soon_ms: number;
  max_attempts: number;
};
export type NotificationDelivery = { outcome: "sent" | "failed" | "unknown"; external_id?: string; error?: string };
export interface NotificationSender {
  readonly channel: NotificationChannel;
  send(candidates: readonly NotificationCandidate[]): Promise<NotificationDelivery>;
}

export type NotificationEnvironment = Readonly<Record<string, string | undefined>>;

export type NudgeDeps = {
  ledgerPath: string;
  controlPath?: string;
  /** Legacy newline-state path retained until notification cutover. */
  statePath: string;
  notify: (message: string) => Promise<void>;
  /** Process identity allowed to own the durable notification cycle. */
  cycleOwner?: string;
  /** Injectable for deterministic configuration tests; defaults to process.env. */
  env?: NotificationEnvironment;
  /** Required for send-mode channels other than the legacy macOS callback. */
  sender?: NotificationSender;
};

export type NotificationCapability = { available: boolean; platform: NodeJS.Platform; reason: string | null };
export function notificationCapability(platform: NodeJS.Platform = process.platform): NotificationCapability {
  return platform === "darwin" ? { available: true, platform, reason: null } : { available: false, platform, reason: "macOS notifications unavailable on this platform" };
}

type MaterialRow = { item_id: string; material_key: string; generation: number };
type AttentionCorrelation = {
  candidate: NotificationCandidate;
  approvalIds: Set<string>;
  requestUids: Set<string>;
  stableIds: Set<string>;
};
type CandidateCollection = { candidates: NotificationCandidate[]; legacyEquivalentIdentities: Set<string> };

function exactIdentity(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function candidateIdentity(candidate: NotificationCandidate): string {
  return `${candidate.subject}\0${candidate.material_key}\0${candidate.threshold}`;
}

/**
 * The mailbox target is the authoritative cross-projection binding. Evidence IDs are
 * accepted only as explicit producer-recorded identities; titles, summaries, parsed
 * item IDs, and request/session resemblance are deliberately never correlations.
 */
function approvalTargetBinding(control: Database, item: AttentionItem): { request_uid: string | null; stable_id: string | null } | null {
  if (!item.approval_id || !item.consumer_owner) return null;
  const table = control.query("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='approval_targets'").get() as { found: number } | null;
  if (!table) return null;
  return control.query("SELECT request_uid,stable_id FROM approval_targets WHERE consumer_owner=? AND approval_id=?")
    .get(item.consumer_owner, item.approval_id) as { request_uid: string | null; stable_id: string | null } | null;
}

function attentionCorrelations(control: Database, now: number, expiresSoonMs: number): AttentionCorrelation[] {
  const items = listAttention(control, "now", now);
  const material = control.query("SELECT item_id,material_key,generation FROM control_attention_material WHERE item_id=?");
  const result: AttentionCorrelation[] = [];
  for (const item of items) {
    const row = material.get(item.item_id) as MaterialRow | null;
    if (!row) continue;
    const base = {
      subject: `attention:${item.item_id}`,
      material_key: row.material_key,
      source_kind: "attention" as const,
      source_id: item.item_id,
      work_id: item.work_id,
      item_id: item.item_id,
      item_revision: item.revision,
      ...(item.approval_id ? { approval_id: item.approval_id } : {}),
    };
    const binding = approvalTargetBinding(control, item);
    const approvalIds = new Set<string>();
    const requestUids = new Set<string>();
    const stableIds = new Set<string>();
    for (const value of [item.approval_id, item.evidence.approval_id]) {
      const identity = exactIdentity(value);
      if (identity) approvalIds.add(identity);
    }
    const bindings = item.evidence.notification_bindings;
    if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
      const recorded = bindings as Record<string, unknown>;
      const requestUid = exactIdentity(recorded.request_uid);
      const stableId = exactIdentity(recorded.stable_id);
      if (requestUid) requestUids.add(requestUid);
      if (stableId) stableIds.add(stableId);
    }
    const boundRequestUid = exactIdentity(binding?.request_uid);
    const boundStableId = exactIdentity(binding?.stable_id);
    if (boundRequestUid) requestUids.add(boundRequestUid);
    if (boundStableId) stableIds.add(boundStableId);
    const add = (candidate: NotificationCandidate) => result.push({ candidate, approvalIds, requestUids, stableIds });
    add({ ...base, threshold: row.generation === 1 ? "new_now" : "material_change", reason: row.generation === 1 ? "new urgent decision" : "material decision basis changed" });
    if (item.expires_at !== null) {
      if (item.expires_at <= now) add({ ...base, threshold: "expired", reason: "decision validity expired" });
      else if (item.expires_at - now <= expiresSoonMs) add({ ...base, threshold: "expires_soon", reason: "decision validity expires soon" });
    }
  }
  return result;
}

/** Return one native candidate only when an explicit identity resolves unambiguously. */
function correlatedAttention(
  correlations: readonly AttentionCorrelation[],
  detail: Record<string, unknown> | null,
  authoritativeId: string,
  kind: "q1" | "hung",
): AttentionCorrelation | undefined {
  const approvalId = exactIdentity(detail?.approval_id);
  const matches = correlations.filter((entry) => (entry.candidate.threshold === "new_now" || entry.candidate.threshold === "material_change")
    && (approvalId !== undefined && entry.approvalIds.has(approvalId)
      || kind === "q1" && entry.requestUids.has(authoritativeId)
      || kind === "hung" && entry.stableIds.has(authoritativeId)));
  if (matches.length === 0) return undefined;
  const identities = new Set(matches.map(({ candidate }) => candidateIdentity(candidate)));
  return identities.size === 1 ? matches[0] : undefined;
}

function collectWithExpiryWindow(ledger: Database, control: Database, now: number, expiresSoonMs: number): CandidateCollection {
  const correlations = attentionCorrelations(control, now, expiresSoonMs);
  const candidates = correlations.map(({ candidate }) => candidate);
  const legacyEquivalentIdentities = new Set<string>();
  for (const row of queryQ1(ledger)) {
    const native = correlatedAttention(correlations, row.detail, row.request_uid, "q1");
    if (native) {
      legacyEquivalentIdentities.add(candidateIdentity(native.candidate));
      continue;
    }
    const subject = `q1:${row.request_uid}`;
    candidates.push({ subject, material_key: `${subject}:legacy-open`, threshold: "new_now", source_kind: "legacy_q1", source_id: row.request_uid, reason: "legacy pending decision" });
  }
  for (const row of queryHung(ledger, now)) {
    const native = correlatedAttention(correlations, row.detail, row.stable_id, "hung");
    if (native) {
      legacyEquivalentIdentities.add(candidateIdentity(native.candidate));
      continue;
    }
    const subject = `hung:${row.stable_id}`;
    candidates.push({ subject, material_key: `${subject}:legacy-open`, threshold: "new_now", source_kind: "legacy_hung", source_id: row.stable_id, reason: "legacy hung turn" });
  }
  return { candidates, legacyEquivalentIdentities };
}

/** Side-effect-free projection. Material rows must already be maintained by the control store. */
export function collectNotificationCandidates(ledger: Database, control: Database, now = Date.now()): NotificationCandidate[] {
  return collectWithExpiryWindow(ledger, control, now, 900_000).candidates;
}

function validatePolicy(policy: NotificationPolicy, sender: NotificationSender): void {
  if (!policy.owner_epoch.trim()) throw new Error("notification owner_epoch is required");
  if (!Number.isSafeInteger(policy.max_attempts) || policy.max_attempts < 1) throw new Error("notification max_attempts must be positive");
  if (!Number.isSafeInteger(policy.expires_soon_ms) || policy.expires_soon_ms < 0) throw new Error("notification expires_soon_ms must be non-negative");
  if (sender.channel !== policy.primary_channel) throw new Error(`notification sender channel ${sender.channel} is not primary ${policy.primary_channel}`);
}

function recordOutcomeEvent(control: Database, row: { notification_id: string; attempt_count: number; work_id?: string; item_id?: string }, outcome: NotificationOutcome, now: number, error?: string, externalId?: string): void {
  enqueueControlEvent(control, {
    entity_id: row.notification_id,
    entity_version: Math.max(1, row.attempt_count),
    kind: "notification_outcome",
    ...(row.work_id ? { work_id: row.work_id } : {}),
    ...(row.item_id ? { item_id: row.item_id } : {}),
    payload: { notification_id: row.notification_id, outcome, ...(error ? { error } : {}), ...(externalId ? { external_id: externalId } : {}) },
  }, now);
}

export async function runNotificationCycle(input: {
  ledger: Database;
  control: Database;
  policy: NotificationPolicy;
  sender: NotificationSender;
  now?: number;
}): Promise<{ claimed: number; sent: number; failed: number; unknown: number; shadowed: number }> {
  const now = input.now ?? Date.now();
  validatePolicy(input.policy, input.sender);
  const collection = collectWithExpiryWindow(input.ledger, input.control, now, input.policy.expires_soon_ms);
  // Dynamic insertion deduplicates candidates that project to the same durable notification identity.
  const byIdentity = new Map(collection.candidates.map((candidate) => [candidateIdentity(candidate), candidate]));
  const claimed: Array<{ notification_id: string; attempt_count: number; candidate: NotificationCandidate }> = [];
  let shadowed = 0;

  const claim = input.control.transaction(() => {
    for (const candidate of byIdentity.values()) {
      const notificationId = randomUUID();
      const outcome: NotificationOutcome = input.policy.mode === "shadow" ? "shadowed" : "pending";
      const inserted = input.control.query(`INSERT OR IGNORE INTO control_notifications(
        notification_id,subject,material_key,threshold,channel,outcome,owner_epoch,work_id,item_id,item_revision,
        approval_id,receipt_id,outbox_event_id,source_kind,source_id,reason,attempt_count,next_attempt_at,created_at,attempted_at,completed_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          notificationId, candidate.subject, candidate.material_key, candidate.threshold, input.policy.primary_channel, outcome,
          input.policy.owner_epoch, candidate.work_id ?? null, candidate.item_id ?? null, candidate.item_revision ?? null,
          candidate.approval_id ?? null, candidate.receipt_id ?? null, candidate.outbox_event_id ?? null,
          candidate.source_kind, candidate.source_id, candidate.reason, input.policy.mode === "send" ? 1 : 0, null, now,
          input.policy.mode === "send" ? now : null, input.policy.mode === "shadow" ? now : null,
        );
      if (Number(inserted.changes) === 1) {
        input.control.query(`INSERT OR IGNORE INTO control_notification_shadow(
          comparison_id,subject,material_key,threshold,legacy_would_send,candidate_would_send,legacy_reason,candidate_reason,
          source_kind,source_id,item_id,item_revision,compared_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            randomUUID(), candidate.subject, candidate.material_key, candidate.threshold,
            candidate.source_kind === "attention" && collection.legacyEquivalentIdentities.has(candidateIdentity(candidate)) ? 1 : candidate.source_kind === "attention" ? 0 : 1,
            1,
            candidate.source_kind === "attention" && collection.legacyEquivalentIdentities.has(candidateIdentity(candidate))
              ? "authoritative legacy binding resolves to this Attention source"
              : candidate.source_kind === "attention" ? "legacy projection had no authoritative source binding" : "legacy source is open",
            candidate.reason, candidate.source_kind, candidate.source_id, candidate.item_id ?? null, candidate.item_revision ?? null, now,
          );
        if (input.policy.mode === "shadow") {
          recordOutcomeEvent(input.control, { notification_id: notificationId, attempt_count: 1, work_id: candidate.work_id, item_id: candidate.item_id }, "shadowed", now);
          shadowed += 1;
        } else claimed.push({ notification_id: notificationId, attempt_count: 1, candidate });
        continue;
      }
      if (input.policy.mode === "send") {
        const existing = input.control.query(`SELECT notification_id,attempt_count,next_attempt_at FROM control_notifications
          WHERE subject=? AND material_key=? AND threshold=? AND owner_epoch=?`).get(candidate.subject, candidate.material_key, candidate.threshold, input.policy.owner_epoch) as { notification_id: string; attempt_count: number; next_attempt_at: number | null } | null;
        if (existing && existing.attempt_count < input.policy.max_attempts && existing.next_attempt_at !== null && existing.next_attempt_at <= now) {
          const updated = input.control.query(`UPDATE control_notifications SET outcome='pending',attempt_count=attempt_count+1,
            attempted_at=?,next_attempt_at=NULL,error=NULL WHERE notification_id=? AND outcome='failed' AND attempt_count=? AND next_attempt_at<=?`).run(now, existing.notification_id, existing.attempt_count, now);
          if (Number(updated.changes) === 1) claimed.push({ notification_id: existing.notification_id, attempt_count: existing.attempt_count + 1, candidate });
        }
      }
    }
  });
  claim.immediate();
  if (input.policy.mode === "shadow" || claimed.length === 0) return { claimed: 0, sent: 0, failed: 0, unknown: 0, shadowed };

  let delivery: NotificationDelivery;
  try {
    delivery = await input.sender.send(claimed.map((entry) => entry.candidate));
  } catch (error) {
    delivery = { outcome: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  const finish = input.control.transaction(() => {
    for (const entry of claimed) {
      const retryAt = delivery.outcome === "failed" && entry.attempt_count < input.policy.max_attempts ? now + Math.min(3_600_000, 60_000 * 2 ** (entry.attempt_count - 1)) : null;
      input.control.query(`UPDATE control_notifications SET outcome=?,error=?,next_attempt_at=?,completed_at=?
        WHERE notification_id=? AND outcome='pending' AND attempt_count=?`).run(delivery.outcome, delivery.error ?? null, retryAt, now, entry.notification_id, entry.attempt_count);
      recordOutcomeEvent(input.control, { notification_id: entry.notification_id, attempt_count: entry.attempt_count, work_id: entry.candidate.work_id, item_id: entry.candidate.item_id }, delivery.outcome, now, delivery.error, delivery.external_id);
    }
  });
  finish.immediate();
  return {
    claimed: claimed.length,
    sent: delivery.outcome === "sent" ? claimed.length : 0,
    failed: delivery.outcome === "failed" ? claimed.length : 0,
    unknown: delivery.outcome === "unknown" ? claimed.length : 0,
    shadowed: 0,
  };
}

const DEFAULT_NOTIFICATION_OWNER = "maintenance";
const DEFAULT_SHADOW_EPOCH = "phase-a-shadow-1";

function configuredInteger(name: string, raw: string | undefined, fallback: number, minimum: number): number {
  if (raw === undefined) return fallback;
  if (raw.trim() === "") throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}`);
  return value;
}

function notificationRuntimeConfig(env: NotificationEnvironment): { owner: string; policy: NotificationPolicy } {
  const modeValue = env.OVERLOAD_NOTIFICATION_MODE ?? "shadow";
  if (modeValue !== "shadow" && modeValue !== "send") throw new Error("OVERLOAD_NOTIFICATION_MODE must be shadow or send");
  const primaryValue = env.OVERLOAD_NOTIFICATION_PRIMARY ?? "macos";
  if (primaryValue !== "macos" && primaryValue !== "feishu") throw new Error("OVERLOAD_NOTIFICATION_PRIMARY must be macos or feishu");
  const owner = (env.OVERLOAD_NOTIFICATION_OWNER ?? DEFAULT_NOTIFICATION_OWNER).trim();
  if (!owner) throw new Error("OVERLOAD_NOTIFICATION_OWNER is required");
  const configuredEpoch = env.OVERLOAD_NOTIFICATION_OWNER_EPOCH;
  if (modeValue === "send" && configuredEpoch === undefined) {
    throw new Error("OVERLOAD_NOTIFICATION_OWNER_EPOCH is required for notification cutover");
  }
  const ownerEpoch = (configuredEpoch ?? DEFAULT_SHADOW_EPOCH).trim();
  if (!ownerEpoch) throw new Error("OVERLOAD_NOTIFICATION_OWNER_EPOCH is required");
  return {
    owner,
    policy: {
      mode: modeValue,
      primary_channel: primaryValue,
      owner_epoch: ownerEpoch,
      expires_soon_ms: configuredInteger("OVERLOAD_NOTIFICATION_EXPIRES_SOON_MS", env.OVERLOAD_NOTIFICATION_EXPIRES_SOON_MS, 900_000, 0),
      max_attempts: configuredInteger("OVERLOAD_NOTIFICATION_MAX_ATTEMPTS", env.OVERLOAD_NOTIFICATION_MAX_ATTEMPTS, 3, 1),
    },
  };
}

/** Legacy subject identity and scope remain Q1/hung only until cutover. */
function collectLegacySubjects(ledger: Database): Set<string> {
  const subjects = new Set<string>();
  for (const row of queryQ1(ledger)) subjects.add(`q1:${row.request_uid}`);
  for (const row of queryHung(ledger)) subjects.add(`hung:${row.stable_id}`);
  // Legacy nudge has always covered ledger Q1/hung only; Attention is candidate-only until cutover.
  return subjects;
}

function readLegacyState(statePath: string): Set<string> {
  try {
    const content = readFileSync(statePath, "utf8").trim();
    return content ? new Set(content.split("\n").filter(Boolean)) : new Set<string>();
  } catch {
    return new Set<string>();
  }
}

async function runLegacyNudge(deps: NudgeDeps, subjects: Set<string>): Promise<{ count: number; notified: boolean }> {
  const previous = readLegacyState(deps.statePath);
  if (subjects.size === 0 && previous.size === 0) return { count: 0, notified: false };
  mkdirSync(join(deps.statePath, ".."), { recursive: true, mode: 0o700 });
  const notified = [...subjects].some((subject) => !previous.has(subject));
  if (!notified) {
    writeFileSync(deps.statePath, `${[...subjects].join("\n")}\n`, { mode: 0o600 });
    return { count: subjects.size, notified: false };
  }
  await deps.notify(`${subjects.size} 项待处理 — 打开 http://127.0.0.1:4870/now`);
  writeFileSync(deps.statePath, `${[...subjects].join("\n")}\n`, { mode: 0o600 });
  return { count: subjects.size, notified: true };
}

function cycleSender(deps: NudgeDeps, policy: NotificationPolicy): NotificationSender {
  if (deps.sender) return deps.sender;
  if (policy.mode === "send" && policy.primary_channel !== "macos") {
    throw new Error(`notification sender for primary channel ${policy.primary_channel} is required`);
  }
  return {
    channel: policy.primary_channel,
    send: async (candidates) => {
      if (policy.primary_channel !== "macos") throw new Error("non-macOS compatibility sender cannot send");
      const count = new Set(candidates.map((candidate) => candidate.subject)).size;
      await deps.notify(`${count} 项待处理 — 打开 http://127.0.0.1:4870/now`);
      return { outcome: "sent" };
    },
  };
}

/**
 * Compatibility entry point used by maintenance. Shadow mode preserves the newline-state
 * sender and only records durable comparisons; send mode is the explicit, non-coexistent cutover.
 */
export async function nudgeOnce(deps: NudgeDeps): Promise<{ count: number; notified: boolean }> {
  const env = deps.env ?? process.env;
  const modeValue = env.OVERLOAD_NOTIFICATION_MODE ?? "shadow";
  if (modeValue !== "shadow" && modeValue !== "send") throw new Error("OVERLOAD_NOTIFICATION_MODE must be shadow or send");
  const cycleOwner = (deps.cycleOwner ?? DEFAULT_NOTIFICATION_OWNER).trim();
  if (!cycleOwner) throw new Error("notification cycle owner identity is required");
  const ledger = new Database(deps.ledgerPath, { readonly: true, create: false });
  const control = openControl(deps.controlPath);
  try {
    const legacySubjects = collectLegacySubjects(ledger);
    if (modeValue === "shadow") {
      // Run the incumbent first; bad experimental policy/recording must never suppress its delivery.
      const legacyResult = await runLegacyNudge(deps, legacySubjects);
      try {
        const { owner, policy } = notificationRuntimeConfig(env);
        if (owner === cycleOwner) {
          await runNotificationCycle({ ledger, control, policy, sender: cycleSender(deps, policy) });
        }
      } catch (error) {
        console.error(`nudge: shadow comparison failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return legacyResult;
    }
    const { owner, policy } = notificationRuntimeConfig(env);
    if (owner !== cycleOwner) return { count: legacySubjects.size, notified: false };
    const result = await runNotificationCycle({ ledger, control, policy, sender: cycleSender(deps, policy) });
    return { count: legacySubjects.size, notified: result.sent > 0 };
  } finally {
    control.close();
    ledger.close();
  }
}

/** Message is derived from a count only; still passed as argv, never interpolated into script source. */
export async function macNotify(message: string): Promise<void> {
  const capability = notificationCapability();
  if (!capability.available) throw new Error(capability.reason!);
  const script = `display notification "${message.replaceAll('"', "")}" with title "Overload"`;
  const proc = Bun.spawn(["osascript", "-e", script], { stdout: "ignore", stderr: "ignore" });
  const exit = await proc.exited;
  if (exit !== 0) throw new Error(`osascript exited ${exit}`);
}

if (import.meta.main) {
  const home = join(homedir(), ".overload");
  const result = await nudgeOnce({ ledgerPath: process.env.OVERLOAD_LEDGER_PATH ?? join(home, "ledger.db"), statePath: join(home, "nudge.state"), notify: macNotify });
  if (result.notified) console.error(`nudge: notified (now=${result.count})`);
}
