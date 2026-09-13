import { isAbsolute, resolve } from "node:path";

export type SessionRecord = { runtime:"pi"|"omp"|"claude"; sessionUuid:string; cwd:string|null; gitBranch:string|null; startedAt:number|null; endedAt:number|null;
  userMessages: { at:number|null; text:string; lineNo:number }[];
  toolEvents: { at:number|null; tool:string; relation:"read"|"modified"|"created"|"exec"|"other"; path:string|null; lineNo:number; isError:boolean }[];
  parseErrors: { lineNo:number; reason:string }[]; lastLineNo:number };

type Runtime = SessionRecord["runtime"];
type Json = Record<string, any>;
const READ = new Set(["read", "grep", "glob", "ls", "cat"]);
const MODIFY = new Set(["edit", "write", "multiedit", "notebookedit"]);
function at(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") { const parsed = Date.parse(value); return Number.isNaN(parsed) ? null : parsed; }
  return null;
}
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part && typeof part === "object" && (part as Json).type === "text" && typeof (part as Json).text === "string").map((part) => (part as Json).text).join("\n");
}
function relation(tool: string, input: Json): SessionRecord["toolEvents"][number]["relation"] {
  const lower = tool.toLowerCase();
  if (READ.has(lower)) return "read";
  if (MODIFY.has(lower)) return input.create === true || input.mode === "create" ? "created" : "modified";
  if (lower === "bash") return "exec";
  return "other";
}
function pathOf(input: Json, cwd: string | null): string | null {
  for (const key of ["path", "file_path", "notebook_path", "filename"]) {
    if (typeof input[key] === "string" && input[key]) return isAbsolute(input[key]) ? resolve(input[key]) : cwd ? resolve(cwd, input[key]) : input[key];
  }
  return null;
}
function parse(runtime: Runtime, lines: string[]): SessionRecord | null {
  const parsed: { value: Json; lineNo: number }[] = [];
  const parseErrors: SessionRecord["parseErrors"] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try { const value = JSON.parse(line); if (value && typeof value === "object" && !Array.isArray(value)) parsed.push({ value, lineNo: index + 1 }); else parseErrors.push({ lineNo: index + 1, reason: "JSON value is not an object" }); }
    catch (error) { parseErrors.push({ lineNo: index + 1, reason: error instanceof Error ? error.message : "invalid JSON" }); }
  });
  if (!parsed.length) return null;
  const header = runtime === "claude" ? parsed.find(({ value }) => typeof value.sessionId === "string" && typeof value.cwd === "string") : parsed.find(({ value }) => value.type === "session" && typeof value.id === "string" && typeof value.cwd === "string");
  if (!header) return null;
  const sessionUuid = runtime === "claude" ? header.value.sessionId : header.value.id;
  const cwd = header.value.cwd ?? null;
  const branchRecord = parsed.find(({ value }) => typeof value.gitBranch === "string");
  const userMessages: SessionRecord["userMessages"] = [];
  const toolEvents: SessionRecord["toolEvents"] = [];
  const byId = new Map<string, number>();
  let startedAt = at(header.value.timestamp ?? header.value.createdAt);
  let endedAt: number | null = null;
  for (const { value, lineNo } of parsed) {
    const timestamp = at(value.timestamp ?? value.createdAt);
    if (startedAt === null && timestamp !== null) startedAt = timestamp;
    if (["session_end", "session_ended", "session_compacted", "shutdown"].includes(value.type)) endedAt = timestamp;
    const message = value.message && typeof value.message === "object" ? value.message : null;
    const role = message?.role ?? (runtime === "claude" ? value.type : null);
    if (role === "user") {
      const text = textOf(message?.content);
      const onlyResults = Array.isArray(message?.content) && message.content.length > 0 && message.content.every((part: Json) => part?.type === "tool_result");
      if (text && !onlyResults) userMessages.push({ at: timestamp, text: text.slice(0, 2000), lineNo });
    }
    const contents = Array.isArray(message?.content) ? message.content : [];
    for (const item of contents) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "toolCall" || item.type === "tool_use") {
        const tool = typeof item.name === "string" ? item.name : "unknown";
        const input = item.type === "toolCall" ? item.arguments : item.input;
        const args = input && typeof input === "object" && !Array.isArray(input) ? input : {};
        const event = { at: timestamp, tool, relation: relation(tool, args), path: pathOf(args, cwd), lineNo, isError: false } as const;
        const index = toolEvents.push(event) - 1;
        const id = item.id ?? item.toolCallId ?? item.tool_call_id;
        if (typeof id === "string") byId.set(id, index);
      } else if (item.type === "tool_result" || role === "toolResult") {
        const id = item.tool_use_id ?? item.toolCallId ?? item.tool_call_id ?? message?.toolCallId;
        const index = typeof id === "string" ? byId.get(id) : undefined;
        if (index !== undefined && (item.is_error === true || message?.isError === true)) toolEvents[index]!.isError = true;
      }
    }
  }
  return { runtime, sessionUuid, cwd, gitBranch: branchRecord?.value.gitBranch ?? null, startedAt, endedAt, userMessages, toolEvents, parseErrors, lastLineNo: lines.length };
}
export function parsePiSession(lines: string[]): SessionRecord|null { return parse("pi", lines); }
export function parseOmpSession(lines: string[]): SessionRecord|null { return parse("omp", lines); }
export function parseClaudeSession(lines: string[]): SessionRecord|null { return parse("claude", lines); }
export function detectRuntimeFromPath(path: string): Runtime|null {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.includes("/.pi/agent/sessions/")) return "pi";
  if (normalized.includes("/.omp/agent/sessions/")) return "omp";
  if (normalized.includes("/.claude/projects/")) return "claude";
  return null;
}
export function sessionDirs(runtime: Runtime, home: string): string[] {
  return [resolve(home, runtime === "pi" ? ".pi/agent/sessions" : runtime === "omp" ? ".omp/agent/sessions" : ".claude/projects")];
}
