import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateAttribReport } from "./report";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function command(argv: string[], cwd?: string, env?: Record<string, string>): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function repo(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `overload-attrib-${name}-`));
  roots.push(root);
  await command(["git", "init", "-q", root]);
  await command(["git", "config", "user.email", "attrib@example.test"], root);
  await command(["git", "config", "user.name", "Attrib Test"], root);
  return root;
}

async function commit(root: string, message: string, at: number): Promise<string> {
  const file = join(root, `${at}-${Math.random()}.txt`);
  await Bun.write(file, message);
  await command(["git", "add", "--", file], root);
  const date = new Date(at).toISOString();
  await command(["git", "commit", "-q", "-m", message], root, {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  return command(["git", "rev-parse", "HEAD"], root);
}

function ledger(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, cwd TEXT);
    CREATE TABLE journal(
      ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      stable_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      detail TEXT
    );
  `);
  return db;
}

function session(db: Database, stableId: string, cwd: string, events: Array<{ at: number; kind?: string; detail?: unknown }>): void {
  db.query("INSERT INTO sessions(stable_id, cwd) VALUES (?, ?)").run(stableId, cwd);
  for (const event of events) {
    db.query("INSERT INTO journal(at, stable_id, kind, detail) VALUES (?, ?, ?, ?)").run(
      event.at,
      stableId,
      event.kind ?? "heartbeat",
      JSON.stringify(event.detail ?? {}),
    );
  }
}

describe("generateAttribReport", () => {
  test("discovers repositories and grades trailer, observed head, window correlation, and unattributed commits", async () => {
    const now = Date.now();
    const trailerRepo = await repo("trailer");
    const observedRepo = await repo("observed");
    const windowRepo = await repo("window");
    const unknownRepo = await repo("unknown");

    const trailerSha = await commit(trailerRepo, "trailer commit\n\nOverload-Session: local:pi:trailer#writer-1", now - 4_000);
    const observedSha = await commit(observedRepo, "observed commit", now - 3_000);
    const windowSha = await commit(windowRepo, "window commit", now - 2_000);
    const unknownSha = await commit(unknownRepo, "unknown commit", now - 1_000);

    const db = ledger();
    session(db, "local:pi:trailer", trailerRepo, [
      { at: now - 5_000 },
      { at: now - 3_500, kind: "commit_observed", detail: { sha: trailerSha, repo: trailerRepo } },
    ]);
    session(db, "local:pi:observed", join(observedRepo, "nested"), [
      { at: now - 3_500, kind: "commit_observed", detail: { sha: observedSha, repo: observedRepo } },
    ]);
    await mkdir(join(observedRepo, "nested"));
    session(db, "local:pi:window", windowRepo, [
      { at: now - 2_500 },
      { at: now - 1_500 },
    ]);
    session(db, "local:pi:not-a-repo", join(trailerRepo, "missing"), [{ at: now }]);

    const report = await generateAttribReport(db, { sinceMs: 60_000, repos: [unknownRepo] });
    const bySha = new Map(report.rows.map((row) => [row.sha, row]));

    expect(bySha.get(trailerSha)).toMatchObject({ grade: "trailer", stable_id: "local:pi:trailer" });
    expect(bySha.get(observedSha)).toMatchObject({ grade: "head_observed", stable_id: "local:pi:observed" });
    expect(bySha.get(windowSha)).toMatchObject({ grade: "window_correlated", stable_id: "local:pi:window" });
    expect(bySha.get(unknownSha)).toMatchObject({ grade: "unattributed" });
    expect(bySha.get(unknownSha)).not.toHaveProperty("stable_id");
    expect(report.universe).toEqual([observedRepo, trailerRepo, unknownRepo, windowRepo].sort());
    db.close();
  });

  test("tolerates a non-repository cwd and ignores commits older than the requested window", async () => {
    const root = await mkdtemp(join(tmpdir(), "overload-attrib-nonrepo-"));
    roots.push(root);
    const validRepo = await repo("since");
    await commit(validRepo, "old commit", Date.now() - 120_000);
    const db = ledger();
    session(db, "local:pi:invalid", root, [{ at: Date.now() }]);

    const report = await generateAttribReport(db, { sinceMs: 1_000, repos: [validRepo, join(root, "absent")] });

    expect(report.universe).toEqual([validRepo]);
    expect(report.rows).toEqual([]);
    db.close();
  });
});
