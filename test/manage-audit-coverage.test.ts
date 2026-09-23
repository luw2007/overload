import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureControlSchema } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { createDiscoveredWork, bindExecution, one, all, addInputs, updateCursor } from "../src/manage/store";
import { detectRuntimeFromPath, sessionDirs } from "../src/manage/readers/types";
import { showWork, setTracking } from "../src/manage/manage";
import { aliasWork } from "../src/manage/relations";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureMgmtSchema(db);
  return db;
}

describe("MAN-12 bindExecution idempotency", () => {
  test("same stableId+writerId returns the same execution_id without duplicating rows", () => {
    const db = fixture();
    const work = createDiscoveredWork(db, "local:pi:seed", "seed", 1);
    const a = bindExecution(db, { workId: work, stableId: "local:pi:seed", writerId: "wr", agent: "pi", cwd: "/repo", coverage: "ledger_full", state: "running", startedAt: 1, observedAt: 1, evidence: {} });
    const b = bindExecution(db, { workId: work, stableId: "local:pi:seed", writerId: "wr", agent: "pi", cwd: "/repo", coverage: "ledger_full", state: "running", startedAt: 1, observedAt: 1, evidence: {} });
    expect(a).toBe(b);
    expect((db.query("SELECT count(*) n FROM mgmt_executions WHERE execution_id=?").get(a) as any).n).toBe(1);
    expect((db.query("SELECT count(*) n FROM mgmt_session_binding WHERE stable_id='local:pi:seed'").get() as any).n).toBe(1);
    db.close();
  });
});

describe("MAN-18 detectRuntimeFromPath", () => {
  test("recognizes pi, omp, claude roots and returns null elsewhere", () => {
    expect(detectRuntimeFromPath("/home/me/.pi/agent/sessions/x.jsonl")).toBe("pi");
    expect(detectRuntimeFromPath("/home/me/.omp/agent/sessions/y.jsonl")).toBe("omp");
    expect(detectRuntimeFromPath("/home/me/.claude/projects/z.jsonl")).toBe("claude");
    expect(detectRuntimeFromPath("/home/me/.config/other/x.jsonl")).toBeNull();
  });
});

describe("MAN-19 sessionDirs", () => {
  test("resolves pi, omp, and claude directories under home", () => {
    expect(sessionDirs("pi", "/home/me")).toEqual(["/home/me/.pi/agent/sessions"]);
    expect(sessionDirs("omp", "/home/me")).toEqual(["/home/me/.omp/agent/sessions"]);
    expect(sessionDirs("claude", "/home/me")).toEqual(["/home/me/.claude/projects"]);
  });
});

describe("MAN-34 showWork detail graph", () => {
  test("returns null for unknown work and expands every relation bucket for a known work", () => {
    const db = fixture();
    expect(showWork(db, "missing")).toBeNull();
    const work = createDiscoveredWork(db, "local:pi:seed", "seed", 1);
    bindExecution(db, { workId: work, stableId: "local:pi:seed", writerId: "wr", agent: "pi", cwd: "/repo", coverage: "ledger_full", state: "ended_ok", startedAt: 1, observedAt: 1, evidence: {} });
    const detail = showWork(db, work);
    expect(detail).not.toBeNull();
    expect(detail?.canonical_work_id).toBe(work);
    expect(Array.isArray(detail?.scope_work_ids)).toBe(true);
    expect(Array.isArray(detail?.aliases)).toBe(true);
    expect(Array.isArray(detail?.hints)).toBe(true);
    expect(Array.isArray(detail?.executions)).toBe(true);
    expect((detail?.executions as any[])).toHaveLength(1);
    expect(Array.isArray(detail?.inputs)).toBe(true);
    expect(Array.isArray(detail?.artifacts)).toBe(true);
    expect(Array.isArray(detail?.links)).toBe(true);
    expect(Array.isArray(detail?.handoffs)).toBe(true);
    expect(Array.isArray(detail?.attention)).toBe(true);
    db.close();
  });
});

describe("MAN-35 setTracking guards", () => {
  test("rejects an aliased work and an unknown work", () => {
    const db = fixture();
    const canonical = createDiscoveredWork(db, "local:pi:canonical", "canonical", 1);
    const alias = createDiscoveredWork(db, "local:pi:alias", "alias", 1);
    aliasWork(db, alias, canonical, { actor: "owner", reason: "dup", now: 2 });
    expect(() => setTracking(db, alias, false)).toThrow(/aliased_work/);
    expect(() => setTracking(db, "does-not-exist", true)).toThrow(/not found/);
    setTracking(db, canonical, false);
    expect(db.query("SELECT track_state FROM mgmt_work_profile WHERE work_id=?").get(canonical)).toEqual({ track_state: "paused" });
    db.close();
  });
});

describe("MAN-09/MAN-10 one/all query helpers", () => {
  test("one returns a single row or null, all returns every row", () => {
    const db = fixture();
    const work = createDiscoveredWork(db, "local:pi:seed", "seed", 1);
    bindExecution(db, { workId: work, stableId: "local:pi:seed", writerId: "wr", agent: "pi", cwd: "/repo", coverage: "ledger_full", state: "ended_ok", startedAt: 1, observedAt: 1, evidence: {} });
    expect(one(db, "SELECT work_id FROM mgmt_work_profile WHERE work_id=?", work)).toEqual({ work_id: work });
    expect(one(db, "SELECT work_id FROM mgmt_work_profile WHERE work_id=?", "missing")).toBeNull();
    const rows = all(db, "SELECT work_id FROM mgmt_work_profile");
    expect(rows).toHaveLength(1);
    db.close();
  });
});

describe("MAN-13 addInputs versioning and supersedes", () => {
  test("increments version, chains supersedes, and returns added count", () => {
    const db = fixture();
    const work = createDiscoveredWork(db, "local:pi:seed", "seed", 1);
    const eid = bindExecution(db, { workId: work, stableId: "local:pi:seed", writerId: "wr", agent: "pi", cwd: "/repo", coverage: "ledger_full", state: "running", startedAt: 1, observedAt: 1, evidence: {} });
    const added = addInputs(db, work, eid, [{ at: 1, text: "hello", lineNo: 1 }, { at: 2, text: "world", lineNo: 2 }], "source", 3);
    expect(added).toBe(2);
    const rows = db.query("SELECT version, supersedes FROM mgmt_inputs ORDER BY version").all() as any[];
    expect(rows[0].version).toBe(1);
    expect(rows[0].supersedes).toBeNull();
    expect(rows[1].version).toBe(2);
    expect(rows[1].supersedes).not.toBeNull();
    db.close();
  });
});

describe("MAN-14 updateCursor idempotent upsert", () => {
  test("inserts on first call and updates cursor/status on conflict", () => {
    const db = fixture();
    updateCursor(db, "host:pi:dir", { byte: 10 }, "ok", 1);
    expect(one(db, "SELECT cursor, failures, last_status FROM mgmt_cursors WHERE source_key=?", "host:pi:dir")).toEqual({ cursor: '{"byte":10}', failures: 0, last_status: "ok" });
    updateCursor(db, "host:pi:dir", { byte: 20 }, "ok", 2);
    expect(one(db, "SELECT cursor FROM mgmt_cursors WHERE source_key=?", "host:pi:dir")).toEqual({ cursor: '{"byte":20}' });
    expect((db.query("SELECT count(*) n FROM mgmt_cursors WHERE source_key=?").get("host:pi:dir") as any).n).toBe(1);
    db.close();
  });
});
