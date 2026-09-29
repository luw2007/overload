import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createWork, openControl, upsertAttention } from "../control/store";
import { startWebServer } from "./server";

/**
 * A deployed dashboard with no server-injected actor (§4.2) answers 501 on every context route, so
 * every owed decision arrives without its package and cannot be answered. That is a deployment fault,
 * and the page has to name it: a decision surface that quietly shows "refresh" for a fault no refresh
 * can clear looks healthy while being unusable, which is how it survived on the macOS install.
 *
 * Driven through real Chromium against the real server — a stubbed decision-package route would have
 * asserted the client's own fixture rather than what a misconfigured deployment actually returns.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = readFileSync(join(__dirname, "../ingest/schema.sql"), "utf8");
const roots: string[] = [];
const servers: Array<{ stop(c?: boolean): void }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function seed(root: string): string {
  const ledgerPath = join(root, "ledger.db");
  const ledger = new Database(ledgerPath);
  ledger.exec(SCHEMA_SQL);
  ledger.close();
  const controlPath = join(root, "control.db");
  const control = openControl(controlPath);
  const work = createWork(control, { title: "actor-gap", source: "test", contract: {
    objective: "prove the decision surface needs an actor", acceptance: [{ id: "a1", kind: "human", description: "operator decides" }],
    non_goals: [], scope: { cwd: "/tmp" }, budget: {}, stop_conditions: [], decision_owner: "operator",
  } });
  upsertAttention(control, {
    item_id: "att-actor-1", work_id: work.work_id, state: "open", effect_state: "not_started", urgency: "now",
    conclusion: "需要决策", trigger: "test", impact: "test impact", recommendation: "continue",
    options: ["stop", "continue"], owner: "operator", expires_at: null, source_link: null,
    approval_id: null, consumer_owner: null, contract_revision: work.revision, decision_mode: "human_only", evidence: {},
  });
  control.close();
  return controlPath;
}

function boot(root: string, controlPath: string, actor?: string): string {
  writeFileSync(join(root, "host"), "local\n");
  const server = startWebServer({
    ledgerPath: join(root, "ledger.db"), controlPath, orchestratorPath: join(root, "orch.db"),
    spoolRoot: root, publishIntervalMs: 60_000, port: 0, actor,
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

/** Loads /decide and reports the owed row once it has stopped loading its package. */
async function readDecide(base: string): Promise<Record<string, any>> {
  const script = String.raw`
import json, sys
from playwright.sync_api import sync_playwright

base = sys.argv[1]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(base + "/decide")
    row = page.locator('[data-item-id="att-actor-1"]')
    row.wait_for()
    page.wait_for_function(
        "() => { const n = document.querySelector('[data-item-id=\"att-actor-1\"] .row-note');"
        " return !n || !n.textContent.startsWith('Loading decision context'); }"
    )
    print(json.dumps({
        "row": row.inner_text(),
        "resolve_buttons": row.locator('button[data-action="resolve"]').count(),
        "main": page.locator("#main").inner_text(),
    }))
    browser.close()
`;
  // The server under test runs in this process, so the probe has to be awaited, never spawnSync'd:
  // a blocking wait would stop Bun answering the very requests the page is making.
  const proc = Bun.spawn(["python3", "-c", script, base], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`browser probe failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim());
}

describe("a deployed decision surface with no server actor", () => {
  test("the page names the missing operator identity instead of telling the operator to refresh", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-actor-gap-"));
    roots.push(root);
    const controlPath = seed(root);

    const without = await readDecide(boot(root, controlPath, undefined));
    // The page renders — it is not stuck — but the row says the decision cannot be answered and why.
    expect(without.main).not.toBe("Loading…");
    expect(without.row).toContain("需要决策");
    expect(without.resolve_buttons).toBe(0);
    expect(without.row).toContain("OVERLOAD_ACTOR");
    expect(without.row).toContain("Refreshing will not help");
    expect(without.row).not.toContain("Refresh before answering");
    // The waits section reports the same fault instead of disappearing without a word.
    expect(without.main).toContain("Waiting on conditions");
    expect(without.main).toContain("OVERLOAD_ACTOR");

    // The same deployment with the work's decision_owner injected server-side is answerable.
    const configured = await readDecide(boot(root, controlPath, "operator"));
    expect(configured.resolve_buttons).toBeGreaterThan(0);
    expect(configured.main).not.toContain("OVERLOAD_ACTOR");
  }, 120_000);
});
