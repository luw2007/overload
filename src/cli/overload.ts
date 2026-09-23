#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { ackRequest, queryHealth, queryHung, queryJumpTarget, queryQ1, querySession, querySessions, queryZombie, requestSession } from "../shared/queries";
import { performJump, type JumpResult } from "../shared/jump";
import { runDoctor, defaultDoctorDeps } from "./doctor";
import { audit, parseSince, printAudit } from "./audit";
import { runCli as runOrchestratorCli } from "../orchestrator/cli";
import { runMgmtCli } from "./mgmt";
import { openMailbox, setBotDisabled, writeHumanAnswer } from "../decision-bot/mailbox";
import { DecisionBotService } from "../decision-bot/service";
import { approvePolicyCandidate, enablePolicyCandidate, getPolicyCandidate } from "../decision-bot/policy";
import { actOnAttention, createWork, getAttention, getWork, listAttention, listWorks, openControl, recordAttentionFeedback, recordStopCondition, redirectWork, reviseContract } from "../control/store";
import type { Contract } from "../control/types";
import { getContextPackage } from "../control/context-assembler";
import { purgeObjectContent } from "../control/context-pin";
import { fetchOnDemand } from "../control/on-demand-fetcher";
import { publishControlEvents } from "../control/outbox";
import { openStore } from "../orchestrator/store";
import { SpoolWriter } from "../orchestrator/spool";

const path = process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
type Output = (line: string) => void;

/** Row streams belong on stdout so a selection can be piped straight back into `ack`;
 *  headings and empty-state notes are chrome and belong on stderr. */
const note: Output = (line) => console.error(line);

function time(value: number | null): string { return value == null ? "-" : new Date(value).toISOString(); }
function detail(value: Record<string, unknown> | null): string { if (!value || !Object.keys(value).length) return ""; return ` ${JSON.stringify(value)}`; }
function usage(): never { console.error("usage: overload now|inbox|done | attention <id> [ack|defer|resolve|feedback <json>] | works | candidates | candidate <id> approve|enable <json> | work <id> | work create|revise|redirect|stop <json> | mgmt scan|works|show|track | context purge --actor <id> | sessions (recent 30d, OVERLOAD_SESSION_WINDOW_DAYS to change) | show <stable_id> | doctor | audit [--sample N] [--since 7d|24h|<ms>] | ack <request_uid>... | jump <stable_id|request_uid> | decision-bot takeover <owner> <id> <answer> | orch ...\n       diagnostics: q1 | q4 | hung | zombie | health"); process.exit(2); }

