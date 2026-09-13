import type { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { ControlError } from "../control/store";
import { checkPr } from "../orchestrator/pr";
import {
 defaultCommandExecutor,
 type CommandExecutor,
} from "../orchestrator/worktree";
import { submitBranch } from "../orchestrator/submit";
import { manifestDigest, type ManifestInput } from "./manifest";
import type { SourceFs } from "./source";

export type SubmitTarget =
 | { target_kind: "github_pr"; target: string }
 | { target_kind: string; target: string };
type State = "pending" | "pushed" | "pr_created" | "failed" | "unsupported";
type Result = {
 submission_id: string;
 state: State;
 external_ref: string | null;
 steps: unknown[];
};
type Snapshot = {
 acceptance_id: string;
 work_id: string;
 manifest_id: string;
 verdict: string;
 invalidated_at: number | null;
 invalidated_reason: string | null;
 evidence: string;
 repo_root: string | null;
 git_head: string | null;
 base_ref: string | null;
 base_sha: string | null;
 verification: string;
 entries: Array<{
  artifact_id: string;
  version_id: string;
  content_sha256: string;
  snapshot_path: string | null;
  snapshot_state: string;
  path: string | null;
 }>;
};

function hash(value: string) {
 return createHash("sha256").update(value).digest("hex");
}
function conflict(cause: string, data?: unknown): never {
 const error = new ControlError("conflict", cause) as ControlError & {
  data?: unknown;
 };
 error.data = data;
 throw error;
}
function json(value: string): any {
 try {
  return JSON.parse(value);
 } catch {
  return [];
 }
}
function parseResult(row: {
 submission_id: string;
 state: State;
 external_ref: string | null;
 steps: string;
}): Result {
 return { ...row, steps: json(row.steps) };
}

export async function submitAcceptance(
 db: Database,
 fs: SourceFs,
 acceptanceId: string,
 target: SubmitTarget,
 opts: {
  executor?: CommandExecutor;
  title?: string;
  now?: number;
  recompute: (
   db: Database,
   fs: SourceFs,
   workId: string,
  ) => Promise<ManifestInput>;
 },
): Promise<Result> {
 const now = opts.now ?? Date.now(),
  executor = opts.executor ?? defaultCommandExecutor;
 db.exec("BEGIN IMMEDIATE");
 let snapshot: Snapshot;
 try {
  const acceptance = db
   .query(`SELECT a.acceptance_id,a.work_id,a.manifest_id,a.verdict,a.invalidated_at,a.invalidated_reason,a.evidence,m.repo_root,m.git_head,m.base_ref,m.base_sha,m.verification
   FROM mgmt_acceptances a JOIN mgmt_manifests m ON m.manifest_id=a.manifest_id WHERE a.acceptance_id=?`)
   .get(acceptanceId) as Omit<Snapshot, "entries"> | null;
  if (!acceptance || acceptance.verdict !== "accepted")
   throw new ControlError("conflict", "acceptance_not_accepted");
  const entries = db
   .query(`SELECT e.artifact_id,e.version_id,v.content_sha256,v.snapshot_path,v.snapshot_state,COALESCE(a.display_path,a.canonical_key) path
   FROM mgmt_manifest_entries e JOIN mgmt_artifact_versions v ON v.version_id=e.version_id AND v.artifact_id=e.artifact_id JOIN mgmt_artifacts a ON a.artifact_id=e.artifact_id WHERE e.manifest_id=? ORDER BY e.artifact_id`)
   .all(acceptance.manifest_id) as Snapshot["entries"];
  snapshot = { ...acceptance, entries };
  db.exec("COMMIT");
 } catch (error) {
  db.exec("ROLLBACK");
  throw error;
 }
 const drift = (data: unknown): never => {
  db
   .query(
    "UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason='manifest_drift' WHERE acceptance_id=? AND invalidated_at IS NULL",
   )
   .run(now, acceptanceId);
  return conflict("manifest_drift", data);
 };
 const recomputed = await opts.recompute(db, fs, snapshot.work_id);
 if (snapshot.invalidated_at !== null) {
  assertDigest(snapshot, recomputed, (data) => {
   const detail = data as { diff?: Array<Record<string, unknown>> };
   conflict("manifest_drift", {
    ...detail,
    diff: detail.diff?.map((entry) => ({
     ...entry,
     path: snapshot.entries.find(
      (item) => item.artifact_id === entry.artifact_id,
     )?.path,
    })),
    invalidated_reason: snapshot.invalidated_reason,
   });
  });
  conflict("manifest_drift", {
   expected: snapshot.manifest_id,
   recomputed: manifestDigest(recomputed),
   diff: [],
   invalidated_reason: snapshot.invalidated_reason,
  });
 }
 assertDigest(snapshot, recomputed, drift);
 for (const entry of snapshot.entries) {
  if (!entry.path)
   drift({
    expected: snapshot.manifest_id,
    recomputed: manifestDigest(recomputed),
    diff: [{ artifact_id: entry.artifact_id, reason: "path_missing" }],
   });
  const current = await fs.readFile(entry.path, Number.MAX_SAFE_INTEGER);
  if (!current || current.sha256 !== entry.content_sha256)
   drift({
    expected: snapshot.manifest_id,
    recomputed: manifestDigest(recomputed),
    diff: [
     {
      artifact_id: entry.artifact_id,
      version_id: entry.version_id,
      reason: "content_sha256",
     },
    ],
   });
  if (entry.snapshot_state === "stored" && entry.snapshot_path) {
   const stored = await fs.readFile(
    entry.snapshot_path,
    Number.MAX_SAFE_INTEGER,
   );
   if (!stored || stored.sha256 !== entry.content_sha256)
    drift({
     expected: snapshot.manifest_id,
     recomputed: manifestDigest(recomputed),
     diff: [
      {
       artifact_id: entry.artifact_id,
       version_id: entry.version_id,
       reason: "snapshot_sha256",
      },
     ],
    });
  }
 }
 if (snapshot.repo_root) {
  const head = await fs.exec(
   snapshot.repo_root,
   ["git", "rev-parse", "HEAD"],
   5000,
  );
  if (head.code !== 0 || head.stdout.trim() !== snapshot.git_head)
   drift({
    expected: snapshot.manifest_id,
    recomputed: manifestDigest(recomputed),
    diff: [
     {
      reason: "git_head",
      expected: snapshot.git_head,
      current: head.stdout.trim(),
     },
    ],
   });
  if (snapshot.base_ref && snapshot.base_sha) {
   const base = await fs.exec(
    snapshot.repo_root,
    ["git", "rev-parse", snapshot.base_ref],
    5000,
   );
   if (base.code !== 0 || base.stdout.trim() !== snapshot.base_sha)
    drift({
     expected: snapshot.manifest_id,
     recomputed: manifestDigest(recomputed),
     diff: [
      {
       reason: "base_sha",
       expected: snapshot.base_sha,
       current: base.stdout.trim(),
      },
     ],
    });
  }
 }
 const key = hash(snapshot.manifest_id + target.target_kind + target.target),
  existing = db
   .query(
    "SELECT submission_id,state,external_ref,steps FROM mgmt_submissions WHERE idempotency_key=?",
   )
   .get(key) as {
   submission_id: string;
   state: State;
   external_ref: string | null;
   steps: string;
  } | null;
 if (existing) return parseResult(existing);
 await reconcileUnknown(db, snapshot.work_id, executor, now);
 if (
  db
   .query(
    "SELECT 1 FROM mgmt_external_effects WHERE work_id=? AND state='unknown' LIMIT 1",
   )
   .get(snapshot.work_id)
 ) {
  openEffectsCard(db, snapshot.work_id, now);
  conflict("effects_unknown");
 }
 const submissionId = randomUUID(),
  snapshotPaths = snapshot.entries.map((e) => e.snapshot_path).filter(Boolean);
 if (target.target_kind !== "github_pr" || !snapshot.repo_root) {
  const steps = [{ message: "需要人工发布", snapshot_paths: snapshotPaths }];
  insertSubmission(
   db,
   submissionId,
   snapshot,
   target,
   key,
   "unsupported",
   steps,
   null,
  );
  return {
   submission_id: submissionId,
   state: "unsupported",
   external_ref: null,
   steps,
  };
 }
 const latest = await opts.recompute(db, fs, snapshot.work_id);
 assertDigest(snapshot, latest, drift);
 const branchResult = await fs.exec(
  snapshot.repo_root,
  ["git", "rev-parse", "--abbrev-ref", "HEAD"],
  5000,
 );
 if (branchResult.code !== 0)
  conflict("manifest_drift", {
   expected: snapshot.manifest_id,
   recomputed: manifestDigest(latest),
   diff: [{ reason: "git_branch" }],
  });
 const artifactsDir = join(
   homedir(),
   ".overload",
   "artifacts",
   snapshot.work_id,
  ),
  bodyFile = join(artifactsDir, "pr-body.md");
 await mkdir(artifactsDir, { recursive: true, mode: 0o700 });
 await writeFile(bodyFile, snapshot.evidence, { mode: 0o600 });
 insertSubmission(db, submissionId, snapshot, target, key, "pending", [], null);
 const submitted = await submitBranch({
  cwd: snapshot.repo_root,
  branch: branchResult.stdout.trim(),
  base_ref: target.target,
  title: opts.title ?? `Submit ${snapshot.work_id}`,
  bodyFile,
  artifactsDir,
  executor,
 });
 const state: State = submitted.ok
   ? "pr_created"
   : submitted.effects.push === "confirmed"
     ? "pushed"
     : "failed",
  externalRef = submitted.ok ? submitted.prUrl : null;
 db
  .query(
   "UPDATE mgmt_submissions SET state=?,steps=?,external_ref=? WHERE submission_id=?",
  )
  .run(state, JSON.stringify(submitted.steps), externalRef, submissionId);
 recordEffects(
  db,
  snapshot.work_id,
  submissionId,
  key,
  branchResult.stdout.trim(),
  snapshot.git_head,
  externalRef,
  submitted,
  now,
 );
 return {
  submission_id: submissionId,
  state,
  external_ref: externalRef,
  steps: submitted.steps,
 };
}

function assertDigest(
 snapshot: Snapshot,
 recomputed: ManifestInput,
 fail: (data: unknown) => never,
) {
 const digest = manifestDigest(recomputed);
 if (digest === snapshot.manifest_id) return;
 const expected = new Map(
   snapshot.entries.map((e) => [e.artifact_id, e.version_id]),
  ),
  actual = new Map(
   recomputed.entries.map((e) => [e.artifact_id, e.version_id]),
  );
 const diff = [...new Set([...expected.keys(), ...actual.keys()])]
  .filter((id) => expected.get(id) !== actual.get(id))
  .map((artifact_id) => ({
   artifact_id,
   expected: expected.get(artifact_id),
   current: actual.get(artifact_id),
  }));
 if (snapshot.git_head !== recomputed.git_head)
  diff.push({
   artifact_id: "git_head",
   expected: snapshot.git_head ?? undefined,
   current: recomputed.git_head ?? undefined,
  });
 if (snapshot.base_sha !== recomputed.base_sha)
  diff.push({
   artifact_id: "base_sha",
   expected: snapshot.base_sha ?? undefined,
   current: recomputed.base_sha ?? undefined,
  });
 if (snapshot.verification !== JSON.stringify(recomputed.verification))
  diff.push({
   artifact_id: "verification",
   expected: snapshot.verification,
   current: JSON.stringify(recomputed.verification),
  });
 fail({ expected: snapshot.manifest_id, recomputed: digest, diff });
}
function insertSubmission(
 db: Database,
 id: string,
 s: Snapshot,
 t: SubmitTarget,
 key: string,
 state: State,
 steps: unknown[],
 ref: string | null,
) {
 db
  .query("INSERT INTO mgmt_submissions VALUES (?,?,?,?,?,?,?,?,?,?)")
  .run(
   id,
   s.acceptance_id,
   s.manifest_id,
   t.target_kind,
   t.target,
   state,
   JSON.stringify(steps),
   ref,
   s.manifest_id,
   key,
  );
}

async function reconcileUnknown(
 db: Database,
 workId: string,
 executor: CommandExecutor,
 now: number,
) {
 const rows = db
  .query(
   `SELECT e.effect_id,e.kind,e.target,m.git_head FROM mgmt_external_effects e LEFT JOIN mgmt_submissions s ON s.submission_id=e.evidence_ref LEFT JOIN mgmt_manifests m ON m.manifest_id=s.manifest_id WHERE e.work_id=? AND e.state='unknown'`,
  )
  .all(workId) as Array<{
  effect_id: string;
  kind: string;
  target: string;
  git_head: string | null;
 }>;
 for (const row of rows) {
  let state = "unknown";
  if (row.kind === "git_push") {
   const r = await executor("git", [
    "ls-remote",
    "--heads",
    "origin",
    row.target,
   ]);
   if (r.ok)
    state =
     r.stdout.trim().split(/\s+/)[0] === row.git_head
      ? "confirmed"
      : "superseded";
  } else if (row.kind === "gh_pr") {
   const r = await executor("gh", [
    "pr",
    "list",
    "--head",
    row.target,
    "--json",
    "url",
    "--limit",
    "1",
   ]);
   if (r.ok) state = json(r.stdout)[0]?.url ? "confirmed" : "observed";
  }
  db
   .query(
    "UPDATE mgmt_external_effects SET state=?,reconciled_at=? WHERE effect_id=?",
   )
   .run(state, now, row.effect_id);
 }
}
function openEffectsCard(db: Database, workId: string, now: number) {
 const work = db
  .query("SELECT revision FROM control_works WHERE work_id=?")
  .get(workId) as { revision: number };
 const owner = (
  db
   .query("SELECT decision_owner FROM mgmt_work_profile WHERE work_id=?")
   .get(workId) as { decision_owner: string }
 ).decision_owner;
 db
  .query(
   `INSERT OR IGNORE INTO control_attention(item_id,work_id,revision,state,effect_state,urgency,conclusion,trigger,impact,recommendation,options,owner,contract_revision,decision_mode,evidence,created_at,updated_at) VALUES (?,?,?,'open','unknown','now','外部效果未知','提交前发现未确认的外部副作用','继续提交可能重复执行外部副作用','先人工核对远端状态','[]',?,?, 'human_only','{}',?,?)`,
  )
  .run(
   `mgmt:effects:${workId}:unknown`,
   workId,
   work.revision,
   owner,
   work.revision,
   now,
   now,
  );
}
function recordEffects(
 db: Database,
 workId: string,
 submissionId: string,
 key: string,
 branch: string,
 _sha: string | null,
 _prUrl: string | null,
 result: Awaited<ReturnType<typeof submitBranch>>,
 now: number,
) {
 const pushState = result.effects.push,
  prState = result.effects.pr;
 db
  .query(
   "INSERT INTO mgmt_external_effects(effect_id,work_id,kind,target,idempotency_key,state,evidence_ref,reconcile_cmd,observed_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
  .run(
   randomUUID(),
   workId,
   "git_push",
   branch,
   key + ":push",
   pushState,
   submissionId,
   `git ls-remote --heads origin ${branch}`,
   now,
  );
 db
  .query(
   "INSERT INTO mgmt_external_effects(effect_id,work_id,kind,target,idempotency_key,state,evidence_ref,reconcile_cmd,observed_at) VALUES (?,?,?,?,?,?,?,?,?)",
  )
  .run(
   randomUUID(),
   workId,
   "gh_pr",
   branch,
   key + ":pr",
   prState,
   submissionId,
   `gh pr list --head ${branch}`,
   now,
  );
}

export async function pollSubmissions(
 db: Database,
 opts: { executor?: CommandExecutor; now?: number } = {},
): Promise<{ checked: number; merged: number; failed_observations: number }> {
 const executor = opts.executor ?? defaultCommandExecutor,
  rows = db
   .query(
    "SELECT submission_id,external_ref,steps FROM mgmt_submissions WHERE state='pr_created'",
   )
   .all() as Array<{
   submission_id: string;
   external_ref: string;
   steps: string;
  }>;
 let merged = 0,
  failed = 0;
 for (const row of rows) {
  const status = await checkPr(row.external_ref, executor);
  if (status.status === "merged") {
   db
    .query("UPDATE mgmt_submissions SET state='merged' WHERE submission_id=?")
    .run(row.submission_id);
   merged++;
  } else if (status.status === "observation_failed") {
   const steps = json(row.steps),
    last = steps.at(-1);
   if (last?.kind === "pr_observation_failure") last.count++;
   else
    steps.push({
     kind: "pr_observation_failure",
     count: 1,
     at: opts.now ?? Date.now(),
    });
   db
    .query("UPDATE mgmt_submissions SET steps=? WHERE submission_id=?")
    .run(JSON.stringify(steps), row.submission_id);
   failed++;
  }
 }
 return { checked: rows.length, merged, failed_observations: failed };
}
