import type { Database } from "bun:sqlite";
import { digest } from "../decision-bot/mailbox";
import { listAttention, listAttentionFollowUps, listAttentionPage, listConditionWaits, listWorks } from "../control/store";
import type { AttentionFollowUp, AttentionItem, ConditionWait, Work } from "../control/types";
import { queryHealth, querySessions, SESSION_WINDOW_MS, type SessionSummary } from "../shared/queries";
import { scrubText } from "../shared/redact";

export const ATTENTION_CAP = 48;
export const SESSION_CAP = 48;
export const DONE_CAP = 30;
export const DONE_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const SOURCE_STALE_MS = DAY_MS;
const TARGET_RUNTIMES = new Set(["pi", "omp", "prime"]);
const RECON_KINDS = ["emitter_dead", "emitter_drained", "emitter_stalled", "turn_hung", "dead_connection", "telemetry_gap"];
const PULL_KINDS = ["source_outage", "source_recovered"];

export type EvidenceTimestamp = { field: string; at: number };
export type CompactAttention = {
  item_id: string; work_id: string; revision: number; state: AttentionItem["state"]; effect_state: AttentionItem["effect_state"];
  urgency: AttentionItem["urgency"]; conclusion: string; trigger: string; impact: string; recommendation: string | null; options: string[];
  owner: string; expires_at: number | null; defer_until: number | null; decision_mode: AttentionItem["decision_mode"];
  source_link: string | null; updated_at: number; evidence_timestamps: EvidenceTimestamp[]; evidence_freshness?: unknown;
};
export type CompactFollowUp = {
  item_id: string; work_id: string; conclusion: string; stage: AttentionFollowUp["stage"]; receipt_id: string | null;
  consumed_at: number | null; applied_at: number | null; outcome: AttentionFollowUp["outcome"];
  remaining_responsibility: string; next_action: string; updated_at: number;
};
export type CompactWork = { work_id: string; title: string; state: Work["state"]; revision: number; objective: string | null; decision_owner: string | null; deadline_at: number | null; acceptance_count: number };
export type CompactWait = { wait_id: string; work_id: string; item_id: string; kind: string; state: ConditionWait["state"]; due_at: number | null; expires_at: number; disposition: ConditionWait["disposition"] };
export type CompactSession = {
  stable_id: string; runtime: string | null; cwd: string | null; branch: string | null; state: string | null; queue: string | null;
  q5_reason: string | null; last_event_at: number | null; handoff: { status: string; uncertainties: number } | null;
};
export type HandoffTarget = {
  target_kind: "session"; target_id: string; runtime: string; cwd: string | null; branch: string | null; state: string | null;
  last_event_at: number | null; reachable: boolean; unreachable_reason: string | null;
};
export type CoverageSource = { source_id: string; kind: "ledger" | "control" | "recon" | "pull"; freshness: "fresh" | "stale" | "unavailable"; last_read_at: number | null; reason: string | null };
export type ManagerTurnContext = {
  version: "manager_turn_context_v1";
  generated_at: number;
  snapshot_id: string;
  attention: { now: CompactAttention[]; inbox: CompactAttention[]; follow_up: CompactFollowUp[] };
  works: CompactWork[];
  waits: CompactWait[];
  sessions: CompactSession[];
  recent_done: CompactAttention[];
  targets: HandoffTarget[];
  coverage: {
    session_window_days: number; sessions_included: number; sessions_omitted: number;
    done_window_days: number; done_included: number; done_omitted: number;
    attention_included: number; attention_omitted: number;
    health: { open_incidents: number; coverage_gaps: number; telemetry_gaps: number };
    sources: CoverageSource[];
  };
};

