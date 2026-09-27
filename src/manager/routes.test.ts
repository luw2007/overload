import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startWebServer } from "../web/server";
import { createWork, openControl, upsertAttention } from "../control/store";
import { beginManagerTurn } from "./store";
import { DEFAULT_MANAGER_CONFIG, type RunModel } from "./turn";

const roots: string[] = []; const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => { for (const s of servers.splice(0)) s.stop(true); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

function start(runModel?: RunModel, model = "fake/m") {
  const root = mkdtempSync(join(tmpdir(), "overload-manager-web-")); roots.push(root);
  const ledgerPath = join(root, "ledger.db"), controlPath = join(root, "control.db");
  const ledger = new Database(ledgerPath); ledger.exec(readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8")); ledger.close();
  const control = openControl(controlPath);
  const work = createWork(control, { title: "w", source: "test", contract: { objective: "o", acceptance: [{ id: "a", kind: "human", description: "d" }], non_goals: [], scope: { cwd: "." }, budget: {}, stop_conditions: [{ id: "s", kind: "judgment", description: "d" }], decision_owner: "owner" } });
  upsertAttention(control, { item_id: "i1", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now", conclusion: "c", trigger: "t", impact: "i", recommendation: null, options: ["ok"], owner: "owner", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {} });
  control.close();
  writeFileSync(join(root, "host"), "local\n");
  const server = startWebServer({ ledgerPath, controlPath, orchestratorPath: join(root, "orch.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0, manager: { config: { ...DEFAULT_MANAGER_CONFIG, model }, runModel } });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify(body) });
  return { base, post, controlPath };
}
const env = { message: "m", triage: [{ item_id: "i1", kind: "user_gate", order: 1, urgency: "inferred", reason: "r", evidence_refs: [], dependency_status: "not_applicable" }], handoffs: [], protected_action: null, gaps: [] };
const good: RunModel = async () => ({ ok: true, text: "答\n```json\n" + JSON.stringify(env) + "\n```" });

describe("manager HTTP routes", () => {
  test("ask → answered and readable via turns; context and read work", async () => {
    const { base, post } = start(good);
    const res = await post("/api/manager/ask", { question: "先做什么", source: "web" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "answered", source: "web" });
    const turns = await (await fetch(`${base}/api/manager/turns?limit=5`)).json() as { turns: Array<{ status: string }> };
    expect(turns.turns.map((t) => t.status)).toEqual(["answered"]);
    const ctx = await (await fetch(`${base}/api/manager/context`)).json() as { version: string; attention: { now: unknown[] } };
    expect(ctx.version).toBe("manager_turn_context_v1"); expect(ctx.attention.now).toHaveLength(1);
    expect(await (await fetch(`${base}/api/manager/read?view=attention`)).json()).toMatchObject({ view: "attention", total: 1, next_cursor: null });
    expect((await fetch(`${base}/api/manager/read?view=bogus`)).status).toBe(400);
    expect((await fetch(`${base}/manager`)).status).toBe(200);
  });
  test("busy → 409 manager_busy; bad input → 400; cross-origin POST → 403; no model → unavailable", async () => {
    const { post, controlPath, base } = start(good);
    const c = openControl(controlPath); beginManagerTurn(c, { source: "web", question: "hold", model: "m", now: Date.now(), timeoutMs: 90_000 }); c.close();
    const busy = await post("/api/manager/ask", { question: "q" });
    expect(busy.status).toBe(409); expect(await busy.json()).toMatchObject({ error: "manager_busy" });
    expect((await post("/api/manager/ask", { question: 1 })).status).toBe(400);
    expect((await fetch(`${base}/api/manager/ask`, { method: "POST", headers: { origin: "http://evil" }, body: "{}" })).status).toBe(403);
    const other = start(good, "");
    expect(await (await other.post("/api/manager/ask", { question: "q" })).json()).toMatchObject({ status: "unavailable", failure_reason: "manager_model_not_configured" });
  });
});
