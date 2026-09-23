/**
 * test/cli-output.test.ts — end-to-end presentation contract for the read-only
 * Overload CLI (src/cli/overload.ts). Spawns the real entrypoint with an
 * OVERLOAD_LEDGER_PATH pointed at a tmp ledger so the actual stdout/stderr and
 * exit codes that `overload sessions|show|q1|health|zombie` produce are asserted.
 * No real ~/.overload is touched.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const SCHEMA_SQL = readFileSync(join(import.meta.dir, "../src/ingest/schema.sql"), "utf8");
const CLI = join(import.meta.dir, "../src/cli/overload.ts");
const NOW = 1_800_000_000_000;

function ledger(seed?: (db: Database) => void): string {
  const root = mkdtempSync(join(tmpdir(), "overload-cli-out-")); roots.push(root);
  const path = join(root, "ledger.db");
  const db = new Database(path);
  db.exec(SCHEMA_SQL);
  seed?.(db);
  db.close();
  return path;
}

function seedSessions(db: Database): void {
  for (const [stableId, host, runtime, origin, t] of [
    ["local:pi:two", "local", "pi", "agent", NOW - 2_000],
    ["devbox:omp:one", "devbox", "omp", "agent", NOW - 1_000],
  ] as const) {
    db.run("INSERT INTO sessions(stable_id, host, runtime, session, origin, created_at, first_seen_at) VALUES (?,?,?,?,?,?,?)",
      stableId, host, runtime, stableId, origin, t, t);
    db.run("INSERT INTO current(stable_id, state, queue, q5_reason, origin, last_event_at) VALUES (?,?,?,?,?,?)",
      stableId, "idle", "q3", null, origin, t);
  }
}

function seedPending(db: Database): void {
  // Remote-host pending request -> jump=ssh <host>
  db.run("INSERT INTO sessions(stable_id, host, runtime, session, origin, created_at, first_seen_at) VALUES (?,?,?,?,?,?,?)",
    "devbox:omp:ask", "devbox", "omp", "ask", "agent", NOW, NOW);
  db.run("INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, detail) VALUES (?,?,?,?,?,?,?,?,?)",
    "devbox:omp:ask#e#r1", "devbox:omp:ask", "w1", "e1", "r1", "ask", "pending", NOW, null);
  // Local pending request with a recorded cmux binding -> jump=<binding>
  db.run("INSERT INTO sessions(stable_id, host, runtime, session, origin, created_at, first_seen_at) VALUES (?,?,?,?,?,?,?)",
    "local:pi:ask", "local", "pi", "ask", "agent", NOW, NOW);
  db.run("INSERT INTO session_hosts(stable_id, app, session_id, tty, observed_at) VALUES (?,?,?,?,?)",
    "local:pi:ask", "cmux", "cmux-surface-9", null, NOW);
  db.run("INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, detail) VALUES (?,?,?,?,?,?,?,?,?)",
    "local:pi:ask#e#r2", "local:pi:ask", "w1", "e1", "r2", "approval_gate", "pending", NOW, null);
}

function seedIncident(db: Database): void {
  db.run("INSERT INTO incidents(source, opened_at, closed_at, detail) VALUES (?,?,?,?)", "recon", NOW - 60_000, null, "{}");
}

async function runCli(args: string[], ledgerPath: string) {
  const home = join(ledgerPath.replace(/\/ledger\.db$/, ""), "home");
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, OVERLOAD_LEDGER_PATH: ledgerPath, HOME: home },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("overload sessions (CLI-01)", () => {
  test("prints stable_id/runtime/origin/state/queue/last_event and empty-state note", async () => {
    const path = ledger(seedSessions);
    const out = await runCli(["sessions"], path);
    expect(out.exitCode).toBe(0);
    // newest last_event first: devbox:omp:one (NOW-1000) ahead of local:pi:two (NOW-2000)
    expect(out.stdout.split("\n")[0]).toContain("devbox:omp:one");
    expect(out.stdout).toContain("local:pi:two\tpi");
    expect(out.stdout).toContain("omp\tagent");
    expect(out.stderr).not.toContain("No known sessions.");
  });
  test("empty ledger notes 'No known sessions.' on stderr and exits 0", async () => {
    const path = ledger();
    const out = await runCli(["sessions"], path);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("No known sessions.");
    expect(out.stdout.trim()).toBe("");
  });
});

describe("overload show (CLI-02)", () => {
  test("prints the session header for a known id", async () => {
    const path = ledger(seedSessions);
    const out = await runCli(["show", "devbox:omp:one"], path);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Session: devbox:omp:one");
    expect(out.stdout).toContain("Runtime: omp");
    expect(out.stdout).toContain("Incarnations:");
    expect(out.stdout).toContain("Pending requests:");
    expect(out.stdout).toContain("Recent events");
  });
  test("unknown id prints 'Session not found' on stderr and exits 1", async () => {
    const path = ledger(seedSessions);
    const out = await runCli(["show", "local:pi:nope"], path);
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Session not found: local:pi:nope");
    expect(out.stdout.trim()).toBe("");
  });
});

describe("overload q1 (CLI-03)", () => {
  test("lists pending requests with jump= binding (ssh remote, local binding)", async () => {
    const path = ledger(seedPending);
    const out = await runCli(["q1"], path);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("Q1 pending requests:");
    // remote host -> ssh binding
    expect(out.stdout).toContain("devbox:omp:ask#e#r1");
    expect(out.stdout).toContain("jump=ssh devbox");
    // local -> recorded cmux binding
    expect(out.stdout).toContain("local:pi:ask#e#r2");
    expect(out.stdout).toContain("jump=cmux-surface-9");
  });
  test("empty q1 notes no pending requests", async () => {
    const path = ledger();
    const out = await runCli(["q1"], path);
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("Q1: no pending requests.");
    expect(out.stdout.trim()).toBe("");
  });
});

describe("overload health (CLI-06)", () => {
  test("prints the counts line and one line per open incident", async () => {
    const path = ledger(seedIncident);
    const out = await runCli(["health"], path);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("Health: open_incidents=1 coverage_gaps=0 telemetry_gaps=0");
    expect(out.stdout).toContain("  incident recon since");
  });
});

describe("CLI contract (CLI-07)", () => {
  test("unknown command prints usage to stderr and exits 2", async () => {
    const path = ledger();
    const out = await runCli(["frobnicate"], path);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("usage: overload");
  });
  test("extra args on a no-arg command print usage and exit 2", async () => {
    const path = ledger();
    const out = await runCli(["sessions", "extra"], path);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain("usage: overload");
  });
  test("unopenable ledger prints an error and exits 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "overload-cli-bad-")); roots.push(root);
    const out = await runCli(["sessions"], join(root, "does-not-exist.db"));
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("Unable to open ledger");
  });
  test("OVERLOAD_LEDGER_PATH selects the isolated ledger (override)", async () => {
    const path = ledger(seedSessions);
    const out = await runCli(["sessions"], path);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("devbox:omp:one");
  });
});
