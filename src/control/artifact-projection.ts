import { Database } from "bun:sqlite";
import { ControlError, ensureControlSchema } from "./store";
import {
  createObject,
  ensureRootProblem,
  getObject,
  linkProblemObject,
  objectId,
  rootProblemId,
  updateObject,
  type Sensitivity,
} from "./context-pool";

export type ProjectResult = { projected: number; skipped: number };

// mgmt sensitivity → control sensitivity 单向安全映射。
// 硬约束：withheld 绝不映射成 confirmed_secret（拒绝摘要，由 visibility 层整体拦截）。
function mapSensitivity(mgmt: string | null | undefined): Sensitivity {
  switch (mgmt) {
    case "none":
    case "clean":
      return "clean";
    case "suspect":
      return "suspected";
    case "withheld":
      return "unknown";
    default:
      return "unknown";
  }
}

type Row = {
  artifact_id: string;
  work_id: string;
  display_path: string | null;
  version_id: string;
  content_kind: string;
  content_sha256: string;
  snapshot_state: string;
  sensitivity: string;
  shareable: number;
};

/**
 * 把 mgmt_artifact_versions 中该 work 的版本投影进 control context 问题池。
 *
 * - stored：投影完整对象（reference 指向快照，full fetch 由 fetcher 校验 hash 后放行）。
 * - reference_only：投影占位对象（fetcher 侧按 snapshot_state 拦截 full 字节）。
 * - 其余状态（pending/lost/too_large/pruned/withheld_sensitive/write_failed）：跳过。
 *
 * 幂等：按 reference（artifact:<aid>@<vid>）查重；同 artifact 的新 mgmt version 推进为
 * 新 revision，problem_objects 指针 upsert 到最新 revision，历史 version 行保留可追溯。
 */
export function projectArtifactVersions(
  db: Database,
  work_id: string,
  now: number = Date.now(),
): ProjectResult {
  ensureControlSchema(db);
  if (typeof work_id !== "string" || !work_id.trim()) throw new ControlError("invalid", "work_id is required");
  // 防御性：任务1已保证所有 work 有根 problem，此处兜底 candidate/存量 work。
  ensureRootProblem(db, work_id, now);
  const rootId = rootProblemId(work_id);

  const rows = db
    .query(
      `SELECT a.artifact_id, a.work_id, a.display_path,
              v.version_id, v.content_kind, v.content_sha256, v.snapshot_state, v.sensitivity, v.shareable
       FROM mgmt_artifact_versions v
       JOIN mgmt_artifacts a ON a.artifact_id = v.artifact_id
       WHERE a.work_id = ?
       ORDER BY v.observed_at, v.version_id`,
    )
    .all(work_id) as Row[];

  let projected = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const row of rows) {
      // 防御：mgmt_artifacts.work_id 为 NOT NULL FK，正常必等于入参；不一致即跳过。
      if (!row.work_id || row.work_id !== work_id) { skipped++; continue; }
      if (row.snapshot_state !== "stored" && row.snapshot_state !== "reference_only") { skipped++; continue; }

      const reference = `artifact:${row.artifact_id}@${row.version_id}`;
      const object_id = objectId(work_id, "artifact", row.artifact_id);
      const sensitivity = mapSensitivity(row.sensitivity);
      const shareable = row.shareable ? 1 : 0;
      const summary_short = row.display_path
        ? `${row.display_path} @${row.version_id.slice(0, 8)}`
        : `artifact @${row.version_id.slice(0, 8)}`;

      // 幂等：该 mgmt version 是否已投影过（reference 唯一标识一个 mgmt version）。
      const existing = db
        .query(
          "SELECT revision FROM control_context_object_versions WHERE reference=? ORDER BY revision DESC LIMIT 1",
        )
        .get(reference) as { revision: number } | null;
      if (existing) { skipped++; continue; }

      const obj = getObject(db, object_id);
      if (!obj) {
        createObject(
          db,
          {
            work_id,
            ctype: "artifact",
            primary_problem_id: rootId,
            object_canonical_key: row.artifact_id,
            reference,
            source_type: "artifact",
            sensitivity,
            shareable,
            content_hash: row.content_sha256,
            summary_short,
          },
          now,
        );
        linkProblemObject(db, { problem_id: rootId, object_id, revision: 1, role: "artifact" }, now);
      } else {
        const next = updateObject(
          db,
          {
            object_id,
            expectedRevision: obj.revision,
            patch: {
              reference,
              source_type: "artifact",
              sensitivity,
              shareable,
              content_hash: row.content_sha256,
              summary_short,
            },
          },
          now,
        );
        linkProblemObject(db, { problem_id: rootId, object_id, revision: next.revision, role: "artifact" }, now);
      }
      projected++;
    }
  });
  run.immediate();

  return { projected, skipped };
}
