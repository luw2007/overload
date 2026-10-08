import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface RuntimeConfigEntry { chatId: string; runtimeConfigPath?: string }

function directory(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute directory`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} must be a directory`);
  return canonical;
}
function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}
function strings(gate: Record<string, unknown>, key: string): string[] {
  const value = gate[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${key} must be an array of strings`);
  return value;
}
function validateConfig(path: string, strict: boolean, root?: string): void {
  const config = JSON.parse(readFileSync(path, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Runtime config must be an object");
  const gate = config.approval_gate;
  if (gate === undefined && !strict) return;
  if (!gate || typeof gate !== "object" || Array.isArray(gate) || typeof gate.enabled !== "boolean") throw new Error("approval_gate must contain a boolean enabled field");
  if (!gate.enabled) {
    if (strict) throw new Error("Required runtime config must enable approval_gate");
    return;
  }
  const blockBash = strings(gate, "block_bash_patterns");
  const requireBash = strings(gate, "require_approval_bash_patterns");
  strings(gate, "block_write_paths");
  const writes = strings(gate, "require_approval_write_paths");
  for (const pattern of [...blockBash, ...requireBash]) new RegExp(pattern);
  if (gate.timeout_ms !== undefined && (!Number.isSafeInteger(gate.timeout_ms) || gate.timeout_ms <= 0)) throw new Error("timeout_ms must be a positive integer");
  if (config.web_port !== undefined && (!Number.isSafeInteger(config.web_port) || config.web_port <= 0 || config.web_port > 65535)) throw new Error("web_port must be a positive integer");
  const allowed = strings(gate, "allowed_write_roots");
  if (gate.allowed_write_roots !== undefined) {
    for (const value of allowed) {
      if (directory(value, "allowed_write_roots") !== resolve(value)) throw new Error("allowed_write_roots must use canonical directories");
    }
  }
  if (!strict) return;
  if (!writes.length || !allowed.length) throw new Error("Required gate needs nonempty require_approval_write_paths and allowed_write_roots");
  if (!blockBash.includes(".*")) throw new Error("Required gate must block all bash with .*");
  const canonicalRoots = (paths: string[], label: string) => paths.map((value) => {
    const canonical = directory(value, label);
    if (resolve(value) !== canonical) throw new Error(`${label} must use canonical directories`);
    if (!contains(root!, canonical)) throw new Error(`${label} must stay within OVERLOAD_RUNTIME_APPROVAL_ROOT`);
    return canonical;
  });
  const approval = canonicalRoots(writes, "require_approval_write_paths");
  for (const allowedRoot of canonicalRoots(allowed, "allowed_write_roots")) {
    if (!approval.some((approved) => contains(approved, allowedRoot))) throw new Error("Approval write roots must cover every allowed write root");
  }
}

/** Revalidate current strict authority before reconnect submission or replacement. */
export function validateRequiredRuntimePolicy(policy: { configPath?: string; approvalRoot?: string }): void {
  if (!policy.configPath || !policy.approvalRoot) throw new Error("runtime_approval_gate_missing");
  const root = directory(policy.approvalRoot, "OVERLOAD_RUNTIME_APPROVAL_ROOT");
  if (policy.approvalRoot !== root) throw new Error("OVERLOAD_RUNTIME_APPROVAL_ROOT must use a canonical directory");
  const path = realpathSync(policy.configPath);
  if (policy.configPath !== path || !statSync(path).isFile()) throw new Error("runtimeConfigPath must be a canonical file");
  validateConfig(path, true, root);
}

/** Validate all authorization rows before starting any channel or runtime. */
export function loadRuntimeConfigs(
  entries: readonly RuntimeConfigEntry[],
  requiredChatsEnv = process.env.OVERLOAD_REQUIRED_RUNTIME_CONFIG_CHATS,
  approvalRootEnv = process.env.OVERLOAD_RUNTIME_APPROVAL_ROOT,
): Map<string, string> {
  const required = new Set((requiredChatsEnv ?? "").split(",").map((chat) => chat.trim()).filter(Boolean));
  const root = required.size ? directory(approvalRootEnv ?? "", "OVERLOAD_RUNTIME_APPROVAL_ROOT") : undefined;
  if (root !== undefined && resolve(approvalRootEnv!) !== root) throw new Error("OVERLOAD_RUNTIME_APPROVAL_ROOT must use a canonical directory");
  const configs = new Map<string, string>();
  const seen = new Map<string, string | undefined>();
  for (const chat of required) {
    if (!entries.some((entry) => entry.chatId === chat)) throw new Error(`Required chat ${chat} has no authorization entry`);
  }
  for (const entry of entries) {
    if (required.has(entry.chatId) && !entry.runtimeConfigPath) throw new Error(`Required chat ${entry.chatId} has an authorization entry without runtimeConfigPath`);
    let path: string | undefined;
    if (entry.runtimeConfigPath !== undefined) {
      if (!entry.runtimeConfigPath) throw new Error("runtimeConfigPath must be nonempty");
      path = realpathSync(entry.runtimeConfigPath);
      if (!statSync(path).isFile()) throw new Error("runtimeConfigPath must be a file");
      validateConfig(path, required.has(entry.chatId), root);
    }
    if (seen.has(entry.chatId) && seen.get(entry.chatId) !== path) throw new Error(`Conflicting runtime configs for chat ${entry.chatId}`);
    seen.set(entry.chatId, path);
    if (path) configs.set(entry.chatId, path);
  }
  return configs;
}
