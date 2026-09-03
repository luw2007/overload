import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
type EventRecord = { kind: string; detail?: Record<string, unknown> };
let importCounter = 0;
const homes: string[] = [];

async function harness(config: unknown) {
  const home = mkdtempSync(join(tmpdir(), "overload-ext-approval-"));
  homes.push(home);
  currentHome = home;
  mkdirSync(join(home, ".overload"), { recursive: true });
  writeFileSync(join(home, ".overload", "config.json"), JSON.stringify(config));
  const handlers = new Map<string, Handler[]>();
  const { default: overload } = await import(`../src/extension/overload.ts?approval-test=${++importCounter}`);
  overload({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as never);
  const dispatch = (name: string, event: unknown, ctx: unknown = {}) =>
    (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => `approval-session-${importCounter}` },
  }));
  return {
    home,
    dispatch,
    async close(): Promise<EventRecord[]> {
      await Promise.all(dispatch("session_shutdown", { reason: "test_end" }));
      const hostDir = join(home, ".overload", "spool", "local");
      const sealed = (readdirSync(hostDir, { recursive: true }) as string[]).filter((name) => name.includes("seg-"));
      return sealed.flatMap((name) => readFileSync(join(hostDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("approval gate", () => {
  test("invalid enabled config fails closed and emits a cancelled pair", async () => {
    const h = await harness({ approval_gate: { enabled: true, block_bash_patterns: "not-an-array" } });
    const event = { toolName: "bash", toolCallId: "invalid-call", input: { command: "echo hi" } };
    const result = await Promise.all(h.dispatch("tool_call", event));
    expect(result[0]).toEqual({ block: true, reason: "overload approval gate misconfigured: block_bash_patterns must be an array of strings" });
    const events = await h.close();
    expect(events.filter((item) => item.kind === "decision_requested").map((item) => item.detail)).toEqual([{
      request_id: "invalid-call", gated: true, rule: "misconfigured", tool: "bash",
    }]);
    expect(events.filter((item) => item.kind === "decision_resolved").map((item) => item.detail)).toEqual([{
      request_id: "invalid-call", gated: true, rule: "misconfigured", tool: "bash", state: "cancelled",
    }]);
  });

  test("require approval resolves approve and consumes mailbox", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(init?.method === "DELETE" ? "" : JSON.stringify({ answer: "approve", actor: "ui" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const h = await harness({ web_port: 4901, approval_gate: { enabled: true, require_approval_bash_patterns: ["^echo"] } });
      const result = await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "approve-call", input: { command: "echo hi" } }));
      expect(result[0]).toBeUndefined();
      const events = await h.close();
      expect(events.find((item) => item.kind === "decision_requested")?.detail).toMatchObject({ request_id: "approve-call", gated: true, gate: "action", rule: "^echo", tool: "bash", command: "echo hi", summary: "放行 bash: echo hi?", options: ["approve", "deny"] });
      expect(events.find((item) => item.kind === "decision_resolved")?.detail).toMatchObject({ request_id: "approve-call", gated: true, state: "resolved", selected: "approve", actor: "ui" });
      expect(calls.some((call) => call.init?.method === "DELETE" && call.init.headers && new Headers(call.init.headers).get("Origin") === "http://127.0.0.1:4901")).toBe(true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("deny answer blocks tool", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ answer: "deny", actor: "ui" }), { status: 200 })) as typeof fetch;
    try {
      const h = await harness({ approval_gate: { enabled: true, require_approval_bash_patterns: ["^echo"] } });
      expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "deny-call", input: { command: "echo hi" } })))[0]).toEqual({ block: true, reason: "overload approval gate: denied by ui" });
      await h.close();
    } finally { globalThis.fetch = oldFetch; }
  });

  test("missing answer times out and blocks", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    try {
      const h = await harness({ approval_gate: { enabled: true, timeout_ms: 50, require_approval_bash_patterns: ["^echo"] } });
      expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "timeout-call", input: { command: "echo hi" } })))[0]).toEqual({ block: true, reason: "overload approval gate: timed out" });
      const events = await h.close();
      expect(events.find((item) => item.kind === "decision_resolved")?.detail).toMatchObject({ request_id: "timeout-call", gated: true, state: "timed_out" });
    } finally { globalThis.fetch = oldFetch; }
  });

  test("block rules win over require rules", async () => {
    const h = await harness({ approval_gate: { enabled: true, block_bash_patterns: ["^echo"], require_approval_bash_patterns: ["^echo"] } });
    expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "both-call", input: { command: "echo hi" } })))[0]).toEqual({ block: true, reason: "overload approval gate: ^echo" });
    await h.close();
  });

  test("git push emits consequential tool activity", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "push-call", input: { command: "git push origin main" } }));
    const events = await h.close();
    expect(events.some((item) => item.kind === "tool_activity" && item.detail?.consequential === true && item.detail?.class === "push")).toBe(true);
  });
});
