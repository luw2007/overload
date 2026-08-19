#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ackRequest, configRefocusCostMin, queryAttention, queryHealth, queryJumpTarget, queryQ1, queryQ2, querySession, querySessions, queryZombie, type JumpTarget } from "../shared/queries";
import { performJump, type JumpResult } from "./jump";

const DEFAULT_WEB_PORT = 4870;
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
*{box-sizing:border-box}body{margin:0;font-family:Roboto,Arial,sans-serif;color:var(--gray-900);background:var(--gray-50)}.brand,.num{font-family:"Google Sans",Roboto,Arial,sans-serif}.app-bar{display:flex;align-items:center;padding:12px 24px;background:#fff;border-bottom:1px solid var(--gray-300);position:sticky;top:0;z-index:5}.brand{font-size:20px;color:var(--gray-700)}.health-pill{margin-left:auto;font-size:12px;color:#137333;background:#e6f4ea;padding:6px 12px;border-radius:16px;display:flex;align-items:center;gap:7px}.health-pill.warn{color:#b06000;background:#fef7e0}.dot{width:8px;height:8px;border-radius:50%;background:#188038}.warn .dot{background:#f9ab00}.b-wrap{padding:20px 28px;max-width:1100px;margin:auto}.b-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px}.b-tile{background:#fff;border-radius:12px;padding:16px 18px;box-shadow:var(--shadow);border-left:4px solid var(--blue)}.b-tile.alert{border-left-color:var(--red)}.num{font-size:28px;font-weight:700}.label{font-size:12px;color:var(--gray-500);margin-top:4px}.b-tabs{display:flex;border-bottom:1px solid var(--gray-300)}.b-tab{appearance:none;background:transparent;border:0;border-bottom:3px solid transparent;padding:12px 18px;font-size:14px;color:var(--gray-500);cursor:pointer}.b-tab.active{color:var(--blue);border-bottom-color:var(--blue);font-weight:500}.b-table-wrap{background:#fff;box-shadow:var(--shadow);border-radius:0 0 8px 8px;overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:12px 16px;color:var(--gray-500);font-weight:500;font-size:12px;border-bottom:1px solid var(--gray-300)}td{padding:12px 16px;border-bottom:1px solid var(--gray-100);vertical-align:middle}tr:hover td{background:var(--gray-50)}tr.failed td:first-child{border-left:3px solid var(--red)}.b-toolbar{display:none;align-items:center;gap:12px;padding:10px 16px;background:#e8f0fe;font-size:13px}.b-toolbar.show{display:flex}.btn{border-radius:6px;padding:7px 14px;font:500 13px inherit;border:1px solid var(--gray-300);background:#fff;color:var(--gray-700);cursor:pointer}.btn:hover{background:var(--gray-100)}.btn.primary{background:var(--blue);color:#fff;border-color:var(--blue)}.btn.primary:hover{background:var(--blue-dark)}.btn.danger{color:var(--red)}.chip{font:11px ui-monospace,monospace;padding:3px 8px;border-radius:10px;background:var(--gray-100);color:var(--gray-700)}.empty{text-align:center;color:var(--gray-500);padding:28px}.error{margin:16px 0;padding:12px;color:var(--red);background:var(--red-bg);border-radius:8px}.hidden{display:none}@media(max-width:720px){.b-wrap{padding:14px}.b-tiles{grid-template-columns:repeat(2,1fr)}th:nth-child(5),td:nth-child(5){display:none}}
</style></head><body>
<header class="app-bar"><span class="brand">Overload</span><span class="health-pill" id="health-pill"><span class="dot"></span><span id="health-label">正在连接…</span></span></header>
<main class="b-wrap"><div id="error" class="error hidden"></div><section class="b-tiles">
<div class="b-tile alert"><div class="num" id="tile-q1">—</div><div class="label">Q1 待决策</div></div><div class="b-tile"><div class="num" id="tile-q2">—</div><div class="label">Q2 已完成</div></div><div class="b-tile"><div class="num" id="tile-zombie">—</div><div class="label">Zombie</div></div><div class="b-tile alert"><div class="num" id="tile-incidents">—</div><div class="label">Open incidents</div></div>
</section><nav class="b-tabs" aria-label="数据集"><button class="b-tab active" data-tab="q1">Q1 决策</button><button class="b-tab" data-tab="q2">Q2 完成</button><button class="b-tab" data-tab="zombie">Zombie</button><button class="b-tab" data-tab="health">Health</button></nav>
<div class="b-toolbar" id="toolbar"><span id="selected-count">0 项已选</span><button class="btn primary" id="bulk-ack">批量 Ack</button><button class="btn" id="clear-selection">取消</button></div><div class="b-table-wrap"><table class="b-table"><thead id="table-head"></thead><tbody id="table-body"></tbody></table></div></main><script src="/static/app.js"></script></body></html>`;

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

export function startWebServer(options: { ledgerPath?: string; port?: number; jump?: (target: JumpTarget) => Promise<JumpResult> } = {}) {
  const ledgerPath = options.ledgerPath ?? process.env.OVERLOAD_LEDGER_PATH ?? join(homedir(), ".overload", "ledger.db");
  return Bun.serve({
    // Loopback is the v1 trust boundary. Add authentication before supporting
    // shared machines or any non-loopback bind address.
    hostname: "127.0.0.1",
    port: options.port ?? DEFAULT_WEB_PORT,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (request.method === "GET" && url.pathname === "/") return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (request.method === "GET" && url.pathname === "/static/app.js") return new Response(Bun.file(staticAppPath), { headers: { "content-type": "text/javascript; charset=utf-8" } });
        if (request.method === "GET" && url.pathname === "/api/summary") return json(withReadonlyDb(ledgerPath, (db) => {
          const health = queryHealth(db);
          return { q1: queryQ1(db).length, q2: queryQ2(db).length, open_incidents: health.open_incidents.length, coverage_gaps: health.coverage_gaps, telemetry_gaps: health.telemetry_gaps };
        }));
        if (request.method === "GET" && url.pathname === "/api/sessions") return json(withReadonlyDb(ledgerPath, querySessions));
        if (request.method === "GET" && url.pathname === "/api/q1") return json(withReadonlyDb(ledgerPath, queryQ1).map(({ platform: _platform, ...row }) => row));
        if (request.method === "GET" && url.pathname === "/api/q2") return json(withReadonlyDb(ledgerPath, queryQ2));
        if (request.method === "GET" && url.pathname === "/api/zombie") return json(withReadonlyDb(ledgerPath, queryZombie));
        if (request.method === "GET" && url.pathname === "/api/health") return json(withReadonlyDb(ledgerPath, (db) => ({ ...queryHealth(db), attention: queryAttention(db, Date.now(), configRefocusCostMin()) })));
        if (request.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
          const stableId = routeParameter(url.pathname.slice("/api/sessions/".length));
          const result = withReadonlyDb(ledgerPath, (db) => querySession(db, stableId));
          return result ? json(result) : json({ error: "session not found" }, { status: 404 });
        }
        if (request.method === "POST" && url.pathname.startsWith("/api/jump/")) {
          const requestUid = routeParameter(url.pathname.slice("/api/jump/".length));
          const target = withReadonlyDb(ledgerPath, (db) => queryJumpTarget(db, requestUid));
          return target ? json(await (options.jump ?? performJump)(target)) : json({ error: "request not found" }, { status: 404 });
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

if (import.meta.main) {
  const config = await loadWebConfig();
  const server = startWebServer({ port: config.web_port });
  console.log(`overload web listening on http://${server.hostname}:${server.port}`);
}
