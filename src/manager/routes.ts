import { Database } from "bun:sqlite";
import { openControl } from "../control/store";
import { buildManagerContext } from "./context";
import { ManagerReadError, readManagerView } from "./inspect";
import { ManagerBusyError, listManagerTurns } from "./store";
import { askManager, loadManagerConfig, ManagerInputError, type DeliverHandoff, type ManagerConfig, type RunModel } from "./turn";

export type ManagerRouteDeps = { controlPath: string; ledgerPath: string; configPath?: string; config?: ManagerConfig; runModel?: RunModel; deliverHandoff?: DeliverHandoff };

export function openLedgerReadonly(path: string): Database | null {
  try { return new Database(path, { readonly: true }); } catch { return null; }
}

async function withDbs<T>(deps: ManagerRouteDeps, fn: (control: Database, ledger: Database | null) => Promise<T> | T): Promise<T> {
  const control = openControl(deps.controlPath);
  const ledger = openLedgerReadonly(deps.ledgerPath);
  try { return await fn(control, ledger); } finally { ledger?.close(); control.close(); }
}

/** /api/manager/* routes. Origin/host checks are applied by the caller (server.ts checkOrigin). */
export async function managerRoute(request: Request, url: URL, deps: ManagerRouteDeps): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/manager/")) return null;
  const route = url.pathname.slice("/api/manager/".length);
  if (request.method === "POST" && route === "ask") {
    let body: unknown;
    try { body = await request.json(); } catch { return Response.json({ error: "invalid", message: "JSON object required" }, { status: 400 }); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "invalid", message: "JSON object required" }, { status: 400 });
    const input = body as Record<string, unknown>;
    if (typeof input.question !== "string") return Response.json({ error: "invalid", message: "question is required" }, { status: 400 });
    const source = input.source === undefined ? "web" : input.source;
    if (source !== "web" && source !== "cli") return Response.json({ error: "invalid", message: "source must be web or cli" }, { status: 400 });
    const config = deps.config ?? loadManagerConfig(deps.configPath);
    try {
      return await withDbs(deps, async (control, ledger) => Response.json(await askManager({ control, ledger, config, runModel: deps.runModel, deliverHandoff: deps.deliverHandoff }, { question: input.question as string, source })));
    } catch (error) {
      if (error instanceof ManagerBusyError) return Response.json({ error: "manager_busy", message: "another manager turn is running" }, { status: 409 });
      if (error instanceof ManagerInputError) return Response.json({ error: "invalid", message: error.message }, { status: 400 });
      throw error;
    }
  }
  if (request.method !== "GET") return null;
  if (route === "turns") {
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return Response.json({ error: "invalid", message: "limit must be 1..200" }, { status: 400 });
    return withDbs(deps, (control) => Response.json({ turns: listManagerTurns(control, limit) }));
  }
  if (route === "context") return withDbs(deps, (control, ledger) => Response.json(buildManagerContext(control, ledger)));
  if (route === "read") {
    try {
      return await withDbs(deps, (control, ledger) => Response.json(readManagerView(control, ledger, { view: url.searchParams.get("view") ?? "", cursor: url.searchParams.get("cursor") ?? undefined })));
    } catch (error) {
      if (error instanceof ManagerReadError) return Response.json({ error: "invalid", message: error.message }, { status: 400 });
      throw error;
    }
  }
  return null;
}
