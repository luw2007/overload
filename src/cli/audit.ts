import type { Database } from "bun:sqlite";
import type { Handoff } from "../shared/queries";
import { controlPayloadHash } from "../control/outbox";

type JournalRow = { ingest_seq: number; stable_id: string; at: number; kind: string; detail: string | null };
type Detail = Record<string, unknown>;
type SessionRow = { stable_id: string; cwd: string | null };
type RequestRow = { request_uid: string; stable_id: string; state: string; created_at: number | null; detail: string | null };
type GatedRequest = { rule: string; requestedAt: number; terminal: boolean; resolved: boolean };

export type AuditOptions = { sample: number; sinceMs: number; now: number };
export type AuditDecisionCounts = { requested: number; resolved: number; cancelled: number; timed_out: number; orphaned: number };
export type AuditSession = {
  stableId: string;
  cwd: string | null;
  lastAt: number;
  decisions: AuditDecisionCounts;
  gatedRules: string[];
  consequentialClasses: string[];
  handoff: Handoff | null;
  maxAwaitingHumanMs: number;
};
/**
 * Flow counts applied attention events in the window by the state in their
 * historical journal payload. The current snapshot retains only the latest
 * event_id and cannot establish prior lifecycle transitions. Missing historical
 * evidence is reported as coverageMissing, never counted as a guessed state.
 * Stock and effects remain SQL aggregates of the current projection.
 * Feedback counts eligible (item_id, revision) pairs, not feedback event rows.
 */
export type AuditControlMetrics = {
  /** applied business events in window, deduplicated by event_id */
  projectedEvents: number;
  /** applied attention events entering open */
  openedFlow: number;
  /** applied attention events entering resolved */
  resolvedFlow: number;
  /** applied attention events entering superseded */
  supersededFlow: number;
  /** applied attention events entering applying */
  applyingFlow: number;
  /** current snapshot stock: state='open' as of now */
  currentOpen: number;
  /** current snapshot stock: state='resolved' as of now */
  currentResolved: number;
  /** current snapshot stock: state='superseded' as of now */
  currentSuperseded: number;
  /** current snapshot stock: state='applying' as of now */
  currentApplying: number;
  /** current effect_state='succeeded' */
  effectsSucceeded: number;
  /** current effect_state='failed' */
  effectsFailed: number;
  /** current effect_state='unknown' */
  effectsUnknown: number;
  /** current effect_state='not_started' — effect observation pending */
  effectsNotStarted: number;
  /** items acknowledged but still open (interrupted then acknowledged, not resolved) */
  acknowledgedOnly: number;
  /** distinct eligible (item_id, revision) pairs with useful feedback */
  feedbackUseful: number;
  /** distinct eligible (item_id, revision) pairs with not-useful feedback */
  feedbackNotUseful: number;
  /** eligible (item_id, revision) pairs without feedback */
  feedbackUnmeasured: number;
  /** applied events without enough historical envelope to classify their flow */
  coverageMissing: number;
};

export type AuditReport = {
  sample: number;
  sinceMs: number;
  sessions: AuditSession[];
  gatedRequested: number;
  gatedResolved: number;
  gatedTerminal: number;
  passRate: number;
  control: AuditControlMetrics;
  repeatedFailurePatterns: string[];
  rulesToAdd: string[];
};

const TERMINAL_STATES = new Set(["resolved", "cancelled", "timed_out"]);
const HANDOFF_STATUSES = new Set(["complete", "partial", "blocked", "unknown"]);
const MAX_HISTORY_IDS = 900; // stay well below SQLite's default 999 variable limit for WHERE stable_id IN (...)

function objectDetail(value: string | null): Detail {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Detail : {};
  } catch {
    return {};
  }
}

function stringValue(detail: Detail, key: string): string | null {
  const value = detail[key];
  return typeof value === "string" && value ? value : null;
}

function handoffFrom(detail: Detail): Handoff | null {
  const value = detail.handoff;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Detail;
  if (typeof row.path !== "string" || typeof row.status !== "string" || typeof row.uncertainties !== "number" || !HANDOFF_STATUSES.has(row.status)) return null;
  return {
    path: row.path,
    status: row.status as Handoff["status"],
    uncertainties: row.uncertainties,
    ...(typeof row.next_owner === "string" ? { next_owner: row.next_owner } : {}),
    ...(typeof row.task === "string" ? { task: row.task } : {}),
  };
}

