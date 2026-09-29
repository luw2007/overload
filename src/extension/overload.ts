// @overload-event-source
// Approval gate is disabled by default. Enabled invalid configuration fails closed
// for bash/write/edit calls while still warning once during session startup.
// Intentionally has no package imports: pi, omp, and prime-agent expose compatible
// extension APIs under different package names.
import { constants, readFileSync, statSync } from "node:fs"
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { execFile, execFileSync } from "node:child_process"

const SEGMENT_MAX_AGE_MS = 30_000
const SEGMENT_MAX_BYTES = 1_048_576
const HEARTBEAT_INTERVAL_MS = 60_000
const TOOL_ACTIVITY_INTERVAL_MS = 5_000
const WRITE_QUEUE_LIMIT = 1000
const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60_000
const DEFAULT_WEB_PORT = 4870
const APPROVAL_POLL_INTERVAL_MS = 2_000
// The terminal dialog waits indefinitely, so the Web target outlives any
// realistic ask; expiry only bounds an abandoned mailbox row.
const ASK_TARGET_TTL_MS = 24 * 60 * 60_000
const procBootId = randomUUID()

type Runtime = "pi" | "omp" | "prime"
type Kind =
  | "session_started" | "working" | "settled" | "decision_requested"
  | "decision_resolved" | "control_event" | "tool_activity" | "heartbeat"
  | "commit_observed" | "session_ended"

type Envelope = {
  v: 1
  at: number
  host: string
  runtime: Runtime
  session: string
  emitter_id: string
  writer_id: string
  seq: number
  kind: Kind
  dropped_total: number
  write_error_total: number
  detail?: Record<string, unknown>
}

type ExtensionApi = {
  on: (event: string, handler: (event: any, ctx: any) => unknown) => void
  registerTool?: (tool: Record<string, unknown>) => void
  exec?: (command: string, args: string[], options?: Record<string, unknown>) => Promise<{ stdout?: string; code?: number }>
}

type AskQuestion = { id?: string; question?: string; header?: string; options?: Array<string | { label?: string }>; multi?: boolean; recommended?: number }
type AskTarget = { approvalId: string; targetVersion: string; expiresAt: number }
type AskAnswer = { id: string; question: string; options: string[]; multi: boolean; selectedOptions: string[]; customInput?: string }

// Plan §4.5 client half. A 409 from the consume route is terminal for this entry: another
// entry already holds the decision, so the poll refreshes current state and stops instead of
// retrying the answer until the target expires.
type ConsumeConflict = {
  code: string
  current_target_version: string | null
  current_target_state: string | null
  current_state: string | null
  current_effect_state: string | null
  current_revision: number | null
  receipt_id: string | null
  decision_package_url: string | null
}
async function consumeConflict(response: { status: number; json: () => Promise<unknown> }): Promise<ConsumeConflict | undefined> {
  if (response.status !== 409) return undefined
  let body: unknown
  try { body = await response.json() } catch { body = null }
  const row = body && typeof body === "object" ? body as Record<string, unknown> : {}
  const text = (key: string): string | null => typeof row[key] === "string" ? row[key] : null
  return {
    code: text("code") ?? "conflict",
    current_target_version: text("current_target_version"),
    current_target_state: text("current_target_state"),
    current_state: text("current_state"),
    current_effect_state: text("current_effect_state"),
    current_revision: typeof row.current_revision === "number" ? row.current_revision : null,
    receipt_id: text("receipt_id"),
    decision_package_url: text("decision_package_url"),
  }
}

// Reserved dialog rows, spelled as omp's built-in ask spells them.
const ASK_OTHER_OPTION = "Other (type your own)"
const ASK_DONE_OPTION = "Done selecting"
const ASK_RECOMMENDED_SUFFIX = " (Recommended)"
const ASK_CANCELLED = "Ask tool was cancelled by the user"
type AskToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }

const ASK_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          header: { type: "string" },
          options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] } },
          multi: { type: "boolean" },
          recommended: { type: "number" },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
}

type GateRule = { kind: "block" | "require"; rule: string }

type ApprovalGate = {
  bash: Array<{ source: string; pattern: RegExp }>
  requireBash: Array<{ source: string; pattern: RegExp }>
  writePaths: string[]
  requireWritePaths: string[]
  timeoutMs: number
  webPort: number
  misconfigured?: string
}

function processName(value: unknown): string {
  return String(value || "").split(/[\\/]/).pop()?.toLowerCase() || ""
}

function detectRuntime(): Runtime {
  const hints = [process.title, process.env._, process.argv[0], process.argv[1]].map(processName)
  if (hints.some((v) => v === "omp" || v.startsWith("omp."))) return "omp"
  if (hints.some((v) => v === "prime-agent" || v.startsWith("prime-agent."))) return "prime"
  return "pi"
}

function safeComponent(value: unknown, fallback: string): string {
  const clean = String(value || "").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 180)
  return clean || fallback
}

// Installed as a single copied file (scripts/install-extension.sh), so it cannot
// import ../shared/types; this mirrors src/shared/types.ts parseHostId.
function parseHostId(value: string): string {
  const host = value.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(host)) throw new Error(`invalid host id: ${value}`)
  return host
}

function textFrom(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  const content = (value as { content?: unknown }).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part) => part && typeof part === "object" && (part as any).type === "text")
    .map((part) => String((part as any).text || ""))
    .join("")
}

