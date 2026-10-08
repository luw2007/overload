import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPiRunnerInvocation, PiRuntime } from "./pi";
import { brokerMetadataPath, brokerSocketPath, type PiBrokerConfig } from "./pi-broker";

test("buildPiRunnerInvocation wraps pi prompt in cmux new-workspace with parent origin", () => {
  const inv = buildPiRunnerInvocation("task-1", "attempt-2", "/worktree", "/tmp/prompt.txt");
  expect(inv.command).toBe("cmux");
  expect(inv.args).toContain("new-workspace");
  expect(inv.args).toContain("--cwd");
  expect(inv.args).toContain("/worktree");
  const command = inv.args[inv.args.indexOf("--command") + 1];
  expect(command).toContain("OVERLOAD_PARENT='orch:task:task-1:attempt-2'");
  expect(command).toContain("OVERLOAD_ORCH_TASK='task-1'");
  expect(command).toContain("pi -p '@/tmp/prompt.txt'");
});

test("connect treats stale starting metadata without a live socket as not live", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-runtime-"));
  const sessionId = "stale-session";
  const metadataPath = brokerMetadataPath(runtimeRoot, sessionId);
  mkdirSync(join(runtimeRoot, "metadata"), { recursive: true });
  writeFileSync(metadataPath, JSON.stringify({
    runtimeRoot, metadataPath, socketPath: brokerSocketPath(runtimeRoot, sessionId),
    sessionId, ownerId: "owner-1", ownerToken: "token-1", cwd: "/tmp",
    command: "pi", stderrLimit: 1024, pid: 99999, state: "starting", updatedAt: Date.now(),
  }));
  const runtime = new PiRuntime({ runtimeRoot, connectTimeoutMs: 5000 });
  const start = Date.now();
  await expect(
    runtime.connect({ runtimeKind: "pi", sessionId, ownerId: "owner-1", cwd: "/tmp" }),
  ).rejects.toThrow("runtime_not_live");
  expect(Date.now() - start).toBeLessThan(500);
  rmSync(runtimeRoot, { recursive: true, force: true });
});

test("connect and restore treat a leftover socket file from a dead pid as not live", async () => {
  const runtimeRoot = mkdtempSync(join(tmpdir(), "pi-runtime-"));
  const sessionId = "dead-pid-session";
  const metadataPath = brokerMetadataPath(runtimeRoot, sessionId);
  const socketPath = brokerSocketPath(runtimeRoot, sessionId);
  mkdirSync(join(runtimeRoot, "metadata"), { recursive: true });
  mkdirSync(join(runtimeRoot, "sockets"), { recursive: true });
  writeFileSync(socketPath, "");
  const deadPid = 99999991;
  writeFileSync(metadataPath, JSON.stringify({
    runtimeRoot, metadataPath, socketPath,
    sessionId, ownerId: "owner-1", ownerToken: "token-1", cwd: "/tmp",
    command: "pi", stderrLimit: 1024, pid: deadPid, state: "starting", updatedAt: Date.now(),
  }));
  const runtime = new PiRuntime({ runtimeRoot, connectTimeoutMs: 5000 });
  const reference = { runtimeKind: "pi" as const, sessionId, ownerId: "owner-1", cwd: "/tmp" };
  const connectStart = Date.now();
  await expect(runtime.connect(reference)).rejects.toThrow("runtime_not_live");
  expect(Date.now() - connectStart).toBeLessThan(500);
  // Legacy metadata carries no process identities, so a dead-looking pid cannot prove the broker is gone
  // (pid reuse): restore refuses as ambiguous instead of spawning a second broker for the same session.
  rmSync(socketPath);
  let spawned = false;
  const restoringRuntime = new PiRuntime({
    runtimeRoot, connectTimeoutMs: 200,
    spawnBroker: async () => { spawned = true; },
  });
  await expect(
    restoringRuntime.restore({ ...reference, sessionFile: "/tmp/session.jsonl" }, {}),
  ).rejects.toThrow("runtime_live_ambiguous");
  expect(spawned).toBe(false);
  rmSync(runtimeRoot, { recursive: true, force: true });
});

