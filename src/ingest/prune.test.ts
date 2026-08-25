import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneSpool } from "./prune";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const DAY = 86_400_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "overload-prune-"));
  roots.push(root);
  const spool = join(root, "spool");
  const db = new Database(":memory:");
  db.run("CREATE TABLE cursors(file_name TEXT PRIMARY KEY, bytes INTEGER NOT NULL)");
  return { root, spool, db };
}

/** Writes a spool file and back-dates it so retention decisions are explicit. */
async function segment(spool: string, host: string, emitter: string, name: string, body: string, ageMs: number) {
  const directory = join(spool, host, emitter);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, body);
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

function markConsumed(db: Database, spool: string, key: string, path: string, bytes?: number) {
  db.run("INSERT INTO cursors VALUES (?, ?)", [key, bytes ?? Bun.file(path).size]);
}

describe("pruneSpool", () => {
  test("sweeps consumed sealed segments and leaves unconsumed or recent ones", async () => {
    const f = await fixture();
    const old = await segment(f.spool, "local", "pi-1-aaaa", "seg-pi-1-aaaa-0.ndjson", "{\"a\":1}\n", 2 * DAY);
    const partial = await segment(f.spool, "local", "pi-1-aaaa", "seg-pi-1-aaaa-1.ndjson", "{}\n{}\n", 2 * DAY);
    const fresh = await segment(f.spool, "local", "pi-1-aaaa", "seg-pi-1-aaaa-2.ndjson", "{}\n", 60_000);
    markConsumed(f.db, f.spool, "local/pi-1-aaaa/seg-pi-1-aaaa-0.ndjson", old);
    markConsumed(f.db, f.spool, "local/pi-1-aaaa/seg-pi-1-aaaa-1.ndjson", partial, 3);
    markConsumed(f.db, f.spool, "local/pi-1-aaaa/seg-pi-1-aaaa-2.ndjson", fresh);

    const summary = await pruneSpool(f.db, f.spool, { host: "local", retentionMs: DAY });
    expect(summary.files).toBe(1);
    // 8 bytes = the only consumed, aged, sealed segment.
    expect(summary.bytes).toBe(8);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(partial)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
    // The cursor row dies with its file; paths are never reused.
    expect(f.db.query("SELECT count(*) n FROM cursors").get()).toEqual({ n: 2 });
  });

  test("keeps a live emitter's unsealed file and removes a dead one's, then drops the empty directory", async () => {
    const f = await fixture();
    const live = await segment(f.spool, "local", `omp-${process.pid}-bbbb`, `active-omp-${process.pid}-bbbb-0.ndjson`, "{}\n", 2 * DAY);
    const dead = await segment(f.spool, "local", "omp-999999-cccc", "active-omp-999999-cccc-0.ndjson", "{}\n", 2 * DAY);
    markConsumed(f.db, f.spool, `local/omp-${process.pid}-bbbb/active-omp-${process.pid}-bbbb-0.ndjson`, live);
    markConsumed(f.db, f.spool, "local/omp-999999-cccc/active-omp-999999-cccc-0.ndjson", dead);

    const summary = await pruneSpool(f.db, f.spool, { host: "local", retentionMs: DAY });
    expect(summary.files).toBe(1);
    expect(summary.directories).toBe(1);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(join(f.spool, "local", "omp-999999-cccc"))).toBe(false);
  });

  test("never touches a pulled host tree, because rsync would refetch it", async () => {
    const f = await fixture();
    const remote = await segment(f.spool, "devbox", "pi-2-dddd", "seg-pi-2-dddd-0.ndjson", "{}\n", 30 * DAY);
    markConsumed(f.db, f.spool, "devbox/pi-2-dddd/seg-pi-2-dddd-0.ndjson", remote);

    const summary = await pruneSpool(f.db, f.spool, { host: "local", retentionMs: DAY });
    expect(summary.files).toBe(0);
    expect(existsSync(remote)).toBe(true);
  });
});
