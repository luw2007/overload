/**
 * test/ext-decision-payload.test.ts — decision payload capture (contract:
 * queryQ1 gains `summary`/`options`, sourced from the extension's
 * decision_requested detail for the `ask` tool). Mirrors the real-extension
 * driving pattern from ext-lineage.test.ts.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

// Bun's os.homedir() ignores process.env.HOME (see ext-lineage.test.ts); mock
// node:os so this test never touches the real ~/.overload spool.
const home = mkdtempSync(join(tmpdir(), "overload-ext-decision-payload-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
let events: Array<{ kind: string; detail?: Record<string, unknown> }> = [];

function dispatch(name: string, event: unknown, ctx: unknown = {}): unknown[] {
  return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
}

function eventFor(requestId: string): { kind: string; detail?: Record<string, unknown> } | undefined {
  return events.find((e) => e.kind === "decision_requested" && e.detail?.request_id === requestId);
}

beforeAll(async () => {
  // Dynamic import required: the node:os mock above must be registered before
  // the extension module evaluates; a static import would hoist past it.
  const { default: overload } = await import("../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as never);
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => "99999999-8888-7777-6666-555555555555" },
  }));

  dispatch("tool_call", {
    toolName: "ask",
    toolCallId: "call-structured",
    input: {
      questions: [{
        id: "q1",
        question: "Deploy to prod now? token=SHOULD_BE_REDACTED_ABCDEFGHIJKL",
        options: [{ label: "Yes, ship it" }, { label: "No, wait" }],
      }],
    },
  });
  dispatch("tool_call", {
    toolName: "ask",
    toolCallId: "call-multi",
    input: {
      questions: [
        { id: "q1", question: "Which env?", options: [{ label: "staging" }] },
        { id: "q2", question: "Which branch?", options: [{ label: "main" }] },
      ],
    },
  });
  dispatch("tool_call", {
    toolName: "ask",
    toolCallId: "call-no-options",
    input: { questions: [{ id: "q1", question: "Free-form: what's the target?", options: [] }] },
  });
  dispatch("tool_call", { toolName: "ask", toolCallId: "call-unknown-shape", input: { legacyField: "whatever" } });
  dispatch("tool_call", { toolName: "ask", toolCallId: "call-no-input" });
  dispatch("tool_call", { toolName: "bash", toolCallId: "call-gated", input: { command: "echo hi" } });

  // session_shutdown flushes and seals the segment (EXT-13), making the read
  // deterministic without timers — no assertion runs before this completes.
  await Promise.all(dispatch("session_shutdown", { reason: "test_end" }));
  const hostDir = join(home, ".overload", "spool", "local");
  const sealed = (readdirSync(hostDir, { recursive: true }) as string[]).filter((name) => name.includes("seg-"));
  events = sealed.flatMap((name) =>
    readFileSync(join(hostDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  );
});

afterAll(() => {
  // Sentinel: this test process must never have written to the real spool.
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

describe("ask tool_call decision_requested payload capture", () => {
  test("structured questions carry redacted summary and option labels", () => {
    const requested = eventFor("call-structured");
    expect(requested?.detail?.summary).toBe("Deploy to prod now? token=[REDACTED]");
    expect(requested?.detail?.options).toEqual(["Yes, ship it", "No, wait"]);
  });

  test("multiple questions in one ask join into a single summary and pool options", () => {
    const requested = eventFor("call-multi");
    expect(requested?.detail?.summary).toBe("Which env?; Which branch?");
    expect(requested?.detail?.options).toEqual(["staging", "main"]);
  });

  test("a question without options omits the options field entirely", () => {
    const requested = eventFor("call-no-options");
    expect(requested?.detail?.summary).toBe("Free-form: what's the target?");
    expect(requested?.detail?.options).toBeUndefined();
  });

  test("unrecognized input shape omits summary/options (request_id-only)", () => {
    expect(eventFor("call-unknown-shape")?.detail).toEqual({ request_id: "call-unknown-shape" });
  });

  test("missing input omits summary/options", () => {
    expect(eventFor("call-no-input")?.detail).toEqual({ request_id: "call-no-input" });
  });

  test("non-ask tool_call never produces a decision_requested with summary/options", () => {
    // No approval_gate configured in this test's ~/.overload/config.json, so a
    // plain bash call never emits decision_requested at all.
    expect(eventFor("call-gated")).toBeUndefined();
  });
});

describe("EXT-20 spool seal", () => {
  test("session_shutdown flushed and sealed a session_ended record", () => {
    expect(events.some((e) => e.kind === "session_ended")).toBe(true);
  });
});