function emptyDecisions(): AuditDecisionCounts {
  return { requested: 0, resolved: 0, cancelled: 0, timed_out: 0, orphaned: 0 };
}

function emptyControlMetrics(): AuditControlMetrics {
  return { projectedEvents: 0, openedFlow: 0, resolvedFlow: 0, supersededFlow: 0, applyingFlow: 0,
    currentOpen: 0, currentResolved: 0, currentSuperseded: 0, currentApplying: 0,
    effectsSucceeded: 0, effectsFailed: 0, effectsUnknown: 0, effectsNotStarted: 0,
    acknowledgedOnly: 0, feedbackUseful: 0, feedbackNotUseful: 0, feedbackUnmeasured: 0, coverageMissing: 0 };
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function inWindow(at: number, cutoff: number, now: number): boolean {
  return at >= cutoff && at <= now;
}

/** Flow uses historical applied journal envelopes; stock uses current SQL projection aggregates. */
function controlMetrics(db: Database, cutoff: number, now: number): AuditControlMetrics {
  const empty = emptyControlMetrics();
  const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
  if (!tables.has("applied_control_events") || !tables.has("control_attention")) return empty;

  // Load each applied receipt and retained envelope once. An expression join on
  // JSON event_id has no index and otherwise scans the journal for every receipt.
  const receipts = db.query("SELECT event_id,payload_hash,applied_at FROM applied_control_events WHERE applied_at<=? ORDER BY event_id")
    .all(now) as Array<{ event_id: string; payload_hash: string; applied_at: number }>;
  const appliedIds = new Set(receipts.map(receipt => receipt.event_id));
  const envelopes = new Map<string, Detail[]>();
  if (receipts.length) for (const row of db.query("SELECT detail FROM journal_all WHERE kind='control_event'").all() as Array<{ detail: string | null }>) {
    const parsed = objectDetail(row.detail);
    if (typeof parsed.event_id !== "string" || !appliedIds.has(parsed.event_id)) continue;
    const copies = envelopes.get(parsed.event_id);
    if (copies) copies.push(parsed); else envelopes.set(parsed.event_id, [parsed]);
  }
  type HistoricalAttention = { itemId: string; revision: number; state: string; kind: string; at: number; eventId: string };
  const byItem = new Map<string, HistoricalAttention[]>();
  for (const receipt of receipts) {
    let detail: Detail | null = null;
    let conflicting = false;
    for (const parsed of envelopes.get(receipt.event_id) ?? []) {
      if (parsed.payload_hash !== receipt.payload_hash) conflicting = true;
      else if (detail && (detail.event_kind !== parsed.event_kind || JSON.stringify(detail.payload) !== JSON.stringify(parsed.payload))) conflicting = true;
      else detail = parsed;
    }
    const within = inWindow(receipt.applied_at, cutoff, now);
    if (within) empty.projectedEvents++;
    if (conflicting || !detail) {
      if (within) empty.coverageMissing++;
      continue;
    }
    const payload = detail.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || controlPayloadHash(payload as Detail) !== receipt.payload_hash) {
      if (within) empty.coverageMissing++;
      continue;
    }
    const attention = "attention" in payload ? payload.attention : undefined;
    if (attention === undefined) {
      if (within && typeof detail.event_kind !== "string") empty.coverageMissing++;
      continue; // Applied work, wait, dependency or feedback event.
    }
    if (!attention || typeof attention !== "object" || Array.isArray(attention)) {
      if (within) empty.coverageMissing++;
      continue;
    }
    const item = attention as Detail;
    if (typeof item.item_id !== "string" || !item.item_id || !Number.isSafeInteger(item.revision)
      || (item.revision as number) < 1 || typeof item.state !== "string"
      || !["open", "applying", "resolved", "superseded"].includes(item.state)
      || typeof detail.event_kind !== "string") {
      if (within) empty.coverageMissing++;
      continue;
    }
    const entry: HistoricalAttention = { itemId: item.item_id, revision: item.revision as number,
      state: item.state, kind: detail.event_kind, at: receipt.applied_at, eventId: receipt.event_id };
    const events = byItem.get(entry.itemId) ?? [];
    events.push(entry);
    byItem.set(entry.itemId, events);
  }
  for (const events of byItem.values()) {
    events.sort((a, b) => a.revision - b.revision || a.at - b.at || a.eventId.localeCompare(b.eventId));
    let prior: HistoricalAttention | undefined;
    for (let i = 0; i < events.length;) {
      let event = events[i]!;
      let conflicting = false;
      while (++i < events.length && events[i]!.revision === event.revision) {
        const duplicate = events[i]!;
        if (duplicate.state !== event.state) conflicting = true;
        if (event.kind === "attention.material_projected" && duplicate.kind !== "attention.material_projected") event = duplicate;
      }
      const within = inWindow(event.at, cutoff, now);
      if (conflicting) {
        if (within) empty.coverageMissing++;
        prior = undefined;
        continue;
      }
      if (within) {
        const provenByKind = event.kind === "attention.created" && event.revision === 1 && event.state === "open"
          || (event.kind === "attention.resolved" || event.kind === "attention.resolve")
            && (event.state === "resolved" || event.state === "superseded")
          || event.kind === "attention.superseded" && event.state === "superseded"
          || event.kind === "attention.applying" && event.state === "applying";
        const adjacent = prior?.revision === event.revision - 1;
        if (event.kind === "attention.material_projected") {
          if (event.revision === 1 && !prior) empty.coverageMissing++;
        } else if (provenByKind || adjacent && prior?.state !== event.state) {
          if (event.state === "open") empty.openedFlow++;
          else if (event.state === "applying") empty.applyingFlow++;
          else if (event.state === "resolved") empty.resolvedFlow++;
          else empty.supersededFlow++;
        } else if (!prior && !provenByKind || prior && !adjacent) {
          empty.coverageMissing++;
        }
      }
      prior = event;
    }
  }

  // --- 3. Current snapshot stock: state of every item as of `now` ---
  const stock = db.query(`
    SELECT state, COUNT(*) AS n
    FROM control_attention
    WHERE updated_at <= ?
    GROUP BY state`).all(now) as Array<{ state: string; n: number }>;
  for (const r of stock) {
    if (r.state === "open") empty.currentOpen = r.n;
    else if (r.state === "resolved") empty.currentResolved = r.n;
    else if (r.state === "superseded") empty.currentSuperseded = r.n;
    else if (r.state === "applying") empty.currentApplying = r.n;
  }

  // --- 4. Current effect_state snapshot ---
  const effects = db.query(`
    SELECT effect_state, COUNT(*) AS n
    FROM control_attention
    WHERE updated_at <= ?
    GROUP BY effect_state`).all(now) as Array<{ effect_state: string; n: number }>;
  for (const r of effects) {
    if (r.effect_state === "succeeded") empty.effectsSucceeded = r.n;
    else if (r.effect_state === "failed") empty.effectsFailed = r.n;
    else if (r.effect_state === "unknown") empty.effectsUnknown = r.n;
    else if (r.effect_state === "not_started") empty.effectsNotStarted = r.n;
  }

  // --- 5. Acknowledged-only: items that are still open but have been acked ---
  const ackOnly = db.query(`
    SELECT COUNT(*) AS n
    FROM control_attention
    WHERE state='open' AND acknowledged_at IS NOT NULL AND updated_at <= ?`).get(now) as { n: number };
  empty.acknowledgedOnly = ackOnly.n;

  // A current snapshot is the item/revision eligible for feedback. Historical
  // envelopes establish flow, not an obligation to rate superseded revisions.
  const eligibleRow = db.query("SELECT COUNT(*) AS n FROM control_attention WHERE updated_at <= ?")
    .get(now) as { n: number };
  const eligibleFeedback = eligibleRow.n;
  if (tables.has("control_attention_feedback")) {
    const feedback = db.query(`SELECT ca.item_id, ca.revision, MIN(fb.useful) AS least, MAX(fb.useful) AS greatest
      FROM control_attention ca
      JOIN control_attention_feedback fb ON fb.item_id=ca.item_id AND fb.revision=ca.revision
      WHERE ca.updated_at <= ? AND fb.created_at <= ?
      GROUP BY ca.item_id, ca.revision`).all(now, now) as Array<{
        item_id: string; revision: number; least: number; greatest: number;
      }>;
    for (const row of feedback) {
      if (row.least !== row.greatest) continue; // contradictory evidence is unmeasured
      if (row.least === 1) empty.feedbackUseful++;
      else if (row.least === 0) empty.feedbackNotUseful++;
    }
  }
  empty.feedbackUnmeasured = eligibleFeedback - empty.feedbackUseful - empty.feedbackNotUseful;

  return empty;
}

