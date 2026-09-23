/**
 * test/cli-actor.test.ts — actor identity gating for the attention/context CLI.
 * Spawns the real entrypoint against an isolated control DB (OVERLOAD_ANSWERS_PATH)
 * so exit codes, stderr, and DB state are asserted end to end. No real ~/.overload.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openControl, createWork, upsertAttention, getAttention } from "../src/control/store";
import type { Contract } from "../src/control/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const CLI = join(import.meta.dir, "../src/cli/overload.ts");

const ownerContract: Contract = {
  objective: "ship the fix",
  acceptance: [{ id: "owner", kind: "human", description: "operator reviews" }],
  non_goals: [],
  scope: { cwd: "/tmp" },
  budget: {},
  stop_conditions: [{ id: "approval", kind: "judgment", description: "needs an ok" }],
  decision_owner: "alice",
};

/** Seed a control DB with one open attention item bound to a work that has a
 *  decision_owner (so a plain resolve counts as a context decision). */
function seedControl(): string {
  const root = mkdtempSync(join(tmpdir(), "overload-actor-")); roots.push(root);
  // SpoolWriter (publishControl) reads <OVERLOAD_ROOT>/host and requires local|devbox.
  writeFileSync(join(root, "host"), "local");
  const ctrlPath = join(root, "control.db");
  const db = openControl(ctrlPath);
  try {
    const work = createWork(db, { title: "w", source: "actor-test", contract: ownerContract });
    upsertAttention(db, {
      item_id: "attn-1",
      work_id: work.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "now",
      conclusion: "needs a decision",
      trigger: "stop condition hit",
      impact: "work held until answered",
      recommendation: null,
      options: ["continue"],
      owner: "alice",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: {},
    });
  } finally { db.close(); }
  return ctrlPath;
}

async function runCli(args: string[], ctrlPath: string) {
  const root = dirname(ctrlPath);
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OVERLOAD_ANSWERS_PATH: ctrlPath,
      OVERLOAD_LEDGER_PATH: join(root, "ledger.db"),
      OVERLOAD_ROOT: root,
      HOME: join(root, "home"),
      // Force the environment to provide no actor: the test must not inherit a
      // developer OVERLOAD_ACTOR.
      OVERLOAD_ACTOR: "",
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function reopenState(ctrlPath: string) {
  const db = openControl(ctrlPath);
  try { return getAttention(db, "attn-1"); } finally { db.close(); }
}

describe("attention resolve actor gating", () => {
  test("context resolve without --actor and without env exits 1 and leaves the item open", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["attention", "attn-1", "resolve", '{"expected_revision":1}'], ctrlPath);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("error: context decision requires --actor or OVERLOAD_ACTOR");
    const item = reopenState(ctrlPath)!;
    expect(item.state).toBe("open");
    expect(item.effect_state).toBe("not_started");
    expect(item.revision).toBe(1);
  });

  test("context resolve with --actor proceeds and marks the item resolved", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["attention", "attn-1", "resolve", '{"expected_revision":1}', "--actor", "alice"], ctrlPath);
    expect(out.exitCode).toBe(0);
    const item = reopenState(ctrlPath)!;
    expect(item.state).toBe("resolved");
  });

  test("OVERLOAD_ACTOR env satisfies the context-decision gate", async () => {
    const ctrlPath = seedControl();
    // Re-spawn manually to inject OVERLOAD_ACTOR (runCli forces it empty).
    const root = dirname(ctrlPath);
    const proc = Bun.spawn(["bun", CLI, "attention", "attn-1", "resolve", '{"expected_revision":1}'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OVERLOAD_ANSWERS_PATH: ctrlPath,
        OVERLOAD_LEDGER_PATH: join(root, "ledger.db"),
        OVERLOAD_ROOT: root,
        HOME: join(root, "home"),
        OVERLOAD_ACTOR: "alice",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const [, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).not.toContain("context decision requires");
    expect(reopenState(ctrlPath)!.state).toBe("resolved");
  });
});

describe("attention legacy operations tolerate a missing actor", () => {
  test("ack without --actor and without env is accepted", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["attention", "attn-1", "ack", '{"expected_revision":1}'], ctrlPath);
    expect(out.exitCode).toBe(0);
    const item = reopenState(ctrlPath)!;
    expect(item.acknowledged_at).not.toBeNull();
    expect(item.state).toBe("open");
  });
});

describe("context purge actor gating", () => {
  test("purge without --actor and without env exits 1", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["context", "purge", "some-object", "--reason", "manual"], ctrlPath);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("error: context purge requires --actor or OVERLOAD_ACTOR");
  });
});
