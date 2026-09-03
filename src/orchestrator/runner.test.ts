import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, claim, getTask, openStore } from "./store";
import { bindRunnerSession, spawnRunner, taskOrigin, type RunnerExecutor } from "./runner";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function store() {
  const d = mkdtempSync(join(tmpdir(), "runner-store-"));
  dirs.push(d);
  return openStore(join(d, "db"));
}

describe("spawnRunner", () => {
  test("writes the prompt to an artifacts-dir file and invokes cmux with --focus false", async () => {
    const artifactsRoot = mkdtempSync(join(tmpdir(), "artifacts-"));
    dirs.push(artifactsRoot);
    const db = store();
    const task = addTask(db, "task-title", "/repo", "0000000000000000000000000000000000000000");
    claim(db, "o", 4);
    const bound = getTask(db, task.task_id)!;
    const calls: Array<{ command: string; args: string[] }> = [];
    const exec: RunnerExecutor = async (command, args) => { calls.push({ command, args }); return { ok: true }; };
    const result = await spawnRunner(bound, "/worktree/dir", bound.attempt_id!, "do the thing", exec, artifactsRoot);
    expect(result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("cmux");
    expect(calls[0]!.args.slice(0, 4)).toEqual(["new-workspace", "--cwd", "/worktree/dir", "--command"]);
    expect(calls[0]!.args.slice(5)).toEqual(["--focus", "false"]);
    const cmd = calls[0]!.args[4]!;
    expect(cmd).toContain(`OVERLOAD_PARENT='orch:task:${task.task_id}:${bound.attempt_id}'`);
    expect(cmd).toContain(`OVERLOAD_ORCH_TASK='${task.task_id}'`);
    expect(cmd).toMatch(/pi -p '@.*prompt-.*\.txt'/);
    const promptFile = join(artifactsRoot, task.task_id, `prompt-${bound.attempt_id}.txt`);
    expect(existsSync(promptFile)).toBeTrue();
    expect(readFileSync(promptFile, "utf8")).toBe("do the thing");
    db.close();
  });

  test("propagates a failed launch (mirrors resume.ts's error shape)", async () => {
    const artifactsRoot = mkdtempSync(join(tmpdir(), "artifacts2-"));
    dirs.push(artifactsRoot);
    const db = store();
    const task = addTask(db, "t", "/repo", "0000000000000000000000000000000000000000");
    claim(db, "o", 4);
    const bound = getTask(db, task.task_id)!;
    const exec: RunnerExecutor = async () => ({ ok: false, error: "cmux_unavailable" });
    const result = await spawnRunner(bound, "/wt", bound.attempt_id!, "prompt", exec, artifactsRoot);
    expect(result).toEqual({ ok: false, error: "cmux_unavailable" });
    db.close();
  });
});

function seedLedger(path: string, rows: { stable_id: string; origin: string; created_at: number; pid?: number; boot_id?: string }[]): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, origin TEXT, cwd TEXT, branch TEXT, created_at INTEGER, first_seen_at INTEGER);
    CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER);
  `);
  for (const row of rows) {
    db.run("INSERT INTO sessions VALUES (?, 'local', 'pi', 'sess', ?, '/wt', 'main', ?, ?)", [row.stable_id, row.origin, row.created_at, row.created_at]);
    if (row.pid != null) db.run("INSERT INTO session_incarnations VALUES (?, 'writer', 'process', ?, ?, ?, ?)", [row.stable_id, row.pid, row.boot_id ?? "boot", row.created_at, row.created_at]);
  }
  db.close();
}

describe("bindRunnerSession", () => {
  test("finds the newest session matching origin and joins session_incarnations for pid/boot_id", () => {
    const root = mkdtempSync(join(tmpdir(), "ledger-"));
    dirs.push(root);
    const ledgerPath = join(root, "ledger.db");
    const origin = taskOrigin("task-1", "attempt-1");
    seedLedger(ledgerPath, [
      { stable_id: "local:pi:old", origin, created_at: 1 },
      { stable_id: "local:pi:new", origin, created_at: 2, pid: 4242, boot_id: "boot-xyz" },
    ]);
    const db = store();
    const task = addTask(db, "t", "/repo", "0000000000000000000000000000000000000000");
    db.close();
    const bound = bindRunnerSession(ledgerPath, { ...({} as never), task_id: "task-1" } as never, "attempt-1");
    expect(bound).toEqual({ stable_id: "local:pi:new", pid: 4242, boot_id: "boot-xyz" });
  });

  test("returns null when no session matches the origin key", () => {
    const root = mkdtempSync(join(tmpdir(), "ledger2-"));
    dirs.push(root);
    const ledgerPath = join(root, "ledger.db");
    seedLedger(ledgerPath, [{ stable_id: "local:pi:other", origin: "orch:task:other:x", created_at: 1 }]);
    const bound = bindRunnerSession(ledgerPath, { task_id: "task-1" } as never, "attempt-1");
    expect(bound).toBeNull();
  });

  test("returns null gracefully when ledger.db doesn't exist yet (never throws)", () => {
    const bound = bindRunnerSession(join(tmpdir(), "definitely-missing-ledger.db"), { task_id: "task-1" } as never, "attempt-1");
    expect(bound).toBeNull();
  });
});
