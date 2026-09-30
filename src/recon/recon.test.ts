import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReconDaemon, type ReconConfig } from "./recon";
import { initializeLedger, scanOnce } from "../ingest/ingest";

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
    CREATE TABLE journal_7d AS SELECT * FROM journal WHERE 0;
    CREATE TABLE journal_30d AS SELECT * FROM journal WHERE 0;
    CREATE VIEW journal_all AS SELECT * FROM journal UNION ALL SELECT * FROM journal_7d UNION ALL SELECT * FROM journal_30d;
    CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT, session TEXT, cwd TEXT);
    CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT, liveness_domain TEXT, pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER);
    CREATE TABLE cursors(file_name TEXT PRIMARY KEY, bytes INTEGER);
    CREATE TABLE attachments(stable_id TEXT, platform TEXT, binding TEXT, observed_at INTEGER, valid INTEGER);
    CREATE TABLE current(stable_id TEXT PRIMARY KEY, state TEXT, last_progress_at INTEGER, last_event_at INTEGER);
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
    turn_hang_ms: 1_000,
    command_timeout_ms: 10_000,
    host: "local",
    ledger,
    spool,
    herdr_cmd: herdr,
    orca_cmd: orca,
    remote_probe_cmd: "unused {host} {pid}",
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

/** A live pi incarnation (this process) with a controllable progress clock. */
function seedLive(ledger: string, emitter: string, options: { at: number; state: string; progressAt: number }) {
  const db = new Database(ledger);
  db.query("INSERT INTO sessions VALUES (?, 'local', 'pi', 's1', '/repo')").run("local:pi:s1");
  db.query("INSERT INTO session_incarnations VALUES (?, ?, 'process', ?, 'feedface00', 1, ?)")
    .run("local:pi:s1", emitter, process.pid, options.at);
  db.query("INSERT INTO journal VALUES (1, 'local', ?, 1, ?, ?, ?, 'heartbeat', '{}')")
    .run(emitter, options.at, "local:pi:s1", emitter);
  db.query("INSERT INTO current VALUES (?, ?, ?, ?)").run("local:pi:s1", options.state, options.progressAt, options.at);
  db.close();
}

function ingestFinding(ledger: string, kind: string, emitter: string, at: number) {
  const db = new Database(ledger);
  db.query("INSERT INTO journal VALUES (99, 'local', 'overload-x', 1, ?, 'local:pi:s1', 'overload-x', ?, ?)")
    .run(at, kind, JSON.stringify({ emitter_id: emitter, stable_id: "local:pi:s1" }));
  db.close();
}

const probes = (addresses: string[], sockets: Array<{ local: string; peer: string }> = []) => ({
  localAddresses: () => new Set(addresses),
  establishedSockets: async () => sockets,
});

