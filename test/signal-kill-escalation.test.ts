import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setKillProcessTreeForTesting,
  killProcessTree,
  runCommand,
} from "../src/pull/pull";
import {
  __setKillGroupForTesting,
  commandSnapshot,
  killGroup,
} from "../src/recon/recon";

// The killer spies record every escalation attempt (before delegating to the
// real /bin/kill on the child's own detached process group) so a leaked inner
// KILL timer is observable even when the target pgid is already dead.
type Signal = "TERM" | "KILL";
let pullCalls: Signal[] = [];
let reconCalls: Signal[] = [];

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), "overload-signal-"));
}

function writeScript(dir: string, name: string, body: string, mode = 0o700): string {
  const path = join(dir, name);
  writeFileSync(path, body, { mode });
  return path;
}

/** Node.js script that installs an instant SIGTERM handler and signals readiness. */
function nodeTermOkScript(dir: string): { path: string; readyFile: string } {
  const readyFile = join(dir, "ready");
  const path = writeScript(
    dir,
    "term-ok.js",
    `#!/usr/bin/env node
const fs = require("fs");
process.on("SIGTERM", () => process.exit(0));
fs.writeFileSync(${JSON.stringify(readyFile)}, "1");
setInterval(() => {}, 1000);
`,
  );
  return { path, readyFile };
}

/** Shell script that ignores TERM. */
function shellTermIgnoreScript(dir: string): string {
  return writeScript(
    dir,
    "term-ignore.sh",
    `#!/bin/sh
trap '' TERM
sleep 30
`,
  );
}

/** Shell script with a grandchild that ignores TERM and holds stdout. */
function shellGrandchildScript(dir: string): string {
  return writeScript(
    dir,
    "grandchild.sh",
    `#!/bin/sh
( trap '' TERM; exec sleep 30 ) &
wait
`,
  );
}

/** Wait for a readiness file to appear (bounded poll). */
async function waitForReady(file: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (existsSync(file)) return;
    await Bun.sleep(20);
  }
  throw new Error(`readiness file ${file} did not appear within ${timeoutMs}ms`);
}

/** Bounded poll: assert a predicate stays true until budget elapses. */
async function pollNoKill(calls: Signal[], budgetMs = 2500, intervalMs = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < budgetMs) {
    if (calls.includes("KILL")) {
      throw new Error(`KILL appeared at ${Date.now() - start}ms (calls=${JSON.stringify(calls)})`);
    }
    await Bun.sleep(intervalMs);
  }
  if (calls.includes("KILL")) {
    throw new Error(`KILL appeared after budget (calls=${JSON.stringify(calls)})`);
  }
}

async function noResidue(marker: string): Promise<boolean> {
  const out = Bun.spawn(["pgrep", "-f", marker], { stdout: "pipe", stderr: "ignore" });
  const text = (await new Response(out.stdout).text()).trim();
  await out.exited;
  return text.length === 0;
}

beforeEach(() => {
  pullCalls = [];
  reconCalls = [];
  __setKillProcessTreeForTesting(async (proc, signal) => {
    pullCalls.push(signal);
    await killProcessTree(proc, signal);
  });
  __setKillGroupForTesting(async (proc, signal) => {
    reconCalls.push(signal);
    await killGroup(proc, signal);
  });
});

afterEach(async () => {
  __setKillProcessTreeForTesting(killProcessTree);
  __setKillGroupForTesting(killGroup);
});

describe("pull runCommand signal-kill escalation", () => {
  test("TERM respected does NOT escalate to KILL (inner timer cleared)", async () => {
    const root = mkRoot();
    try {
      const { path: script, readyFile } = nodeTermOkScript(root);
      // Start the process via runCommand; it will write readyFile before keepalive.
      // We don't need to wait separately because runCommand spawns immediately,
      // but the 200ms timeout gives the process time to start.
      await expect(runCommand(["node", script], [], 200)).rejects.toThrow(/timed out/);
      // Core assertion: only TERM was sent, no KILL escalation.
      expect(pullCalls).toEqual(["TERM"]);
      // Bounded poll past the 800ms escalation window: a leaked KILL timer
      // would fire here and be caught immediately.
      await pollNoKill(pullCalls, 2500, 100);
      expect(pullCalls).toEqual(["TERM"]);
      expect(await noResidue(script)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("TERM ignored escalates to KILL within budget", async () => {
    const root = mkRoot();
    try {
      const script = shellTermIgnoreScript(root);
      const start = Date.now();
      await expect(runCommand(["sh", script], [], 200)).rejects.toThrow(/timed out/);
      const elapsed = Date.now() - start;
      // KILL fires at 200 + 800 and reaps the ignoring group.
      expect(pullCalls).toEqual(["TERM", "KILL"]);
      expect(elapsed).toBeLessThan(3000);
      expect(await noResidue(script)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("grandchild holding stdout keeps escalation armed until KILL closes the pipe", async () => {
    const root = mkRoot();
    try {
      const script = shellGrandchildScript(root);
      const start = Date.now();
      await expect(runCommand(["sh", script], [], 200)).rejects.toThrow(/timed out/);
      const elapsed = Date.now() - start;
      // If Promise.all had resolved on proc.exited alone, settle would be ~200ms
      // and KILL would never fire. Resolving only after KILL proves the pipe EOF
      // was awaited and the inner timer stayed armed until the group died.
      expect(pullCalls).toEqual(["TERM", "KILL"]);
      expect(elapsed).toBeGreaterThan(700);
      expect(elapsed).toBeLessThan(3000);
      expect(await noResidue(script)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normal command sends no signal and clears the outer timer", async () => {
    const root = mkRoot();
    try {
      const script = writeScript(root, "normal.sh", `#!/bin/sh\necho hello\n`);
      const out = await runCommand(["sh", script], [], 5000);
      expect(out.trim()).toBe("hello");
      expect(pullCalls).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("recon commandSnapshot signal-kill escalation", () => {
  test("ignored TERM escalates to KILL", async () => {
    const root = mkRoot();
    try {
      const script = shellTermIgnoreScript(root);
      const start = Date.now();
      await expect(
        commandSnapshot(`sh ${script}`, 200, () => ({ sessions: [] })),
      ).rejects.toThrow(/timed out/);
      const elapsed = Date.now() - start;
      expect(reconCalls).toEqual(["TERM", "KILL"]);
      expect(elapsed).toBeLessThan(3000);
      expect(await noResidue(script)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("normal snapshot command sends no signal", async () => {
    const snap = await commandSnapshot(`echo '{"sessions":[]}'`, 2000, (v) => v as { sessions: unknown[] });
    expect(snap.sessions).toEqual([]);
    expect(reconCalls).toEqual([]);
  });
});
