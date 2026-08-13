/**
 * test/envelope.test.ts — envelope validation against the FROZEN contract
 * (src/shared/types.ts). P1 acceptance: field names/types exactly; seq
 * monotonicity; counters present on EVERY event; UTF-8-safe truncation boundary.
 *
 * These tests assert the CONTRACT, independent of any emitter implementation.
 */
import { test, expect, describe } from "bun:test";
import {
  ENVELOPE_VERSION,
  type EventEnvelope,
} from "../src/shared/types";
import {
  buildEnvelope,
  serializeEnvelope,
  validateEnvelope,
  parseEnvelopeLine,
  ENVELOPE_REQUIRED_FIELDS,
  ALL_ENVELOPE_TOP_LEVEL_FIELDS,
} from "./lib/envelope";
import { truncateUtf8Safe, truncateStringLeaves } from "./lib/utf8";

describe("envelope: frozen field names/types (types.ts exact match)", () => {
  test("a well-formed envelope validates with zero errors", () => {
    const e = buildEnvelope({ emitter_id: "pi-100-deadbeef", seq: 1 });
    expect(validateEnvelope(e)).toEqual([]);
  });

  test("every required field from types.ts is checked for presence", () => {
    const e = buildEnvelope({ emitter_id: "pi-1-ab", seq: 1 });
    for (const field of ENVELOPE_REQUIRED_FIELDS) {
      const copy: any = { ...e };
      delete copy[field];
      const errs = validateEnvelope(copy).map((x) => x.field);
      expect(errs).toContain(field);
    }
  });

  test("unknown top-level field is rejected (contract is narrow)", () => {
    const e: any = { ...buildEnvelope({ emitter_id: "pi-2-cd", seq: 1 }), surprise: 1 };
    const errs = validateEnvelope(e).map((x) => x.reason);
    expect(errs).toContain("unknown top-level field");
  });

  test("the ONLY optional field is `detail`; it is an object when present", () => {
    const allowed = new Set(ALL_ENVELOPE_TOP_LEVEL_FIELDS);
    expect(allowed.has("detail")).toBe(true);
    // detail missing is fine
    const e = buildEnvelope({ emitter_id: "pi-3-ef", seq: 1 });
    expect(validateEnvelope(e)).toEqual([]);
    // detail present + object is fine
    expect(validateEnvelope({ ...e, detail: { a: 1 } })).toEqual([]);
    // detail present but NOT object is rejected
    const bad: any = { ...e, detail: "string-not-object" };
    const errs = validateEnvelope(bad).map((x) => x.reason);
    expect(errs.some((r) => r.includes("JSON object"))).toBe(true);
  });

  test("field types match types.ts exactly", () => {
    const cases: Array<[string, any, string]> = [
      ["v", 2, "ENVELOPE_VERSION"],
      ["v", "1", "ENVELOPE_VERSION"],
      ["at", "notnum", "number"],
      ["seq", 1.5, "number"],
      ["session", "", "string"],
      ["emitter_id", 5, "string"],
      ["dropped_total", "0", "number"],
      ["write_error_total", true, "number"],
    ];
    for (const [field, badVal, _hint] of cases) {
      const e: any = { ...buildEnvelope({ emitter_id: "pi-t-" + field, seq: 1 }) };
      e[field] = badVal;
      const errs = validateEnvelope(e);
      expect(errs.some((x) => x.field === field), `field ${field}=${badVal} should fail`).toBe(true);
    }
  });

  test("host ∈ {local, devbox} exactly; runtime/kind in frozen unions", () => {
    const e = buildEnvelope({ emitter_id: "pi-4-00", seq: 1 });
    expect(validateEnvelope({ ...e, host: "laptop" })).not.toEqual([]);
    expect(validateEnvelope({ ...e, runtime: "zed" })).not.toEqual([]);
    expect(validateEnvelope({ ...e, kind: "working_harder" })).not.toEqual([]);
    // valid unions pass
    expect(validateEnvelope({ ...e, host: "local", runtime: "pi", kind: "settled" })).toEqual([]);
    expect(validateEnvelope({ ...e, host: "devbox", runtime: "claude", kind: "decision_requested" })).toEqual([]);
  });

  test("v === ENVELOPE_VERSION (currently 1) — the version gate", () => {
    expect(ENVELOPE_VERSION).toBe(1);
    const e = buildEnvelope({ emitter_id: "pi-5-11", seq: 1 });
    expect((e as EventEnvelope).v).toBe(1);
  });
});

describe("envelope: seq monotonicity (per-emitter, starts at 1)", () => {
  test("a stream of envelopes has strictly increasing integer seq from 1", () => {
    const emitter = "pi-100-aaaaaaaa";
    const seqs = [1, 2, 3, 4, 5].map((seq) => buildEnvelope({ emitter_id: emitter, seq }).seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5]);
  });

  test("validation rejects non-integer and negative seq", () => {
    for (const bad of [0, -1, 1.2, NaN]) {
      const e: any = { ...buildEnvelope({ emitter_id: "pi-6-22", seq: 1 }) };
      e.seq = bad;
      expect(validateEnvelope(e).some((x) => x.field === "seq")).toBe(true);
    }
  });
});

