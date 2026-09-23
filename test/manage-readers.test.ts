import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { detectRuntimeFromPath, parseClaudeSession, parseOmpSession, parsePiSession, sessionDirs } from "../src/manage/readers/types";

const fixtures = resolve(import.meta.dir, "fixtures/mgmt");
async function lines(name: string) { return (await readFile(resolve(fixtures, name), "utf8")).trimEnd().split("\n"); }
describe("session readers", () => {
  for (const [name, parse, expected] of [
    ["pi.jsonl", parsePiSession, ["modified", "/tmp/project/src/a.ts"]],
    ["omp.jsonl", parseOmpSession, ["created", "/tmp/omp/new.ts"]],
    ["claude.jsonl", parseClaudeSession, ["modified", "/tmp/claude/lib/a.ts"]],
  ] as const) test(name, async () => {
    const record = parse(await lines(name))!;
    expect(record.userMessages).toHaveLength(1);
    expect(record.toolEvents).toHaveLength(2);
    expect(record.toolEvents[0]).toMatchObject({ relation: expected[0], path: expected[1] });
    expect(record.toolEvents[1]).toMatchObject({ relation: "read" });
    expect(record.parseErrors).toHaveLength(1);
    expect(record.endedAt).toBeNull();
  });
  test("empty and paths", () => {
    expect(parsePiSession([])).toBeNull(); expect(parseOmpSession([])).toBeNull(); expect(parseClaudeSession([])).toBeNull();
    expect(detectRuntimeFromPath("/home/me/.claude/projects/x/a.jsonl")).toBe("claude");
    expect(sessionDirs("pi", "/home/me")).toEqual(["/home/me/.pi/agent/sessions"]);
  });
});
