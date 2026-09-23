/**
 * test/ext-answer.test.ts — ATT-3 decision answer round-trip.
 *
 * Story: "I answer a pending ask from the web card and the agent unblocks."
 *
 * The story's original verify_method described a ~/.overload/answers/<uid>.json
 * file poll; that mechanism has since been superseded by the DB mailbox
 * (answers.db) plus /api/decision/target + /api/decision/consume/. The web
 * HTTP layer is covered by src/web/server.test.ts (POST /api/orchestrator/answer).
 * This test drives the REAL extension against a mocked control plane and
 * asserts the extension-side contract: a blocked tool registers a target, the
 * web answer is consumed exactly once, the tool unblocks, and a single
 * decision_resolved carries the selected answer.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
type EventRecord = { kind: string; detail?: Record<string, unknown> };
let importCounter = 0;
const homes: string[] = [];

async function harness(config: unknown) {
  const home = mkdtempSync(join(tmpdir(), "overload-ext-answer-"));
  homes.push(home);
  currentHome = home;
  mkdirSync(join(home, ".overload"), { recursive: true });
  // config.json lives at ~/.overload/config.json; write it before the extension
  // evaluates loadApprovalGate() during session_start.
  writeFileSync(join(home, ".overload", "config.json"), JSON.stringify(config));
  const handlers = new Map<string, Handler[]>();
  const { default: overload } = await import(`../src/extension/overload.ts?answer-test=${++importCounter}`);
  overload({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as never);
  const dispatch = (name: string, event: unknown, ctx: unknown = {}) =>
    (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => `answer-session-${importCounter}` },
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

describe("ATT-3 answer round-trip", () => {
  test("web answer consumes the target once, unblocks the tool, and resolves once", async () => {
    const oldFetch = globalThis.fetch;
    let consumeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/decision/target")) {
        return new Response(JSON.stringify({ targetVersion: "v-1" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/api/decision/consume/")) {
        consumeCalls++;
        // First consume returns the web answer; subsequent polls see it gone.
        if (consumeCalls === 1) {
          return new Response(JSON.stringify({ answer: "approve", actor: "ui", receiptId: "receipt-att3" }), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      // approval_gate.require_approval_bash_patterns forces a web-card decision
      // for `git push`; this is the implemented "answer from the web card" path.
      const h = await harness({ approval_gate: { enabled: true, require_approval_bash_patterns: ["^git push"], timeout_ms: 5_000 } });
      const result = await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "att3-call", input: { command: "git push origin main" } }));
      // Approve unblocks the tool: the extension returns no block decision.
      expect(result[0]).toBeUndefined();
      expect(consumeCalls).toBe(1);
      const events = await h.close();
      const requested = events.find((e) => e.kind === "decision_requested" && e.detail?.request_id === "att3-call");
      const resolved = events.filter((e) => e.kind === "decision_resolved" && e.detail?.request_id === "att3-call");
      expect(requested?.detail).toMatchObject({ request_id: "att3-call", gated: true, rule: "^git push" });
      expect(resolved[0]?.detail).toMatchObject({ request_id: "att3-call", gated: true, state: "resolved", selected: "approve", actor: "ui", receipt_id: "receipt-att3" });
      // Resolved exactly once — the answer is consumed, not re-polled.
      expect(resolved.length).toBe(1);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("a plain ask tool_call surfaces a decision_requested (observational Q1 row)", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", {
      toolName: "ask",
      toolCallId: "att3-ask",
      input: { questions: [{ question: "Deploy?", options: [{ label: "yes" }, { label: "no" }] }] },
    }));
    const events = await h.close();
    const requested = events.find((e) => e.kind === "decision_requested" && e.detail?.request_id === "att3-ask");
    expect(requested?.detail).toMatchObject({ request_id: "att3-ask", summary: "Deploy?", options: ["yes", "no"] });
  });

  test("ask resolution via tool_execution_end emits a single decision_resolved", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", { toolName: "ask", toolCallId: "att3-resolve", input: {} }));
    await Promise.all(h.dispatch("tool_execution_end", { toolName: "ask", toolCallId: "att3-resolve", result: { selected: "yes" }, isError: false }));
    // A second end event must not double-emit resolution.
    await Promise.all(h.dispatch("tool_execution_end", { toolName: "ask", toolCallId: "att3-resolve", result: {}, isError: false }));
    const events = await h.close();
    const resolved = events.filter((e) => e.kind === "decision_resolved" && e.detail?.request_id === "att3-resolve");
    expect(resolved.length).toBe(1);
    expect(resolved[0]?.detail).toMatchObject({ request_id: "att3-resolve", state: "resolved", selected: "yes" });
  });
});
