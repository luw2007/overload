/**
 * test/ext-commit-observed.test.ts — EXT-12 commit_observed.
 *
 * A real git repo under tmp. session_start seeds the HEAD probe (observeChange
 * = false). After the repo HEAD advances (a new commit), a subsequent bash
 * tool_result drives probeHead(observeChange = true), which compares the seeded
 * previous HEAD against the new one and emits commit_observed{sha, repo}.
 *
 * Real git via node:child_process (not mocked). tmp HOME isolation via node:os.
 */
import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir as realHomedir, tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "overload-ext-commit-observed-"));
const realSpool = join(realHomedir(), ".overload", "spool", "local");
const repo = join(home, "repo");
const SESSION = "9f1e7a30-0000-4000-8000-000000000004";

mock.module("node:os", () => ({ homedir: () => home, tmpdir }));

type Handler = (event: unknown, ctx: unknown) => unknown;
const handlers = new Map<string, Handler[]>();
function dispatch(name: string, event: unknown, ctx: unknown = {}): unknown[] {
  return (handlers.get(name) ?? []).map((handler) => handler(event, ctx));
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo }).toString().trim();
}
function head(): string {
  return git(["rev-parse", "HEAD"]);
}

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "v1\n");
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "c1"]);

  const { default: overload } = await import("../src/extension/overload");
  overload({
    on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
  } as never);
  // session_start probes HEAD with observeChange=false, seeding headByCwd[repo].
  await Promise.all(dispatch("session_start", { reason: "startup" }, {
    cwd: repo,
    sessionManager: { getSessionId: () => SESSION },
  }));
  await Bun.sleep(300); // let the seed probe resolve
});

afterAll(() => {
  if (existsSync(realSpool)) {
    expect(readdirSync(realSpool).filter((name) => name.includes(`-${process.pid}-`))).toEqual([]);
  }
  rmSync(home, { recursive: true, force: true });
});

test("EXT-12: a new HEAD after a bash tool_result emits commit_observed{sha, repo}", async () => {
  const before = head();

  // Advance HEAD with a real commit.
  writeFileSync(join(repo, "f.txt"), "v2\n");
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."]);
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "c2"]);
  const after = head();
  expect(after).not.toBe(before);

  // A bash tool_result triggers probeHead(observeChange=true) against the repo.
  dispatch("tool_result", { toolName: "bash", toolCallId: "c1", isError: false }, { cwd: repo });
  await Bun.sleep(500); // let the async git probe resolve

  const base = join(home, ".overload", "spool");
  const events: Array<{ kind: string; detail?: { sha?: string; repo?: string } }> = [];
  for (const hostDir of readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const emDir of readdirSync(join(base, hostDir.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const emPath = join(base, hostDir.name, emDir.name);
      for (const file of readdirSync(emPath)) {
        for (const line of readFileSync(join(emPath, file), "utf8").split("\n")) {
          if (line.trim()) events.push(JSON.parse(line));
        }
      }
    }
  }

  const observed = events.filter((e) => e.kind === "commit_observed");
  expect(observed.length).toBe(1);
  expect(observed[0]!.detail?.sha).toBe(after);
  // git reports the canonical toplevel (realpath); compare against it directly.
  expect(observed[0]!.detail?.repo).toBe(git(["rev-parse", "--show-toplevel"]));
});
