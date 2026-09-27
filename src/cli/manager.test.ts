import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runManagerCli } from "./manager";

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function paths() {
  const root = mkdtempSync(join(tmpdir(), "overload-manager-cli-")); roots.push(root);
  const configPath = join(root, "config.json"); writeFileSync(configPath, JSON.stringify({ manager: { model: "fake/m" } }));
  return { controlPath: join(root, "control.db"), ledgerPath: join(root, "missing-ledger.db"), configPath };
}

describe("overload manager CLI", () => {
  test("ask stores a turn that turns/read/context can read back", async () => {
    const p = paths(); const lines: string[] = [];
    const text = "无待办\n```json\n" + JSON.stringify({ message: "无", triage: [], handoffs: [], protected_action: null, gaps: ["ledger unavailable"] }) + "\n```";
    expect(await runManagerCli(["ask", "现在先做什么"], { ...p, runModel: async () => ({ ok: true, text }), out: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "answered" });
    lines.length = 0;
    expect(await runManagerCli(["turns"], { ...p, out: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ source: "cli", question: "现在先做什么", status: "answered" });
    lines.length = 0;
    expect(await runManagerCli(["read", "works"], { ...p, out: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({ view: "works", total: 0 });
    lines.length = 0;
    expect(await runManagerCli(["context"], { ...p, out: (l) => lines.push(l) })).toBe(0);
    expect(JSON.parse(lines[0]!).coverage.sources.find((s: { kind: string }) => s.kind === "ledger").freshness).toBe("unavailable");
    expect(await runManagerCli(["bogus"], p)).toBe(2);
  });
});
