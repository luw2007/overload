#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { openMailbox } from "../decision-bot/mailbox";
import { AdapterService } from "./service";
import { FeishuChannel, type FeishuChannelConfig } from "./feishu";
import { PiRuntime } from "./pi";
import type { AgentRuntime, ChannelAdapter, ChannelIdentity } from "./types";

type AuthorizationEntry = ChannelIdentity & {
 ownerId: string;
 chatId: string;
 appId: string;
 role?: "owner" | "requester";
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
     row.role !== "requester"),
  )
 )
  throw new Error(
   "Authorization requires explicit appId/chatId and valid optional role",
  );
 return value as AuthorizationEntry[];
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
 const service = new AdapterService(db, {
  runtime,
  channels: [channel],
  cwd: required("OVERLOAD_RUNTIME_CWD"),
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
   return entry ? { ownerId: entry.ownerId, role: entry.role } : null;
  },
 });
 let ticking = false;
 const tick = async () => {
  if (ticking) return;
  ticking = true;
  try {
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
  throw error;
 }
 const timer = setInterval(() => void tick(), 1000);
 await tick();
 return {
  service,
  async stop() {
   clearInterval(timer);
   await service.stop();
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