// Installed as a single copied file (scripts/install-extension.sh), so it cannot
// import ../shared/redact; these patterns mirror src/shared/redact.ts scrubText.
function scrub(text: string): string {
  return text
    .replace(/\b(?:sk|pk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/gi, "[REDACTED]")
    .replace(/\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(authorization|api[_-]?key|token|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
}

function truncateUtf8(value: unknown, limit = 500): string {
  const source = scrub(typeof value === "string" ? value : String(value ?? ""))
  let bytes = 0
  let result = ""
  for (const char of source) {
    const width = Buffer.byteLength(char, "utf8")
    if (bytes + width > limit) break
    bytes += width
    result += char
  }
  return result
}

function selectedOption(result: unknown, depth = 0): string | undefined {
  if (typeof result === "string") return truncateUtf8(result)
  if (!result || typeof result !== "object" || depth > 3) return undefined
  const record = result as Record<string, unknown>
  for (const key of ["selected", "selection", "selectedOption", "answer", "value", "label"]) {
    if (typeof record[key] === "string") return truncateUtf8(record[key])
  }
  for (const key of ["answers", "result", "details", "data"]) {
    const nested = record[key]
    if (Array.isArray(nested)) {
      const values = nested.map((value) => selectedOption(value, depth + 1)).filter(Boolean)
      if (values.length) return truncateUtf8(values.join(", "))
    } else {
      const value = selectedOption(nested, depth + 1)
      if (value) return value
    }
  }
  const visible = textFrom(record)
  return visible ? truncateUtf8(visible) : undefined
}

// AskToolInput (@oh-my-pi/pi-coding-agent tools/ask.d.ts) is always
// { questions: [{ question, options: [{ label }] }] }; unrecognized/legacy
// shapes yield {}, never throw, and simply omit the fields (decision_requested
// stays request_id-only).
function questionPayload(input: unknown): { summary?: string; options?: string[] } {
  if (!input || typeof input !== "object" || !("questions" in input) || !Array.isArray(input.questions)) return {}
  const texts: string[] = []
  const options: string[] = []
  for (const entry of input.questions) {
    if (!entry || typeof entry !== "object") continue
    if ("question" in entry && typeof entry.question === "string" && entry.question) texts.push(entry.question)
    if (!("options" in entry) || !Array.isArray(entry.options)) continue
    for (const option of entry.options) {
      if (!option || typeof option !== "object" || !("label" in option)) continue
      if (typeof option.label === "string" && option.label) options.push(truncateUtf8(option.label, 120))
    }
  }
  return { ...(texts.length ? { summary: truncateUtf8(texts.join("; "), 500) } : {}), ...(options.length ? { options } : {}) }
}

function askLabels(question: AskQuestion): string[] {
  return (question.options || []).map((option) => option && typeof option === "object" && typeof option.label === "string" ? option.label : "").filter(Boolean)
}

// Web-answerable asks are one single-choice question whose labels reach the
// card verbatim (questionPayload truncates and scrubs labels): the option the
// card posts back must be exactly a label the agent asked for. Every other
// shape stays terminal-only and its card keeps inert option chips.
function webAskQuestion(input: unknown): AskQuestion | undefined {
  if (!input || typeof input !== "object" || !("questions" in input) || !Array.isArray(input.questions) || input.questions.length !== 1) return undefined
  const question: unknown = input.questions[0]
  if (!question || typeof question !== "object" || ("multi" in question && question.multi === true)) return undefined
  const labels = askLabels(question as AskQuestion)
  if (!labels.length || new Set(labels).size !== labels.length || labels.some((label) => truncateUtf8(label, 120) !== label)) return undefined
  return question as AskQuestion
}

// Result text mirrors omp's built-in ask so an overridden ask reads the same
// to the model: one question → "User selected: …", several → "User answers:".
function askAnswerLine(answer: AskAnswer): string {
  if (answer.customInput !== undefined) return `${answer.id}: "${answer.customInput}"`
  if (answer.multi) return `${answer.id}: [${answer.selectedOptions.join(", ")}]`
  return `${answer.id}: ${answer.selectedOptions[0] ?? "(cancelled)"}`
}

function askAnswerText(answer: AskAnswer): string {
  const lines: string[] = []
  if (answer.selectedOptions.length) lines.push(`User selected: ${answer.selectedOptions.join(", ")}`)
  if (answer.customInput !== undefined) {
    lines.push(answer.customInput.includes("\n")
      ? `User provided custom input:\n${answer.customInput.split("\n").map((line) => `  ${line}`).join("\n")}`
      : `User provided custom input: ${answer.customInput}`)
  }
  return lines.length ? lines.join("\n") : answer.multi ? "User did not select any options" : "User cancelled the selection"
}

// `selected` stays in details because the decision_resolved reducer path
// (selectedOption) reads it.
function askDetails(answer: AskAnswer): Record<string, unknown> {
  const selected = answer.selectedOptions.length ? answer.selectedOptions.join(", ") : answer.customInput
  return { ...answer, ...(selected !== undefined ? { selected } : {}) }
}

function askResult(answers: AskAnswer[], source: "terminal" | "overload-web"): AskToolResult {
  if (answers.length === 1) {
    const answer = answers[0]!
    return { content: [{ type: "text", text: askAnswerText(answer) }], details: { source, ...askDetails(answer) } }
  }
  return { content: [{ type: "text", text: `User answers:\n${answers.map(askAnswerLine).join("\n")}` }], details: { source, answers: answers.map(askDetails) } }
}

type AskUi = {
  select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => Promise<string | undefined>
  input: (title: string, placeholder?: string, opts?: { signal?: AbortSignal }) => Promise<string | undefined>
}

function terminalUi(ctx: unknown): AskUi | undefined {
  if (!ctx || typeof ctx !== "object" || !("hasUI" in ctx) || ctx.hasUI !== true || !("ui" in ctx)) return undefined
  const ui: unknown = ctx.ui
  if (!ui || typeof ui !== "object" || !("select" in ui) || typeof ui.select !== "function" || !("input" in ui) || typeof ui.input !== "function") return undefined
  return ui as AskUi
}

// Throws (so the model re-asks) on inputs omp's built-in ask also refuses:
// reserved dialog labels and duplicate labels within one question.
function validateAskQuestions(questions: AskQuestion[]): void {
  if (!questions.length) throw new Error("ask: questions must not be empty")
  for (const question of questions) {
    const labels = askLabels(question)
    const reserved = labels.find((label) => label === ASK_OTHER_OPTION || (question.multi === true && label === ASK_DONE_OPTION))
    if (reserved !== undefined) throw new Error(`ask: option labels must not collide with reserved runtime labels: ${JSON.stringify(reserved)}`)
    const duplicate = labels.find((label, index) => labels.indexOf(label) !== index)
    if (duplicate !== undefined) throw new Error(`ask: option labels must be unique within a question: ${JSON.stringify(duplicate)}`)
  }
}

function askTitle(question: AskQuestion): string {
  const text = String(question.question || "Decision required")
  const header = typeof question.header === "string" ? question.header.trim() : ""
  return header ? `[${header}] ${text}` : text
}

// One question through the host dialogs. Esc (select → undefined) cancels the
// whole ask, as in omp's built-in; Esc inside "Other" returns to the list.
async function askOneInTerminal(question: AskQuestion, index: number, ui: AskUi, signal: AbortSignal): Promise<AskAnswer | undefined> {
  const title = askTitle(question)
  const labels = askLabels(question)
  const multi = question.multi === true
  const answer: AskAnswer = { id: typeof question.id === "string" && question.id ? question.id : `q${index + 1}`, question: String(question.question || "Decision required"), options: labels, multi, selectedOptions: [] }
  const readCustom = async (): Promise<string | undefined> => {
    const text = await ui.input(title, undefined, { signal })
    return signal.aborted ? undefined : text
  }
  if (!labels.length) {
    const text = await readCustom()
    return text === undefined ? undefined : { ...answer, customInput: text }
  }
  if (!multi) {
    const recommended = typeof question.recommended === "number" && Number.isInteger(question.recommended) ? question.recommended : -1
    const shown = labels.map((label, i) => i === recommended && !label.endsWith(ASK_RECOMMENDED_SUFFIX) ? label + ASK_RECOMMENDED_SUFFIX : label)
    while (true) {
      const choice = await ui.select(title, [...shown, ASK_OTHER_OPTION], { signal })
      if (signal.aborted || choice === undefined) return undefined
      if (choice === ASK_OTHER_OPTION) {
        const text = await readCustom()
        if (signal.aborted) return undefined
        if (text === undefined) continue
        return { ...answer, customInput: text }
      }
      const picked = shown.indexOf(choice)
      return { ...answer, selectedOptions: [picked >= 0 ? labels[picked]! : choice] }
    }
  }
  const checked = new Set<number>()
  while (true) {
    const shown = labels.map((label, i) => `${checked.has(i) ? "[x]" : "[ ]"} ${label}`)
    const choice = await ui.select(checked.size ? `(${checked.size} selected) ${title}` : title, [...shown, ...(checked.size ? [ASK_DONE_OPTION] : []), ASK_OTHER_OPTION], { signal })
    if (signal.aborted || choice === undefined) return undefined
    if (choice === ASK_DONE_OPTION) break
    if (choice === ASK_OTHER_OPTION) {
      const text = await readCustom()
      if (signal.aborted) return undefined
      if (text === undefined) continue
      answer.customInput = text
      break
    }
    const picked = shown.indexOf(choice)
    if (picked < 0) continue
    if (checked.has(picked)) checked.delete(picked)
    else checked.add(picked)
  }
  return { ...answer, selectedOptions: labels.filter((_label, i) => checked.has(i)) }
}

// Asks every question in order; undefined means the user cancelled.
async function askInTerminal(questions: AskQuestion[], ui: AskUi, signal: AbortSignal): Promise<AskAnswer[] | undefined> {
  const answers: AskAnswer[] = []
  for (const [index, question] of questions.entries()) {
    const answer = await askOneInTerminal(question, index, ui, signal)
    if (!answer) return undefined
    answers.push(answer)
  }
  return answers
}

function hostContext(): { host?: Record<string, string>; error?: string } {
  let environment = { ...process.env } as Record<string, string | undefined>;
  const directHost = environment.CMUX_SURFACE_ID ? "cmux" : undefined;
  const deadline = Date.now() + 1_000;
  let pid = process.ppid;
  for (let depth = 0; !directHost && depth < 6; depth++) {
    try {
      const timeout = Math.min(250, deadline - Date.now());
      if (timeout < 1) return { error: "ps_timeout" };
      const output = execFileSync("/bin/ps", ["eww", "-p", String(pid)], { timeout, stdio: ["ignore", "pipe", "ignore"] }).toString();
      const match = output.match(/CMUX_SURFACE_ID=([^\s]+)/);
      if (match?.[1]) {
        environment = { CMUX_SURFACE_ID: match[1] };
        break;
      }
      const remaining = Math.min(250, deadline - Date.now());
      if (remaining < 1) return { error: "ps_timeout" };
      const parent = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { timeout: remaining, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      pid = Number(parent);
      if (!Number.isSafeInteger(pid) || pid < 2) break;
    } catch (error: unknown) {
      return { error: typeof error === "object" && error !== null && "code" in error && error.code === "ETIMEDOUT" ? "ps_timeout" : "ps_failed" };
    }
  }
  const sessionId = environment.CMUX_SURFACE_ID;
  if (!sessionId) return {};
  let tty: string | undefined;
  try {
    const timeout = Math.min(250, deadline - Date.now());
    if (timeout > 0) {
      const value = execFileSync("/usr/bin/tty", [], { timeout, stdio: ["inherit", "pipe", "ignore"] }).toString().trim();
      if (value.startsWith("/dev/")) tty = value;
    }
  } catch { /* no controlling terminal */ }
  return { host: { app: "cmux", session_id: sessionId, ...(tty ? { tty } : {}) } };
}

function execGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 1500, maxBuffer: 64 * 1024 }, (error, stdout) => {
      resolve(error ? null : String(stdout).trim() || null)
    })
  })
}

