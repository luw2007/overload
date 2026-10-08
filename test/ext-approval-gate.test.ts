import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let currentHome = "";
mock.module("node:os", () => ({ homedir: () => currentHome, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
type EventRecord = { kind: string; detail?: Record<string, unknown> };
let importCounter = 0;
const homes: string[] = [];

async function harness(config: unknown, beforeStart?: (home: string) => void) {
  const home = mkdtempSync(join(tmpdir(), "overload-ext-approval-"));
  homes.push(home);
  currentHome = home;
  mkdirSync(join(home, ".overload"), { recursive: true });
  writeFileSync(join(home, ".overload", "config.json"), JSON.stringify(config));
  const handlers = new Map<string, Handler[]>();
  const { default: overload } = await import(`../src/extension/overload.ts?approval-test=${++importCounter}`);
  overload({
    on: (name: string, handler: Handler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  } as never);
  const dispatch = (name: string, event: unknown, ctx: unknown = {}) =>
    (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
  beforeStart?.(home);
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: home,
    sessionManager: { getSessionId: () => `approval-session-${importCounter}` },
  }));
  return {
    home,
    dispatch,
    async close(): Promise<EventRecord[]> {
      await Promise.all(dispatch("session_shutdown", { reason: "test_end" }));
      const hostDir = join(home, ".overload", "spool", "local");
      const sealed = (readdirSync(hostDir, { recursive: true }) as string[]).filter((name) => name.includes("seg-"));
      return sealed.flatMap((name) => readFileSync(join(hostDir, name), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    },
  };
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("approval gate", () => {
  test("abort interrupts pending approval and blocks the tool", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    let polling: (() => void) | undefined;
    const polled = new Promise<void>((resolve) => { polling = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/target")) return Response.json({ targetVersion: "v1" });
      if (String(input).includes("/cancel/")) return Response.json({ closed: true });
      polling?.();
      return new Response(null, { status: 404 });
    }) as typeof fetch;
    try {
      const h = await harness({ approval_gate: { enabled: true, require_approval_bash_patterns: ["^git push"], timeout_ms: 60_000 } });
      const pending = Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "cancel-call", input: { command: "git push" } }, { signal: controller.signal }));
      await polled;
      controller.abort();
      expect((await pending)[0]).toMatchObject({ block: true });
      const events = await h.close();
      expect(events.some((event) => event.kind === "decision_resolved" && event.detail?.state === "cancelled" && event.detail?.cancellation_confirmed === true)).toBe(true);
    } finally { globalThis.fetch = originalFetch; }
  });
  test("invalid enabled config fails closed and emits a cancelled pair", async () => {
    const h = await harness({ approval_gate: { enabled: true, block_bash_patterns: "not-an-array" } });
    const event = { toolName: "bash", toolCallId: "invalid-call", input: { command: "echo hi" } };
    const result = await Promise.all(h.dispatch("tool_call", event));
    expect(result[0]).toEqual({ block: true, reason: "overload approval gate misconfigured: block_bash_patterns must be an array of strings" });
    const events = await h.close();
    expect(events.filter((item) => item.kind === "decision_requested").map((item) => item.detail)).toEqual([{
      request_id: "invalid-call", gated: true, rule: "misconfigured", tool: "bash",
    }]);
    expect(events.filter((item) => item.kind === "decision_resolved").map((item) => item.detail)).toEqual([{
      request_id: "invalid-call", gated: true, rule: "misconfigured", tool: "bash", state: "cancelled",
    }]);
  });

  test("require approval resolves approve and consumes mailbox", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/api/decision/target")) return new Response(JSON.stringify({ targetVersion: "v1" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ answer: "approve", actor: "ui", receiptId: "receipt-1" }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const h = await harness({ web_port: 4901, approval_gate: { enabled: true, require_approval_bash_patterns: ["^git push"] } });
      const result = await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "approve-call", input: { command: "git push origin main" } }));
      expect(result[0]).toBeUndefined();
      const events = await h.close();
      // The card must say what kind of action is being released, not only which regex matched.
      expect(events.find((item) => item.kind === "decision_requested")?.detail).toMatchObject({ request_id: "approve-call", gated: true, gate: "action", rule: "^git push", tool: "bash", command: "git push origin main", class: "push", summary: "放行 bash: git push origin main?", options: ["approve", "deny"] });
      expect(events.find((item) => item.kind === "decision_resolved")?.detail).toMatchObject({ request_id: "approve-call", gated: true, state: "resolved", selected: "approve", actor: "ui" });
      expect(calls.some((call) => call.init?.method === "POST" && call.url.includes("/api/decision/consume/"))).toBe(true);
    } finally {
      globalThis.fetch = oldFetch;
    }
  });

  test("deny answer blocks tool", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input) => String(input).endsWith("/api/decision/target") ? new Response(JSON.stringify({ targetVersion: "v1" }), { status: 200 }) : new Response(JSON.stringify({ answer: "deny", actor: "ui", receiptId: "receipt-2" }), { status: 200 })) as typeof fetch;
    try {
      const h = await harness({ approval_gate: { enabled: true, require_approval_bash_patterns: ["^echo"] } });
      expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "deny-call", input: { command: "echo hi" } })))[0]).toEqual({ block: true, reason: "overload approval gate: denied by ui" });
      await h.close();
    } finally { globalThis.fetch = oldFetch; }
  });

  test("missing answer times out and blocks", async () => {
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    try {
      const h = await harness({ approval_gate: { enabled: true, timeout_ms: 50, require_approval_bash_patterns: ["^echo"] } });
      expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "timeout-call", input: { command: "echo hi" } })))[0]).toEqual({ block: true, reason: "overload approval gate: timed out" });
      const events = await h.close();
      expect(events.find((item) => item.kind === "decision_resolved")?.detail).toMatchObject({ request_id: "timeout-call", gated: true, state: "timed_out" });
    } finally { globalThis.fetch = oldFetch; }
  });

  // §4.5 client half: a 409 says another entry already holds this decision, so the poll refreshes
  // current state and stops. Before this, a lost race looked exactly like "not answered yet" and the
  // gate kept polling a target that could never answer it again, all the way to expiry.
  test("a lost consume race stops the poll with current state instead of waiting out expiry", async () => {
    const oldFetch = globalThis.fetch;
    let consumes = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/decision/target")) return Response.json({ targetVersion: "v1" });
      consumes++;
      return Response.json({
        error: "conflict", message: "decision already consumed by another entry",
        code: "already_consumed", retry: false,
        approval_id: "conflict-call", consumer_owner: "extension",
        expected_target_version: "v1", current_target_version: "v1",
        current_target_state: "consumed", current_state: "applying", current_effect_state: "applying",
        current_revision: 3, receipt_id: "receipt-winner",
        decision_package_url: "/api/context/decision-package?item_id=conflict-call&work_id=work-1",
      }, { status: 409 });
    }) as typeof fetch;
    try {
      // A 60s gate polled every 2s: waiting out expiry cannot finish inside a test timeout.
      const h = await harness({ approval_gate: { enabled: true, timeout_ms: 60_000, require_approval_bash_patterns: ["^echo"] } });
      const started = Date.now();
      expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "conflict-call", input: { command: "echo hi" } })))[0])
        .toEqual({ block: true, reason: "overload approval gate: already_consumed by another entry" });
      expect(Date.now() - started).toBeLessThan(5_000);
      // Stopped, not retried: exactly one consume, and no cancel of a target another entry owns.
      expect(consumes).toBe(1);
      const events = await h.close();
      expect(events.find((item) => item.kind === "decision_resolved")?.detail).toEqual({
        request_id: "conflict-call", gated: true, state: "cancelled",
        conflict: {
          code: "already_consumed", current_target_version: "v1", current_target_state: "consumed",
          current_state: "applying", current_effect_state: "applying", current_revision: 3,
          receipt_id: "receipt-winner",
          decision_package_url: "/api/context/decision-package?item_id=conflict-call&work_id=work-1",
        },
      });
    } finally { globalThis.fetch = oldFetch; }
  });

  test("block rules win over require rules", async () => {
    const h = await harness({ approval_gate: { enabled: true, block_bash_patterns: ["^echo"], require_approval_bash_patterns: ["^echo"] } });
    expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "both-call", input: { command: "echo hi" } })))[0]).toEqual({ block: true, reason: "overload approval gate: ^echo" });
    await h.close();
  });

  test("confined writes wait for approval before effect, including missing relative targets", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "overload-write-root-")));
    homes.push(root);
    const oldFetch = globalThis.fetch;
    let release: (() => void) | undefined;
    let polling: (() => void) | undefined;
    const polled = new Promise<void>((resolve) => { polling = resolve; });
    const approved = new Promise<void>((resolve) => { release = resolve; });
    globalThis.fetch = (async (input) => {
      if (String(input).endsWith("/api/decision/target")) return new Response(JSON.stringify({ targetVersion: "v1" }));
      polling?.();
      await approved;
      return new Response(JSON.stringify({ answer: "approve", actor: "ui", receiptId: "write-receipt" }));
    }) as typeof fetch;
    try {
      const h = await harness({ approval_gate: { enabled: true, allowed_write_roots: [root], require_approval_write_paths: ["/unrelated"] } });
      const target = join(root, "new", "file.txt");
      const effect = Promise.all(h.dispatch("tool_call", { toolName: "write", toolCallId: "confined-write", input: { path: "new/file.txt" } }, { cwd: root })).then((results) => {
        if (!results.some((result) => result && typeof result === "object" && "block" in result && result.block)) {
          mkdirSync(join(root, "new"));
          writeFileSync(target, "approved");
        }
      });
      await polled;
      expect(existsSync(target)).toBe(false);
      release?.();
      await effect;
      expect(readFileSync(target, "utf8")).toBe("approved");
      const events = await h.close();
      expect(events.find((event) => event.kind === "decision_requested")?.detail).toMatchObject({ rule: "allowed_write_roots", gated: true });
    } finally { globalThis.fetch = oldFetch; }
  });

  test("confined write/edit deny traversal, prefix siblings, escaping and dangling symlinks without approval", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "overload-write-boundary-")));
    homes.push(base);
    const root = join(base, "repo");
    mkdirSync(root);
    mkdirSync(join(base, "repo-other"));
    symlinkSync(join(base, "repo-other"), join(root, "escape"));
    symlinkSync(join(base, "missing"), join(root, "dangling"));
    const h = await harness({ approval_gate: { enabled: true, allowed_write_roots: [root] } });
    const oldFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("outside paths must not request approval"); }) as typeof fetch;
    try {
      for (const toolName of ["write", "edit"]) {
        for (const path of ["../repo-other/new", join(base, "repo-other/new"), "escape/new", "escape/../escaped.txt", "dangling/new", "../../outside"]) {
          const result = await Promise.all(h.dispatch("tool_call", { toolName, toolCallId: `${toolName}-${path}`, input: { path } }, { cwd: root }));
          expect(result[0]).toMatchObject({ block: true });
          if (!result.some((entry) => entry && typeof entry === "object" && "block" in entry && entry.block)) writeFileSync(path.startsWith("/") ? path : `${root}/${path}`, "escaped");
        }
      }
      expect(calls).toBe(0);
      expect(existsSync(join(base, "repo-other/new"))).toBe(false);
      expect(existsSync(join(base, "escaped.txt"))).toBe(false);
      await h.close();
    } finally { globalThis.fetch = oldFetch; }
  });

  test("invalid roots fail closed and omitted roots preserve legacy write behavior", async () => {
    for (const roots of [["relative"], [join(tmpdir(), "overload-nonexistent-root")], "not-an-array"]) {
      const h = await harness({ approval_gate: { enabled: true, allowed_write_roots: roots } });
      expect((await Promise.all(h.dispatch("tool_call", { toolName: "write", toolCallId: "invalid-root", input: { path: "file" } }, { cwd: h.home })))[0]).toMatchObject({ block: true });
      await h.close();
    }
    const h = await harness({ approval_gate: { enabled: true } });
    expect((await Promise.all(h.dispatch("tool_call", { toolName: "write", input: { path: "/outside/legacy" } }, { cwd: h.home })))[0]).toBeUndefined();
    await h.close();
  });

  test("existing inside edits require approval and denial prevents the effect", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "overload-edit-root-")));
    homes.push(root);
    const target = join(root, "file.txt");
    writeFileSync(target, "original");
    const oldFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async (input) => {
      requests++;
      return new Response(JSON.stringify(String(input).endsWith("/api/decision/target") ? { targetVersion: "v1" } : { answer: "deny", actor: "ui", receiptId: "denied-edit" }));
    }) as typeof fetch;
    try {
      const h = await harness({ approval_gate: { enabled: true, allowed_write_roots: [root] } });
      const results = await Promise.all(h.dispatch("tool_call", { toolName: "edit", toolCallId: "inside-edit", input: { path: target } }, { cwd: root }));
      if (!results.some((result) => result && typeof result === "object" && "block" in result && result.block)) writeFileSync(target, "changed");
      expect(results[0]).toMatchObject({ block: true });
      expect(requests).toBeGreaterThan(0);
      expect(readFileSync(target, "utf8")).toBe("original");
      await h.close();
    } finally { globalThis.fetch = oldFetch; }
  });

  test("missing explicit configuration fails closed for all change tools", async () => {
    const original = process.env.OVERLOAD_CONFIG_PATH;
    process.env.OVERLOAD_CONFIG_PATH = join(tmpdir(), `overload-missing-config-${Date.now()}.json`);
    try {
      const h = await harness({ approval_gate: { enabled: false } });
      for (const toolName of ["bash", "write", "edit"]) {
        expect((await Promise.all(h.dispatch("tool_call", { toolName, toolCallId: `missing-${toolName}`, input: { command: "echo hi", path: "file" } }, { cwd: h.home })))[0]).toMatchObject({ block: true });
      }
      await h.close();
    } finally {
      if (original === undefined) delete process.env.OVERLOAD_CONFIG_PATH;
      else process.env.OVERLOAD_CONFIG_PATH = original;
    }
  });

  test("uppercase bash cannot bypass deny rules", async () => {
    const h = await harness({ approval_gate: { enabled: true, block_bash_patterns: [".*"] } });
    expect((await Promise.all(h.dispatch("tool_call", { toolName: "BASH", toolCallId: "uppercase-bash", input: { command: "echo hi" } })))[0]).toMatchObject({ block: true });
    await h.close();
  });

  test("git push emits consequential tool activity", async () => {
    const h = await harness({ approval_gate: { enabled: false } });
    await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: "push-call", input: { command: "git push origin main" } }));
    const events = await h.close();
    expect(events.some((item) => item.kind === "tool_activity" && item.detail?.consequential === true && item.detail?.class === "push")).toBe(true);
  });
});

