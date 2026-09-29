import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createWork, openControl, upsertAttention } from "../control/store";
import { startWebServer } from "./server";
import type { Contract } from "../control/types";

const roots: string[] = [];
afterEach(() => {
  delete process.env.OVERLOAD_SEMANTIC_ASSESSMENTS;
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }));
});

type TestWebServer = { port: number; stop(closeActiveConnections?: boolean): void };

function contract(): Contract {
  return { objective: "test advisory assessment", acceptance: [{ id: "a", kind: "check", description: "test", evidence: "test" }], non_goals: [], scope: { repo: "/repo" }, budget: {}, stop_conditions: [], decision_owner: "alice" };
}

function setup(): { server: TestWebServer; itemId: string; stop(): void } {
  const root = mkdtempSync(join(tmpdir(), "semantic-assessment-api-"));
  roots.push(root);
  const controlPath = join(root, "control.db");
  const db = openControl(controlPath);
  const work = createWork(db, { title: "w", source: "test", contract: contract() }, 1);
  const itemId = "semantic-api-card";
  upsertAttention(db, { item_id: itemId, work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "inbox", conclusion: "review", trigger: "changed", impact: "impact", recommendation: "review", options: ["continue"], owner: "alice", expires_at: null, source_link: null, approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {} }, 1);
  db.close();
  const spoolRoot = join(root, "spool"); mkdirSync(spoolRoot, { recursive: true }); writeFileSync(join(spoolRoot, "host"), "test-host\n");
  const server = startWebServer({ controlPath, ledgerPath: join(root, "ledger.db"), orchestratorPath: join(root, "orchestrator.db"), spoolRoot, port: 0, publishIntervalMs: 60_000 });
  return { server, itemId, stop: () => server.stop(true) };
}

function post(base: string, path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
}

describe("semantic assessment API", () => {
  test("feature disabled is inert", async () => {
    const env = setup();
    try {
      const response = await post(`http://127.0.0.1:${env.server.port}`, `/api/attention/${env.itemId}/semantic-assessments`, { model: "jev-fast" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ assessment: null });
    } finally { env.stop(); }
  });

  test("enabled API schedules, claims, and records advisory-only receipt", async () => {
    process.env.OVERLOAD_SEMANTIC_ASSESSMENTS = "1";
    const env = setup();
    try {
      const base = `http://127.0.0.1:${env.server.port}`;
      const scheduled = await post(base, `/api/attention/${env.itemId}/semantic-assessments`, { model: "jev-fast" });
      expect(scheduled.status).toBe(200);
      const scheduledBody = await scheduled.json() as { assessment: { assessment_id: string } };
      const claimed = await post(base, `/api/attention/${env.itemId}/semantic-assessments/claim`, { model: "jev-fast" });
      const claimBody = await claimed.json() as { claims: Array<{ assessment: { assessment_id: string; lease_token: string } }> };
      expect(claimBody.claims).toHaveLength(1);
      expect(claimBody.claims[0]!.assessment.assessment_id).toBe(scheduledBody.assessment.assessment_id);
      const settled = await post(base, `/api/attention/${env.itemId}/semantic-assessments/settle`, { assessment_id: scheduledBody.assessment.assessment_id, lease_token: claimBody.claims[0]!.assessment.lease_token, result: { verdict: "ordinary", rationale: "no independent concern", confidence: 0.9 } });
      expect(settled.status).toBe(200);
      expect(await settled.json()).toMatchObject({ assessment: { state: "completed", verdict: "ordinary" } });
      const listed = await fetch(`${base}/api/attention/${env.itemId}/semantic-assessments`);
      expect(await listed.json()).toMatchObject({ assessments: [{ state: "completed", verdict: "ordinary" }] });
    } finally { env.stop(); }
  });
});

describe("bounded context spool integration", () => {
  test("server pass honors supplied file budget and drains the next sealed segment on the interval", async () => {
    const root = mkdtempSync(join(tmpdir(), "bounded-context-web-"));
    roots.push(root);
    const controlPath = join(root, "control.db");
    const db = openControl(controlPath);
    const work = createWork(db, { title: "w", source: "test", contract: contract() }, 1);
    db.close();
    const spoolRoot = join(root, "spool");
    mkdirSync(spoolRoot, { recursive: true });
    writeFileSync(join(spoolRoot, "host"), "test-host\n");
    const spoolDir = join(spoolRoot, "spool", "test-host", "orchestrator");
    mkdirSync(spoolDir, { recursive: true });
    for (const seq of [1, 2]) {
      const summary = `observation ${seq}`;
      writeFileSync(join(spoolDir, `active-context-collector.${seq}.ndjson`), JSON.stringify({
        v: 1, at: seq, kind: "context.external_observation", detail: {
          source_id: "bounded-web", source_event_id: `event-${seq}`, observation_revision: 1,
          work_id: work.work_id, kind: "historical", subject: `event ${seq}`, summary,
          content_hash: createHash("sha256").update(summary).digest("hex"), observed_at: "2026-09-28T00:00:00.000Z",
        },
      }) + "\n");
    }
    const server = startWebServer({ controlPath, ledgerPath: join(root, "ledger.db"), orchestratorPath: join(root, "orchestrator.db"), spoolRoot, contextIngest: { max_files: 1, max_lines: 10, max_bytes: 100_000 }, publishIntervalMs: 20, port: 0 });
    try {
      // This specifically exercises Bun's live server interval; fake timers cannot advance its event loop.
      await Bun.sleep(90);
      const check = openControl(controlPath);
      try {
        expect(check.query("SELECT COUNT(*) n FROM control_external_observations").get()).toMatchObject({ n: 2 });
      } finally { check.close(); }
      expect(readdirSync(spoolDir).filter((name) => name.includes(".processed."))).toHaveLength(2);
    } finally { server.stop(true); }
  });
});
