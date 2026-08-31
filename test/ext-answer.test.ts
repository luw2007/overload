import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-answer-"));
const answers = join(home, "answers");
mock.module("node:os", () => ({ homedir: () => home, tmpdir }));
process.env.OVERLOAD_ANSWERS_DIR = answers;

type Handler = (event: any, ctx: any) => unknown;
const handlers = new Map<string, Handler[]>();
let askTool: any;
const sessionId = "test-session";
const stableId = `local:pi:${sessionId}`;

function dispatch(name: string, event: any, ctx: any = {}): unknown[] {
  return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
}
function answerFile(requestUid: string): string { return join(answers, `${requestUid}.json`); }
function writeAnswer(requestUid: string, option: string | null, text: string | null): void {
  mkdirSync(answers, { recursive: true });
  writeFileSync(answerFile(requestUid), JSON.stringify({ request_uid: requestUid, option, text, answered_at: Date.now() }));
}
const params = { questions: [{ id: "q", question: "Ship?", options: [{ label: "Yes" }, { label: "No" }] }] };

beforeAll(async () => {
  const { default: overload } = await import("../src/extension/overload");
  overload({
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
    registerTool(tool: { name: string }) { if (tool.name === "ask" || tool.name === "ask_user") askTool = tool; },
  } as never);
  await Promise.all(dispatch("session_start", {}, { cwd: home, sessionManager: { getSessionId: () => sessionId } }));
});

afterAll(() => {
  delete process.env.OVERLOAD_ANSWERS_DIR;
  rmSync(home, { recursive: true, force: true });
});

async function runWeb(id: string, option: string | null, text: string | null) {
  dispatch("tool_call", { toolName: "ask", toolCallId: id, input: params });
  // writer suffix is random; recover it from the answer path expected by decision_requested spool is not public.
  // Capture it by finding the poll target through a temporary filesystem scan is impossible before creation,
  // so derive it from the extension event emitted to the spool after it flushes.
  await Bun.sleep(20);
  const spool = join(home, ".overload", "spool", "local");
  const emitter = readdirSync(spool)[0]!;
  const file = readdirSync(join(spool, emitter)).find((name) => name.startsWith("active-"))!;
  const lines = (await Bun.file(join(spool, emitter, file)).text()).trim().split("\n").map(JSON.parse);
  const event = lines.findLast((row: any) => row.kind === "decision_requested" && row.detail?.request_id === id);
  const fullUid = `${stableId}#${event.writer_id}#${id}`;
  const promise = askTool.execute(id, params, undefined, undefined, { ui: { select: () => new Promise(() => {}), input: () => new Promise(() => {}) } });
  writeAnswer(fullUid, option, text);
  return { result: await promise, fullUid };
}

describe("web answers for ask", () => {
  test("an option resolves and consumes the answer file", async () => {
    const { result, fullUid } = await runWeb("option-1", "Yes", null);
    expect(result.details.selectedOptions).toEqual(["Yes"]);
    expect(existsSync(answerFile(fullUid))).toBe(false);
  }, 4000);

  test("free text resolves as custom input", async () => {
    const { result } = await runWeb("text-1", null, "Use the canary");
    expect(result.details.customInput).toBe("Use the canary");
    expect(result.content[0].text).toContain("Use the canary");
  }, 4000);

  test("TUI wins the race and an already-written loser is cleaned", async () => {
    const id = "race-1";
    dispatch("tool_call", { toolName: "ask", toolCallId: id, input: params });
    await Bun.sleep(20);
    const spool = join(home, ".overload", "spool", "local");
    const emitter = readdirSync(spool)[0]!;
    const file = readdirSync(join(spool, emitter)).find((name) => name.startsWith("active-"))!;
    const rows = (await Bun.file(join(spool, emitter, file)).text()).trim().split("\n").map(JSON.parse);
    const event = rows.findLast((row: any) => row.kind === "decision_requested" && row.detail?.request_id === id);
    const fullUid = `${stableId}#${event.writer_id}#${id}`;
    writeAnswer(fullUid, "No", null);
    const result = await askTool.execute(id, params, undefined, undefined, { ui: { select: async () => "Yes", input: async () => undefined } });
    dispatch("tool_execution_end", { toolName: "ask", toolCallId: id, result, isError: false });
    expect(result.details.selectedOptions).toEqual(["Yes"]);
    await Bun.sleep(10);
    expect(existsSync(answerFile(fullUid))).toBe(false);
  });

  test("aborting stops a pending poll promptly", async () => {
    const controller = new AbortController();
    const promise = askTool.execute("abort-1", params, controller.signal, undefined, { ui: { select: () => new Promise(() => {}), input: () => new Promise(() => {}) } });
    controller.abort();
    await expect(promise).rejects.toThrow();
  });
});
