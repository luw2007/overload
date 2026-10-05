import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actOnAttention, createWork, getAttentionMaterial, openControl, resolveAttention, upsertAttention } from "../control/store";
import { openStore } from "../orchestrator/store";
import { contextRoute } from "./context-routes";
import type { Contract } from "../control/types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const contract: Contract = { objective: "ship", acceptance: [{ id: "a", kind: "human", description: "owner accepts" }],
  non_goals: [], scope: { cwd: "/tmp" }, budget: {}, stop_conditions: [], decision_owner: "owner" };

async function request(path: string, controlPath: string, actor?: string, orchestratorPath?: string) {
  const url = new URL(path, "http://localhost");
  const response = await contextRoute(new Request(url), url, { controlPath, actor, orchestratorPath });
  if (!response) throw new Error("context route missing");
  return response;
}

test("receipt retains the decision basis and distinguishes missing history from current context", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-receipt-")); roots.push(root);
  const controlPath = join(root, "control.db"), db = openControl(controlPath);
  try {
    const work = createWork(db, { title: "w", source: "test", contract }, 1000);
    const item = upsertAttention(db, { item_id: "decision", work_id: work.work_id, state: "open", effect_state: "not_started",
      urgency: "now", conclusion: "Continue under the reviewed risk", trigger: "test coverage gap", impact: "existing callers affected",
      recommendation: "continue", options: ["continue", "stop"], owner: "owner", expires_at: null, source_link: null,
      approval_id: null, consumer_owner: null, contract_revision: 1, decision_mode: "human_only", evidence: {} }, 2000);
    resolveAttention(db, item.item_id, { attention_revision: item.revision, material_fingerprint: getAttentionMaterial(db, item.item_id)!.fingerprint,
      selected_option: "continue", reason: "accepted boundary" }, "owner", 3000);
    const path = "/api/context/decision-receipt?item_id=decision";
    expect((await request(path, controlPath)).status).toBe(501);
    expect((await request(path, controlPath, "other")).status).toBe(403);
    const response = await request(path, controlPath, "owner");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.decision).toMatchObject({ selected_option: "continue", decided_at: 3000, actor: "owner", reason: "accepted boundary", context_status: "recorded",
      summary: { contract_revision: 1, trigger: "test coverage gap", impact: "existing callers affected" } });
    expect(body.effect_state).toBe("succeeded");
    db.query("DELETE FROM control_outbox WHERE item_id=?").run(item.item_id);
    const lost = await (await request(path, controlPath, "owner")).json();
    expect(lost.decision.context_status).toBe("unavailable");
    expect(lost.decision.summary).toBeNull();
    expect(lost.decision.selected_option).toBe("continue");
  } finally { db.close(); }
});

test("recovery inspection is owner-only, bound to current revision and cannot authorize execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "context-review-")); roots.push(root);
  const controlPath = join(root, "control.db"), orchestratorPath = join(root, "orch.db");
  const control = openControl(controlPath), tasks = openStore(orchestratorPath);
  try {
    const work = createWork(control, { title: "w", source: "test", contract }, 1000);
    const item = upsertAttention(control, { item_id: "review", work_id: work.work_id, state: "open", effect_state: "not_started",
      urgency: "inbox", conclusion: "Check original task", trigger: "liveness unknown", impact: "do not replay",
      recommendation: "reconcile", options: [], owner: "owner", expires_at: null, source_link: null,
      approval_id: null, consumer_owner: "orchestrator", contract_revision: 1, decision_mode: "human_only",
      evidence: { kind: "context.recovery_reconcile", task_id: "task", attempt_id: "attempt" } }, 2000);
    tasks.query("INSERT INTO tasks(task_id,title,repo,base_ref,state,attempt_id,work_id,contract_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run("task", "original task", "/tmp/repo", "a".repeat(40), "blocked", "attempt", work.work_id, 1, 1000, 1000);
    const path = "/api/context/recovery-review?item_id=review&attention_revision=1";
    expect((await request(path, controlPath, "other", orchestratorPath)).status).toBe(403);
    const response = await request(path, controlPath, "owner", orchestratorPath);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ execution_authorized: false, task: { task_id: "task", attempt_id: "attempt" }, outcome: { type: "reconcile" } });
    expect(tasks.query("SELECT COUNT(*) n FROM task_events").get()).toEqual({ n: 0 });
    actOnAttention(control, item.item_id, item.revision, "ack", {}, "owner", 3000);
    expect((await request(path, controlPath, "owner", orchestratorPath)).status).toBe(409);
  } finally { tasks.close(); control.close(); }
});
