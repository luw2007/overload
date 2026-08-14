import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLASSIFIER_VERSION, queueAfter } from "../ingest/classifier";
import { printQ4 } from "./overload";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const done = { ingest_seq: 9, at: 99, kind: "session_ended", detail: {} };
const base = { stable_id: "local:pi:read-only", state: "done", origin: "agent", queue: "q3", q5_reason: null };

describe("classifier v2 Q4", () => {
  test("auto-verifies only done agent sessions with zero change evidence", () => {
    expect(CLASSIFIER_VERSION).toBe(2);
    expect(queueAfter({ ...base, has_change_evidence: false }, done).queue).toBe("q4");
    expect(queueAfter({ ...base, has_change_evidence: true }, done).queue).toBe("q2");
  });

  test("never auto-verifies unknown, human, or unfinished sessions", () => {
    expect(queueAfter({ ...base, origin: "unknown", has_change_evidence: false }, done).queue).toBe("q2");
    expect(queueAfter({ ...base, origin: "human", has_change_evidence: false }, done).queue).toBeNull();
    expect(queueAfter({ ...base, state: "idle", has_change_evidence: false }, { ...done, kind: "settled" }).queue).toBe("q3");
  });
});

describe("overload q4", () => {
  test("prints auto-verified read-only sessions", () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-")); roots.push(root);
    const db = new Database(join(root, "ledger.db"));
    db.run("CREATE TABLE current(stable_id TEXT, origin TEXT, last_event_at INTEGER, queue TEXT)");
    db.run("INSERT INTO current VALUES ('local:pi:read-only', 'agent', 1700000000000, 'q4')");
    const lines: string[] = [];
    printQ4(db, (line) => lines.push(line));
    expect(lines.join("\n")).toContain("Q4 auto-verified read-only sessions:");
    expect(lines.join("\n")).toContain("local:pi:read-only\tagent");
    db.close();
  });
});
