// @overload-event-source
// Approval gate v0 is a local, deterministic pre-tool denylist. It is disabled by
// default, never waits for a remote decision, and fails open (with one warning) if
// its session-start configuration cannot be parsed or compiled.
// Intentionally has no package imports: pi, omp, and prime-agent expose compatible
// extension APIs under different package names.
import { constants } from "node:fs"
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { execFile, execFileSync } from "node:child_process"

const SEGMENT_MAX_AGE_MS = 30_000
const SEGMENT_MAX_BYTES = 1_048_576
const HEARTBEAT_INTERVAL_MS = 60_000
const TOOL_ACTIVITY_INTERVAL_MS = 5_000
const WRITE_QUEUE_LIMIT = 1000
const procBootId = randomUUID()

type Runtime = "pi" | "omp" | "prime"
type Kind =
  | "session_started" | "working" | "settled" | "decision_requested"
  | "decision_resolved" | "tool_activity" | "heartbeat"
  | "commit_observed" | "session_ended"

type Envelope = {
  v: 1
  at: number
  host: "local" | "devbox"
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

type WebAnswer = { request_uid: string; option: string | null; text: string | null }
type AskQuestion = {
  id?: string
  question?: string
  header?: string
  options?: Array<string | { label?: string; description?: string }>
  multi?: boolean
}

const ASK_SCHEMA = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          id: { type: "string" }, question: { type: "string" }, header: { type: "string" },
          options: { type: "array", items: { type: "object", properties: { label: { type: "string" }, description: { type: "string" } }, required: ["label"] } },
          multi: { type: "boolean" }, recommended: { type: "number" },
        },
        required: ["question", "options"],
      },
    },
  },
  required: ["questions"],
}

function answerPath(requestUid: string): string {
  return join(process.env.OVERLOAD_ANSWERS_DIR || join(homedir(), ".overload", "answers"), `${requestUid}.json`)
}

async function takeWebAnswer(requestUid: string): Promise<WebAnswer | undefined> {
  const path = answerPath(requestUid)
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<WebAnswer>
    await unlink(path)
    if (parsed.request_uid !== requestUid) return undefined
    const option = typeof parsed.option === "string" ? parsed.option : null
    const text = typeof parsed.text === "string" ? parsed.text : null
    return option !== null || text !== null ? { request_uid: requestUid, option, text } : undefined
  } catch (error: any) {
    if (error?.code !== "ENOENT") {
      try { await unlink(path) } catch {}
    }
    return undefined
  }
}

async function pollWebAnswer(requestUid: string, signal: AbortSignal): Promise<WebAnswer | undefined> {
  while (!signal.aborted) {
    const answer = await takeWebAnswer(requestUid)
    if (answer) return answer
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000)
      signal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }
  return undefined
}

function optionLabels(question: AskQuestion): string[] {
  return (question.options || []).map((option) => typeof option === "string" ? option : String(option.label || "")).filter(Boolean)
}

function askResult(question: AskQuestion, answer: WebAnswer): Record<string, unknown> {
  const options = optionLabels(question)
  const selected = answer.option && options.includes(answer.option) ? [answer.option] : []
  const customInput = answer.text || undefined
  const text = [selected.length ? `Selected: ${selected.join(", ")}` : "", customInput ? `User input: ${customInput}` : ""].filter(Boolean).join("\n")
  return {
    content: [{ type: "text", text: text || "No answer supplied" }],
    details: { question: question.question, options, multi: question.multi === true, selectedOptions: selected, customInput },
  }
}

type ApprovalGate = {
  bash: Array<{ source: string; pattern: RegExp }>
  writePaths: string[]
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

function scrub(text: string): string {
  return text
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_A-Za-z0-9]{12,}\b/gi, "[REDACTED]")
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

