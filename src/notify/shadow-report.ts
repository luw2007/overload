import { Database } from "bun:sqlite";
import { openControl } from "../control/store";

export type ShadowFalseNegative = {
  subject: string;
  material_key: string;
  threshold: string;
  source_kind: string;
  source_id: string;
  legacy_reason: string;
  candidate_reason: string;
  compared_at: number;
};
export type ShadowDuplicate = {
  source_kind: string;
  source_id: string;
  rows: number;
  thresholds: string[];
  subjects: string[];
};
export type ShadowUnlinked = {
  subject: string;
  threshold: string;
  source_id: string;
  item_id: string | null;
  item_revision: number | null;
  compared_at: number;
};
export type ShadowInspection = {
  compared: number;
  false_negatives: ShadowFalseNegative[];
  duplicates: ShadowDuplicate[];
  unlinked_attention: ShadowUnlinked[];
};

type ShadowGroupRow = { source_kind: string; source_id: string; threshold: string; subject: string };

/**
 * The frozen contract's §6 step 2 shadow inspection, read-only over `control_notification_shadow`.
 *
 * - `false_negatives`: the legacy sender would have delivered and the candidate would not.
 * - `duplicates`: one source with more than one comparison row. Distinct thresholds for one source
 *   are expected by §4.4, so `thresholds`/`subjects` are returned for the operator to tell those
 *   apart from a source genuinely covered twice.
 * - `unlinked_attention`: Attention comparisons with no authoritative legacy binding. §6 step 2
 *   calls these visible coverage gaps rather than defects, so they are reported separately.
 */
export function inspectNotificationShadow(control: Database): ShadowInspection {
  const falseNegatives = control.query(`SELECT subject,material_key,threshold,source_kind,source_id,
      legacy_reason,candidate_reason,compared_at FROM control_notification_shadow
    WHERE legacy_would_send=1 AND candidate_would_send=0
    ORDER BY compared_at,subject,threshold`).all() as ShadowFalseNegative[];

  // Grouped in TypeScript rather than with group_concat: subjects and source IDs are opaque
  // producer strings and may contain the separator.
  const groups = new Map<string, ShadowDuplicate>();
  const rows = control.query(`SELECT source_kind,source_id,threshold,subject FROM control_notification_shadow
    ORDER BY source_kind,source_id,compared_at,threshold`).all() as ShadowGroupRow[];
  for (const row of rows) {
    const key = `${row.source_kind}\0${row.source_id}`;
    const group = groups.get(key)
      ?? { source_kind: row.source_kind, source_id: row.source_id, rows: 0, thresholds: [], subjects: [] };
    group.rows += 1;
    group.thresholds.push(row.threshold);
    if (!group.subjects.includes(row.subject)) group.subjects.push(row.subject);
    groups.set(key, group);
  }

  const unlinked = control.query(`SELECT subject,threshold,source_id,item_id,item_revision,compared_at
    FROM control_notification_shadow WHERE source_kind='attention' AND legacy_would_send=0
    ORDER BY compared_at,subject,threshold`).all() as ShadowUnlinked[];

  return {
    compared: rows.length,
    false_negatives: falseNegatives,
    duplicates: [...groups.values()].filter((group) => group.rows > 1),
    unlinked_attention: unlinked,
  };
}

/**
 * One JSON line on stdout. Reads no notification mode/flag/owner and writes no notification state;
 * the only write is `openControl`'s own idempotent schema ensure.
 */
function main(argv: string[]): number {
  if (argv.length > 0) {
    console.error("usage: bun run src/notify/shadow-report.ts");
    return 2;
  }
  const control = openControl();
  try {
    console.log(JSON.stringify(inspectNotificationShadow(control)));
    return 0;
  } finally {
    control.close();
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
