import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureControlSchema, ControlError } from "../src/control/store";
import { bindExecution, createDiscoveredWork } from "../src/manage/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import { aliasWork } from "../src/manage/relations";
import type { SourceFs } from "../src/manage/source";
import {
 computeManifest,
 insertManifest,
 invalidateAcceptances,
 manifestDigest,
 recordAcceptance,
 requestAcceptance,
 type ManifestInput,
} from "../src/manage/manifest";

function fixture() {
 const db = new Database(":memory:");
 db.exec("PRAGMA foreign_keys=ON");
 ensureControlSchema(db);
 ensureMgmtSchema(db);
 return db;
}
function version(
 db: Database,
 work: string,
 artifact: string,
 vid: string,
 at: number,
 producer="x",
) {
 db
  .query("INSERT OR IGNORE INTO mgmt_artifacts VALUES(?,?, 'file',?,?,?)")
  .run(artifact, work, artifact, artifact, at);
 db
  .query(
   "INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_state,producer,observed_at) VALUES(?,?,'content',?,'reference_only',?,?)",
  )
  .run(vid, artifact, vid, producer, at);
}
const input = (
 work: string,
 entries: { artifact_id: string; version_id: string }[],
): ManifestInput => ({
 work_id: work,
 repo_root: "/r",
 git_head: "h",
 git_tree_sha: "t",
 base_ref: "main",
 base_sha: "b",
 entries,
 verification: [{ kind: "test", at: 1, evidence_sha256: "e" }],
});

