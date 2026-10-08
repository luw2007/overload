#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAnswersDb, defaultAnswersPath } from "../orchestrator/approval";
import { cancelTarget, closeTarget, consumeConflictBody, consumeDecisionResult, reconcileExtensionGateClosures,
  isConsumeConflict, observeAndProjectReceiptEffect, reconcileEffectEvents, registerTarget, writeHumanAnswer, setBotDisabled } from "../decision-bot/mailbox";
import type { ConsumerOwner } from "../decision-bot/mailbox";
import { approvePolicyCandidate, enablePolicyCandidate, getPolicyCandidate, loadPolicy, matchingRule, policyAuthorizes, rulesReport } from "../decision-bot/policy";
import { disablePolicyRule, enablePolicyRule, proposeRuleFromAttention } from "../decision-bot/policy";
import { DecisionBotService } from "../decision-bot/service";
import { ackRequest, queryArchive, queryHealth, queryHung, queryJumpTarget, queryQ1, querySession, querySessions, queryZombie, requestSession, type JumpTarget } from "../shared/queries";
import { performJump, type JumpResult } from "../shared/jump";
import { inspectResume, resumeSession, type CheckpointProbe, type ProcessProbe, type ResumeExecutor } from "../shared/resume";
import { listingSnapshotProbe } from "../shared/checkpoint";
import type { LaunchLeases } from "../shared/launch-lease";
import { mgmtRoute } from "./mgmt-routes";
import { contextRoute } from "./context-routes";
import { conversationRoute } from "./conversation-routes";
import { managerRoute, type ManagerRouteDeps } from "../manager/routes";
import { recordAcceptance } from "../manage/manifest";
import { acknowledgeHandoff, createHandoffRequest, expireStaleHandoffs, listHandoffReturns, listHandoffs, listPendingHandoffs, markHandoffRead, recordHandoffConclusion } from "../control/handoff";
import type { HandoffAckDecision, HandoffConclusionKind, HandoffSourceKind, HandoffState } from "../control/handoff-types";
import { actOnAttention, cancelConditionWait, ControlError, createWork, getAttention, getAttentionMaterial, getConditionWait, getWork, listAttention, listAttentionPage, listAttentionFollowUps, listConditionWaits, listWorks, openControl, recordAttentionFeedback, recordStopCondition, redirectWork, resolveAttention, reviseContract, promoteWork } from "../control/store";
import { previewContractRevision } from "../control/store";
import type { AttentionDecisionInput, AttentionItem, ConditionWait, Contract, CreateWaitInput, StaleAttentionBody, WaitBaseline, WaitCondition, WaitDispositionInput, WaitErrorKind, WaitSourceAdapters, WaitState } from "../control/types";
import { cancelTarget } from "../decision-bot/mailbox";
import { createWait } from "../waits/create";
import { conditionWaitsEnabled } from "../waits/gate";
import { createResumeGrant, inspectWaitRecovery, type WaitRecoveryCapability } from "../waits/recovery";
import { createChildProcessRegistry, WAIT_SERVICE_ACTOR } from "../waits/runner";
import { createCheckResultAdapter } from "../waits/sources/check-result";
import { createGithubPrAdapter } from "../waits/sources/github-pr";
import { createWorkCompleteAdapter } from "../waits/sources/work-complete";
import { notificationCapability } from "../notify/nudge";
import { initializeLedger } from "../ingest/ingest";
import { publishControlEvents } from "../control/outbox";
import { openStore } from "../orchestrator/store";
import { Coordinator } from "../orchestrator/coordinator";
import { ingestContextSpool } from "../control/context-ingest";
import { ingestExternalObservation, listExternalObservations } from "../control/external-observations";
import { claimSemanticAssessments, listSemanticAssessments, scheduleSemanticAssessment, settleSemanticAssessment } from "../control/semantic-assessments";
import { validateExternalObservationInput } from "../shared/external-observation-contract";
import {ensureAdapterSchema,type Conversation,type StoredTurn} from '../adapters/store';
import {randomUUID} from 'node:crypto';
import { SpoolWriter } from "../orchestrator/spool";

import { ledgerReport } from "./ledger";

const DEFAULT_WEB_PORT = 4870;
/** The list is a launchpad for drill-down, not an inventory: 1000 rows serve nobody. */
const SESSION_LIST_LIMIT = 100;
let warnedInvalidConfig = false;
let warnedInvalidWebPort = false;

export type WebConfig = { web_port: number };

/** Port precedence is config.json > OVERLOAD_WEB_PORT > 4870. config.json wins because it is
 *  the only setting the extension also reads when it resolves the control-plane port, so it is
 *  the one that keeps both sides agreeing. The env var is a fallback for manual runs; the
 *  LaunchAgent never sees it, since the plists carry only OVERLOAD_ROOT and OVERLOAD_BUN. */
export async function loadWebConfig(
  path = join(homedir(), ".overload", "config.json"),
  env: { OVERLOAD_WEB_PORT?: string } = process.env,
): Promise<WebConfig> {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
    else warnInvalidConfig(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnInvalidConfig(path);
  }
  if (value.web_port !== undefined && !validPort(value.web_port)) warnInvalidConfig(path);
  if (validPort(value.web_port)) return { web_port: value.web_port };
  return { web_port: envPort(env.OVERLOAD_WEB_PORT) ?? DEFAULT_WEB_PORT };
}

/** An unusable value is reported and ignored: a listener that refuses to start is a worse
 *  answer than the default port, and silently doing nothing is what this var used to do. */
function envPort(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (raw.trim() !== "" && validPort(parsed)) return parsed;
  if (!warnedInvalidWebPort) {
    warnedInvalidWebPort = true;
    console.error(`overload web: ignoring invalid OVERLOAD_WEB_PORT ${JSON.stringify(raw)}`);
  }
  return null;
}

function validPort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65535;
}

function warnInvalidConfig(path: string): void {
  if (warnedInvalidConfig) return;
  warnedInvalidConfig = true;
  console.error(`overload web: ignoring invalid config ${path}`);
}

const staticRoot = fileURLToPath(new URL("./static/", import.meta.url));


function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function withReadonlyDb<T>(path: string, query: (db: Database) => T): T {
  const db = new Database(path, { readonly: true });
  try { return query(db); } finally { db.close(); }
}

/** Launch leases for read-only resume capability: a missing or unopenable control DB holds none. */
function withReadonlyLeases<T>(controlPath: string, query: (leases: LaunchLeases | null) => T): T {
  let db: Database | null = null;
  try { db = new Database(controlPath, { readonly: true }); } catch { /* no control DB yet → no lease */ }
  try { return query(db && { db, now: Date.now }); } finally { db?.close(); }
}

function routeParameter(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function ensureCloseouts(path: string): void {
  const db = new Database(path);
  try { db.exec("CREATE TABLE IF NOT EXISTS closeouts(stable_id TEXT PRIMARY KEY, closed_at INTEGER NOT NULL)"); } finally { db.close(); }
}

/** CSRF hygiene, not caller binding (plan §5.1): Host blocks DNS rebinding, Origin
 *  blocks cross-site POST. Any same-UID local process can still supply both headers. */
function controlError(error: unknown): Response {
  if (error instanceof ControlError) {
    const status = error.code === "not_found" ? 404 : error.code === "invalid" ? 400 : 409;
    return json({ error: error.code, message: error.message }, { status });
  }
  throw error;
}

function staleAttentionBody(item: AttentionItem, expectedRevision: number): StaleAttentionBody {
  return {
    error: "conflict",
    message: "stale attention revision",
    code: "stale_attention",
    item_id: item.item_id,
    expected_revision: expectedRevision,
    current_revision: item.revision,
    current_state: item.state,
    current_effect_state: item.effect_state,
    decision_package_url: `/api/context/decision-package?item_id=${encodeURIComponent(item.item_id)}&work_id=${encodeURIComponent(item.work_id)}`,
  };
}

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlError("invalid", "JSON object required");
  return value as Record<string, unknown>;
}

function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ControlError("invalid", "expected_revision must be a positive integer");
  return value;
}

// ── Phase B condition waits (docs/plans/overload-20260926-phaseB-contract.md §10) ──

/**
 * §10.1: `resume_grant` never leaves the server; only its presence is reported. Field-level redaction for a
 * non-owner actor reduces the condition to its kind and drops the baseline.
 */
export type WebConditionWait = Omit<ConditionWait, "resume_grant" | "condition" | "baseline"> & {
  condition: WaitCondition | { kind: WaitCondition["kind"] };
  baseline: WaitBaseline | null;
  has_resume_grant: boolean;
};

