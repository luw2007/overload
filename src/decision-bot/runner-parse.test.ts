import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDecisionModel } from "./runner";

const roots: string[] = [];
const originalPath = process.env.PATH;
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  process.env.PATH = originalPath;
});

/**
 * Creates a fake `pi` executable in a tmp bin directory that emits the JSONL
 * lines specified by OVERLOAD_FAKE_PI_OUTPUT (newline-separated). Prepends
 * that bin to PATH so runDecisionModel's `Bun.spawn(["pi", ...])` resolves to
 * the fake.
 */
function fakePiBin(output: string): string {
  const binDir = mkdtempSync(join(tmpdir(), "overload-fake-pi-"));
  roots.push(binDir);
  const script = join(binDir, "pi");
  // shell script: emit the configured JSONL lines to stdout
  writeFileSync(script, "#!/bin/sh\ncat <<'OVERLOAD_FAKE_EOF'\n" + output + "\nOVERLOAD_FAKE_EOF\n");
  chmodSync(script, 0o755);
  process.env.PATH = binDir + ":" + process.env.PATH;
  return binDir;
}

const baseOpts = {
  model: "test-model",
  prompt: "decide",
  systemPrompt: "be helpful",
  timeoutMs: 5_000,
  maxOutputBytes: 65_536,
};

describe("DBT-26 runDecisionModel parseOutput", () => {
  test("timeoutMs <= 0 returns invalid_limits without spawning pi", async () => {
    const result = await runDecisionModel({ ...baseOpts, timeoutMs: 0 });
    expect(result).toEqual({ ok: false, reason: "invalid_limits" });
  });

  test("maxOutputBytes <= 0 returns invalid_limits without spawning pi", async () => {
    const result = await runDecisionModel({ ...baseOpts, maxOutputBytes: -1 });
    expect(result).toEqual({ ok: false, reason: "invalid_limits" });
  });

  test("tool_execution_* event returns tool_call_rejected", async () => {
    fakePiBin(JSON.stringify({ type: "tool_execution_start", toolCallId: "call_1" }));
    const result = await runDecisionModel(baseOpts);
    expect(result).toEqual({ ok: false, reason: "tool_call_rejected" });
  });

  test("message_end with toolCall in content returns tool_call_rejected", async () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "toolCall", toolCallId: "call_1" }],
      },
    });
    fakePiBin(line);
    const result = await runDecisionModel(baseOpts);
    expect(result).toEqual({ ok: false, reason: "tool_call_rejected" });
  });

  test("two message_end with different text returns conflicting_final_answers", async () => {
    const a = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "approve" }],
      },
    });
    const b = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "deny" }],
      },
    });
    fakePiBin(a + "\n" + b);
    const result = await runDecisionModel(baseOpts);
    expect(result).toEqual({ ok: false, reason: "conflicting_final_answers" });
  });

  test("single clean message_end returns ok with the text", async () => {
    const line = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "text", text: "approve" }],
      },
    });
    fakePiBin(line);
    const result = await runDecisionModel(baseOpts);
    expect(result).toEqual({ ok: true, text: "approve" });
  });

  test("malformed JSONL returns malformed_jsonl", async () => {
    fakePiBin("not json at all");
    const result = await runDecisionModel(baseOpts);
    expect(result).toEqual({ ok: false, reason: "malformed_jsonl" });
  });

  test("no message_end returns missing_final_answer", async () => {
    fakePiBin(JSON.stringify({ type: "message_start", message: { role: "assistant" } }));
    const result = await runDecisionModel(baseOpts);
    expect(result).toEqual({ ok: false, reason: "missing_final_answer" });
  });
});