class SpoolWriter {
  readonly ready: Promise<void>
  private runtime: Runtime
  host = "local"
  emitterId = ""
  writerId = ""
  private dir = ""
  private disabled = false
  private warned = false
  private queue: Envelope[] = []
  private draining = false
  private seq = 0
  private droppedTotal = 0
  private writeErrorTotal = 0
  private segment = 1
  private segmentBytes = 0
  private segmentOpenedAt = Date.now()
  private sealTimer: ReturnType<typeof setTimeout> | null = null
  private activePath = ""

  constructor(runtime: Runtime) {
    this.runtime = runtime
    this.emitterId = safeComponent(`${this.runtime}-${process.pid}-${procBootId.slice(0, 8)}`, "emitter")
    this.writerId = this.emitterId
    this.ready = this.initialize()
  }

  private async initialize(): Promise<void> {
    try {
      const root = join(homedir(), ".overload")
      try {
        this.host = parseHostId(await readFile(join(root, "host"), "utf8"))
      } catch {
        // Missing, unreadable or malformed host configuration falls back to local.
      }
      const spoolRoot = join(root, "spool")
      const hostDir = join(spoolRoot, this.host)
      this.dir = join(hostDir, this.emitterId)
      for (const path of [root, spoolRoot, hostDir, this.dir]) {
        await mkdir(path, { recursive: true, mode: 0o700 })
        await chmod(path, 0o700)
      }
      this.activePath = this.path("active")
    } catch (error) {
      this.disable(error)
    }
  }

  enqueue(base: Omit<Envelope, "v" | "at" | "host" | "runtime" | "emitter_id" | "writer_id" | "seq" | "dropped_total" | "write_error_total">): void {
    if (this.disabled) return
    const seq = ++this.seq
    if (this.queue.length >= WRITE_QUEUE_LIMIT) {
      this.droppedTotal++
      return
    }
    this.queue.push({
      v: 1,
      at: Date.now(),
      host: this.host,
      runtime: this.runtime,
      emitter_id: this.emitterId,
      writer_id: this.writerId,
      seq,
      dropped_total: this.droppedTotal,
      write_error_total: this.writeErrorTotal,
      ...base,
    })
    this.drain()
  }

  async flushAndSeal(): Promise<void> {
    await this.ready
    while (!this.disabled && (this.draining || this.queue.length)) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    await this.seal()
  }

  private drain(): void {
    if (this.draining) return
    this.draining = true
    void this.drainAsync().catch((error) => this.disable(error)).finally(() => {
      this.draining = false
      if (this.queue.length && !this.disabled) this.drain()
    })
  }

  private async drainAsync(): Promise<void> {
    await this.ready
    while (this.queue.length && !this.disabled) {
      // One open/write/close per batch, not per line: open() alone can cost
      // milliseconds under endpoint scanning or load, which capped the writer
      // near 120 lines/s and let bursts overflow WRITE_QUEUE_LIMIT. A batch
      // never crosses the segment size limit, so the inline seal still fires
      // at the first line that reaches SEGMENT_MAX_BYTES.
      let batch = ""
      let batchBytes = 0
      let count = 0
      while (this.queue.length && (count === 0 || this.segmentBytes + batchBytes < SEGMENT_MAX_BYTES)) {
        const item = this.queue.shift()!
        // Counters describe all failures known at the instant of the write attempt.
        item.dropped_total = this.droppedTotal
        item.write_error_total = this.writeErrorTotal
        const line = `${JSON.stringify(item)}\n`
        batch += line
        batchBytes += Buffer.byteLength(line)
        count++
      }
      try {
        const handle = await open(
          this.activePath,
          constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await handle.chmod(0o600)
          await handle.writeFile(batch, "utf8")
        } finally {
          await handle.close()
        }
        this.segmentBytes += batchBytes
        this.armSealTimer()
        if (this.segmentBytes >= SEGMENT_MAX_BYTES) await this.seal()
      } catch {
        this.writeErrorTotal += count
        // Failed events are not retried indefinitely; the resident counter exposes the gap.
      }
    }
  }

  private armSealTimer(): void {
    if (this.sealTimer) return
    const delay = Math.max(0, SEGMENT_MAX_AGE_MS - (Date.now() - this.segmentOpenedAt))
    this.sealTimer = setTimeout(() => {
      this.sealTimer = null
      if (this.draining) {
        this.armSealTimer()
        return
      }
      this.draining = true
      void this.seal().finally(() => {
        this.draining = false
        if (this.queue.length && !this.disabled) this.drain()
      })
    }, delay)
    this.sealTimer.unref?.()
  }

  private async seal(): Promise<void> {
    if (this.disabled || !this.activePath || this.segmentBytes === 0) return
    if (this.sealTimer) clearTimeout(this.sealTimer)
    this.sealTimer = null
    const sealedPath = this.path("seg")
    try {
      await rename(this.activePath, sealedPath)
      this.segment++
      this.segmentBytes = 0
      this.segmentOpenedAt = Date.now()
      this.activePath = this.path("active")
    } catch (error: any) {
      if (error?.code !== "ENOENT") this.writeErrorTotal++
    }
  }

  private path(prefix: "active" | "seg"): string {
    return join(this.dir, `${prefix}-${this.emitterId}-${this.segment}.ndjson`)
  }

  private disable(error: unknown): void {
    this.disabled = true
    this.queue.length = 0
    if (this.sealTimer) clearTimeout(this.sealTimer)
    this.sealTimer = null
    if (!this.warned) {
      this.warned = true
      console.warn("[overload] spool unavailable; telemetry disabled:", (error as Error)?.message || error)
    }
  }
}

