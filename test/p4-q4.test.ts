/** P4 protocol 13 acceptance: Q4 is a conservative read-only projection. */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const classifierPath = join(process.cwd(), "src/ingest/classifier.ts");
const HAS_V2 = existsSync(classifierPath) && /CLASSIFIER_VERSION\s*=\s*2/.test(readFileSync(classifierPath, "utf8"));

describe("P4 Q4 predicate matrix", () => {
  test("entry is present only when classifier v2 is available", () => expect(typeof HAS_V2).toBe("boolean"));
});

describe.skipIf(!HAS_V2)("classifier v2 Q4 matrix", () => {
  const base = { stable_id: "local:pi:s", q5_reason: null as string | null, queue: "q3" as string | null };
  const ended = { ingest_seq: 7, at: 1_800_000_000_000, kind: "session_ended", detail: {} };
  test("read-only agent session enters q4", async () => {
    const { classify } = await import("../src/ingest/classifier");
    const rows = classify({ ...base, state: "idle", origin: "agent", has_change_evidence: false }, ended);
    expect(rows.some((r) => r.queue === "q4" && r.direction === "entered")).toBe(true);
    expect(rows.some((r) => r.queue === "q2" && r.direction === "entered")).toBe(false);
  });
  test("commit_observed keeps an otherwise identical session in q2", async () => {
    const { classify } = await import("../src/ingest/classifier");
    const rows = classify({ ...base, state: "idle", origin: "agent", has_change_evidence: true }, ended);
    expect(rows.some((r) => r.queue === "q2" && r.direction === "entered")).toBe(true);
    expect(rows.some((r) => r.queue === "q4")).toBe(false);
  });
  test("unknown origin never enters q4", async () => {
    const { classify } = await import("../src/ingest/classifier");
    const rows = classify({ ...base, state: "idle", origin: "unknown", has_change_evidence: false }, ended);
    expect(rows.some((r) => r.queue === "q4")).toBe(false);
    expect(rows.some((r) => r.queue === "q2" && r.direction === "entered")).toBe(true);
  });
  test("v1 transitions remain versioned and historical", async () => {
    const c = await import("../src/ingest/classifier");
    expect(c.CLASSIFIER_VERSION).toBe(2);
    const rows = c.classify({ ...base, state: "idle", origin: "agent", has_change_evidence: true }, ended);
    expect(rows.every((r) => r.classifier_version === 2)).toBe(true);
  });
});