/** §10.1 read model. Every field is server-derived; the UI renders Answer/Resume only from `actions`. */
export type ConditionWaitReadModel = {
  wait: WebConditionWait;
  condition_summary: string;
  latest_observation: { summary: string; observed_at: number | null; confirmed_at: number | null };
  /**
   * `next_check_at` is null while observation is paused: a disabled observer promises no next check. The raw
   * row value stays on `wait.next_check_at` as the persisted schedule that resumes once re-enabled (§14.3).
   */
  schedule: { next_check_at: number | null; deadline_at: number };
  /** §14.3: `paused` only for a `watching` row on a server whose condition-wait gate is off. */
  observation: { state: "active" | "paused" | "stopped"; reason: "condition_waits_disabled" | null };
  error: { kind: WaitErrorKind; detail: string; failures: number; budget: number; retry_after_at: number | null } | null;
  attention: { item_id: string; current_revision: number; state: AttentionItem["state"]; effect_state: AttentionItem["effect_state"] } | null;
  recovery_capability: WaitRecoveryCapability;
  actions: { cancel: boolean; jump_url: string | null; answer: boolean; resume: boolean };
};

/** `observing` is this server's resolved §14.1 gate (`OVERLOAD_CONDITION_WAITS`), never a request input. */
type WaitReadContext = { control: Database; mailbox: Database; ledger: Database | null; actor: string; now: number; processAlive?: ProcessProbe; checkpointProbe?: CheckpointProbe; observing: boolean };

const WAIT_ERROR_KINDS: Record<string, true> = {
  transient: true, rate_limited: true, permission_denied: true, unsupported_provider: true, configuration: true,
  invalid_response: true, identity_mismatch: true, source_missing: true, unknown: true,
};
/** Bounded, never a full stderr: source adapters already sanitize, the Web additionally caps what it returns. */
const WAIT_TEXT_LIMIT = 500;
/** One live baseline read per create; the adapter child is killed when this (or the client) aborts. */
const WAIT_BASELINE_TIMEOUT_MS = 15_000;
const WAIT_ROUTE = /^\/api\/waits(?:\/([^/]+)(?:\/([^/]+))?)?$/;
/** Wait ids are UUIDs, so this literal segment never shadows `/api/waits/:wait_id`. */
const WAIT_GRANT_ROUTE = "/api/waits/resume-grant";
/**
 * The only client-settable fields of a resume-grant wait. The checkpoint (runtime/session/cwd/file/last entry/bytes and
 * its reference), the grant, its attempt and execution owner are all server-derived; anything else is rejected (§8.1 rule 4).
 */
const RESUME_GRANT_FIELDS: Record<string, true> = { work_id: true, item_id: true, condition: true, deadline_at: true, stable_id: true, transient_budget: true };
const REDACTED_CONDITION: Record<WaitCondition["kind"], string> = {
  github_pr_merged: "A GitHub pull request is merged",
  check_new_result: "A new check result is recorded",
  work_completed: "A prerequisite Work completes",
};

function boundedWaitText(value: string): string {
  return value.length > WAIT_TEXT_LIMIT ? `${value.slice(0, WAIT_TEXT_LIMIT - 1)}…` : value;
}

function waitConditionSummary(condition: WaitCondition): string {
  if (condition.kind === "github_pr_merged") {
    const s = condition.source;
    return `GitHub PR ${s.host === "github.com" ? "" : `${s.host}/`}${s.owner}/${s.repo}#${s.number} is merged`;
  }
  if (condition.kind === "check_new_result") {
    const s = condition.source;
    return `New ${s.check_id} result (definition ${s.check_def_version}) for attempt ${s.attempt_id}`;
  }
  return `Work ${condition.source.prerequisite_work_id} completes (dependency r${condition.source.dependency_revision})`;
}

/** Summarizes the last identity-verified source snapshot; errors never replace it (§3.3 `observed_json`). */
function waitObservationSummary(wait: ConditionWait): string {
  const observed = wait.observed ?? {};
  const fact = (key: string): string | null => typeof observed[key] === "string" || typeof observed[key] === "number" ? String(observed[key]) : null;
  let summary: string;
  if (wait.condition.kind === "github_pr_merged") {
    summary = fact("merged_at") ? `PR merged at ${fact("merged_at")}` : `PR ${(fact("state") ?? "state unknown").toLowerCase()} · updated ${fact("updated_at") ?? "unknown"}`;
  } else if (wait.condition.kind === "check_new_result") {
    summary = fact("status") ? `Result ${fact("status")} in result set v${fact("result_set_version")}` : `No new result after result set v${fact("result_set_version") ?? "?"}`;
  } else {
    summary = `Prerequisite is ${fact("state") ?? "in an unknown state"} at revision ${fact("work_revision") ?? "?"}`;
  }
  return wait.unchanged_count > 0 ? `${summary} · unchanged for ${wait.unchanged_count} check${wait.unchanged_count === 1 ? "" : "s"}` : summary;
}

/** Field-level visibility (§10.1): only the wait's or the Work's current decision owner sees source identity and raw facts. */
function webConditionWait(wait: ConditionWait, visible: boolean): WebConditionWait {
  const { resume_grant, ...rest } = wait;
  const projected: WebConditionWait = {
    ...rest, has_resume_grant: resume_grant !== null,
    last_error_detail: rest.last_error_detail === null ? null : boundedWaitText(rest.last_error_detail),
  };
  if (visible) return projected;
  return {
    ...projected, condition: { kind: wait.condition.kind }, source_identity: {}, baseline: null,
    observed: null, disposition_detail: null, last_error_detail: null,
  };
}

function waitRecoveryCapability(ctx: WaitReadContext, wait: ConditionWait): WaitRecoveryCapability {
  try {
    return inspectWaitRecovery(ctx.control, ctx.mailbox, ctx.ledger, wait, { now: ctx.now, processAlive: ctx.processAlive, checkpointProbe: ctx.checkpointProbe });
  } catch (error) {
    // Recovery facts that cannot be read are unknown: never a guessed button.
    console.error(`overload web: wait ${wait.wait_id} recovery inspection failed: ${(error as Error).message}`);
    return { state: "unknown", reason: "recovery_inspection_failed", jump_url: null };
  }
}

export function waitReadModel(ctx: WaitReadContext, wait: ConditionWait): ConditionWaitReadModel {
  const owner = getWork(ctx.control, wait.work_id)?.contract?.decision_owner ?? null;
  const visible = ctx.actor === wait.decision_owner || ctx.actor === owner;
  const item = getAttention(ctx.control, wait.item_id);
  const capability = waitRecoveryCapability(ctx, wait);
  // A cancelled wait is history only; everything else keeps the original item's exits.
  const live = visible && wait.state !== "cancelled";
  const paused = wait.state === "watching" && !ctx.observing;
  return {
    wait: webConditionWait(wait, visible),
    condition_summary: visible ? waitConditionSummary(wait.condition) : REDACTED_CONDITION[wait.condition.kind],
    latest_observation: {
      summary: visible ? waitObservationSummary(wait) : "Source facts are visible to the decision owner only.",
      observed_at: wait.last_observed_at, confirmed_at: wait.last_confirmed_at,
    },
    schedule: { next_check_at: paused ? null : wait.next_check_at, deadline_at: wait.deadline_at },
    observation: { state: wait.state !== "watching" ? "stopped" : paused ? "paused" : "active", reason: paused ? "condition_waits_disabled" : null },
    error: wait.last_error_kind === null ? null : {
      kind: wait.last_error_kind, detail: visible ? boundedWaitText(wait.last_error_detail ?? "") : "", failures: wait.transient_failures,
      budget: wait.transient_budget, retry_after_at: wait.retry_after_at,
    },
    attention: item ? { item_id: item.item_id, current_revision: item.revision, state: item.state, effect_state: item.effect_state } : null,
    recovery_capability: visible || capability.state === "available" ? capability : { ...capability, jump_url: null },
    actions: {
      cancel: wait.state === "watching" && owner !== null && ctx.actor === owner,
      jump_url: live && capability.state !== "available" ? capability.jump_url : null,
      answer: live && capability.state === "available" && capability.action === "answer_live_request",
      // Never a Web button: an authorized resume is dispatched only by the maintenance runner (dispatchAuthorizedRecovery,
      // effect proof by observeRecoveryEffect) once the condition holds; the Web only pins the grant (POST WAIT_GRANT_ROUTE).
      resume: false,
    },
  };
}

/** Source adapters (github-pr, check-result, work-complete) throw typed errors carrying the §7.2 classification. */
function sourceError(error: unknown): { kind: WaitErrorKind; message: string; retry_after_at: number | null } | null {
  if (!(error instanceof Error) || !("error_kind" in error) || typeof error.error_kind !== "string" || !Object.hasOwn(WAIT_ERROR_KINDS, error.error_kind)) return null;
  const retryAfter = "retry_after_at" in error && typeof error.retry_after_at === "number" ? error.retry_after_at : null;
  return { kind: error.error_kind as WaitErrorKind, message: boundedWaitText(error.message), retry_after_at: retryAfter };
}

