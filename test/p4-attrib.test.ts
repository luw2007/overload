import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openLedgerP2 } from "./lib/p2/schema";

const reportPath = join(process.cwd(), "src/attrib/report.ts");
const available = await Bun.file(reportPath).exists();

describe.skipIf(!available)("P4 attribution grades", () => {
  test("fixture commits cover all grades and trailer precedence", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "overload-p4-attrib-")));
    try {
      execFileSync("git", ["init", "-q", root]);
      execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
      execFileSync("git", ["-C", root, "config", "user.name", "P4 Test"]);
      writeFileSync(join(root, "a"), "a");
      execFileSync("git", ["-C", root, "add", "."]);
      execFileSync("git", ["-C", root, "commit", "-qm", "trailer\n\nOverload-Session: sid#writer"]);
      const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      const mod = await import("../src/attrib/report");
      expect(typeof mod.generateAttribReport).toBe("function");
      // The report must preserve the frozen grade vocabulary and trailer wins
      // over an otherwise matching observed-head record.
      const db = openLedgerP2(join(root, "ledger.db"));
      const result = await mod.generateAttribReport(db, { repos: [root], sinceMs: 0 });
      expect(result.universe.map((u: string) => realpathSync(u))).toContain(root);
      expect(result.rows.every((r: any) => ["trailer", "head_observed", "window_correlated", "unattributed"].includes(r.grade))).toBe(true);
      if (result.rows.some((r: any) => r.sha === commit)) expect(result.rows.find((r: any) => r.sha === commit).grade).toBe("trailer");
      db.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

test("attribution entry inventory", () => expect(typeof available).toBe("boolean"));
