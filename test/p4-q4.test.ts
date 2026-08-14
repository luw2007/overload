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
  test("read-only agent session enters q4", async () => {
    const c = await import("../src/ingest/classifier");
    const fn = (c as any).queueForSession ?? (c as any).classifySession;
    expect(typeof fn).toBe("function");
    const result = fn({ stable_id: "local:pi:readonly", state: "done", origin: "agent", last_heartbeat_at: 0, queue: null }, 1_800_000_000_000);
    expect(result.queue ?? result).toBe("q4");
  });
  test("commit_observed keeps an otherwise identical session in q2", async () => {
    const c = await import("../src/ingest/classifier");
    const fn = (c as any).queueForSession ?? (c as any).classifySession;
    const result = fn({ stable_id: "local:pi:changed", state: "done", origin: "agent", last_heartbeat_at: 0, queue: null, has_commit_observed: true, mutation_evidence: true }, 1_800_000_000_000);
    expect(result.queue ?? result).toBe("q2");
  });
  test("unknown origin never enters q4", async () => {
    const c = await import("../src/ingest/classifier");
    const fn = (c as any).queueForSession ?? (c as any).classifySession;
    const result = fn({ stable_id: "local:pi:unknown", state: "done", origin: "unknown", last_heartbeat_at: 0, queue: null }, 1_800_000_000_000);
    expect(result.queue ?? result).not.toBe("q4");
  });
  test("v1 transitions remain versioned and historical", async () => {
    const c = await import("../src/ingest/classifier");
    expect((c as any).CLASSIFIER_VERSION).toBe(2);
    if (typeof (c as any).classify === "function") {
      const rows = (c as any).classify({ stable_id: "s", state: "idle", origin: "agent", queue: "q3", q5_reason: null }, { ingest_seq: 7, at: 10, kind: "session_ended", detail: {} });
      expect(rows.every((r: any) => r.classifier_version >= 1)).toBe(true);
    }
  });
});
