import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { ensureControlSchema, getAttention } from "../src/control/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { createDiscoveredWork } from "../src/manage/store";
import { aliasWork } from "../src/manage/relations";
import { insertManifest, invalidateAcceptances, requestAcceptance, type ManifestInput } from "../src/manage/manifest";
import { reconcileLaunches } from "../src/manage/launch";

function fixture() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  ensureControlSchema(db);
  ensureMgmtSchema(db);
  return db;
}
function version(db: Database, work: string, artifact: string, vid: string, at: number) {
  db.query("INSERT OR IGNORE INTO mgmt_artifacts VALUES(?,?, 'file',?,?,?)").run(artifact, work, artifact, artifact, at);
  db.query(
    "INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_state,producer,observed_at) VALUES(?,?,'content',?,'reference_only','x',?)",
  ).run(vid, artifact, vid, at);
}
const input = (work: string, entries: { artifact_id: string; version_id: string }[]): ManifestInput => ({
  work_id: work, repo_root: "/r", git_head: "h", git_tree_sha: "t", base_ref: "main", base_sha: "b",
  entries, verification: [{ kind: "test", at: 1 }],
});

describe("manage attention consolidation", () => {
  test("aliasWork supersedes open attention of the canonical work via Core API", () => {
    const db = fixture();
    const canonical = createDiscoveredWork(db, "canonical", "canonical", 1);
    const alias = createDiscoveredWork(db, "alias", "alias", 1);
    // 直接经 upsertAttention 开一张 canonical 下的 open 卡（contract_revision 对齐 candidate work 的 revision=1）。
    db.query(
      `INSERT INTO control_attention(item_id,work_id,revision,state,effect_state,urgency,conclusion,trigger,impact,recommendation,options,owner,contract_revision,decision_mode,evidence,created_at,updated_at)
       VALUES ('mgmt:accept:${canonical}:m1',?,1,'open','not_started','inbox','c','t','i',null,'[]','owner',1,'human_only','{}',1,1)`,
    ).run(canonical);
    aliasWork(db, alias, canonical, { actor: "owner", reason: "duplicate", now: 2 });
    const card = getAttention(db, `mgmt:accept:${canonical}:m1`)!;
    expect(card.state).toBe("superseded");
    expect(card.revision).toBe(2);
    const ev = db.query("SELECT kind,detail FROM control_attention_events WHERE item_id=? ORDER BY revision DESC LIMIT 1").get(`mgmt:accept:${canonical}:m1`) as { kind: string; detail: string };
    expect(ev.kind).toBe("superseded");
    expect(JSON.parse(ev.detail)).toMatchObject({ reason: "work_aliased", actor: "owner" });
    expect((db.query("SELECT count(*) n FROM control_outbox WHERE item_id=?").get(`mgmt:accept:${canonical}:m1`) as { n: number }).n).toBeGreaterThan(0);
    db.close();
  });

  test("invalidateAcceptances supersedes the open acceptance card via Core API", () => {
    const db = fixture();
    const w = createDiscoveredWork(db, "w", "w", 1);
    version(db, w, "a", "v1", 1);
    const manifestId = insertManifest(db, input(w, [{ artifact_id: "a", version_id: "v1" }]), "me", 2).manifest_id;
    const { item_id } = requestAcceptance(db, manifestId, 3);
    expect(getAttention(db, item_id)!.state).toBe("open");
    version(db, w, "a", "v2", 5);
    invalidateAcceptances(db, w, "artifact_version_changed", 6);
    const card = getAttention(db, item_id)!;
    expect(card.state).toBe("superseded");
    expect(card.revision).toBe(2);
    expect((db.query("SELECT count(*) n FROM control_outbox WHERE item_id=?").get(item_id) as { n: number }).n).toBeGreaterThan(0);
    db.close();
  });

  test("reconcileLaunches binds an unknown handoff card to resolved/succeeded via Core API", () => {
    const db = fixture();
    const ledger = new Database(":memory:");
    ledger.exec(readFileSync(new URL("../src/ingest/schema.sql", import.meta.url), "utf8"));
    db.query("INSERT INTO control_works VALUES ('w','work','test','w','active',1,null,1,1)").run();
    db.query("INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES ('w','discovered','mgmt','tracking','owner','work',1)").run();
    db.query("INSERT INTO mgmt_session_binding VALUES ('s','w','origin','seed',1)").run();
    db.query("INSERT INTO mgmt_executions(execution_id,work_id,stable_id,writer_id,attempt_no,exec_state,source_coverage,ledger_evidence,started_at,cwd) VALUES ('e','w','s','wr',1,'running','ledger_full','{}',1,'/tmp')").run();
    db.query("INSERT INTO mgmt_handoffs(handoff_id,work_id,source_execution_id,manifest_id,target_agent,state,packet,packet_sha256,workspace_fp,isolate) VALUES ('h1','w','e',NULL,'pi','launch_unknown','{}','x','fp',0)").run();
    db.query(
      `INSERT INTO control_attention(item_id,work_id,revision,state,effect_state,urgency,conclusion,trigger,impact,recommendation,options,owner,contract_revision,decision_mode,evidence,created_at,updated_at)
       VALUES ('mgmt:handoff:h1:unknown','w',1,'open','unknown','now','c','t','i',null,'[]','owner',1,'human_only','{}',1,1)`,
    ).run();
    ledger.query("INSERT INTO sessions(stable_id,host,runtime,session,origin,cwd,first_seen_at) VALUES ('new','local','pi','new',?,'/tmp',2)").run("mgmt:handoff:h1");

    expect(reconcileLaunches(db, ledger).bound).toBe(1);
    const card = getAttention(db, "mgmt:handoff:h1:unknown")!;
    expect(card.state).toBe("resolved");
    expect(card.effect_state).toBe("succeeded");
    expect(card.revision).toBe(2);
    const ev = db.query("SELECT kind FROM control_attention_events WHERE item_id=? ORDER BY revision DESC LIMIT 1").get("mgmt:handoff:h1:unknown") as { kind: string };
    expect(ev.kind).toBe("resolved");
    db.close();
    ledger.close();
  });
});
