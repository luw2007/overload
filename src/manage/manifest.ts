import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { ControlError, getWork, upsertAttention } from "../control/store";
import { ensureMgmtSchema } from "./schema";
import { canonicalWorkId, workScope } from "./relations";
import type { SourceFs } from "./source";
import { all, id, one } from "./store";

export type Verification = {
  kind: "check" | "test" | "human" | "history_gap_acknowledged";
  cmd?: string;
  exit_code?: number;
  evidence_sha256?: string;
  actor?: string;
  at: number;
};
export type ManifestInput = {
  work_id: string;
  repo_root: string | null;
  git_head: string | null;
  git_tree_sha: string | null;
  base_ref: string | null;
  base_sha: string | null;
  entries: { artifact_id: string; version_id: string }[];
  verification: Verification[];
};

const canonical = (value: unknown): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : `{${Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(",")}}`;
export function manifestDigest(input: ManifestInput): string {
  const normalized = {
    ...input,
    entries: [...input.entries].sort(
      (a, b) =>
        a.artifact_id.localeCompare(b.artifact_id) ||
        a.version_id.localeCompare(b.version_id),
    ),
    verification: [...input.verification].sort((a, b) =>
      canonical(a).localeCompare(canonical(b)),
    ),
  };
  return createHash("sha256")
    .update(canonical(normalized))
    .digest("hex")
    .slice(0, 32);
}

function evidenceFacts(raw: string | null): {
  repo_root?: string;
  base_ref?: string;
} {
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return {};
    const v = value as Record<string, unknown>;
    return {
      repo_root: typeof v.repo_root === "string" ? v.repo_root : undefined,
      base_ref: typeof v.base_ref === "string" ? v.base_ref : undefined,
    };
  } catch {
    return {};
  }
}
async function git(
  fs: SourceFs,
  cwd: string,
  args: string[],
): Promise<string | null> {
  const result = await fs.exec(cwd, ["git", ...args], 5000);
  return result.code === 0 ? result.stdout.trim() || null : null;
}
function validateManifestHosts(db:Database,entries:{version_id:string}[]):void{
  if(!entries.length)return;
  const marks=entries.map(()=>"?").join(","),hosts=new Set<string>();
  const executions=all<{stable_id:string;ledger_evidence:string|null}>(db,`SELECT DISTINCT e.stable_id,e.ledger_evidence FROM mgmt_artifact_versions v JOIN mgmt_executions e ON e.execution_id=v.producer OR EXISTS(SELECT 1 FROM mgmt_links l WHERE l.object=v.version_id AND l.subject=e.execution_id AND l.superseded_at IS NULL) WHERE v.version_id IN (${marks})`,...entries.map(x=>x.version_id));
  for(const execution of executions){let host=execution.stable_id.split(":")[0]!;try{const evidence=JSON.parse(execution.ledger_evidence??"{}");if(typeof evidence.host==="string")host=evidence.host;}catch{ /* Stable identity remains authoritative when optional evidence is malformed. */ }hosts.add(host);}
  if(hosts.size>1)throw new ControlError("conflict",`manifest_multiple_sources:${[...hosts].sort().join(",")}`);
}
export async function computeManifest(
  db: Database,
  fs: SourceFs,
  workId: string,
  opts: { verification: Verification[]; now?: number },
): Promise<ManifestInput> {
  ensureMgmtSchema(db);
  const canonicalWork = canonicalWorkId(db, workId), scope = workScope(db, canonicalWork), marks = scope.map(() => "?").join(",");
  const latest = one<{ cwd: string | null; ledger_evidence: string | null }>(
    db,
    `SELECT cwd,ledger_evidence FROM mgmt_executions WHERE work_id IN (${marks}) ORDER BY last_observed_at DESC,started_at DESC,execution_id DESC LIMIT 1`,
    ...scope,
  );
  const facts = evidenceFacts(latest?.ledger_evidence ?? null),
    repoRoot = facts.repo_root ?? latest?.cwd ?? null,
    baseRef = facts.base_ref ?? null;
  const entries = all<{ artifact_id: string; version_id: string }>(
    db,
    `SELECT a.artifact_id,v.version_id FROM mgmt_artifacts a JOIN mgmt_artifact_versions v ON v.version_id=(SELECT v2.version_id FROM mgmt_artifact_versions v2 WHERE v2.artifact_id=a.artifact_id ORDER BY v2.observed_at DESC,v2.version_id DESC LIMIT 1) WHERE a.work_id IN (${marks}) AND a.kind IN ('file','git_dirty') AND (a.work_id=? OR NOT EXISTS(SELECT 1 FROM mgmt_artifacts canonical WHERE canonical.work_id=? AND canonical.kind=a.kind AND canonical.canonical_key=a.canonical_key)) ORDER BY a.artifact_id`,
    ...scope, canonicalWork, canonicalWork,
  );
  validateManifestHosts(db,entries);
  return {
    work_id: canonicalWork,
    repo_root: repoRoot,
    git_head: repoRoot ? await git(fs, repoRoot, ["rev-parse", "HEAD"]) : null,
    git_tree_sha: repoRoot
      ? await git(fs, repoRoot, ["rev-parse", "HEAD^{tree}"])
      : null,
    base_ref: baseRef,
    base_sha:
      repoRoot && baseRef
        ? await git(fs, repoRoot, ["rev-parse", baseRef])
        : null,
    entries,
    verification: opts.verification,
  };
}

