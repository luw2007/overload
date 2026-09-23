import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentRuntime, CommandReceipt, RuntimeEvent, SessionHandle, SessionReference, StartRequest, TurnRequest } from "./types";
import { brokerMetadataPath, brokerSocketPath, connectPiBroker, readBrokerMetadata, runPiBroker, stopPiBroker, type PiBrokerClient, type PiBrokerConfig } from "./pi-broker";

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export type PiRunnerInvocation = { command: string; args: string[] };

export function buildPiRunnerInvocation(taskId: string, attemptId: string, worktreeDir: string, promptFile: string): PiRunnerInvocation {
  const origin = `orch:task:${taskId}:${attemptId}`;
  const piCommand = `OVERLOAD_PARENT=${shellQuote(origin)} OVERLOAD_ORCH_TASK=${shellQuote(taskId)} pi -p ${shellQuote(`@${promptFile}`)}`;
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
    if (metadata.state !== "running" && metadata.state !== "starting") throw new Error("runtime_not_live");
    return this.connectFromMetadata(metadata, reference.sessionId, reference);
  }

  async restore(reference: SessionReference): Promise<SessionHandle> {
    if (reference.runtimeKind !== this.kind) throw new Error("runtime_kind_mismatch");
    const metadata = metadataFor(this.runtimeRoot, reference.sessionId);
    if (metadata?.state === "running" || metadata?.state === "starting") {
      if (metadata.ownerId !== reference.ownerId || metadata.cwd !== reference.cwd) throw new Error("runtime_ownership_mismatch");
      if (existsSync(metadata.socketPath)) return this.connectFromMetadata(metadata, reference.sessionId, reference);
      if (metadata.state === "running") throw new Error("runtime_live_ambiguous");
    }
    const sessionFile = reference.sessionFile ?? metadata?.sessionFile;
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
    };
    await this.spawnBroker(config);
    return this.connectFromMetadata({ ...config }, reference.sessionId, reference);
  }

  async shutdown(reference: SessionReference): Promise<CommandReceipt> {
    if (reference.runtimeKind !== this.kind) throw new Error("runtime_kind_mismatch");
    const metadata = metadataFor(this.runtimeRoot, reference.sessionId);
    if (!metadata) return { state: "rejected", commandId: `cmd-${randomUUID()}`, reason: "runtime_metadata_missing" };
    if (metadata.ownerId !== reference.ownerId || metadata.cwd !== reference.cwd) throw new Error("runtime_ownership_mismatch");
    const receipt = await stopPiBroker(metadata.socketPath, metadata.ownerToken, this.commandTimeoutMs);
    if (receipt.state === "accepted") {
      const deadline = Date.now() + this.commandTimeoutMs;
      while (Date.now() < deadline) {
        const current = metadataFor(this.runtimeRoot, reference.sessionId);
        if (current?.state === "stopped") break;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    return receipt;
  }

  private async connectFromMetadata(metadata: { socketPath: string; ownerToken: string }, sessionId: string, expected?: SessionReference): Promise<SessionHandle> {
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
    const encoded = JSON.stringify(config);
    const proc = Bun.spawn([process.execPath, "run", defaultBrokerScript, "--pi-broker", encoded], { cwd: config.cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", detached: true }) as unknown as BrokerProcess;
    proc.unref?.();
  }
}

export { runPiBroker } from "./pi-broker";
