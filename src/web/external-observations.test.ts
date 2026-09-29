import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openControl, createWork } from "../control/store";
import { startWebServer } from "./server";
import type { Contract } from "../control/types";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

type TestWebServer = {
  port: number;
  stop(closeActiveConnections?: boolean): void;
};

function makeContract(): Contract {
  return {
    objective: "observe only", acceptance: [{ id: "a", kind: "check", description: "test", evidence: "test" }],
    non_goals: [], scope: { repo: "/repo" }, budget: {}, stop_conditions: [], decision_owner: "alice",
  };
}

function setup(): { server: TestWebServer; controlPath: string; stop(): void } {
  const root = mkdtempSync(join(tmpdir(), "external-observation-api-"));
  roots.push(root);
  const controlPath = join(root, "control.db");
  const db = openControl(controlPath);
  createWork(db, { title: "w", source: "test", contract: makeContract() }, 1);
  db.close();
  const spoolRoot = join(root, "spool");
  mkdirSync(spoolRoot, { recursive: true });
  writeFileSync(join(spoolRoot, "host"), "test-host\n");
  const server = startWebServer({ controlPath, ledgerPath: join(root, "ledger.db"), orchestratorPath: join(root, "orchestrator.db"), spoolRoot, port: 0, publishIntervalMs: 60_000 });
  return { server, controlPath, stop: () => server.stop(true) };
}

describe("external observation API", () => {
  test("POST routes a valid live observation to its existing Work; GET returns it", async () => {
    const env = setup();
    try {
      const db = openControl(env.controlPath);
      const workId = (db.query("SELECT work_id FROM control_works").get() as { work_id: string }).work_id;
      db.close();
      const summary = "shadow observer recorded a state transition";
      const response = await fetch(`http://127.0.0.1:${env.server.port}/api/external-observations`, {
        method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ source_id: "shadow", source_event_id: "e1", observation_revision: 1, work_id: workId, kind: "live", subject: "state changed", summary, content_hash: createHash("sha256").update(summary).digest("hex"), observed_at: "2026-09-28T00:00:00.000Z" }),
      });
      expect(response.status).toBe(200);
      const created = await response.json() as { status: string; observation: { observation_id: string; state: string } };
      expect(created).toMatchObject({ status: "created", observation: { state: "attention_open" } });
      const listed = await fetch(`http://127.0.0.1:${env.server.port}/api/external-observations?work_id=${encodeURIComponent(workId)}`);
      expect(listed.status).toBe(200);
      expect(await listed.json()).toMatchObject({ observations: [{ observation_id: created.observation.observation_id, state: "attention_open" }] });
    } finally { env.stop(); }
  });

  test("POST rejects an invalid hash before creating a row", async () => {
    const env = setup();
    try {
      const response = await fetch(`http://127.0.0.1:${env.server.port}/api/external-observations`, {
        method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
        body: JSON.stringify({ source_id: "shadow", source_event_id: "bad", observation_revision: 1, work_id: null, kind: "live", subject: "bad", summary: "wrong hash", content_hash: "a".repeat(64), observed_at: "2026-09-28T00:00:00.000Z" }),
      });
      expect(response.status).toBe(400);
      const db = openControl(env.controlPath);
      expect(db.query("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='control_external_observations'").get()).toMatchObject({ n: 0 });
      db.close();
    } finally { env.stop(); }
  });
});