export function insertManifest(
  db: Database,
  input: ManifestInput,
  builtBy: string,
  now: number,
): { manifest_id: string; created: boolean } {
  ensureMgmtSchema(db);
  const canonicalWork=canonicalWorkId(db,input.work_id);
  if(canonicalWork!==input.work_id)throw new ControlError("invalid","manifest work_id must be canonical");
  const scope=workScope(db,canonicalWork);
  validateManifestHosts(db,input.entries);
  for (const entry of input.entries) {
    const row = one<{ work_id: string; artifact_id: string }>(
      db,
      "SELECT a.work_id,v.artifact_id FROM mgmt_artifact_versions v JOIN mgmt_artifacts a ON a.artifact_id=v.artifact_id WHERE v.version_id=?",
      entry.version_id,
    );
    if (
      !row ||
      row.artifact_id !== entry.artifact_id ||
      !scope.includes(row.work_id)
    )
      throw new ControlError(
        "invalid",
        "manifest entry does not belong to work artifact",
      );
  }
  const manifestId = manifestDigest(input);
  const tx = db.transaction(() => {
    const created = !!db
      .query(
        "INSERT OR IGNORE INTO mgmt_manifests(manifest_id,work_id,repo_root,git_head,git_tree_sha,base_ref,base_sha,verification,built_by,built_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        manifestId,
        input.work_id,
        input.repo_root,
        input.git_head,
        input.git_tree_sha,
        input.base_ref,
        input.base_sha,
        JSON.stringify(input.verification),
        builtBy,
        now,
      ).changes;
    if (created)
      for (const entry of input.entries)
        db.query(
          "INSERT INTO mgmt_manifest_entries(manifest_id,artifact_id,version_id) VALUES(?,?,?)",
        ).run(manifestId, entry.artifact_id, entry.version_id);
    return { manifest_id: manifestId, created };
  });
  return tx.immediate();
}

export function requestAcceptance(
  db: Database,
  manifestId: string,
  now: number,
): { item_id: string } {
  ensureMgmtSchema(db);
  const manifest = one<any>(
    db,
    "SELECT * FROM mgmt_manifests WHERE manifest_id=?",
    manifestId,
  );
  if (!manifest) throw new ControlError("not_found", "manifest not found");
  const work = getWork(db, manifest.work_id);
  if (!work) throw new ControlError("not_found", "work not found");
  const entries = all<any>(
    db,
    "SELECT e.artifact_id,e.version_id,a.display_path AS path,v.content_sha256 AS sha256 FROM mgmt_manifest_entries e JOIN mgmt_artifacts a ON a.artifact_id=e.artifact_id JOIN mgmt_artifact_versions v ON v.version_id=e.version_id WHERE e.manifest_id=? ORDER BY e.artifact_id",
    manifestId,
  );
  const itemId = `mgmt:accept:${manifest.work_id}:${manifestId}`;
  const existing = one<{ revision: number }>(
    db,
    "SELECT revision FROM control_attention WHERE item_id=?",
    itemId,
  );
  let verification: unknown;
  try {
    verification = JSON.parse(manifest.verification);
  } catch {
    throw new ControlError("invalid", "invalid manifest verification");
  }
  upsertAttention(
    db,
    {
      item_id: itemId,
      work_id: manifest.work_id,
      state: "open",
      effect_state: "not_started",
      urgency: "inbox",
      conclusion: "Artifact manifest is ready for acceptance",
      trigger: "A new immutable manifest was built",
      impact: "Submission remains blocked until this manifest is accepted",
      recommendation: "accept",
      options: ["accept", "reject", "defer"],
      owner: work.contract?.decision_owner ?? "owner",
      expires_at: null,
      source_link: null,
      approval_id: null,
      consumer_owner: null,
      contract_revision: work.revision,
      decision_mode: "human_only",
      evidence: {
        manifest_id: manifestId,
        entries,
        git_head: manifest.git_head,
        base_sha: manifest.base_sha,
        verification,
      },
      ...(existing ? { expected_revision: existing.revision } : {}),
    },
    now,
  );
  return { item_id: itemId };
}

