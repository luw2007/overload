import { describe, expect, test } from "bun:test";
import { queueAfter, type ClassifiableCurrent, type ClassifierEvent } from "./classifier";

const baseCurrent: ClassifiableCurrent = {
  stable_id: "local:pi:handoff",
  state: "working",
  origin: "agent",
  queue: "q3",
  q5_reason: null,
};

function settled(detail: Record<string, unknown>): ClassifierEvent {
  return { ingest_seq: 1, at: 1_700_000_000_001, kind: "settled", detail };
}

describe("settled handoff classification", () => {
  test("routes blocked handoff to Inbox", () => {
    expect(queueAfter(baseCurrent, settled({ handoff: { path: "/repo/HANDOFF.md", status: "blocked", uncertainties: 0 } }))).toEqual({ queue: "q5", q5_reason: "handoff_blocked" });
  });

  test("keeps complete zero-uncertainty handoff on normal Q3 path", () => {
    expect(queueAfter({ ...baseCurrent, queue: "q5", q5_reason: "handoff_blocked" }, settled({ handoff: { path: "/repo/HANDOFF.md", status: "complete", uncertainties: 0 } }))).toEqual({ queue: "q3", q5_reason: null });
  });

  test("keeps settled event without handoff on normal Q3 path", () => {
    expect(queueAfter(baseCurrent, settled({ summary: "done" }))).toEqual({ queue: "q3", q5_reason: null });
  });

  test("later working event clears handoff block", () => {
    expect(queueAfter({ ...baseCurrent, state: "idle", queue: "q5", q5_reason: "handoff_blocked" }, { ingest_seq: 2, at: 1_700_000_000_002, kind: "working", detail: {} })).toEqual({ queue: "q3", q5_reason: null });
  });

  test("keeps the Inbox entry when the session exits, unlike liveness reasons", () => {
    const ended: ClassifierEvent = { ingest_seq: 3, at: 1_700_000_000_003, kind: "session_ended", detail: {} };
    expect(queueAfter({ ...baseCurrent, state: "idle", queue: "q5", q5_reason: "handoff_blocked" }, ended)).toEqual({ queue: "q5", q5_reason: "handoff_blocked" });
    expect(queueAfter({ ...baseCurrent, state: "idle", queue: "q5", q5_reason: "stalled" }, ended)).toEqual({ queue: "q2", q5_reason: null });
  });
});
