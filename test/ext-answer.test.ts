/**
 * test/ext-answer.test.ts — ATT-3 decision answer round-trip.
 *
 * Story: "I answer a pending ask from the web card and the agent unblocks."
 *
 * Web answers flow through the DB mailbox (answers.db): the extension
 * registers a target via /api/decision/target, the card writes the human
 * answer via POST /api/orchestrator/answer (covered by src/web/server.test.ts),
 * and the extension consumes it via /api/decision/consume/. These tests drive
 * the REAL extension against a mocked control plane and assert the
 * extension-side contract for both the approval gate and the answerable `ask`
 * tool: the answer is consumed exactly once and a single decision_resolved
 * carries the selected answer.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { controlPayloadHash } from "../src/control/outbox";
import { applyControlEvent } from "../src/control/projection";
import { initializeLedger } from "../src/ingest/ingest";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
type EventRecord = { kind: string; detail?: Record<string, unknown> };
type ToolResult = { content: Array<{ type: string; text: string }>; details: Record<string, unknown> };
type RegisteredTool = {
  name: string;
  execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<ToolResult>;
};
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
  const tools = new Map<string, RegisteredTool>();
  const { default: overload } = await import(`../src/extension/overload.ts?answer-test=${++importCounter}`);
  overload({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: RegisteredTool) => {
      tools.set(tool.name, tool);
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
    tools,
    async close(): Promise<EventRecord[]> {
      await Promise.all(dispatch("session_shutdown", { reason: "test_end" }));
      const hostDir = join(home, ".overload", "spool", "local");
      const sealed = (readdirSync(hostDir, { recursive: true }) as string[]).filter((name) => name.includes("seg-"));
      return sealed.flatMap((name) => readFileSync(join(hostDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    },
  };
}

// Every test runs against a fake control plane: an unmocked fetch would reach
// the live dashboard on 127.0.0.1:4870 and register real mailbox targets.
type Call = { url: string; body: Record<string, unknown> };
const realFetch = globalThis.fetch;
let calls: Call[] = [];
let controlPlane: (call: Call) => Response | Promise<Response> = () => new Response(null, { status: 503 });
beforeEach(() => {
  calls = [];
  controlPlane = () => new Response(null, { status: 503 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), body: typeof init?.body === "string" ? JSON.parse(init.body) : {} };
    calls.push(call);
    return controlPlane(call);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const GREEN_BLUE = { questions: [{ question: "Green or Blue?", options: [{ label: "Green" }, { label: "Blue" }] }] };
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });

// A terminal dialog that never answers on its own; it resolves undefined when
// dismissed, matching pi's select() on abort.
function pendingTerminal() {
  const signals: AbortSignal[] = [];
  const wait = (_title: string, _options: unknown, opts?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => {
    if (opts?.signal) signals.push(opts.signal);
    opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
  });
  return { signals, ctx: { hasUI: true, ui: { select: wait, input: wait } } };
}

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

  test("an ask_user tool_call stays an observational Q1 row without a mailbox target", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", { toolName: "ask_user", toolCallId: "att3-ask", input: GREEN_BLUE }));
    const events = await h.close();
    const requested = events.find((e) => e.kind === "decision_requested" && e.detail?.request_id === "att3-ask");
    expect(requested?.detail).toMatchObject({ request_id: "att3-ask", summary: "Green or Blue?", options: ["Green", "Blue"] });
    expect(requested?.detail?.approval_id).toBeUndefined();
    expect(calls.filter((call) => call.url.includes("/api/decision/"))).toEqual([]);
  });

  test("Web answer wins the ask race: consumed once, dialog dismissed, one resolution with the receipt", async () => {
    let consumes = 0;
    controlPlane = ({ url }) => {
      if (url.endsWith("/api/decision/target")) return json({ targetVersion: "v-ask" });
      if (url.includes("/api/decision/consume/")) return ++consumes === 1 ? json({ answer: "Green", actor: "ui", receiptId: "receipt-green" }) : new Response(null, { status: 404 });
      return new Response(null, { status: 404 });
    };
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", { toolName: "ask", toolCallId: "ask-web", input: GREEN_BLUE }));
    const target = calls.find((call) => call.url.endsWith("/api/decision/target"));
    expect(target?.body).toMatchObject({ consumerOwner: "extension", question: "Green or Blue?", options: ["Green", "Blue"], decisionMode: "human_only" });
    const approvalId = String(target?.body.approvalId);
    expect(approvalId.endsWith("#ask-web")).toBe(true);

    const terminal = pendingTerminal();
    const result = await h.tools.get("ask")!.execute("ask-web", GREEN_BLUE, undefined, undefined, terminal.ctx);
    expect(result.content[0]?.text).toBe("User selected: Green");
    expect(result.details).toMatchObject({ source: "overload-web", selected: "Green" });
    expect(terminal.signals.every((signal) => signal.aborted)).toBe(true);
    expect(consumes).toBe(1);
    const consume = calls.find((call) => call.url.includes("/api/decision/consume/"));
    expect(consume?.url.endsWith(`/api/decision/consume/${encodeURIComponent(approvalId)}`)).toBe(true);
    expect(consume?.body).toEqual({ consumer_owner: "extension", target_version: "v-ask" });
    // The consumed target is never cancelled.
    expect(calls.some((call) => call.url.includes("/api/decision/cancel/"))).toBe(false);

    await Promise.all(h.dispatch("tool_result", { toolName: "ask", toolCallId: "ask-web", isError: false, content: result.content }));
    await Promise.all(h.dispatch("tool_execution_end", { toolName: "ask", toolCallId: "ask-web", result, isError: false }));
    const events = await h.close();
    const requested = events.filter((e) => e.kind === "decision_requested" && e.detail?.request_id === "ask-web");
    expect(requested.map((e) => e.detail)).toEqual([expect.objectContaining({ approval_id: approvalId, consumer_owner: "extension", target_version: "v-ask", options: ["Green", "Blue"] })]);
    const resolved = events.filter((e) => e.kind === "decision_resolved" && e.detail?.request_id === "ask-web");
    expect(resolved.map((e) => e.detail)).toEqual([expect.objectContaining({ state: "resolved", selected: "Green", actor: "ui", receipt_id: "receipt-green" })]);
    const effects = events.filter((e) => e.kind === "control_event" && e.detail?.event_kind === "effect_observed");
    expect(effects.map((e) => e.detail?.payload)).toEqual([expect.objectContaining({ receipt_id: "receipt-green", toolCallId: "ask-web", effect: "ask_answer", effect_state: "succeeded" })]);
    // Regression (B07 ingest crash loop): an ask receipt carries no attempt_id; the hash must be over the spooled
    // wire payload, so ingest's recomputation matches and the ledger applies it exactly once.
    const effect = effects[0]!.detail as Record<string, unknown>;
    expect(Object.keys(effect.payload as object)).not.toContain("attempt_id");
    expect(controlPayloadHash(effect.payload as Record<string, unknown>)).toBe(effect.payload_hash as string);
    const ledger = new Database(":memory:");
    initializeLedger(ledger);
    applyControlEvent(ledger, effect, 1);
    applyControlEvent(ledger, JSON.parse(JSON.stringify(effect)), 2);
    expect(ledger.query("SELECT event_id, payload_hash FROM applied_control_events").all()).toEqual([{ event_id: effect.event_id, payload_hash: effect.payload_hash }]);
    ledger.close();
  });

  test("terminal answer wins the ask race: a late Web consume is recorded as undelivered and the target is cancelled", async () => {
    let releaseConsume = () => {};
    const consumeGate = new Promise<void>((resolve) => { releaseConsume = resolve; });
    let consumeRead = () => {};
    const consumeParsed = new Promise<void>((resolve) => { consumeRead = resolve; });
    controlPlane = async ({ url }) => {
      if (url.endsWith("/api/decision/target")) return json({ targetVersion: "v-race" });
      if (url.includes("/api/decision/consume/")) {
        await consumeGate;
        const response = json({ answer: "Green", actor: "ui", receiptId: "receipt-late" });
        const parse = response.json.bind(response);
        response.json = async () => { const body = await parse(); consumeRead(); return body; };
        return response;
      }
      return json({ closed: false });
    };
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", { toolName: "ask", toolCallId: "ask-tui", input: GREEN_BLUE }));
    const ctx = { hasUI: true, ui: { select: async () => "Blue", input: async () => undefined } };
    const result = await h.tools.get("ask")!.execute("ask-tui", GREEN_BLUE, undefined, undefined, ctx);
    expect(result.details).toMatchObject({ source: "terminal", selected: "Blue" });
    const cancel = calls.find((call) => call.url.includes("/api/decision/cancel/"));
    expect(cancel?.body).toEqual({ consumer_owner: "extension", target_version: "v-race" });

    releaseConsume();
    await consumeParsed;
    // The extension's post-parse continuation is a microtask chain; one macrotask turn drains it.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.all(h.dispatch("tool_execution_end", { toolName: "ask", toolCallId: "ask-tui", result, isError: false }));
    const events = await h.close();
    const resolved = events.filter((e) => e.kind === "decision_resolved" && e.detail?.request_id === "ask-tui");
    expect(resolved.map((e) => e.detail)).toEqual([expect.objectContaining({ state: "resolved", selected: "Blue" })]);
    expect(resolved[0]?.detail?.receipt_id).toBeUndefined();
    const effects = events.filter((e) => e.kind === "control_event" && e.detail?.event_kind === "effect_observed");
    expect(effects.map((e) => e.detail?.payload)).toEqual([expect.objectContaining({ receipt_id: "receipt-late", effect_state: "failed", evidence: { reason: "answered_in_terminal_first" } })]);
  });

  test("an ask with no terminal and no reachable control plane fails instead of hanging", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", { toolName: "ask", toolCallId: "ask-headless", input: GREEN_BLUE }));
    await expect(h.tools.get("ask")!.execute("ask-headless", GREEN_BLUE, undefined, undefined, { hasUI: false })).rejects.toThrow("ask needs an interactive terminal");
    const events = await h.close();
    const requested = events.find((e) => e.kind === "decision_requested" && e.detail?.request_id === "ask-headless");
    expect(requested?.detail?.approval_id).toBeUndefined();
  });

  test("multi-select asks are not Web-answerable", async () => {
    controlPlane = ({ url }) => url.endsWith("/api/decision/target") ? json({ targetVersion: "v-multi" }) : new Response(null, { status: 404 });
    const h = await harness({ approval_gate: { enabled: false } });
    const input = { questions: [{ question: "Pick colours", options: [{ label: "Green" }, { label: "Blue" }], multi: true }] };
    await Promise.all(h.dispatch("tool_call", { toolName: "ask", toolCallId: "ask-multi", input }));
    expect(calls.some((call) => call.url.endsWith("/api/decision/target"))).toBe(false);
    const events = await h.close();
    const requested = events.find((e) => e.kind === "decision_requested" && e.detail?.request_id === "ask-multi");
    expect(requested?.detail).toMatchObject({ summary: "Pick colours", options: ["Green", "Blue"] });
    expect(requested?.detail?.approval_id).toBeUndefined();
  });

  // Scripted terminal: each select() answers from `picks` and records what it was shown.
  function scriptedTerminal(picks: Array<string | undefined>, inputs: Array<string | undefined> = []) {
    const shown: Array<{ title: string; options: string[] }> = [];
    let aborted = 0;
    const ctx = {
      hasUI: true,
      abort: () => { aborted++; },
      ui: {
        select: async (title: string, options: string[]) => { shown.push({ title, options }); return picks.shift(); },
        input: async () => inputs.shift(),
      },
    };
    return { ctx, shown, aborted: () => aborted };
  }

  test("multi:true collects several options in the terminal, like omp's built-in ask", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    const input = { questions: [{ id: "colours", header: "Palette", question: "Pick colours", options: [{ label: "Green" }, { label: "Blue" }, { label: "Red" }], multi: true }] };
    await Promise.all(h.dispatch("tool_call", { toolName: "ask", toolCallId: "ask-multi-tui", input }));
    // Toggle Green, toggle Red, untoggle Green, toggle Blue, then finish.
    const terminal = scriptedTerminal(["[ ] Green", "[ ] Red", "[x] Green", "[ ] Blue", "Done selecting"]);
    const result = await h.tools.get("ask")!.execute("ask-multi-tui", input, undefined, undefined, terminal.ctx);
    expect(result.content[0]?.text).toBe("User selected: Blue, Red");
    expect(result.details).toMatchObject({ source: "terminal", multi: true, selectedOptions: ["Blue", "Red"], selected: "Blue, Red" });
    expect(terminal.shown[0]).toEqual({ title: "[Palette] Pick colours", options: ["[ ] Green", "[ ] Blue", "[ ] Red", "Other (type your own)"] });
    expect(terminal.shown[4]).toEqual({ title: "(2 selected) [Palette] Pick colours", options: ["[ ] Green", "[x] Blue", "[x] Red", "Done selecting", "Other (type your own)"] });
    await Promise.all(h.dispatch("tool_execution_end", { toolName: "ask", toolCallId: "ask-multi-tui", result, isError: false }));
    const events = await h.close();
    const resolved = events.filter((e) => e.kind === "decision_resolved" && e.detail?.request_id === "ask-multi-tui");
    expect(resolved.map((e) => e.detail)).toEqual([expect.objectContaining({ state: "resolved", selected: "Blue, Red" })]);
  });

  test("multi:true ask with a reserved label is rejected so the model re-asks", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    const input = { questions: [{ question: "Pick", options: [{ label: "Done selecting" }, { label: "Blue" }], multi: true }] };
    const terminal = scriptedTerminal([]);
    await expect(h.tools.get("ask")!.execute("ask-reserved", input, undefined, undefined, terminal.ctx)).rejects.toThrow("reserved runtime labels");
    expect(terminal.shown).toEqual([]);
    await h.close();
  });

  test("Esc on an options question cancels the ask and the Web target instead of opening free text", async () => {
    controlPlane = ({ url }) => url.endsWith("/api/decision/target") ? json({ targetVersion: "v-esc" }) : url.includes("/api/decision/consume/") ? new Response(null, { status: 404 }) : json({ closed: true });
    const h = await harness({ approval_gate: { enabled: false } });
    const input = { questions: [{ question: "Green or Blue?", options: [{ label: "Green" }, { label: "Blue" }], recommended: 1 }] };
    await Promise.all(h.dispatch("tool_call", { toolName: "ask", toolCallId: "ask-esc", input }));
    let inputs = 0;
    const terminal = scriptedTerminal([undefined]);
    terminal.ctx.ui.input = async () => { inputs++; return "typed"; };
    await expect(h.tools.get("ask")!.execute("ask-esc", input, undefined, undefined, terminal.ctx)).rejects.toThrow("Ask tool was cancelled by the user");
    expect(inputs).toBe(0);
    expect(terminal.aborted()).toBe(1);
    expect(terminal.shown[0]?.options).toEqual(["Green", "Blue (Recommended)", "Other (type your own)"]);
    expect(calls.find((call) => call.url.includes("/api/decision/cancel/"))?.body).toEqual({ consumer_owner: "extension", target_version: "v-esc" });
    await Promise.all(h.dispatch("tool_execution_end", { toolName: "ask", toolCallId: "ask-esc", result: {}, isError: true }));
    const events = await h.close();
    const resolved = events.filter((e) => e.kind === "decision_resolved" && e.detail?.request_id === "ask-esc");
    expect(resolved.map((e) => e.detail)).toEqual([expect.objectContaining({ state: "cancelled" })]);
  });

  test("the recommended option returns its plain label and Other falls through to free text", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    const input = { questions: [{ question: "Green or Blue?", options: [{ label: "Green" }, { label: "Blue" }], recommended: 1 }] };
    const picked = await h.tools.get("ask")!.execute("ask-rec", input, undefined, undefined, scriptedTerminal(["Blue (Recommended)"]).ctx);
    expect(picked.content[0]?.text).toBe("User selected: Blue");
    // Esc inside "Other" returns to the list rather than cancelling.
    const other = await h.tools.get("ask")!.execute("ask-other", input, undefined, undefined, scriptedTerminal(["Other (type your own)", "Other (type your own)"], [undefined, "Teal"]).ctx);
    expect(other.content[0]?.text).toBe("User provided custom input: Teal");
    await h.close();
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
