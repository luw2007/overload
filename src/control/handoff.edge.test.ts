// Verifier edge cases for context handoff (manager-chat spec §1.5, §5 B).
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acknowledgeHandoff, createHandoffRequest, expireStaleHandoffs, getHandoff, HANDOFF_TTL_MS, listHandoffReturns, listHandoffs, listPendingHandoffs, markHandoffRead, markReturnPresented, recordHandoffConclusion } from "./handoff";
import { ControlError, openControl } from "./store";
import { startWebServer } from "../web/server";
import type { CollaborationBrief } from "./handoff-types";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string { const root = mkdtempSync(join(tmpdir(), "overload-handoff-edge-")); roots.push(root); return root; }
const brief: CollaborationBrief = { version: "collaboration_brief_v0", purpose: "P", context: "C", constraints: ["c1"], inputs: [], acceptance: ["a1"], return_requirement: "R" };
const s1 = { target_kind: "session" as const, target_id: "local:pi:s1" };
const input = { source_kind: "manager_turn" as const, source_id: "turn-1", ...s1, brief };
function err(fn: () => unknown): string { try { fn(); return "no-error"; } catch (error) { return error instanceof ControlError ? `${error.code}:${error.message}` : String(error); } }

describe("handoff store edge cases", () => {
  test("idempotency ignores brief key order and defaulted optional fields", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const a = createHandoffRequest(db, { ...input, brief: { ...brief, constraints: [], inputs: [], acceptance: [], context: "" } }, 1);
    const reordered = { return_requirement: "R", purpose: "P", version: "collaboration_brief_v0" } as unknown as CollaborationBrief;
    expect(createHandoffRequest(db, { ...input, brief: reordered }, 2).request_id).toBe(a.request_id);
    expect(listHandoffs(db)).toHaveLength(1);
    db.close();
  });

  test("brief validation rejects missing purpose, return_requirement, wrong version, non-string lists", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    for (const bad of [{ ...brief, purpose: " " }, { ...brief, return_requirement: "" }, { ...brief, version: "v1" }, { ...brief, inputs: [1] }, null, []]) {
      expect(err(() => createHandoffRequest(db, { ...input, brief: bad as never }))).toStartWith("invalid");
    }
    expect(err(() => createHandoffRequest(db, { ...input, source_kind: "work" as never }))).toStartWith("invalid");
    expect(err(() => createHandoffRequest(db, { ...input, source_id: "" }))).toStartWith("invalid");
    expect(err(() => createHandoffRequest(db, { ...input, target_id: "  " }))).toStartWith("invalid");
    expect(listHandoffs(db)).toHaveLength(0);
    db.close();
  });

  test("original_message boundary: exactly 20000 chars accepted, 20001 rejected", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const ok = createHandoffRequest(db, { ...input, original_message: "x".repeat(20_000) });
    expect(getHandoff(db, ok.request_id)!.original_message).toHaveLength(20_000);
    expect(err(() => createHandoffRequest(db, { ...input, source_id: "t2", original_message: "x".repeat(20_001) }))).toStartWith("invalid");
    db.close();
  });

  test("pending list is scoped to the target and excludes adopted/rejected/concluded/expired", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const mk = (source_id: string, target_id = s1.target_id, at = 1_000) => createHandoffRequest(db, { ...input, source_id, target_id }, at).request_id;
    const pending = mk("p"), read = mk("r"), deferred = mk("d"), adopted = mk("a"), rejected = mk("x"), concluded = mk("c"), other = mk("o", "local:pi:s2");
    markHandoffRead(db, read);
    acknowledgeHandoff(db, deferred, "defer", "later");
    acknowledgeHandoff(db, adopted, "adopt", "ok");
    acknowledgeHandoff(db, rejected, "reject", "no");
    recordHandoffConclusion(db, concluded, "decision", "done");
    const ids = listPendingHandoffs(db, s1).map((r) => r.request_id).sort();
    expect(ids).toEqual([pending, read, deferred].sort());
    expect(listPendingHandoffs(db, { target_kind: "session", target_id: "local:pi:s2" }).map((r) => r.request_id)).toEqual([other]);
    db.close();
  });

  test("ack directly from pending stamps read_at; defer->defer->reject allowed; no_change closes", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const { request_id } = createHandoffRequest(db, input, 1);
    expect(acknowledgeHandoff(db, request_id, "defer", "a", 10)).toMatchObject({ read_at: 10, acknowledged_at: 10 });
    expect(acknowledgeHandoff(db, request_id, "defer", "b", 20)).toMatchObject({ read_at: 10, acknowledged_at: 20, ack_reason: "b" });
    expect(acknowledgeHandoff(db, request_id, "reject", "c", 30)).toMatchObject({ ack_decision: "reject", acknowledged_at: 30 });
    expect(err(() => acknowledgeHandoff(db, request_id, "adopt", "d"))).toStartWith("conflict");
    const other = createHandoffRequest(db, { ...input, source_id: "t2" }).request_id;
    acknowledgeHandoff(db, other, "no_change", "already done");
    expect(err(() => acknowledgeHandoff(db, other, "adopt", ""))).toStartWith("conflict");
    expect(err(() => acknowledgeHandoff(db, other, "maybe" as never, ""))).toStartWith("invalid");
    expect(err(() => acknowledgeHandoff(db, "missing", "adopt", ""))).toStartWith("not_found");
    db.close();
  });

  test("markHandoffRead is idempotent and does not move later states back", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const { request_id } = createHandoffRequest(db, input, 1);
    expect(markHandoffRead(db, request_id, 5)).toMatchObject({ state: "read", read_at: 5 });
    expect(markHandoffRead(db, request_id, 9)).toMatchObject({ state: "read", read_at: 5 });
    acknowledgeHandoff(db, request_id, "adopt", "ok", 10);
    expect(markHandoffRead(db, request_id, 11)).toMatchObject({ state: "acknowledged", ack_decision: "adopt" });
    expect(err(() => markHandoffRead(db, "missing"))).toStartWith("not_found");
    db.close();
  });

  test("conclusion is immutable, bounded, and queued exactly once to the derived origin", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const { request_id } = createHandoffRequest(db, { ...input, source_kind: "attention_item", source_id: "item-1" }, 1);
    expect(err(() => recordHandoffConclusion(db, request_id, "decision", "x".repeat(20_001)))).toStartWith("invalid");
    expect(err(() => recordHandoffConclusion(db, request_id, "note" as never, "x"))).toStartWith("invalid");
    expect(err(() => recordHandoffConclusion(db, request_id, "decision", "   "))).toStartWith("invalid");
    recordHandoffConclusion(db, request_id, "decision", "first", 2);
    expect(err(() => recordHandoffConclusion(db, request_id, "decision", "second", 3))).toStartWith("conflict");
    expect(getHandoff(db, request_id)).toMatchObject({ conclusion_text: "first", conclusion_kind: "decision", concluded_at: 2 });
    expect(listHandoffReturns(db, { destination_kind: "attention_item", destination_id: "item-1" }).map((r) => r.state)).toEqual(["queued"]);
    expect(listHandoffReturns(db, { destination_kind: "manager_conversation", destination_id: "owner" })).toEqual([]);
    expect(markReturnPresented(db, request_id, 4)).toMatchObject({ state: "presented", presented_at: 4 });
    expect(markReturnPresented(db, request_id, 5)).toMatchObject({ state: "presented", presented_at: 4 });
    expect(err(() => markReturnPresented(db, "missing"))).toStartWith("not_found");
    db.close();
  });

  test("expiry: 7d boundary per state; concluded/expired untouched; expired cannot be read, acked or concluded", () => {
    const db = openControl(join(tempRoot(), "c.db"));
    const mk = (source_id: string, at: number) => createHandoffRequest(db, { ...input, source_id }, at).request_id;
    const fresh = mk("fresh", 1), read = mk("read", 0), deferred = mk("defer", 0), concluded = mk("done", 0);
    markHandoffRead(db, read, 1);
    acknowledgeHandoff(db, deferred, "defer", "later", 1);
    recordHandoffConclusion(db, concluded, "decision", "ok", 1);
    expect(expireStaleHandoffs(db, HANDOFF_TTL_MS)).toBe(2);
    expect(getHandoff(db, fresh)!.state).toBe("pending");
    expect(getHandoff(db, read)!.state).toBe("expired");
    expect(getHandoff(db, deferred)!.state).toBe("expired");
    expect(getHandoff(db, concluded)!.state).toBe("concluded");
    expect(expireStaleHandoffs(db, HANDOFF_TTL_MS)).toBe(0);
    expect(listPendingHandoffs(db, s1).map((r) => r.request_id)).toEqual([fresh]);
    expect(err(() => markHandoffRead(db, read))).toStartWith("conflict");
    expect(err(() => recordHandoffConclusion(db, read, "decision", "late"))).toStartWith("conflict");
    expect(listHandoffs(db, "expired")).toHaveLength(2);
    db.close();
  });

  test("schema is created lazily on a bare database without ensureControlSchema", () => {
    const db = new Database(":memory:");
    expect(listHandoffs(db)).toEqual([]);
    const { request_id } = createHandoffRequest(db, input);
    expect(getHandoff(db, request_id)!.state).toBe("pending");
    db.close();
  });
});