test("required gate start and restore preserve authority and reject mismatched existing sessions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-required-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const configPath = join(root, "gate.json");
  writeFileSync(configPath, JSON.stringify({
    approval_gate: {
      enabled: true,
      block_bash_patterns: [".*"],
      require_approval_write_paths: [root],
      allowed_write_roots: [repo],
    },
  }));
  const request = { sessionId: "required", ownerId: "owner", cwd: root, configPath, requiredApprovalGate: true, approvalRoot: root };
  const marker = new Error("captured-spawn");
  const configs: PiBrokerConfig[] = [];
  const runtime = new PiRuntime({ runtimeRoot: root, spawnBroker: async config => { configs.push(config); throw marker; } });
  try {
    await expect(runtime.start(request)).rejects.toThrow("captured-spawn");
    expect(configs[0]).toMatchObject({ configPath: request.configPath, requiredApprovalGate: true, approvalRoot: root });
    const metadataPath = brokerMetadataPath(root, request.sessionId);
    mkdirSync(join(root, "metadata"), { recursive: true });
    const metadata = { ...configs[0], state: "stopped", sessionFile: join(root, "session.jsonl") };
    writeFileSync(metadataPath, JSON.stringify(metadata));
    await expect(runtime.restore({ runtimeKind: "pi", sessionId: request.sessionId, ownerId: request.ownerId, cwd: root }, { configPath: request.configPath, requiredApprovalGate: true, approvalRoot: root })).rejects.toThrow("captured-spawn");
    expect(configs[1]).toMatchObject({ configPath: request.configPath, requiredApprovalGate: true, approvalRoot: root });
    for (const altered of [{ requiredApprovalGate: false }, { configPath: "/different/config.json" }]) {
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, state: "running", ...altered }));
      await expect(runtime.start(request)).rejects.toThrow("runtime_approval_gate_mismatch");
    }
    expect(configs).toHaveLength(2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restore rejects legacy stopped metadata under current required policy and strict metadata under unrequired policy before spawn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-legacy-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const configPath = join(root, "gate.json");
  writeFileSync(configPath, JSON.stringify({
    approval_gate: {
      enabled: true,
      block_bash_patterns: [".*"],
      require_approval_write_paths: [root],
      allowed_write_roots: [repo],
    },
  }));
  const requiredPolicy = { configPath, requiredApprovalGate: true, approvalRoot: root };
  let spawns = 0;
  const runtime = new PiRuntime({
    runtimeRoot: root,
    spawnBroker: async () => { spawns++; },
  });
  mkdirSync(join(root, "metadata"), { recursive: true });

  try {
    const legacySessionId = "legacy-session";
    writeFileSync(brokerMetadataPath(root, legacySessionId), JSON.stringify({
      runtimeRoot: root,
      metadataPath: brokerMetadataPath(root, legacySessionId),
      socketPath: brokerSocketPath(root, legacySessionId),
      sessionId: legacySessionId,
      ownerId: "owner",
      ownerToken: "token-legacy",
      cwd: root,
      command: "pi",
      stderrLimit: 1024,
      pid: 99991,
      state: "stopped",
      sessionFile: join(root, "legacy.jsonl"),
    }));

    await expect(
      runtime.restore(
        { runtimeKind: "pi", sessionId: legacySessionId, ownerId: "owner", cwd: root },
        requiredPolicy,
      ),
    ).rejects.toThrow("runtime_approval_gate_mismatch");
    expect(spawns).toBe(0);

    const strictSessionId = "strict-session";
    writeFileSync(brokerMetadataPath(root, strictSessionId), JSON.stringify({
      runtimeRoot: root,
      metadataPath: brokerMetadataPath(root, strictSessionId),
      socketPath: brokerSocketPath(root, strictSessionId),
      sessionId: strictSessionId,
      ownerId: "owner",
      ownerToken: "token-strict",
      cwd: root,
      command: "pi",
      stderrLimit: 1024,
      pid: 99992,
      state: "stopped",
      sessionFile: join(root, "strict.jsonl"),
      configPath,
      requiredApprovalGate: true,
      approvalRoot: root,
    }));

    await expect(
      runtime.restore(
        { runtimeKind: "pi", sessionId: strictSessionId, ownerId: "owner", cwd: root },
        {},
      ),
    ).rejects.toThrow("runtime_approval_gate_mismatch");
    expect(spawns).toBe(0);

    await expect(
      runtime.restore(
        { runtimeKind: "pi", sessionId: strictSessionId, ownerId: "owner", cwd: root },
        { requiredApprovalGate: false, configPath, approvalRoot: root },
      ),
    ).rejects.toThrow("runtime_approval_gate_mismatch");
    expect(spawns).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restore rejects config or root rotation and missing required policy fields before spawn, but permits matching valid strict policy", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-rotate-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const configPath = join(root, "gate.json");
  writeFileSync(configPath, JSON.stringify({
    approval_gate: {
      enabled: true,
      block_bash_patterns: [".*"],
      require_approval_write_paths: [root],
      allowed_write_roots: [repo],
    },
  }));

  const altConfigPath = join(root, "gate2.json");
  writeFileSync(altConfigPath, JSON.stringify({
    approval_gate: {
      enabled: true,
      block_bash_patterns: [".*"],
      require_approval_write_paths: [root],
      allowed_write_roots: [repo],
    },
  }));
  const altRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-alt-root-")));

  const spawnedConfigs: PiBrokerConfig[] = [];
  const runtime = new PiRuntime({
    runtimeRoot: root,
    spawnBroker: async (config) => { spawnedConfigs.push(config); throw new Error("captured-spawn"); },
  });
  mkdirSync(join(root, "metadata"), { recursive: true });

  const sessionId = "strict-session";
  const metadata = {
    runtimeRoot: root,
    metadataPath: brokerMetadataPath(root, sessionId),
    socketPath: brokerSocketPath(root, sessionId),
    sessionId,
    ownerId: "owner",
    ownerToken: "token-strict",
    cwd: root,
    command: "pi",
    stderrLimit: 1024,
    pid: 99993,
    state: "stopped",
    sessionFile: join(root, "session.jsonl"),
    configPath,
    requiredApprovalGate: true,
    approvalRoot: root,
  };
  writeFileSync(brokerMetadataPath(root, sessionId), JSON.stringify(metadata));

  try {
    const reference = { runtimeKind: "pi" as const, sessionId, ownerId: "owner", cwd: root };

    await expect(
      runtime.restore(reference, { configPath: altConfigPath, requiredApprovalGate: true, approvalRoot: root }),
    ).rejects.toThrow("runtime_approval_gate_mismatch");
    expect(spawnedConfigs).toHaveLength(0);

    await expect(
      runtime.restore(reference, { configPath, requiredApprovalGate: true, approvalRoot: altRoot }),
    ).rejects.toThrow("runtime_approval_gate_mismatch");
    expect(spawnedConfigs).toHaveLength(0);

    await expect(
      runtime.restore(reference, { configPath: undefined, requiredApprovalGate: true, approvalRoot: root }),
    ).rejects.toThrow("runtime_approval_gate_mismatch");
    expect(spawnedConfigs).toHaveLength(0);

    await expect(
      runtime.restore(reference, { configPath, requiredApprovalGate: true, approvalRoot: undefined }),
    ).rejects.toThrow("runtime_approval_gate_mismatch");
    expect(spawnedConfigs).toHaveLength(0);

    await expect(runtime.restore(reference, { configPath, requiredApprovalGate: true, approvalRoot: root })).rejects.toThrow("captured-spawn");
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]).toMatchObject({
      sessionId,
      configPath,
      requiredApprovalGate: true,
      approvalRoot: root,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(altRoot, { recursive: true, force: true });
  }
});