describe("management manifests", () => {
 test("digest canonicalizes sets and covers facts", () => {
  const a = input("w", [
    { artifact_id: "b", version_id: "2" },
    { artifact_id: "a", version_id: "1" },
   ]),
   b = {
    ...a,
    entries: [...a.entries].reverse(),
    verification: [...a.verification],
   };
  expect(manifestDigest(a)).toBe(manifestDigest(b));
  for (const changed of [
   { ...a, git_head: "x" },
   { ...a, base_sha: "x" },
   { ...a, entries: [{ artifact_id: "b", version_id: "3" }] },
   {
    ...a,
    verification: [{ kind: "test" as const, at: 1, evidence_sha256: "x" }],
   },
  ])
   expect(manifestDigest(changed)).not.toBe(manifestDigest(a));
 });
 test("insert validates ownership and is idempotent", () => {
  const db = fixture(),
   w = createDiscoveredWork(db, "w", "w", 1),
   foreign = createDiscoveredWork(db, "f", "f", 1);
  version(db, w, "a", "v", 1);
  version(db, foreign, "x", "z", 1);
  const m = input(w, [{ artifact_id: "a", version_id: "v" }]);
  expect(insertManifest(db, m, "me", 2).created).toBe(true);
  expect(insertManifest(db, m, "me", 3).created).toBe(false);
  expect(() =>
   insertManifest(
    db,
    input(w, [{ artifact_id: "a", version_id: "z" }]),
    "me",
    2,
   ),
  ).toThrow(ControlError);
  expect(() =>
   insertManifest(
    db,
    input(w, [{ artifact_id: "x", version_id: "z" }]),
    "me",
    2,
   ),
  ).toThrow(ControlError);
 });

 test("canonical manifest includes direct aliases and rejects alias or outsiders", async () => {
  const db=fixture(),canonical=createDiscoveredWork(db,"canonical","canonical",1),alias=createDiscoveredWork(db,"alias","alias",1),outsider=createDiscoveredWork(db,"outsider","outsider",1);
  bindExecution(db,{workId:canonical,stableId:"s",writerId:"w",agent:"pi",cwd:"/r",coverage:"ledger_full",state:"done",startedAt:1,observedAt:1,evidence:{repo_root:"/r"}});
  version(db,canonical,"a","v1",1);version(db,alias,"b","v2",1);version(db,outsider,"x","v3",1);
  aliasWork(db,alias,canonical,{actor:"owner",reason:"duplicate",now:2});
  const fs={exec:async(_cwd:string,argv:string[])=>({code:0,stdout:argv.at(-1)==="HEAD^{tree}"?"tree\n":"head\n",stderr:""})} as SourceFs;
  const computed=await computeManifest(db,fs,alias,{verification:[]});
  expect(computed.work_id).toBe(canonical);expect(computed.entries).toEqual([{artifact_id:"a",version_id:"v1"},{artifact_id:"b",version_id:"v2"}]);
  expect(insertManifest(db,computed,"owner",3).created).toBe(true);
  const accepted=recordAcceptance(db,insertManifest(db,computed,"owner",3).manifest_id,"accepted","owner",{},3);
  version(db,canonical,"canonical-b","v4",4);db.query("UPDATE mgmt_artifacts SET canonical_key='b' WHERE artifact_id='canonical-b'").run();
  const shadowed=await computeManifest(db,fs,canonical,{verification:[]});expect(shadowed.entries).toEqual([{artifact_id:"a",version_id:"v1"},{artifact_id:"canonical-b",version_id:"v4"}]);expect(invalidateAcceptances(db,canonical,"scope_drift",4)).toBe(1);expect(db.query("SELECT invalidated_reason FROM mgmt_acceptances WHERE acceptance_id=?").get(accepted.acceptance_id)).toEqual({invalidated_reason:"scope_drift"});
  expect(()=>insertManifest(db,input(alias,[{artifact_id:"b",version_id:"v2"}]),"owner",3)).toThrow("manifest work_id must be canonical");
  expect(()=>insertManifest(db,input(canonical,[{artifact_id:"x",version_id:"v3"}]),"owner",3)).toThrow("manifest entry does not belong to work artifact");
 });
 test("canonical manifest rejects artifacts produced on multiple hosts", async()=>{const db=fixture(),canonical=createDiscoveredWork(db,"multi-canonical","canonical",1),alias=createDiscoveredWork(db,"multi-alias","alias",1);const local=bindExecution(db,{workId:canonical,stableId:"local:pi:c",writerId:"w",agent:"pi",cwd:"/r",coverage:"ledger_full",state:"ended_ok",startedAt:1,observedAt:1,evidence:{repo_root:"/r",host:"local"}}),remote=bindExecution(db,{workId:alias,stableId:"ssh:pi:a",writerId:"w",agent:"pi",cwd:"/r",coverage:"ledger_full",state:"ended_ok",startedAt:1,observedAt:1,evidence:{repo_root:"/r",host:"ssh"}});version(db,canonical,"local-artifact","local-version",1,local);version(db,alias,"remote-artifact","remote-version",1,remote);aliasWork(db,alias,canonical,{actor:"owner",reason:"duplicate",now:2});const fs={exec:async()=>({code:0,stdout:"head\n",stderr:""})} as SourceFs;expect(computeManifest(db,fs,canonical,{verification:[]})).rejects.toThrow("manifest_multiple_sources:local,ssh");
 });
 test("acceptance card resolves atomically for both verdicts", () => {
  for (const verdict of ["accepted", "rejected"] as const) {
   const db = fixture(),
    w = createDiscoveredWork(db, verdict, verdict, 1);
   version(db, w, "a", "v", 1);
   const { manifest_id } = insertManifest(
    db,
    input(w, [{ artifact_id: "a", version_id: "v" }]),
    "me",
    2,
   );
   const { item_id } = requestAcceptance(db, manifest_id, 3);
   requestAcceptance(db, manifest_id, 4);
   expect(
    (
     db
      .query(
       "SELECT count(*) n FROM control_attention WHERE item_id=? AND state='open'",
      )
      .get(item_id) as any
    ).n,
   ).toBe(1);
   recordAcceptance(db, manifest_id, verdict, "owner", { ok: true }, 5);
   expect(
    (
     db
      .query("SELECT state FROM control_attention WHERE item_id=?")
      .get(item_id) as any
    ).state,
   ).toBe("resolved");
   expect(
    (db.query("SELECT verdict FROM mgmt_acceptances").get() as any).verdict,
   ).toBe(verdict);
  }
 });
 test("new artifact version invalidates only related acceptance", () => {
  const db = fixture(),
   w = createDiscoveredWork(db, "w", "w", 1),
   other = createDiscoveredWork(db, "o", "o", 1);
  version(db, w, "a", "v1", 1);
  version(db, other, "b", "x1", 1);
  const m = insertManifest(
    db,
    input(w, [{ artifact_id: "a", version_id: "v1" }]),
    "me",
    2,
   ).manifest_id,
   om = insertManifest(
    db,
    input(other, [{ artifact_id: "b", version_id: "x1" }]),
    "me",
    2,
   ).manifest_id;
  requestAcceptance(db, m, 3);
  recordAcceptance(db, m, "accepted", "owner", {}, 4);
  recordAcceptance(db, om, "accepted", "owner", {}, 4);
  version(db, w, "a", "v2", 5);
  expect(invalidateAcceptances(db, w, "changed", 6)).toBe(1);
  expect(
   (
    db
     .query(
      "SELECT invalidated_reason FROM mgmt_acceptances WHERE manifest_id=?",
     )
     .get(m) as any
   ).invalidated_reason,
  ).toBe("changed");
  expect(
   (
    db
     .query("SELECT invalidated_at FROM mgmt_acceptances WHERE manifest_id=?")
     .get(om) as any
   ).invalidated_at,
  ).toBeNull();
 });
});
