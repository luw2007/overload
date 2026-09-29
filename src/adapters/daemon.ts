#!/usr/bin/env bun
import { readFileSync, realpathSync, statSync } from "node:fs";
import { openMailbox } from "../decision-bot/mailbox";
import { AdapterService } from "./service";
import { FeishuChannel, type FeishuChannelConfig } from "./feishu";
import { PiRuntime } from "./pi";
import type { AgentRuntime, ChannelAdapter, ChannelIdentity } from "./types";
import { CoordinatorBridge } from "./coordinator";
import { openStore } from "../orchestrator/store";
import { Orchestrator } from "../orchestrator/orchestrator";
import { SpoolWriter } from "../orchestrator/spool";
import { CoordinatorWorkers } from "./worker-runtime";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadWebConfig, startWebServer } from "../web/server";

type AuthorizationEntry = ChannelIdentity & {
 ownerId: string;
 chatId: string;
 appId: string;
 role?: "owner" | "requester";
 workId?: string;
 runtimeConfigPath?: string;
};
type FeishuCredentials = { app_id: string; app_secret: string };
type ChannelFactory = (config: FeishuChannelConfig) => ChannelAdapter;
type RuntimeFactory = () => AgentRuntime;

const defaultChannelFactories: Record<string, ChannelFactory> = {
 feishu: (config) => new FeishuChannel(config),
};
const defaultRuntimeFactories: Record<string, RuntimeFactory> = {
 pi: () => new PiRuntime(),
};

function required(name: string): string {
 const value = process.env[name];
 if (!value) throw new Error(name + " is required");
 return value;
}
function credentials(): FeishuCredentials {
 const file = process.env.FEISHU_APP_FILE;
 if (!file)
  return {
   app_id: required("FEISHU_APP_ID"),
   app_secret: required("FEISHU_APP_SECRET"),
  };
 const value: unknown = JSON.parse(readFileSync(file, "utf8"));
 if (
  !value ||
  typeof value !== "object" ||
  Array.isArray(value) ||
  typeof (value as Record<string, unknown>).app_id !== "string" ||
  typeof (value as Record<string, unknown>).app_secret !== "string" ||
  !(value as Record<string, unknown>).app_id ||
  !(value as Record<string, unknown>).app_secret
 )
  throw new Error("FEISHU_APP_FILE must contain app_id and app_secret");
 return value as FeishuCredentials;
}
function authorizationEntries(): AuthorizationEntry[] {
 const value: unknown = JSON.parse(
  readFileSync(required("OVERLOAD_CHANNEL_AUTH_FILE"), "utf8"),
 );
 if (
  !Array.isArray(value) ||
  !value.length ||
  value.some(
   (row) =>
    !row ||
    typeof row !== "object" ||
    typeof (row as Record<string, unknown>).instanceId !== "string" ||
    typeof (row as Record<string, unknown>).tenantId !== "string" ||
    typeof (row as Record<string, unknown>).userId !== "string" ||
    typeof (row as Record<string, unknown>).ownerId !== "string",
  )
 )
  throw new Error(
   "Authorization file must contain explicit instanceId/tenantId/userId/ownerId entries",
  );
 if (
  value.some(
   (row) =>
    typeof row.appId !== "string" ||
    !row.appId ||
    typeof row.chatId !== "string" ||
    !row.chatId ||
    (row.role !== undefined &&
     row.role !== "owner" &&
     row.role !== "requester") ||
    (row.workId !== undefined &&
     (typeof row.workId !== "string" || !row.workId)) ||
    (row.runtimeConfigPath !== undefined &&
     (typeof row.runtimeConfigPath !== "string" || !row.runtimeConfigPath)),
  )
 )
  throw new Error(
   "Authorization requires explicit appId/chatId, valid optional role, and optional non-empty workId/runtimeConfigPath",
  );
 const entries = value as AuthorizationEntry[];
 if (
  new Set(
   entries.map((row) =>
    JSON.stringify([row.appId, row.instanceId, row.tenantId, row.userId, row.chatId]),
   ),
  ).size !== entries.length
 )
  throw new Error("Authorization contains duplicate conversation routes");
 return entries;
}
/** The control plane is one HTTP server per machine on a well-known port: the extension the
 *  runtime loads resolves that port from configuration (`web_port` > `OVERLOAD_WEB_PORT` > 4870)
 *  and cannot discover an ephemeral one, and every instance is the same stateless view over one
 *  control database. So the daemon hosts it only when nobody else does. On a host that also runs
 *  the `web` agent that agent owns the port, and the channel must stay up rather than die on
 *  EADDRINUSE and flap under launchd KeepAlive; on an adapter-only host the port is free and the
 *  daemon still serves it, which is what its own pi workers post their decisions to. */
async function hostControlPlane(configPath?: string) {
 const port = (await loadWebConfig(configPath)).web_port;
 try {
  return startWebServer({ controlPath: process.env.OVERLOAD_ANSWERS_PATH, port });
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
  console.error(
   `adapter: control plane already served on 127.0.0.1:${port}; not hosting a second one`,
  );
  return null;
 }
}
function selectFactory<T>(
 registry: Record<string, T>,
 name: string,
 kind: string,
): T {
 const factory = registry[name];
 if (!factory) throw new Error(`Unsupported ${kind}: ${name}`);
 return factory;
}