test("required session seals configuration removed or weakened before extension load", async () => {
  const oldRequired = process.env.OVERLOAD_REQUIRED_APPROVAL_GATE;
  const oldPath = process.env.OVERLOAD_CONFIG_PATH;
  const oldRoot = process.env.OVERLOAD_RUNTIME_APPROVAL_ROOT;
  process.env.OVERLOAD_REQUIRED_APPROVAL_GATE = "1";
  delete process.env.OVERLOAD_CONFIG_PATH;
  try {
    for (const replacement of [undefined, {}, { approval_gate: { enabled: false } }, { approval_gate: { enabled: true } }, "malformed", { approval_gate: { enabled: true, allowed_write_roots: [], require_approval_write_paths: ["/"], require_approval_bash_patterns: [".*"] } }]) {
      const h = await harness({}, home => {
        const path = join(home, ".overload", "config.json");
        process.env.OVERLOAD_RUNTIME_APPROVAL_ROOT = realpathSync(home);
        if (replacement === undefined) rmSync(path);
        else writeFileSync(path, replacement === "malformed" ? "{" : JSON.stringify(replacement));
      });
      for (const toolName of ["bash", "write", "edit"]) {
        expect((await Promise.all(h.dispatch("tool_call", { toolName, toolCallId: toolName, input: { command: "echo safe", path: join(h.home, "file") } })))[0]).toMatchObject({ block: true });
      }
      await h.close();
    }
    for (const weakness of ["outside", "missing-bash", "missing-write", "outside-approval", "uncovered"]) {
      const h = await harness({}, home => {
        process.env.OVERLOAD_RUNTIME_APPROVAL_ROOT = realpathSync(home);
        writeFileSync(join(home, ".overload", "config.json"), JSON.stringify({ approval_gate: {
          enabled: true, allowed_write_roots: [weakness === "outside" ? realpathSync(tmpdir()) : realpathSync(home)],
          require_approval_write_paths: weakness === "missing-write" ? [] : [weakness === "outside-approval" ? realpathSync(tmpdir()) : weakness === "uncovered" ? realpathSync(join(home, ".overload")) : realpathSync(home)],
          block_bash_patterns: weakness === "missing-bash" ? [] : [".*"], require_approval_bash_patterns: [".*"],
        } }));
      });
      expect((await Promise.all(h.dispatch("tool_call", { toolName: "bash", toolCallId: weakness, input: { command: "echo hi" } })))[0]).toMatchObject({ block: true });
      await h.close();
    }
    const valid = await harness({}, home => {
      process.env.OVERLOAD_RUNTIME_APPROVAL_ROOT = realpathSync(home);
      writeFileSync(join(home, ".overload", "config.json"), JSON.stringify({ approval_gate: {
        enabled: true, allowed_write_roots: [realpathSync(home)], require_approval_write_paths: [realpathSync(home)],
        block_bash_patterns: [".*"],
      } }));
    });
    const validResult = (await Promise.all(valid.dispatch("tool_call", { toolName: "bash", toolCallId: "valid", input: { command: "blocked" } })))[0];
    expect(validResult).toMatchObject({ block: true, reason: "overload approval gate: .*" });
    await valid.close();
    delete process.env.OVERLOAD_REQUIRED_APPROVAL_GATE;
    const legacy = await harness({ approval_gate: { enabled: false } });
    expect((await Promise.all(legacy.dispatch("tool_call", { toolName: "bash", input: { command: "echo hi" } })))[0]).toBeUndefined();
    await legacy.close();
  } finally {
    if (oldRequired === undefined) delete process.env.OVERLOAD_REQUIRED_APPROVAL_GATE; else process.env.OVERLOAD_REQUIRED_APPROVAL_GATE = oldRequired;
    if (oldPath === undefined) delete process.env.OVERLOAD_CONFIG_PATH; else process.env.OVERLOAD_CONFIG_PATH = oldPath;
    if (oldRoot === undefined) delete process.env.OVERLOAD_RUNTIME_APPROVAL_ROOT; else process.env.OVERLOAD_RUNTIME_APPROVAL_ROOT = oldRoot;
  }
});
