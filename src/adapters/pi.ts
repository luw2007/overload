import { existsSync, mkdirSync, chmodSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, CommandReceipt, RuntimeEvent, SessionHandle, SessionReference, StartRequest, TurnRequest } from "./types";
import { brokerMetadataPath, brokerSocketPath, connectPiBroker, readBrokerMetadata, runPiBroker, stopPiBroker, type PiBrokerClient, type PiBrokerConfig } from "./pi-broker";
import {processLiveness} from './pi-broker';

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export type PiRunnerInvocation = { command: string; args: string[] };

export function buildPiRunnerInvocation(taskId: string, attemptId: string, worktreeDir: string, promptFile: string, options?: { readOnly?: boolean; reportPath?: string }): PiRunnerInvocation {
  const origin = `orch:task:${taskId}:${attemptId}`;
  // Read-only (scout) children never get write-capable tools on the unmanaged
  // cmux spawn path either; this mirrors pi-broker.ts's managed --tools gate
  // so the capability boundary is the same regardless of which runtime owns
  // the child.
  const toolsFlag = options?.readOnly ? ` --tools ${shellQuote("read,grep,find,ls")}` : "";
  const base = `OVERLOAD_PARENT=${shellQuote(origin)} OVERLOAD_ORCH_TASK=${shellQuote(taskId)} pi -p ${shellQuote(`@${promptFile}`)}${toolsFlag}`;
  // The unmanaged cmux path has no broker observing turn events, so a scout
  // report has nowhere to land unless the child's own stdout is captured;
  // tee it to the report path the orchestrator will read as evidence.
  const piCommand = options?.reportPath ? `${base} | tee ${shellQuote(options.reportPath)}` : base;
  return { command: "cmux", args: ["new-workspace", "--cwd", worktreeDir, "--command", piCommand, "--focus", "false"] };
}

export type PiRuntimeOptions = {
  runtimeRoot?: string;
  command?: string;
  commandTimeoutMs?: number;
  connectTimeoutMs?: number;
  stderrLimit?: number;
  spawnBroker?: (config: PiBrokerConfig) => Promise<void>;
};

type BrokerProcess = { unref?: () => void; exited?: Promise<number> };

const defaultRuntimeRoot = join(homedir(), ".overload", "runtime");
const defaultBrokerScript = join(import.meta.dir, "pi-broker.ts");
function metadataFor(root: string, sessionId: string): ReturnType<typeof readBrokerMetadata> {
  return readBrokerMetadata(brokerMetadataPath(root, sessionId));
}

function sameReference(left: SessionReference, right: SessionReference): boolean {
  return left.runtimeKind === right.runtimeKind && left.sessionId === right.sessionId && left.ownerId === right.ownerId && left.cwd === right.cwd;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function safeUnlinkSocket(path: string): void {
  try { unlinkSync(path); } catch { /* stale socket cleanup is best-effort */ }
}

export class PiSessionHandle implements SessionHandle {
  readonly reference: SessionReference;
  readonly events: AsyncIterable<RuntimeEvent>;
  private readonly uiMethods = new Map<string, { method: "select" | "confirm" | "input" | "editor"; options?: string[] }>();
  private readonly eventQueue: AsyncIterable<RuntimeEvent>;
  private submitTail: Promise<void> = Promise.resolve();
  private activeTurn: string | undefined;
  private uncertainTurn: string | undefined;
  private closed = false;

  constructor(reference: SessionReference, private readonly client: PiBrokerClient, private readonly commandTimeoutMs: number) {
    this.reference = reference;
    this.eventQueue = client.events();
    this.events = this.observeEvents();
  }

  private async *observeEvents(): AsyncIterable<RuntimeEvent> {
    for await (const event of this.eventQueue) {
      if (event.kind === "blocked" && event.requestId && event.requestMethod) this.uiMethods.set(event.requestId, { method: event.requestMethod, options: event.options });
      if (event.turnId && (event.kind === "completed" || event.kind === "failed" || event.kind === "unknown")) {
        if (this.activeTurn === event.turnId) this.activeTurn = undefined;
        if (this.uncertainTurn === event.turnId) this.uncertainTurn = undefined;
      }
      yield event;
    }
  }

  async submit(request: TurnRequest): Promise<CommandReceipt> {
    const run = this.submitTail.then(async () => {
      if (this.closed) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "runtime_closed" } satisfies CommandReceipt;
      if (this.activeTurn) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "turn_in_flight" } satisfies CommandReceipt;
      if (this.uncertainTurn) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "prior_turn_unknown" } satisfies CommandReceipt;
      const receipt = await this.client.command({ type: "prompt", message: request.text }, request.turnId);
      if (receipt.state === "accepted") this.activeTurn = request.turnId;
      if (receipt.state === "unknown") this.uncertainTurn = request.turnId;
      return receipt;
    });
    this.submitTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async cancel(turnId: string): Promise<CommandReceipt> {
    if (this.closed) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "runtime_closed" };
    const clear = await this.client.command({ type: "clear_queue" }, turnId);
    if (clear.state !== "accepted") return clear;
    return this.client.command({ type: "abort" }, turnId);
  }

  async answer(requestId: string, value: string): Promise<CommandReceipt> {
    if (this.closed) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "runtime_closed" };
    const request = this.uiMethods.get(requestId);
    if (!request) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "unknown_ui_request" };
    let payload: Record<string, unknown>;
    if (request.method === "confirm") {
      if (value !== "yes" && value !== "no") return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "invalid_confirm_answer" };
      payload = { type: "extension_ui_response", id: requestId, confirmed: value === "yes" };
    } else if (request.method === "select") {
      if (request.options && !request.options.includes(value)) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "invalid_select_answer" };
      payload = { type: "extension_ui_response", id: requestId, value };
    } else {
      payload = { type: "extension_ui_response", id: requestId, value };
    }
    const receipt = await this.client.command(payload);
    if (receipt.state === "accepted") this.uiMethods.delete(requestId);
    return receipt;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.client.close();
  }
}