export async function startAdapterDaemon(options?: {
 channelFactories?: Record<string, ChannelFactory>;
 runtimeFactories?: Record<string, RuntimeFactory>;
 /** Test seam, like the factories above: `homedir()` is resolved once per process, so a test
  *  cannot move `~/.overload/config.json` by setting HOME. */
 webConfigPath?: string;
}) {
 const entries = authorizationEntries();
 const app = credentials();
 const channelRegistry = options?.channelFactories ?? defaultChannelFactories;
 const runtimeRegistry = options?.runtimeFactories ?? defaultRuntimeFactories;
 const channel = selectFactory(
  channelRegistry,
  process.env.OVERLOAD_CHANNEL ?? "feishu",
  "channel",
 )({
  appId: app.app_id,
  appSecret: app.app_secret,
  instanceId: required("FEISHU_INSTANCE_ID"),
 });
 const runtime = selectFactory(
  runtimeRegistry,
  process.env.OVERLOAD_RUNTIME ?? "pi",
  "runtime",
 )();
 const db = openMailbox(process.env.OVERLOAD_ANSWERS_PATH);
 const web = await hostControlPlane(options?.webConfigPath);
 const coordinatorDb = entries.some((entry) => entry.workId) ? openStore() : null;
 const bridge = coordinatorDb ? new CoordinatorBridge(db, coordinatorDb) : null;
 bridge?.start(Number(process.env.OVERLOAD_COORDINATOR_PORT ?? 4891));
 const artifactsRoot = join(homedir(), ".overload", "artifacts");
 const workers = coordinatorDb
  ? new CoordinatorWorkers(
     coordinatorDb,
     runtime,
     artifactsRoot,
     process.env.OVERLOAD_PI_PROVIDER,
     process.env.OVERLOAD_PI_MODEL,
    )
  : null;
 const orchestrator = coordinatorDb
  ? new Orchestrator(
     coordinatorDb,
     new SpoolWriter(coordinatorDb),
     2,
     undefined,
     undefined,
     undefined,
     undefined,
     artifactsRoot,
     workers ?? undefined,
    )
  : null;
 const requiredRuntimeChats = new Set(
  (process.env.OVERLOAD_REQUIRED_RUNTIME_CONFIG_CHATS ?? "")
   .split(",")
   .filter(Boolean),
 );
 for (const chatId of requiredRuntimeChats)
  if (!entries.some((entry) => entry.chatId === chatId && entry.runtimeConfigPath))
   throw new Error("required_runtime_config_missing:" + chatId);
 const runtimeConfigs = new Map(
  entries
   .filter((entry) => entry.runtimeConfigPath)
   .map((entry) => {
    const path = realpathSync(entry.runtimeConfigPath!);
    if (!statSync(path).isFile()) throw new Error("runtime_config_not_file");
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
     value?.approval_gate?.enabled !== true ||
     !Array.isArray(value.approval_gate.require_approval_write_paths) ||
     value.approval_gate.require_approval_write_paths.some(
      (root: unknown) =>
       typeof root !== "string" ||
       !realpathSync(root).startsWith("/tmp/overload-botmux-gate-acceptance/repo"),
     )
    )
     throw new Error("invalid_runtime_gate_config");
    return [entry.chatId, path] as const;
   }),
 );
 const service = new AdapterService(db, {
  runtime,
  channels: [channel],
  cwd: required("OVERLOAD_RUNTIME_CWD"),
  runtimeConfig: (conversation) => {
   const chatId = (JSON.parse(conversation.address) as { chatId: string }).chatId,
    path = runtimeConfigs.get(chatId);
   return path ? { configPath: path } : undefined;
  },
  coordinator: bridge
   ? (conversation, reference) =>
      conversation.coordinator_work_id
       ? bridge.bind(conversation, reference, conversation.coordinator_work_id)
       : undefined
   : undefined,
  silentTurn: bridge ? (turnId) => bridge.isWakeup(turnId) : undefined,
  coordinatorDecision: bridge
   ? (item, answer, actor) => bridge.decide(item, answer, actor)
   : undefined,
  provider: process.env.OVERLOAD_PI_PROVIDER,
  model: process.env.OVERLOAD_PI_MODEL,
  allowedModels:
   process.env.OVERLOAD_PI_ALLOWED_MODELS?.split(",").filter(Boolean),
  authorize: (identity, address) => {
   const entry = entries.find(
    (entry) =>
     entry.appId === app.app_id &&
     entry.chatId === address.chatId &&
     entry.instanceId === identity.instanceId &&
     entry.tenantId === identity.tenantId &&
     entry.userId === identity.userId,
   );
   return entry
    ? { ownerId: entry.ownerId, role: entry.role, workId: entry.workId ?? null }
    : null;
  },
 });
 let ticking = false;
 const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
   await orchestrator?.tick();
   bridge?.tick();
   await service.tick();
  } catch (error) {
   console.error(
    "adapter tick failed:",
    error instanceof Error ? error.message : "unknown",
   );
  } finally {
   ticking = false;
  }
 };
 try {
  await service.start();
 } catch (error) {
  await service.stop();
  web?.stop(true);
  bridge?.stop();
  await workers?.close();
  coordinatorDb?.close();
  db.close();
  throw error;
 }
 const timer = setInterval(() => void tick(), 1000);
 await tick();
 return {
  service,
  async stop() {
   clearInterval(timer);
   await service.stop();
   web?.stop(true);
   await workers?.close();
   bridge?.stop();
   coordinatorDb?.close();
  },
 };
}
if (import.meta.main) {
 const daemon = await startAdapterDaemon();
 console.log("Feishu long-connection daemon started");
 for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
   void daemon.stop().then(() => process.exit(0));
  });
}
