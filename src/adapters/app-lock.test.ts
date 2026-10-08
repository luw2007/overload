import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map(child => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const completion = Promise.withResolvers<void>();
    child.once("exit", () => completion.resolve());
    child.kill("SIGKILL");
    return completion.promise;
  }));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const modulePath = join(import.meta.dir, "app-lock.ts");
function home(): string {
  const root = mkdtempSync(join(tmpdir(), "overload-app-lock-"));
  roots.push(root);
  return root;
}
function appId(label: string): string {
  return `cli_${label}_${randomUUID()}`;
}
function run(root: string, app: string, mode = "hold", extraEnv: Record<string, string> = {}, fixture = "") {
  const source = `${fixture}
    // Dynamic loading lets negative fixtures install module mocks before evaluation.
    const { acquireAppLock } = await import(${JSON.stringify(modulePath)});
    try {
      const lock = await acquireAppLock(${JSON.stringify(app)});
      console.log("acquired");
      if (${JSON.stringify(mode)} === "fail") {
        try { throw new Error("startup failed"); } finally { await lock.release(); }
      } else if (${JSON.stringify(mode)} === "release") {
        await lock.release(); await lock.release(); console.log("released");
      } else {
        const input = Promise.withResolvers();
        process.stdin.once("data", input.resolve);
        await input.promise;
        await lock.release(); console.log("released");
        process.stdin.destroy();
      }
    } catch (error) { console.error(String(error)); process.exitCode = 1; }`;
  const child = spawn(process.execPath, ["--eval", source], {
    env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"), OVERLOAD_LEDGER_PATH: join(root, "ledger.db"), ...extraEnv }, stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  let output = "";
  let errors = "";
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { errors += String(chunk); });
  const completion = Promise.withResolvers<number | null>();
  child.once("exit", completion.resolve); child.once("error", completion.reject);
  const exit = completion.promise;
  const handshake = Promise.withResolvers<void>();
  child.stdout!.on("data", () => { if (output.includes("acquired\n")) handshake.resolve(); });
  child.once("exit", () => { if (!output.includes("acquired\n")) handshake.reject(new Error(errors)); });
  child.once("error", handshake.reject);
  const acquired = handshake.promise;
  void acquired.catch(() => {});
  return { child, exit, acquired, errors: () => errors };
}

test("same canonical app conflicts across concurrent processes and deployment overrides", async () => {
  const root = home();
  const app = appId("AbC");
  const first = run(root, ` ${app} `);
  await first.acquired;
  const second = run(home(), app, "release", {
    OVERLOAD_LEDGER_PATH: join(root, "different.db"),
    FEISHU_INSTANCE_ID: "different-instance",
    OVERLOAD_APP_LOCK_DIR: join(root, "bypass"),
    HOME: join(root, "different-home"),
    XDG_STATE_HOME: join(root, "different-state"),
    XDG_CONFIG_HOME: join(root, "different-config"),
    XDG_RUNTIME_DIR: join(root, "different-runtime"),
    TMPDIR: join(root, "different-tmp"),
  });
  expect(await second.exit).toBe(1);
  expect(second.errors()).toContain("already running");
  first.child.stdin!.write("stop\n");
  expect(await first.exit).toBe(0);
  const third = run(root, app, "release");
  expect(await third.exit).toBe(0);
});

test("distinct case-sensitive app IDs can run concurrently", async () => {
  const root = home();
  const app = appId("App");
  const first = run(root, app);
  await first.acquired;
  const second = run(home(), app.replace("cli_App_", "cli_app_"), "release");
  expect(await second.exit).toBe(0);
  first.child.stdin!.write("stop\n");
  expect(await first.exit).toBe(0);
});

test("failed startup finally releases the helper lock", async () => {
  const root = home();
  const app = appId("failure");
  expect(await run(root, app, "fail").exit).toBe(1);
  expect(await run(root, app, "release").exit).toBe(0);
});

test("unexpected OS holder death terminates the otherwise live parent", async () => {
  const root = home();
  const parent = run(root, appId("holder_loss"));
  await parent.acquired;
  // Linux kernel child inventory observes the real holder, without exposing a test API.
  const pids = readFileSync(`/proc/${parent.child.pid}/task/${parent.child.pid}/children`, "utf8")
    .trim().split(/\s+/).filter(Boolean).map(Number);
  expect(pids).toHaveLength(1);
  process.kill(pids[0]!, "SIGKILL");
  expect(await parent.exit).toBe(1);
  expect(parent.errors()).toContain("OS lock holder was lost");
});

test("parent process death releases OS lock without deleting its file", async () => {
  const root = home();
  const app = appId("death");
  const first = run(root, app);
  await first.acquired;
  first.child.kill("SIGKILL");
  await first.exit;
  // The holder sees EOF asynchronously. Retry boundedly rather than assume exit ordering.
  let acquired = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await run(root, app, "release").exit === 0) { acquired = true; break; }
  }
  expect(acquired).toBe(true);
});

