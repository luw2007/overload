import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFile, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
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
  test("reads only bounded verification bytes plus the appended tail in steady state", async () => {
    const { path, db } = await fixture();
    const initial = Array.from({ length: 512 }, (_, index) =>
      `${row("sessionStart", "telemetry", `start-${index}`, { padding: "x".repeat(1024) })}\n`
    ).join("");
    await writeFile(path, initial);
    await scanCmux(db, path);

    const appended = `${row("question", "pending", "ask-tail")}\n`;
    await appendFile(path, appended);

    const probe = await open(path, "r");
    const prototype = Object.getPrototypeOf(probe) as { read: (...args: any[]) => Promise<{ bytesRead: number }> };
    await probe.close();
    const originalRead = prototype.read;
    const reads: Array<{ bytesRead: number; position: number | null }> = [];
    prototype.read = async function (...args: any[]) {
      const result = await originalRead.apply(this, args);
      reads.push({ bytesRead: result.bytesRead, position: args[3] });
      return result;
    };

    try {
      expect((await scanCmux(db, path)).inserted).toBe(1);
    } finally {
      prototype.read = originalRead;
    }

    const bytesRead = reads.reduce((total, read) => total + read.bytesRead, 0);
    expect(bytesRead).toBeLessThan(appended.length + 8192);
    expect(reads.some((read) => read.position === initial.length)).toBeTrue();
  });

  test("turns a real-shape pending question into a Q1 request and terminal status resolves it", async () => {
    const { path, db } = await fixture();
    const started = row("sessionStart", "telemetry", "start-1");
    const pending = row("question", "pending", "ask-1");
    await writeFile(path, `${started}\n${pending}\n`);
    expect((await scanCmux(db, path)).inserted).toBe(2);
    expect(db.query("SELECT state FROM requests WHERE request_id='ask-1'").get()).toEqual({ state: "pending" });
    expect(db.query("SELECT kind FROM journal WHERE kind='decision_requested'").get()).toEqual({ kind: "decision_requested" });

    await writeFile(path, `${started}\n${pending}\n${row("question", "answered", "ask-1")}\n`);
    expect((await scanCmux(db, path)).inserted).toBe(1);
    expect(db.query("SELECT state FROM requests WHERE request_id='ask-1'").get()).toEqual({ state: "resolved" });
    db.close();
  });

  test("detects rotation even when the replacement has the same head line", async () => {
    const { root, path, db } = await fixture();
    const head = row("sessionStart", "telemetry", "same-head");
    await writeFile(path, `${head}\n${row("question", "pending", "old-question")}\n`);
    const first = await scanCmux(db, path);

    await rename(path, join(root, "workstream.old.jsonl"));
    await writeFile(path, `${head}\n${row("question", "pending", "new-question")}\n`);
    const second = await scanCmux(db, path);

    expect(second.generation).not.toBe(first.generation);
    expect(second.inserted).toBe(2);
    expect((db.query("SELECT COUNT(*) AS count FROM source_generations WHERE path=?").get(path) as { count: number }).count).toBe(2);
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
    expect(await scanOnce(db, join(root, "missing-spool"), 500, join(root, "missing.jsonl"))).toEqual({ files: 0, inserted: 0 });
    db.close();
  });
});