/** 409 for a wait that exists but cannot take the requested change; always carries the current row (§10.2). */
function waitConflict(ctx: WaitReadContext, error: ControlError, waitId: string | null, extra: Record<string, unknown> = {}): Response {
  const details = error.details && "wait_id" in error.details ? error.details : null;
  const current = getConditionWait(ctx.control, details?.wait_id ?? waitId ?? "");
  return json({
    error: "conflict",
    code: details?.code ?? "stale_wait",
    message: error.message,
    ...extra,
    ...(current ? { wait_id: current.wait_id, version: current.version, state: current.state, disposition_state: current.disposition_state } : {}),
    current: current ? waitReadModel(ctx, current) : null,
  }, { status: 409 });
}

function waitCreateError(ctx: WaitReadContext, error: unknown, signal: AbortSignal): Response {
  if (error instanceof ControlError) {
    if (error.code === "forbidden") return json({ error: "forbidden", message: error.message }, { status: 403 });
    if (error.code === "invalid") return json({ error: "invalid", message: error.message }, { status: 400 });
    if (error.details && "wait_id" in error.details) return waitConflict(ctx, error, null);
    const stale = !/authorization/.test(error.message);
    return json({ error: "conflict", code: stale ? "stale_work_item" : "invalid_authorization", message: error.message }, { status: 409 });
  }
  const source = sourceError(error);
  if (source?.kind === "unsupported_provider") {
    return json({ error: "unsupported_source", error_kind: source.kind, message: source.message }, { status: 422 });
  }
  if (source || signal.aborted) {
    return json({
      error: "conflict", code: "baseline_unbindable", error_kind: source?.kind ?? "transient",
      message: source?.message ?? "live baseline read did not finish before the deadline",
      ...(source?.retry_after_at ? { retry_after_at: source.retry_after_at } : {}),
    }, { status: 409 });
  }
  throw error;
}

/**
 * `/api/waits` routes (§10.1). The trusted actor comes only from `startWebServer` options/env, never from the
 * request; baseline reads use server-owned adapters. There is intentionally no ready/observe/resume route:
 * `POST /api/waits/resume-grant` only pins the owner's consent to a future resume, which maintenance dispatches.
 */
async function waitRoute(request: Request, url: URL, deps: {
  controlPath: string; ledgerPath: string; actor: string | undefined; adapters: WaitSourceAdapters; processAlive?: ProcessProbe; checkpointProbe?: CheckpointProbe; conditionWaits: boolean;
}): Promise<Response> {
  const match = url.pathname.match(WAIT_ROUTE);
  const waitId = match?.[1] === undefined ? null : routeParameter(match[1]);
  const operation = match?.[2];
  const grantRoute = url.pathname === WAIT_GRANT_ROUTE;
  const known = grantRoute ? request.method === "POST" : !!match && (request.method === "GET" ? operation === undefined
    : request.method === "POST" && (waitId === null || operation === "cancel"));
  if (!known) return json({ error: "not_found" }, { status: 404 });
  // §14.1 gate: creation is refused before any body parse, DB open, or baseline adapter read. Reads and
  // cancels of existing rows stay available so a disabled deployment can still inspect and withdraw them.
  if (request.method === "POST" && (waitId === null || grantRoute) && !deps.conditionWaits) {
    return json({ error: "disabled", code: "condition_waits_disabled", message: "condition waits are disabled on this server (set OVERLOAD_CONDITION_WAITS=1 to enable)" }, { status: 503 });
  }
  const actor = deps.actor?.trim();
  if (!actor) return json({ error: "not_implemented", message: "condition waits require a server-side actor identity" }, { status: 501 });
  let input: Record<string, unknown> = {};
  if (request.method === "POST") {
    try { input = await bodyObject(request); } catch { return json({ error: "invalid", message: "JSON object required" }, { status: 400 }); }
  }
  const control = openControl(deps.controlPath);
  const mailbox = openAnswersDb(deps.controlPath);
  let ledger: Database | null = null;
  try { ledger = new Database(deps.ledgerPath, { readonly: true }); } catch { /* recovery reports ledger_unavailable */ }
  const ctx: WaitReadContext = { control, mailbox, ledger, actor, now: Date.now(), processAlive: deps.processAlive, checkpointProbe: deps.checkpointProbe, observing: deps.conditionWaits };
  try {
    if (grantRoute) return await createResumeGrantWait(ctx, input, request.signal, deps.adapters);
    if (request.method === "GET" && waitId === null) {
      const [workId, itemId, state, limit] = ["work_id", "item_id", "state", "limit"].map((key) => url.searchParams.get(key));
      const filter = {
        ...(workId ? { work_id: workId } : {}),
        ...(itemId ? { item_id: itemId } : {}),
        // Validated by listConditionWaits against the closed WaitState set.
        ...(state ? { state: state as WaitState } : {}),
        ...(limit ? { limit: Number(limit) } : {}),
      };
      // The gate is server-resolved; the UI shows create/observation state only from this field.
      const gate = { enabled: deps.conditionWaits, reason: deps.conditionWaits ? null : "condition_waits_disabled" };
      return json({ items: listConditionWaits(control, filter).map((wait) => waitReadModel(ctx, wait)), gate });
    }
    if (request.method === "GET") {
      const wait = getConditionWait(control, waitId!);
      return wait ? json(waitReadModel(ctx, wait)) : json({ error: "not_found" }, { status: 404 });
    }
    if (waitId === null) {
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(WAIT_BASELINE_TIMEOUT_MS)]);
      try {
        const wait = await createWait(control, input as CreateWaitInput, { actor, adapters: deps.adapters, mailbox, signal });
        const model = waitReadModel({ ...ctx, now: Date.now() }, wait);
        return json({ wait: model.wait, recovery_capability: model.recovery_capability }, { status: 201 });
      } catch (error) { return waitCreateError(ctx, error, signal); }
    }
    const extra = Object.keys(input).find((key) => key !== "expected_version" && key !== "reason");
    if (extra !== undefined) return json({ error: "invalid", message: `unexpected field ${extra}` }, { status: 400 });
    try {
      const wait = cancelConditionWait(control, waitId!, input.expected_version as number, { actor, reason: input.reason as string });
      return json({ wait: webConditionWait(wait, true) });
    } catch (error) {
      if (!(error instanceof ControlError)) throw error;
      if (error.code === "not_found") return json({ error: "not_found", message: error.message }, { status: 404 });
      if (error.code === "forbidden") return json({ error: "forbidden", message: error.message }, { status: 403 });
      if (error.code === "invalid") return json({ error: "invalid", message: error.message }, { status: 400 });
      return waitConflict(ctx, error, waitId, { expected_version: input.expected_version });
    }
  } catch (error) {
    if (error instanceof ControlError && error.code === "invalid") return json({ error: "invalid", message: error.message }, { status: 400 });
    throw error;
  } finally {
    ledger?.close(); mailbox.close(); control.close();
  }
}

/**
 * Creates an `authorized_resume` wait for the decision owner (§4.2 rule 5, §8.4): pins the resume grant for the
 * server-probed checkpoint of `stable_id` (`createResumeGrant`, owner-checked like wait creation), then creates the
 * wait bound to it. A wait that cannot be created closes the just-pinned grant so no consent outlives its wait —
 * unless a concurrent request already bound an unsettled wait to that exact target version.
 */
async function createResumeGrantWait(ctx: WaitReadContext, input: Record<string, unknown>, requestSignal: AbortSignal, adapters: WaitSourceAdapters): Promise<Response> {
  const extra = Object.keys(input).find((key) => !Object.hasOwn(RESUME_GRANT_FIELDS, key));
  if (extra !== undefined) {
    return json({ error: "invalid", code: "server_derived_field", message: `unexpected field ${extra}: the checkpoint, grant and execution identity are server-derived` }, { status: 400 });
  }
  const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(WAIT_BASELINE_TIMEOUT_MS)]);
  let disposition: Extract<WaitDispositionInput, { kind: "authorized_resume" }>;
  try {
    disposition = createResumeGrant(ctx.control, ctx.mailbox, ctx.ledger, {
      work_id: input.work_id as string, item_id: input.item_id as string, condition: input.condition as WaitCondition,
      stable_id: input.stable_id as string, attempt_id: `resume-grant:${randomUUID()}`, execution_owner: WAIT_SERVICE_ACTOR,
      expires_at: input.deadline_at as number,
    }, { actor: ctx.actor, actor_source: "server", now: Date.now(), processAlive: ctx.processAlive, checkpointProbe: ctx.checkpointProbe });
  } catch (error) {
    if (error instanceof ControlError && error.code === "blocked" && error.message.startsWith("checkpoint_unavailable")) {
      return json({ error: "conflict", code: "checkpoint_unavailable", message: error.message }, { status: 409 });
    }
    return waitCreateError(ctx, error, signal);
  }
  const { consumer_owner: owner, approval_id: approvalId, target_version: version } = disposition.authorization;
  try {
    const wait = await createWait(ctx.control, {
      work_id: input.work_id as string, item_id: input.item_id as string, condition: input.condition as WaitCondition,
      deadline_at: input.deadline_at as number, disposition,
      ...(input.transient_budget === undefined ? {} : { transient_budget: input.transient_budget as number }),
    }, { actor: ctx.actor, adapters, mailbox: ctx.mailbox, signal });
    const model = waitReadModel({ ...ctx, now: Date.now() }, wait);
    return json({ wait: model.wait, recovery_capability: model.recovery_capability }, { status: 201 });
  } catch (error) {
    const bound = listConditionWaits(ctx.control, { work_id: input.work_id as string, item_id: input.item_id as string })
      .some((wait) => (wait.state === "watching" || wait.state === "ready")
        && wait.resume_grant?.approval_id === approvalId && wait.resume_grant.target_version === version);
    if (!bound) cancelTarget(ctx.mailbox, owner, approvalId, version);
    return waitCreateError(ctx, error, signal);
  }
}

