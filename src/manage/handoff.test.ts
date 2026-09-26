import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureControlSchema } from "../control/store";
import { createDiscoveredWork, bindExecution } from "./store";
import { ensureMgmtSchema } from "./schema";
import { checkHandoffPreconditions } from "./handoff";

const NOW = 1_755_000_000_000;

function fixture() {
  const control = new Database(":memory:");
  control.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(control);
  ensureMgmtSchema(control);
  const workId = createDiscoveredWork(control, "local:pi:stale", "stale work", NOW);
  bindExecution(control, {
    workId, stableId: "local:pi:stale", writerId: "w", agent: "pi", cwd: "/repo",
    coverage: "ledger_full", state: "running", startedAt: NOW - 60_000, observedAt: NOW - 10_000, evidence: {},
  });
  // ledger.current says idle (not running/awaiting), last event 10s ago.
  const ledger = new Database(":memory:");
  ledger.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, state TEXT, last_event_at INTEGER, last_heartbeat_at INTEGER)");
  ledger.run("CREATE TABLE requests(stable_id TEXT, state TEXT)");
  ledger.run("INSERT INTO current VALUES('local:pi:stale','idle',?,?)", [NOW - 10_000, NOW - 10_000]);
  return { control, ledger, workId };
}

describe("checkHandoffPreconditions freshnessMs", () => {
  test("custom freshness_ms=5000 flags a 10s-old last event as stale", () => {
    const { control, ledger, workId } = fixture();
    const pre = checkHandoffPreconditions(control, ledger, workId, { now: NOW, freshnessMs: 5_000 });
    expect(pre.ok).toBe(false);
    expect(pre.cause).toBe("liveness_unknown");
    expect(pre.evidence.cause).toBe("stale");
    control.close(); ledger.close();
  });

  test("default freshnessMs=120000 treats a 10s-old last event as fresh enough", () => {
    const { control, ledger, workId } = fixture();
    const pre = checkHandoffPreconditions(control, ledger, workId, { now: NOW });
    expect(pre.ok).toBe(true);
    control.close(); ledger.close();
  });
});
