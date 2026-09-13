import { Database } from "bun:sqlite";
import { ControlError, openControl } from "../control/store";
import { loadManageConfig, scanOnce, listWorks, showWork, setTracking } from "../manage/manage";
import { checkHandoffPreconditions, createHandoff, launchHandoff, abandonHandoff, buildHandoffPacket } from "../manage/handoff";
import type { SourceHost } from "../manage/source";

const json = (value: unknown, init?: ResponseInit) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" }, ...init });
const body = async (r: Request) => { const x = await r.json(); if (!x || typeof x !== "object" || Array.isArray(x)) throw new ControlError("invalid", "JSON object required"); return x as Record<string, unknown>; };
const idOf = (s: string) => decodeURIComponent(s);

export type MgmtRouteOptions = { controlPath: string; ledgerPath: string; overloadHome?: string };
export async function mgmtRoute(request: Request, url: URL, options: MgmtRouteOptions): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/mgmt/")) return null;
  const path = url.pathname;
  const m = path.match(/^\/api\/mgmt\/works\/([^/]+)(?:\/(track|handoff\/preconditions|handoffs))?$/);
  const handoff = path.match(/^\/api\/mgmt\/handoffs\/([^/]+)\/(launch|abandon|packet)$/);
  const control = openControl(options.controlPath);
  try {
    if (request.method === "GET" && path === "/api/mgmt/works") {
      const track = url.searchParams.get("track") || "tracking";
      if (!["tracking", "paused", "archived"].includes(track)) return json({ error: "invalid track" }, { status: 400 });
      return json(listWorks(control, { track: track as "tracking"|"paused"|"archived" }));
    }
    if (m && request.method === "GET" && !m[2]) { const result = showWork(control, idOf(m[1]!)); return result ? json(result) : json({ error: "not found" }, { status: 404 }); }
    if (m && m[2] === "track" && request.method === "POST") { const x = await body(request); setTracking(control, idOf(m[1]!), x.on === true); return json({ ok: true }); }
    if (m && m[2] === "handoff/preconditions" && request.method === "GET") return json(checkHandoffPreconditions(control, null, idOf(m[1]!)));
    if (m && m[2] === "handoffs" && request.method === "POST") {
      const x = await body(request); const result = createHandoff(control, null, idOf(m[1]!), { target_agent: x.target_agent as any, target_host: String(x.target_host || "local"), isolate: x.isolate === true, override_reason: typeof x.override_reason === "string" ? x.override_reason : undefined });
      return json(result, { status: 201 });
    }
    if (handoff && request.method === "GET" && handoff[2] === "packet") return json(buildHandoffPacket(control, idOf(handoff[1]!)));
    if (handoff && request.method === "POST" && handoff[2] === "abandon") { const x = await body(request); abandonHandoff(control, idOf(handoff[1]!), String(x.reason || "abandoned")); return json({ ok: true }); }
    if (handoff && request.method === "POST" && handoff[2] === "launch") {
      const x = await body(request); if (x.confirmed !== true) return json({ error: "confirmed is required" }, { status: 400 });
      const result = await launchHandoff(control, idOf(handoff[1]!), { confirmed: true, executor: async ({ argv, cwd, env, host }) => {
        const command = host.kind === "ssh" ? [host.remote, ...argv] : argv;
        const p = Bun.spawn(command, { cwd: host.kind === "local" ? cwd : undefined, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
        return { pid: p.pid, receipt: `pid:${p.pid}` };
      }}); return json(result);
    }
    if (request.method === "POST" && path === "/api/mgmt/scan") { const cfg = loadManageConfig(options.overloadHome); const result = await scanOnce(control, null, cfg); return json(result); }
    return json({ error: "not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof ControlError) { const cause = (error as any).cause || error.message; const status = error.code === "conflict" ? 409 : error.code === "invalid" ? 400 : error.code === "not_found" ? 404 : 500; return json({ error: cause, allowed: (error as any).allowed, evidence: (error as any).evidence }, { status }); }
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  } finally { control.close(); }
}
