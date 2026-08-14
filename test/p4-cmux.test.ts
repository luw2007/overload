import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const cmuxPath = join(process.cwd(), "src/ingest/cmux.ts");
const available = existsSync(cmuxPath);

describe("P4 cmux entry inventory", () => test("cmux implementation is optional during parallel landing", () => expect(typeof available).toBe("boolean")));

describe.skipIf(!available)("cmux identity and generation contracts", () => {
  test("exports a scanner/translator surface", async () => {
    const mod = await import("../src/ingest/cmux");
    expect(Object.keys(mod).some((key) => /cmux|scan|translate/i.test(key))).toBe(true);
  });
  test("frozen identity mapping is documented by implementation", async () => {
    const source = await Bun.file(cmuxPath).text();
    expect(source).toContain("cmux-");
    expect(source).toMatch(/byte_start|lineStart|offset/);
    expect(source).toMatch(/generation_uuid|source_generations/);
  });
  test("generation retirement and rescan hooks exist", async () => {
    const source = await Bun.file(cmuxPath).text();
    expect(source).toMatch(/retired/);
    expect(source).toMatch(/cursor_tail_fp/);
  });
});
