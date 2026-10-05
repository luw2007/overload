import { describe, expect, test } from "bun:test";
import { ManagerReadError, READ_PAGE_SIZE, readManagerView } from "./inspect";
import { controlDb, item, ledgerDb, NOW, session, work } from "./test-fixtures";

const DAY_MS = 86_400_000;
const SEVEN_DAYS = 7 * DAY_MS;

describe("readManagerView", () => {
  test("cursor pagination covers every row exactly once", () => {
    const control = controlDb(); const w = work(control);
    for (let i = 0; i < 30; i++) item(control, w, `i${i}`, { urgency: i % 2 ? "now" : "inbox", at: NOW - 1000 + i });
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const page = readManagerView(control, null, { view: "attention", cursor, now: NOW });
      expect(page.total).toBe(30); expect(page.rows.length).toBeLessThanOrEqual(12);
      seen.push(...page.rows.map((r) => (r as { item_id: string }).item_id));
      cursor = page.next_cursor ?? undefined; pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(30);
  });
  test("targets and sessions views read the ledger; bad view/cursor rejected", () => {
    const control = controlDb(), ledger = ledgerDb(); session(ledger, "s1");
    expect(readManagerView(control, ledger, { view: "targets", now: NOW })).toMatchObject({ total: 1, next_cursor: null });
    expect(readManagerView(control, ledger, { view: "sessions", now: NOW }).rows).toHaveLength(1);
    expect(() => readManagerView(control, ledger, { view: "q1" })).toThrow(ManagerReadError);
    expect(() => readManagerView(control, ledger, { view: "works", cursor: "-1" })).toThrow(ManagerReadError);
  });
  test("done view uses keyset cursor, paginates without loss, and reports exact total", () => {
    const control = controlDb(); const w = work(control);
    const cutoff = NOW - SEVEN_DAYS;
    // 25 recent + 2 ancient
    for (let i = 0; i < 25; i++) item(control, w, `r${i}`, { state: "resolved", at: cutoff + 1 + i });
    item(control, w, "ancient1", { state: "resolved", at: cutoff - 100 });
    item(control, w, "ancient2", { state: "resolved", at: cutoff - 1000 });
    const seen: string[] = []; let cursor: string | undefined; let pages = 0;
    do {
      const page = readManagerView(control, null, { view: "done", cursor, now: NOW });
      expect(page.total).toBe(25); // only recent, cutoff-inclusive total
      expect(page.rows.length).toBeLessThanOrEqual(READ_PAGE_SIZE);
      seen.push(...page.rows.map((r) => (r as { item_id: string }).item_id));
      cursor = page.next_cursor ?? undefined; pages++;
    } while (cursor);
    expect(pages).toBe(Math.ceil(25 / READ_PAGE_SIZE));
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
    expect(seen.sort()).not.toContain("ancient1");
    expect(seen.sort()).not.toContain("ancient2");
    // default order: updated_at DESC, so first row is youngest (r24)
    const first = readManagerView(control, null, { view: "done", now: NOW });
    expect((first.rows[0] as { item_id: string }).item_id).toBe("r24");
  });
  test("done cutoff is inclusive at page level too", () => {
    const control = controlDb(); const w = work(control);
    const cutoff = NOW - SEVEN_DAYS;
    item(control, w, "at-cutoff", { state: "resolved", at: cutoff });
    item(control, w, "just-before", { state: "resolved", at: cutoff - 1 });
    const page = readManagerView(control, null, { view: "done", now: NOW });
    expect(page.total).toBe(1);
    expect((page.rows[0] as { item_id: string }).item_id).toBe("at-cutoff");
    expect((page.rows[0] as { updated_at: number }).updated_at).toBe(cutoff);
  });
  test("invalid done keyset cursor raises ManagerReadError (HTTP 400 path)", () => {
    const control = controlDb(); const w = work(control);
    item(control, w, "d1", { state: "resolved", at: NOW - 1000 });
    expect(() => readManagerView(control, null, { view: "done", cursor: "not-valid-base64!", now: NOW })).toThrow(ManagerReadError);
    // valid base64 but wrong payload
    expect(() => readManagerView(control, null, { view: "done", cursor: Buffer.from("{}").toString("base64url"), now: NOW })).toThrow(ManagerReadError);
    // old numeric offset cursor that works for attention must NOT work for done
    expect(() => readManagerView(control, null, { view: "done", cursor: "0", now: NOW })).toThrow(ManagerReadError);
  });
  test("done rows are redacted/consistent empty shape", () => {
    const control = controlDb(); const w = work(control);
    item(control, w, "secret", { state: "resolved", at: NOW - 1000, conclusion: "token=abcdef1234 done" });
    const page = readManagerView(control, null, { view: "done", now: NOW });
    expect(page.rows).toHaveLength(1);
    const row = page.rows[0] as { conclusion: string; item_id: string; state: string };
    expect(row.item_id).toBe("secret");
    expect(row.state).toBe("resolved");
    expect(row.conclusion).not.toContain("abcdef");
    // empty db returns empty rows but still well-shaped total=0, next_cursor=null
    const empty = readManagerView(controlDb(), null, { view: "done", now: NOW });
    expect(empty).toMatchObject({ view: "done", rows: [], next_cursor: null, total: 0 });
  });
});