test("malformed IDs fail closed", async () => {
  const root = home();
  for (const id of ["", "   ", "../escape", "cli/a", "cli app", "cli.abc"]) {
    const result = run(root, id, "release");
    expect(await result.exit).toBe(1);
    expect(result.errors()).toContain("Invalid Feishu app_id");
  }
});

// Mock only metadata for the fixed namespace, never the contention path or a
// public root override. No unsafe fixture mutates the shared OS namespace.
function unsafeNamespace(metadata: string): string {
  return `import { mock } from "bun:test";
    import * as fs from "node:fs/promises";
    const actual = { ...fs };
    const namespace = "/run/user/" + process.getuid() + "/overload-channel-locks";
    mock.module("node:fs/promises", () => ({ ...actual,
      mkdir: async (path, options) => path === namespace ? undefined : actual.mkdir(path, options),
      lstat: async path => path === namespace ? (${metadata}) : actual.lstat(path),
    }));`;
}

test("symlink namespace fails closed", async () => {
  const result = run(home(), appId("symlink"), "release", {}, unsafeNamespace(
    "{ isDirectory: () => true, isSymbolicLink: () => true, uid: process.getuid(), mode: 0o40700 }",
  ));
  expect(await result.exit).toBe(1);
  expect(result.errors()).toContain("private (0700)");
});

test("nonprivate or foreign-owned namespace fails closed", async () => {
  for (const metadata of [
    "{ isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid(), mode: 0o40755 }",
    "{ isDirectory: () => true, isSymbolicLink: () => false, uid: process.getuid() + 1, mode: 0o40700 }",
  ]) {
    const result = run(home(), appId("permissions"), "release", {}, unsafeNamespace(metadata));
    expect(await result.exit).toBe(1);
    expect(result.errors()).toContain("private (0700)");
  }
});

function ancestorFixture(overrides: {
  missingPath?: string;
  symlinkPath?: string;
  aliasPath?: string;
  foreignUidPath?: string;
  groupWorldWritablePath?: string;
  nonDirectoryPath?: string;
  unsafeRootParent?: boolean;
  realMountIdentity?: boolean;
  expectNoOperations?: boolean;
}): string {
  return `import { mock } from "bun:test";
    import * as fs from "node:fs/promises";
    const actual = { ...fs };
    const uid = process.getuid();
    const runtime = "/run/user/" + uid;
    const plan = ${JSON.stringify(overrides)};
    const calls = { mkdir: 0, open: 0 };
    process.on("exit", () => {
      if (plan.expectNoOperations && (calls.mkdir !== 0 || calls.open !== 0)) {
        console.error("FAIL: mkdir or open called unexpectedly: " + JSON.stringify(calls));
      }
    });
    mock.module("node:fs/promises", () => ({ ...actual,
      mkdir: async (path, options) => {
        calls.mkdir++;
        return actual.mkdir(path, options);
      },
      open: async (path, flags, mode) => {
        calls.open++;
        return actual.open(path, flags, mode);
      },
      realpath: async path => {
        if (plan.aliasPath && path === plan.aliasPath) return "/run-alias" + path;
        if (plan.realMountIdentity && (path === "/run" || path === "/run/user" || path === runtime)) return path;
        return actual.realpath(path);
      },
      lstat: async path => {
        if (plan.missingPath && path === plan.missingPath) {
          const err = new Error("ENOENT: no such file or directory, lstat '" + path + "'");
          err.code = "ENOENT";
          throw err;
        }
        if (plan.unsafeRootParent && path === "/run") {
          return { isDirectory: () => true, isSymbolicLink: () => false, uid: 1000, mode: 0o40755 };
        }
        if (path === plan.symlinkPath) {
          return { isDirectory: () => true, isSymbolicLink: () => true, uid: path === runtime ? uid : 0, mode: 0o40755 };
        }
        if (path === plan.foreignUidPath) {
          return { isDirectory: () => true, isSymbolicLink: () => false, uid: path === runtime ? uid + 1 : 1000, mode: 0o40755 };
        }
        if (path === plan.groupWorldWritablePath) {
          return { isDirectory: () => true, isSymbolicLink: () => false, uid: path === runtime ? uid : 0, mode: 0o40777 };
        }
        if (path === plan.nonDirectoryPath) {
          return { isDirectory: () => false, isSymbolicLink: () => false, uid: path === runtime ? uid : 0, mode: 0o100644 };
        }
        return actual.lstat(path);
      },
    }));`;
}