/** Recursively scrub every string with the shared redactor. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return scrubText(value) as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}

const TIMESTAMP_KEYS = new Set(["observed_at", "effect_verified_at", "at"]);
function evidenceTimestamps(evidence: unknown, path = "", depth = 0, out: EvidenceTimestamp[] = []): EvidenceTimestamp[] {
  if (depth > 3 || !evidence || typeof evidence !== "object") return out;
  for (const [key, value] of Object.entries(evidence)) {
    const field = path ? `${path}.${key}` : key;
    if (TIMESTAMP_KEYS.has(key) && typeof value === "number" && Number.isFinite(value)) out.push({ field, at: value });
    else if (value && typeof value === "object") evidenceTimestamps(value, field, depth + 1, out);
  }
  return out;
}

export function compactAttention(item: AttentionItem): CompactAttention {
  return {
    item_id: item.item_id, work_id: item.work_id, revision: item.revision, state: item.state, effect_state: item.effect_state,
    urgency: item.urgency, conclusion: item.conclusion, trigger: item.trigger, impact: item.impact, recommendation: item.recommendation,
    options: item.options, owner: item.owner, expires_at: item.expires_at, defer_until: item.defer_until, decision_mode: item.decision_mode,
    source_link: item.source_link, updated_at: item.updated_at, evidence_timestamps: evidenceTimestamps(item.evidence),
  };
}
export function compactFollowUp(entry: AttentionFollowUp): CompactFollowUp {
  return {
    item_id: entry.item.item_id, work_id: entry.item.work_id, conclusion: entry.item.conclusion, stage: entry.stage, receipt_id: entry.receipt_id,
    consumed_at: entry.consumed_at, applied_at: entry.applied_at, outcome: entry.outcome,
    remaining_responsibility: entry.remaining_responsibility, next_action: entry.next_action, updated_at: entry.item.updated_at,
  };
}
export function compactWork(work: Work): CompactWork {
  const c = work.contract;
  return { work_id: work.work_id, title: work.title, state: work.state, revision: work.revision, objective: c?.objective ?? null, decision_owner: c?.decision_owner ?? null, deadline_at: c?.budget?.deadline_at ?? null, acceptance_count: c?.acceptance?.length ?? 0 };
}
export function compactWait(wait: ConditionWait): CompactWait {
  return { wait_id: wait.wait_id, work_id: wait.work_id, item_id: wait.item_id, kind: String((wait.condition as { kind?: unknown }).kind ?? "unknown"), state: wait.state, due_at: wait.next_check_at, expires_at: wait.deadline_at, disposition: wait.disposition };
}

type SessionMeta = { host: string | null; cwd: string | null; branch: string | null; ended: number };
function sessionMeta(ledger: Database, stableId: string): SessionMeta {
  return (ledger.query(`SELECT host, cwd, branch,
    EXISTS(SELECT 1 FROM journal_all WHERE stable_id=?1 AND kind='session_ended') ended
    FROM sessions WHERE stable_id=?1`).get(stableId) as SessionMeta | null) ?? { host: null, cwd: null, branch: null, ended: 0 };
}

export type ManagerReadModel = {
  now: AttentionItem[]; inbox: AttentionItem[]; followUps: AttentionFollowUp[]; done: AttentionItem[]; doneTotal: number;
  works: Work[]; waits: ConditionWait[];
  sessions: Array<SessionSummary & SessionMeta>;
  health: ManagerTurnContext["coverage"]["health"];
  sources: CoverageSource[];
};

function latestAt(ledger: Database, kinds: string[]): number | null {
  const row = ledger.query(`SELECT MAX(at) at FROM journal_all WHERE kind IN (${kinds.map(() => "?").join(",")})`).get(...kinds) as { at: number | null };
  return row.at;
}

/**
 * Load the read model shared by the snapshot and the paged read views.
 * When doneLimit is provided, done is capped at that count but doneTotal remains the full
 * matching total (inclusive cutoff) for accurate omitted accounting.
 */
