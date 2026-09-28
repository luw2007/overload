import { describe, expect, test } from "bun:test";
import { beginManagerTurn, finishManagerTurn, getManagerTurn, listManagerTurns, ManagerBusyError } from "./store";
import { controlDb, NOW } from "./test-fixtures";

describe("manager_turns store", () => {
  test("single-flight blocks a second running turn until finished or timed out", () => {
    const db = controlDb();
    const t = beginManagerTurn(db, { source: "web", question: "q", model: "m", now: NOW, timeoutMs: 1000 });
    expect(() => beginManagerTurn(db, { source: "web", question: "q2", model: "m", now: NOW + 10, timeoutMs: 1000 })).toThrow(ManagerBusyError);
    expect(beginManagerTurn(db, { source: "cli", question: "q3", model: "m", now: NOW + 2000, timeoutMs: 1000 }).status).toBe("running");
    finishManagerTurn(db, t.turn_id, { status: "answered", answer_markdown: "a", envelope: { x: 1 }, handoff_receipts: [], finished_at: NOW + 3000 });
    expect(getManagerTurn(db, t.turn_id)).toMatchObject({ status: "answered", envelope: { x: 1 }, handoff_receipts: [] });
    expect(listManagerTurns(db, 10).map((x) => x.question)).toEqual(["q3", "q"]);
  });
});
