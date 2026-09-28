/**
 * Web decision card → mailbox answer for a live `ask`.
 *
 * A pending ask whose request detail advertises its mailbox target
 * (approval_id + consumer_owner, registered by the extension through
 * /api/decision/target) renders its options as buttons; clicking one in a
 * real Chromium writes the human answer through POST /api/orchestrator/answer,
 * and the extension-side consume returns it exactly once. Asks without a
 * target keep inert chips, and answering never goes through Ack.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startWebServer } from "./server";

const SCHEMA_SQL = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../ingest/schema.sql"), "utf8");
const STABLE_ID = "local:pi:ask-card";
const APPROVAL_ID = `${STABLE_ID}#writer#call-live`;
const roots: string[] = [];
const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type ProbeResult = { answer_status: number; answer_body: Record<string, unknown>; live_buttons: string[]; inert_buttons: number; inert_chips: string[]; ack_requests: number; top_line: string; legacy_q1_path: string };

async function clickGreen(base: string): Promise<ProbeResult> {
  const script = String.raw`
import json, sys
from playwright.sync_api import sync_playwright

base = sys.argv[1]
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    acks = []
    page.on("request", lambda request: acks.append(request.url) if "/api/ack/" in request.url else None)
    # Pending asks live in the primary attention IA (Decide), not only on the Agents diagnostics page.
    page.goto(base + "/decide")
    live = page.locator("article.decision-card", has_text="Green or Blue?")
    inert = page.locator("article.decision-card", has_text="Deploy now?")
    live.locator("button.answer", has_text="Green").wait_for()
    result = {
        "live_buttons": live.locator("button.answer").all_inner_texts(),
        "inert_buttons": inert.locator("button.answer").count(),
        "inert_chips": inert.locator(".option-chip").all_inner_texts(),
        "top_line": page.locator("main").inner_text(),
    }
    with page.expect_response(lambda response: "/api/orchestrator/answer/" in response.url) as answered:
        live.locator("button.answer", has_text="Green").click()
    response = answered.value
    result["answer_status"] = response.status
    result["answer_body"] = response.json()
    result["ack_requests"] = len(acks)
    page.goto(base + "/q1")
    page.locator("article.decision-card", has_text="Green or Blue?").wait_for()
    result["legacy_q1_path"] = page.evaluate("location.pathname")
    print(json.dumps(result))
    browser.close()
`;
  const proc = Bun.spawn(["python3", "-c", script, base], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(`browser probe failed (${exitCode}): ${stderr}`);
  return JSON.parse(stdout.trim());
}

const extensionHeaders = { "content-type": "application/json", "sec-fetch-site": "same-origin" };

describe("live ask decision card", () => {
  test("clicking an option writes the mailbox answer the extension consumes exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-ask-card-"));
    roots.push(root);
    writeFileSync(join(root, "host"), "local\n");
    const ledgerPath = join(root, "ledger.db");
    const controlPath = join(root, "control.db");
    const ledger = new Database(ledgerPath);
    ledger.exec(SCHEMA_SQL);
    ledger.close();
    const server = startWebServer({ ledgerPath, controlPath, orchestratorPath: join(root, "orch.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0 });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    // Exactly what the extension's `ask` sends from its tool_call hook.
    const registered = await fetch(`${base}/api/decision/target`, { method: "POST", headers: extensionHeaders, body: JSON.stringify({
      consumerOwner: "extension", approvalId: APPROVAL_ID, stableId: STABLE_ID, requestUid: APPROVAL_ID,
      question: "Green or Blue?", options: ["Green", "Blue"], effect: "ask_answer", scope: { gate: "ask", cwd: root },
      evidence: { tool: "ask", question: "Green or Blue?", options: ["Green", "Blue"], cwd: root, toolCallId: "call-live" },
      toolCallId: "call-live", decisionMode: "human_only", expiresAt: Date.now() + 3_600_000,
    }) });
    expect(registered.status).toBe(200);
    const { targetVersion } = await registered.json() as { targetVersion: string };

    const now = Date.now();
    const db = new Database(ledgerPath);
    db.run("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?)", [STABLE_ID, "local", "pi", "ask-card", "agent", root, "main", now, now]);
    db.run("INSERT INTO current VALUES (?,?,?,?,?,?,?,?,?,?)", [STABLE_ID, "writer", "awaiting_human", "q1", null, "agent", 1, now, now, now]);
    const insertRequest = "INSERT INTO requests VALUES (?,?,?,?,?,?,'pending',?,NULL,?)";
    db.run(insertRequest, [APPROVAL_ID, STABLE_ID, "writer", "emitter", "call-live", "decision", now, JSON.stringify({
      request_id: "call-live", summary: "Green or Blue?", options: ["Green", "Blue"], approval_id: APPROVAL_ID, consumer_owner: "extension", target_version: targetVersion,
    })]);
    // An ask_user call: observed, but nothing in this runtime can consume a Web answer for it.
    db.run(insertRequest, [`${STABLE_ID}#writer#call-inert`, STABLE_ID, "writer", "emitter", "call-inert", "decision", now - 1_000, JSON.stringify({
      request_id: "call-inert", summary: "Deploy now?", options: ["yes", "no"],
    })]);
    db.close();

    const consume = () => fetch(`${base}/api/decision/consume/${encodeURIComponent(APPROVAL_ID)}`, { method: "POST", headers: extensionHeaders, body: JSON.stringify({ consumer_owner: "extension", target_version: targetVersion }) });
    expect((await consume()).status).toBe(404);

    const probe = await clickGreen(base);
    expect(probe).toMatchObject({ answer_status: 200, answer_body: { ok: true }, live_buttons: ["Green", "Blue"], inert_buttons: 0, inert_chips: ["yes", "no"], ack_requests: 0, legacy_q1_path: "/decide" });
    // Both pending asks are owed decisions in Decide's top line.
    expect(probe.top_line).toContain("2 decisions owed");

    const first = await consume();
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ answer: "Green", actor: "ui", approvalId: APPROVAL_ID, targetVersion });
    expect((await consume()).status).toBe(404);
  }, 60_000);
});
