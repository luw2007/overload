/**
 * test/audit-pipeline-recon.test.ts — audit backfill for recon stories whose
 * r2 evidence cited reference/outage tests but shipped no assertion on the key
 * behavior. Isolated tmp ledger + fake snapshot scripts.
 *
 * Covers: REC-14 snapshot command timeout → outage; REC-13 bad host id exit 2.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReconDaemon, type ReconConfig } from "../src/recon/recon";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true }))); });

async function reconFixture(herdrBody: string, commandTimeoutMs: number) {
  const root = await mkdtemp(join(tmpdir(), "ov-rcnaudit-"));
  roots.push(root);
  const spool = join(root, "spool");
  await mkdir(spool, { recursive: true });
  const ledger = join(root, "ledger.db");
  const db = new Database(ledger);
  db.exec(`
    CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, host TEXT, emitter_id TEXT, seq INTEGER, at INTEGER, stable_id TEXT, writer_id TEXT, kind TEXT, detail TEXT);
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, cwd TEXT);
    CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE cursors(file_name TEXT PRIMARY KEY, bytes INTEGER);
    CREATE TABLE attachments(stable_id TEXT, platform TEXT, binding TEXT, observed_at INTEGER, valid INTEGER);
    CREATE TABLE current(stable_id TEXT PRIMARY KEY, state TEXT, last_progress_at INTEGER, last_event_at INTEGER);
  `);
  db.close();
  const herdr = join(root, "herdr.sh");
  await writeFile(herdr, herdrBody, { mode: 0o700 });
  const orca = join(root, "orca.sh");
  await writeFile(orca, "#!/bin/sh\nprintf '%s\\n' '[]'\n", { mode: 0o700 });
  const cmux = join(root, "cmux.json");
  await writeFile(cmux, "{}\n");
  const config: ReconConfig = {
    recon_interval_ms: 60_000, drain_grace_ms: 0, stall_profile_ms: 1_000, turn_hang_ms: 1_000,
    command_timeout_ms: commandTimeoutMs, host: "local", ledger, spool,
    herdr_cmd: herdr, orca_cmd: orca, remote_probe_cmd: "unused {host} {pid}", cmux_sessions_file: cmux,
  };
  return { root, config };
}

describe("REC-14 a hung snapshot command is treated as an outage", () => {
  test("herdr snapshot killed at command_timeout_ms emits source_outage", async () => {
    const f = await reconFixture("#!/bin/sh\nsleep 60\n", 300);
    const started = Date.now();
    const summary = await new ReconDaemon(f.config).runOnce();
    const elapsed = Date.now() - started;
    expect(summary.byKind.source_outage ?? 0).toBe(1);
    expect(elapsed).toBeLessThan(8_000); // not the natural 60s lifetime
  }, 15_000);
});

describe("REC-13 invalid host id exits 2", () => {
  test("recon --once refuses a non-local/devbox host file", async () => {
    const home = await mkdtemp(join(tmpdir(), "ov-rcnhost-"));
    roots.push(home);
    await mkdir(join(home, ".overload"), { recursive: true });
    await writeFile(join(home, ".overload", "host"), "bogus-host\n");
    const env = { ...process.env, HOME: home };
    const proc = Bun.spawn(["bun", "src/recon/recon.ts", "--once"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
  });
});
