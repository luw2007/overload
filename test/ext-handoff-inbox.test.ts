/**
 * Context handoff receiver in the extension (manager-chat spec §3 extension, §5 B).
 * A hanging or failing control plane must never delay or break the turn.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
type Tool = { name: string; execute: (id: string, params: unknown) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> };
let importCounter = 0;
const homes: string[] = [];
const realFetch = globalThis.fetch;
let calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
let controlPlane: (url: string, init?: RequestInit) => Promise<Response> = async () => new Response(null, { status: 503 });

beforeEach(() => {
  calls = [];
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : {} });
    return controlPlane(String(input), init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

async function harness() {
  const home = mkdtempSync(join(tmpdir(), "overload-ext-handoff-inbox-"));
  homes.push(home); currentHome = home;
  mkdirSync(join(home, ".overload"), { recursive: true });
  writeFileSync(join(home, ".overload", "config.json"), "{}");
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const { default: overload } = await import(`../src/extension/overload.ts?handoff-inbox=${++importCounter}`);
  overload({ on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]), registerTool: (tool: Tool) => tools.set(tool.name, tool) } as never);
  const dispatch = (name: string, event: unknown = {}, ctx: unknown = {}) => Promise.all((handlers.get(name) ?? []).map((h) => h(event, ctx)));
  await dispatch("session_start", { reason: "startup" }, { cwd: home, sessionManager: { getSessionId: () => `handoff-${importCounter}` } });
  return { dispatch, tools, close: () => dispatch("session_shutdown", { reason: "test_end" }) };
}

const pendingItem = { request_id: "r1", state: "pending", brief: { version: "collaboration_brief_v0", purpose: "Adopt retry policy", context: "", constraints: ["no schema change"], inputs: [], acceptance: [], return_requirement: "report" } };
const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

describe("extension handoff receiver", () => {
  test("hanging /api/handoff/pending does not hold before_agent_start or turn_start past the timeout", async () => {
    controlPlane = () => new Promise<Response>(() => {}); // never resolves, ignores abort
    const h = await harness();
    const started = Date.now();
    const results = await h.dispatch("before_agent_start");
    await h.dispatch("turn_start");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(results.filter(Boolean)).toEqual([]);
    expect(calls.some((c) => c.url.includes("/api/handoff/pending?target_kind=session&target_id="))).toBe(true);
    await h.close();
  });

  test("failing control plane is silent", async () => {
    controlPlane = async () => { throw new Error("ECONNREFUSED"); };
    const h = await harness();
    expect((await h.dispatch("before_agent_start")).filter(Boolean)).toEqual([]);
    await h.close();
  });

  test("pending briefs are injected once and marked read; ack/conclude tools call the routes", async () => {
    controlPlane = async (url) => url.includes("/pending") ? ok({ items: [pendingItem] }) : ok({ request_id: "r1", state: "concluded" });
    const h = await harness();
    const [message] = (await h.dispatch("before_agent_start")).filter(Boolean) as Array<{ message: { customType: string; content: string } }>;
    expect(message!.message.customType).toBe("overload_handoff");
    expect(message!.message.content).toContain("NOT a priority change");
    expect(message!.message.content).toContain("Adopt retry policy");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/api/handoff/r1/read"))).toBe(true);
    expect((await h.dispatch("before_agent_start")).filter(Boolean)).toEqual([]);
    expect([...h.tools.keys()]).toEqual(expect.arrayContaining(["handoff_inbox", "handoff_ack", "handoff_conclude"]));
    await h.tools.get("handoff_ack")!.execute("t1", { request_id: "r1", decision: "adopt", reason: "fits" });
    expect(calls.at(-1)).toMatchObject({ method: "POST", body: { decision: "adopt", reason: "fits" } });
    expect(calls.at(-1)!.url).toEndWith("/api/handoff/r1/ack");
    const concluded = await h.tools.get("handoff_conclude")!.execute("t2", { request_id: "r1", kind: "conclusion", text: "done" });
    expect(concluded.details.ok).toBe(true);
    controlPlane = async () => new Response(JSON.stringify({ error: "conflict", message: "handoff already concluded" }), { status: 409 });
    const again = await h.tools.get("handoff_conclude")!.execute("t3", { request_id: "r1", kind: "conclusion", text: "again" });
    expect(again.details.ok).toBe(false);
    expect(again.content[0]!.text).toContain("already concluded");
    await h.close();
  });
});
