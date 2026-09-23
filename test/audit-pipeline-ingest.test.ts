/**
 * test/audit-pipeline-ingest.test.ts — audit (group data pipeline) backfill for
 * ingest stories whose r2 evidence cited a "green suite" but shipped no
 * assertion on the key expected behavior. Every case uses an isolated tmp
 * root + in-test Database; never touches ~/.overload.
 *
 * Covers: ING-01 loadConfig, ING-02 openLedger hardening, ING-04 hostile
 * discovery, ING-06 truncation recovery, ING-07 host/emitter dir binding,
 * ING-09 sessions projection, ING-10 liveness_domain claude vs process,
 * ING-11 liveness refresh last_seen_at, ING-12 reducer batch drain.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { activateClassifier, initializeLedger, loadConfig, openLedger, scanOnce } from "../src/ingest/ingest";
import { reduceJournal } from "../src/ingest/reducer";
import { CLASSIFIER_VERSION } from "../src/ingest/classifier";

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(prefix: string) { const r = await mkdtemp(join(tmpdir(), prefix)); roots.push(r); return r; }

function envelope(over: Record<string, unknown> = {}) {
  return {
    v: 1, at: 1_700_000_000_000, host: "local", runtime: "pi", session: "sess-1",
    emitter_id: "em-one", writer_id: "em-one", seq: 1, kind: "heartbeat",
    dropped_total: 0, write_error_total: 0, ...over,
  };
}

describe("ING-01 loadConfig variants", () => {
  test("missing file → defaults 2000/500", async () => {
    const dir = await root("ov-ing01-");
    const cfg = await loadConfig(join(dir, "nope.json"));
    expect(cfg.scan_interval_ms).toBe(2_000);
    expect(cfg.reducer_batch_size).toBe(500);
  });

  test("invalid JSON → defaults (warns, does not throw)", async () => {
    const dir = await root("ov-ing01b-");
    const p = join(dir, "config.json");
    await writeFile(p, "{ not json");
    const cfg = await loadConfig(p);
    expect(cfg.scan_interval_ms).toBe(2_000);
    expect(cfg.reducer_batch_size).toBe(500);
  });

  test("explicit values honored; non-positive falls back", async () => {
    const dir = await root("ov-ing01c-");
    const p = join(dir, "config.json");
    await writeFile(p, JSON.stringify({ scan_interval_ms: 777, reducer_batch_size: 0, bogus: -5 }));
    const cfg = await loadConfig(p);
    expect(cfg.scan_interval_ms).toBe(777);
    expect(cfg.reducer_batch_size).toBe(500); // 0 not a positive integer → fallback
  });
});

describe("ING-02 openLedger hardening", () => {
  test("ledger dir is 0700 and db file is 0600", async () => {
    const dir = await root("ov-ing02-");
    const db = await openLedger(join(dir, "ledger.db"));
    db.close();
    const dirMode = (await lstat(dir)).mode & 0o777;
    const fileMode = (await lstat(join(dir, "ledger.db"))).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  test("refuses a symlinked ledger path", async () => {
    const dir = await root("ov-ing02b-");
    const real = join(dir, "real.db");
    await writeFile(real, "");
    const link = join(dir, "link.db");
    await symlink(real, link);
    await expect(openLedger(link)).rejects.toThrow(/symlink/);
  });

  test("schema is idempotent across a second open", async () => {
    const dir = await root("ov-ing02c-");
    const a = await openLedger(join(dir, "ledger.db"));
    a.close();
    const b = await openLedger(join(dir, "ledger.db"));
    expect(b.query("SELECT count(*) AS n FROM sqlite_master WHERE type='table'").get()).toBeDefined();
    b.close();
  });
});

describe("ING-04 spool discovery rejects hostile names and symlinks", () => {
  test("foreign dir names, foreign files, and file symlinks are skipped", async () => {
    const dir = await root("ov-ing04-");
    const spool = join(dir, "spool");
    const good = join(spool, "local", "em-one");
    await mkdir(good, { recursive: true });
    await writeFile(join(good, "active-em-one-0.ndjson"), `${JSON.stringify(envelope())}\n`);
    // Host dir with an illegal name (regex rejects)
    await mkdir(join(spool, "bad name!"), { recursive: true });
    // Foreign file inside a valid emitter dir
    await writeFile(join(good, "README.txt"), "junk\n");
    // A symlink pretending to be a segment file
    await symlink(join(good, "active-em-one-0.ndjson"), join(good, "seg-em-one-1.ndjson"));

    const db = new Database(join(dir, "ledger.db"));
    initializeLedger(db);
    const result = await scanOnce(db, spool);
    expect(result.inserted).toBe(1);
    expect((db.query("SELECT count(*) n FROM journal").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("ING-06 truncation recovery restarts from 0 without double-insert", () => {
  test("cursor beyond new size restarts at 0 and dedups by (host,emitter,seq)", async () => {
    const dir = await root("ov-ing06-");
    const spool = join(dir, "spool");
    const em = join(spool, "local", "em-one");
    await mkdir(em, { recursive: true });
    const file = join(em, "active-em-one-0.ndjson");
    const lines = [1, 2, 3].map((s) => JSON.stringify(envelope({ seq: s }))).join("\n") + "\n";
    await writeFile(file, lines);
    const db = new Database(join(dir, "ledger.db"));
    initializeLedger(db);
    expect((await scanOnce(db, spool)).inserted).toBe(3);
    expect((db.query("SELECT bytes b FROM cursors").get() as { b: number }).b).toBe(Buffer.byteLength(lines));

    // Truncate + rewrite from scratch (emitter restarted its seq numbering).
    const rewritten = [1, 2].map((s) => JSON.stringify(envelope({ seq: s }))).join("\n") + "\n";
    await writeFile(file, rewritten);
    const second = await scanOnce(db, spool);
    expect(second.inserted).toBe(0); // seq 1,2 already present → deduped
    expect((db.query("SELECT count(*) n FROM journal").get() as { n: number }).n).toBe(3);
    db.close();
  });
});

describe("ING-07 envelope host/emitter must match its spool directory", () => {
  test("line whose host or emitter_id mismatches the dir is dropped", async () => {
    const dir = await root("ov-ing07-");
    const spool = join(dir, "spool");
    const em = join(spool, "local", "em-one");
    await mkdir(em, { recursive: true });
    const file = join(em, "active-em-one-0.ndjson");
    const good = envelope({ seq: 1 });
    const wrongHost = envelope({ seq: 2, host: "devbox" });
    const wrongEmitter = envelope({ seq: 3, emitter_id: "other", writer_id: "other" });
    await writeFile(file, [good, wrongHost, wrongEmitter].map(JSON.stringify).join("\n") + "\n");
    const db = new Database(join(dir, "ledger.db"));
    initializeLedger(db);
    expect((await scanOnce(db, spool)).inserted).toBe(1);
    expect((db.query("SELECT seq FROM journal").get() as { seq: number }).seq).toBe(1);
    db.close();
  });
});

describe("ING-09 sessions projection: origin upgrades only from unknown, cwd/branch coalesce", () => {
  test("second session_started does not overwrite origin or null cwd", async () => {
    const dir = await root("ov-ing09-");
    const spool = join(dir, "spool");
    const em = join(spool, "local", "em-one");
    await mkdir(em, { recursive: true });
    const file = join(em, "active-em-one-0.ndjson");
    const first = envelope({ seq: 1, kind: "session_started", detail: { cwd: "/repo", branch: "main", origin: "unknown" } });
    const second = envelope({ seq: 2, kind: "session_started", detail: { origin: "agent" } }); // no cwd/branch
    await writeFile(file, [first, second].map(JSON.stringify).join("\n") + "\n");
    const db = new Database(join(dir, "ledger.db"));
    initializeLedger(db);
    await scanOnce(db, spool);
    const row = db.query("SELECT origin, cwd, branch FROM sessions").get() as { origin: string; cwd: string | null; branch: string | null };
    expect(row).toEqual({ origin: "agent", cwd: "/repo", branch: "main" });
    db.close();
  });

  test("a non-unknown origin is never downgraded", async () => {
    const dir = await root("ov-ing09b-");
    const spool = join(dir, "spool");
    const em = join(spool, "local", "em-one");
    await mkdir(em, { recursive: true });
    const file = join(em, "active-em-one-0.ndjson");
    await writeFile(file, [
      envelope({ seq: 1, kind: "session_started", detail: { origin: "human" } }),
      envelope({ seq: 2, kind: "session_started", detail: { origin: "unknown" } }),
    ].map(JSON.stringify).join("\n") + "\n");
    const db = new Database(join(dir, "ledger.db"));
    initializeLedger(db);
    await scanOnce(db, spool);
    expect((db.query("SELECT origin FROM sessions").get() as { origin: string }).origin).toBe("human");
    db.close();
  });
});

describe("ING-10 liveness_domain is lifecycle for claude, process otherwise", () => {
  test("claude runtime → lifecycle; pi runtime → process", async () => {
    const dir = await root("ov-ing10-");
    const spool = join(dir, "spool");
    const em = join(spool, "local", "em-one");
    await mkdir(em, { recursive: true });
    const file = join(em, "active-em-one-0.ndjson");
    await writeFile(file, [
      envelope({ seq: 1, runtime: "claude", kind: "session_started", detail: { pid: 111 } }),
      envelope({ seq: 2, runtime: "pi", kind: "session_started", detail: { pid: 222 } }),
    ].map((e) => JSON.stringify(e)).join("\n") + "\n");
    const db = new Database(join(dir, "ledger.db"));
    initializeLedger(db);
    await scanOnce(db, spool);
    const rows = (db.query("SELECT runtime, liveness_domain FROM session_incarnations JOIN sessions USING (stable_id) ORDER BY runtime").all()) as Array<{ runtime: string; liveness_domain: string }>;
    expect(rows).toEqual([
      { runtime: "claude", liveness_domain: "lifecycle" },
      { runtime: "pi", liveness_domain: "process" },
    ]);
    db.close();
  });
});

describe("ING-11 non-start events bump session_incarnations.last_seen_at", () => {
  test("heartbeat advances last_seen_at monotonically", async () => {
    const dir = await root("ov-ing11-");
    const spool = join(dir, "spool");
    const em = join(spool, "local", "em-one");
    await mkdir(em, { recursive: true });
    const file = join(em, "active-em-one-0.ndjson");
    await writeFile(file, [
      envelope({ seq: 1, at: 1000, kind: "session_started", detail: { pid: 1 } }),
      envelope({ seq: 2, at: 500, kind: "heartbeat" }), // older than start
      envelope({ seq: 3, at: 9000, kind: "heartbeat" }),
    ].map(JSON.stringify).join("\n") + "\n");
    const db = new Database(join(dir, "ledger.db"));
    initializeLedger(db);
    await scanOnce(db, spool);
    expect((db.query("SELECT last_seen_at FROM session_incarnations").get() as { last_seen_at: number }).last_seen_at).toBe(9000);
    db.close();
  });
});

describe("ING-12 reduceJournal drains in batches until a short batch", () => {
  test("more than one batch is applied fully", () => {
    const db = new Database(":memory:");
    initializeLedger(db);
    for (let seq = 1; seq <= 10; seq++) {
      db.query(`INSERT INTO journal(host, emitter_id, seq, at, stable_id, writer_id, kind, detail)
        VALUES('local','em-one',?,?,?,'w','heartbeat','{}')`).run(seq, seq, seq);
    }
    // batchSize=4 → batches of 4,4,2; loop stops on the short 2-row batch.
    let drained = 0;
    let calls = 0;
    while (true) { const n = reduceJournal(db, 4); calls++; drained += n; if (n < 4) break; }
    expect(drained).toBe(10);
    expect(calls).toBe(3);
    expect((db.query("SELECT journal_seq FROM reducer_cursor WHERE id=1").get() as { journal_seq: number }).journal_seq).toBe(10);
    db.close();
  });
});

describe("ING-03 classifier activation appends once and records watermark", () => {
  test("activateClassifier twice keeps one row and records the journal watermark", async () => {
    const rootPath = await root("ov-ing03-");
    const spoolRoot = join(rootPath, "spool");
    const db = new Database(":memory:");
    initializeLedger(db);
    db.query("INSERT INTO journal(ingest_seq, host, emitter_id, seq, at, stable_id, writer_id, kind, detail) VALUES(7,'local','e',1,1,'s','w','heartbeat','{}')").run();
    expect(activateClassifier(db, rootPath, spoolRoot, 1_000)).toBe(true);
    expect(activateClassifier(db, rootPath, spoolRoot, 2_000)).toBe(false);
    const row = db.query("SELECT activated_at_journal_seq FROM classifier_activations WHERE version=?").get(CLASSIFIER_VERSION) as { activated_at_journal_seq: number };
    expect(row.activated_at_journal_seq).toBe(7);
    expect((db.query("SELECT count(*) n FROM classifier_activations").get() as { n: number }).n).toBe(1);
    db.close();
  });
});

describe("ING-13/14 ingest CLI --once contract + watchdog heartbeat", () => {
  test("ingest --once prints the ingested summary and writes a numeric heartbeat", async () => {
    const home = await root("ov-ingcli-");
    const env = { ...process.env, HOME: home };
    const proc = Bun.spawn(["bun", "src/ingest/ingest.ts", "--once"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(0);
    expect(out).toMatch(/^ingested \d+ new event\(s\) from \d+ file\(s\)$/m);
    const beat = await readFile(join(home, ".overload", "ingest.heartbeat"), "utf8");
    expect(Number(beat.trim())).toBeGreaterThan(0);
  });

  test("unknown CLI arg exits 2 with usage", async () => {
    const home = await root("ov-ingcli-bad-");
    const env = { ...process.env, HOME: home };
    const proc = Bun.spawn(["bun", "src/ingest/ingest.ts", "--bogus"], { cwd: process.cwd(), env, stdout: "pipe", stderr: "pipe" });
    await new Response(proc.stdout).text();
    await new Response(proc.stderr).text();
    expect(await proc.exited).toBe(2);
  });
});
