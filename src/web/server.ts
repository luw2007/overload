#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAnswersDb, defaultAnswersPath } from "../orchestrator/approval";
import { cancelTarget, consumeDecision, reconcileEffectEvents, registerTarget, writeHumanAnswer, setBotDisabled } from "../decision-bot/mailbox";
import { approvePolicyCandidate, enablePolicyCandidate, getPolicyCandidate, loadPolicy, matchingRule, policyAuthorizes, rulesReport } from "../decision-bot/policy";
import { disablePolicyRule, enablePolicyRule, proposeRuleFromAttention } from "../decision-bot/policy";
import { DecisionBotService } from "../decision-bot/service";
import { ackRequest, queryArchive, queryHealth, queryHung, queryJumpTarget, queryQ1, queryQ2, querySession, querySessions, queryZombie, requestSession, type JumpTarget } from "../shared/queries";
import { performJump, type JumpResult } from "../shared/jump";
import { inspectResume, resumeSession, type ProcessProbe, type ResumeExecutor } from "../shared/resume";
import { actOnAttention, ControlError, createWork, getAttention, getWork, listAttention, listWorks, openControl, recordAttentionFeedback, recordStopCondition, redirectWork, reviseContract, promoteWork } from "../control/store";
import { previewContractRevision } from "../control/store";
import type { Contract } from "../control/types";
import { notificationCapability } from "../notify/nudge";
import { publishControlEvents } from "../control/outbox";
import { openStore } from "../orchestrator/store";
import {ensureAdapterSchema,type Conversation,type StoredTurn} from '../adapters/store';
import {randomUUID} from 'node:crypto';
import { SpoolWriter } from "../orchestrator/spool";

import { ledgerReport } from "./ledger";

const DEFAULT_WEB_PORT = 4870;
/** The list is a launchpad for drill-down, not an inventory: 1000 rows serve nobody. */
const SESSION_LIST_LIMIT = 100;
let warnedInvalidConfig = false;

export type WebConfig = { web_port: number };

