import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { consumeDecision, openMailbox, registerTarget, writeHumanAnswer } from "../decision-bot/mailbox";
import { createWork, getAttention, upsertAttention } from "../control/store";
import { startWebServer } from "./server";

test("extension Origin-only effects replay once and later failed steps reach the original card", async () => {
  const root = mkdtempSync(join(tmpdir(), "effect-consumer-")), controlPath = join(root, "control.db");
  writeFileSync(join(root, "host"), "local\n");
  const db = openMailbox(controlPath);
  const work = createWork(db, { title: "effect", source: "test", contract: {
    objective: "ship", acceptance: [{ id: "check", kind: "check", description: "verified", evidence: "passed" }],
    non_goals: [], scope: { cwd: root }, budget: {}, stop_conditions: [], decision_owner: "owner",
  } });
  const target = registerTarget(db, { consumerOwner: "extension", approvalId: "approve", question: "Proceed?", options: ["approve"],
    effect: "write", scope: { cwd: root }, evidence: { toolCallId: "tool" }, expiresAt: Date.now() + 60000,
    toolCallId: "tool", attemptId: "attempt", workId: work.work_id, contractRevision: 1 });
  upsertAttention(db, { item_id: "item", work_id: work.work_id, state: "applying", effect_state: "applying", urgency: "now",
    conclusion: "Proceed?", trigger: "write", impact: "effect", recommendation: null, options: ["approve"], owner: "owner",
    expires_at: null, source_link: null, approval_id: "approve", consumer_owner: "extension", contract_revision: 1,
    decision_mode: "human_only", evidence: {} });
  writeHumanAnswer(db, "extension", "approve", "approve", "owner");
  const receipt = consumeDecision(db, { consumerOwner: "extension", approvalId: "approve", targetVersion: target.targetVersion,
    policyHash: "human", liveValid: () => true, contractValid: () => true, policyValid: () => false });
  if (!receipt) throw new Error("receipt missing");
  const server = startWebServer({ ledgerPath: join(root, "ledger.db"), controlPath, orchestratorPath: join(root, "orch.db"), spoolRoot: root, port: 0 });
  const base = `http://127.0.0.1:${server.port}`;
  const send = (tool: string, state: string, evidence: Record<string, unknown>, origin = base) => fetch(base + "/api/decision/effect", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ receipt_id: receipt.receiptId, toolCallId: tool, attempt_id: "attempt", effect_state: state, evidence }),
  });
  try {
    expect((await send("tool", "succeeded", {}, "http://other.example")).status).toBe(403);
    const first = await send("tool", "succeeded", { summary: "write completed" });
    expect(first.status).toBe(200); expect(await first.json()).toEqual({ observed: true });
    const version = getAttention(db, "item")!.revision;
    expect(getAttention(db, "item")!.state).toBe("resolved");
    const replay = await send("tool", "succeeded", { summary: "write completed" });
    expect(replay.status).toBe(200); expect(getAttention(db, "item")!.revision).toBe(version);
    expect((await send("tool", "failed", { reason: "contradiction" })).status).toBe(409);
    const next = await send("tool:review", "failed", { reason: "review was denied" });
    expect(next.status).toBe(200);
    expect(getAttention(db, "item")).toMatchObject({ state: "open", effect_state: "failed", effect_detail: "review was denied" });
    expect(db.query("SELECT tool_call_id,state FROM receipt_effect_observations ORDER BY observed_at,tool_call_id").all()).toEqual([
      { tool_call_id: "tool", state: "succeeded" }, { tool_call_id: "tool:review", state: "failed" },
    ]);
  } finally { server.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); }
});