export class PiRuntime implements AgentRuntime {
  readonly kind = "pi";
  readonly capabilities = { restore: true, answer: true, steer: false } as const;
  private readonly runtimeRoot: string;
  private readonly command: string;
  private readonly commandTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly stderrLimit: number;
  private readonly spawnBroker: (config: PiBrokerConfig) => Promise<void>;

  constructor(options: PiRuntimeOptions = {}) {
    this.runtimeRoot = options.runtimeRoot ?? process.env.OVERLOAD_PI_RUNTIME_ROOT ?? defaultRuntimeRoot;
    this.command = options.command ?? "pi";
    this.commandTimeoutMs = options.commandTimeoutMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 5_000;
    this.stderrLimit = options.stderrLimit ?? 64 * 1024;
    this.spawnBroker = options.spawnBroker ?? (config => this.spawnDefaultBroker(config));
    mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
  }

  async start(request: StartRequest): Promise<SessionHandle> {
    const existing = metadataFor(this.runtimeRoot, request.sessionId);
    if (existing) {
      if (existing.ownerId !== request.ownerId || existing.cwd !== request.cwd) throw new Error("runtime_ownership_mismatch");
      if (existing.state === "running" || existing.state === "starting") return this.connectFromMetadata(existing, request.sessionId);
      throw new Error("runtime_session_exists_stopped");
    }
    const ownerToken = randomUUID();
    const config: PiBrokerConfig = {
      runtimeRoot: this.runtimeRoot,
      metadataPath: brokerMetadataPath(this.runtimeRoot, request.sessionId),
      socketPath: brokerSocketPath(this.runtimeRoot, request.sessionId),
      sessionId: request.sessionId,
      ownerId: request.ownerId,
      ownerToken,
      cwd: request.cwd,
      command: this.command,
      stderrLimit: this.stderrLimit,
      coordinator:request.coordinator,readOnly:request.readOnly,configPath:request.configPath??process.env.OVERLOAD_CONFIG_PATH,
      ...(request.provider ? { provider: request.provider } : {}),
      ...(request.model ? { model: request.model } : {}),
    };
    await this.spawnBroker(config);
    return this.connectFromMetadata({ ...config, pid: 0, state: "starting", updatedAt: Date.now() }, request.sessionId);
  }

  async connect(reference: SessionReference): Promise<SessionHandle> {
    if (reference.runtimeKind !== this.kind) throw new Error("runtime_kind_mismatch");
    const metadata = metadataFor(this.runtimeRoot, reference.sessionId);
    if (!metadata) throw new Error("runtime_metadata_missing");
    if (metadata.ownerId !== reference.ownerId || metadata.cwd !== reference.cwd) throw new Error("runtime_ownership_mismatch");
    const broker=metadata.brokerIdentity,child=metadata.childIdentity;
    if(broker&&child&&processLiveness(broker.pid,broker.startIdentity,broker.bootIdentity)==='dead'&&processLiveness(child.pid,child.startIdentity,child.bootIdentity)==='dead')throw new Error('runtime_not_live');
    if (metadata.state !== "running" && metadata.state !== "starting") throw new Error("runtime_not_live");
    if (!existsSync(metadata.socketPath) || !processAlive(metadata.pid)) throw new Error("runtime_not_live");
    return this.connectFromMetadata(metadata, reference.sessionId, reference);
  }

