import { createServer, createConnection, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, appendFileSync, renameSync, chmodSync, openSync, closeSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { CommandReceipt, RuntimeEvent, SessionReference } from "./types";


type JsonObject = Record<string, unknown>;

// Generic tool names only (fast-channel §5.2): anything else is "tool", so no raw string from a
// tool call ever reaches a RuntimeEvent. The regex is a second guard on the allowlist itself.
const SAFE_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "test"]);
export function safeToolName(raw: unknown): string {
  if (typeof raw !== "string") return "tool";
  const name = raw.trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,15}$/.test(name) && SAFE_TOOL_NAMES.has(name) ? name : "tool";
}

// Maps a Pi tool_execution_start/end record to a fact carrying only ids and the generic name.
// The event id is derived from (session, turn, hashed toolCallId, phase) so a re-delivered record
// yields the same eventId; the raw toolCallId is hashed because Pi/providers control its content.
export function toolActivityEvent(record: JsonObject, sessionId: string, turnId: string): RuntimeEvent | undefined {
  const type = stringValue(record.type);
  if (type !== "tool_execution_start" && type !== "tool_execution_end") return undefined;
  const callId = stringValue(record.toolCallId);
  if (!callId) return undefined;
  const kind = type === "tool_execution_start" ? "tool_started" : "tool_finished";
  const digest = createHash("sha256").update(callId).digest("hex").slice(0, 24);
  return { eventId: `tool:${sessionId}:${turnId}:${digest}:${kind}`, sessionId, turnId, kind, toolName: safeToolName(record.toolName) };
}
type PiStdin = { write(data: string): number | Promise<number>; flush?: () => void | Promise<void> };
type PiProcess = { stdin: unknown; stdout: unknown; stderr: unknown; exited: Promise<number>; kill?: (signal?: string) => void };
type AsyncBytes = AsyncIterable<Uint8Array>;

export class JsonlFramer {
  private pending = "";
  push(chunk: string | Uint8Array): JsonObject[] {
    this.pending += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk, { stream: true });
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    const values: JsonObject[] = [];
    for (const line of lines) {
      const text = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (!text) continue;
      const value: unknown = JSON.parse(text);
      if (!isObject(value)) throw new Error("rpc_non_object_record");
      values.push(value);
    }
    return values;
  }
  finish(): JsonObject[] {
    if (!this.pending) return [];
    const text = this.pending.endsWith("\r") ? this.pending.slice(0, -1) : this.pending;
    this.pending = "";
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) throw new Error("rpc_non_object_record");
    return [value];
  }
}