export function recordAcceptance(
  db: Database,
  manifestId: string,
  verdict: "accepted" | "rejected",
  actor: string,
  evidence: Record<string, unknown>,
  now: number,
): { acceptance_id: string } {
  ensureMgmtSchema(db);
  const manifest = one<{ work_id: string }>(
    db,
    "SELECT work_id FROM mgmt_manifests WHERE manifest_id=?",
    manifestId,
  );
  if (!manifest) throw new ControlError("not_found", "manifest not found");
  const acceptanceId = id("acceptance", manifestId, verdict, actor);
  const itemId = `mgmt:accept:${manifest.work_id}:${manifestId}`;
  return db
    .transaction(() => {
      db.query(
        "INSERT OR IGNORE INTO mgmt_acceptances(acceptance_id,work_id,manifest_id,verdict,actor,evidence) VALUES(?,?,?,?,?,?)",
      ).run(
        acceptanceId,
        manifest.work_id,
        manifestId,
        verdict,
        actor,
        JSON.stringify(evidence),
      );
      const card = one<{ revision: number }>(
        db,
        "SELECT revision FROM control_attention WHERE item_id=?",
        itemId,
      );
      if (card) {
        const next = card.revision + 1;
        db.query(
          "UPDATE control_attention SET state='resolved',effect_state='succeeded',revision=?,acknowledged_at=?,updated_at=? WHERE item_id=?",
        ).run(next, now, now, itemId);
        db.query(
          "INSERT INTO control_attention_events(item_id,revision,kind,detail,created_at) VALUES(?,?,?,?,?)",
        ).run(
          itemId,
          next,
          "resolved",
          JSON.stringify({ selected_option: verdict, actor }),
          now,
        );
      }
      return { acceptance_id: acceptanceId };
    })
    .immediate();
}

export function invalidateAcceptances(
  db: Database,
  workId: string,
  reason: string,
  now: number,
): number {
  ensureMgmtSchema(db);
  const canonicalWork=canonicalWorkId(db,workId);
  const apply = () => {
    const stale = all<{ manifest_id: string }>(
      db,
      `SELECT DISTINCT m.manifest_id FROM mgmt_manifests m JOIN mgmt_manifest_entries e ON e.manifest_id=m.manifest_id JOIN mgmt_artifact_versions old ON old.version_id=e.version_id JOIN mgmt_artifacts old_artifact ON old_artifact.artifact_id=old.artifact_id WHERE m.work_id=? AND EXISTS(SELECT 1 FROM mgmt_artifacts current_artifact JOIN mgmt_artifact_versions newer ON newer.artifact_id=current_artifact.artifact_id WHERE current_artifact.work_id IN (${workScope(db, canonicalWork).map(() => "?").join(",")}) AND current_artifact.kind=old_artifact.kind AND current_artifact.canonical_key=old_artifact.canonical_key AND (newer.observed_at>old.observed_at OR newer.observed_at=old.observed_at AND newer.version_id>old.version_id))`,
      canonicalWork, ...workScope(db, canonicalWork),
    );
    let count = 0;
    for (const { manifest_id } of stale) {
      count += db
        .query(
          "UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason=? WHERE manifest_id=? AND verdict='accepted' AND invalidated_at IS NULL",
        )
        .run(now, reason, manifest_id).changes;
      db.query(
        "UPDATE control_attention SET state='superseded',revision=revision+1,updated_at=? WHERE item_id=? AND state='open'",
      ).run(now, `mgmt:accept:${canonicalWork}:${manifest_id}`);
    }
    return count;
  };
  return db.inTransaction ? apply() : db.transaction(apply).immediate();
}

export function listManifests(
  db: Database,
  workId: string,
): Array<{
  manifest_id: string;
  built_at: number;
  entries: number;
  acceptance: null | {
    acceptance_id: string;
    verdict: string;
    actor: string;
    invalidated_at: number | null;
  };
  submission: null | {
    submission_id: string;
    state: string;
    external_ref: string | null;
  };
}> {
  ensureMgmtSchema(db);
  return all<any>(
    db,
    "SELECT manifest_id,built_at FROM mgmt_manifests WHERE work_id=? ORDER BY built_at DESC,manifest_id",
    workId,
  ).map((m) => ({
    ...m,
    entries: one<{ n: number }>(
      db,
      "SELECT count(*) n FROM mgmt_manifest_entries WHERE manifest_id=?",
      m.manifest_id,
    )!.n,
    acceptance: one<any>(
      db,
      "SELECT acceptance_id,verdict,actor,invalidated_at FROM mgmt_acceptances WHERE manifest_id=? ORDER BY rowid DESC LIMIT 1",
      m.manifest_id,
    ),
    submission: one<any>(
      db,
      "SELECT submission_id,state,external_ref FROM mgmt_submissions WHERE manifest_id=? ORDER BY rowid DESC LIMIT 1",
      m.manifest_id,
    ),
  }));
}
