import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type DecisionModelResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

type AssistantMessage = {
  role?: unknown;
  content?: unknown;
  stopReason?: unknown;
};

const PRIVATE_ENV_PREFIXES = ["ORCA_", "WAILMER_"];
const PRIVATE_ENV_KEYS = new Set([
  "PI_INTERCOM_SESSION_ID",
  "PI_SESSION_FILE",
  "PI_SESSION_ID",
  "PI_SUBAGENT_PARENT_SESSION",
]);

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      !PRIVATE_ENV_KEYS.has(key) &&
      !PRIVATE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      env[key] = value;
    }
  }
  return env;
}

function assistantText(message: AssistantMessage): string | undefined {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return;
  if (message.stopReason !== "stop") return;

  let text = "";
  for (const part of message.content) {
    if (!part || typeof part !== "object") return;
    const item = part as { type?: unknown; text?: unknown };
    if (item.type === "toolCall") return;
    if (item.type === "text" && typeof item.text === "string") text += item.text;
    else if (item.type !== "thinking") return;
  }
  return text.trim() || undefined;
}

function parseOutput(stdout: string): DecisionModelResult {
  const answers = new Set<string>();
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { type?: unknown; message?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      return { ok: false, reason: "malformed_jsonl" };
    }
    if (!event || typeof event !== "object" || typeof event.type !== "string") {
      return { ok: false, reason: "malformed_jsonl" };
    }
    if (event.type.startsWith("tool_execution_")) {
      return { ok: false, reason: "tool_call_rejected" };
    }
    if (event.type === "message_end") {
      const message = event.message as AssistantMessage | undefined;
      if (
        message?.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) => part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall",
        )
      ) {
        return { ok: false, reason: "tool_call_rejected" };
      }
      const text = message && assistantText(message);
      if (text) answers.add(text);
    }
  }
  if (answers.size === 0) return { ok: false, reason: "missing_final_answer" };
  if (answers.size > 1) return { ok: false, reason: "conflicting_final_answers" };
  return { ok: true, text: answers.values().next().value as string };
}

export async function runDecisionModel(options: {
  model: string;
  prompt: string;
  systemPrompt: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<DecisionModelResult> {
  if (options.timeoutMs <= 0 || options.maxOutputBytes <= 0) {
    return { ok: false, reason: "invalid_limits" };
  }

  const cwd = await mkdtemp(join(tmpdir(), "overload-decision-bot-"));
  const promptPath = join(cwd, "prompt.txt");
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let stopped: "timeout" | "output_overflow" | undefined;

  const kill = () => {
    if (!proc) return;
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL");
      else proc.kill("SIGKILL");
    } catch {
      try { proc.kill("SIGKILL"); } catch {}
    }
  };

  try {
    await writeFile(promptPath, options.prompt, { mode: 0o600 });
    proc = Bun.spawn([
      "pi",
      "--no-tools",
      "--no-extensions",
      "--no-context-files",
      "--no-skills",
      "--no-prompt-templates",
      "--no-session",
      "--print",
      "--mode",
      "json",
      "--model",
      options.model,
      "--system-prompt",
      options.systemPrompt,
      `@${promptPath}`,
    ], {
      cwd,
      env: childEnv(),
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32",
    });

    let total = 0;
    const readBounded = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > options.maxOutputBytes) {
            stopped = "output_overflow";
            kill();
            break;
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return new TextDecoder().decode(bytes);
    };

    const timer = setTimeout(() => {
      stopped = "timeout";
      kill();
    }, options.timeoutMs);
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(proc.stdout),
      readBounded(proc.stderr),
      proc.exited,
    ]).finally(() => clearTimeout(timer));

    if (stopped) return { ok: false, reason: stopped };
    if (exitCode !== 0) {
      const detail = stderr.trim().split("\n", 1)[0];
      return { ok: false, reason: detail ? `pi_exit_${exitCode}: ${detail}` : `pi_exit_${exitCode}` };
    }
    return parseOutput(stdout);
  } catch {
    kill();
    return { ok: false, reason: "runner_failed" };
  } finally {
    kill();
    await rm(cwd, { recursive: true, force: true });
  }
}
