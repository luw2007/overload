import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { audit, parseSince, printAudit } from "../src/cli/audit";

const SCHEMA_SQL = readFileSync(new URL("../src/ingest/schema.sql", import.meta.url), "utf8");
const NOW = 1_800_000_000_000;
const roots: Database[] = [];

afterEach(() => { for (const db of roots.splice(0)) db.close(); });

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
  roots.push(db);
  for (const [stableId, cwd] of [["s1", "/repo/a"], ["s2", "/repo/a"], ["s3", "/repo/b"]]) {
    db.query("INSERT INTO sessions(stable_id, host, runtime, session, origin, cwd, created_at, first_seen_at) VALUES (?, 'local', 'pi', ?, 'agent', ?, ?, ?)")
      .run(stableId, stableId, cwd, NOW - 20_000, NOW - 20_000);
  }
  let seq = 0;
  const add = (stableId: string, at: number, kind: string, detail: Record<string, unknown>): void => {
    seq += 1;
    db.query(`INSERT INTO journal(ingest_seq, host, emitter_id, seq, at, stable_id, writer_id, kind, detail)
      VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?)`).run(seq, `pi-${stableId}`, seq, at, stableId, `pi-${stableId}`, kind, JSON.stringify(detail));
  };
  add("s1", NOW - 10_000, "decision_requested", { request_id: "r1", gated: true, rule: "require_approval" });
  add("s1", NOW - 9_000, "decision_resolved", { request_id: "r1", gated: true, state: "resolved", selected: "approve" });
  add("s2", NOW - 8_000, "decision_requested", { request_id: "r2", gated: true, rule: "require_approval" });
  add("s2", NOW - 7_000, "decision_resolved", { request_id: "r2", gated: true, state: "timed_out" });
  add("s3", NOW - 6_000, "tool_activity", { consequential: true, class: "push" });
  add("s3", NOW - 5_000, "settled", { handoff: { path: "/repo/b/HANDOFF.md", status: "blocked", uncertainties: 1, task: "finish release" } });
  add("s3", NOW - 4_000, "settled", { handoff: { path: "/repo/b/HANDOFF.md", status: "blocked", uncertainties: 2, task: "finish release" } });
  return db;
}

describe("audit", () => {
  test("reports gate pass rate, repeated handoff failures, and missing consequential rule", () => {
    const report = audit(fixture(), { sample: 0, sinceMs: 24 * 60 * 60_000, now: NOW });
    expect(report.passRate).toBe(0.5);
    expect(report.repeatedFailurePatterns).toHaveLength(1);
    expect(report.rulesToAdd).toHaveLength(1);
    const lines: string[] = [];
    printAudit(report, (line) => lines.push(line));
    const output = lines.join("\n");
    expect(output).toContain("PASS_RATE 50.0% (1/2)");
    expect(output).toContain("REPEATED_FAILURE_PATTERNS");
    expect(output).toContain("handoff blocked 2x in /repo/b");
    expect(output).toContain("RULES_TO_ADD");
    expect(output).toContain("class push consequential 1x with no gate → add require_approval pattern");
  });

  test("parses supported since values", () => {
    expect(parseSince("7d")).toBe(7 * 24 * 60 * 60_000);
    expect(parseSince("24h")).toBe(24 * 60 * 60_000);
    expect(parseSince("12345")).toBe(12345);
  });
});