function seedRemote(ledger: string, emitter: string, pid = 999999) {
  const db = new Database(ledger);
  db.query("INSERT INTO sessions VALUES (?, 'devbox', 'pi', 'remote', '/devbox/repo')").run("devbox:pi:remote");
  db.query("INSERT INTO session_incarnations VALUES (?, ?, 'process', ?, 'devbox0000', 1, ?)")
    .run("devbox:pi:remote", emitter, pid, Date.now() - 5_000);
  db.query("INSERT INTO journal VALUES (1, 'devbox', ?, 1, ?, ?, ?, 'heartbeat', '{}')")
    .run(emitter, Date.now() - 5_000, "devbox:pi:remote", emitter);
  db.close();
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

  test("treats a vanished spool file as consumed when prune wins the lstat race", async () => {
    const f = await fixture();
    const emitter = "pi-999999-pruned00";
    const sourceDir = join(f.spool, "local", emitter);
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = join(sourceDir, `active-${emitter}-0.ndjson`);
    await writeFile(sourceFile, "source-event\n");
    const db = new Database(f.ledger);
    db.query("INSERT INTO sessions VALUES (?, 'local', 'pi', 's1', '/repo')").run("local:pi:s1");
    db.query("INSERT INTO session_incarnations VALUES (?, ?, 'process', 999999, 'pruned0000', 1, ?)")
      .run("local:pi:s1", emitter, Date.now() - 5_000);
    db.query("INSERT INTO journal VALUES (1, 'local', ?, 1, ?, ?, ?, 'heartbeat', '{}')")
      .run(emitter, Date.now() - 5_000, "local:pi:s1", emitter);
    db.close();

    let raced = false;
    const raceProbes = {
      ...probes(["10.0.0.1"]),
      spoolLstat: async (path: string) => {
        if (path === sourceFile && !raced) {
          raced = true;
          await rm(path);
          const error = new Error("pruned") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        }
        return stat(path);
      },
    };
    const summary = await new ReconDaemon(f.config, raceProbes).runOnce();
    expect(raced).toBe(true);
    expect(summary.byKind.emitter_drained).toBe(1);
  });

  test("keeps a remote incarnation live when its injected host probe finds the process", async () => {
    const f = await fixture();
    const emitter = "pi-999999-devbox00";
    seedRemote(f.ledger, emitter);
    let calledWith: [string, number] | undefined;

    const summary = await new ReconDaemon(f.config, {
      ...probes([]),
      remoteProcess: async (host, pid) => { calledWith = [host, pid]; return "alive"; },
    }).runOnce();

    expect(calledWith).toEqual(["devbox", 999999]);
    expect(summary.byKind.emitter_dead ?? 0).toBe(0);
  });

  test("batches same-host pids into one probe", async () => {
    const f = await fixture();
    const db = new Database(f.ledger);
    for (const [suffix, pid] of [["one", 91_001], ["two", 91_002]] as const) {
      const stable = `devbox:pi:${suffix}`;
      const writer = `pi-${pid}-devbox`;
      db.query("INSERT INTO sessions VALUES (?, 'devbox', 'pi', ?, '/repo')").run(stable, suffix);
      db.query("INSERT INTO session_incarnations VALUES (?, ?, 'process', ?, 'devbox0000', 1, 1)").run(stable, writer, pid);
      db.query("INSERT INTO journal VALUES (?, 'devbox', ?, 1, 1, ?, ?, 'heartbeat', '{}')").run(pid, writer, stable, writer);
    }
    db.close();
    const calls: Array<[string, number[]]> = [];
    const daemon = new ReconDaemon(f.config, {
      ...probes([]),
      remoteProcesses: async (host, pids) => { calls.push([host, pids]); return new Set<number>(); },
    });

    expect((await daemon.runOnce()).byKind.emitter_dead).toBe(2);
    expect(calls).toEqual([["devbox", [91_001, 91_002]]]);
  });

  /** Routed through the real ingest on the real schema on purpose: recon's spool
   * output is only durable if `parseEnvelope` accepts it, and a test that
   * hand-inserts recon's events into the journal cannot see it being rejected. */
  test("a drained remote incarnation leaves the probe set once real ingest has read recon's spool", async () => {
    const root = await mkdtemp(join(tmpdir(), "overload-recon-ingest-"));
    roots.push(root);
    const spool = join(root, "spool");
    await mkdir(spool, { recursive: true });
    const ledger = join(root, "ledger.db");
    const seed = new Database(ledger);
    initializeLedger(seed);
    const stable = "devbox:pi:one";
    const writer = "pi-91001-devbox";
    seed.query("INSERT INTO sessions(stable_id,host,runtime,session,cwd) VALUES (?,'devbox','pi','one','/repo')").run(stable);
    seed.query(`INSERT INTO session_incarnations(stable_id,writer_id,liveness_domain,pid,proc_boot_id,started_at,last_seen_at)
      VALUES (?,?,'process',91001,'devbox0000',1,1)`).run(stable, writer);
    seed.query(`INSERT INTO journal(host,emitter_id,seq,at,stable_id,writer_id,kind,detail)
      VALUES ('devbox',?,1,1,?,?,'heartbeat','{}')`).run(writer, stable, writer);
    seed.close();

    const herdr = join(root, "herdr.sh"), orca = join(root, "orca.sh"), cmux = join(root, "cmux.json");
    await writeFile(herdr, "#!/bin/sh\nprintf '%s\\n' '{\"result\":{\"agents\":[]}}'\n", { mode: 0o700 });
    await writeFile(orca, "#!/bin/sh\nprintf '%s\\n' '[]'\n", { mode: 0o700 });
    await writeFile(cmux, "{}\n");
    const config: ReconConfig = {
      recon_interval_ms: 60_000, drain_grace_ms: 0, stall_profile_ms: 1_000, turn_hang_ms: 1_000,
      command_timeout_ms: 10_000, host: "local", ledger, spool,
      herdr_cmd: herdr, orca_cmd: orca, remote_probe_cmd: "unused {host} {pids}", cmux_sessions_file: cmux,
    };
    const calls: number[][] = [];
    const daemon = new ReconDaemon(config, {
      ...probes([]),
      remoteProcesses: async (_host, pids) => { calls.push(pids); return new Set<number>(); },
    });

    const first = await daemon.runOnce();
    expect(first.byKind.emitter_dead).toBe(1);
    expect(first.byKind.emitter_drained).toBe(1);
    expect(calls).toEqual([[91_001]]);

    const db = new Database(ledger);
    await scanOnce(db, spool);
    // Recon must never forge a terminal event for another host's session: the
    // envelope host is the emitter's, and ingest derives stable_id from it.
    expect(db.query("SELECT COUNT(*) n FROM journal WHERE kind='session_ended'").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) n FROM journal WHERE kind='emitter_drained' AND host='local'").get()).toEqual({ n: 1 });
    db.close();

    calls.length = 0;
    await daemon.runOnce();
    expect(calls).toEqual([]);
    // The durable finding, not in-process memory, is what retires it: a fresh
    // daemon (as after a restart) must not probe it either.
    const restarted = new ReconDaemon(config, {
      ...probes([]),
      remoteProcesses: async (_host, pids) => { calls.push(pids); return new Set<number>(); },
    });
    await restarted.runOnce();
    expect(calls).toEqual([]);
  });

  /** `ps -p` exits 1 when nothing matched. That is an answer, and treating it as a
   * failed probe left every all-dead host permanently unresolved behind a
   * source_outage. Exercises the real probe, not an injected one. */
  test("the real host probe reads exit 1 as proven-absent and exit 255 as unknown", async () => {
    for (const [rc, expected] of [[1, { dead: 1, outage: 0 }], [255, { dead: 0, outage: 1 }]] as const) {
      const f = await fixture();
      seedRemote(f.ledger, "pi-999999-devbox00");
      const summary = await new ReconDaemon(
        { ...f.config, remote_probe_cmd: `exit ${rc}` }, probes([]),
      ).runOnce();
      expect({ dead: summary.byKind.emitter_dead ?? 0, outage: summary.byKind.source_outage ?? 0 }).toEqual(expected);
    }
  });

  test("declares a remote incarnation dead only when its injected host probe proves absence", async () => {
    const f = await fixture();
    const emitter = "pi-999999-devbox01";
    seedRemote(f.ledger, emitter);

    const summary = await new ReconDaemon(f.config, {
      ...probes([]), remoteProcess: async () => "dead",
    }).runOnce();

    expect(summary.byKind.emitter_dead).toBe(1);
  });

  test("treats a failed remote host probe as unknown and aggregates outage and recovery", async () => {
    const f = await fixture();
    const emitter = "pi-999999-devbox02";
    seedRemote(f.ledger, emitter);
    let reachable = false;
    const daemon = new ReconDaemon(f.config, {
      ...probes([]),
      remoteProcess: async () => {
        if (!reachable) throw new Error("ssh timeout");
        return "alive";
      },
    });

    const failed = await daemon.runOnce();
    const repeated = await daemon.runOnce();
    reachable = true;
    const recovered = await daemon.runOnce();

    expect(failed.byKind.emitter_dead ?? 0).toBe(0);
    expect(failed.byKind.source_outage).toBe(1);
    expect(repeated.total).toBe(0);
    expect(recovered.byKind.source_recovered).toBe(1);
    const output = await events(f.spool);
    expect(output.filter((event) => event.detail?.source === "host_probe:devbox").map((event) => event.kind))
      .toEqual(["source_outage", "source_recovered"]);
  });

  test("checks a dead remote emitter against spool/<incarnation host>/<emitter>", async () => {
    const f = await fixture();
    const emitter = "pi-999999-devbox03";
    seedRemote(f.ledger, emitter);
    const sourceDir = join(f.spool, "devbox", emitter);
    await mkdir(sourceDir, { recursive: true });
    await writeFile(join(sourceDir, `active-${emitter}-0.ndjson`), "not-consumed\n");

    const summary = await new ReconDaemon(f.config, {
      ...probes([]), remoteProcess: async () => "dead",
    }).runOnce();

    expect(summary.byKind.emitter_dead).toBe(1);
    expect(summary.byKind.emitter_drained ?? 0).toBe(0);
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

  test("preserves emitter clocks, end exclusion, and liveness filters in one reconciliation pass", async () => {
    const f = await fixture();
    const now = Date.now();
    const sharedWriter = "pi-91000-shared00";
    const noEventWriter = "pi-91003-noevent0";
    const db = new Database(f.ledger);
    const addSession = (stableId: string, host: string, session: string) => {
      db.query("INSERT INTO sessions VALUES (?, ?, 'pi', ?, '/repo')").run(stableId, host, session);
    };
    const addIncarnation = (stableId: string, writerId: string, domain: string, pid: number,
      startedAt: number, lastSeenAt: number | null) => {
      db.query("INSERT INTO session_incarnations VALUES (?, ?, ?, ?, 'bootclock', ?, ?)")
        .run(stableId, writerId, domain, pid, startedAt, lastSeenAt);
    };
    for (const [stableId, session] of [["devbox:pi:shared-a", "shared-a"], ["devbox:pi:shared-b", "shared-b"]]) {
      addSession(stableId, "devbox", session);
    }
    addSession("devbox:pi:no-event", "devbox", "no-event");
    addSession("devbox:pi:ended", "devbox", "ended");
    addSession("devbox:pi:lifecycle", "devbox", "lifecycle");
    addSession("devbox:pi:no-pid", "devbox", "no-pid");
    addIncarnation("devbox:pi:shared-a", sharedWriter, "process", 91_001, now - 5_000, now - 5_000);
    addIncarnation("devbox:pi:shared-b", sharedWriter, "process", 91_002, now - 5_000, now - 5_000);
    addIncarnation("devbox:pi:no-event", noEventWriter, "process", 91_003, now - 4_000, null);
    addIncarnation("devbox:pi:ended", "pi-91004-ended000", "process", 91_004, now - 5_000, now - 100);
    addIncarnation("devbox:pi:lifecycle", "pi-91005-lifecycle", "lifecycle", 91_005, now - 5_000, now - 100);
    addIncarnation("devbox:pi:no-pid", "pi-91006-nopid000", "process", 0, now - 5_000, now - 100);
    db.query("INSERT INTO journal VALUES (1, 'devbox', ?, 1, ?, 'devbox:pi:shared-a', ?, 'heartbeat', '{}')")
      .run(sharedWriter, now - 100, sharedWriter);
    // Ingest order is deliberately opposite wall-clock order: MAX(at), not the
    // last row, is the emitter heartbeat clock shared by duplicate writer IDs.
    db.query("INSERT INTO journal VALUES (2, 'devbox', ?, 2, ?, 'devbox:pi:shared-b', ?, 'heartbeat', '{}')")
      .run(sharedWriter, now - 8_000, sharedWriter);
    db.query("INSERT INTO journal VALUES (3, 'devbox', 'pi-91004-ended000', 1, ?, 'devbox:pi:ended', 'pi-91004-ended000', 'session_ended', '{}')")
      .run(now - 50);
    for (const stableId of ["devbox:pi:shared-a", "devbox:pi:shared-b", "devbox:pi:no-event"])
      db.query("INSERT INTO current VALUES (?, 'working', ?, ?)").run(stableId, now, now);
    db.close();

    const probed: number[] = [];
    const summary = await new ReconDaemon(f.config, {
      ...probes([]),
      remoteProcess: async (_host, pid) => { probed.push(pid); return "alive"; },
    }).runOnce(now);

    expect(probed).toEqual([91_001, 91_002, 91_003]);
    expect(summary.byKind.emitter_stalled).toBe(1);
    const stalls = (await events(f.spool)).filter((event) => event.kind === "emitter_stalled");
    expect(stalls).toHaveLength(1);
    expect(stalls[0]?.detail).toMatchObject({
      emitter_id: noEventWriter, stable_id: "devbox:pi:no-event", silent_ms: 4_000,
    });
  });

  test("ignores idle silence and reports a working stall once per silence episode", async () => {
    const f = await fixture();
    const emitter = `pi-${process.pid}-idlecafe`;
    const now = Date.now();
    seedLive(f.ledger, emitter, { at: now - 5_000, state: "idle", progressAt: now - 5_000 });

    const idle = await new ReconDaemon(f.config, probes(["10.0.0.1"])).runOnce(now);
    expect(idle.byKind.emitter_stalled ?? 0).toBe(0);

    const db = new Database(f.ledger);
    db.query("UPDATE current SET state='working'").run();
    db.close();
    const working = await new ReconDaemon(f.config, probes(["10.0.0.1"])).runOnce(now);
    expect(working.byKind.emitter_stalled).toBe(1);

    ingestFinding(f.ledger, "emitter_stalled", emitter, now);
    const repeat = await new ReconDaemon(f.config, probes(["10.0.0.1"])).runOnce(now);
    expect(repeat.byKind.emitter_stalled ?? 0).toBe(0);
  });

  test("reports a heartbeating turn with frozen progress as turn_hung", async () => {
    const f = await fixture();
    const emitter = `pi-${process.pid}-hungbeef`;
    const now = Date.now();
    seedLive(f.ledger, emitter, { at: now - 100, state: "working", progressAt: now - 60_000 });

    const summary = await new ReconDaemon(f.config, probes(["10.0.0.1"])).runOnce(now);
    expect(summary.byKind.turn_hung).toBe(1);
    expect(summary.byKind.emitter_stalled ?? 0).toBe(0);
    const finding = (await events(f.spool)).find((event) => event.kind === "turn_hung");
    expect(finding?.detail).toMatchObject({ emitter_id: emitter, stable_id: "local:pi:s1" });
    expect(finding?.detail.hung_ms).toBeGreaterThanOrEqual(60_000);
  });

  test("outranks turn_hung with dead_connection when a socket is stranded on a lost address", async () => {
    const f = await fixture();
    const emitter = `pi-${process.pid}-deadconn`;
    const now = Date.now();
    // Only a lost address shortens the grace, so the hang is younger than turn_hang_ms.
    const config = { ...f.config, turn_hang_ms: 3_600_000 };
    seedLive(f.ledger, emitter, { at: now - 100, state: "working", progressAt: now - 120_000 });
    const db = new Database(f.ledger);
    db.query("INSERT INTO journal VALUES (50, 'local', 'overload-x', 1, ?, 'admin', 'overload-x', 'network_changed', ?)")
      .run(now - 200, JSON.stringify({ previous: [], current: ["10.0.0.1", "192.168.1.5"] }));
    db.close();

    const socket = { local: "192.168.1.5:55373", peer: "192.168.1.20:20128" };
    const summary = await new ReconDaemon(config, probes(["10.0.0.1"], [socket])).runOnce(now);
    expect(summary.byKind.dead_connection).toBe(1);
    expect(summary.byKind.turn_hung ?? 0).toBe(0);
    expect(summary.byKind.network_changed).toBe(1);
    const finding = (await events(f.spool)).find((event) => event.kind === "dead_connection");
    expect(finding?.detail).toMatchObject({ local: socket.local, peer: socket.peer });
  });

  test("ignores a future remote clock when the local ingest pipeline is stale", async () => {
    const f = await fixture();
    const emitter = `pi-${process.pid}-remoteclock`;
    const now = Date.now();
    seedLive(f.ledger, emitter, { at: now - 600_000, state: "working", progressAt: now - 600_000 });
    const db = new Database(f.ledger);
    db.query("INSERT INTO journal VALUES (2, 'devbox', 'pi-remote', 1, ?, 'devbox:pi:s2', 'pi-remote', 'heartbeat', '{}')")
      .run(now + 60_000);
    db.close();

    const summary = await new ReconDaemon(f.config, probes(["10.0.0.1"])).runOnce(now);
    expect(summary.byKind.turn_hung ?? 0).toBe(0);
  });

  test("holds back hang findings while the ingest clock is stale", async () => {
    const f = await fixture();
    const emitter = `pi-${process.pid}-stalepipe`;
    const now = Date.now();
    seedLive(f.ledger, emitter, { at: now - 600_000, state: "working", progressAt: now - 600_000 });

    const summary = await new ReconDaemon(f.config, probes(["10.0.0.1"])).runOnce(now);
    expect(summary.byKind.turn_hung ?? 0).toBe(0);
  });
});