function isObject(value: unknown): value is JsonObject { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function boolValue(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
function numberValue(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }
function sendSocket(socket: Socket, value: JsonObject): void { if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`); }
function safeUnlink(path: string): void { try { unlinkSync(path); } catch { /* stale socket is optional */ } }
function atomicWrite(path: string, content: string): void { const temp = `${path}.${process.pid}.${randomUUID()}.tmp`; writeFileSync(temp, content, { mode: 0o600 }); renameSync(temp, path); }

export type ProcessIdentity = { pid: number; startIdentity: string; bootIdentity: string };
export type ProcessLiveness = "alive" | "dead" | "unknown";

function commandOutput(argv: string[]): string | undefined {
  try {
    const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    if (result.exitCode !== 0) return undefined;
    return new TextDecoder().decode(result.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

function procStartIdentity(pid: number): string | undefined {
  if (process.platform === "darwin") return commandOutput(["/bin/ps", "-p", String(pid), "-o", "lstart="]);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const end = stat.lastIndexOf(")");
    if (end < 0) return undefined;
    const fields = stat.slice(end + 2).trim().split(/\s+/);
    return fields[19];
  } catch { return undefined; }
}

function procBootIdentity(): string | undefined {
  if (process.platform === "darwin") return commandOutput(["/usr/sbin/sysctl", "-n", "kern.boottime"]);
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || undefined; } catch { return undefined; }
}

export function captureProcessIdentity(pid: number): ProcessIdentity | null {
  const startIdentity = procStartIdentity(pid);
  const bootIdentity = procBootIdentity();
  if (!startIdentity || !bootIdentity) return null;
  return { pid, startIdentity, bootIdentity };
}

export function processLiveness(pid: number | undefined, startIdentity: string | undefined, bootIdentity: string | undefined): ProcessLiveness {
  if (pid === undefined || !Number.isInteger(pid) || !startIdentity || !bootIdentity) return "unknown";
  const current = captureProcessIdentity(pid);
  if (current) {
    return current.startIdentity === startIdentity && current.bootIdentity === bootIdentity ? "alive" : "dead";
  }
  try {
    process.kill(pid!, 0);
    return "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
  }
}

type LockRecord = { pid: number; startIdentity: string; bootIdentity: string; acquiredAt: number; token: string };
export type OwnershipLease = { release(): void };
export const ownershipLockPath = (metadataPath: string): string => `${metadataPath}.lock`;
export const brokerLockPath = (metadataPath: string): string => `${metadataPath}.broker.lock`;

function readLock(path: string): LockRecord | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObject(value) || typeof value.pid !== "number" || typeof value.startIdentity !== "string" || typeof value.bootIdentity !== "string" || typeof value.acquiredAt !== "number" || typeof value.token !== "string") return null;
    return value as unknown as LockRecord;
  } catch { return null; }
}

export async function acquireOwnershipLock(path: string, timeoutMs = 1_000): Promise<OwnershipLease> {
  const identity = captureProcessIdentity(process.pid);
  if (!identity) throw new Error("runtime_owner_identity_unavailable");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + Math.max(1, timeoutMs);
  while (Date.now() <= deadline) {
    const token = randomUUID();
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      const record: LockRecord = { ...identity, acquiredAt: Date.now(), token };
      writeSync(fd, Buffer.from(JSON.stringify(record)));
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try { closeSync(fd!); } catch { /* already closed */ }
          const current = readLock(path);
          if (current?.token === token) safeUnlink(path);
        },
      };
    } catch (error) {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* best effort */ } }
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const current = readLock(path);
      if (!current) throw new Error("runtime_ownership_lock_unknown");
      const state = processLiveness(current.pid, current.startIdentity, current.bootIdentity);
      if (state === "alive") {
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
        continue;
      }
      if (state === "unknown") throw new Error("runtime_ownership_lock_unknown");
      try { unlinkSync(path); } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("runtime_ownership_contended");
}

export type PiBrokerConfig = {
  runtimeRoot: string;
  metadataPath: string;
  socketPath: string;
  sessionId: string;
  ownerId: string;
  ownerToken: string;
  cwd: string;
  provider?: string;
  model?: string;
  sessionFile?: string;
  command: string;
  stderrLimit: number;
  coordinator?:{endpoint:string;token:string;workId:string};
  readOnly?:boolean;
  configPath?:string;
};

type BrokerMetadata = PiBrokerConfig & { pid: number; brokerIdentity?:ProcessIdentity;childIdentity?:ProcessIdentity;state: "starting" | "running" | "stopped"; stderrTail?: string; exitCode?: number; updatedAt: number };
type ClientState = { socket: Socket; framer: JsonlFramer; hello: boolean };
type PendingCommand = { socket: Socket; commandId: string; turnId?: string; type: string };
type JournalRow = { seq: number; event: RuntimeEvent };

const makeReference = (config: PiBrokerConfig, sessionFile?: string): SessionReference => ({
  runtimeKind: "pi", sessionId: config.sessionId, ownerId: config.ownerId, cwd: config.cwd, ...(sessionFile ? { sessionFile } : {}),
});

export function buildPiBrokerInvocation(config: PiBrokerConfig): string[] {
  const argv = [config.command, "--mode", "rpc", "--session-dir", join(config.runtimeRoot, "sessions"), "--no-extensions", "--extension", join(import.meta.dir, "../extension/overload.ts")];
  if (config.provider) argv.push("--provider", config.provider);
  if (config.model) argv.push("--model", config.model);
  if (config.sessionFile) argv.push("--session", config.sessionFile);
  if (config.coordinator || config.readOnly) argv.push("--tools", config.coordinator ? "read,grep,find,ls,coordinator_dispatch,coordinator_status,coordinator_review,coordinator_deliver" : "read,grep,find,ls");
  if (config.coordinator) argv.push("-e", join(import.meta.dir, "../extension/coordinator.ts"));
  return argv;
}

class PiBroker {
  private server: Server | undefined;
  private child: PiProcess | undefined;
  private childIdentity:ProcessIdentity|undefined;
  private ownershipLease:OwnershipLease|undefined;
  private readonly clients = new Set<ClientState>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly pendingHello = new Set<ClientState>();
  private readonly childFramer = new JsonlFramer();
  private readonly journalPath: string;
  private readonly eventSeq = { value: 0 };
  private readonly issued=new Set<string>();
  private readonly toolEventIds=new Set<string>(); // broker-level dedupe of re-delivered tool records; cleared at turn end
  private activeTurn: { turnId: string; commandId: string; cancelRequested: boolean; failureReason?: string } | undefined;
  private shutdownRequested = false;
  private sessionFile: string | undefined;
  private stderrTail = "";
  private stopping = false;
  private stateReadyResolve!: (ok: boolean) => void;
  private readonly stateReady: Promise<boolean>;
  private stateReadyDone = false;

  constructor(private readonly config: PiBrokerConfig) {
    this.journalPath = join(config.runtimeRoot, "events", `${config.sessionId}.ndjson`);
    this.sessionFile = config.sessionFile;
    this.stateReady = new Promise(resolve => { this.stateReadyResolve = resolve; });
  }

  async run(): Promise<void> {
    mkdirSync(dirname(this.config.metadataPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.config.socketPath), { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.journalPath), { recursive: true, mode: 0o700 });
    this.ownershipLease=await acquireOwnershipLock(brokerLockPath(this.config.metadataPath),1000);
    safeUnlink(this.config.socketPath);
    this.loadJournalSequence();
    const commandsPath=this.journalPath+'.commands';if(existsSync(commandsPath))for(const key of readFileSync(commandsPath,'utf8').split('\n'))if(key)this.issued.add(key);
    this.writeMetadata("starting");
    this.server = createServer(socket => this.acceptSocket(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.config.socketPath, () => {
        chmodSync(this.config.socketPath, 0o600);
        resolve();
      });
    });
    this.spawnChild();
    const childExit = await this.child!.exited;
    await this.onChildExit(childExit);
  }

  private loadJournalSequence(): void {
    if (!existsSync(this.journalPath)) return;
    const text = readFileSync(this.journalPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isObject(parsed)) this.eventSeq.value = Math.max(this.eventSeq.value, numberValue(parsed.seq) ?? 0);
      } catch { /* a torn final line is ignored; complete records remain durable */ }
    }
  }

  private writeMetadata(state: BrokerMetadata["state"], exitCode?: number): void {
    const value: BrokerMetadata = {
      ...this.config, pid: process.pid, state, updatedAt: Date.now(),
      brokerIdentity:captureProcessIdentity(process.pid)??undefined,childIdentity:this.childIdentity,
      ...(this.sessionFile ? { sessionFile: this.sessionFile } : {}),
      ...(this.stderrTail ? { stderrTail: this.stderrTail } : {}), ...(exitCode === undefined ? {} : { exitCode }),
    };
    atomicWrite(this.config.metadataPath, JSON.stringify(value));
  }

  private spawnChild(): void {
    const argv = buildPiBrokerInvocation(this.config);
    const coordinator=this.config.coordinator;
    const proc = Bun.spawn(argv, { cwd: this.config.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe",env:{...process.env,OVERLOAD_RUNTIME_SESSION_ID:this.config.sessionId,...(this.config.configPath?{OVERLOAD_CONFIG_PATH:this.config.configPath}:{}),...(coordinator?{OVERLOAD_COORDINATOR_ENDPOINT:coordinator.endpoint,OVERLOAD_COORDINATOR_TOKEN:coordinator.token,OVERLOAD_COORDINATOR_WORK_ID:coordinator.workId}:{})} }) as unknown as PiProcess & { pid: number };
    this.childIdentity=captureProcessIdentity(proc.pid)??undefined;
    this.child = proc;
    this.writeMetadata("running");
    void this.readStdout(proc.stdout as AsyncBytes);
    void this.readStderr(proc.stderr as AsyncBytes);
    void this.sendPi({ id: "__overload_state__", type: "get_state" });
    setTimeout(() => this.resolveState(false), 5000).unref?.();
  }

  private async readStdout(stream: AsyncBytes): Promise<void> {
    try {
      for await (const chunk of stream) {
        let records: JsonObject[];
        try { records = this.childFramer.push(chunk); } catch (error) { this.failProtocol(String(error)); return; }
        for (const record of records) this.handlePiRecord(record);
      }
      for (const record of this.childFramer.finish()) this.handlePiRecord(record);
    } catch (error) { this.failProtocol(String(error)); }
  }

  private async readStderr(stream: AsyncBytes): Promise<void> {
    try {
      for await (const chunk of stream) {
        const text = new TextDecoder().decode(chunk);
        this.stderrTail = `${this.stderrTail}${text}`.slice(-this.config.stderrLimit);
      }
    } catch { /* exit status remains authoritative */ }
  }

  private failProtocol(reason: string): void {
    this.resolveState(false);
    if (this.activeTurn) this.publish({ eventId: randomUUID(), sessionId: this.config.sessionId, turnId: this.activeTurn.turnId, kind: "unknown", reason });
  }

  private resolveState(ok: boolean): void {
    if (this.stateReadyDone) return;
    this.stateReadyDone = true;
    this.stateReadyResolve(ok);
  }

  private async sendPi(command: JsonObject): Promise<void> {
    const stdin = this.child?.stdin as PiStdin | undefined;
    if (!stdin) throw new Error("pi_stdin_unavailable");
    await stdin.write(`${JSON.stringify(command)}\n`);
    await stdin.flush?.();
  }

  private handlePiRecord(record: JsonObject): void {
    if (stringValue(record.type) === "response") { this.handleResponse(record); return; }
    this.handleEvent(record);
  }

  private handleResponse(record: JsonObject): void {
    const id = stringValue(record.id);
    if (id === "__overload_state__") {
      const data = isObject(record.data) ? record.data : undefined;
      const sessionFile = data ? stringValue(data.sessionFile) : undefined;
      if (boolValue(record.success) && sessionFile) {
        this.sessionFile = sessionFile;
        this.resolveState(true);
        this.writeMetadata("running");
        this.flushHello(true);
      } else {
        this.resolveState(false);
        this.flushHello(false);
      }
      return;
    }
    if (!id) return;
    const command = this.pending.get(id);
    if (!command) return;
    this.pending.delete(id);
    const success = boolValue(record.success) === true;
    const type = command.type;
    if (type === "prompt" && command.turnId) {
      if (success && !this.activeTurn) this.activeTurn = { turnId: command.turnId, commandId: id, cancelRequested: false };
      if (!success && this.activeTurn?.commandId === id) this.activeTurn = undefined;
    }
    sendSocket(command.socket, { type: "command_response", commandId: id, state: success ? "accepted" : "rejected", ...(success ? {} : { reason: stringValue(record.error) ?? "pi_rejected" }) });
  }

  private handleEvent(record: JsonObject): void {
    const type = stringValue(record.type);
    if (type === "extension_ui_request") {
      const method = stringValue(record.method);
      const id = stringValue(record.id);
      if (!id || (method !== "select" && method !== "confirm" && method !== "input" && method !== "editor")) return;
      const options = method === "select" ? (Array.isArray(record.options) ? record.options.filter((v): v is string => typeof v === "string") : []) : method === "confirm" ? ["yes", "no"] : undefined;
      const timeout = numberValue(record.timeout);
      const event: RuntimeEvent = { eventId: randomUUID(), sessionId: this.config.sessionId, ...(this.activeTurn ? { turnId: this.activeTurn.turnId } : {}), kind: "blocked", requestId: id, requestMethod: method, text: stringValue(record.title) ?? stringValue(record.message), ...(options?.length ? { options } : {}), ...(timeout !== undefined ? { expiresAt: Date.now() + timeout } : {}) };
      this.publish(event);
      return;
    }
    if (type === "message_end" && isObject(record.message) && record.message.role === "assistant") {
      const stopReason = stringValue(record.message.stopReason);
      if (this.activeTurn && (stopReason === "error" || stopReason === "aborted")) {
        this.activeTurn.failureReason = stringValue(record.message.errorMessage) ?? stopReason;
        if (stopReason === "aborted") this.activeTurn.cancelRequested = true;
      }
      return;
    }
    if (type === "agent_settled") {
      if (!this.activeTurn) return;
      const active = this.activeTurn;
      const kind = active.cancelRequested ? "unknown" : active.failureReason ? "failed" : "completed";
      this.publish({ eventId: randomUUID(), sessionId: this.config.sessionId, turnId: active.turnId, kind, ...(active.failureReason ? { reason: active.failureReason } : {}) });
      this.activeTurn = undefined;
      this.toolEventIds.clear();
      return;
    }
    if (type === "extension_error") {
      if (this.activeTurn) this.activeTurn.failureReason = stringValue(record.error) ?? "extension_error";
      return;
    }
    if (type === "tool_execution_start" || type === "tool_execution_end") {
      if (!this.activeTurn) return;
      const event = toolActivityEvent(record, this.config.sessionId, this.activeTurn.turnId);
      if (!event || this.toolEventIds.has(event.eventId)) return;
      this.toolEventIds.add(event.eventId);
      this.publish(event);
      return;
    }
    if (type === "message_update") {
      const update = isObject(record.assistantMessageEvent) ? record.assistantMessageEvent : undefined;
      const delta = update?.type === "text_delta" ? stringValue(update.delta) : undefined;
      if (delta && this.activeTurn) this.publish({ eventId: randomUUID(), sessionId: this.config.sessionId, turnId: this.activeTurn.turnId, kind: "output", text: delta });
    }
  }

  private requestShutdown(): void {
    if (this.shutdownRequested) return;
    this.shutdownRequested = true;
    this.child?.kill?.("SIGTERM");
  }

  private publish(event: RuntimeEvent): void {
    const row: JournalRow = { seq: ++this.eventSeq.value, event };
    appendFileSync(this.journalPath, `${JSON.stringify(row)}\n`, { mode: 0o600 });
    for (const client of this.clients) sendSocket(client.socket, { type: "event", seq: row.seq, event });
  }

  private acceptSocket(socket: Socket): void {
    const client: ClientState = { socket, framer: new JsonlFramer(), hello: false };
    socket.on("data", chunk => {
      try {
        for (const record of client.framer.push(chunk)) this.handleClientRecord(client, record);
      } catch (error) { sendSocket(socket, { type: "error", reason: String(error) }); socket.destroy(); }
    });
    socket.on("close", () => { this.clients.delete(client); this.pendingHello.delete(client); });
    socket.on("error", () => { this.clients.delete(client); this.pendingHello.delete(client); });
  }

  private handleClientRecord(client: ClientState, record: JsonObject): void {
    const op = stringValue(record.op);
    if (!client.hello) {
      if (op !== "hello" || stringValue(record.token) !== this.config.ownerToken) { sendSocket(client.socket, { type: "error", reason: "runtime_ownership_rejected" }); client.socket.destroy(); return; }
      client.hello = true;
      for (const old of this.clients) if (old !== client) { old.socket.destroy(); this.clients.delete(old); }
      this.clients.add(client);
      const after = numberValue(record.after) ?? 0;
      this.replay(client.socket, after);
      if (this.stateReadyDone) this.sendHello(client, this.stateReadyDone && !!this.sessionFile);
      else this.pendingHello.add(client);
      return;
    }
    if (op !== "command" || stringValue(record.token) !== this.config.ownerToken) { sendSocket(client.socket, { type: "error", reason: "runtime_ownership_rejected" }); return; }
    const commandId = stringValue(record.commandId);
    const payload = isObject(record.payload) ? record.payload : undefined;
    const turnId = stringValue(record.turnId);
    if (!commandId || !payload) { sendSocket(client.socket, { type: "command_response", commandId: commandId ?? "", state: "rejected", reason: "malformed_command" }); return; }
    const type = stringValue(payload.type);
    if (!type) { sendSocket(client.socket, { type: "command_response", commandId, state: "rejected", reason: "missing_command_type" }); return; }
    if (!this.clients.has(client) || client.socket.destroyed) return;
    if ((type === "prompt" && !turnId) || ((type === "abort" || type === "clear_queue") && (!turnId || !this.activeTurn || this.activeTurn.turnId !== turnId))) {
      sendSocket(client.socket, { type: "command_response", commandId, state: "rejected", reason: type === "prompt" ? "missing_turn_id" : "turn_not_active" });
      return;
    }
    if (type === "prompt" && (this.activeTurn || [...this.pending.values()].some(p => p.type === "prompt"))) {
      sendSocket(client.socket, { type: "command_response", commandId, state: "rejected", reason: "turn_in_flight" });
      return;
    }
    const key = type === "prompt" ? `turn:${turnId}` : type === "extension_ui_response" ? `answer:${stringValue(payload.id)}` : `command:${commandId}`;
    if (this.issued.has(key)) { sendSocket(client.socket, { type: "command_response", commandId, state: "unknown", reason: "command_already_issued" }); return; }
    appendFileSync(this.journalPath + ".commands", key + "\n", { mode: 0o600 });
    this.issued.add(key);
    if (type === "shutdown") {
      sendSocket(client.socket, { type: "command_response", commandId, state: "accepted" });
      this.requestShutdown();
      return;
    }
    if (type === "abort" && this.activeTurn && this.activeTurn.turnId === turnId) this.activeTurn.cancelRequested = true;
    if (type === "extension_ui_response") {
      void this.sendPi(payload).then(() => sendSocket(client.socket, { type: "command_response", commandId, state: "accepted" })).catch(error => sendSocket(client.socket, { type: "command_response", commandId, state: "unknown", reason: String(error) }));
      return;
    }
    this.pending.set(commandId, { socket: client.socket, commandId, turnId, type });
    if (type === "prompt" && turnId) this.activeTurn = { turnId, commandId, cancelRequested: false };
    void this.sendPi({ ...payload, id: commandId }).catch(error => {
      this.pending.delete(commandId);
      sendSocket(client.socket, { type: "command_response", commandId, state: "unknown", reason: String(error) });
    });
  }

  private replay(socket: Socket, after: number): void {
    if (!existsSync(this.journalPath)) return;
    const text = readFileSync(this.journalPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (!isObject(parsed)) continue;
        const seq = numberValue(parsed.seq) ?? 0;
        if (seq > after) sendSocket(socket, { type: "event", seq, event: parsed.event });
      } catch { /* ignore only torn/unreadable journal rows */ }
    }
  }

  private sendHello(client: ClientState, ok: boolean): void {
    if (!ok || !this.sessionFile) { sendSocket(client.socket, { type: "hello", ok: false, reason: "session_file_unavailable" }); return; }
    sendSocket(client.socket, { type: "hello", ok: true, reference: makeReference(this.config, this.sessionFile), seq: this.eventSeq.value, ...(this.activeTurn ? { activeTurnId: this.activeTurn.turnId } : {}) });
  }

  private flushHello(ok: boolean): void {
    for (const client of this.pendingHello) { this.pendingHello.delete(client); this.sendHello(client, ok); }
  }

  private async onChildExit(exitCode: number): Promise<void> {
    if (this.stopping) return;
    this.resolveState(false);
    for (const command of this.pending.values()) sendSocket(command.socket, { type: "command_response", commandId: command.commandId, state: "unknown", reason: "pi_child_exit" });
    this.pending.clear();
    if (this.activeTurn) {
      this.publish({ eventId: randomUUID(), sessionId: this.config.sessionId, turnId: this.activeTurn.turnId, kind: "unknown", reason: "pi_child_exit" });
      this.activeTurn = undefined;
    }
    this.writeMetadata("stopped", exitCode);
    this.stopping = true;
    for (const client of this.clients) client.socket.destroy();
    await new Promise<void>(resolve => this.server?.close(() => resolve()) ?? resolve());
    safeUnlink(this.config.socketPath);
    this.ownershipLease?.release();
  }
}

export async function runPiBroker(config: PiBrokerConfig): Promise<void> {
  await new PiBroker(config).run();
}

export function connectPiBroker(socketPath: string, token: string, after: number, timeoutMs = 5000): Promise<PiBrokerClient> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const framer = new JsonlFramer();
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("runtime_connect_timeout")); }, timeoutMs);
    const client = new PiBrokerClient(socket, framer, token, after, timeoutMs);
    socket.once("error", error => { clearTimeout(timer); reject(error); client.fail(error); });
    socket.on("data", chunk => {
      try { for (const record of framer.push(chunk)) client.receive(record, () => clearTimeout(timer), resolve, reject); }
      catch (error) { clearTimeout(timer); socket.destroy(); reject(error); }
    });
    socket.once("close", () => client.fail(new Error("runtime_broker_closed")));
  });
}

export class PiBrokerClient {
  private readonly pending = new Map<string, { resolve: (receipt: CommandReceipt) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly queue: RuntimeEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<RuntimeEvent>) => void> = [];
  private ended = false;
  private lastSeq: number;
  private referenceValue: SessionReference | undefined;
  constructor(private readonly socket: Socket, private readonly framer: JsonlFramer, private readonly token: string, private readonly after: number, private readonly timeoutMs: number) {
    this.lastSeq = after;
    sendSocket(socket, { op: "hello", token, after });
  }
  get reference(): SessionReference | undefined { return this.referenceValue; }
  receive(record: JsonObject, done: () => void, resolve: (client: PiBrokerClient) => void, reject: (error: Error) => void): void {
    const type = stringValue(record.type);
    if (type === "hello") {
      done();
      if (boolValue(record.ok) !== true || !isObject(record.reference)) { reject(new Error(stringValue(record.reason) ?? "runtime_hello_rejected")); this.socket.destroy(); return; }
      const r = record.reference;
      const runtimeKind = stringValue(r.runtimeKind), sessionId = stringValue(r.sessionId), ownerId = stringValue(r.ownerId), cwd = stringValue(r.cwd);
      if (!runtimeKind || !sessionId || !ownerId || !cwd) { reject(new Error("runtime_reference_invalid")); this.socket.destroy(); return; }
      this.referenceValue = { runtimeKind, sessionId, ownerId, cwd, ...(stringValue(r.sessionFile) ? { sessionFile: stringValue(r.sessionFile) } : {}) };
      resolve(this); return;
    }
    if (type === "event") {
      const seq = numberValue(record.seq) ?? this.lastSeq;
      this.lastSeq = Math.max(this.lastSeq, seq);
      if (isObject(record.event)) this.pushEvent(record.event as unknown as RuntimeEvent);
      return;
    }
    if (type === "command_response") {
      const commandId = stringValue(record.commandId); if (!commandId) return;
      const item = this.pending.get(commandId); if (!item) return;
      this.pending.delete(commandId); clearTimeout(item.timer);
      const state = stringValue(record.state);
      item.resolve(state === "accepted" || state === "rejected" || state === "unknown" ? { state, commandId, ...(stringValue(record.reason) ? { reason: stringValue(record.reason) } : {}) } : { state: "unknown", commandId, reason: "runtime_invalid_receipt" });
    }
  }
  command(payload: JsonObject, turnId?: string): Promise<CommandReceipt> {
    const commandId = `cmd-${randomUUID()}`;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(commandId); resolve({ state: "unknown", commandId, reason: "runtime_command_timeout" }); }, this.timeoutMs);
      this.pending.set(commandId, { resolve, timer });
      try { sendSocket(this.socket, { op: "command", token: this.token, commandId, ...(turnId ? { turnId } : {}), payload }); }
      catch (error) { clearTimeout(timer); this.pending.delete(commandId); resolve({ state: "unknown", commandId, reason: String(error) }); }
    });
  }
  pushEvent(event: RuntimeEvent): void { if (this.waiters.length) this.waiters.shift()!({ value: event, done: false }); else this.queue.push(event); }
  fail(_error: Error): void { if (this.ended) return; this.ended = true; for (const item of this.pending.values()) { clearTimeout(item.timer); item.resolve({ state: "unknown", commandId: "", reason: "runtime_broker_closed" }); } this.pending.clear(); while (this.waiters.length) this.waiters.shift()!({ value: undefined, done: true }); }
  async *events(): AsyncIterable<RuntimeEvent> { while (!this.ended || this.queue.length) { if (this.queue.length) { yield this.queue.shift()!; continue; } const next = await new Promise<IteratorResult<RuntimeEvent>>(resolve => this.waiters.push(resolve)); if (next.done) return; yield next.value; } }
  close(): void { this.socket.destroy(); this.fail(new Error("runtime_client_closed")); }
}

export async function stopPiBroker(socketPath: string, ownerToken: string, timeoutMs = 5_000): Promise<CommandReceipt> {
  const client = await connectPiBroker(socketPath, ownerToken, 0, timeoutMs);
  try { return await client.command({ type: "shutdown" }); } finally { client.close(); }
}

export function brokerMetadataPath(runtimeRoot: string, sessionId: string): string { return join(runtimeRoot, "metadata", `${sessionId}.json`); }
export function brokerSocketPath(runtimeRoot: string, sessionId: string): string { return join(runtimeRoot, "sockets", `${sessionId}.sock`); }
export function readBrokerMetadata(path: string): BrokerMetadata | null {
  try { const value: unknown = JSON.parse(readFileSync(path, "utf8")); return isObject(value) && typeof value.sessionId === "string" && typeof value.ownerId === "string" && typeof value.ownerToken === "string" && typeof value.socketPath === "string" ? value as unknown as BrokerMetadata : null; } catch { return null; }
}

// The token-bearing config is handed off via a private (mode-0600) file, never
// inline argv/log: argv is world-readable through /proc/<pid>/cmdline and ps,
// and both ownerToken and any bound coordinator token would otherwise leak.
if (Bun.argv[2] === "--pi-broker-file") {
  const configPath = Bun.argv[3];
  if (!configPath) process.exit(2);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(configPath, "utf8")); } catch { process.exit(2); }
  if (!isObject(parsed)) process.exit(2);
  safeUnlink(configPath); // one-shot handoff; the broker holds the config in memory from here.
  void runPiBroker(parsed as unknown as PiBrokerConfig).catch(() => process.exit(1));
}