export default function overload(pi: ExtensionApi): void {
  const runtime = detectRuntime()
  const spool = new SpoolWriter(runtime)
  const pendingAsk = new Set<string>()
  // Web targets registered by tool_call for the answerable ask, keyed by
  // toolCallId; execute takes ownership, tool_execution_end closes leftovers.
  const askTargets = new Map<string, AskTarget>()
  const askWebAnswers = new Map<string, { actor: string; receiptId: string }>()
  // An ask whose target another entry consumed. The terminal decision_resolved is emitted at
  // tool_execution_end, so the conflict rides along on it rather than adding a second one.
  const askWebConflicts = new Map<string, ConsumeConflict>()
  const isAskTool = (name: unknown) => name === "ask" || name === "ask_user"
  let askToolRegistered = false
  let controlPlanePort = DEFAULT_WEB_PORT
  const headByCwd = new Map<string, string>()
  let session = safeComponent(randomUUID(), "session")
  let stableId = ""
  let sessionCwd = process.cwd()
  let runStartedAt = 0
  let working = false
  let settledForRun = false
  let lastToolActivity = 0
  let changeEvidenceSeen = false
  let lastAssistantText = ""
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let approvalGate: ApprovalGate | null = null
  let gateWarned = false

  function emit(kind: Kind, detail?: Record<string, unknown>): void {
    spool.enqueue({ session, kind, ...(detail ? { detail } : {}) })
  }

  function warnAndSealGate(error: unknown): void {
    const message = (error as Error)?.message || String(error)
    approvalGate = { bash: [], requireBash: [], writePaths: [], requireWritePaths: [], timeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS, webPort: DEFAULT_WEB_PORT, misconfigured: message }
    if (gateWarned) return
    gateWarned = true
    console.warn("[overload] invalid approval_gate configuration; blocking all bash/write/edit until it is fixed:", message)
  }

  async function loadApprovalGate(): Promise<void> {
    approvalGate = null
    try {
      let raw: string
      try {
        raw = await readFile(process.env.OVERLOAD_CONFIG_PATH??join(homedir(), ".overload", "config.json"), "utf8")
      } catch (error: any) {
        if (error?.code === "ENOENT") return
        throw error
      }
      const config = JSON.parse(raw)
      // The answerable ask talks to the control plane even with the gate off.
      if (Number.isSafeInteger(config?.web_port) && config.web_port > 0 && config.web_port <= 65535) controlPlanePort = config.web_port
      const gate = config?.approval_gate
      if (gate === undefined) return
      if (!gate || typeof gate !== "object" || typeof gate.enabled !== "boolean") {
        throw new Error("approval_gate must contain a boolean enabled field")
      }
      if (!gate.enabled) return
      const stringArray = (key: string): string[] => {
        const value = gate[key]
        if (value === undefined) return []
        if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) {
          throw new Error(`${key} must be an array of strings`)
        }
        return [...value]
      }
      const timeoutMs = gate.timeout_ms === undefined ? DEFAULT_APPROVAL_TIMEOUT_MS : gate.timeout_ms
      if (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeout_ms must be a positive integer")
      const webPort = config.web_port === undefined ? DEFAULT_WEB_PORT : config.web_port
      if (typeof webPort !== "number" || !Number.isSafeInteger(webPort) || webPort <= 0 || webPort > 65535) throw new Error("web_port must be a positive integer")
      const blockBash = stringArray("block_bash_patterns")
      const requireBash = stringArray("require_approval_bash_patterns")
      const writePaths = stringArray("block_write_paths")
      const requireWritePaths = stringArray("require_approval_write_paths")
      approvalGate = {
        bash: blockBash.map((source) => ({ source, pattern: new RegExp(source) })),
        requireBash: requireBash.map((source) => ({ source, pattern: new RegExp(source) })),
        writePaths,
        requireWritePaths,
        timeoutMs,
        webPort,
      }
    } catch (error) {
      warnAndSealGate(error)
    }
  }
  function gateRule(event: any): GateRule | undefined {
    const gate = approvalGate
    if (!gate || !/^(bash|write|edit)$/i.test(String(event?.toolName || ""))) return undefined
    if (gate.misconfigured) return { kind: "block", rule: "misconfigured" }
    if (event?.toolName === "bash" && typeof event?.input?.command === "string") {
      for (const rule of gate.bash) {
        rule.pattern.lastIndex = 0
        if (rule.pattern.test(event.input.command)) return { kind: "block", rule: rule.source }
      }
      for (const rule of gate.requireBash) {
        rule.pattern.lastIndex = 0
        if (rule.pattern.test(event.input.command)) return { kind: "require", rule: rule.source }
      }
      return undefined
    }
    if ((event?.toolName === "write" || event?.toolName === "edit") && typeof event?.input?.path === "string") {
      for (const path of gate.writePaths) {
        if (event.input.path.startsWith(path)) return { kind: "block", rule: path }
      }
      for (const path of gate.requireWritePaths) {
        if (event.input.path.startsWith(path)) return { kind: "require", rule: path }
      }
    }
    return undefined
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }
  function approvalDetail(event: any, rule: string, expiresAt: number): Record<string, unknown> {
    const tool = String(event?.toolName || "unknown")
    const command = typeof event?.input?.command === "string" ? truncateUtf8(event.input.command, 120) : ""
    const path = typeof event?.input?.path === "string" ? truncateUtf8(event.input.path, 120) : ""
    const target = command || path
    const actionClass = command ? consequentialClass(event.input.command) : undefined
    const approvalId = `${stableId}#${spool.writerId}#${String(event?.toolCallId || "")}`
    return {
      request_id: String(event?.toolCallId || ""),
      gated: true,
      gate: "action",
      approval_id: approvalId,
      rule,
      tool,
      ...(command ? { command } : {}),
      ...(actionClass ? { class: actionClass } : {}),
      ...(path ? { path } : {}),
      summary: truncateUtf8(`放行 ${tool}: ${target}?`, 500),
      options: ["approve", "deny"],
      expires_at: expiresAt,
    }
  }

  const receiptByToolCall = new Map<string,{receiptId:string;attemptId?:string;effect:string}>()
  function canonicalValue(value:unknown):string{if(value===null||typeof value!=="object")return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(canonicalValue).join(",")}]`;const row=value as Record<string,unknown>;return `{${Object.keys(row).sort().map(key=>`${JSON.stringify(key)}:${canonicalValue(row[key])}`).join(",")}}`}
  // The hash must cover exactly what ingest will decode from the spool line. JSON drops undefined members (an ask
  // receipt has no attempt_id), so hash and emit the JSON wire form, never the in-memory object.
  function emitEffect(effect:Record<string,unknown>):void{const payload=JSON.parse(JSON.stringify(effect)) as Record<string,unknown>,receiptId=String(payload.receipt_id),toolCallId=String(payload.toolCallId),eventId=`extension:${receiptId}:${toolCallId}:effect_observed`;emit("control_event",{event_id:eventId,producer_id:`extension:${spool.emitterId}`,entity_id:receiptId,entity_version:1,event_kind:"effect_observed",payload,payload_hash:createHash("sha256").update(canonicalValue(payload)).digest("hex")})}

  async function waitForApproval(event: { toolCallId: string; toolName: string; input?: Record<string, unknown> }, rule: GateRule, signal?: AbortSignal): Promise<{ block: true; reason: string } | undefined> {
    const gate = approvalGate
    if (!gate || typeof event?.toolCallId !== "string") return { block: true, reason: `overload approval gate: ${rule.rule}` }
    if (rule.kind === "block") {
      // A denial is already terminal: it carries no options and no expiry, so the
      // dashboard never renders approve buttons for a request nobody can answer.
      const detail = { request_id: String(event.toolCallId), gated: true, rule: gate.misconfigured ? "misconfigured" : rule.rule, tool: String(event?.toolName || "unknown") }
      emit("decision_requested", detail)
      emit("decision_resolved", { ...detail, state: "cancelled" })
      return { block: true, reason: gate.misconfigured ? `overload approval gate misconfigured: ${gate.misconfigured}` : `overload approval gate: ${rule.rule}` }
    }
    const expiresAt = Date.now() + gate.timeoutMs
    const detail = approvalDetail(event, rule.rule, expiresAt)
    const approvalId = String(detail.approval_id)
    const base = `http://127.0.0.1:${gate.webPort}`
    const evidence = { tool: detail.tool, command: typeof event?.input?.command === "string" ? event.input.command : undefined, path: typeof event?.input?.path === "string" ? event.input.path : undefined, input: event?.input, cwd: sessionCwd, rule: rule.rule, class: detail.class, toolCallId: event.toolCallId,session_id:process.env.OVERLOAD_RUNTIME_SESSION_ID }
    let targetVersion = ""
    const cancelApproval = async (): Promise<{ block: true; reason: string }> => {
      let closed = false
      try {
        const response = await globalThis.fetch(`${base}/api/decision/cancel/${encodeURIComponent(approvalId)}`, { method: "POST", headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, signal: AbortSignal.timeout(2000), body: JSON.stringify({ consumer_owner: "extension", target_version: targetVersion }) })
        closed = response.ok
      } catch { /* Never allow execution when cancellation cannot be confirmed. */ }
      emit("decision_resolved", { request_id: detail.request_id, gated: true, state: "cancelled", cancellation_confirmed: closed })
      return { block: true, reason: closed ? "overload approval gate: cancelled" : "overload approval gate: cancelled; target closure unconfirmed" }
    }
    try {
      const registered = await globalThis.fetch(`${base}/api/decision/target`, { method: "POST", signal: AbortSignal.timeout(2000), headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ consumerOwner: "extension", approvalId, stableId, requestUid: `${stableId}#${spool.writerId}#${event.toolCallId}`, question: detail.summary, options: ["approve", "deny"], effect: String(detail.class || "gated_tool"), scope: { gate: "action", rule: rule.rule, cwd: sessionCwd }, evidence, toolCallId: event.toolCallId, decisionMode: "human_only", expiresAt }) })
      if (registered.ok) {
        const payload: unknown = await registered.json()
        if (payload && typeof payload === "object" && "targetVersion" in payload && typeof payload.targetVersion === "string") targetVersion = payload.targetVersion
      }
    } catch { /* unavailable control plane remains fail-closed */ }
    emit("decision_requested", { ...detail, consumer_owner: "extension", target_version: targetVersion })
    while (Date.now() < expiresAt && targetVersion) {
      if (signal?.aborted) return cancelApproval()
      try {
        const response = await globalThis.fetch(`${base}/api/decision/consume/${encodeURIComponent(approvalId)}`, { method: "POST", signal: AbortSignal.timeout(2000), headers: { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }, body: JSON.stringify({ consumer_owner: "extension", target_version: targetVersion }) })
        if (response.status === 200) {
          const payload = await response.json() as { answer?: unknown; actor?: unknown; receiptId?: unknown; attemptId?:unknown }
          if (signal?.aborted) {
            if (typeof payload.receiptId === "string") emitEffect({ receipt_id: payload.receiptId, toolCallId: event.toolCallId, effect: String(detail.class || "gated_tool"), effect_state: "failed", evidence: { reason: "cancelled_before_tool_execution" } })
            return cancelApproval()
          }
          const answer = typeof payload.answer === "string" ? payload.answer : ""
          const actor = typeof payload.actor === "string" ? payload.actor : "unknown"
          emit("decision_resolved", { request_id: detail.request_id, gated: true, state: "resolved", selected: answer, actor, receipt_id: payload.receiptId })
          if(answer === "approve" && typeof payload.receiptId === "string")receiptByToolCall.set(event.toolCallId,{receiptId:payload.receiptId,attemptId:typeof payload.attemptId==="string"?payload.attemptId:undefined,effect:String(detail.class||"gated_tool")})
          return answer === "approve" ? undefined : { block: true, reason: `overload approval gate: denied by ${actor}` }
        }
        // §4.5: another entry consumed this decision. Terminal for this entry — report where
        // the decision stands and stop, rather than polling a target that can never answer us
        // again. Still fail-closed: the answer never reached this session, so the tool blocks.
        const conflict = await consumeConflict(response)
        if (conflict) {
          emit("decision_resolved", { request_id: detail.request_id, gated: true, state: "cancelled", conflict })
          return { block: true, reason: `overload approval gate: ${conflict.code} by another entry` }
        }
      } catch { /* Poll errors are fail-closed at expiry, not an early allow. */ }
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); resolve() }
        const timer = setTimeout(finish, Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(1, expiresAt - Date.now())))
        signal?.addEventListener("abort", finish, { once: true })
        if (signal?.aborted) finish()
      })
    }
    if (signal?.aborted) return cancelApproval()
    emit("decision_resolved", { request_id: detail.request_id, gated: true, state: "timed_out" })
    return { block: true, reason: "overload approval gate: timed out" }
  }

  const controlPlaneHeaders = { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" }

  async function registerAskTarget(toolCallId: string, question: AskQuestion): Promise<AskTarget | undefined> {
    const approvalId = `${stableId}#${spool.writerId}#${toolCallId}`
    const expiresAt = Date.now() + ASK_TARGET_TTL_MS
    const text = truncateUtf8(question.question || "", 500)
    const options = askLabels(question)
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${controlPlanePort}/api/decision/target`, { method: "POST", signal: AbortSignal.timeout(2000), headers: controlPlaneHeaders, body: JSON.stringify({ consumerOwner: "extension", approvalId, stableId, requestUid: approvalId, question: text, options, effect: "ask_answer", scope: { gate: "ask", cwd: sessionCwd }, evidence: { tool: "ask", question: text, options, cwd: sessionCwd, toolCallId }, toolCallId, decisionMode: "human_only", expiresAt }) })
      if (!response.ok) return undefined
      const payload: unknown = await response.json()
      if (payload && typeof payload === "object" && "targetVersion" in payload && typeof payload.targetVersion === "string") return { approvalId, targetVersion: payload.targetVersion, expiresAt }
    } catch { /* Control plane unreachable: the ask stays terminal-only. */ }
    return undefined
  }

  function cancelAskTarget(target: AskTarget): void {
    // A consumed target refuses cancellation, so a late Web consume stays observable.
    void globalThis.fetch(`http://127.0.0.1:${controlPlanePort}/api/decision/cancel/${encodeURIComponent(target.approvalId)}`, { method: "POST", signal: AbortSignal.timeout(2000), headers: controlPlaneHeaders, body: JSON.stringify({ consumer_owner: "extension", target_version: target.targetVersion }) }).catch(() => {})
  }

  // Polls the mailbox until the Web answer is consumed, the target expires, or
  // `stop` fires because the terminal answered first. A consume request is
  // never aborted client-side: the server may commit the receipt after any
  // client timeout, and an abandoned response would lose the only copy of the
  // answer. A late response after `stop` is recorded as undelivered instead.
  async function awaitWebAnswer(toolCallId: string, target: AskTarget, stop: AbortSignal): Promise<{ answer: string; actor: string; receiptId: string } | { conflict: ConsumeConflict } | undefined> {
    while (!stop.aborted && Date.now() < target.expiresAt) {
      try {
        const response = await globalThis.fetch(`http://127.0.0.1:${controlPlanePort}/api/decision/consume/${encodeURIComponent(target.approvalId)}`, { method: "POST", headers: controlPlaneHeaders, body: JSON.stringify({ consumer_owner: "extension", target_version: target.targetVersion }) })
        if (response.status === 200) {
          const payload: unknown = await response.json()
          const field = (key: string): string => payload && typeof payload === "object" && key in payload && typeof (payload as Record<string, unknown>)[key] === "string" ? String((payload as Record<string, unknown>)[key]) : ""
          const receiptId = field("receiptId")
          if (stop.aborted) {
            // The terminal won while this consume was in flight: the receipt exists but its answer never reached the agent.
            if (receiptId) emitEffect({ receipt_id: receiptId, toolCallId, effect: "ask_answer", effect_state: "failed", evidence: { reason: "answered_in_terminal_first" } })
            return undefined
          }
          return { answer: field("answer"), actor: field("actor") || "unknown", receiptId }
        }
        // §4.5: another entry consumed this ask. Stop polling instead of waiting out the
        // target's TTL; the terminal contender, when there is one, still decides.
        const conflict = await consumeConflict(response)
        if (conflict) return { conflict }
      } catch { /* Poll errors retry until expiry; the terminal can still answer. */ }
      await new Promise<void>((resolve) => {
        const finish = () => { clearTimeout(timer); stop.removeEventListener("abort", finish); resolve() }
        const timer = setTimeout(finish, Math.min(APPROVAL_POLL_INTERVAL_MS, Math.max(1, target.expiresAt - Date.now())))
        stop.addEventListener("abort", finish, { once: true })
      })
    }
    return undefined
  }

  // Registered as `ask`: the terminal dialog races the Overload mailbox and the
  // first answer wins. pi keeps its bundled ask_user beside it (same-name
  // extension tools refuse to start); omp's built-in ask is overridden.
  async function executeAsk(toolCallId: string, params: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: unknown): Promise<AskToolResult> {
    const questions = params && typeof params === "object" && "questions" in params && Array.isArray(params.questions) ? params.questions as AskQuestion[] : []
    // Before claiming the target: an unclaimed target is cancelled at tool_execution_end.
    validateAskQuestions(questions)
    const target = askTargets.get(toolCallId)
    askTargets.delete(toolCallId)
    const ui = terminalUi(ctx)
    if (!ui && !target) {
      throw new Error("ask needs an interactive terminal or a reachable Overload control plane")
    }
    const dialog = new AbortController()
    const poll = new AbortController()
    const stop = () => { dialog.abort(); poll.abort() }
    signal?.addEventListener("abort", stop, { once: true })
    let webWon = false
    try {
      const contenders: Array<Promise<AskToolResult>> = [
        new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(new Error(ASK_CANCELLED))
          if (signal?.aborted) cancel()
          else signal?.addEventListener("abort", cancel, { once: true })
        }),
      ]
      if (ui) {
        contenders.push(askInTerminal(questions, ui, dialog.signal).then((answers) => {
          if (!answers) {
            // Built-in parity: a terminal cancel also stops the agent turn.
            if (!dialog.signal.aborted && ctx && typeof ctx === "object" && "abort" in ctx && typeof ctx.abort === "function") ctx.abort()
            throw new Error(ASK_CANCELLED)
          }
          return askResult(answers, "terminal")
        }))
      }
      if (target) {
        contenders.push(awaitWebAnswer(toolCallId, target, poll.signal).then((web) => {
          if (!web || "conflict" in web) {
            if (web) askWebConflicts.set(toolCallId, web.conflict)
            if (ui) return new Promise<never>(() => {})
            throw new Error(web
              ? `ask was ${web.conflict.code} through another entry; no answer reached this session`
              : "ask expired before an Overload answer arrived")
          }
          webWon = true
          askWebAnswers.set(toolCallId, { actor: web.actor, receiptId: web.receiptId })
          if (web.receiptId) receiptByToolCall.set(toolCallId, { receiptId: web.receiptId, effect: "ask_answer" })
          const asked = questions[0]
          return askResult([{ id: typeof asked?.id === "string" && asked.id ? asked.id : "q1", question: String(asked?.question || "Decision required"), options: asked ? askLabels(asked) : [], multi: false, selectedOptions: [web.answer] }], "overload-web")
        }))
      }
      return await Promise.race(contenders)
    } finally {
      stop()
      signal?.removeEventListener("abort", stop)
      if (target && !webWon) cancelAskTarget(target)
    }
  }

  if (typeof pi.registerTool === "function") {
    try {
      pi.registerTool({ name: "ask", label: "Ask", description: "Ask the user one or more questions and wait for an answer from the terminal or the Overload dashboard.", parameters: ASK_SCHEMA, execute: executeAsk })
      askToolRegistered = true
    } catch { /* Host refused the tool: asks stay observational. */ }
  }

  // Context handoff receiver (docs/plans/overload-20260928-manager-chat.md §1.5).
  // A handoff is context, not a priority change or an interruption: briefs are
  // attached to the next prompt and the agent decides adopt/defer/reject itself.
  const injectedHandoffs = new Set<string>()
  const HANDOFF_FETCH_TIMEOUT_MS = 1500

  async function handoffCall(path: string, body?: Record<string, unknown>): Promise<any> {
    const response = await globalThis.fetch(`http://127.0.0.1:${controlPlanePort}${path}`, body
      ? { method: "POST", signal: AbortSignal.timeout(2000), headers: controlPlaneHeaders, body: JSON.stringify(body) }
      : { signal: AbortSignal.timeout(HANDOFF_FETCH_TIMEOUT_MS) })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(String(value?.message || value?.error || `HTTP ${response.status}`))
    return value
  }

  async function fetchPendingHandoffs(): Promise<any[]> {
    if (!stableId) return []
    let timer: ReturnType<typeof setTimeout> | undefined
    // Hard deadline independent of fetch's own abort handling: never hold the turn.
    const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, HANDOFF_FETCH_TIMEOUT_MS) })
    try {
      const result = await Promise.race([handoffCall(`/api/handoff/pending?target_kind=session&target_id=${encodeURIComponent(stableId)}`).catch(() => undefined), deadline])
      return Array.isArray(result?.items) ? result.items : []
    } finally { clearTimeout(timer) }
  }

  function renderHandoff(item: any): string {
    const brief = item?.brief ?? {}
    const list = (label: string, values: unknown) => Array.isArray(values) && values.length ? `${label}:\n${values.map((v) => `- ${String(v)}`).join("\n")}\n` : ""
    return `## Handoff ${item.request_id} (state: ${item.state}${item.ack_decision ? `/${item.ack_decision}` : ""})\nPurpose: ${brief.purpose ?? ""}\n${brief.context ? `Context: ${brief.context}\n` : ""}${list("Constraints", brief.constraints)}${list("Inputs", brief.inputs)}${list("Acceptance", brief.acceptance)}Return requirement: ${brief.return_requirement ?? ""}\n`
  }

  const HANDOFF_PREAMBLE = "Overload context handoff: the owner forwarded context for this session. This is NOT a priority change and NOT an interruption; finish or keep your current work as you judge best. Decide yourself: call handoff_ack with adopt, defer, reject or no_change (and a reason), and when done call handoff_conclude with your decision or conclusion so it returns to the origin.\n\n"

  on("before_agent_start", async () => {
    const items = (await fetchPendingHandoffs()).filter((item) => typeof item?.request_id === "string" && !injectedHandoffs.has(item.request_id))
    if (!items.length) return undefined
    for (const item of items) {
      injectedHandoffs.add(item.request_id)
      if (item.state === "pending") void handoffCall(`/api/handoff/${encodeURIComponent(item.request_id)}/read`, {}).catch(() => {})
    }
    return { message: { customType: "overload_handoff", content: HANDOFF_PREAMBLE + items.map(renderHandoff).join("\n"), display: true, details: { request_ids: items.map((item) => item.request_id) } } }
  })

  function toolText(text: string, details: Record<string, unknown> = {}): AskToolResult {
    return { content: [{ type: "text", text }], details }
  }

  async function handoffTool(run: () => Promise<any>): Promise<AskToolResult> {
    try {
      const value = await run()
      return toolText(JSON.stringify(value), { ok: true })
    } catch (error) {
      return toolText(`handoff call failed: ${(error as Error)?.message || String(error)}`, { ok: false })
    }
  }

  if (typeof pi.registerTool === "function") {
    const tools = [
      { name: "handoff_inbox", label: "Handoff inbox", description: "List Overload context handoffs addressed to this session that you have not concluded yet.", parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => { const items = await fetchPendingHandoffs(); return toolText(items.length ? HANDOFF_PREAMBLE + items.map(renderHandoff).join("\n") : "No pending handoffs.", { count: items.length }) } },
      { name: "handoff_ack", label: "Handoff ack", description: "Acknowledge an Overload context handoff: adopt, defer, reject or no_change, with a reason. A deferred handoff may be acknowledged again later.",
        parameters: { type: "object", properties: { request_id: { type: "string" }, decision: { type: "string", enum: ["adopt", "defer", "reject", "no_change"] }, reason: { type: "string" } }, required: ["request_id", "decision", "reason"], additionalProperties: false },
        execute: (_id: string, params: any) => handoffTool(() => handoffCall(`/api/handoff/${encodeURIComponent(String(params?.request_id ?? ""))}/ack`, { decision: params?.decision, reason: params?.reason })) },
      { name: "handoff_conclude", label: "Handoff conclude", description: "Record the single, final decision or conclusion for an Overload context handoff; it is returned to where the handoff came from. Can only be recorded once.",
        parameters: { type: "object", properties: { request_id: { type: "string" }, kind: { type: "string", enum: ["decision", "conclusion"] }, text: { type: "string" } }, required: ["request_id", "kind", "text"], additionalProperties: false },
        execute: (_id: string, params: any) => handoffTool(() => handoffCall(`/api/handoff/${encodeURIComponent(String(params?.request_id ?? ""))}/conclude`, { kind: params?.kind, text: params?.text })) },
    ]
    for (const tool of tools) {
      try { pi.registerTool(tool) } catch { /* Host refused the tool: handoffs stay readable via the dashboard. */ }
    }
  }

  function shellCommand(command: string): string {
    const tokens = command.trim().split(/\s+/)
    while (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(tokens[0] || "")) tokens.shift()
    return tokens.join(" ")
  }

  function consequentialClass(command: string): string | undefined {
    const normalized = shellCommand(command)
    if (/^git push\b/.test(normalized)) return "push"
    if (/^(npm|bun|pnpm|yarn) publish\b|^gh (pr merge|release create)\b/.test(normalized)) return "publish"
    if (/^rm -rf?\b|^git branch -D\b|^gh.* delete\b/.test(normalized)) return "delete"
    if (/^(kubectl|helm) (apply|delete|rollout)\b|^terraform apply\b/.test(normalized)) return "prod"
    if (/^(curl|http|wget)\b.*(-X\s*(POST|PUT|DELETE|PATCH)\b|--data\b)/i.test(normalized)) return "send"
    return undefined
  }

  function setWorking(): void {
    settledForRun = false
    if (!working) {
      runStartedAt = Date.now()
      working = true
      emit("working")
    }
    if (!heartbeat) {
      heartbeat = setInterval(() => {
        if (working) emit("heartbeat")
      }, HEARTBEAT_INTERVAL_MS)
      heartbeat.unref?.()
    }
  }

  function handoff(): Record<string, unknown> | undefined {
    const path = join(sessionCwd, "HANDOFF.md")
    try {
      if (statSync(path).mtimeMs < runStartedAt) return undefined
      const lines = readFileSync(path, "utf8").split(/\r?\n/)
      let task = ""
      let status = "unknown"
      let nextOwner = ""
      let uncertainties = 0
      let inUncertainties = false
      for (const line of lines) {
        const match = line.match(/^(TASK|STATUS|NEXT OWNER|NEXT_OWNER)\s*[—:-]\s*(.*)$/)
        if (match) {
          inUncertainties = false
          if (match[1] === "TASK") task = match[2]
          else if (match[1] === "STATUS") status = match[2].trim().toLowerCase()
          else nextOwner = match[2].trim()
          continue
        }
        if (/^UNCERTAINTIES(?:\s*[—:-].*)?$/.test(line.trim())) {
          inUncertainties = true
          continue
        }
        if (inUncertainties && /^[A-Z][A-Z0-9_ ]*(?:\s*[—:-]|$)/.test(line.trim())) {
          inUncertainties = false
          continue
        }
        if (inUncertainties && line.trim()) uncertainties++
      }
      const normalizedStatus = status === "complete" || status === "partial" || status === "blocked" ? status : "unknown"
      return {
        path,
        status: normalizedStatus,
        ...(nextOwner ? { next_owner: truncateUtf8(nextOwner, 200) } : {}),
        uncertainties,
        ...(task ? { task: truncateUtf8(task, 200) } : {}),
      }
    } catch {
      return undefined
    }
  }

  function settle(): void {
    if (!working || settledForRun) return
    working = false
    settledForRun = true
    const handoffDetail = handoff()
    emit("settled", {
      ...(lastAssistantText ? { text: truncateUtf8(lastAssistantText) } : {}),
      // Review P4 B1: resident change flag flushed with every settle so the
      // classifier never depends on a throttled tool_activity row alone.
      change_evidence: changeEvidenceSeen,
      ...(handoffDetail ? { handoff: handoffDetail } : {}),
    })
  }

  function settleAgentLifecycle(): void {
    // Some hosts dispatch the terminal agent event even when an earlier lifecycle
    // callback was skipped during print-mode setup. Reconstruct the required
    // transition here rather than silently losing both working and settled.
    if (settledForRun) return
    if (!working) setWorking()
    settle()
  }

  function probeHead(cwd: string, observeChange: boolean): void {
    void Promise.all([execGit(cwd, ["rev-parse", "HEAD"]), execGit(cwd, ["rev-parse", "--show-toplevel"])]).then(([sha, repo]) => {
      if (!sha) return
      const previous = headByCwd.get(cwd)
      headByCwd.set(cwd, sha)
      if (observeChange && previous && previous !== sha && repo) emit("commit_observed", { sha, repo })
    }).catch(() => {})
  }

  function on(event: string, handler: (event: any, ctx: any) => unknown): boolean {
    try {
      pi.on(event, (value, ctx) => {
        try {
          const result = handler(value, ctx)
          // Async handlers reject instead of throwing synchronously; swallow
          // both paths so telemetry can never propagate into the host.
          if (result && typeof (result as Promise<unknown>).catch === "function") {
            return (result as Promise<unknown>).catch(() => event === "tool_call" ? { block: true, reason: "overload tool gate failed" } : undefined)
          }
          return result
        } catch {
          if (event === "tool_call") return { block: true, reason: "overload tool gate failed" }
        }
      })
      return true
    } catch {
      return false
    }
  }

  on("session_start", async (event, ctx) => {
    const rawSession = ctx?.sessionManager?.getSessionId?.()
    session = safeComponent(rawSession, randomUUID())
    const cwd = String(ctx?.cwd || process.cwd())
    sessionCwd = cwd
    try {
      // Hosts await session_start handlers, preserving lifecycle order while all
      // subsequent handlers themselves remain non-blocking.
      await Promise.all([spool.ready, loadApprovalGate()])
      stableId = `${spool.host}:${runtime}:${session}`
      const detail: Record<string, unknown> = {
        lease: { pid: process.pid, proc_boot_id: procBootId },
        cwd,
        reason: event?.reason || "startup",
      }
      const hostProbe = hostContext()
      if (hostProbe.host) detail.host = hostProbe.host
      if (hostProbe.error) detail.host_probe_error = hostProbe.error
      if (process.env.OVERLOAD_PARENT) detail.parent = truncateUtf8(process.env.OVERLOAD_PARENT)
      const branch = await execGit(cwd, ["branch", "--show-current"])
      if (branch) detail.branch = truncateUtf8(branch)
      emit("session_started", detail)
      // EXT-20: own parent recorded above; from here on, every child process
      // this session spawns inherits THIS session as its parent lineage.
      process.env.OVERLOAD_PARENT = stableId
      probeHead(cwd, false)
    } catch {
      // Initialization already disables and warns once; never affect the host.
    }
  })

  // Feature-probe richer lifecycle events; runtimes lacking them retain the
  // minimal session/agent/tool_call registrations below.
  on("before_agent_start", () => setWorking())
  on("agent_start", () => setWorking())
  on("turn_start", () => setWorking())
  on("agent_settled", () => settleAgentLifecycle())
  on("agent_end", (event) => {
    const messages = Array.isArray(event?.messages) ? event.messages : []
    const last = [...messages].reverse().find((message) => message?.role === "assistant")
    if (last) lastAssistantText = textFrom(last)
    // agent_end is part of the minimal cross-runtime set. Modern hosts may
    // subsequently emit agent_settled; the working-state guard deduplicates it.
    settleAgentLifecycle()
  })
  on("message_end", (event) => {
    if (event?.message?.role === "assistant") lastAssistantText = textFrom(event.message)
  })

  on("tool_call", async (event, ctx) => {
    const now = Date.now()
    const tool = String(event?.toolName || "unknown")
    const command = typeof event?.input?.command === "string" ? event.input.command : ""
    const actionClass = tool.toLowerCase() === "bash" ? consequentialClass(command) : undefined
    const changeCapable = /^(bash|write|edit)$/i.test(tool)
    // Review P4 B1: the 5s throttle must never suppress CHANGE evidence — the
    // first change-capable call always emits (unthrottled) and latches a resident
    // flag that is also flushed with settled/session_ended details. Consequential
    // classes bypass the throttle for the same reason: audit must never miss one.
    if (actionClass) {
      changeEvidenceSeen = true
      lastToolActivity = now
      emit("tool_activity", { tool: truncateUtf8(tool, 80), change: true, consequential: true, class: actionClass })
    } else if (changeCapable && !changeEvidenceSeen) {
      changeEvidenceSeen = true
      lastToolActivity = now
      emit("tool_activity", { tool: truncateUtf8(tool, 80), change: true })
    } else if (now - lastToolActivity >= TOOL_ACTIVITY_INTERVAL_MS) {
      lastToolActivity = now
      emit("tool_activity", { tool: truncateUtf8(tool, 80), ...(changeCapable ? { change: true } : {}) })
    }
    if (isAskTool(event?.toolName) && typeof event.toolCallId === "string") {
      pendingAsk.add(event.toolCallId)
      // Only this extension's own `ask` can consume a Web answer, so only it
      // registers a mailbox target and advertises approval_id to the card.
      const question = event.toolName === "ask" && askToolRegistered ? webAskQuestion(event.input) : undefined
      const target = question ? await registerAskTarget(event.toolCallId, question) : undefined
      if (target) askTargets.set(event.toolCallId, target)
      emit("decision_requested", { request_id: event.toolCallId, ...questionPayload(event.input), ...(target ? { approval_id: target.approvalId, consumer_owner: "extension", target_version: target.targetVersion } : {}) })
    }
    const rule = gateRule(event)
    if (rule) {
      const decision = await waitForApproval(event, rule, ctx?.signal)
      if (decision) return decision
    }
    if (event?.toolName !== "bash" || !command) return
    // Shared guard: never rewrite compound commands (quoting hazards); the
    // dispatch templates own env injection for those (EXT-19 non-goal #2).
    if (/[|;&`$()\n\r]/.test(command)) return
    if (/^git commit\b/.test(command)) {
      const trailer = `Overload-Session: ${stableId}#${spool.writerId}`
      event.input.command = `${command} --trailer "${trailer}"`
      return
    }
    // EXT-19: cross-process agent spawns inherit this session as parent
    // lineage; children read OVERLOAD_PARENT (EXT-03 / CLH-09).
    if (/^(pi|omp|prime-agent|claude)\b/.test(command) && stableId && !command.includes("OVERLOAD_PARENT")) {
      event.input.command = `OVERLOAD_PARENT=${stableId} ${command}`
    }
  })
  on("tool_execution_end", (event) => {
    if (!isAskTool(event?.toolName) || !pendingAsk.delete(event.toolCallId)) return
    // A target execute never claimed (the call was blocked) must not stay answerable.
    const unclaimed = askTargets.get(event.toolCallId)
    askTargets.delete(event.toolCallId)
    if (unclaimed) cancelAskTarget(unclaimed)
    const web = askWebAnswers.get(event.toolCallId)
    askWebAnswers.delete(event.toolCallId)
    const conflict = askWebConflicts.get(event.toolCallId)
    askWebConflicts.delete(event.toolCallId)
    const selected = selectedOption(event.result)
    emit("decision_resolved", {
      request_id: event.toolCallId,
      // Explicit terminal state: ask erroring out (user escape/abort) is a
      // cancellation, never a successful resolution (review B1).
      state: event.isError ? "cancelled" : "resolved",
      ...(selected ? { selected } : {}),
      ...(web ? { actor: web.actor, receipt_id: web.receiptId } : {}),
      // §4.5: the Web leg stopped on a lost race; the terminal still decided the ask.
      ...(conflict ? { conflict } : {}),
      ...(event.isError ? { error: true } : {}),
    })
  })

  on("tool_result", (event, ctx) => {
    if (event?.toolName === "bash") probeHead(String(ctx?.cwd || process.cwd()), true)
    const toolCallId=typeof event?.toolCallId==="string"?event.toolCallId:""
    const pending=receiptByToolCall.get(toolCallId)
    if(pending){
      receiptByToolCall.delete(toolCallId)
      const isError=event?.isError===true
      const tool=String(event?.toolName||"unknown").toLowerCase()
      // A delivered ask answer is the whole effect: the agent received it iff the tool returned.
      const state:"succeeded"|"failed"|"unknown" = tool==="write"||tool==="edit"||tool==="ask"?(isError?"failed":"succeeded"):"unknown"
      const evidence={tool,isError,output:truncateUtf8(textFrom(event),2000)}
      const observation={receipt_id:pending.receiptId,toolCallId,attempt_id:pending.attemptId,effect:pending.effect,effect_state:state,evidence};emitEffect(observation)
      void globalThis.fetch(`http://127.0.0.1:${approvalGate?.webPort??DEFAULT_WEB_PORT}/api/decision/effect`,{method:"POST",headers:{"Content-Type":"application/json","Origin":`http://127.0.0.1:${approvalGate?.webPort??DEFAULT_WEB_PORT}`},body:JSON.stringify(observation)}).catch(()=>{})
    }
  })

  on("session_shutdown", async (event) => {
    working = false
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    for(const [toolCallId,pending] of receiptByToolCall){emitEffect({receipt_id:pending.receiptId,toolCallId,attempt_id:pending.attemptId,effect:pending.effect,effect_state:"unknown",evidence:{reason:"session_ended_before_tool_result"}})}
    for(const target of askTargets.values())cancelAskTarget(target)
    askTargets.clear()
    receiptByToolCall.clear()
    emit("session_ended", { reason: event?.reason || "quit" })
    await spool.flushAndSeal().catch(() => {})
  })
}