/** `flag` names the caller's own option so a typo is reported against the flag the operator typed. */
export function parseSince(value: string, flag = "--since"): number {
  const match = /^(\d+)(ms|s|m|h|d)?$/.exec(value);
  if (!match) throw new Error(`invalid ${flag}: ${value}`);
  const amount = Number(match[1]);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 }[match[2] ?? "ms"];
  return amount * multiplier;
}

export function audit(db: Database, options: AuditOptions): AuditReport {
  if (!Number.isSafeInteger(options.sample) || options.sample < 0) throw new Error("sample must be a non-negative integer");
  if (!Number.isSafeInteger(options.sinceMs) || options.sinceMs < 0) throw new Error("sinceMs must be a non-negative integer");
  const cutoff = options.now - options.sinceMs;
  const windowRows = db.query("SELECT ingest_seq, stable_id, at, kind, detail FROM journal_all WHERE at>=? AND at<=? ORDER BY at DESC, ingest_seq DESC").all(cutoff, options.now) as JournalRow[];
  const firstQualifying = new Map<string, JournalRow>();
  for (const row of windowRows) {
    const detail = objectDetail(row.detail);
    const handoff = row.kind === "settled" ? handoffFrom(detail) : null;
    if ((row.kind === "decision_requested" && detail.gated === true)
      || (row.kind === "tool_activity" && detail.consequential === true)
      || (handoff !== null && handoff.status !== "complete")) {
      if (!firstQualifying.has(row.stable_id)) firstQualifying.set(row.stable_id, row);
    }
  }
  const selectedIds = [...firstQualifying.entries()]
    .sort((a, b) => b[1].at - a[1].at || b[1].ingest_seq - a[1].ingest_seq || b[0].localeCompare(a[0]))
    .slice(0, options.sample === 0 ? undefined : options.sample)
    .map(([stableId]) => stableId);
  const selected = new Set(selectedIds);
  const cwdById = new Map((db.query("SELECT stable_id, cwd FROM sessions").all() as SessionRow[]).map((row) => [row.stable_id, row.cwd]));
  const history = new Map<string, JournalRow[]>();
  if (selectedIds.length) {
    // Restrict the history query to only the selected stable_ids. Chunk so we
    // never exceed SQLite's default 999 variable limit — this guards against
    // an operator asking for a large --sample on a DB with many qualifying
    // sessions.
    for (let i = 0; i < selectedIds.length; i += MAX_HISTORY_IDS) {
      const chunk = selectedIds.slice(i, i + MAX_HISTORY_IDS);
      const placeholders = chunk.map(() => "?").join(",");
      const allRows = db.query(`SELECT ingest_seq, stable_id, at, kind, detail FROM journal_all WHERE stable_id IN (${placeholders}) AND at<=? ORDER BY at ASC, ingest_seq ASC`)
        .all(...chunk, options.now) as JournalRow[];
      for (const row of allRows) {
        const rows = history.get(row.stable_id);
        if (rows) rows.push(row); else history.set(row.stable_id, [row]);
      }
    }
  }
  const requestRows = db.query("SELECT request_uid, stable_id, state, created_at, detail FROM requests").all() as RequestRow[];
  const q5Rows = db.query("SELECT stable_id, q5_reason FROM current WHERE queue='q5'").all() as Array<{ stable_id: string; q5_reason: string | null }>;
  const q5Counts = new Map<string, number>();
  const ruleFailures = new Map<string, number>();
  const ungatedClasses = new Map<string, number>();
  const blockedByCwd = new Map<string, number>();
  let gatedRequested = 0;
  let gatedResolved = 0;
  let gatedTerminal = 0;
  const reports: AuditSession[] = [];

  for (const row of q5Rows) {
    if (selected.has(row.stable_id) && row.q5_reason && row.q5_reason !== "handoff_blocked") q5Counts.set(row.q5_reason, (q5Counts.get(row.q5_reason) ?? 0) + 1);
  }
  for (const stableId of selectedIds) {
    const rows = history.get(stableId) ?? [];
    const decisions = emptyDecisions();
    const gated = new Map<string, GatedRequest>();
    const awaiting = new Map<string, number>();
    const gatedRules = new Set<string>();
    const consequentialClasses = new Set<string>();
    let latestHandoff: Handoff | null = null;
    let maxAwaitingHumanMs = 0;
    let hasGate = false;
    // tool_activity precedes decision_requested within one tool call, so the
    // "was it gated" verdict is only sound after the whole session is scanned.
    const sessionClasses = new Map<string, number>();
    const cwd = cwdById.get(stableId) ?? null;
    for (const row of rows) {
      const detail = objectDetail(row.detail);
      const scoped = inWindow(row.at, cutoff, options.now);
      if (row.kind === "decision_requested") {
        const requestId = stringValue(detail, "request_id");
        if (scoped) decisions.requested += 1;
        if (detail.gated === true) {
          hasGate = true;
          const rule = stringValue(detail, "rule") ?? "unknown";
          gatedRules.add(rule);
          if (requestId && scoped && !gated.has(requestId)) {
            gated.set(requestId, { rule, requestedAt: row.at, terminal: false, resolved: false });
            gatedRequested += 1;
          }
        }
        if (requestId && scoped) awaiting.set(requestId, row.at);
      } else if (row.kind === "decision_resolved") {
        const requestId = stringValue(detail, "request_id");
        const state = stringValue(detail, "state") ?? stringValue(detail, "outcome") ?? "resolved";
        if (scoped && (state === "resolved" || state === "cancelled" || state === "timed_out")) decisions[state] += 1;
        if (requestId) {
          const requestedAt = awaiting.get(requestId);
          if (requestedAt !== undefined) {
            maxAwaitingHumanMs = Math.max(maxAwaitingHumanMs, Math.max(0, row.at - requestedAt));
            awaiting.delete(requestId);
          }
          const gate = gated.get(requestId);
          if (gate && !gate.terminal && TERMINAL_STATES.has(state)) {
            gate.terminal = true;
            gate.resolved = state === "resolved";
            gatedTerminal += 1;
            if (gate.resolved) gatedResolved += 1;
            if (state === "timed_out" || stringValue(detail, "selected") === "deny" || stringValue(detail, "answer") === "deny") {
              const key = `${gate.rule}\u0000${state === "timed_out" ? "timed_out" : "denied"}`;
              ruleFailures.set(key, (ruleFailures.get(key) ?? 0) + 1);
            }
          }
        }
      } else if (row.kind === "tool_activity" && detail.consequential === true && scoped) {
        const className = stringValue(detail, "class");
        if (className) {
          consequentialClasses.add(className);
          sessionClasses.set(className, (sessionClasses.get(className) ?? 0) + 1);
        }
      } else if (row.kind === "settled" && scoped) {
        const handoff = handoffFrom(detail);
        if (handoff) {
          latestHandoff = handoff;
          if (handoff.status === "blocked") {
            const key = cwd ?? "unknown";
            blockedByCwd.set(key, (blockedByCwd.get(key) ?? 0) + 1);
          }
        }
      }
    }
    for (const at of awaiting.values()) maxAwaitingHumanMs = Math.max(maxAwaitingHumanMs, Math.max(0, options.now - at));
    if (!hasGate) for (const [className, count] of sessionClasses) ungatedClasses.set(className, (ungatedClasses.get(className) ?? 0) + count);
    for (const request of requestRows) {
      if (request.stable_id !== stableId || request.state !== "orphaned" || request.created_at == null || !inWindow(request.created_at, cutoff, options.now)) continue;
      decisions.orphaned += 1;
      const detail = objectDetail(request.detail);
      if (detail.gated === true) {
        gatedRequested += 1;
        gatedTerminal += 1;
      }
    }
    reports.push({
      stableId,
      cwd,
      lastAt: firstQualifying.get(stableId)!.at,
      decisions,
      gatedRules: uniqueSorted(gatedRules),
      consequentialClasses: uniqueSorted(consequentialClasses),
      handoff: latestHandoff,
      maxAwaitingHumanMs,
    });
  }

  const repeatedFailurePatterns: string[] = [];
  const rulesToAdd: string[] = [];
  for (const [key, count] of [...ruleFailures.entries()].sort()) {
    if (count < 2) continue;
    const [rule, failure] = key.split("\u0000");
    repeatedFailurePatterns.push(`rule ${rule} ${failure} ${count}x`);
    rulesToAdd.push(`rule ${rule} ${failure} ${count}x → ${failure === "timed_out" ? "shorten timeout or move to block/allow" : "review denial or move to block/allow"}`);
  }
  for (const [reason, count] of [...q5Counts.entries()].sort()) {
    if (count < 2) continue;
    repeatedFailurePatterns.push(`q5 ${reason} ${count}x`);
  }
  for (const [cwd, count] of [...blockedByCwd.entries()].sort()) {
    if (count < 2) continue;
    repeatedFailurePatterns.push(`handoff blocked ${count}x in ${cwd}`);
  }
  for (const [className, count] of [...ungatedClasses.entries()].sort()) {
    rulesToAdd.push(`class ${className} consequential ${count}x with no gate → add require_approval pattern`);
  }
  return {
    sample: options.sample,
    sinceMs: options.sinceMs,
    sessions: reports,
    gatedRequested,
    gatedResolved,
    gatedTerminal,
    passRate: gatedTerminal ? gatedResolved / gatedTerminal : 0,
    control: controlMetrics(db, cutoff, options.now),
    repeatedFailurePatterns,
    rulesToAdd,
  };
}

