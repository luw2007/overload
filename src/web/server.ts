#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openAnswersDb, defaultAnswersPath } from "../orchestrator/approval";
import { consumeDecision, reconcileEffectEvents, registerTarget, writeHumanAnswer } from "../decision-bot/mailbox";
import { approvePolicyCandidate, enablePolicyCandidate, getPolicyCandidate, loadPolicy, matchingRule, policyAuthorizes } from "../decision-bot/policy";
import { DecisionBotService } from "../decision-bot/service";
import { ackRequest, queryArchive, queryHealth, queryHung, queryJumpTarget, queryQ1, queryQ2, querySession, querySessions, queryZombie, requestSession, type JumpTarget } from "../shared/queries";
import { performJump, type JumpResult } from "../shared/jump";
import { inspectResume, resumeSession, type ProcessProbe, type ResumeExecutor } from "../shared/resume";
import { actOnAttention, ControlError, createWork, getAttention, getWork, listAttention, listWorks, openControl, recordAttentionFeedback, recordStopCondition, redirectWork, reviseContract } from "../control/store";
import type { Contract } from "../control/types";
import { notificationCapability } from "../notify/nudge";
import { publishControlEvents } from "../control/outbox";
import { openStore } from "../orchestrator/store";
import { SpoolWriter } from "../orchestrator/spool";

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

const dashboardHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Overload dashboard</title><style>
:root{--blue:#1a73e8;--blue-dark:#1557b0;--red:#d93025;--red-bg:#fef7f6;--gray-900:#202124;--gray-700:#3c4043;--gray-500:#5f6368;--gray-300:#dadce0;--gray-100:#f1f3f4;--gray-50:#f8f9fa;--surface:#fff;--shadow:0 1px 2px rgba(60,64,67,.3),0 1px 3px 1px rgba(60,64,67,.15)}
*{box-sizing:border-box}body{margin:0;font-family:Roboto,Arial,sans-serif;color:var(--gray-900);background:var(--gray-50)}.brand,.num{font-family:"Google Sans",Roboto,Arial,sans-serif}.app-bar{display:flex;align-items:center;padding:12px 24px;background:#fff;border-bottom:1px solid var(--gray-300);position:sticky;top:0;z-index:5}.brand{font-size:20px;color:var(--gray-700)}.health-pill{margin-left:auto;font-size:12px;color:#137333;background:#e6f4ea;padding:6px 12px;border-radius:16px;display:flex;align-items:center;gap:7px}.health-pill.warn{color:#b06000;background:#fef7e0}.dot{width:8px;height:8px;border-radius:50%;background:#188038}.warn .dot{background:#f9ab00}.b-wrap{padding:20px 28px;max-width:1100px;margin:auto}.b-tiles{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-bottom:20px}.b-tile{background:#fff;border-radius:12px;padding:16px 18px;box-shadow:var(--shadow);border-left:4px solid var(--blue)}.b-tile.alert{border-left-color:var(--red)}.num{font-size:28px;font-weight:700}.label{font-size:12px;color:var(--gray-500);margin-top:4px}.b-tabs{display:flex;align-items:center;border-bottom:1px solid var(--gray-300)}.b-tab{appearance:none;background:transparent;border:0;border-bottom:3px solid transparent;padding:12px 18px;font-size:14px;color:var(--gray-500);cursor:pointer}.b-tab.active{color:var(--blue);border-bottom-color:var(--blue);font-weight:500}.b-tabs-secondary{margin-left:auto;display:flex}.b-tab.secondary{font-size:12px;padding:12px 14px}.b-table-wrap{background:#fff;box-shadow:var(--shadow);border-radius:0 0 8px 8px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:12px 16px;color:var(--gray-500);font-weight:500;font-size:12px;border-bottom:1px solid var(--gray-300)}td{padding:12px 16px;border-bottom:1px solid var(--gray-100);vertical-align:middle}tr:hover td{background:var(--gray-50)}tr.failed td:first-child{border-left:3px solid var(--red)}.b-toolbar{display:none;align-items:center;gap:12px;padding:10px 16px;background:#e8f0fe;font-size:13px}.b-toolbar.show{display:flex}.btn{border-radius:6px;padding:7px 14px;font:500 13px inherit;border:1px solid var(--gray-300);background:#fff;color:var(--gray-700);cursor:pointer}.btn:hover{background:var(--gray-100)}.btn.primary{background:var(--blue);color:#fff;border-color:var(--blue)}.btn.primary:hover{background:var(--blue-dark)}.btn.danger{color:var(--red)}.chip{font:11px ui-monospace,monospace;padding:3px 8px;border-radius:10px;background:var(--gray-100);color:var(--gray-700)}.empty{text-align:center;color:var(--gray-500);padding:28px}.error{margin:16px 0;padding:12px;color:var(--red);background:var(--red-bg);border-radius:8px}.hidden{display:none}@media(max-width:720px){.b-wrap{padding:14px}}
.session-grid,.decision-groups,.decision-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}.decision-groups{grid-template-columns:1fr}.session-card,.decision-card,.decision-group,.hint-card{background:var(--surface);border-radius:12px;padding:16px}.session-card,.decision-card{border:1px solid var(--gray-300);box-shadow:0 1px 2px rgba(60,64,67,.12)}.decision-group,.hint-card{box-shadow:var(--shadow);margin-bottom:16px}.session-card-head,.session-actions,.decision-card-head,.decision-card-actions,.group-head{display:flex;align-items:center;gap:10px}.session-card-head,.group-head,.decision-card-head{justify-content:space-between}.session-card-head a{overflow-wrap:anywhere}.session-meta,.session-time,.decision-card-meta{color:var(--gray-500);font-size:13px;margin-top:8px}.session-actions,.decision-card-actions{margin-top:16px;flex-wrap:wrap}.resume-status{font-size:12px;color:var(--gray-500)}.session-grid .btn:disabled{opacity:.55}.group-head{margin-bottom:12px}.decision-card-summary{font-size:14px;font-weight:500;flex:1}.decision-card.hung{border-left:3px solid var(--red)}.option-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.hint-text{color:var(--gray-500);font-size:13px;margin:8px 0}
</style></head><body>
<header class="app-bar"><span class="brand">Overload</span><span class="health-pill" id="health-pill"><span class="dot"></span><span id="health-label">正在连接…</span></span></header>
<main class="b-wrap"><div id="error" class="error hidden"></div><section class="b-tiles">
<div class="b-tile alert"><div class="num" id="tile-now">—</div><div class="label">Now 待处理</div></div><div class="b-tile"><div class="num" id="tile-inbox">—</div><div class="label">Inbox 待批量</div></div>
</section><nav class="b-tabs" aria-label="数据集"><button class="b-tab active" data-tab="now">Now</button><button class="b-tab" data-tab="inbox">Inbox</button><button class="b-tab" data-tab="done">Done</button><span class="b-tabs-secondary"><button class="b-tab secondary" data-tab="sessions">会话</button><button class="b-tab secondary" data-tab="health">Health</button></span></nav>
<div class="b-toolbar" id="toolbar"><span id="selected-count">0 项已选</span><button class="btn primary" id="bulk-ack">批量 Ack</button><button class="btn primary hidden" id="bulk-closeout">批量收尾</button><button class="btn" id="clear-selection">取消</button></div><div id="detail" class="hidden"></div><div class="b-content" id="content"></div></main><script src="/static/app.js"></script></body></html>`;

const staticAppPath = fileURLToPath(new URL("./static/app.js", import.meta.url));

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
        if (request.method === "GET" && (url.pathname === "/" || dashboardRoute(url.pathname))) return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (request.method === "GET" && url.pathname === "/static/app.js") return new Response(Bun.file(staticAppPath), { headers: { "content-type": "text/javascript; charset=utf-8" } });
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
            if (action === "feedback") { recordAttentionFeedback(control, itemId, revision, input.useful === true, typeof input.reason === "string" ? input.reason : undefined); return json(getAttention(control, itemId)); }
            return json(actOnAttention(control, itemId, revision, action as "ack" | "defer" | "resolve", { defer_until: typeof input.defer_until === "number" ? input.defer_until : undefined, reason: typeof input.reason === "string" ? input.reason : undefined, selected_option: typeof input.selected_option === "string" ? input.selected_option : undefined, replacement_contract: input.replacement_contract as Contract | undefined }));
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
          if (!request.headers.get("sec-fetch-site") && !request.headers.get("sec-fetch-mode")) return json({ error: "forbidden" }, { status: 403 });let body:any;try{body=await request.json();}catch{return json({error:"invalid JSON"},{status:400});}const approvalId=routeParameter(url.pathname.slice("/api/orchestrator/answer/".length));if(!approvalId||typeof body?.answer!=="string")return json({error:"missing answer"},{status:400});const mailbox=openAnswersDb(controlPath);try{const owner=body.consumer_owner==="extension"?"extension":"orchestrator";const result=writeHumanAnswer(mailbox,owner,approvalId,body.answer,"ui");return result.ok?json({ok:true}):json({error:result.reason},{status:result.reason==="already_consumed"?409:400});}finally{mailbox.close();}
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

function dashboardRoute(pathname: string): boolean {
  return /^\/(?:now|inbox|done|sessions|health|q1|q2|archive|hung|zombie)(?:\/[^/]+)?\/$/.test(`${pathname}/`);
}

if (import.meta.main) {
  const config = await loadWebConfig();
  const server = startWebServer({ port: config.web_port });
  console.log(`overload web listening on http://${server.hostname}:${server.port}`);
}
