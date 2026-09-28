import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMailbox, registerTarget } from "../decision-bot/mailbox";
import { proposePolicyCandidate, loadPolicy } from "../decision-bot/policy";
import { createWork, upsertAttention } from "../control/store";
import { ensureAdapterSchema } from "../adapters/store";
import { startWebServer } from "./server";

const roots: string[] = [];
const servers: Array<{ stop(c?: boolean): void }> = [];
const SCHEMA_SQL = readFileSync(join(import.meta.dir, "../ingest/schema.sql"), "utf8");

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  delete process.env.OVERLOAD_ANSWERS_PATH;
});

function seedLedger(): string {
  const root = mkdtempSync(join(tmpdir(), "overload-audit-api-"));
  roots.push(root);
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  db.run("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", ["remote:pi:alpha", "buildbox", "pi", "alpha", "agent", "/repo", "main", 1_700_000_000_000, 1_700_000_000_000]);
  db.close();
  return path;
}

async function boot(path: string, controlPath?: string, policyPath?: string) {
  const root = join(path, "..");
  writeFileSync(join(root, "host"), "local\n");
  const server = startWebServer({ ledgerPath: path, controlPath, policyPath, orchestratorPath: join(root, "orch.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0 });
  servers.push(server);
  const base = `http://127.0.0.1:${server.port}`;
  return { server, base };
}

/** Full CSRF headers: origin + sec-fetch-site (required by /api/decision/* and /api/orchestrator/* routes). */
function csrf(base: string) {
  return { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" };
}

describe("WEB-09 conversations API", () => {
  test("GET /api/conversations returns empty array on fresh DB", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/conversations`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("GET /api/conversations lists seeded conversations with turns", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    ensureAdapterSchema(db);
    db.run("INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES('conv-1','bk-1','{}','owner',1)");
    db.run("INSERT INTO conversation_turns(id,conversation_id,sequence,text,state,created_at) VALUES('turn-1','conv-1',1,'hello','queued',2)");
    db.close();
    const { base } = await boot(path, ctrl);
    const rows = await (await fetch(`${base}/api/conversations`)).json() as Array<{ id: string; turns: unknown[] }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("conv-1");
    expect(rows[0]!.turns).toHaveLength(1);
    expect(rows[0]!.turns[0]).toMatchObject({ text: "hello" });
  });

  test("POST /api/conversations/:id/messages enqueues a turn and returns 201", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    ensureAdapterSchema(db);
    db.run("INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES('conv-1','bk-1','{}','owner',1)");
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/conversations/conv-1/messages`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ text: "new message" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("turn_id");
    // Verify the turn was inserted
    const inspect = openMailbox(ctrl);
    const row = inspect.query("SELECT text,state FROM conversation_turns WHERE conversation_id='conv-1' ORDER BY sequence").all() as Array<{ text: string; state: string }>;
    inspect.close();
    expect(row).toHaveLength(1);
    expect(row[0]!.text).toBe("new message");
    expect(row[0]!.state).toBe("queued");
  });

  test("POST /api/conversations/:id/messages returns 404 for unknown conversation", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/conversations/no-such/messages`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/conversations/:id/messages returns 400 for empty text", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    ensureAdapterSchema(db);
    db.run("INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES('conv-1','bk-1','{}','owner',1)");
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/conversations/conv-1/messages`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ text: "   " }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/conversations/:id/messages without Origin returns 403", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    ensureAdapterSchema(db);
    db.run("INSERT INTO conversations(id,binding_key,address,owner_id,created_at) VALUES('conv-1','bk-1','{}','owner',1)");
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/conversations/conv-1/messages`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hi" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("WEB-12 propose-rule", () => {
  test("POST /api/attention/:id/propose-rule returns 400 without answer", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/attention/attn-1/propose-rule`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/attention/:id/propose-rule returns 409 for unknown attention", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/attention/no-such/propose-rule`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ answer: "allow" }),
    });
    expect(res.status).toBe(409);
  });

  test("POST /api/attention/:id/propose-rule without Origin returns 403", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/attention/attn-1/propose-rule`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ answer: "allow" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("WEB-13 decision-bot status", () => {
  test("GET /api/decision-bot/status returns identity, targets, and attempts arrays", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision-bot/status`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty("identity");
    expect(Array.isArray(body.targets)).toBe(true);
    expect(Array.isArray(body.attempts)).toBe(true);
  });
});

