/**
 * Verifier: the extension's handoff receiver against the REAL web server
 * (manager-chat spec §3 extension, §5 B). No fetch mocking: this proves the
 * extension's headers pass checkOrigin and the Sec-Fetch guard, and that the
 * full receiver loop (inject -> read -> ack defer -> ack adopt -> conclude ->
 * return queued, second conclude rejected) works end to end.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
let importCounter = 0;
const roots: string[] = [];
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const brief = { version: "collaboration_brief_v0", purpose: "Adopt retry policy v2", context: "Owner rejected option B", constraints: ["no schema change"], inputs: ["docs/x.md"], acceptance: ["tests green"], return_requirement: "Report adopt/reject with reason" };

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "overload-ext-handoff-live-")); roots.push(root);
  writeFileSync(join(root, "host"), "local\n");
  const ledger = new Database(join(root, "ledger.db")); ledger.exec(await Bun.file(new URL("../src/ingest/schema.sql", import.meta.url)).text()); ledger.close();
  const { startWebServer } = await import("../src/web/server");
  const server = startWebServer({ ledgerPath: join(root, "ledger.db"), controlPath: join(root, "c.db"), orchestratorPath: join(root, "o.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const home = join(root, "home"); currentHome = home;
  mkdirSync(join(home, ".overload"), { recursive: true });
  writeFileSync(join(home, ".overload", "config.json"), JSON.stringify({ web_port: server.port }));
  const seen: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => { seen.push(`${init?.method ?? "GET"} ${String(input)}`); return realFetch(input, init); }) as typeof fetch;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const { default: overload } = await import(`../src/extension/overload.ts?handoff-live=${++importCounter}`);
  overload({ on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]), registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
  const dispatch = (name: string, event: unknown = {}, ctx: unknown = {}) => Promise.all((handlers.get(name) ?? []).map((h) => h(event, ctx)));
  await dispatch("session_start", { reason: "startup" }, { cwd: home, sessionManager: { getSessionId: () => `live-${importCounter}` } });
  // Learn this session's stable id from the extension's own pending poll.
  await dispatch("before_agent_start");
  const poll = seen.find((line) => line.includes("/api/handoff/pending?"));
  const stableId = new URL(poll!.split(" ")[1]!).searchParams.get("target_id")!;
  const create = (sourceId: string, b = brief) => realFetch(`${base}/api/handoff`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ source_kind: "manager_turn", source_id: sourceId, target_kind: "session", target_id: stableId, brief: b, original_message: "forward this" }) });
  const get = async (path: string) => (await realFetch(base + path)).json() as Promise<any>;
  return { server, base, dispatch, tools, stableId, create, get, seen, close: async () => { await dispatch("session_shutdown", { reason: "test_end" }); server.stop(true); } };
}

async function until(check: () => Promise<boolean>, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return true; await Bun.sleep(20); }
  return false;
}

describe("extension handoff receiver against the real control plane", () => {
  test("full receiver loop through real routes", async () => {
    const h = await setup();
    try {
      expect(h.stableId).toMatch(/:live-\d+$/);
      const created = await h.create("turn-live");
      expect(created.status).toBe(201);
      const { request_id } = await created.json() as { request_id: string };

      const results = (await h.dispatch("before_agent_start")).filter(Boolean) as Array<{ message: { customType: string; content: string; details: { request_ids: string[] } } }>;
      expect(results).toHaveLength(1);
      expect(results[0]!.message.details.request_ids).toEqual([request_id]);
      expect(results[0]!.message.content).toContain("Adopt retry policy v2");
      expect(results[0]!.message.content).toContain("no schema change");
      expect(results[0]!.message.content).toContain(request_id);
      // read is fire-and-forget: wait for it to land on the real server.
      expect(await until(async () => (await h.get(`/api/handoff?state=read`)).items.length === 1)).toBe(true);
      // Not re-injected on the next prompt.
      expect((await h.dispatch("before_agent_start")).filter(Boolean)).toEqual([]);

      const inbox = await h.tools.get("handoff_inbox")!.execute("t0", {});
      expect(inbox.content[0]!.text).toContain(request_id);

      const deferred = await h.tools.get("handoff_ack")!.execute("t1", { request_id, decision: "defer", reason: "finishing current task" });
      expect(deferred.details.ok).toBe(true);
      expect((await h.get(`/api/handoff/pending?target_kind=session&target_id=${encodeURIComponent(h.stableId)}`)).items).toHaveLength(1);
      const adopted = await h.tools.get("handoff_ack")!.execute("t2", { request_id, decision: "adopt", reason: "now free" });
      expect(adopted.details.ok).toBe(true);
      expect((await h.get(`/api/handoff/pending?target_kind=session&target_id=${encodeURIComponent(h.stableId)}`)).items).toHaveLength(0);
      const badAck = await h.tools.get("handoff_ack")!.execute("t3", { request_id, decision: "reject", reason: "changed my mind" });
      expect(badAck.details.ok).toBe(false);

      const concluded = await h.tools.get("handoff_conclude")!.execute("t4", { request_id, kind: "conclusion", text: "Adopted; retries capped at 3" });
      expect(concluded.details.ok).toBe(true);
      const again = await h.tools.get("handoff_conclude")!.execute("t5", { request_id, kind: "decision", text: "overwrite" });
      expect(again.details.ok).toBe(false);
      expect(again.content[0]!.text).toContain("already concluded");

      const returns = await h.get(`/api/handoff/returns?destination_kind=manager_conversation&destination_id=owner`);
      expect(returns.items).toHaveLength(1);
      expect(returns.items[0]).toMatchObject({ request_id, state: "queued", request: { conclusion_text: "Adopted; retries capped at 3", state: "concluded" } });

      const unknown = await h.tools.get("handoff_conclude")!.execute("t6", { request_id: "nope", kind: "decision", text: "x" });
      expect(unknown.details.ok).toBe(false);
      expect(unknown.content[0]!.text).toContain("not found");
    } finally { await h.close(); }
  });

  test("handoffs for other sessions are never injected", async () => {
    const h = await setup();
    try {
      const other = await realFetch(`${h.base}/api/handoff`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ source_kind: "manager_turn", source_id: "t-other", target_kind: "session", target_id: "local:pi:someone-else", brief }) });
      expect(other.status).toBe(201);
      expect((await h.dispatch("before_agent_start")).filter(Boolean)).toEqual([]);
      expect((await h.get(`/api/handoff?state=pending`)).items).toHaveLength(1);
    } finally { await h.close(); }
  });
});
