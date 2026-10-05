/**
 * test/cli-actor.test.ts — actor identity + decision-payload gating for the attention CLI.
 * Spawns the real entrypoint against an isolated control DB (OVERLOAD_ANSWERS_PATH)
 * so exit codes, stdout, and DB state are asserted end to end. No real ~/.overload.
 *
 * All resolve tests MUST pass explicit material_fingerprint observed via the read path
 * — CLI resolve never auto-injects fingerprint; store enforces fingerprint equality.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createWork, getAttention, getAttentionMaterial, getWork, openControl, upsertAttention } from "../src/control/store";
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

function seedControl(): string {
  const root = mkdtempSync(join(tmpdir(), "overload-actor-")); roots.push(root);
  writeFileSync(join(root, "host"), "local");
  const ctrlPath = join(root, "control.db");
  const db = openControl(ctrlPath);
  try {
    const work = createWork(db, { title: "w", source: "actor-test", contract: ownerContract });
    upsertAttention(db, {
      item_id: "attn-1", work_id: work.work_id, state: "open", effect_state: "not_started",
      urgency: "now", conclusion: "needs a decision", trigger: "stop condition hit",
      impact: "work held until answered", recommendation: null, options: ["continue"],
      owner: "alice", expires_at: null, source_link: null, approval_id: null,
      consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only",
      evidence: {},
    });
    // upsertAttention creates the projection; verify here so the read path in tests
    // always has a material row to surface.
    const m = getAttentionMaterial(db, "attn-1");
    if (!m) throw new Error("seed did not project material");
  } finally { db.close(); }
  return ctrlPath;
}

async function runCli(args: string[], ctrlPath: string, extraEnv?: Record<string, string>) {
  const root = dirname(ctrlPath);
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OVERLOAD_ANSWERS_PATH: ctrlPath,
      OVERLOAD_LEDGER_PATH: join(root, "ledger.db"),
      OVERLOAD_ROOT: root,
      HOME: join(root, "home"),
      OVERLOAD_ACTOR: "",
      ...extraEnv,
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

function reopenAttention(ctrlPath: string, itemId = "attn-1") {
  const db = openControl(ctrlPath);
  try { return getAttention(db, itemId); } finally { db.close(); }
}
function reopenWork(ctrlPath: string, workId: string) {
  const db = openControl(ctrlPath);
  try { return getWork(db, workId); } finally { db.close(); }
}

describe("attention resolve — actor identity required", () => {
  test("resolve without --actor and without env exits 1 and leaves the item open", async () => {
    const ctrlPath = seedControl();
    // Fingerprint from REAL read command — caller must have seen it.
    const read = await runCli(["attention", "attn-1"], ctrlPath);
    expect(read.exitCode).toBe(0);
    const fp = JSON.parse(read.stdout).material_fingerprint;
    expect(typeof fp).toBe("string");

    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, material_fingerprint: fp, selected_option: "continue" })],
      ctrlPath);
    expect(out.exitCode).toBe(1);
    const item = reopenAttention(ctrlPath)!;
    expect(item.state).toBe("open");
    expect(item.effect_state).toBe("not_started");
  });

  test("OVERLOAD_ACTOR env satisfies the actor gate", async () => {
    const ctrlPath = seedControl();
    const read = await runCli(["attention", "attn-1"], ctrlPath);
    const fp = JSON.parse(read.stdout).material_fingerprint;
    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, material_fingerprint: fp, selected_option: "continue" })],
      ctrlPath, { OVERLOAD_ACTOR: "alice" });
    expect(out.exitCode).toBe(0);
    expect(reopenAttention(ctrlPath)!.state).toBe("resolved");
  });

  test("--actor flag takes precedence over OVERLOAD_ACTOR env", async () => {
    const ctrlPath = seedControl();
    const read = await runCli(["attention", "attn-1"], ctrlPath);
    const fp = JSON.parse(read.stdout).material_fingerprint;
    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, material_fingerprint: fp, selected_option: "continue" }),
      "--actor", "alice"], ctrlPath, { OVERLOAD_ACTOR: "bob" });
    expect(out.exitCode).toBe(0);
    expect(reopenAttention(ctrlPath)!.state).toBe("resolved");
  });
});

describe("attention resolve — must pass explicit decision payload", () => {
  test("missing selected_option exits 1 and does not archive", async () => {
    const ctrlPath = seedControl();
    const read = await runCli(["attention", "attn-1"], ctrlPath);
    const fp = JSON.parse(read.stdout).material_fingerprint;
    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, material_fingerprint: fp })], ctrlPath, { OVERLOAD_ACTOR: "alice" });
    expect(out.exitCode).toBe(1);
    const item = reopenAttention(ctrlPath)!;
    expect(item.state).toBe("open");
  });

  test("missing material_fingerprint fails", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, selected_option: "continue" })], ctrlPath, { OVERLOAD_ACTOR: "alice" });
    expect(out.exitCode).toBe(1);
    expect(reopenAttention(ctrlPath)!.state).toBe("open");
  });

  test("stale material_fingerprint is rejected", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, material_fingerprint: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef", selected_option: "continue" })],
      ctrlPath, { OVERLOAD_ACTOR: "alice" });
    expect(out.exitCode).toBe(1);
    expect(reopenAttention(ctrlPath)!.state).toBe("open");
  });

  test("non-owner is rejected even if flag passes a real identity", async () => {
    const ctrlPath = seedControl();
    const read = await runCli(["attention", "attn-1"], ctrlPath);
    const fp = JSON.parse(read.stdout).material_fingerprint;
    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, material_fingerprint: fp, selected_option: "continue" }),
      "--actor", "bob"], ctrlPath);
    expect(out.exitCode).toBe(1);
    expect(reopenAttention(ctrlPath)!.state).toBe("open");
  });
});

describe("attention resolve — successful consumer closure", () => {
  test("owner + explicit choice + read-observed fingerprint: work.revision advances, effect succeeded, choice recorded in evidence", async () => {
    const ctrlPath = seedControl();
    const item = reopenAttention(ctrlPath)!;
    const workBefore = reopenWork(ctrlPath, item.work_id)!;
    expect(workBefore.revision).toBe(1);

    // Fingerprint from REAL read command — caller observed it.
    const read = await runCli(["attention", "attn-1"], ctrlPath);
    expect(read.exitCode).toBe(0);
    const readPayload = JSON.parse(read.stdout);
    const fp = readPayload.material_fingerprint;
    expect(typeof fp).toBe("string");

    const out = await runCli(["attention", "attn-1", "resolve",
      JSON.stringify({ attention_revision: 1, material_fingerprint: fp, selected_option: "continue", reason: "keep going" }),
      "--actor", "alice"], ctrlPath);
    expect(out.exitCode).toBe(0);

    const resolved = reopenAttention(ctrlPath)!;
    expect(resolved.state).toBe("resolved");
    expect(resolved.effect_state).toBe("succeeded");
    expect(resolved.evidence.selected_option).toBe("continue");
    expect(resolved.evidence.decision_reason).toBe("keep going");
    expect(typeof resolved.evidence.effect_verified_at).toBe("number");

    const workAfter = reopenWork(ctrlPath, item.work_id)!;
    expect(workAfter.revision).toBeGreaterThan(workBefore.revision);
  });
});

describe("attention legacy operations tolerate a missing actor", () => {
  test("ack without --actor and without env is accepted", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["attention", "attn-1", "ack", '{"expected_revision":1}'], ctrlPath);
    expect(out.exitCode).toBe(0);
    const item = reopenAttention(ctrlPath)!;
    expect(item.acknowledged_at).not.toBeNull();
    expect(item.state).toBe("open");
  });
});

describe("context purge actor gating", () => {
  test("purge without --actor and without env exits 1", async () => {
    const ctrlPath = seedControl();
    const out = await runCli(["context", "purge", "some-object", "--reason", "manual"], ctrlPath);
    expect(out.exitCode).toBe(1);
  });
});
