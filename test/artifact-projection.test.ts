import { describe, expect, test, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureControlSchema, createWork } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { projectArtifactVersions } from "../src/control/artifact-projection";
import {
  rootProblemId,
  listObjectsByProblem,
  getObjectVersion,
  objectId,
} from "../src/control/context-pool";
import { fetchOnDemand, clearFetchCache } from "../src/control/on-demand-fetcher";
import { getContextPackage } from "../src/control/context-assembler";
import { makeTempDir, cleanupTempDir } from "./lib/util";

function fixture(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureMgmtSchema(db);
  return db;
}

function setupWork(db: Database, workId: string): string {
  const work = createWork(
    db,
    {
      title: workId,
      source: "test",
      source_id: workId,
      contract: {
        objective: "do " + workId,
        acceptance: [{ id: "a1", kind: "check", description: "x" }],
        non_goals: [],
        scope: { repo: "/r" },
        budget: {},
        stop_conditions: [],
        decision_owner: "owner",
      },
      candidate: false,
    },
    1,
  );
  db.query(
    `INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at)
     VALUES(?,'discovered','mgmt','tracking','owner',?,1)`,
  ).run(work.work_id, workId);
  return work.work_id;
}

type VersionOpts = {
  state: string;
  sensitivity?: string;
  sha?: string;
  snapshotPath?: string | null;
  observedAt?: number;
};

function insertVersion(
  db: Database,
  workId: string,
  aid: string,
  vid: string,
  opts: VersionOpts,
): void {
  db.query(
    "INSERT OR IGNORE INTO mgmt_artifacts(artifact_id,work_id,kind,canonical_key,display_path,created_at) VALUES(?,?,'file',?,?,?)",
  ).run(aid, workId, aid, "src/" + aid, 1);
  const sha = opts.sha ?? vid;
  db.query(
    `INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_path,snapshot_state,sensitivity,shareable,producer,observed_at)
     VALUES(?,?, 'content',?,?,?,?,0,'test',?)`,
  ).run(vid, aid, sha, opts.snapshotPath ?? null, opts.state, opts.sensitivity ?? "none", opts.observedAt ?? 1);
}

function projectedRow(db: Database, ref: string) {
  return db
    .query(
      `SELECT o.object_id, o.ctype, v.revision, v.reference, v.content_hash, v.sensitivity
       FROM control_context_objects o
       JOIN control_context_object_versions v ON v.object_id = o.object_id
       WHERE v.reference = ?`,
    )
    .get(ref) as Record<string, unknown> | null;
}

let snapshotRoot: string | null = null;

afterEach(() => {
  clearFetchCache();
  if (snapshotRoot) { cleanupTempDir(snapshotRoot); snapshotRoot = null; }
  delete process.env.OVERLOAD_SNAPSHOT_ROOT;
});