function trustedTargetBinding(db: Database, approvalId: string, effect: string): { workId?: string; contractRevision?: number; humanOnly: boolean } {
  const row = db.query("SELECT work_id,contract_revision FROM control_attention WHERE consumer_owner='extension' AND approval_id=? ORDER BY updated_at DESC LIMIT 1").get(approvalId) as { work_id:string; contract_revision:number } | null;
  if (!row) return { humanOnly: false };
  const work = getWork(db, row.work_id);
  const current = !!work?.contract && work.revision === row.contract_revision;
  return { workId: row.work_id, contractRevision: row.contract_revision, humanOnly: !current || !!work.contract!.scope.human_only_effects?.includes(effect) };
}

function checkOrigin(request: Request, port: number): Response | null {
  if (request.headers.get("host") !== `127.0.0.1:${port}`) return json({ error: "forbidden" }, { status: 403 });
  if (request.method === "GET") return null;
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (origin ? origin !== `http://127.0.0.1:${port}` : fetchSite !== "same-origin") return json({ error: "forbidden" }, { status: 403 });
  return null;
}

// Context handoff (docs/plans/overload-20260928-manager-chat.md §1.5): a brief
// delivered to a receiver session. Not a priority change, not an interruption.
async function handoffRoute(request: Request, url: URL, controlPath: string): Promise<Response | null> {
  if (url.pathname !== "/api/handoff" && !url.pathname.startsWith("/api/handoff/")) return null;
  if (request.method === "POST" && !request.headers.get("sec-fetch-site") && !request.headers.get("sec-fetch-mode")) return json({ error: "forbidden" }, { status: 403 });
  let input: Record<string, unknown> = {};
  if (request.method === "POST") { try { input = await bodyObject(request); } catch { return json({ error: "invalid", message: "JSON object required" }, { status: 400 }); } }
  const control = openControl(controlPath);
  try {
    if (request.method === "POST" && url.pathname === "/api/handoff") {
      const receipt = createHandoffRequest(control, { source_kind: input.source_kind as HandoffSourceKind, source_id: input.source_id as string, target_kind: input.target_kind as "session", target_id: input.target_id as string, brief: input.brief as never, original_message: (input.original_message ?? null) as string | null });
      return json(receipt, { status: 201 });
    }
    if (request.method === "GET" && url.pathname === "/api/handoff") {
      expireStaleHandoffs(control);
      return json({ items: listHandoffs(control, (url.searchParams.get("state") || undefined) as HandoffState | undefined) });
    }
    if (request.method === "GET" && url.pathname === "/api/handoff/pending") {
      const targetId = url.searchParams.get("target_id");
      if (url.searchParams.get("target_kind") !== "session" || !targetId) return json({ error: "invalid", message: "target_kind=session and target_id are required" }, { status: 400 });
      expireStaleHandoffs(control);
      return json({ items: listPendingHandoffs(control, { target_kind: "session", target_id: targetId }) });
    }
    if (request.method === "GET" && url.pathname === "/api/handoff/returns") {
      const kind = url.searchParams.get("destination_kind"), id = url.searchParams.get("destination_id");
      if (!kind || !id) return json({ error: "invalid", message: "destination_kind and destination_id are required" }, { status: 400 });
      return json({ items: listHandoffReturns(control, { destination_kind: kind, destination_id: id }) });
    }
    const action = url.pathname.match(/^\/api\/handoff\/([^/]+)\/(read|ack|conclude)$/);
    if (request.method === "POST" && action) {
      const id = routeParameter(action[1]!);
      if (action[2] === "read") return json(markHandoffRead(control, id));
      if (action[2] === "ack") return json(acknowledgeHandoff(control, id, input.decision as HandoffAckDecision, typeof input.reason === "string" ? input.reason : ""));
      return json(recordHandoffConclusion(control, id, input.kind as HandoffConclusionKind, input.text as string));
    }
    return json({ error: "not found" }, { status: 404 });
  } catch (error) {
    return controlError(error);
  } finally { control.close(); }
}

/** A refused bind (EADDRINUSE) must not leave this instance's publish/ingest timers behind: a
 *  caller that survives the failure — the adapter daemon, which keeps its channel up when the
 *  `web` agent already serves the port — would otherwise keep duplicating that instance's
 *  publish and ingest work every second. */
function bindOrRelease<T>(bind: () => T, release: () => void): T {
  try { return bind(); } catch (error) { release(); throw error; }
}

