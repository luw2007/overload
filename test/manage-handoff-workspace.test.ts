import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { prepareHandoffWorkspace } from "../src/manage/launch";
import { localSourceFs, type SourceFs } from "../src/manage/source";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

function newDb(): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE mgmt_handoffs(
    handoff_id TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    packet TEXT NOT NULL,
    packet_sha256 TEXT NOT NULL,
    workspace_fp TEXT NOT NULL
  )`);
  return db;
}

function insertHandoff(db: Database, id: string, cwd: string): void {
  const packet = JSON.stringify({ workspace: { cwd }, target_host: "local" });
  db.query("INSERT INTO mgmt_handoffs(handoff_id,state,packet,packet_sha256,workspace_fp) VALUES (?,?,?,?,?)")
    .run(id, "ready_to_launch", packet, "x", "x");
}

test("MAN-28: prepareHandoffWorkspace captures root/head/status/patch and writes patch to git-dir", async () => {
  const repo = await mkdtemp(resolve(tmpdir(), "overload-man28-repo-"));
  dirs.push(repo);

  git(repo, ["init", "-q"]);
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "add", "a.txt"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init"]);
  const head = git(repo, ["rev-parse", "HEAD"]);

  // Tracked, unstaged modification -> non-empty working-tree diff vs HEAD.
  await writeFile(join(repo, "a.txt"), "one\ntwo\n");

  const db = newDb();
  insertHandoff(db, "h1", repo);
  const source: SourceFs = localSourceFs("local");

  const workspace = await prepareHandoffWorkspace(db, "h1", source);
  const root = realpathSync(repo);

  expect(workspace.root).toBe(root);
  expect(workspace.head).toBe(head);
  expect(typeof workspace.status_sha256).toBe("string");
  expect(workspace.status_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(typeof workspace.patch_sha256).toBe("string");
  expect(workspace.patch_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(workspace.patch_sha256).not.toBe(Bun.SHA256.hash("", "hex")); // diff is non-empty
  expect(typeof workspace.patch_path).toBe("string");
  expect(existsSync(workspace.patch_path as string)).toBe(true);

  // DB packet must be round-tripped with the same workspace fields.
  const row = db.query("SELECT packet FROM mgmt_handoffs WHERE handoff_id='h1'").get() as { packet: string };
  const stored = JSON.parse(row.packet).workspace;
  expect(stored.root).toBe(root);
  expect(stored.head).toBe(head);
  expect(stored.status_sha256).toBe(workspace.status_sha256);
  expect(stored.patch_sha256).toBe(workspace.patch_sha256);
  expect(stored.patch_path).toBe(workspace.patch_path);

  db.close();
});

test("MAN-28: prepareHandoffWorkspace rejects a dirty tree with untracked files", async () => {
  const repo = await mkdtemp(resolve(tmpdir(), "overload-man28-untracked-"));
  dirs.push(repo);

  git(repo, ["init", "-q"]);
  await writeFile(join(repo, "a.txt"), "one\n");
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "add", "a.txt"]);
  git(repo, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "init"]);

  // Untracked file that is never added.
  await writeFile(join(repo, "untracked.txt"), "nope\n");

  const db = newDb();
  insertHandoff(db, "h2", repo);
  const source: SourceFs = localSourceFs("local");

  let caught: any = null;
  try {
    await prepareHandoffWorkspace(db, "h2", source);
  } catch (error) {
    caught = error;
  }
  expect(caught).not.toBeNull();
  expect(String(caught?.message ?? caught)).toContain("untracked");
  expect(caught?.no_effect).toBe(true);

  db.close();
});