function jsonArg(value: string | undefined): Record<string, unknown> {
  if (!value) usage();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error("argument must be valid JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("argument must be a JSON object");
  return parsed as Record<string, unknown>;
}

function publishControl(control: Database): void {
  const orchestrator = openStore();
  const spool = new SpoolWriter(orchestrator, process.env.OVERLOAD_ROOT ?? join(homedir(), ".overload"));
  try { publishControlEvents(control, path, (event) => spool.emit(`control:${String(event.event_id)}`, "control_event", event)); }
  finally { spool.close(); orchestrator.close(); }
}

function controlCommand(args: string[]): boolean {
  const command = args[0];
  if (command === "now" || command === "inbox" || command === "done") {
    const control = openControl(); try { const rows = listAttention(control, command); if (!rows.length) note(`No ${command} items.`); for (const item of rows) console.log(`${item.item_id}\t${item.revision}\t${item.work_id}\t${item.effect_state}\t${item.owner}\t${item.expires_at ? time(item.expires_at) : "-"}\t${item.conclusion}`); } finally { control.close(); } return true;
  }
  if (command === "works") {
    const control = openControl(); try { for (const work of listWorks(control)) console.log(JSON.stringify(work)); } finally { control.close(); } return true;
  }
  if (command === "candidates") {
    const control = openControl(); try { for (const row of control.query("SELECT candidate_id FROM policy_candidates ORDER BY created_at DESC").all() as Array<{candidate_id:string}>) console.log(JSON.stringify(getPolicyCandidate(control, row.candidate_id))); } finally { control.close(); } return true;
  }
  if (command === "candidate") {
    const id = args[1], action = args[2]; if (!id || !action) usage(); const input = jsonArg(args[3] ?? "{}"); const control = openControl();
    try { if (action === "approve") { if (!approvePolicyCandidate(control, id, String(input.actor ?? ""), Number(input.observation_until))) throw new Error("candidate cannot be approved"); } else if (action === "enable") { if (!enablePolicyCandidate(control, id)) throw new Error("candidate observation incomplete or already enabled"); } else usage(); console.log(JSON.stringify(getPolicyCandidate(control, id))); return true; } finally { control.close(); }
  }
  if (command === "attention") {
    const verbose = args.includes("--verbose");
    const clean = args.filter((x) => x !== "--verbose");
    const actorIdx = clean.indexOf("--actor");
    const actorFlag = actorIdx >= 0 ? clean[actorIdx + 1] : undefined;
    if (actorIdx >= 0 && (!actorFlag || actorFlag.startsWith("--"))) usage();
    const drop = actorIdx >= 0 ? new Set([actorIdx, actorIdx + 1]) : new Set<number>();
    const a = clean.filter((_, i) => !drop.has(i));
    const itemId = a[1]; if (!itemId) usage(); const action = a[2]; const input = jsonArg(a[3] ?? "{}"); const control = openControl();
    try {
      if (!action) { if (verbose) { console.log(renderDecisionCard(control, itemId)); return true; } const item = getAttention(control, itemId); if (!item) throw new Error(`attention not found: ${itemId}`); console.log(JSON.stringify(item)); return true; }
      const revision = Number(input.expected_revision); if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("expected_revision must be a positive integer");
      if (action === "feedback") { recordAttentionFeedback(control, itemId, revision, input.useful === true, typeof input.reason === "string" ? input.reason : undefined); publishControl(control); console.log(JSON.stringify(getAttention(control, itemId))); return true; }
      if (action !== "ack" && action !== "defer" && action !== "resolve") usage();
      // Context decisions must carry a real identity: --actor takes precedence over
      // OVERLOAD_ACTOR, and neither may fall back to a hardcoded pseudo-user. Legacy
      // ack/defer and non-context resolves tolerate an absent actor.
      const actor: string | undefined = actorFlag ?? (process.env.OVERLOAD_ACTOR || undefined);
      if (action === "resolve") {
        const item = getAttention(control, itemId);
        if (item) {
          const work = getWork(control, item.work_id);
          const hasContextEvidence = typeof item.evidence?.object_id === "string" && !!item.evidence.object_id;
          const hasDecisionOwner = !!work?.contract?.decision_owner?.trim();
          if ((hasContextEvidence || hasDecisionOwner) && !actor) {
            console.error("error: context decision requires --actor or OVERLOAD_ACTOR");
            process.exit(1);
          }
        }
      }
      const result = actOnAttention(control, itemId, revision, action, { defer_until: typeof input.defer_until === "number" ? input.defer_until : undefined, reason: typeof input.reason === "string" ? input.reason : undefined }, actor); publishControl(control); console.log(JSON.stringify(result)); return true;
    } finally { control.close(); }
  }
  if (command === "context") {
    const sub = args[1]; if (!sub) usage();
    if (sub === "purge") {
      const actorIdx = args.indexOf("--actor");
      const actorFlag = actorIdx >= 0 ? args[actorIdx + 1] : undefined;
      if (actorIdx >= 0 && (!actorFlag || actorFlag.startsWith("--"))) usage();
      const purgeDrop = actorIdx >= 0 ? new Set([actorIdx, actorIdx + 1]) : new Set<number>();
      const purgeArgs = args.filter((_, i) => !purgeDrop.has(i));
      const objectId = purgeArgs[2]; if (!objectId) usage();
      const reasonIdx = purgeArgs.indexOf("--reason");
      const reason = reasonIdx >= 0 ? purgeArgs[reasonIdx + 1] : "manual";
      if (!["expired", "revoked", "retention_policy", "manual"].includes(reason)) usage();
      // Purge mutates context evidence and is a write operation: require a real actor,
      // fail closed rather than stamping a system identity onto the tombstone.
      const actor: string | undefined = actorFlag ?? (process.env.OVERLOAD_ACTOR || undefined);
      if (!actor) { console.error("error: context purge requires --actor or OVERLOAD_ACTOR"); process.exit(1); }
      const control = openControl();
      try { purgeObjectContent(control, objectId, reason as "expired" | "revoked" | "retention_policy" | "manual"); publishControl(control); console.log(JSON.stringify({ purged: objectId, reason })); return true; }
      finally { control.close(); }
    }
    usage();
  }
  if (command !== "work") return false;
  const action = args[1]; if (!action) usage(); const control = openControl();
  try {
    if (!(["create", "revise", "redirect", "stop"] as string[]).includes(action)) { const work = getWork(control, action); if (!work) throw new Error(`work not found: ${action}`); console.log(JSON.stringify(work)); return true; }
    const input = jsonArg(args[2]);
    if (action === "create") console.log(JSON.stringify(createWork(control, input as Parameters<typeof createWork>[1])));
    else { const workId = String(input.work_id ?? ""); const revision = Number(input.expected_revision); if (!workId || !Number.isSafeInteger(revision) || revision < 1) throw new Error("work_id and positive expected_revision required"); if (action === "revise") console.log(JSON.stringify(reviseContract(control, workId, revision, input.contract as Contract, String(input.reason ?? "")))); if (action === "redirect") console.log(JSON.stringify(redirectWork(control, workId, revision, { reason: String(input.reason ?? ""), affected_work_ids: input.affected_work_ids as string[], action: input.action as "activate" | "pause" | "stop", evidence: input.evidence as Record<string, unknown> | undefined }))); if (action === "stop") console.log(JSON.stringify(recordStopCondition(control, workId, String(input.condition_id ?? ""), (input.evidence ?? {}) as Record<string, unknown>, Date.now(), revision))); }
    publishControl(control);
    return true;
  } finally { control.close(); }
}

function listSessions(db: Database): void {
  const rows = querySessions(db);
  if (!rows.length) { note("No known sessions."); return; }
  for (const row of rows) console.log(`${row.stable_id}\t${row.runtime ?? "-"}\t${row.origin ?? "unknown"}\t${row.state ?? "-"}\t${row.queue ?? "-"}\t${time(row.last_event_at)}`);
}
function showSession(db: Database, stableId: string): void {
  const result = querySession(db, stableId);
  if (!result) { console.error(`Session not found: ${stableId}`); process.exitCode = 1; return; }
  const { session, incarnations, pending_requests: requests, events } = result;
  console.log(`Session: ${session.stable_id}\nOrigin: ${session.origin ?? "unknown"}\nRuntime: ${session.runtime ?? "-"}\nState: ${session.state ?? "-"}${session.queue ? ` (${session.queue}${session.q5_reason ? `/${session.q5_reason}` : ""})` : ""}\nCreated: ${time(session.created_at)}\nWorkspace: ${session.cwd ?? "-"}${session.branch ? ` (${session.branch})` : ""}\nLast event: ${time(session.last_event_at)}\nLast progress: ${time(session.last_progress_at)}\nLast heartbeat: ${time(session.last_heartbeat_at)}\nJump: ${session.binding ?? "-"}`);
  console.log("\nIncarnations:");
  if (!incarnations.length) console.log("  (none)");
  for (const row of incarnations) console.log(`  ${row.writer_id} [${row.liveness_domain}] pid=${row.pid ?? "-"} started=${time(row.started_at)} last_seen=${time(row.last_seen_at)}`);
  console.log("\nPending requests:");
  if (!requests.length) console.log("  (none)");
  for (const row of requests) console.log(`  ${row.request_uid} [${row.kind}] ${time(row.created_at)}${detail(row.detail)}`);
  console.log("\nRecent events (newest first, heartbeats omitted):");
  if (!events.length) console.log("  (none)");
  for (const row of events) console.log(`  #${row.ingest_seq} ${time(row.at)} ${row.kind} emitter=${row.emitter_id} writer=${row.writer_id}${detail(row.detail)}`);
}
function q1(db: Database): void {
  const rows = queryQ1(db);
  if (!rows.length) { note("Q1: no pending requests."); return; }
  note("Q1 pending requests:");
  for (const row of rows) {
    const jump = row.binding ?? (row.host && row.host !== "local" ? `ssh ${row.host}` : "-");
    console.log(`${row.request_uid}\t${row.kind}\t${time(row.created_at)}\tjump=${jump}${detail(row.detail)}`);
  }
}
export function printQ4(db: Database, output: Output = console.log, heading: Output = note): void {
  const rows = db.query("SELECT stable_id, origin, last_event_at FROM current WHERE queue='q4' ORDER BY last_event_at DESC, stable_id DESC").all() as Array<{ stable_id: string; origin: string; last_event_at: number }>;
  if (!rows.length) { heading("Q4: no auto-verified read-only sessions."); return; }
  heading("Q4 auto-verified read-only sessions:"); for (const row of rows) output(`${row.stable_id}\t${row.origin}\t${time(row.last_event_at)}`);
}
function zombie(db: Database): void {
  const { groups, orphaned_requests: orphaned } = queryZombie(db);
  if (!groups.length && !orphaned.length) { note("Q5: no zombie sessions."); return; }
  // The reason belongs on the row, not in a heading: a grouped row loses its
  // classification the moment it is filtered or piped.
  for (const group of groups) for (const row of group.rows) console.log(`${row.stable_id}\t${group.q5_reason}\t${time(row.last_event_at)}${row.handoff ? `\thandoff=${JSON.stringify(row.handoff)}` : ""}`);
  for (const row of orphaned) console.log(`${row.request_uid}\torphaned_request\t${row.stable_id}\t${time(row.resolved_at)}`);
}
function hung(db: Database): void {
  const rows = queryHung(db);
  if (!rows.length) { note("Hung: no stuck turns."); return; }
  note("Hung turns (heartbeat alive, progress frozen):");
  for (const row of rows) console.log(`${row.stable_id}\t${row.q5_reason}\t${Math.round(row.hung_ms / 60_000)}min\tsince ${time(row.since)}${detail(row.detail)}`);
}
function health(db: Database): void {
  const view = queryHealth(db);
  console.log(`Health: open_incidents=${view.open_incidents.length} coverage_gaps=${view.coverage_gaps} telemetry_gaps=${view.telemetry_gaps}`);
  for (const row of view.open_incidents) console.log(`  incident ${row.source} since ${time(row.opened_at)}${detail(row.detail)}`);
}
/** Accepts either id because the two things worth reaching are addressed differently:
 *  a pending decision is a request, a hung turn has no request to jump from. */
export async function jumpTo(db: Database, id: string, jump = performJump): Promise<void> {
  const stableId = requestSession(db, id) ?? id;
  const target = queryJumpTarget(db, stableId);
  if (!target) { console.error(`Session not found: ${stableId}`); process.exitCode = 1; return; }
  if (!target.binding) { console.error(`No jump target recorded for ${stableId}`); process.exitCode = 1; return; }
  const result: JumpResult = await jump(target);
  if (result.opened) { console.log(`opened ${target.platform ?? "terminal"} ${target.binding}`); return; }
  console.error(`jump failed: ${result.error ?? "target did not respond"}`);
  process.exitCode = 1;
}
/** Acknowledgement is a source terminal (the operator IS the decision authority here):
 *  it cancels the request and thereby stops reminders. Web acks a multi-selection, so
 *  this takes many; a uid that matched nothing must not exit 0 and read as done. */
export function ackAll(db: Database, uids: string[]): void {
  let missed = 0;
  for (const uid of uids) {
    if (ackRequest(db, uid).changes === 1) console.log(`acked ${uid}`);
    else { console.error(`no pending request matches ${uid}`); missed += 1; }
  }
  if (missed) process.exitCode = 1;
}
/** 决策卡：默认 short（summary + reference）；--verbose 展开 long（summary_long，仅读池内摘要，不取源，避免阻塞）。
 *  full 级别 CLI 不取原文，只展示 reference 供用户自行查看。blocked(needs_context) 时不占位、不造值。 */
export function renderDecisionCard(db: Database, itemId: string, opts: { verbose?: boolean; actor?: string } = {}): string {
  const item = getAttention(db, itemId);
  if (!item) throw new Error(`attention not found: ${itemId}`);
  const actor = opts.actor ?? item.owner;
  const result = getContextPackage({
    consumer_type: "decision_ui", consumer_id: itemId, work_id: item.work_id,
    package_type: "decision_view", actor, db,
  });
  const lines: string[] = [];
  if (!result.ok) {
    lines.push("⚠️ 上下文不足：无法装配决策视图");
    lines.push(`原因：${result.reason}`);
    lines.push("必需字段缺失，无法继续。请检查数据源权限或采集状态。");
    return lines.join("\n");
  }
  const pkg = result.package;
  if (pkg.package_type !== "decision_view") return "";
  lines.push(`结论: ${pkg.conclusion}`);
  lines.push(`触发: ${pkg.trigger}`);
  lines.push(`影响: ${pkg.impact}`);
  lines.push(`建议: ${pkg.recommendation ?? "-"}`);
  lines.push(`选项: ${pkg.options.join(" | ")}`);
  lines.push(`责任人: ${pkg.owner}${pkg.expires_at ? `（有效期至 ${time(pkg.expires_at)}）` : ""}`);
  lines.push(`状态: ${pkg.effect_state} (contract rev ${pkg.contract_revision})`);
  if (pkg.scene_entry?.jump_target) lines.push(`现场: ${pkg.scene_entry.jump_target}`);
  lines.push("");
  lines.push("触发证据:");
  if (!pkg.trigger_evidence.length) lines.push("  （无）");
  for (const ev of pkg.trigger_evidence) {
    lines.push(`  - ${ev.summary}  [${ev.reference}]${ev.stale ? "  ⚠ stale：该证据已有新版本，决策依据可能过期" : ""}`);
    if (opts.verbose) {
      const long = fetchOnDemand({
        reference: ev.reference, visibility: "long", actor, work_id: pkg.work_id,
        purpose: "decision_view", version_pin: { object_id: ev.object_id, revision: ev.revision }, db,
      });
      if (!("blocked" in long) && long.payload) lines.push(`    详情: ${long.payload}`);
      else lines.push(`    详情: (不可用${"blocked" in long ? `：${long.reason}` : ""})`);
    }
  }
  if (pkg.stale_objects.length) lines.push(`过期对象: ${pkg.stale_objects.length}（决策依据可能过期）`);
  return lines.join("\n");
}

function runAudit(db: Database, args: string[]): void {
  let sample = 5;
  let sinceMs = 7 * 24 * 60 * 60_000;
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    const value = args[i + 1];
    if (!value || (option !== "--sample" && option !== "--since")) usage();
    if (option === "--sample") {
      sample = Number(value);
      if (!Number.isSafeInteger(sample) || sample < 0) usage();
    } else {
      try { sinceMs = parseSince(value); } catch { usage(); }
    }
  }
  printAudit(audit(db, { sample, sinceMs, now: Date.now() }));
}
export async function main(argv = Bun.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;
  if (command && controlCommand([command, ...rest])) return;
  const simple = new Set(["sessions", "q1", "q4", "hung", "zombie", "health"]);
  const arity: Record<string, (count: number) => boolean> = {
    show: (count) => count === 1, jump: (count) => count === 1, ack: (count) => count >= 1,
    doctor: (count) => count === 0, audit: (count) => count <= 4 && count % 2 === 0,
  };
  if (!command) usage();
  if (command === "orch") { await runOrchestratorCli(rest); return; }
  if (command === "mgmt") { await runMgmtCli(rest); return; }
  if (command === "decision-bot") { const mailbox=openMailbox();const bot=new DecisionBotService(mailbox);try{if(rest[0]==="status"&&rest.length===1)console.log(JSON.stringify(bot.status(),null,2));else if(rest[0]==="once"&&rest.length===1)await bot.tick();else if(rest[0]==="disable"&&rest.length===1)setBotDisabled(mailbox,true,"cli");else if(rest[0]==="enable"&&rest.length===1)setBotDisabled(mailbox,false,"cli");else if(rest[0]==="takeover"&&rest.length===4){const owner=rest[1];if(owner!=="extension"&&owner!=="orchestrator")usage();const result=writeHumanAnswer(mailbox,owner,rest[2]!,rest[3]!,"cli");if(!result.ok){console.error(result.reason);process.exitCode=1;}}else if(rest[0]==="run"&&rest.length===1){for(;;){await bot.tick();await Bun.sleep(2000);}}else usage();}finally{mailbox.close();}return; }
  if (simple.has(command)) { if (rest.length) usage(); } else if (!arity[command]?.(rest.length)) usage();
  if (command === "ack") {
    const rw = new Database(path);
    try { ackAll(rw, rest); } finally { rw.close(); }
    return;
  }
  if (command === "doctor") {
    const { checks, exitCode } = await runDoctor(defaultDoctorDeps());
    for (const check of checks) console.log(`[${check.status}] ${check.label}: ${check.detail}`);
    process.exitCode = exitCode;
    return;
  }
  let db: Database; try { db = new Database(path, { readonly: true }); } catch (error) { console.error(`Unable to open ledger ${path}: ${(error as Error).message}`); process.exit(1); }
  try {
    if (command === "jump") await jumpTo(db, rest[0]!);
    else if (command === "sessions") listSessions(db); else if (command === "show") showSession(db, rest[0]!); else if (command === "q1") q1(db);
    else if (command === "q4") printQ4(db); else if (command === "hung") hung(db); else if (command === "zombie") zombie(db); else if (command === "health") health(db); else runAudit(db, rest);
  } finally { db.close(); }
}
if (import.meta.main) await main();