test("restore revalidates strict gate content and rejects missing disabled or weakened config before spawn", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-reval-")));
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const configPath = join(root, "gate.json");
  const saveGate = (gate: Record<string, unknown>) => {
    writeFileSync(configPath, JSON.stringify({ approval_gate: gate }));
  };
  saveGate({
    enabled: true,
    block_bash_patterns: [".*"],
    require_approval_write_paths: [root],
    allowed_write_roots: [repo],
  });

  let spawns = 0;
  const runtime = new PiRuntime({
    runtimeRoot: root,
    spawnBroker: async () => { spawns++; },
  });
  mkdirSync(join(root, "metadata"), { recursive: true });

  const sessionId = "reval-session";
  const metadata = {
    runtimeRoot: root,
    metadataPath: brokerMetadataPath(root, sessionId),
    socketPath: brokerSocketPath(root, sessionId),
    sessionId,
    ownerId: "owner",
    ownerToken: "token-reval",
    cwd: root,
    command: "pi",
    stderrLimit: 1024,
    pid: 99994,
    state: "stopped",
    sessionFile: join(root, "session.jsonl"),
    configPath,
    requiredApprovalGate: true,
    approvalRoot: root,
  };
  writeFileSync(brokerMetadataPath(root, sessionId), JSON.stringify(metadata));
  const reference = { runtimeKind: "pi" as const, sessionId, ownerId: "owner", cwd: root };
  const policy = { configPath, requiredApprovalGate: true, approvalRoot: root };

  try {
    saveGate({ enabled: false });
    await expect(runtime.restore(reference, policy)).rejects.toThrow("Required runtime config must enable approval_gate");
    expect(spawns).toBe(0);

    saveGate({
      enabled: true,
      block_bash_patterns: ["rm"],
      require_approval_write_paths: [root],
      allowed_write_roots: [repo],
    });
    await expect(runtime.restore(reference, policy)).rejects.toThrow("Required gate must block all bash with .*");
    expect(spawns).toBe(0);

    saveGate({
      enabled: true,
      block_bash_patterns: [".*"],
      require_approval_write_paths: [],
      allowed_write_roots: [repo],
    });
    await expect(runtime.restore(reference, policy)).rejects.toThrow("Required gate needs nonempty require_approval_write_paths and allowed_write_roots");
    expect(spawns).toBe(0);

    rmSync(configPath);
    await expect(runtime.restore(reference, policy)).rejects.toThrow();
    expect(spawns).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ordinary restore preserves metadata config when neither metadata nor policy requires approval gate", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-ordinary-")));
  const customConfig = join(root, "custom.json");
  writeFileSync(customConfig, JSON.stringify({ custom: true }));

  const spawnedConfigs: PiBrokerConfig[] = [];
  const runtime = new PiRuntime({
    runtimeRoot: root,
    spawnBroker: async (config) => { spawnedConfigs.push(config); throw new Error("captured-spawn"); },
  });
  mkdirSync(join(root, "metadata"), { recursive: true });

  const sessionId = "ordinary-session";
  const metadata = {
    runtimeRoot: root,
    metadataPath: brokerMetadataPath(root, sessionId),
    socketPath: brokerSocketPath(root, sessionId),
    sessionId,
    ownerId: "owner",
    ownerToken: "token-ordinary",
    cwd: root,
    command: "pi",
    stderrLimit: 1024,
    pid: 99995,
    state: "stopped",
    sessionFile: join(root, "session.jsonl"),
    configPath: customConfig,
    requiredApprovalGate: false,
  };
  writeFileSync(brokerMetadataPath(root, sessionId), JSON.stringify(metadata));
  const reference = { runtimeKind: "pi" as const, sessionId, ownerId: "owner", cwd: root };

  try {
    await expect(runtime.restore(reference, {})).rejects.toThrow("captured-spawn");
    expect(spawnedConfigs).toHaveLength(1);
    expect(spawnedConfigs[0]).toMatchObject({
      sessionId,
      configPath: customConfig,
      requiredApprovalGate: false,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