function hostContext(): Record<string, string> | undefined {
  let environment = { ...process.env } as Record<string, string | undefined>;
  const directHost = environment.CMUX_SURFACE_ID ? "cmux" : undefined;
  let pid = process.ppid;
  for (let depth = 0; !directHost && depth < 6; depth++) {
    try {
      const output = execFileSync("/bin/ps", ["eww", "-p", String(pid)], { timeout: 50, stdio: ["ignore", "pipe", "ignore"] }).toString();
      const match = output.match(/CMUX_SURFACE_ID=([^\s]+)/);
      if (match?.[1]) {
        environment = { CMUX_SURFACE_ID: match[1] };
        break;
      }
      const parent = execFileSync("/bin/ps", ["-p", String(pid), "-o", "ppid="], { timeout: 50, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      pid = Number(parent);
      if (!Number.isSafeInteger(pid) || pid < 2) break;
    } catch { break; }
  }
  const sessionId = environment.CMUX_SURFACE_ID;
  if (!sessionId) return undefined;
  let tty: string | undefined;
  try {
    const value = execFileSync("/usr/bin/tty", [], { timeout: 50, stdio: ["inherit", "pipe", "ignore"] }).toString().trim();
    if (value.startsWith("/dev/")) tty = value;
  } catch { /* no controlling terminal */ }
  return { app: "cmux", session_id: sessionId, ...(tty ? { tty } : {}) };
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
  host: "local" | "devbox" = "local"
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
        const configured = (await readFile(join(root, "host"), "utf8")).trim()
        if (configured === "devbox") this.host = "devbox"
      } catch {
        // Missing/unreadable host configuration deliberately falls back to local.
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
      const item = this.queue.shift()!
      // Counters describe all failures known at the instant of the write attempt.
      item.dropped_total = this.droppedTotal
      item.write_error_total = this.writeErrorTotal
      const line = `${JSON.stringify(item)}\n`
      try {
        const handle = await open(
          this.activePath,
          constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        )
        try {
          await handle.chmod(0o600)
          await handle.writeFile(line, "utf8")
        } finally {
          await handle.close()
        }
        this.segmentBytes += Buffer.byteLength(line)
        this.armSealTimer()
        if (this.segmentBytes >= SEGMENT_MAX_BYTES) await this.seal()
      } catch {
        this.writeErrorTotal++
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
  // pi's question tool is the bundled "ask-user" npm extension; registering a
  // tool under the same name makes pi REFUSE TO START (load conflict, proven
  // live). So always register our answerable tool as "ask" (overrides omp's
  // built-in; coexists on pi) and observe both spellings in hooks. On pi,
  // asks made via the bundled ask_user are captured but not web-answerable.
  const isAskTool = (name: unknown) => name === "ask" || name === "ask_user"
  const headByCwd = new Map<string, string>()
  let session = safeComponent(randomUUID(), "session")
  let stableId = ""
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

  if (pi.registerTool) {
    pi.registerTool({
      name: "ask",
      label: "Ask",
      description: "Ask the user one or more questions and wait for an answer from the TUI or Overload.",
      parameters: ASK_SCHEMA,
      async execute(toolCallId: string, params: { questions?: AskQuestion[] }, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
        const question = params.questions?.[0] || {}
        const requestUid = `${stableId}#${spool.writerId}#${toolCallId}`
        const pollController = new AbortController()
        const dialogController = new AbortController()
        const abort = () => { pollController.abort(); dialogController.abort() }
        signal?.addEventListener("abort", abort, { once: true })

        const tui = (async () => {
          const labels = optionLabels(question)
          const selected = labels.length
            ? await ctx.ui.select(question.question || "Decision required", labels, { signal: dialogController.signal })
            : undefined
          const text = selected === undefined
            ? await ctx.ui.input(question.question || "Decision required", undefined, { signal: dialogController.signal })
            : undefined
          if (selected === undefined && text === undefined) throw new Error("Ask tool was cancelled by the user")
          return askResult(question, { request_uid: requestUid, option: selected || null, text: text || null })
        })()
        // Avoid an aborting loser becoming an unhandled rejection after Promise.race.
        tui.catch(() => undefined)

        try {
          const aborted = new Promise<never>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("Ask tool was cancelled by the user")), { once: true }))
          const winner = await Promise.race([
            tui.then((result) => ({ source: "tui" as const, result })),
            pollWebAnswer(requestUid, pollController.signal).then((answer) => answer ? ({ source: "web" as const, result: askResult(question, answer) }) : new Promise<never>(() => {})),
            aborted,
          ])
          if (winner.source === "web") dialogController.abort()
          else pollController.abort()
          return winner.result
        } finally {
          abort()
          signal?.removeEventListener("abort", abort)
        }
      },
    })
  }

  function warnAndDisableGate(error: unknown): void {
    approvalGate = null
    if (gateWarned) return
    gateWarned = true
    console.warn("[overload] invalid approval_gate configuration; gate disabled:", (error as Error)?.message || error)
  }

  async function loadApprovalGate(): Promise<void> {
    approvalGate = null
    try {
      let raw: string
      try {
        raw = await readFile(join(homedir(), ".overload", "config.json"), "utf8")
      } catch (error: any) {
        if (error?.code === "ENOENT") return
        throw error
      }
      const config = JSON.parse(raw)
      const gate = config?.approval_gate
      if (gate === undefined) return
      if (!gate || typeof gate !== "object" || typeof gate.enabled !== "boolean") {
        throw new Error("approval_gate must contain a boolean enabled field")
      }
      // Review P4 m3: a disabled gate is inert by definition — never validate
      // (and thus never warn about) rule shapes the gate will not use.
      if (!gate.enabled) return
      if (!Array.isArray(gate.block_bash_patterns) || !gate.block_bash_patterns.every((value: unknown) => typeof value === "string")) {
        throw new Error("block_bash_patterns must be an array of strings")
      }
      if (!Array.isArray(gate.block_write_paths) || !gate.block_write_paths.every((value: unknown) => typeof value === "string")) {
        throw new Error("block_write_paths must be an array of strings")
      }
      approvalGate = {
        bash: gate.block_bash_patterns.map((source: string) => ({ source, pattern: new RegExp(source) })),
        writePaths: [...gate.block_write_paths],
      }
    } catch (error) {
      warnAndDisableGate(error)
    }
  }

  function gateRule(event: any): string | undefined {
    const gate = approvalGate
    if (!gate) return undefined
    if (event?.toolName === "bash" && typeof event?.input?.command === "string") {
      for (const rule of gate.bash) {
        rule.pattern.lastIndex = 0
        if (rule.pattern.test(event.input.command)) return rule.source
      }
      return undefined
    }
    if ((event?.toolName === "write" || event?.toolName === "edit") && typeof event?.input?.path === "string") {
      for (const path of gate.writePaths) {
        if (event.input.path.startsWith(path)) return path
      }
    }
    return undefined
  }

  function setWorking(): void {
    settledForRun = false
    if (!working) {
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

  function settle(): void {
    if (!working || settledForRun) return
    working = false
    settledForRun = true
    emit("settled", {
      ...(lastAssistantText ? { text: truncateUtf8(lastAssistantText) } : {}),
      // Review P4 B1: resident change flag flushed with every settle so the
      // classifier never depends on a throttled tool_activity row alone.
      change_evidence: changeEvidenceSeen,
    })
  }

  function settleAgentLifecycle(): void {
    if (settledForRun) return
    // Some hosts dispatch the terminal agent event even when an earlier lifecycle
    // callback was skipped during print-mode setup. Reconstruct the required
    // transition here rather than silently losing both working and settled.
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
            return (result as Promise<unknown>).catch(() => {})
          }
          return result
        } catch {
          // Telemetry must never throw out of an extension handler.
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
      const host = hostContext()
      if (host) detail.host = host
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

  on("tool_call", (event) => {
    const now = Date.now()
    const tool = String(event?.toolName || "unknown")
    // Review P4 B1: the 5s throttle must never suppress CHANGE evidence —
    // the first change-capable call always emits (unthrottled) and latches a
    // resident flag that is also flushed with settled/session_ended details.
    const changeCapable = /^(bash|write|edit)$/i.test(tool)
    if (changeCapable && !changeEvidenceSeen) {
      changeEvidenceSeen = true
      lastToolActivity = now
      emit("tool_activity", { tool: truncateUtf8(tool, 80), change: true })
    } else if (now - lastToolActivity >= TOOL_ACTIVITY_INTERVAL_MS) {
      lastToolActivity = now
      emit("tool_activity", { tool: truncateUtf8(tool, 80), ...(changeCapable ? { change: true } : {}) })
    }
    if (isAskTool(event?.toolName) && typeof event.toolCallId === "string") {
      pendingAsk.add(event.toolCallId)
      emit("decision_requested", { request_id: event.toolCallId, ...questionPayload(event.input) })
    }
    const rule = gateRule(event)
    if (rule !== undefined && typeof event?.toolCallId === "string") {
      const detail = { request_id: event.toolCallId, gated: true }
      emit("decision_requested", detail)
      emit("decision_resolved", { ...detail, state: "cancelled" })
      return { block: true, reason: `overload approval gate: ${rule}` }
    }
    if (event?.toolName !== "bash" || !event.input || typeof event.input.command !== "string") return
    const command = event.input.command
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
    // A TUI winner may race a web write. Remove that losing answer lazily.
    void unlink(answerPath(`${stableId}#${spool.writerId}#${event.toolCallId}`)).catch(() => undefined)
    const selected = selectedOption(event.result)
    emit("decision_resolved", {
      request_id: event.toolCallId,
      // Explicit terminal state: ask erroring out (user escape/abort) is a
      // cancellation, never a successful resolution (review B1).
      state: event.isError ? "cancelled" : "resolved",
      ...(selected ? { selected } : {}),
      ...(event.isError ? { error: true } : {}),
    })
  })

  on("tool_result", (event, ctx) => {
    if (event?.toolName === "bash") probeHead(String(ctx?.cwd || process.cwd()), true)
  })

  on("session_shutdown", async (event) => {
    working = false
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    emit("session_ended", { reason: event?.reason || "quit" })
    await spool.flushAndSeal().catch(() => {})
  })
}
