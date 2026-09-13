import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { ensureControlSchema } from "../src/control/store";
import { manifestDigest, type ManifestInput } from "../src/manage/manifest";
import { submitAcceptance } from "../src/manage/submit";
import type { SourceFs } from "../src/manage/source";

const bytes = new TextEncoder().encode("artifact"),
 sha = createHash("sha256").update(bytes).digest("hex");
function setup(git = false) {
 const db = new Database(":memory:");
 ensureControlSchema(db);
 db.exec("PRAGMA foreign_keys=ON");
 db
  .query("INSERT INTO control_works VALUES (?,?,?,?,?,?,?,?,?)")
  .run("w", "work", "test", "w", "active", 0, null, 1, 1);
 db
  .query(
   "INSERT INTO mgmt_work_profile(work_id,origin_mode,closeout_owner,track_state,decision_owner,discovered_title,updated_at) VALUES ('w','discovered','mgmt','tracking','owner','work',1)",
  )
  .run();
 db
  .query("INSERT INTO mgmt_artifacts VALUES (?,?,?,?,?,?)")
  .run("a", "w", "file", "/repo/a.txt", "/repo/a.txt", 1);
 db
  .query(
   "INSERT INTO mgmt_artifact_versions(version_id,artifact_id,content_kind,content_sha256,snapshot_state,producer,observed_at) VALUES ('v','a','content',?,'reference_only','e',1)",
  )
  .run(sha);
 const input: ManifestInput = {
   work_id: "w",
   repo_root: git ? "/repo" : null,
   git_head: git ? "head" : null,
   git_tree_sha: git ? "tree" : null,
   base_ref: null,
   base_sha: null,
   entries: [{ artifact_id: "a", version_id: "v" }],
   verification: [],
  },
  manifest = manifestDigest(input);
 db
  .query("INSERT INTO mgmt_manifests VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(
   manifest,
   "w",
   input.repo_root,
   input.git_head,
   input.git_tree_sha,
   null,
   null,
   "[]",
   "tester",
   1,
  );
 db
  .query("INSERT INTO mgmt_manifest_entries VALUES (?,?,?)")
  .run(manifest, "a", "v");
 db
  .query("INSERT INTO mgmt_acceptances VALUES (?,?,?,?,?,?,?,?)")
  .run("accept", "w", manifest, "accepted", "owner", "accepted", null, null);
 const fs: SourceFs = {
  host: { host: "local", kind: "local" },
  listFiles: async () => [],
  readRange: async () => null,
  readFile: async (path) =>
   path === "/repo/a.txt" ? { bytes, truncated: false, sha256: sha } : null,
  exec: async (_cwd, argv) =>
   git
    ? {
       code: 0,
       stdout: `${argv.at(-1) === "HEAD" ? "head" : argv.at(-1) === "HEAD^{tree}" ? "tree" : "feature/e2e"}\n`,
       stderr: "",
      }
    : { code: 1, stdout: "", stderr: "" },
 };
 return { db, input, fs, manifest };
}

describe("management submission gates", () => {
 test("unsupported targets create one idempotent manual submission", async () => {
  const { db, input, fs } = setup();
  const first = await submitAcceptance(
   db,
   fs,
   "accept",
   { target_kind: "gitlab_mr", target: "main" },
   { recompute: async () => input, now: 2 },
  );
  const second = await submitAcceptance(
   db,
   fs,
   "accept",
   { target_kind: "gitlab_mr", target: "main" },
   { recompute: async () => input, now: 3 },
  );
  expect(first.state).toBe("unsupported");
  expect(first.steps).toEqual([
   { message: "需要人工发布", snapshot_paths: [] },
  ]);
  expect(second.submission_id).toBe(first.submission_id);
  expect(
   (db.query("SELECT count(*) n FROM mgmt_submissions").get() as { n: number })
    .n,
  ).toBe(1);
 });
 test("invalidated acceptance returns manifest drift with its reason", async () => {
  const { db, input, fs, manifest } = setup();
  db
   .query(
    "UPDATE mgmt_acceptances SET invalidated_at=2,invalidated_reason='new_artifact_version' WHERE acceptance_id='accept'",
   )
   .run();
  const changed = {
   ...input,
   entries: [{ artifact_id: "a", version_id: "new" }],
  };
  try {
   await submitAcceptance(
    db,
    fs,
    "accept",
    { target_kind: "gitlab_mr", target: "main" },
    { recompute: async () => changed },
   );
   throw new Error("expected rejection");
  } catch (error) {
   expect((error as Error).message).toBe("manifest_drift");
   expect(
    (error as { data: { expected: string; diff: unknown[] } }).data.expected,
   ).toBe(manifest);
   expect(
    (error as { data: { diff: unknown[] } }).data.diff.length,
   ).toBeGreaterThan(0);
   expect(
    (error as { data: { invalidated_reason: string } }).data.invalidated_reason,
   ).toBe("new_artifact_version");
  }
 });
 test("push failure records a failed submission with unknown push effect", async () => {
  const { db, input, fs } = setup(true);
  const result = await submitAcceptance(
   db,
   fs,
   "accept",
   { target_kind: "github_pr", target: "main" },
   {
    recompute: async () => input,
    executor: async (_command, args) =>
     args[0] === "push"
      ? { ok: false, stdout: "", stderr: "push failed" }
      : {
         ok: true,
         stdout: args[0] === "rev-parse" ? "head\n" : "",
         stderr: "",
        },
   },
  );
  expect(result.state).toBe("failed");
  expect(result.external_ref).toBeNull();
  expect(
   (
    db
     .query("SELECT state FROM mgmt_external_effects WHERE kind='git_push'")
     .get() as { state: string }
   ).state,
  ).toBe("unknown");
 });
 test("unknown effects remain blocked and create one no-option attention card", async () => {
  const { db, input, fs } = setup();
  db
   .query(
    "INSERT INTO mgmt_external_effects(effect_id,work_id,kind,target,idempotency_key,state,evidence_ref,observed_at) VALUES ('x','w','other','target','k','unknown','e',1)",
   )
   .run();
  for (let i = 0; i < 2; i++)
   await expect(
    submitAcceptance(
     db,
     fs,
     "accept",
     { target_kind: "gitlab_mr", target: "main" },
     { recompute: async () => input, now: 2 },
    ),
   ).rejects.toThrow("effects_unknown");
  const card = db
   .query(
    "SELECT options FROM control_attention WHERE item_id='mgmt:effects:w:unknown'",
   )
   .get() as { options: string };
  expect(card.options).toBe("[]");
  expect(
   (
    db
     .query(
      "SELECT count(*) n FROM control_attention WHERE item_id='mgmt:effects:w:unknown'",
     )
     .get() as { n: number }
   ).n,
  ).toBe(1);
 });
});
