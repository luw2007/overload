import { describe, expect, test } from "bun:test";
import { ManagerReadError, readManagerView } from "./inspect";
import { controlDb, item, ledgerDb, NOW, session, work } from "./test-fixtures";

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
});