test("missing, symlink, realpath alias, foreign uid, group/world writable, non-directory, or unsafe root parent runtime ancestor fails closed before mkdir/open", async () => {
  const uid = process.getuid?.() ?? 1001;
  const runtime = `/run/user/${uid}`;
  const scenarios = [
    { missingPath: runtime, label: "missing runtime" },
    { missingPath: "/run/user", label: "missing /run/user" },
    { missingPath: "/run", label: "missing /run" },
    { symlinkPath: runtime, label: "symlink runtime" },
    { symlinkPath: "/run/user", label: "symlink /run/user" },
    { aliasPath: runtime, label: "alias realpath runtime" },
    { aliasPath: "/run", label: "alias realpath /run" },
    { foreignUidPath: runtime, label: "foreign uid runtime" },
    { foreignUidPath: "/run/user", label: "foreign uid /run/user" },
    { groupWorldWritablePath: runtime, label: "group/world writable runtime" },
    { groupWorldWritablePath: "/run", label: "group/world writable /run" },
    { nonDirectoryPath: runtime, label: "non-directory runtime" },
    { nonDirectoryPath: "/run/user", label: "non-directory /run/user" },
    { unsafeRootParent: true, label: "unsafe root parent" },
  ];

  for (const scenario of scenarios) {
    const result = run(home(), appId("ancestor_rejection"), "release", {}, ancestorFixture({ ...scenario, expectNoOperations: true }));
    expect(await result.exit).toBe(1);
    const err = result.errors();
    expect(err).toContain("App lock runtime ancestor");
    expect(err).toContain("preflight");
    expect(err).not.toContain("FAIL: mkdir or open called unexpectedly");
    // Fail-closed verification: never fall back to /tmp.
    expect(err).not.toContain("overload-channel-locks-");
  }
});

test("safe runtime mount realpath identity fixture allows acquisition", async () => {
  const result = run(home(), appId("mount_identity"), "release", {}, ancestorFixture({ realMountIdentity: true }));
  expect(await result.exit).toBe(0);
});

function openedFileStatTamperFixture(tamperStat: string): string {
  return `import { mock } from "bun:test";
    import * as fs from "node:fs/promises";
    const actual = { ...fs };
    mock.module("node:fs/promises", () => ({ ...actual,
      open: async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode);
        return new Proxy(handle, {
          get(target, prop, receiver) {
            if (prop === "stat") {
              return async () => {
                const realStat = await target.stat();
                return Object.assign(realStat, ${tamperStat});
              };
            }
            const val = Reflect.get(target, prop, receiver);
            return typeof val === "function" ? val.bind(target) : val;
          },
        });
      },
    }));`;
}

test("opened lock file fails closed when mode is not 0600 or uid is foreign", async () => {
  for (const tamper of [
    "{ mode: 0o100644 }",
    "{ mode: 0o100666 }",
    "{ uid: process.getuid() + 1 }",
    "{ nlink: 2 }",
    "{ isFile: () => false }",
  ]) {
    const result = run(home(), appId("file_tamper"), "release", {}, openedFileStatTamperFixture(tamper));
    expect(await result.exit).toBe(1);
    expect(result.errors()).toContain("single-link regular file owned by this user");
  }
});

test("non-linux platform fails closed", async () => {
  const fixture = `Object.defineProperty(process, "platform", { value: "darwin", configurable: true });`;
  const result = run(home(), appId("non_linux"), "release", {}, fixture);
  expect(await result.exit).toBe(1);
  expect(result.errors()).toContain("Linux systemd-logind runtime directory and flock");
});