describe("WEB-15 candidates", () => {
  test("GET /api/candidates returns empty array on fresh DB", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/candidates`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("GET /api/candidates lists seeded policy candidates", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    const rule = { id: "r1", consumer_owner: "extension" as const, gate: "action", effect: "write", answers: ["allow"], cwd: "/repo", command: "echo ok" };
    proposePolicyCandidate(db, rule, 1);
    db.close();
    const { base } = await boot(path, ctrl);
    const rows = await (await fetch(`${base}/api/candidates`)).json() as Array<{ candidateId: string }>;
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.candidateId).toBeTruthy();
  });

  test("POST /api/candidates/:id/approve approves a candidate", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    const rule = { id: "r2", consumer_owner: "extension" as const, gate: "action", effect: "write", answers: ["allow"], cwd: "/repo", command: "echo ok" };
    const candidate = proposePolicyCandidate(db, rule, 1);
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/candidates/${candidate.candidateId}/approve`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ actor: "operator", observation_until: Date.now() + 86_400_000 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.approvedBy).toBe("operator");
  });

  test("POST /api/candidates/:id/approve returns 409 for unknown candidate", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/candidates/no-such/approve`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ actor: "op", observation_until: Date.now() + 86_400_000 }),
    });
    expect(res.status).toBe(409);
  });

  test("POST /api/candidates/:id/approve without Origin returns 403", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/candidates/xyz/approve`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ actor: "op", observation_until: Date.now() + 86_400_000 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("WEB-17 work-ops (contract/redirect/stop)", () => {
  const validContract = {
    objective: "ship", acceptance: [{ id: "owner", kind: "human", description: "review" }],
    non_goals: [], scope: { cwd: "/repo" }, budget: {},
    stop_conditions: [{ id: "c1", kind: "judgment", description: "owner stops" }],
    decision_owner: "op",
  };

  test("POST /api/works/:id/stop records a stop condition", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    const work = createWork(db, { title: "w", source: "test", contract: validContract });
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/works/${work.work_id}/stop`, {
      method: "POST", headers: csrf(base),
      body: JSON.stringify({ expected_revision: work.revision, condition_id: "c1", evidence: { reason: "done" } }),
    });
    expect(res.status).toBe(200);
  });

  test("POST /api/works/:id/stop returns 404 for unknown work", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/works/no-such/stop`, {
      method: "POST", headers: csrf(base),
      body: JSON.stringify({ expected_revision: 1, condition_id: "c1", evidence: {} }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/works/:id/stop returns 400 without expected_revision", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    const work = createWork(db, { title: "w", source: "test" });
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/works/${work.work_id}/stop`, {
      method: "POST", headers: csrf(base),
      body: JSON.stringify({ condition_id: "c1", evidence: {} }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/works/:id/stop without Origin returns 403", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/works/any/stop`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ expected_revision: 1, condition_id: "c1", evidence: {} }),
    });
    expect(res.status).toBe(403);
  });

  test("POST /api/works/:id/contract revises contract", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    const work = createWork(db, { title: "w", source: "test", contract: validContract });
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/works/${work.work_id}/contract`, {
      method: "POST", headers: csrf(base),
      body: JSON.stringify({ expected_revision: work.revision, contract: validContract, reason: "update" }),
    });
    expect(res.status).toBe(200);
  });
});

describe("WEB-32 decision-target", () => {
  test("POST /api/decision/target registers a target and returns 200", async () => {
    const path = seedLedger();
    const root = join(path, "..");
    const ctrl = join(root, "control.db");
    writeFileSync(join(root, "config.json"), JSON.stringify({ decision_bot: { enabled: true, model: "t", timeout_ms: 1000, max_output_bytes: 1024, rules: [] } }));
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl, join(root, "config.json"));
    const payload = {
      consumerOwner: "extension", approvalId: "app-1", options: ["allow", "deny"],
      question: "deploy?", effect: "write", scope: { gate: "action", cwd: "/repo" },
      evidence: { command: "echo ok" }, expiresAt: Date.now() + 60_000, decisionMode: "human_only",
    };
    const res = await fetch(`${base}/api/decision/target`, {
      method: "POST", headers: csrf(base), body: JSON.stringify(payload),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.consumerOwner).toBe("extension");
    expect(body.approvalId).toBe("app-1");
  });

  test("POST /api/decision/target returns 400 for invalid body", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision/target`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ wrong: "field" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/decision/target returns 403 without sec-fetch headers", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision/target`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ consumerOwner: "extension", approvalId: "x", options: ["a"] }),
    });
    expect(res.status).toBe(403);
  });
});

