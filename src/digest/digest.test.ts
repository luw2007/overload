import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateDigest } from "./digest";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "overload-digest-")); roots.push(root);
  const db = new Database(join(root, "ledger.db"));
  db.run("CREATE TABLE current(stable_id TEXT PRIMARY KEY, queue TEXT, q5_reason TEXT, last_event_at INTEGER)");
  db.run("CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT)");
  db.run("CREATE TABLE journal(ingest_seq INTEGER PRIMARY KEY, stable_id TEXT, at INTEGER, kind TEXT, detail TEXT)");
  db.run("CREATE TABLE attachments(stable_id TEXT, binding TEXT, observed_at INTEGER, valid INTEGER)");
  db.run("CREATE TABLE notifications(request_uid TEXT, kind TEXT, state TEXT, sent_at INTEGER)");
  db.run("CREATE TABLE requests(request_uid TEXT, stable_id TEXT, state TEXT, created_at INTEGER)");
  db.run("CREATE TABLE incidents(source TEXT, closed_at INTEGER)");
  db.run("CREATE TABLE coverage_gaps(id INTEGER)");
  return { root, db, out: join(root, "digests") };
}

function add(db: Database, id: string, queue: string, seq: number) {
  db.run("INSERT INTO current VALUES (?, ?, ?, ?)", [id, queue, queue === "q5" ? "stalled" : null, seq]);
  db.run("INSERT INTO sessions VALUES (?, 'local')", [id]);
  db.run("INSERT INTO journal VALUES (?, ?, ?, 'settled', ?)", [seq, id, seq, JSON.stringify({ text: `summary ${id}` })]);
}

describe("digest generation", () => {
  test("orders q5 before q2 before q4 and caps the batch at 50", async () => {
    const { db, out } = fixture();
    for (let i = 0; i < 52; i++) add(db, `q4-${i}`, "q4", i);
    add(db, "q2-one", "q2", 100); add(db, "q5-one", "q5", 101);
    const path = await generateDigest(db, { outputDir: out, now: new Date("2026-08-13T09:15:00Z") });
    const markdown = readFileSync(path, "utf8");
    expect((markdown.match(/^## /gm) ?? []).length).toBe(50);
    expect(markdown.indexOf("q5-one")).toBeLessThan(markdown.indexOf("q2-one"));
    expect(markdown.indexOf("q2-one")).toBeLessThan(markdown.indexOf("q4-"));
    expect(markdown).toContain("summary q5-one");
    expect(markdown).toContain("Attention: interruptions(24h)=0");
    db.close();
  });

  test("failure before rename leaves neither a partial publication nor tmp file", async () => {
    const { db, out } = fixture(); add(db, "q4-one", "q4", 1);
    await expect(generateDigest(db, { outputDir: out, now: new Date("2026-08-13T09:15:00Z"), beforeRename: () => { throw new Error("killed"); } })).rejects.toThrow("killed");
    expect(existsSync(join(out, "20260813-09.md"))).toBeFalse();
    expect(existsSync(out) ? readdirSync(out).filter((name) => name.includes(".tmp")).length : 0).toBe(0);
    db.close();
  });
});
