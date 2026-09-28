import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { ensureControlSchema } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { stableId, artifactId, versionId, canonicalFileKey } from "../src/manage/identity";
import { id } from "../src/manage/store";
import { abandonHandoff } from "../src/manage/handoff";
import { listManifests } from "../src/manage/manifest";
import { listWorks, showWork, setTracking } from "../src/manage/manage";

function sha(parts: string[]): string {
  return createHash("sha256").update(parts.join("")).digest("hex").slice(0, 32);
}

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureMgmtSchema(db);
  db.query("INSERT INTO control_works(work_id,title,source,source_id,state,revision,contract,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run("w", "work", "discovered", "w", "active", 1, null, 1, 1);
  db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES ('w','discovered','mgmt','tracking','owner','work',1)").run();
  db.query("INSERT INTO mgmt_session_binding VALUES ('s','w','origin','seed',1)").run();
  db.query("INSERT INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,ledger_evidence,started_at,cwd) VALUES ('e','w','s','wr',1,'ended_ok','ledger_full','{}',1,'/tmp')").run();
  return db;
}

describe("identity pure functions", () => {
  test("stableId composes host:runtime:session", () => {
    expect(stableId("h1", "pi", "uuid-1")).toBe("h1:pi:uuid-1");
    expect(stableId("h2", "claude", "uuid-2")).toBe("h2:claude:uuid-2");
  });
  test("artifactId and versionId are stable 32-hea digests", () => {
    const a = artifactId("w", "file", "src/a.ts");
    expect(a).toBe(sha(["w", "file", "src/a.ts"]));
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    const v = versionId(a, "content", "deadbeef");
    expect(v).toBe(sha([a, ":", "content", ":", "deadbeef"]));
  });
  test("canonicalFileKey relativizes under root and escapes outside", () => {
    expect(canonicalFileKey("/repo", "/repo/src/a.ts")).toBe("src/a.ts");
    expect(canonicalFileKey("/repo", "/elsewhere/b.ts")).toBe("/elsewhere/b.ts");
    expect(canonicalFileKey(null, "/repo/src/a.ts")).toBe("/repo/src/a.ts");
  });
  test("store.id joins parts with colon and digests", () => {
    expect(id("a", "b", 1)).toBe(createHash("sha256").update("a:b:1", "utf8").digest("hex").slice(0, 32));
  });
});

describe("abandonHandoff", () => {
  test("abandons a non-terminal handoff and rejects empty reason", () => {
    const db = fixture();
    db.query("INSERT INTO mgmt_handoffs(handoff_id,work_id,source_execution_id,target_agent,state,packet,packet_sha256,workspace_fp,isolate) VALUES ('h','w','e','pi','ready_to_launch','{}','x','{}',0)").run();
    expect(() => abandonHandoff(db, "h", "   ")).toThrow();
    expect(abandonHandoff(db, "h", "user decided to drop it")).toBeUndefined();
    expect(db.query("SELECT state FROM mgmt_handoffs WHERE handoff_id='h'").get()).toEqual({ state: "abandoned" });
    expect(() => abandonHandoff(db, "h", "again")).toThrow();
  });
});

describe("listManifests", () => {
  test("lists manifests with entry count and null acceptance/submission", () => {
    const db = fixture();
    db.query("INSERT INTO mgmt_manifests(manifest_id,work_id,repo_root,git_head,git_tree_sha,base_ref,base_sha,verification,built_by,built_at) VALUES ('m1','w',NULL,NULL,NULL,NULL,NULL,'[]','tester',5)").run();
    const rows = listManifests(db, "w");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ manifest_id: "m1", built_at: 5, entries: 0, acceptance: null, submission: null });
  });
});

describe("works listing and tracking", () => {
  test("listWorks returns the tracked work row", () => {
    const db = fixture();
    const rows = listWorks(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ work_id: "w", track_state: "tracking" });
    expect(listWorks(db, { track: "paused" })).toHaveLength(0);
  });
  test("showWork returns detail graph for a known work", () => {
    const db = fixture();
    const detail = showWork(db, "w");
    expect(detail).not.toBeNull();
    expect(detail?.canonical_work_id).toBe("w");
    expect(Array.isArray(detail?.executions)).toBe(true);
    expect(showWork(db, "missing")).toBeNull();
  });
  test("setTracking pauses and resumes a work", () => {
    const db = fixture();
    setTracking(db, "w", false);
    expect(db.query("SELECT track_state FROM mgmt_work_profile WHERE work_id='w'").get()).toEqual({ track_state: "paused" });
    setTracking(db, "w", true);
    expect(db.query("SELECT track_state FROM mgmt_work_profile WHERE work_id='w'").get()).toEqual({ track_state: "tracking" });
  });
});