export function printAudit(report: AuditReport, output: (line: string) => void = console.log): void {
  output(`PASS_RATE ${(report.passRate * 100).toFixed(1)}% (${report.gatedResolved}/${report.gatedTerminal})`);
  output(`SESSIONS ${report.sessions.length}`);
  const control = report.control;
  output(`CONTROL projected_events=${control.projectedEvents} coverage_missing=${control.coverageMissing}`);
  output(`CONTROL_FLOW  open=${control.openedFlow} applying=${control.applyingFlow} resolved=${control.resolvedFlow} superseded=${control.supersededFlow}`);
  output(`CONTROL_STOCK open=${control.currentOpen} applying=${control.currentApplying} resolved=${control.currentResolved} superseded=${control.currentSuperseded}`);
  output(`EFFECTS succeeded=${control.effectsSucceeded} failed=${control.effectsFailed} unknown=${control.effectsUnknown} not_started=${control.effectsNotStarted} ack_only=${control.acknowledgedOnly}`);
  output(`FEEDBACK useful=${control.feedbackUseful} not_useful=${control.feedbackNotUseful} unmeasured=${control.feedbackUnmeasured}`);
  for (const session of report.sessions) {
    const d = session.decisions;
    output(`SESSION ${session.stableId} cwd=${session.cwd ?? "-"}`);
    output(`  decisions requested=${d.requested} resolved=${d.resolved} cancelled=${d.cancelled} timed_out=${d.timed_out} orphaned=${d.orphaned}`);
    output(`  gated_rules=${session.gatedRules.join(",") || "-"} consequential=${session.consequentialClasses.join(",") || "-"}`);
    output(`  handoff=${session.handoff ? `${session.handoff.status} uncertainties=${session.handoff.uncertainties}` : "-"} max_awaiting_human=${session.maxAwaitingHumanMs}ms`);
  }
  output("REPEATED_FAILURE_PATTERNS");
  for (const pattern of report.repeatedFailurePatterns) output(`  ${pattern}`);
  output("RULES_TO_ADD");
  for (const rule of report.rulesToAdd) output(`  ${rule}`);
}