describe("artifact-projection", () => {
  test("1. stored artifact projected, linked to root problem", () => {
    const db = fixture();
    const w = setupWork(db, "p1-work");
    insertVersion(db, w, "aid1", "vid1", { state: "stored", sha: "sha1hex" });

    const result = projectArtifactVersions(db, w, 10);
    expect(result).toEqual({ projected: 1, skipped: 0 });

    const row = projectedRow(db, "artifact:aid1@vid1");
    expect(row).not.toBeNull();
    expect(row!.ctype).toBe("artifact");
    expect(row!.content_hash).toBe("sha1hex");
    expect(row!.sensitivity).toBe("clean");

    const linked = listObjectsByProblem(db, rootProblemId(w));
    expect(linked.some((e) => e.object.object_id === row!.object_id && e.role === "artifact")).toBe(true);
  });

  test("2. projected artifact appears in agent_task context package", () => {
    const db = fixture();
    const w = setupWork(db, "p2-work");
    insertVersion(db, w, "aid2", "vid2", { state: "stored", sha: "sha2hex" });
    projectArtifactVersions(db, w, 10);

    const res = getContextPackage({
      consumer_type: "agent_task",
      consumer_id: "c1",
      work_id: w,
      package_type: "agent_task",
      actor: "owner",
      purpose: "agent_task",
      db,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unexpected blocked");
    const pkg = res.package as { artifacts: { reference: string }[] };
    expect(pkg.artifacts.some((a) => a.reference === "artifact:aid2@vid2")).toBe(true);
  });

  test("3. fetch full bytes via on-demand-fetcher, sha256 matches", () => {
    const db = fixture();
    const w = setupWork(db, "p3-work");
    snapshotRoot = makeTempDir("ovl-proj");
    process.env.OVERLOAD_SNAPSHOT_ROOT = snapshotRoot;
    const body = "hello snapshot body";
    const sha = createHash("sha256").update(body).digest("hex");
    const rel = join("p3-work", "aid3", sha);
    const abs = join(snapshotRoot, rel);
    mkdirSync(abs, { recursive: true });
    const filePath = join(abs, "content");
    writeFileSync(filePath, body, { mode: 0o600 });

    insertVersion(db, w, "aid3", "vid3", { state: "stored", sha, snapshotPath: filePath });
    projectArtifactVersions(db, w, 10);

    const object_id = objectId(w, "artifact", "aid3");
    const fetched = fetchOnDemand({
      reference: "artifact:aid3@vid3",
      visibility: "full",
      actor: "owner",
      work_id: w,
      purpose: "decision_view",
      db,
      version_pin: { object_id, revision: 1 },
    });
    expect("payload" in fetched).toBe(true);
    if ("payload" in fetched) {
      expect(fetched.payload).toBe(body);
      expect(fetched.content_hash).toBe(sha);
    }
  });

  test("4. rerun is idempotent, projected=0 second time", () => {
    const db = fixture();
    const w = setupWork(db, "p4-work");
    insertVersion(db, w, "aid4", "vid4", { state: "stored", sha: "sha4hex" });

    const first = projectArtifactVersions(db, w, 10);
    expect(first.projected).toBe(1);
    const objectsBefore = (db.query("SELECT count(*) n FROM control_context_objects").get() as { n: number }).n;
    const versionsBefore = (db.query("SELECT count(*) n FROM control_context_object_versions").get() as { n: number }).n;

    const second = projectArtifactVersions(db, w, 11);
    expect(second.projected).toBe(0);
    expect((db.query("SELECT count(*) n FROM control_context_objects").get() as { n: number }).n).toBe(objectsBefore);
    expect((db.query("SELECT count(*) n FROM control_context_object_versions").get() as { n: number }).n).toBe(versionsBefore);
  });

  test("5. new mgmt version advances revision, history traceable", () => {
    const db = fixture();
    const w = setupWork(db, "p5-work");
    insertVersion(db, w, "aid5", "vid5a", { state: "stored", sha: "sha5a", observedAt: 1 });
    projectArtifactVersions(db, w, 10);

    insertVersion(db, w, "aid5", "vid5b", { state: "stored", sha: "sha5b", observedAt: 5 });
    const second = projectArtifactVersions(db, w, 11);
    expect(second.projected).toBe(1);

    const object_id = objectId(w, "artifact", "aid5");
    const v1 = getObjectVersion(db, object_id, 1);
    const v2 = getObjectVersion(db, object_id, 2);
    expect(v1?.reference).toBe("artifact:aid5@vid5a");
    expect(v1?.content_hash).toBe("sha5a");
    expect(v2?.reference).toBe("artifact:aid5@vid5b");
    expect(v2?.content_hash).toBe("sha5b");

    const linked = listObjectsByProblem(db, rootProblemId(w));
    const link = linked.find((e) => e.object.object_id === object_id);
    expect(link?.version.revision).toBe(2);
  });

  test("6. cross-work artifact not projected into this work", () => {
    const db = fixture();
    const wA = setupWork(db, "p6-workA");
    const wB = setupWork(db, "p6-workB");
    // workB 的 stored artifact：不应进入 workA 的池。
    insertVersion(db, wB, "aidB", "vidB", { state: "stored", sha: "shaB" });
    // workA 自身只有 pending 版本：应被跳过。
    insertVersion(db, wA, "aidA", "vidA", { state: "pending", sha: "shaA" });

    const result = projectArtifactVersions(db, wA, 10);
    expect(result.projected).toBe(0);
    expect(result.skipped).toBe(1);
    expect(projectedRow(db, "artifact:aidB@vidB")).toBeNull();
  });

  test("7. withheld maps to unknown, summary/full fetch blocked", () => {
    const db = fixture();
    const w = setupWork(db, "p7-work");
    insertVersion(db, w, "aid7", "vid7", { state: "stored", sha: "sha7", sensitivity: "withheld" });
    projectArtifactVersions(db, w, 10);

    const row = projectedRow(db, "artifact:aid7@vid7");
    expect(row).not.toBeNull();
    expect(row!.sensitivity).toBe("unknown");
    expect(row!.sensitivity).not.toBe("confirmed_secret");

    const object_id = objectId(w, "artifact", "aid7");
    const fetched = fetchOnDemand({
      reference: "artifact:aid7@vid7",
      visibility: "full",
      actor: "owner",
      work_id: w,
      purpose: "decision_view",
      db,
      version_pin: { object_id, revision: 1 },
    });
    expect("blocked" in fetched).toBe(true);
    if ("blocked" in fetched) expect(fetched.reason).toContain("sensitivity unknown");

    // 占位 summary 也不得进入 agent 包（visibility 层整体拦截）。
    const res = getContextPackage({
      consumer_type: "agent_task",
      consumer_id: "c1",
      work_id: w,
      package_type: "agent_task",
      actor: "owner",
      purpose: "agent_task",
      db,
    });
    if (res.ok) {
      const pkg = res.package as { artifacts: { reference: string }[] };
      expect(pkg.artifacts.some((a) => a.reference === "artifact:aid7@vid7")).toBe(false);
    }
  });

  test("8. fetch from another work is forbidden", () => {
    const db = fixture();
    const wA = setupWork(db, "p8-workA");
    const wB = setupWork(db, "p8-workB");
    snapshotRoot = makeTempDir("ovl-proj");
    process.env.OVERLOAD_SNAPSHOT_ROOT = snapshotRoot;
    const body = "cross work secret body";
    const sha = createHash("sha256").update(body).digest("hex");
    const filePath = join(snapshotRoot, "p8", "aid8", "content");
    mkdirSync(join(snapshotRoot, "p8", "aid8"), { recursive: true });
    writeFileSync(filePath, body, { mode: 0o600 });
    insertVersion(db, wA, "aid8", "vid8", { state: "stored", sha, snapshotPath: filePath });
    projectArtifactVersions(db, wA, 10);

    const object_id = objectId(wA, "artifact", "aid8");
    const fetched = fetchOnDemand({
      reference: "artifact:aid8@vid8",
      visibility: "full",
      actor: "owner",
      work_id: wB, // 跨 work
      purpose: "decision_view",
      db,
      version_pin: { object_id, revision: 1 },
    });
    expect("blocked" in fetched).toBe(true);
  });

  test("9. non-stored states skipped", () => {
    const db = fixture();
    const w = setupWork(db, "p9-work");
    const states = ["pending", "too_large", "lost", "pruned", "withheld_sensitive"];
    states.forEach((s, i) => insertVersion(db, w, `aid9-${i}`, `vid9-${i}`, { state: s, sha: "sha9-" + i }));

    const result = projectArtifactVersions(db, w, 10);
    expect(result.projected).toBe(0);
    expect(result.skipped).toBe(states.length);
    expect((db.query("SELECT count(*) n FROM control_context_objects").get() as { n: number }).n).toBe(0);
  });

  test("reference_only projects placeholder, full fetch blocked by state", () => {
    const db = fixture();
    const w = setupWork(db, "p10-work");
    insertVersion(db, w, "aid10", "vid10", { state: "reference_only", sha: "sha10" });
    const result = projectArtifactVersions(db, w, 10);
    expect(result.projected).toBe(1);
    const row = projectedRow(db, "artifact:aid10@vid10");
    expect(row).not.toBeNull();

    const object_id = objectId(w, "artifact", "aid10");
    const fetched = fetchOnDemand({
      reference: "artifact:aid10@vid10",
      visibility: "full",
      actor: "owner",
      work_id: w,
      purpose: "decision_view",
      db,
      version_pin: { object_id, revision: 1 },
    });
    // reference_only 占位对象：visibility(clean, short) 放行 short，但 full fetch 被 fetcher state 拦截。
    expect("blocked" in fetched).toBe(true);
    if ("blocked" in fetched) expect(fetched.reason).toContain("snapshot not stored");
  });
});
