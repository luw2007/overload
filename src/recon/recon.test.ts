import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReconDaemon, type ReconConfig } from "./recon";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "overload-recon-"));
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
  `);
  db.close();
  const herdr = join(root, "herdr.sh");
  const orca = join(root, "orca.sh");
  const cmux = join(root, "cmux-hook-sessions.json");
  await writeFile(herdr, "#!/bin/sh\nprintf '%s\\n' '{\"result\":{\"agents\":[]}}'\n", { mode: 0o700 });
  await writeFile(orca, "#!/bin/sh\nprintf '%s\\n' '[]'\n", { mode: 0o700 });
  await writeFile(cmux, "{}\n");
  const config: ReconConfig = {
    recon_interval_ms: 60_000,
    drain_grace_ms: 0,
    stall_profile_ms: 1_000,
    command_timeout_ms: 10_000,
    host: "local",
    ledger,
    spool,
    herdr_cmd: herdr,
    orca_cmd: orca,
    cmux_sessions_file: cmux,
  };
  return { root, spool, ledger, herdr, orca, cmux, config };
}

async function events(spool: string) {
  const host = join(spool, "local");
  const emitters = await Array.fromAsync(new Bun.Glob("*/active-*.ndjson").scan({ cwd: host, absolute: true }));
  const lines = (await Promise.all(emitters.map((path) => readFile(path, "utf8"))))
    .flatMap((text) => text.trim().split("\n").filter((line) => line.startsWith("{")));
  return lines.map((line) => JSON.parse(line));
}

describe("ReconDaemon", () => {
  test("emits dead then drained only after every emitter spool cursor reaches EOF", async () => {
    const f = await fixture();
    const emitter = "pi-999999-deadbeef";
    const sourceDir = join(f.spool, "local", emitter);
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, `active-${emitter}-0.ndjson`);
    await writeFile(sourceFile, "source-event\n");
    const size = (await stat(sourceFile)).size;
    const db = new Database(f.ledger);
    db.query("INSERT INTO sessions VALUES (?, 'local', 'pi', 's1', '/repo')").run("local:pi:s1");
    db.query("INSERT INTO session_incarnations VALUES (?, ?, 'process', 999999, 'deadbeef00', 1, ?)").run("local:pi:s1", emitter, Date.now() - 5_000);
    db.query("INSERT INTO journal VALUES (1, 'local', ?, 1, ?, ?, ?, 'heartbeat', '{}')").run(emitter, Date.now() - 5_000, "local:pi:s1", emitter);
    db.query("INSERT INTO cursors VALUES (?, ?)").run(`local/${emitter}/active-${emitter}-0.ndjson`, size);
    db.close();

    const summary = await new ReconDaemon(f.config).runOnce();
    expect(summary.byKind.emitter_dead).toBe(1);
    expect(summary.byKind.emitter_drained).toBe(1);
    const output = await events(f.spool);
    expect(output.map((event) => event.kind)).toEqual(expect.arrayContaining(["emitter_dead", "emitter_drained"]));
    expect(output.every((event) => event.runtime === "overload" && event.dropped_total === 0 && event.write_error_total === 0)).toBe(true);
  });

  test("joins visible native sessions by cwd and includes stable_id in a rate-limited telemetry gap", async () => {
    const f = await fixture();
    await writeFile(f.herdr, "#!/bin/sh\nprintf '%s\\n' '{\"result\":{\"agents\":[{\"terminal_id\":\"term-1\",\"agent_status\":\"working\",\"cwd\":\"/repo\"},{\"terminal_id\":\"term-gap\",\"agent_status\":\"working\",\"cwd\":\"/missing\"}]}}'\n", { mode: 0o700 });
    const emitter = `pi-${process.pid}-feedface`;
    const sourceDir = join(f.spool, "local", emitter);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, `active-${emitter}-0.ndjson`), "\n");
    const db = new Database(f.ledger);
    db.query("INSERT INTO sessions VALUES (?, 'local', 'pi', 's1', '/repo')").run("local:pi:s1");
    db.query("INSERT INTO sessions VALUES (?, 'local', 'claude', 'gap', '/missing')").run("local:claude:gap");
    db.query("INSERT INTO session_incarnations VALUES (?, ?, 'process', ?, 'feedface00', 1, ?)").run("local:pi:s1", emitter, process.pid, Date.now());
    db.query("INSERT INTO journal VALUES (1, 'local', ?, 1, ?, ?, ?, 'heartbeat', '{}')").run(emitter, Date.now(), "local:pi:s1", emitter);
    db.close();

    const daemon = new ReconDaemon(f.config);
    const first = await daemon.runOnce();
    const second = await daemon.runOnce();
    expect(first.byKind.attachment_observed).toBe(2);
    expect(first.byKind.telemetry_gap).toBe(1);
    expect(second.byKind.telemetry_gap ?? 0).toBe(0);
    const output = await events(f.spool);
    expect(output.find((event) => event.kind === "attachment_observed")?.detail.binding).toBe("term-1");
    expect(output.find((event) => event.kind === "telemetry_gap")?.detail).toMatchObject({
      platform: "herdr", native_id: "term-gap", cwd: "/missing", stable_id: "local:claude:gap",
    });
  });

  test("aggregates a source outage and emits recovery without source-derived findings", async () => {
    const f = await fixture();
    await writeFile(f.herdr, "#!/bin/sh\nexit 7\n", { mode: 0o700 });
    const daemon = new ReconDaemon(f.config);
    const first = await daemon.runOnce();
    const second = await daemon.runOnce();
    expect(first.byKind.source_outage).toBe(1);
    expect(second.total).toBe(0);

    await writeFile(f.herdr, "#!/bin/sh\nprintf '%s\\n' '{\"result\":{\"agents\":[]}}'\n", { mode: 0o700 });
    const recovered = await daemon.runOnce();
    expect(recovered.byKind.source_recovered).toBe(1);
    const output = await events(f.spool);
    expect(output.filter((event) => event.detail?.source === "herdr").map((event) => event.kind)).toEqual(["source_outage", "source_recovered"]);
  });
});