// Loopback is the v1 trust boundary for host/origin (CSRF), but NOT for caller
// identity. Context routes (plan §4.2) require a server-injected actor; the
// loopback bind only proves "same machine", not "trusted model". The actor below
// is a transition-state minimal trusted injection: production must bind actor to
// an authenticated session/token instead of an env var. Do NOT read actor from
// request headers / body / query.
export function startWebServer(options: { ledgerPath?: string; controlPath?: string; policyPath?: string; orchestratorPath?: string; spoolRoot?: string; publishIntervalMs?: number; contextIngest?: { max_files?: number; max_lines?: number; max_bytes?: number }; port?: number; jump?: (target: JumpTarget) => Promise<JumpResult>; resume?: ResumeExecutor; processAlive?: ProcessProbe; checkpointProbe?: CheckpointProbe; actor?: string; waitAdapters?: WaitSourceAdapters; conditionWaits?: boolean; manager?: Omit<ManagerRouteDeps, "controlPath" | "ledgerPath"> } = {}) {
  // 在创建任何 DB/SpoolWriter 之前显式解析全部路径：不允许把 undefined 传到 open*
  // （Bun 会据 undefined 在 CWD 创建名为 "undefined" 的文件）。
  const ledgerPath = options.ledgerPath ?? process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
  const controlPath = options.controlPath ?? process.env.OVERLOAD_ANSWERS_PATH ?? join(homedir(), ".overload", "orchestrator-answers.db");
  const orchestratorPath = options.orchestratorPath ?? process.env.OVERLOAD_ORCHESTRATOR_PATH ?? join(homedir(), ".overload", "orchestrator.db");
  // 问题 9：publish 的 SpoolWriter、context ingest、orchestrator collector 写入必须共用同一根目录，
  // 否则 publish 走默认 ~/.overload 而 ingest 不启动，collector 事件被静默丢弃。
  // 此处是 startWebServer 内唯一的 spoolRoot 解析点；host 标记缺失时 web server 仍可独立运行。
  const spoolRoot = options.spoolRoot ?? process.env.OVERLOAD_SPOOL_ROOT ?? join(homedir(), ".overload");
  // Trusted actor injected server-side; falls back to env. When absent/empty,
  // context routes and decision POSTs return 501 (no caller-supplied actor is ever accepted).
  const actor = options.actor ?? process.env.OVERLOAD_ACTOR ?? undefined;
  const port = options.port ?? DEFAULT_WEB_PORT;
  const ledger = new Database(ledgerPath, { create: true });
  try {
    ledger.exec("PRAGMA busy_timeout=5000");
    initializeLedger(ledger);
  } finally {
    ledger.close();
  }
  // §14.1: wait creation is default-off; resolved once at startup (OVERLOAD_CONDITION_WAITS="1" enables).
  const conditionWaits = options.conditionWaits ?? conditionWaitsEnabled();
  // Server-owned source adapters for wait baselines (§4.2); a request can never choose or replace them.
  const waitAdapters: WaitSourceAdapters = options.waitAdapters ?? {
    github_pr_merged: createGithubPrAdapter(createChildProcessRegistry().executor),
    check_new_result: createCheckResultAdapter({ orchestratorPath }),
    work_completed: createWorkCompleteAdapter({ controlPath }),
  };
  ensureCloseouts(ledgerPath);
  let publishing = false;
  const publish = () => {
    if (publishing) return;
    publishing = true;
    const control = openAnswersDb(controlPath); const orchestrator = openStore(orchestratorPath); const spool = new SpoolWriter(orchestrator, spoolRoot);
    try { reconcileEffectEvents(control, ledgerPath); reconcileExtensionGateClosures(control); publishControlEvents(control, ledgerPath, (detail) => spool.emit(`control:${String(detail.event_id)}`, "control_event", detail)); }
    finally { spool.close(); orchestrator.close(); control.close(); publishing = false; }
  };
  publish();
  let ingestTimer: ReturnType<typeof setInterval> | null = null;
  // context ingest：读 collector 写入 spoolRoot/<host>/orchestrator/*.ndjson，投影到 control context-pool。
  // 与 publish 共用同一 spoolRoot（问题 9）。SpoolWriter 构造需 <spoolRoot>/host 标记；标记缺失
  // （web server 独立运行、无 orchestrator）时只告警不启动 ingest，不 crash。
  let spoolReady = false;
  try {
    const probeOrch = openStore(orchestratorPath);
    try {
      new SpoolWriter(probeOrch, spoolRoot).close();
      spoolReady = true;
    } finally {
      probeOrch.close();
    }
  } catch (error) {
    console.error(`overload web: context ingest disabled (no usable spool at ${spoolRoot}): ${(error as Error).message}`);
  }
  if (spoolReady) {
    const ingest = () => {
      let control: Database | null = null;
      try {
        control = openAnswersDb(controlPath);
        const orchestrator = openStore(orchestratorPath);
        try {
          const spool = new SpoolWriter(orchestrator, spoolRoot);
          try {
            const stats = ingestContextSpool(control, spool.dir, options.contextIngest);
            if (stats.busy || stats.read > 0 || stats.deferred > 0 || stats.blocked_files > 0) {
              console.error(`overload web: context ingest busy=${stats.busy} backlog_files=${stats.backlog_files} backlog_bytes=${stats.backlog_bytes} read=${stats.read} bytes_read=${stats.bytes_read} processed_files=${stats.processed_files} deferred=${stats.deferred} blocked_files=${stats.blocked_files} created=${stats.created} idempotent=${stats.idempotent} quarantined=${stats.quarantined} failed=${stats.failed}`);
            }
          } finally { spool.close(); }
        } finally { orchestrator.close(); }
      } catch (error) {
        console.error(`overload web: context ingest failed: ${(error as Error).message}`);
      } finally { control?.close(); }
    };
    ingest();
    ingestTimer = setInterval(ingest, options.publishIntervalMs ?? 1_000);
    ingestTimer.unref?.();
  }
  const timer = setInterval(publish, options.publishIntervalMs ?? 1_000);
  timer.unref?.();
  const server = bindOrRelease(() => Bun.serve({
    // Loopback is the v1 trust boundary. Add authentication before supporting
    // shared machines or any non-loopback bind address.
    hostname: "127.0.0.1",
    port,
    async fetch(request, server) {
      let url: URL;
      try {
        url = new URL(request.url);
        if (request.method === "GET" && (url.pathname === "/" || dashboardRoute(url.pathname))) return new Response(Bun.file(join(staticRoot, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } });
        if (request.method === "GET" && url.pathname.startsWith("/static/")) {
          const name = decodeURIComponent(url.pathname.slice(8));
          if (name.includes("..") || name.includes("/") || name.includes("\\")) return new Response("invalid path", {status:400});
          const file = Bun.file(join(staticRoot, name));
          if (!await file.exists()) return new Response("not found", {status:404});
          return new Response(file, {headers:{"content-type":name.endsWith(".js")?"text/javascript; charset=utf-8":name.endsWith(".css")?"text/css; charset=utf-8":"application/octet-stream"}});
        }
        const originError = checkOrigin(request, port === 0 ? server.port : port);
        if (originError) return originError;
        const management = await mgmtRoute(request, url, { controlPath, ledgerPath, overloadHome: join(homedir(), ".overload"), actor });
        if (management) return management;
        const context = await contextRoute(request, url, { controlPath, orchestratorPath, actor });
        if (context) return context;
        const manager = await managerRoute(request, url, { ...options.manager, controlPath, ledgerPath, configPath: options.manager?.configPath ?? options.policyPath });
        if (manager) return manager;
        const handoff = await handoffRoute(request, url, controlPath);
        if (handoff) return handoff;
        if (request.method === "GET" && url.pathname === "/api/summary") return json(withReadonlyDb(ledgerPath, (db) => {
          const health = queryHealth(db);
          const control = openControl(controlPath);
          try {
            const q2Count = (db.query("SELECT count(*) n FROM current WHERE queue='q2'").get() as { n: number }).n;
            return { q1: queryQ1(db).length, q2: q2Count, hung: queryHung(db).length, open_incidents: health.open_incidents.length, coverage_gaps: health.coverage_gaps, telemetry_gaps: health.telemetry_gaps };
          }
          finally { control.close(); }
        }));
        if (request.method === "GET" && /^\/api\/attention\/(now|inbox|done)$/.test(url.pathname)) {
          const control = openControl(controlPath);
          try {
            if (url.pathname.endsWith("/done")) {
              const now = Date.now();
              const page = listAttentionPage(control, "done", {
                limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 50,
                cursor: url.searchParams.get("cursor") ?? undefined,
              }, now);
              const automatic = control.query(`SELECT COUNT(*) n FROM control_attention
                WHERE state='resolved' AND decision_mode='scoped_auto' AND updated_at>=?`).get(now - 86400000) as { n: number };
              return json({ ...page, automatic_today: automatic.n });
            }
            return json(listAttention(control, url.pathname.slice("/api/attention/".length) as "now" | "inbox"));
          } catch (error) { return controlError(error); } finally { control.close(); }
        }
        if (request.method === "GET" && url.pathname === "/api/control/attention" && url.searchParams.get("zone") === "follow_up") {
          const control = openControl(controlPath); try { return json({ items: listAttentionFollowUps(control, Date.now()) }); } finally { control.close(); }
        }
        if (url.pathname === "/api/waits" || url.pathname.startsWith("/api/waits/")) {
          return await waitRoute(request, url, { controlPath, ledgerPath, actor, adapters: waitAdapters, processAlive: options.processAlive, checkpointProbe: options.checkpointProbe, conditionWaits });
        }
        if (request.method === "GET" && url.pathname === "/api/capabilities") return json({ notifications: notificationCapability(), web: { available: true, bind: "127.0.0.1", port: server.port } });
        const conversationsResponse = await conversationRoute(request, url, { controlPath });
        if (conversationsResponse) return conversationsResponse;
        const conversationMessage=url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if(request.method==='POST'&&conversationMessage){const db=openControl(controlPath);try{ensureAdapterSchema(db);const input=await bodyObject(request);if(typeof input.text!=='string'||!input.text.trim()||input.text.length>100000)return json({error:'invalid message'},{status:400});const id=routeParameter(conversationMessage[1]);const c=db.query('SELECT * FROM conversations WHERE id=?').get(id) as Conversation|null;if(!c)return json({error:'not_found'},{status:404});const turnId=randomUUID();db.transaction(()=>{const row=db.query('SELECT COALESCE(MAX(sequence),0)+1 n FROM conversation_turns WHERE conversation_id=?').get(id) as {n:number};db.run('INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,created_at) VALUES(?,?,?,?,?,?)',[turnId,id,row.n,input.text as string,'queued',Date.now()]);}).immediate();return json({turn_id:turnId},{status:201});}finally{db.close();}}
        if (request.method === "GET" && url.pathname === "/api/ledger") {
          const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : Date.now();
          const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : until - 7*86400000;
          if (!Number.isFinite(since)||!Number.isFinite(until)||since<0||since>until) return json({error:"invalid time window"},{status:400});
          const db=openAnswersDb(controlPath);try{return json(ledgerReport(db,{since,until}));}finally{db.close();}
        }
        if (url.pathname === "/api/external-observations") {
          if (request.method === "GET") {
            const state = url.searchParams.get("state") ?? undefined;
            if (state !== undefined && !["unmatched", "attention_open", "historical", "recovered"].includes(state)) return json({ error: "invalid", message: "invalid state" }, { status: 400 });
            const workId = url.searchParams.get("work_id") ?? undefined;
            const limitText = url.searchParams.get("limit");
            const limit = limitText === null ? undefined : Number(limitText);
            const db = openAnswersDb(controlPath);
            try { return json({ observations: listExternalObservations(db, { ...(workId ? { work_id: workId } : {}), ...(state ? { state: state as "unmatched" | "attention_open" | "historical" | "recovered" } : {}), ...(limit === undefined ? {} : { limit }) }) }); }
            catch (error) { return controlError(error); }
            finally { db.close(); }
          }
          if (request.method === "POST") {
            if (!request.headers.get("sec-fetch-site") && !request.headers.get("sec-fetch-mode")) return json({ error: "forbidden" }, { status: 403 });
            let body: unknown;
            try { body = await request.json(); validateExternalObservationInput(body); }
            catch (error) { return json({ error: "invalid", message: error instanceof Error ? error.message : "invalid external observation" }, { status: 400 }); }
            const db = openAnswersDb(controlPath);
            try { return json(ingestExternalObservation(db, body, Date.now())); }
            catch (error) { return controlError(error); }
            finally { db.close(); }
          }
          return json({ error: "not_found" }, { status: 404 });
        }
        const semanticRoute = url.pathname.match(/^\/api\/attention\/([^/]+)\/semantic-assessments(?:\/(claim|settle))?$/);
        if (semanticRoute) {
          const itemId = routeParameter(semanticRoute[1]);
          const action = semanticRoute[2] ?? null;
          if (request.method === "GET" && action === null) {
            const db = openAnswersDb(controlPath);
            try { return json({ assessments: listSemanticAssessments(db, itemId) }); }
            finally { db.close(); }
          }
          if (request.method !== "POST") return json({ error: "not_found" }, { status: 404 });
          if (!request.headers.get("sec-fetch-site") && !request.headers.get("sec-fetch-mode")) return json({ error: "forbidden" }, { status: 403 });
          const body = await bodyObject(request);
          const db = openAnswersDb(controlPath);
          try {
            if (action === null) {
              if (typeof body.model !== "string") return json({ error: "invalid", message: "model is required" }, { status: 400 });
              return json({ assessment: scheduleSemanticAssessment(db, itemId, body.model, Date.now()) });
            }
            if (action === "claim") {
              if (typeof body.model !== "string") return json({ error: "invalid", message: "model is required" }, { status: 400 });
              return json({ claims: claimSemanticAssessments(db, { model: body.model, ...(typeof body.limit === "number" ? { limit: body.limit } : {}), ...(typeof body.lease_ms === "number" ? { lease_ms: body.lease_ms } : {}) }, Date.now()) });
            }
            if (typeof body.assessment_id !== "string" || typeof body.lease_token !== "string") return json({ error: "invalid", message: "assessment_id and lease_token are required" }, { status: 400 });
            return json({ assessment: settleSemanticAssessment(db, {
              assessment_id: body.assessment_id, lease_token: body.lease_token,
              ...(body.result && typeof body.result === "object" ? { result: body.result as { verdict: "ordinary" | "needs_attention" | "uncertain"; rationale: string; confidence: number } } : {}),
              ...(typeof body.unavailable === "string" ? { unavailable: body.unavailable } : {}),
            }, Date.now()) });
          } catch (error) { return controlError(error); }
          finally { db.close(); }
        }
        if (request.method === "GET" && url.pathname === "/api/rules") {
          const db=openAnswersDb(controlPath);try{return json(rulesReport(db,loadPolicy(options.policyPath,db),Date.now()));}finally{db.close();}
        }
        if (request.method === "POST" && /^\/api\/rules\/[^/]+\/(approve|enable|disable)$/.test(url.pathname)) {
          const parts=url.pathname.split("/"),id=routeParameter(parts[3]);const db=openAnswersDb(controlPath);
          try {
            const input=await bodyObject(request);
            if(parts[4]==="approve"){const approved=approvePolicyCandidate(db,id,"operator",Date.now()+86400000);return approved?json(getPolicyCandidate(db,id)):json({error:"candidate cannot be approved"},{status:409});}
            const policy=loadPolicy(options.policyPath,db);
            const result=parts[4]==="disable"?disablePolicyRule(db,policy,id,"operator",typeof input.reason==="string"?input.reason:undefined):enablePolicyRule(db,policy,id,"operator");
            return result.ok?json(result):json({error:result.reason},{status:409});
          }finally{db.close();}
        }
        const proposalRoute=url.pathname.match(/^\/api\/attention\/([^/]+)\/propose-rule$/);
        if(request.method==="POST"&&proposalRoute){const db=openAnswersDb(controlPath);try{const input=await bodyObject(request);if(typeof input.answer!=="string")return json({error:"answer is required"},{status:400});const result=proposeRuleFromAttention(db,routeParameter(proposalRoute[1]),input.answer,"operator");return result.ok?json(result.candidate,{status:201}):json({error:result.reason},{status:409});}finally{db.close();}}
        if (request.method === "POST" && /^\/api\/decision-bot\/(disable|enable)$/.test(url.pathname)) {
          const db=openAnswersDb(controlPath);const disabled=url.pathname.endsWith("/disable");try{const body=await bodyObject(request);setBotDisabled(db,disabled,String(body.reason??(disabled?"disabled by operator":"enabled by operator")));return json({disabled});}finally{db.close();}
        }
        if (request.method === "GET" && url.pathname === "/api/works") {
          const control = openControl(controlPath); try { return json(listWorks(control)); } finally { control.close(); }
        }
        if (request.method === "GET" && url.pathname === "/api/candidates") {
          const control = openControl(controlPath); try { return json((control.query("SELECT candidate_id FROM policy_candidates ORDER BY created_at DESC").all() as Array<{candidate_id:string}>).map((row) => getPolicyCandidate(control, row.candidate_id))); } finally { control.close(); }
        }
        const candidateRoute = url.pathname.match(/^\/api\/candidates\/([^/]+)\/(approve|enable)$/);
        if (request.method === "POST" && candidateRoute) {
          const input = await bodyObject(request); const control = openControl(controlPath);
          try { const id = routeParameter(candidateRoute[1]!); if (candidateRoute[2] === "approve") { const observationUntil = Number(input.observation_until); if (!approvePolicyCandidate(control, id, String(input.actor ?? ""), observationUntil)) throw new ControlError("conflict", "candidate cannot be approved"); return json(getPolicyCandidate(control, id)); } const rule = enablePolicyCandidate(control, id); if (!rule) throw new ControlError("blocked", "candidate observation incomplete or already enabled"); return json({ candidate: getPolicyCandidate(control, id), rule }); }
          catch (error) { return controlError(error); } finally { control.close(); }
        }
        if (request.method === "POST" && url.pathname === "/api/works") {
          const input = await bodyObject(request); const control = openControl(controlPath);
          try { return json(createWork(control, input as Parameters<typeof createWork>[1]), { status: 201 }); } catch (error) { return controlError(error); } finally { control.close(); }
        }
        const promoteRoute = url.pathname.match(/^\/api\/works\/([^/]+)\/promote$/);
        if (request.method === "POST" && promoteRoute) {
          const db=openControl(controlPath);try{const body=await bodyObject(request);return json(promoteWork(db,routeParameter(promoteRoute[1]),Number(body.expected_revision),body.contract as Contract,String(body.reason??"")));}catch(error){return controlError(error);}finally{db.close();}
        }
        const previewRoute=url.pathname.match(/^\/api\/works\/([^/]+)\/contract-preview$/);
        if(request.method==="POST"&&previewRoute){const db=openControl(controlPath);try{const input=await bodyObject(request);return json(previewContractRevision(db,routeParameter(previewRoute[1]),expectedRevision(input.expected_revision),input.contract as Contract));}catch(error){return controlError(error);}finally{db.close();}}
        const workRoute = url.pathname.match(/^\/api\/works\/([^/]+)(?:\/(contract|redirect|stop))?$/);
        if (workRoute) {
          const workId = routeParameter(workRoute[1]!); const operation = workRoute[2]; const control = openControl(controlPath);
          try {
            if (request.method === "GET" && !operation) { const work = getWork(control, workId); return work ? json(work) : json({ error: "not_found" }, { status: 404 }); }
            const input = await bodyObject(request); const revision = expectedRevision(input.expected_revision);
            if (request.method === "POST" && operation === "contract") return json(reviseContract(control, workId, revision, input.contract as Contract, String(input.reason ?? "")));
            if (request.method === "POST" && operation === "redirect") return json(redirectWork(control, workId, revision, { reason: String(input.reason ?? ""), affected_work_ids: input.affected_work_ids as string[], action: input.action as "activate" | "pause" | "stop", evidence: input.evidence as
                    | Record<string, unknown> | undefined }));
            if (request.method === "POST" && operation === "stop") return json(recordStopCondition(control, workId, String(input.condition_id ?? ""), (input.evidence ?? {}) as Record<string, unknown>, Date.now(), revision));
          } catch (error) { return controlError(error); } finally { control.close(); }
        }
        const attentionRoute = url.pathname.match(/^\/api\/attention\/([^/]+)\/(ack|defer|resolve|feedback)$/);
        if (request.method === "POST" && attentionRoute) {
          const itemId = routeParameter(attentionRoute[1]!);
          const action = attentionRoute[2]!;
          // Resolve consumes a human decision. Reject servers without a trusted
          // actor before parsing the decision body or loading its material identity.
          if (action === "resolve" && (!actor || !actor.trim())) {
            return json({ error: "not_implemented", message: "decision action requires server-side actor identity" }, { status: 501 });
          }
          const control = openControl(controlPath);
          let revision: number | null = null;
          try {
            const input = await bodyObject(request);
            const suppliedRevision = input.attention_revision ?? input.expected_revision;
            if (typeof suppliedRevision !== "number") return json({ error: "invalid", message: "attention_revision required" }, { status: 400 });
            revision = expectedRevision(suppliedRevision);
            if (action === "resolve" && input.selected_option === "narrow" && (!Number.isSafeInteger(input.expected_contract_revision) || !Array.isArray(input.affected_cards))) {
              throw new ControlError("invalid", "Review the contract and affected cards before applying narrow.");
            }
            if (action === "feedback") {
              recordAttentionFeedback(control, itemId, revision, input.useful === true, typeof input.reason === "string" ? input.reason : undefined);
              return json(getAttention(control, itemId));
            }
            const current = getAttention(control, itemId);
            if (action === "resolve" && current) {
              if (current.owner !== actor!.trim()) throw new ControlError("blocked", "permission_denied: actor is not the decision owner");
            }
            const suppliedFingerprint = typeof input.material_fingerprint === "string" ? input.material_fingerprint : "";
            const material = action === "resolve" && current ? getAttentionMaterial(control, itemId) : null;
            if (action === "resolve" && current && (!material || current.revision !== revision || material.fingerprint !== suppliedFingerprint)) {
              return json(staleAttentionBody(current, revision), { status: 409 });
            }
            if (action === "resolve" && current) {
              if (current.state !== "open" || current.effect_state !== "not_started") throw new ControlError("blocked", "attention decision is not open");
              if (current.expires_at !== null && current.expires_at <= Date.now()) throw new ControlError("blocked", "attention decision has expired");
            }
            if (itemId.startsWith("mgmt:accept:") && action === "resolve") {
              if (current && current.revision !== revision) return json(staleAttentionBody(current, revision), { status: 409 });
              if (input.selected_option === "defer") return json(current);
              if (input.selected_option !== "accept" && input.selected_option !== "reject") {
                throw new ControlError("invalid", "invalid acceptance decision");
              }
              const manifestId = itemId.slice(itemId.lastIndexOf(":") + 1);
              return json(recordAcceptance(
                control,
                manifestId,
                input.selected_option === "accept" ? "accepted" : "rejected",
                actor!.trim(),
                typeof input.reason === "string" ? { reason: input.reason } : {},
                { attention_revision: revision, material_fingerprint: suppliedFingerprint },
                Date.now(),
              ));
            }
            if (action === "resolve") {
              if (!actor || !actor.trim()) return json({ error: "not_implemented", message: "decision action requires server-side actor identity" }, { status: 501 });
              if (current?.evidence.kind === "coordinator_delivery") {
                const tasks = openStore(orchestratorPath);
                try {
                  const coordinator = new Coordinator(tasks, control);
                  if (input.selected_option === "accept")
                    return json(coordinator.acceptDelivery(current.work_id, itemId, revision!, actor!.trim()).attention);
                  if (input.selected_option === "reject")
                    return json(coordinator.rejectDelivery(current.work_id, itemId, revision!, actor!.trim()));
                  throw new ControlError("invalid", "invalid coordinator decision");
                } finally {
                  tasks.close();
                }
              }
              const decision: AttentionDecisionInput = {
                attention_revision: revision,
                material_fingerprint: suppliedFingerprint,
                selected_option: typeof input.selected_option === "string" ? input.selected_option : "",
                reason: typeof input.reason === "string" ? input.reason : undefined,
                replacement_contract: input.replacement_contract as Contract | undefined,
                expected_contract_revision: input.expected_contract_revision as number | undefined,
                affected_cards: input.affected_cards as Array<{ item_id: string; revision: number }> | undefined,
              };
              return json(resolveAttention(control, itemId, decision, actor!));
            }
            return json(actOnAttention(control, itemId, revision, action as "ack" | "defer", {
              defer_until: typeof input.defer_until === "number" ? input.defer_until : undefined,
              reason: typeof input.reason === "string" ? input.reason : undefined,
            }, actor));
          } catch (error) {
            if (error instanceof ControlError && error.code === "conflict") {
              if (error.details) return json(error.details, { status: 409 });
              const current = revision === null ? null : getAttention(control, itemId);
              if (current && revision !== null) return json(staleAttentionBody(current, revision), { status: 409 });
            }
            return controlError(error);
          } finally { control.close(); }
        }
        // List endpoints probe every row's checkpoint, so each request shares one listing of the session roots.
        if (request.method === "GET" && url.pathname === "/api/sessions") return json(withReadonlyLeases(controlPath, (leases) => withReadonlyDb(ledgerPath, (db) => { const probe = listingSnapshotProbe(); return querySessions(db, SESSION_LIST_LIMIT).map((session) => ({ ...session, resume_capability: inspectResume(db, session.stable_id, options.processAlive, probe, leases) })); })));
        if (request.method === "GET" && url.pathname === "/api/q1") return json(withReadonlyDb(ledgerPath, queryQ1).map(({ platform: _platform, ...row }) => row));
        if (request.method === "GET" && url.pathname === "/api/archive") return json(withReadonlyDb(ledgerPath, queryArchive));
        if (request.method === "GET" && url.pathname === "/api/zombie") return json(withReadonlyLeases(controlPath, (leases) => withReadonlyDb(ledgerPath, (db) => {
          const view = queryZombie(db), probe = listingSnapshotProbe();
          return { ...view, groups: view.groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, resume_capability: inspectResume(db, row.stable_id, options.processAlive, probe, leases) })) })) };
        })));
        if (request.method === "GET" && url.pathname === "/api/hung") return json(withReadonlyLeases(controlPath, (leases) => withReadonlyDb(ledgerPath, (db) => { const probe = listingSnapshotProbe(); return queryHung(db).map((row) => ({ ...row, resume_capability: inspectResume(db, row.stable_id, options.processAlive, probe, leases) })); })));
        if (request.method === "GET" && url.pathname === "/api/health") return json(withReadonlyDb(ledgerPath, queryHealth));
        if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
          const stableId = routeParameter(url.pathname.slice("/api/sessions/".length));
          const result = withReadonlyDb(ledgerPath, (db) => querySession(db, stableId));
          return result ? json(result) : json({ error: "session not found" }, { status: 404 });
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/jump/")) {
          const requestUid = routeParameter(url.pathname.slice("/api/jump/".length));
          const target = withReadonlyDb(ledgerPath, (db) => {
            const stableId = requestSession(db, requestUid);
            return stableId ? queryJumpTarget(db, stableId) : null;
          });
          return target ? json(await (options.jump ?? performJump)(target)) : json({ error: "request not found" }, { status: 404 });
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/jump-session/")) {
          const stableId = routeParameter(url.pathname.slice("/api/jump-session/".length));
          const target = withReadonlyDb(ledgerPath, (db) => queryJumpTarget(db, stableId));
          return target ? json(await (options.jump ?? performJump)(target)) : json({ error: "session not found" }, { status: 404 });
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/resume-session/")) {
          const stableId = routeParameter(url.pathname.slice("/api/resume-session/".length));
          const db = new Database(ledgerPath, { readonly: true });
          let control: Database | null = null;
          try {
            control = openControl(controlPath);
            const result = await resumeSession(db, stableId, { db: control, now: Date.now }, options.resume, options.processAlive);
            return result ? json(result, { status: result.resumed ? 200 : 409 }) : json({ error: "session not found" }, { status: 404 });
          } finally { control?.close(); db.close(); }
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/closeout/")) {
          const stableId = routeParameter(url.pathname.slice("/api/closeout/".length));
          const db = new Database(ledgerPath);
          db.exec("PRAGMA busy_timeout=5000");
          try {
            const current = db.query("SELECT queue FROM current WHERE stable_id=?").get(stableId) as { queue: string | null } | null;
            if (!current) return json({ error: "session not found" }, { status: 404 });
            if (current.queue !== "q2") return json({ error: "session is not eligible for closeout" }, { status: 409 });
            db.run("INSERT OR IGNORE INTO closeouts(stable_id, closed_at) VALUES (?, ?)", [stableId, Date.now()]);
            return json({ closed: true });
          } finally { db.close(); }
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/ack/")) {
          const requestUid = routeParameter(url.pathname.slice("/api/ack/".length));
          const db = new Database(ledgerPath);
          db.exec("PRAGMA busy_timeout=5000");
          try { return json({ acked: ackRequest(db, requestUid).changes === 1 }); } finally { db.close(); }
        }
        if (request.method === "POST" && url.pathname === "/api/decision/target") {
          if (!request.headers.get("sec-fetch-site") && !request.headers.get("sec-fetch-mode")) return json({error:"forbidden"},{status:403});let body:any;try{body=await request.json();}catch{return json({error:"invalid JSON"},{status:400});}if(body?.consumerOwner!=="extension"||typeof body.approvalId!=="string"||!Array.isArray(body.options))return json({error:"invalid target"},{status:400});const mailbox=openAnswersDb(controlPath);try{const effect=String(body.effect??"gated_tool"),binding=trustedTargetBinding(mailbox,body.approvalId,effect),
              evidence =
                body.evidence &&
                typeof body.evidence === "object" &&
                !Array.isArray(body.evidence)
                  ? body.evidence
                  : {};
            const sessionId =
                typeof evidence.session_id === "string"
                  ? evidence.session_id
                  : "",
              toolCallId =
                typeof body.toolCallId === "string" ? body.toolCallId : "",
              // Only a channel runtime stamps session_id; a bare toolCallId (e.g. a terminal ask) claims no channel turn.
              channelClaim = !!sessionId;
            const turn =
              sessionId && toolCallId
                ? (mailbox
                    .query(
                      "SELECT t.id FROM conversations c JOIN conversation_turns t ON t.conversation_id=c.id WHERE json_extract(c.session_reference,'$.sessionId')=? AND t.state IN ('submitting','running') ORDER BY t.sequence DESC LIMIT 1",
                    )
                    .get(sessionId) as { id: string } | null)
                : null;
            if (channelClaim && !turn)
              return json({ error: "active_turn_required" }, { status: 409 });
            mailbox.exec(
              "CREATE TABLE IF NOT EXISTS approval_channel_bindings(consumer_owner TEXT NOT NULL,approval_id TEXT NOT NULL,target_version TEXT NOT NULL,session_id TEXT NOT NULL,turn_id TEXT NOT NULL,tool_call_id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,PRIMARY KEY(consumer_owner,approval_id,target_version))",
            );const normalized={consumerOwner:"extension" as const,approvalId:body.approvalId,stableId:typeof body.stableId==="string"?body.stableId:undefined,requestUid:typeof body.requestUid==="string"?body.requestUid:undefined,question:String(body.question??""),options:body.options,effect,scope:body.scope??{},evidence: { ...evidence, ...(turn ?{ turn_id: turn.id } : {}) },expiresAt:Number(body.expiresAt),workId:binding.workId,contractRevision:binding.contractRevision,decisionMode:"human_only" as "human_only"|"scoped_auto",
              toolCallId:
                typeof body.toolCallId === "string"
                  ? body.toolCallId
                  : undefined,
              attemptId:
                typeof body.attemptId === "string" ? body.attemptId : undefined,
            };const policy=loadPolicy(options.policyPath,mailbox);/* Structured asks stay human decisions: no policy rule may let the bot answer them. */if(!binding.humanOnly&&effect!=="ask_answer"&&normalized.scope?.gate!=="ask"&&matchingRule(policy,normalized as any))normalized.decisionMode="scoped_auto";
            const target = mailbox
              .transaction(() => {
                const registered = registerTarget(mailbox,normalized);
                if (turn)
                  mailbox.run(
                    "INSERT OR IGNORE INTO approval_channel_bindings VALUES('extension',?,?,?,?,?,'active',?)",
                    [
                      registered.approvalId,
                      registered.targetVersion,
                      sessionId,
                      turn.id,
                      toolCallId,
                      Date.now(),
                    ],
                  );
                return registered;
              })
              .immediate();
            return json(target);}finally{mailbox.close();}
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/orchestrator/answer/")) {
          try{await request.clone().json();}catch{return json({error:'invalid JSON'},{status:400});}
          if (!request.headers.get('sec-fetch-site') && !request.headers.get('sec-fetch-mode')) return json({error:'forbidden'},{status:403});const body=await bodyObject(request);const approvalId=routeParameter(url.pathname.slice('/api/orchestrator/answer/'.length));if(!approvalId||typeof body.answer!=='string')return json({error:'missing answer'},{status:400});const mailbox=openAnswersDb(controlPath);try{const owner=body.consumer_owner==='extension'?'extension':'orchestrator';if(approvalId.startsWith('runtime:')){const item=getAttention(mailbox,approvalId);if(!item||item.revision!==body.expected_revision||item.state!=='open')return json({error:'stale_decision'},{status:409});}const result=writeHumanAnswer(mailbox,owner,approvalId,body.answer,'ui');return result.ok?json({ok:true}):json({error:result.reason},{status:result.reason==='already_consumed'?409:400});}finally{mailbox.close();}
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/decision/cancel/")) {
          if (!request.headers.get("sec-fetch-site") && !request.headers.get("sec-fetch-mode")) return json({ error: "forbidden" }, { status: 403 });
          let body: unknown;
          try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, { status: 400 }); }
          if (!body || typeof body !== "object" || !("consumer_owner" in body) || body.consumer_owner !== "extension" || !("target_version" in body) || typeof body.target_version !== "string") return json({ error: "invalid cancellation" }, { status: 400 });
          const mailbox = openAnswersDb(controlPath);
          try {
            const closed = cancelTarget(mailbox, "extension", routeParameter(url.pathname.slice("/api/decision/cancel/".length)), body.target_version);
            return json({ closed }, { status: closed ? 200 : 409 });
          } finally { mailbox.close(); }
        }
        if(request.method==="POST"&&url.pathname.startsWith("/api/decision/consume/")){if(!request.headers.get("sec-fetch-site")&&!request.headers.get("sec-fetch-mode"))return json({error:"forbidden"},{status:403});let body:any;try{body=await request.json();}catch{return json({error:"invalid JSON"},{status:400});}const id=routeParameter(url.pathname.slice("/api/decision/consume/".length));if(!id||body?.consumer_owner!=="extension"||typeof body.target_version!=="string")return json({error:"invalid consume"},{status:400});const mailbox=openAnswersDb(controlPath);try{const policy=loadPolicy(options.policyPath,mailbox);const r=consumeDecisionResult(mailbox,{consumerOwner:"extension",approvalId:id,targetVersion:body.target_version,policyHash:policy.hash,liveValid:()=>true,policyValid:(t,p)=>!!p&&policyAuthorizes(policy,t,p.answer,p.policyHash)});if(r.ok)return json(r.receipt);
          // A lost race is a conflict carrying current state (§4.5), not "the answer is not written yet".
          if(isConsumeConflict(r.reason))return json(consumeConflictBody(mailbox,"extension",id,body.target_version,r.reason),{status:409});
          return json({error:"not ready",reason:r.reason},{status:404});}finally{mailbox.close();}}
        if(request.method=== "POST" &&
          url.pathname === "/api/decision/effect"
        ) {
          let body: Record<string, unknown>;
          try {
            body = await bodyObject(request);
          } catch {
            return json({ error: "invalid JSON" }, { status: 400 });
          }
          if (
            typeof body.receipt_id !== "string" ||
            typeof body.toolCallId !== "string" ||
            (body.effect_state !== "succeeded" && body.effect_state !== "failed" && body.effect_state !== "unknown") ||
            (body.evidence !== undefined && (!body.evidence || typeof body.evidence !== "object" || Array.isArray(body.evidence)))
          )
            return json({ error: "invalid effect" }, { status: 400 });
          const mailbox = openAnswersDb(controlPath);
          try {
            const observation = {
              receiptId: body.receipt_id,
              toolCallId: body.toolCallId,
              attemptId:
                typeof body.attempt_id === "string"
                  ? body.attempt_id
                  : undefined,
              state: body.effect_state,
              evidence: (body.evidence ?? {}) as Record<string, unknown>,
              observedAt: Date.now(),
            };
            return json({ observed: observeAndProjectReceiptEffect(mailbox, observation) });
          } catch (error) {
            if (error instanceof Error && error.message === "conflicting_effect_observation") return json({ error: "conflicting_effect_observation" }, { status: 409 });
            throw error;
          } finally {
            mailbox.close();
          }
        }
        if (
          request.method === "GET"&&url.pathname==="/api/decision-bot/status"){const mailbox=openAnswersDb(controlPath);try{return json(new DecisionBotService(mailbox).status());}finally{mailbox.close();}}
        /* Legacy GET/DELETE answer consumption was removed: registered targets use POST consume receipts. */
        if (false && request.method === "GET" && url.pathname.startsWith("/api/orchestrator/answer/")) {
          const approvalId = routeParameter(url.pathname.slice("/api/orchestrator/answer/".length));
          const answersPath = controlPath ?? defaultAnswersPath;
          const db = openAnswersDb(answersPath);
          try {
            const row = db.query("SELECT answer, actor, at FROM answers WHERE approval_id=?").get(approvalId) as { answer: string; actor: string; at: number } | null;
            return row ? json(row) : json({ error: "not found" }, { status: 404 });
          } finally { db.close(); }
        }
        if (false && request.method === "DELETE" && url.pathname.startsWith("/api/orchestrator/answer/")) {
          const approvalId = routeParameter(url.pathname.slice("/api/orchestrator/answer/".length));
          const answersPath = controlPath ?? defaultAnswersPath;
          const db = openAnswersDb(answersPath);
          try { db.run("DELETE FROM answers WHERE approval_id=?", [approvalId]); } finally { db.close(); }
          return json({ ok: true });
        }
        return json({ error: "not found" }, { status: 404 });
      } catch (error) {
        console.error(`overload web: ${request.method} ${url.pathname}: ${(error as Error).message}`);
        return json({ error: "internal server error" }, { status: 500 });
      }
    },
  }), () => { clearInterval(timer); if (ingestTimer) clearInterval(ingestTimer); });
  const originalStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => { clearInterval(timer); if (ingestTimer) clearInterval(ingestTimer); return originalStop(closeActiveConnections); }) as typeof server.stop;
  return server;
}

function dashboardRoute(path: string): boolean {
  return /^\/(conversations|manager|decide|ledger|works|tasks|candidates|rules|agents|now|inbox|done|sessions|health|q1|archive|hung|zombie)(?:\/.*)?$/.test(path);
}

if (import.meta.main) {
  const config = await loadWebConfig();
  const server = startWebServer({ port: config.web_port });
  console.log(`overload web listening on http://${server.hostname}:${server.port}`);
}