describe("envelope: monotonic counters present on EVERY event (R5-B2)", () => {
  test("dropped_total and write_error_total are required on every envelope", () => {
    const required = ENVELOPE_REQUIRED_FIELDS as readonly string[];
    expect(required).toContain("dropped_total");
    expect(required).toContain("write_error_total");
  });

  test("a gap in dropped_total is detectable across consecutive events", () => {
    // §2.3/R5-B2: any loss is exposed by the first successful event after it.
    // Concretely: counters are monotonic non-decreasing per emitter.
    const emitter = "pi-7-33";
    const events = [
      buildEnvelope({ emitter_id: emitter, seq: 1, dropped_total: 0, write_error_total: 0 }),
      buildEnvelope({ emitter_id: emitter, seq: 2, dropped_total: 3, write_error_total: 0 }),
      buildEnvelope({ emitter_id: emitter, seq: 3, dropped_total: 3, write_error_total: 1 }),
    ];
    for (const ev of events) expect(validateEnvelope(ev)).toEqual([]);
    expect(events.map((e) => e.dropped_total)).toEqual([0, 3, 3]);
    // monotonic
    const d = events.map((e) => e.dropped_total);
    expect(d).toEqual([...d].sort((a, b) => a - b));
  });
});

describe("envelope: UTF-8-safe truncation boundary (§2.7)", () => {
  test("ASCII string truncates to exact byte budget", () => {
    expect(truncateUtf8Safe("abcdefghij", 4)).toBe("abcd");
    expect(Buffer.byteLength(truncateUtf8Safe("hello world", 5), "utf8")).toBe(5);
  });

  test("multi-byte codepoints are NEVER split (2-byte, 3-byte, 4-byte)", () => {
    // "é" = 2 bytes (U+00E9)
    expect(truncateUtf8Safe("éééé", 3)).toBe("é"); // 3 bytes can only hold 1 "é" (2 bytes), not half
    expect(Buffer.byteLength(truncateUtf8Safe("éééé", 3), "utf8")).toBe(2);

    // "€" = 3 bytes (U+20AC)
    expect(truncateUtf8Safe("€€€", 4)).toBe("€");
    expect(Buffer.byteLength(truncateUtf8Safe("€€€", 4), "utf8")).toBe(3);

    // "😀" = 4 bytes (U+1F600) — a surrogate pair
    expect(truncateUtf8Safe("😀😀", 5)).toBe("😀");
    expect(Buffer.byteLength(truncateUtf8Safe("😀😀", 5), "utf8")).toBe(4);
    // Must NOT produce a lone surrogate / replacement char
    const truncated = truncateUtf8Safe("😀😀", 2);
    expect(Buffer.byteLength(truncated, "utf8")).toBe(0);
    expect(truncated).toBe("");
  });

  test("resulting bytes never exceed the budget", () => {
    const samples = ["", "a", "ab", "αβγδε", "日本語テスト", "🚀🛰️🛸"];
    for (const s of samples) {
      for (const budget of [0, 1, 2, 3, 4, 5, 7, 8, 12, 100]) {
        const out = truncateUtf8Safe(s, budget);
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(budget);
      }
    }
  });

  test("detail string leaves truncated before serialization (≤500B rule)", () => {
    // types.ts: settled carries "last assistant text ≤500B, UTF-8-safe
    // pre-serialization truncation". We model detail.text as the payload.
    const longText = "é".repeat(2000); // 4000 bytes
    const detail = { text: longText, nested: { text: "😀".repeat(400) } };
    const truncated = truncateStringLeaves(detail, 500) as any;
    expect(Buffer.byteLength(truncated.text, "utf8")).toBeLessThanOrEqual(500);
    expect(Buffer.byteLength(truncated.nested.text, "utf8")).toBeLessThanOrEqual(500);
    // and the envelope stays valid
    const e = buildEnvelope({
      emitter_id: "pi-8-44",
      seq: 1,
      kind: "settled",
      detail: truncated,
    });
    expect(validateEnvelope(e)).toEqual([]);
  });

  test("truncating a valid envelope's serialized form keeps it parseable", () => {
    const e = buildEnvelope({
      emitter_id: "pi-9-55",
      seq: 1,
      kind: "settled",
      detail: truncateStringLeaves({ text: "α".repeat(2000) }, 100),
    });
    const line = serializeEnvelope(e);
    const { obj, errors } = parseEnvelopeLine(line);
    expect(errors).toEqual([]);
    expect((obj as EventEnvelope).detail).toBeDefined();
  });
});