export async function loadWebConfig(path = join(homedir(), ".overload", "config.json")): Promise<WebConfig> {
  let value: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed;
    else warnInvalidConfig(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warnInvalidConfig(path);
  }
  if (value.web_port !== undefined && !positiveInteger(value.web_port)) warnInvalidConfig(path);
  return { web_port: positiveInteger(value.web_port) ? value.web_port : DEFAULT_WEB_PORT };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

async function bodyObject(request: Request): Promise<Record<string, unknown>> {
  const value = await request.json();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ControlError("invalid", "JSON object required");
  return value as Record<string, unknown>;
}

function expectedRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new ControlError("invalid", "expected_revision must be a positive integer");
  return value;
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

export function startWebServer(options: { ledgerPath?: string; controlPath?: string; policyPath?: string; orchestratorPath?: string; spoolRoot?: string; publishIntervalMs?: number; port?: number; jump?: (target: JumpTarget) => Promise<JumpResult>; resume?: ResumeExecutor; processAlive?: ProcessProbe } = {}) {
  const ledgerPath = options.ledgerPath ?? process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
  const controlPath = options.controlPath;
  const port = options.port ?? DEFAULT_WEB_PORT;
  ensureCloseouts(ledgerPath);
  let publishing = false;
  const publish = () => {
    if (publishing) return;
    publishing = true;
    const control = openAnswersDb(controlPath); const orchestrator = openStore(options.orchestratorPath); const spool = new SpoolWriter(orchestrator, options.spoolRoot);
    try { reconcileEffectEvents(control, ledgerPath); publishControlEvents(control, ledgerPath, (detail) => spool.emit(`control:${String(detail.event_id)}`, "control_event", detail)); }
    finally { spool.close(); orchestrator.close(); control.close(); publishing = false; }
  };
  publish();
  const timer = setInterval(publish, options.publishIntervalMs ?? 1_000);
  timer.unref?.();
  const server = Bun.serve({
    // Loopback is the v1 trust boundary. Add authentication before supporting
    // shared machines or any non-loopback bind address.
    hostname: "127.0.0.1",
    port,
    async fetch(request, server) {
      const url = new URL(request.url);
      try {
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
        if (request.method === "GET" && url.pathname === "/api/summary") return json(withReadonlyDb(ledgerPath, (db) => {
          const health = queryHealth(db);
          const control = openControl(controlPath);
          try { return { q1: queryQ1(db).length, q2: queryQ2(db).length, hung: queryHung(db).length, open_incidents: health.open_incidents.length, coverage_gaps: health.coverage_gaps, telemetry_gaps: health.telemetry_gaps }; }
          finally { control.close(); }
        }));
        if (request.method === "GET" && /^\/api\/attention\/(now|inbox|done)$/.test(url.pathname)) {
          const control = openControl(controlPath); try { return json(listAttention(control, url.pathname.slice("/api/attention/".length) as "now" | "inbox" | "done")); } finally { control.close(); }
        }
        if (request.method === "GET" && url.pathname === "/api/capabilities") return json({ notifications: notificationCapability(), web: { available: true, bind: "127.0.0.1", port: server.port } });
        if(request.method==='GET'&&url.pathname==='/api/conversations'){const db=openControl(controlPath);try{ensureAdapterSchema(db);const rows=db.query('SELECT * FROM conversations ORDER BY created_at DESC').all() as Conversation[];return json(rows.map(c=>({...c,address:JSON.parse(c.address),session_reference:c.session_reference?JSON.parse(c.session_reference):null,turns:db.query('SELECT * FROM conversation_turns WHERE conversation_id=? ORDER BY sequence').all(c.id)})));}finally{db.close();}}
        const conversationMessage=url.pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
        if(request.method==='POST'&&conversationMessage){const db=openControl(controlPath);try{ensureAdapterSchema(db);const input=await bodyObject(request);if(typeof input.text!=='string'||!input.text.trim()||input.text.length>100000)return json({error:'invalid message'},{status:400});const id=routeParameter(conversationMessage[1]);const c=db.query('SELECT * FROM conversations WHERE id=?').get(id) as Conversation|null;if(!c)return json({error:'not_found'},{status:404});const turnId=randomUUID();db.transaction(()=>{const row=db.query('SELECT COALESCE(MAX(sequence),0)+1 n FROM conversation_turns WHERE conversation_id=?').get(id) as {n:number};db.run('INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,created_at) VALUES(?,?,?,?,?,?)',[turnId,id,row.n,input.text as string,'queued',Date.now()]);}).immediate();return json({turn_id:turnId},{status:201});}finally{db.close();}}
        if (request.method === "GET" && url.pathname === "/api/ledger") {
          const until = url.searchParams.has("until") ? Number(url.searchParams.get("until")) : Date.now();
          const since = url.searchParams.has("since") ? Number(url.searchParams.get("since")) : until - 7*86400000;
          if (!Number.isFinite(since)||!Number.isFinite(until)||since<0||since>until) return json({error:"invalid time window"},{status:400});
          const db=openAnswersDb(controlPath);try{return json(ledgerReport(db,{since,until}));}finally{db.close();}
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
            if (request.method === "POST" && operation === "redirect") return json(redirectWork(control, workId, revision, { reason: String(input.reason ?? ""), affected_work_ids: input.affected_work_ids as string[], action: input.action as "activate" | "pause" | "stop", evidence: input.evidence as Record<string, unknown> | undefined }));
            if (request.method === "POST" && operation === "stop") return json(recordStopCondition(control, workId, String(input.condition_id ?? ""), (input.evidence ?? {}) as Record<string, unknown>, Date.now(), revision));
          } catch (error) { return controlError(error); } finally { control.close(); }
        }
        const attentionRoute = url.pathname.match(/^\/api\/attention\/([^/]+)\/(ack|defer|resolve|feedback)$/);
        if (request.method === "POST" && attentionRoute) {
          const itemId = routeParameter(attentionRoute[1]!); const action = attentionRoute[2]!; const input = await bodyObject(request); const control = openControl(controlPath);
          try {
            const revision = expectedRevision(input.expected_revision);
            if(action==="resolve"&&input.selected_option==="narrow"&&(!Number.isSafeInteger(input.expected_contract_revision)||!Array.isArray(input.affected_cards)))throw new ControlError("invalid","Review the contract and affected cards before applying narrow.");
            if (action === "feedback") { recordAttentionFeedback(control, itemId, revision, input.useful === true, typeof input.reason === "string" ? input.reason : undefined); return json(getAttention(control, itemId)); }
            return json(actOnAttention(control, itemId, revision, action as "ack" | "defer" | "resolve", { defer_until: typeof input.defer_until === "number" ? input.defer_until : undefined, reason: typeof input.reason === "string" ? input.reason : undefined, selected_option: typeof input.selected_option === "string" ? input.selected_option : undefined, replacement_contract: input.replacement_contract as Contract | undefined, expected_contract_revision: input.expected_contract_revision as number | undefined, affected_cards: input.affected_cards as Array<{item_id:string;revision:number}> | undefined }));
          } catch (error) { return controlError(error); } finally { control.close(); }
        }
        if (request.method === "GET" && url.pathname === "/api/sessions") return json(withReadonlyDb(ledgerPath, (db) => querySessions(db, SESSION_LIST_LIMIT).map((session) => ({ ...session, resume_capability: inspectResume(db, session.stable_id, options.processAlive) }))));
        if (request.method === "GET" && url.pathname === "/api/q1") return json(withReadonlyDb(ledgerPath, queryQ1).map(({ platform: _platform, ...row }) => row));
        if (request.method === "GET" && url.pathname === "/api/q2") return json(withReadonlyDb(ledgerPath, queryQ2));
        if (request.method === "GET" && url.pathname === "/api/archive") return json(withReadonlyDb(ledgerPath, queryArchive));
        if (request.method === "GET" && url.pathname === "/api/zombie") return json(withReadonlyDb(ledgerPath, (db) => {
          const view = queryZombie(db);
          return { ...view, groups: view.groups.map((group) => ({ ...group, rows: group.rows.map((row) => ({ ...row, resume_capability: inspectResume(db, row.stable_id, options.processAlive) })) })) };
        }));
        if (request.method === "GET" && url.pathname === "/api/hung") return json(withReadonlyDb(ledgerPath, (db) => queryHung(db).map((row) => ({ ...row, resume_capability: inspectResume(db, row.stable_id, options.processAlive) }))));
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
          try {
            const result = await resumeSession(db, stableId, options.resume, options.processAlive);
            return result ? json(result, { status: result.resumed ? 200 : 409 }) : json({ error: "session not found" }, { status: 404 });
          } finally { db.close(); }
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
          if (!request.headers.get("sec-fetch-site") && !request.headers.get("sec-fetch-mode")) return json({error:"forbidden"},{status:403});let body:any;try{body=await request.json();}catch{return json({error:"invalid JSON"},{status:400});}if(body?.consumerOwner!=="extension"||typeof body.approvalId!=="string"||!Array.isArray(body.options))return json({error:"invalid target"},{status:400});const mailbox=openAnswersDb(controlPath);try{const effect=String(body.effect??"gated_tool"),binding=trustedTargetBinding(mailbox,body.approvalId,effect);const normalized={consumerOwner:"extension" as const,approvalId:body.approvalId,stableId:typeof body.stableId==="string"?body.stableId:undefined,requestUid:typeof body.requestUid==="string"?body.requestUid:undefined,question:String(body.question??""),options:body.options,effect,scope:body.scope??{},evidence:body.evidence??{},expiresAt:Number(body.expiresAt),workId:binding.workId,contractRevision:binding.contractRevision,decisionMode:"human_only" as "human_only"|"scoped_auto"};const policy=loadPolicy(options.policyPath,mailbox);if(!binding.humanOnly&&matchingRule(policy,normalized as any))normalized.decisionMode="scoped_auto";return json(registerTarget(mailbox,normalized));}finally{mailbox.close();}
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
        if(request.method==="POST"&&url.pathname.startsWith("/api/decision/consume/")){if(!request.headers.get("sec-fetch-site")&&!request.headers.get("sec-fetch-mode"))return json({error:"forbidden"},{status:403});let body:any;try{body=await request.json();}catch{return json({error:"invalid JSON"},{status:400});}const id=routeParameter(url.pathname.slice("/api/decision/consume/".length));if(!id||body?.consumer_owner!=="extension"||typeof body.target_version!=="string")return json({error:"invalid consume"},{status:400});const mailbox=openAnswersDb(controlPath);try{const policy=loadPolicy(options.policyPath,mailbox);const r=consumeDecision(mailbox,{consumerOwner:"extension",approvalId:id,targetVersion:body.target_version,policyHash:policy.hash,liveValid:()=>true,policyValid:(t,p)=>!!p&&policyAuthorizes(policy,t,p.answer,p.policyHash)});return r?json(r):json({error:"not ready"},{status:404});}finally{mailbox.close();}}
        if(request.method==="GET"&&url.pathname==="/api/decision-bot/status"){const mailbox=openAnswersDb(controlPath);try{return json(new DecisionBotService(mailbox).status());}finally{mailbox.close();}}
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
  });
  const originalStop = server.stop.bind(server);
  server.stop = ((closeActiveConnections?: boolean) => { clearInterval(timer); return originalStop(closeActiveConnections); }) as typeof server.stop;
  return server;
}

function dashboardRoute(path: string): boolean {
  return /^\/(conversations|decide|ledger|works|candidates|rules|agents|now|inbox|done|sessions|health|q1|q2|archive|hung|zombie)(?:\/.*)?$/.test(path);
}

if (import.meta.main) {
  const config = await loadWebConfig();
  const server = startWebServer({ port: config.web_port });
  console.log(`overload web listening on http://${server.hostname}:${server.port}`);
}
