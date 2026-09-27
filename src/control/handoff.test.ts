import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeHandoff, createHandoffRequest, expireStaleHandoffs, getHandoff, HANDOFF_TTL_MS, listHandoffReturns, listPendingHandoffs, markHandoffRead, markReturnPresented, recordHandoffConclusion } from "./handoff";
import { ControlError, openControl } from "./store";
import { startWebServer } from "../web/server";
import type { CollaborationBrief } from "./handoff-types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string { const root = mkdtempSync(join(tmpdir(), "overload-handoff-")); roots.push(root); return root; }

const brief: CollaborationBrief = { version: "collaboration_brief_v0", purpose: "Use the new retry policy", context: "Owner rejected option B", constraints: ["no schema change"], inputs: ["docs/x.md"], acceptance: ["tests green"], return_requirement: "Report adopt/reject with reason" };
const target = { target_kind: "session" as const, target_id: "local:pi:s1" };
const input = { source_kind: "manager_turn" as const, source_id: "turn-1", ...target, brief, original_message: "please forward" };

function code(fn: () => unknown): string | undefined { try { fn(); } catch (error) { return error instanceof ControlError ? error.code + ":" + error.message : String(error); } }

describe("handoff store", () => {
  test("full lifecycle: pending -> read -> defer -> adopt -> conclude -> return queued -> presented", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const receipt = createHandoffRequest(db, input, 1000);
    expect(receipt).toEqual({ request_id: expect.stringMatching(/^[0-9a-f]{64}$/), priority_changed: false, todo_created: false, execution_interrupted: false });
    const id = receipt.request_id;
    expect(listPendingHandoffs(db, target).map((r) => r.request_id)).toEqual([id]);
    expect(markHandoffRead(db, id, 2000)).toMatchObject({ state: "read", read_at: 2000 });
    expect(acknowledgeHandoff(db, id, "defer", "busy", 3000)).toMatchObject({ state: "acknowledged", ack_decision: "defer" });
    expect(listPendingHandoffs(db, target)).toHaveLength(1);
    expect(acknowledgeHandoff(db, id, "adopt", "now free", 4000)).toMatchObject({ ack_decision: "adopt", ack_reason: "now free", acknowledged_at: 4000 });
    expect(listPendingHandoffs(db, target)).toHaveLength(0);
    expect(code(() => acknowledgeHandoff(db, id, "reject", "x"))).toStartWith("conflict");
    expect(recordHandoffConclusion(db, id, "conclusion", "Adopted, retries capped at 3", 5000)).toMatchObject({ state: "concluded", conclusion_text: "Adopted, retries capped at 3" });
    expect(code(() => recordHandoffConclusion(db, id, "decision", "again"))).toStartWith("conflict");
    expect(getHandoff(db, id)!.conclusion_text).toBe("Adopted, retries capped at 3");
    const returns = listHandoffReturns(db, { destination_kind: "manager_conversation", destination_id: "owner" });
    expect(returns).toHaveLength(1);
    expect(returns[0]).toMatchObject({ request_id: id, state: "queued" });
    expect(markReturnPresented(db, id, 6000)).toMatchObject({ state: "presented", presented_at: 6000 });
    db.close();
  });

  test("idempotent create and conflict on different brief", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const a = createHandoffRequest(db, input, 1);
    const b = createHandoffRequest(db, { ...input, brief: { ...brief } }, 2);
    expect(b.request_id).toBe(a.request_id);
    expect(getHandoff(db, a.request_id)!.created_at).toBe(1);
    expect(code(() => createHandoffRequest(db, { ...input, brief: { ...brief, purpose: "other" } }))).toContain("handoff_conflict");
    expect(code(() => createHandoffRequest(db, { ...input, source_id: "t2", original_message: "x".repeat(20_001) }))).toStartWith("invalid");
    db.close();
  });

  test("attention_item source returns to the item; 7 day expiry", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const { request_id } = createHandoffRequest(db, { ...input, source_kind: "attention_item", source_id: "item-9" }, 0);
    recordHandoffConclusion(db, request_id, "decision", "done", 10);
    expect(listHandoffReturns(db, { destination_kind: "attention_item", destination_id: "item-9" })).toHaveLength(1);
    const stale = createHandoffRequest(db, { ...input, source_id: "old" }, 0).request_id;
    expect(expireStaleHandoffs(db, HANDOFF_TTL_MS - 1)).toBe(0);
    expect(expireStaleHandoffs(db, HANDOFF_TTL_MS)).toBe(1);
    expect(getHandoff(db, stale)!.state).toBe("expired");
    expect(getHandoff(db, request_id)!.state).toBe("concluded");
    expect(code(() => acknowledgeHandoff(db, stale, "adopt", ""))).toStartWith("conflict");
    db.close();
  });
});

describe("handoff routes", () => {
  test("create, pending, read, ack, conclude, list, returns", async () => {
    const root = tempRoot(); writeFileSync(join(root, "host"), "local\n");
    const ledger = new Database(join(root, "ledger.db")); ledger.exec(await Bun.file(new URL("../ingest/schema.sql", import.meta.url)).text()); ledger.close();
    const server = startWebServer({ ledgerPath: join(root, "ledger.db"), controlPath: join(root, "c.db"), orchestratorPath: join(root, "o.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const post = (path: string, body: unknown, headers: Record<string, string> = { "Sec-Fetch-Site": "same-origin" }) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    try {
      expect((await post("/api/handoff", input, {})).status).toBe(403);
      const created = await post("/api/handoff", input);
      expect(created.status).toBe(201);
      const { request_id } = await created.json() as { request_id: string };
      expect((await post("/api/handoff", { ...input, brief: { ...brief, purpose: "changed" } })).status).toBe(409);
      expect((await post("/api/handoff", { ...input, brief: { purpose: "x" } })).status).toBe(400);
      expect((await fetch(`${base}/api/handoff/pending?target_kind=session`)).status).toBe(400);
      const pending = await (await fetch(`${base}/api/handoff/pending?target_kind=session&target_id=${encodeURIComponent(target.target_id)}`)).json() as { items: Array<{ request_id: string }> };
      expect(pending.items.map((i) => i.request_id)).toEqual([request_id]);
      expect((await post(`/api/handoff/${request_id}/read`, {})).status).toBe(200);
      expect((await post(`/api/handoff/${request_id}/ack`, { decision: "bogus" })).status).toBe(400);
      expect(await (await post(`/api/handoff/${request_id}/ack`, { decision: "adopt", reason: "ok" })).json()).toMatchObject({ ack_decision: "adopt" });
      expect((await post(`/api/handoff/${request_id}/conclude`, { kind: "conclusion", text: "done" })).status).toBe(200);
      expect((await post(`/api/handoff/${request_id}/conclude`, { kind: "conclusion", text: "again" })).status).toBe(409);
      expect((await post(`/api/handoff/nope/read`, {})).status).toBe(404);
      const listed = await (await fetch(`${base}/api/handoff?state=concluded`)).json() as { items: unknown[] };
      expect(listed.items).toHaveLength(1);
      const returns = await (await fetch(`${base}/api/handoff/returns?destination_kind=manager_conversation&destination_id=owner`)).json() as { items: Array<{ state: string }> };
      expect(returns.items.map((r) => r.state)).toEqual(["queued"]);
    } finally { server.stop(true); }
  });
});
