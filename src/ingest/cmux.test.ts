import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeLedger, scanOnce } from "./ingest";
import { scanCmux } from "./cmux";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "overload-cmux-"));
  roots.push(root);
  const path = join(root, "workstream.jsonl");
  const db = new Database(join(root, "ledger.db"));
  initializeLedger(db);
  return { root, path, db };
}

function row(kind: string, status: string, id: string, extra: Record<string, unknown> = {}) {
  const workstreamId = "claude-11111111-2222-3333-4444-555555555555";
  const payload = kind === "question"
    ? { question: { requestId: id, questions: [{ prompt: "Choose deployment?", options: [{ label: "safe" }] }] } }
    : kind === "permissionRequest"
      ? { permissionRequest: { requestId: id, toolName: "Bash", toolInputJSON: "{\"command\":\"echo secret\"}" } }
      : { [kind]: {} };
  return JSON.stringify({ id, kind, source: "claude", workstreamId, status: { [status]: {} }, cwd: "/repo", payload,
    createdAt: "2026-06-26T10:33:17Z", updatedAt: "2026-06-26T10:33:17Z", ...extra });
}

describe("cmux workstream ingestion", () => {
  test("turns a real-shape pending question into a Q1 request and terminal status resolves it", async () => {
    const { path, db } = await fixture();
    const pending = row("question", "pending", "ask-1");
    await writeFile(path, `${pending}\n`);
    expect((await scanCmux(db, path)).inserted).toBe(1);
    expect(db.query("SELECT state FROM requests WHERE request_id='ask-1'").get()).toEqual({ state: "pending" });
    expect(db.query("SELECT queue FROM current").get()).toEqual({ queue: "q1" });

    await writeFile(path, `${pending}\n${row("question", "answered", "ask-1")}\n`);
    expect((await scanCmux(db, path)).inserted).toBe(1);
    expect(db.query("SELECT state FROM requests WHERE request_id='ask-1'").get()).toEqual({ state: "resolved" });
    db.close();
  });

  test("detects truncate-and-regrow ABA with the same first line using cursor tail fingerprint", async () => {
    const { path, db } = await fixture();
    const sameHead = row("sessionStart", "telemetry", "head");
    const oldTail = row("question", "pending", "old");
    await writeFile(path, `${sameHead}\n${oldTail}\n`);
    await scanCmux(db, path);

    const newTail = row("permissionRequest", "pending", "new-request-with-a-longer-id");
    await writeFile(path, `${sameHead}\n${newTail}\n`);
    expect((await scanCmux(db, path)).inserted).toBe(2);
    expect((db.query("SELECT count(*) AS n FROM source_generations").get() as { n: number }).n).toBe(2);
    expect(db.query("SELECT retired FROM source_generations ORDER BY first_seen, rowid").all()).toEqual([{ retired: 1 }, { retired: 0 }]);
    expect(db.query("SELECT state FROM requests WHERE request_id='new-request-with-a-longer-id'").get()).toEqual({ state: "pending" });
    db.close();
  });

  test("is idempotent and silently skips a missing configured file through scanOnce", async () => {
    const { root, path, db } = await fixture();
    await writeFile(path, `${row("permissionRequest", "pending", "permit-1")}\n`);
    expect((await scanCmux(db, path)).inserted).toBe(1);
    expect((await scanCmux(db, path)).inserted).toBe(0);
    expect((db.query("SELECT count(*) AS n FROM journal").get() as { n: number }).n).toBe(1);
    expect(await scanOnce(db, join(root, "missing-spool"), 500, "osascript", join(root, "missing.jsonl"))).toEqual({ files: 0, inserted: 0 });
    db.close();
  });
});