  async restore(reference: SessionReference): Promise<SessionHandle> {
    if (reference.runtimeKind !== this.kind) throw new Error("runtime_kind_mismatch");
    const metadata = metadataFor(this.runtimeRoot, reference.sessionId);
    if (metadata?.state === "running" || metadata?.state === "starting") {
      if (metadata.ownerId !== reference.ownerId || metadata.cwd !== reference.cwd) throw new Error("runtime_ownership_mismatch");
      const broker=metadata.brokerIdentity,child=metadata.childIdentity;
      if(!broker||!child||processLiveness(broker.pid,broker.startIdentity,broker.bootIdentity)!=='dead'||processLiveness(child.pid,child.startIdentity,child.bootIdentity)!=='dead'){if(existsSync(metadata.socketPath))return this.connectFromMetadata(metadata,reference.sessionId,reference);throw new Error('runtime_live_ambiguous');}
      safeUnlinkSocket(metadata.socketPath);
    }
    const sessionFile = reference.sessionFile ?? metadata?.sessionFile;
    if(!metadata||metadata.ownerId!==reference.ownerId||metadata.cwd!==reference.cwd||sessionFile!==metadata.sessionFile)throw new Error('runtime_restore_ownership_mismatch');
    if (!sessionFile) throw new Error("runtime_session_file_missing");
    const config: PiBrokerConfig = {
      runtimeRoot: this.runtimeRoot,
      metadataPath: brokerMetadataPath(this.runtimeRoot, reference.sessionId),
      socketPath: brokerSocketPath(this.runtimeRoot, reference.sessionId),
      sessionId: reference.sessionId,
      ownerId: reference.ownerId,
      ownerToken: randomUUID(),
      cwd: reference.cwd,
      command: this.command,
      stderrLimit: this.stderrLimit,
      sessionFile,
      coordinator:metadata.coordinator,readOnly:metadata.readOnly,provider:metadata.provider,model:metadata.model,configPath:metadata.configPath,
    };
    await this.spawnBroker(config);
    return this.connectFromMetadata({ ...config }, reference.sessionId, reference);
  }

  async shutdown(reference: SessionReference): Promise<CommandReceipt> {
    if (reference.runtimeKind !== this.kind) throw new Error("runtime_kind_mismatch");
    const metadata = metadataFor(this.runtimeRoot, reference.sessionId);
    if (!metadata) return { state: "unknown", commandId: `cmd-${randomUUID()}`, reason: "runtime_metadata_missing" };
    if (metadata.ownerId !== reference.ownerId || metadata.cwd !== reference.cwd) throw new Error("runtime_ownership_mismatch");
    const broker=metadata.brokerIdentity,child=metadata.childIdentity;
    if(!broker||!child)return {state:"unknown",commandId:`cmd-${randomUUID()}`,reason:"runtime_process_identity_missing"};
    const stopped=()=>{
      const current=metadataFor(this.runtimeRoot,reference.sessionId);
      return current?.ownerId===reference.ownerId&&current.cwd===reference.cwd&&current.ownerToken===metadata.ownerToken&&current.brokerIdentity?.startIdentity===broker.startIdentity&&current.brokerIdentity.bootIdentity===broker.bootIdentity&&current.childIdentity?.startIdentity===child.startIdentity&&current.childIdentity.bootIdentity===child.bootIdentity&&current.state==='stopped'&&processLiveness(child.pid,child.startIdentity,child.bootIdentity)==='dead';
    };
    if(stopped())return {state:'accepted',commandId:`cmd-${randomUUID()}`};
    const deadline=Date.now()+this.commandTimeoutMs;
    let receipt:CommandReceipt;
    try{receipt=await stopPiBroker(metadata.socketPath,metadata.ownerToken,this.commandTimeoutMs);}
    catch(error){receipt={state:'unknown',commandId:`cmd-${randomUUID()}`,reason:error instanceof Error?error.message:String(error)};}
    do{
      if(stopped())return {state:'accepted',commandId:receipt.commandId};
      const remaining=deadline-Date.now();
      if(remaining<=0)break;
      const pause=Promise.withResolvers<void>();setTimeout(pause.resolve,Math.min(remaining,25));await pause.promise;
    }while(true);
    return {state:'unknown',commandId:receipt.commandId,reason:receipt.reason??'runtime_shutdown_unconfirmed'};
  }

  private async connectFromMetadata(metadata: { socketPath: string; ownerToken: string } & Record<string, unknown>, sessionId: string, expected?: SessionReference): Promise<SessionHandle> {
    const deadline = Date.now() + this.connectTimeoutMs;
    let lastError: unknown = new Error("runtime_connect_timeout");
    while (Date.now() < deadline) {
      try {
        const remaining = Math.max(100, deadline - Date.now());
        const client = await connectPiBroker(metadata.socketPath, metadata.ownerToken, 0, remaining);
        const reference = client.reference;
        if (!reference || reference.sessionId !== sessionId || (expected && !sameReference(reference, expected))) {
          client.close();
          throw new Error("runtime_reference_mismatch");
        }
        return new PiSessionHandle(reference, client, this.commandTimeoutMs);
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async spawnDefaultBroker(config: PiBrokerConfig): Promise<void> {
    // config carries ownerToken (and, when bound, the coordinator bridge token);
    // both must never appear in argv (world-readable via /proc/<pid>/cmdline and
    // ps) or in any log line. Hand the broker a private config file instead of
    // an inline --pi-broker <json> argument.
    const configDir = join(this.runtimeRoot, "config");
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, `${config.sessionId}-${randomUUID()}.json`);
    await Bun.write(configPath, JSON.stringify(config), { mode: 0o600 });
    const proc = Bun.spawn([process.execPath, "run", defaultBrokerScript, "--pi-broker-file", configPath], { cwd: config.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }) as unknown as BrokerProcess;
    proc.unref?.();
  }
}

export { runPiBroker } from "./pi-broker";
