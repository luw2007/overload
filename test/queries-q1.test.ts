/**
 * test/queries-q1.test.ts — queryQ1's `summary`/`options` contract fields
 * (src/shared/queries.ts). Runs the real ledger DDL (src/ingest/schema.sql,
 * read verbatim — schema is frozen and never duplicated here) so this test
 * fails the moment the production schema and this query drift apart.
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { queryQ1 } from "../src/shared/queries";

const REPO = process.cwd();
const SCHEMA_SQL = readFileSync(join(REPO, "src/ingest/schema.sql"), "utf8");

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA_SQL);
});

afterEach(() => {
  db.close();
});

function insertRequest(uid: string, stableId: string, detail: string | null, createdAt = Date.now()): void {
  db.query(`INSERT INTO sessions(stable_id, host, runtime, session, origin, created_at, first_seen_at)
    VALUES (?, 'local', 'pi', ?, 'unknown', ?, ?)`).run(stableId, stableId, createdAt, createdAt);
  db.query(`INSERT INTO requests(request_uid, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, detail)
    VALUES (?, ?, 'w1', 'e1', ?, 'ask', 'pending', ?, ?)`).run(uid, stableId, uid, createdAt, detail);
}

describe("queryQ1 summary/options extraction", () => {
  test("ask-sourced detail (summary + options array) surfaces both fields", () => {
    insertRequest("r1", "s1", JSON.stringify({ request_id: "r1", summary: "Deploy to prod?", options: ["Yes", "No"] }));
    const [row] = queryQ1(db);
    expect(row?.summary).toBe("Deploy to prod?");
    expect(row?.options).toEqual(["Yes", "No"]);
  });

  test("cmux-sourced detail (summary only, no options field) surfaces summary with null options", () => {
    insertRequest("r2", "s2", JSON.stringify({ request_id: "r2", request_kind: "question", tool_name: "AskUserQuestion", summary: "Choose deployment?" }));
    const [row] = queryQ1(db);
    expect(row?.summary).toBe("Choose deployment?");
    expect(row?.options).toBeNull();
  });

  test("gated (approval-gate) detail has neither field: both null", () => {
    insertRequest("r3", "s3", JSON.stringify({ request_id: "r3", gated: true }));
    const [row] = queryQ1(db);
    expect(row?.summary).toBeNull();
    expect(row?.options).toBeNull();
  });

  test("absent detail (NULL column) yields both fields null", () => {
    insertRequest("r4", "s4", null);
    const [row] = queryQ1(db);
    expect(row?.detail).toBeNull();
    expect(row?.summary).toBeNull();
    expect(row?.options).toBeNull();
  });

  test("malformed JSON detail parses to null detail and null summary/options", () => {
    insertRequest("r5", "s5", "{not valid json");
    const [row] = queryQ1(db);
    expect(row?.detail).toBeNull();
    expect(row?.summary).toBeNull();
    expect(row?.options).toBeNull();
  });

  test("options containing non-string entries are dropped; empty result is null, not []", () => {
    insertRequest("r6", "s6", JSON.stringify({ request_id: "r6", summary: "Pick one", options: [1, null, "Keep me"] }));
    const [row] = queryQ1(db);
    expect(row?.options).toEqual(["Keep me"]);

    insertRequest("r7", "s7", JSON.stringify({ request_id: "r7", summary: "Pick one", options: [1, null] }));
    const row7 = queryQ1(db).find((r) => r.request_uid === "r7");
    expect(row7?.options).toBeNull();
  });
});