describe("handoff routes edge cases", () => {
  test("validation, CSRF, expiry-on-read and unknown paths through the real server", async () => {
    const root = tempRoot(); writeFileSync(join(root, "host"), "local\n");
    const ledger = new Database(join(root, "ledger.db")); ledger.exec(await Bun.file(new URL("../ingest/schema.sql", import.meta.url)).text()); ledger.close();
    const controlPath = join(root, "c.db");
    const server = startWebServer({ ledgerPath: join(root, "ledger.db"), controlPath, orchestratorPath: join(root, "o.db"), spoolRoot: root, publishIntervalMs: 60_000, port: 0 });
    const base = `http://127.0.0.1:${server.port}`;
    const H = { "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" };
    const post = (path: string, body: string, headers: Record<string, string> = H) => fetch(base + path, { method: "POST", headers, body });
    try {
      expect((await post("/api/handoff", "not json")).status).toBe(400);
      expect((await post("/api/handoff", "[1]")).status).toBe(400);
      expect((await post("/api/handoff", JSON.stringify({ ...input, target_kind: "stable_id" }))).status).toBe(400);
      expect((await post("/api/handoff", JSON.stringify(input), { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
      expect((await post("/api/handoff", JSON.stringify(input), { ...H, Origin: "http://evil.example" })).status).toBe(403);
      const conflict = await post("/api/handoff", JSON.stringify(input));
      expect(conflict.status).toBe(201);
      const again = await post("/api/handoff", JSON.stringify({ ...input, brief: { ...brief, purpose: "other" } }));
      expect(again.status).toBe(409);
      expect(await again.json()).toMatchObject({ error: "conflict", message: expect.stringContaining("handoff_conflict") });
      expect((await fetch(`${base}/api/handoff?state=bogus`)).status).toBe(400);
      expect((await fetch(`${base}/api/handoff/returns?destination_kind=manager_conversation`)).status).toBe(400);
      expect((await fetch(`${base}/api/handoff/pending?target_kind=stable_id&target_id=x`)).status).toBe(400);
      expect((await post("/api/handoff/abc/frob", "{}")).status).toBe(404);
      // A stale request written directly is expired by the pending read.
      const db = openControl(controlPath);
      const stale = createHandoffRequest(db, { ...input, source_id: "old" }, Date.now() - HANDOFF_TTL_MS - 1).request_id;
      db.close();
      const pending = await (await fetch(`${base}/api/handoff/pending?target_kind=session&target_id=${encodeURIComponent(s1.target_id)}`)).json() as { items: Array<{ request_id: string }> };
      expect(pending.items.map((i) => i.request_id)).not.toContain(stale);
      expect((await post(`/api/handoff/${stale}/ack`, JSON.stringify({ decision: "adopt", reason: "late" }))).status).toBe(409);
      expect((await post(`/api/handoff/${stale}/conclude`, JSON.stringify({ kind: "decision", text: "late" }))).status).toBe(409);
      const expired = await (await fetch(`${base}/api/handoff?state=expired`)).json() as { items: Array<{ request_id: string }> };
      expect(expired.items.map((i) => i.request_id)).toEqual([stale]);
    } finally { server.stop(true); }
  });
});
