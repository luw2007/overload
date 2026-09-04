import type { Database } from "bun:sqlite";
import type { Handoff } from "../shared/queries";

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
export type AuditReport = {
  sample: number;
  sinceMs: number;
  sessions: AuditSession[];
  gatedRequested: number;
  gatedResolved: number;
  gatedTerminal: number;
  passRate: number;
  repeatedFailurePatterns: string[];
  rulesToAdd: string[];
};

const TERMINAL_STATES = new Set(["resolved", "cancelled", "timed_out"]);
const HANDOFF_STATUSES = new Set(["complete", "partial", "blocked", "unknown"]);

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

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function inWindow(at: number, cutoff: number, now: number): boolean {
  return at >= cutoff && at <= now;
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
  const windowRows = db.query("SELECT ingest_seq, stable_id, at, kind, detail FROM journal WHERE at>=? AND at<=? ORDER BY at DESC, ingest_seq DESC").all(cutoff, options.now) as JournalRow[];
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
    const allRows = db.query("SELECT ingest_seq, stable_id, at, kind, detail FROM journal WHERE at<=? ORDER BY at ASC, ingest_seq ASC").all(options.now) as JournalRow[];
    for (const row of allRows) {
      if (!selected.has(row.stable_id)) continue;
      const rows = history.get(row.stable_id);
      if (rows) rows.push(row); else history.set(row.stable_id, [row]);
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
    repeatedFailurePatterns,
    rulesToAdd,
  };
}

export function printAudit(report: AuditReport, output: (line: string) => void = console.log): void {
  output(`PASS_RATE ${(report.passRate * 100).toFixed(1)}% (${report.gatedResolved}/${report.gatedTerminal})`);
  output(`SESSIONS ${report.sessions.length}`);
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
