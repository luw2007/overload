import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ensureControlSchema, ControlError } from "../src/control/store";
import { createDiscoveredWork } from "../src/manage/store";
import { ensureMgmtSchema } from "../src/manage/schema";
import {
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
) {
 db
  .query("INSERT OR IGNORE INTO mgmt_artifacts VALUES(?,?, 'file',?,?,?)")
  .run(artifact, work, artifact, artifact, at);
 db
  .query(
   "INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_state,producer,observed_at) VALUES(?,?,'content',?,'reference_only','x',?)",
  )
  .run(vid, artifact, vid, at);
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
