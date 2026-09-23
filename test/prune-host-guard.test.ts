import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pruneSpool } from "../src/ingest/prune";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });

const DAY = 86_400_000;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "overload-host-guard-"));
  roots.push(root);
  const spool = join(root, "spool");
  const db = new Database(":memory:");
  db.run("CREATE TABLE cursors(file_name TEXT PRIMARY KEY, bytes INTEGER NOT NULL)");
  return { root, spool, db };
}

async function segment(spool: string, host: string, emitter: string, name: string, body: string, ageMs: number) {
  const directory = join(spool, host, emitter);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  await writeFile(path, body);
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

describe("PRN-04 pruneSpool host-guard", () => {
  test("illegal host '../etc' returns empty summary and deletes nothing", async () => {
    const f = await fixture();
    // Put files under a "local" host tree.
    const old = await segment(f.spool, "local", "pi-1-aaaa", "seg-pi-1-aaaa-0.ndjson", "{\"a\":1}\n", 2 * DAY);
    f.db.run("INSERT INTO cursors VALUES (?, ?)", ["local/pi-1-aaaa/seg-pi-1-aaaa-0.ndjson", Bun.file(old).size]);

    const summary = await pruneSpool(f.db, f.spool, { host: "../etc", retentionMs: DAY });
    expect(summary.files).toBe(0);
    expect(summary.bytes).toBe(0);
    expect(summary.directories).toBe(0);
    // Original file untouched.
    expect(existsSync(old)).toBe(true);
    // No unexpected directories created at spool root.
    expect(existsSync(join(f.spool, "..etc"))).toBe(false);
    f.db.close();
  });

  test("illegal host empty string returns empty summary and deletes nothing", async () => {
    const f = await fixture();
    const old = await segment(f.spool, "local", "pi-1-aaaa", "seg-pi-1-aaaa-0.ndjson", "{\"a\":1}\n", 2 * DAY);
    f.db.run("INSERT INTO cursors VALUES (?, ?)", ["local/pi-1-aaaa/seg-pi-1-aaaa-0.ndjson", Bun.file(old).size]);

    const summary = await pruneSpool(f.db, f.spool, { host: "", retentionMs: DAY });
    expect(summary.files).toBe(0);
    expect(summary.bytes).toBe(0);
    expect(summary.directories).toBe(0);
    expect(existsSync(old)).toBe(true);
    f.db.close();
  });

  test("illegal host with slash returns empty summary and deletes nothing", async () => {
    const f = await fixture();
    const old = await segment(f.spool, "local", "pi-1-aaaa", "seg-pi-1-aaaa-0.ndjson", "{\"a\":1}\n", 2 * DAY);
    f.db.run("INSERT INTO cursors VALUES (?, ?)", ["local/pi-1-aaaa/seg-pi-1-aaaa-0.ndjson", Bun.file(old).size]);

    const summary = await pruneSpool(f.db, f.spool, { host: "foo/bar", retentionMs: DAY });
    expect(summary.files).toBe(0);
    expect(existsSync(old)).toBe(true);
    f.db.close();
  });

  test("legal host 'local' still prunes consumed aged segments", async () => {
    const f = await fixture();
    const old = await segment(f.spool, "local", "pi-1-aaaa", "seg-pi-1-aaaa-0.ndjson", "{\"a\":1}\n", 2 * DAY);
    f.db.run("INSERT INTO cursors VALUES (?, ?)", ["local/pi-1-aaaa/seg-pi-1-aaaa-0.ndjson", Bun.file(old).size]);

    const summary = await pruneSpool(f.db, f.spool, { host: "local", retentionMs: DAY });
    expect(summary.files).toBe(1);
    expect(existsSync(old)).toBe(false);
    f.db.close();
  });
});
