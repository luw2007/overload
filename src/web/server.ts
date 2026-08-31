#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ackRequest, queryArchive, queryHealth, queryHung, queryJumpTarget, queryQ1, queryQ2, querySession, querySessions, queryZombie, requestSession, type JumpTarget } from "../shared/queries";
import { performJump, type JumpResult } from "../shared/jump";
import { inspectResume, resumeSession, type ProcessProbe, type ResumeExecutor } from "../shared/resume";

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
.age-chip{font-size:11px;color:var(--gray-500);background:var(--gray-100);padding:3px 8px;border-radius:10px}.age-warn{color:var(--red);background:var(--red-bg)}.impact-line{font-size:12px;color:var(--gray-500)}.btn.closeout{color:var(--red);border-color:var(--red)}.opt-answer{cursor:pointer;border:1px solid var(--blue);border-radius:10px;padding:3px 8px;color:var(--blue)}.opt-answer:hover{background:#e8f0fe}.answered-note{font-size:12px;color:#137333;background:#e6f4ea;padding:3px 8px;border-radius:10px}
</style></head><body>
<header class="app-bar"><span class="brand">Overload</span><span class="health-pill" id="health-pill"><span class="dot"></span><span id="health-label">正在连接…</span></span></header>
<main class="b-wrap"><div id="error" class="error hidden"></div><section class="b-tiles">
<div class="b-tile alert"><div class="num" id="tile-now">—</div><div class="label">Now 待处理</div></div><div class="b-tile"><div class="num" id="tile-inbox">—</div><div class="label">Inbox 待批量</div></div>
</section><nav class="b-tabs" aria-label="数据集"><button class="b-tab active" data-tab="now">Now</button><button class="b-tab" data-tab="inbox">Inbox</button><button class="b-tab" data-tab="done">Done</button><span class="b-tabs-secondary"><button class="b-tab secondary" data-tab="sessions">会话</button><button class="b-tab secondary" data-tab="health">Health</button></span></nav>
<div class="b-toolbar" id="toolbar"><span id="selected-count">0 项已选</span><button class="btn primary" id="bulk-ack">批量 Ack</button><button class="btn" id="clear-selection">取消</button></div><div id="detail" class="hidden"></div><div class="b-content" id="content"></div></main><script src="/static/app.js"></script></body></html>`;

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

async function writeAnswer(dir: string, requestUid: string, option: string | null, text: string | null): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const path = join(dir, `${requestUid}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ request_uid: requestUid, option, text, answered_at: Date.now() }), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export function startWebServer(options: { ledgerPath?: string; port?: number; jump?: (target: JumpTarget) => Promise<JumpResult>; resume?: ResumeExecutor; processAlive?: ProcessProbe } = {}) {
  const ledgerPath = options.ledgerPath ?? process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
  const answersDir = process.env.OVERLOAD_ANSWERS_DIR ?? join(homedir(), ".overload", "answers");
  ensureCloseouts(ledgerPath);
  return Bun.serve({
    // Loopback is the v1 trust boundary. Add authentication before supporting
    // shared machines or any non-loopback bind address.
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_WEB_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && (url.pathname === "/" || dashboardRoute(url.pathname))) return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (request.method === "GET" && url.pathname === "/static/app.js") return new Response(Bun.file(staticAppPath), { headers: { "content-type": "text/javascript; charset=utf-8" } });
        if (request.method === "GET" && url.pathname === "/api/summary") return json(withReadonlyDb(ledgerPath, (db) => {
          const health = queryHealth(db);
          return { q1: queryQ1(db).length, q2: queryQ2(db).length, hung: queryHung(db).length, open_incidents: health.open_incidents.length, coverage_gaps: health.coverage_gaps, telemetry_gaps: health.telemetry_gaps };
        }));
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
        if (request.method === "POST" && url.pathname.startsWith("/api/closeout/")) {
          const stableId = routeParameter(url.pathname.slice("/api/closeout/".length));
          const db = new Database(ledgerPath);
          try {
            if (!db.query("SELECT 1 FROM sessions WHERE stable_id=?").get(stableId)) return json({ error: "session not found" }, { status: 404 });
            db.query("INSERT OR REPLACE INTO closeouts(stable_id, closed_at) VALUES (?, ?)").run(stableId, Date.now());
            return json({ closed: true });
          } finally { db.close(); }
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/answer/")) {
          const requestUid = routeParameter(url.pathname.slice("/api/answer/".length));
          if (!requestUid || basename(requestUid) !== requestUid) return json({ error: "invalid request_uid" }, { status: 400 });
          const body = await request.json().catch(() => null) as { option?: unknown; text?: unknown } | null;
          if (!body || (body.option === undefined && body.text === undefined) || (body.option !== undefined && typeof body.option !== "string") || (body.text !== undefined && typeof body.text !== "string")) return json({ error: "option or text required" }, { status: 400 });
          const state = withReadonlyDb(ledgerPath, (db) => db.query("SELECT state FROM requests WHERE request_uid=?").get(requestUid) as { state: string } | null);
          if (!state) return json({ error: "request not found" }, { status: 404 });
          if (state.state !== "pending") return json({ error: "request not pending" }, { status: 409 });
          await writeAnswer(answersDir, requestUid, body.option as string | undefined ?? null, body.text as string | undefined ?? null);
          return json({ written: true });
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/resume-session/")) {
          const stableId = routeParameter(url.pathname.slice("/api/resume-session/".length));
          const db = new Database(ledgerPath, { readonly: true });
          try {
            const result = await resumeSession(db, stableId, options.resume, options.processAlive);
            return result ? json(result, { status: result.resumed ? 200 : 409 }) : json({ error: "session not found" }, { status: 404 });
          } finally { db.close(); }
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/ack/")) {
          const requestUid = routeParameter(url.pathname.slice("/api/ack/".length));
          const db = new Database(ledgerPath);
          try { return json({ acked: ackRequest(db, requestUid).changes === 1 }); } finally { db.close(); }
        }
        return json({ error: "not found" }, { status: 404 });
      } catch (error) {
        console.error(`overload web: ${request.method} ${url.pathname}: ${(error as Error).message}`);
        return json({ error: "internal server error" }, { status: 500 });
      }
    },
  });
}

function dashboardRoute(pathname: string): boolean {
  return /^\/(?:now|inbox|done|sessions|health|q1|q2|archive|hung|zombie)(?:\/[^/]+)?\/$/.test(`${pathname}/`);
}

if (import.meta.main) {
  const config = await loadWebConfig();
  const server = startWebServer({ port: config.web_port });
  console.log(`overload web listening on http://${server.hostname}:${server.port}`);
}