export function loadManagerReadModel(control: Database, ledger: Database | null, now: number, doneLimit?: number): ManagerReadModel {
  const doneCutoff = now - DONE_WINDOW_DAYS * DAY_MS;
  const works = listWorks(control).filter((w) => w.state !== "completed" || w.updated_at >= doneCutoff);
  const waits = listConditionWaits(control, { limit: 200 }).filter((w) => w.state === "watching" || w.state === "ready" || w.updated_at >= doneCutoff);
  const attentionNow = listAttention(control, "now", now), inbox = listAttention(control, "inbox", now);
  const controlLatest = Math.max(0, ...[...attentionNow, ...inbox].map((i) => i.updated_at), ...works.map((w) => w.updated_at)) || null;
  const sources: CoverageSource[] = [{ source_id: "control", kind: "control", freshness: "fresh", last_read_at: controlLatest, reason: null }];
  let sessions: ManagerReadModel["sessions"] = [];
  let health = { open_incidents: 0, coverage_gaps: 0, telemetry_gaps: 0 };
  if (!ledger) {
    sources.push({ source_id: "ledger", kind: "ledger", freshness: "unavailable", last_read_at: null, reason: "ledger_unavailable" });
  } else {
    try {
      sessions = querySessions(ledger, -1, now).map((s) => ({ ...s, ...sessionMeta(ledger, s.stable_id) }));
      const h = queryHealth(ledger);
      health = { open_incidents: h.open_incidents.length, coverage_gaps: h.coverage_gaps, telemetry_gaps: h.telemetry_gaps };
      const ledgerLatest = (ledger.query("SELECT MAX(at) at FROM journal").get() as { at: number | null }).at;
      sources.push({ source_id: "ledger", kind: "ledger", freshness: ledgerLatest !== null && now - ledgerLatest <= SOURCE_STALE_MS ? "fresh" : "stale", last_read_at: ledgerLatest, reason: ledgerLatest === null ? "no_ledger_events" : null });
      const reconAt = latestAt(ledger, RECON_KINDS);
      sources.push({ source_id: "recon", kind: "recon", freshness: reconAt === null ? "unavailable" : "fresh", last_read_at: reconAt, reason: reconAt === null ? "no_recon_signal" : null });
      const pullAt = latestAt(ledger, PULL_KINDS);
      const outage = h.open_incidents[0]?.source ?? null;
      sources.push({ source_id: "pull", kind: "pull", freshness: outage ? "stale" : pullAt === null ? "unavailable" : "fresh", last_read_at: pullAt, reason: outage ? `open_incident:${outage}` : pullAt === null ? "no_pull_signal" : null });
    } catch (error) {
      sessions = [];
      sources.push({ source_id: "ledger", kind: "ledger", freshness: "unavailable", last_read_at: null, reason: `ledger_read_failed: ${(error as Error).message}` });
    }
  }
  const donePage = doneLimit === undefined ? null : listAttentionPage(control, "done", { updated_since: Math.max(0, doneCutoff), limit: doneLimit }, now);
  const done = donePage?.items ?? listAttention(control, "done", now, { updated_since: Math.max(0, doneCutoff) });
  return { now: attentionNow, inbox, followUps: listAttentionFollowUps(control, now), done, doneTotal: donePage?.total ?? done.length, works, waits, sessions, health, sources };
}

export function compactSession(s: SessionSummary & SessionMeta): CompactSession {
  return { stable_id: s.stable_id, runtime: s.runtime, cwd: s.cwd, branch: s.branch, state: s.state, queue: s.queue, q5_reason: s.q5_reason, last_event_at: s.last_event_at, handoff: s.handoff ? { status: s.handoff.status, uncertainties: s.handoff.uncertainties } : null };
}

/** Local pi/omp/prime sessions that have not ended; a stuck session is kept but marked unreachable. */
export function handoffTargets(sessions: ManagerReadModel["sessions"]): HandoffTarget[] {
  return sessions
    .filter((s) => s.host === "local" && !!s.runtime && TARGET_RUNTIMES.has(s.runtime) && !s.ended)
    .map((s) => ({ target_kind: "session" as const, target_id: s.stable_id, runtime: s.runtime!, cwd: s.cwd, branch: s.branch, state: s.state, last_event_at: s.last_event_at, reachable: !s.q5_reason, unreachable_reason: s.q5_reason }));
}

export function buildManagerContext(control: Database, ledger: Database | null, opts: { now?: number } = {}): ManagerTurnContext {
  const now = opts.now ?? Date.now();
  const model = loadManagerReadModel(control, ledger, now, DONE_CAP);
  const cap = <T>(rows: T[], n: number) => rows.slice(0, n);
  const attentionTotal = model.now.length + model.inbox.length + model.followUps.length;
  const attention = {
    now: cap(model.now, ATTENTION_CAP).map(compactAttention),
    inbox: cap(model.inbox, ATTENTION_CAP).map(compactAttention),
    follow_up: cap(model.followUps, ATTENTION_CAP).map(compactFollowUp),
  };
  const attentionIncluded = attention.now.length + attention.inbox.length + attention.follow_up.length;
  const sessions = cap(model.sessions, SESSION_CAP).map(compactSession);
  const recentDone = model.done.map(compactAttention);
  const body = redactDeep({
    version: "manager_turn_context_v1" as const,
    attention,
    works: model.works.map(compactWork),
    waits: model.waits.map(compactWait),
    sessions,
    recent_done: recentDone,
    targets: handoffTargets(model.sessions),
    coverage: {
      session_window_days: Math.round(SESSION_WINDOW_MS / DAY_MS), sessions_included: sessions.length, sessions_omitted: model.sessions.length - sessions.length,
      done_window_days: DONE_WINDOW_DAYS, done_included: recentDone.length, done_omitted: Math.max(0, model.doneTotal - recentDone.length),
      attention_included: attentionIncluded, attention_omitted: attentionTotal - attentionIncluded,
      health: model.health, sources: model.sources,
    },
  });
  return { version: body.version, generated_at: now, snapshot_id: digest(body), attention: body.attention, works: body.works, waits: body.waits, sessions: body.sessions, recent_done: body.recent_done, targets: body.targets, coverage: body.coverage };
}