describe("WEB-33 orchestrator-answer", () => {
  test("POST /api/orchestrator/answer/:id writes human answer and returns 200", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    const db = openMailbox(ctrl);
    registerTarget(db, {
      consumerOwner: "orchestrator", approvalId: "ans-1", question: "approve?", options: ["approve"],
      effect: "push_and_create_pr", scope: { gate: "ready", repo: "/repo" }, evidence: {},
      expiresAt: Date.now() + 60_000,
    });
    db.close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/orchestrator/answer/ans-1`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ answer: "approve" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("POST /api/orchestrator/answer/:id returns 400 for malformed JSON", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/orchestrator/answer/ans-2`, {
      method: "POST", headers: csrf(base), body: "not json",
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/orchestrator/answer/:id returns 400 without answer field", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/orchestrator/answer/ans-3`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ wrong: "field" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/orchestrator/answer/:id returns 403 without sec-fetch headers", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/orchestrator/answer/ans-4`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ answer: "approve" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("WEB-34 decision-consume", () => {
  test("POST /api/decision/consume/:id returns 404 when no valid target exists", async () => {
    const path = seedLedger();
    const root = join(path, "..");
    const ctrl = join(root, "control.db");
    writeFileSync(join(root, "config.json"), JSON.stringify({ decision_bot: { enabled: true, model: "t", timeout_ms: 1000, max_output_bytes: 1024, rules: [] } }));
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl, join(root, "config.json"));
    const res = await fetch(`${base}/api/decision/consume/no-such`, {
      method: "POST", headers: csrf(base),
      body: JSON.stringify({ consumer_owner: "extension", target_version: "v1" }),
    });
    expect(res.status).toBe(404);
  });

  test("POST /api/decision/consume/:id returns 400 for invalid body", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision/consume/app-1`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ wrong: "field" }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /api/decision/consume/:id returns 403 without sec-fetch headers", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision/consume/app-1`, {
      method: "POST", headers: { origin: base, "content-type": "application/json" },
      body: JSON.stringify({ consumer_owner: "extension", target_version: "v1" }),
    });
    expect(res.status).toBe(403);
  });
});

describe("WEB-35 bot-status (disable/enable)", () => {
  test("POST /api/decision-bot/disable sets disabled=true", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision-bot/disable`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({ reason: "testing" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: true });
    const inspect = openMailbox(ctrl);
    expect((inspect.query("SELECT disabled FROM bot_control WHERE id=1").get() as { disabled: number }).disabled).toBe(1);
    inspect.close();
  });

  test("POST /api/decision-bot/enable sets disabled=false", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision-bot/enable`, {
      method: "POST", headers: csrf(base), body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabled: false });
    const inspect = openMailbox(ctrl);
    expect((inspect.query("SELECT disabled FROM bot_control WHERE id=1").get() as { disabled: number }).disabled).toBe(0);
    inspect.close();
  });

  test("POST /api/decision-bot/disable without Origin returns 403", async () => {
    const path = seedLedger();
    const ctrl = join(join(path, ".."), "control.db");
    openMailbox(ctrl).close();
    const { base } = await boot(path, ctrl);
    const res = await fetch(`${base}/api/decision-bot/disable`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "x" }),
    });
    expect(res.status).toBe(403);
  });
});
