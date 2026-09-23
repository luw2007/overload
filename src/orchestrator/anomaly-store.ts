import type { Database } from "bun:sqlite";

// 异常检测数据层：信号采样、逐项检查结果、work 级异常预算。

export type SignalSample = {
  sample_id: number;
  work_id: string | null;
  task_id: string;
  attempt_id: string;
  window_at: number;
  commit_count: number;
  diff_added: number;
  diff_deleted: number;
  result_set_version: number;
};

export type CheckStatus = "pass" | "fail" | "unknown" | "not_run";
export type CheckResult = {
  result_set_version: number;
  work_id: string | null;
  task_id: string;
  attempt_id: string;
  observed_at: number;
  check_id: string;
  status: CheckStatus;
  fingerprint: string | null;
  check_def_version: string | null;
  evidence_ref: string | null;
};
export type CheckResultInput = {
  check_id: string;
  status: string;
  fingerprint?: string | null;
  check_def_version?: string | null;
  evidence_ref?: string | null;
};

export type AnomalyBudget = {
  work_id: string;
  budget_version: number;
  fingerprint: string | null;
  fix_rounds_consumed: number;
  trigger_count: number;
  continuation_windows_remaining: number;
  last_progress_result_version: number | null;
  updated_at: number;
};
export type AnomalyBudgetPatch = Partial<
  Pick<
    AnomalyBudget,
    | "fingerprint"
    | "fix_rounds_consumed"
    | "trigger_count"
    | "continuation_windows_remaining"
    | "last_progress_result_version"
  >
>;

// ---- 采样（按窗追加、只增不改）----

export function insertSignalSample(
  db: Database,
  task_id: string,
  attempt_id: string,
  window_at: number,
  commit_count: number,
  diff_added: number,
  diff_deleted: number,
  result_set_version: number,
  work_id?: string | null,
): number {
  const res = db.run(
    "INSERT INTO attempt_signal_samples(work_id,task_id,attempt_id,window_at,commit_count,diff_added,diff_deleted,result_set_version) VALUES(?,?,?,?,?,?,?,?)",
    [work_id ?? null, task_id, attempt_id, window_at, commit_count, diff_added, diff_deleted, result_set_version],
  );
  return Number(res.lastInsertRowid);
}

export function getSignalSamples(db: Database, work_id: string, limit = 100): SignalSample[] {
  return db
    .query("SELECT * FROM attempt_signal_samples WHERE work_id=? ORDER BY window_at ASC LIMIT ?")
    .all(work_id, limit) as SignalSample[];
}

export function getSignalSamplesByAttempt(db: Database, attempt_id: string): SignalSample[] {
  return db
    .query("SELECT * FROM attempt_signal_samples WHERE attempt_id=? ORDER BY window_at ASC")
    .all(attempt_id) as SignalSample[];
}

// ---- 逐项检查结果 ----

export function insertCheckResults(
  db: Database,
  result_set_version: number,
  task_id: string,
  attempt_id: string,
  observed_at: number,
  items: CheckResultInput[],
  work_id?: string | null,
): void {
  const stmt = db.prepare(
    "INSERT INTO attempt_check_results(result_set_version,work_id,task_id,attempt_id,observed_at,check_id,status,fingerprint,check_def_version,evidence_ref) VALUES(?,?,?,?,?,?,?,?,?,?)",
  );
  const run = db.transaction((rows: CheckResultInput[]) => {
    for (const it of rows) {
      stmt.run([
        result_set_version,
        work_id ?? null,
        task_id,
        attempt_id,
        observed_at,
        it.check_id,
        it.status,
        it.fingerprint ?? null,
        it.check_def_version ?? null,
        it.evidence_ref ?? null,
      ]);
    }
  });
  run(items);
}

export function getCheckResults(db: Database, result_set_version: number): CheckResult[] {
  return db
    .query("SELECT * FROM attempt_check_results WHERE result_set_version=? ORDER BY check_id")
    .all(result_set_version) as CheckResult[];
}

export function getLatestCheckResults(db: Database, work_id: string): CheckResult[] | null {
  const rows = db
    .query(
      "SELECT * FROM attempt_check_results WHERE work_id=? AND result_set_version=(SELECT MAX(result_set_version) FROM attempt_check_results WHERE work_id=?) ORDER BY check_id",
    )
    .all(work_id, work_id) as CheckResult[];
  return rows.length ? rows : null;
}

export function getResultSetVersions(db: Database, work_id: string, limit = 50): number[] {
  const rows = db
    .query(
      "SELECT DISTINCT result_set_version AS v FROM attempt_check_results WHERE work_id=? ORDER BY result_set_version DESC LIMIT ?",
    )
    .all(work_id, limit) as { v: number }[];
  return rows.map((r) => r.v);
}

// 下一个结果集版本号：跨 attempt_signal_samples 与 attempt_check_results 两表取 max。
// 空窗（本窗无检查输出）也会在 samples 占用一个版本号；若只从 check_results 取 max，
// 下一带检查的窗口会复用空窗版本号，导致空窗错误继承后续窗的检查结果。
export function getNextResultSetVersion(db: Database, work_id: string): number {
  const row = db
    .query(
      "SELECT COALESCE(MAX(v),0) AS m FROM (SELECT result_set_version AS v FROM attempt_signal_samples WHERE work_id=? UNION ALL SELECT result_set_version AS v FROM attempt_check_results WHERE work_id=?)",
    )
    .get(work_id, work_id) as { m: number };
  return row.m + 1;
}

// 裁剪历史采样：只保留最近 keep 个采样窗的 signal sample，并删除不再被任何 sample
// 引用的 check_results。evaluateAndFence 仅取最近 20 窗，保留 40 窗足够判断且防止无限膨胀。
export function pruneSignalHistory(db: Database, work_id: string, keep = 40): void {
  const cutoff = db
    .query(
      "SELECT sample_id AS id FROM attempt_signal_samples WHERE work_id=? ORDER BY window_at DESC LIMIT 1 OFFSET ?",
    )
    .get(work_id, keep) as { id: number } | undefined;
  if (cutoff) {
    db.run("DELETE FROM attempt_signal_samples WHERE work_id=? AND sample_id<=?", [work_id, cutoff.id]);
  }
  db.run(
    "DELETE FROM attempt_check_results WHERE work_id=? AND result_set_version NOT IN (SELECT result_set_version FROM attempt_signal_samples WHERE work_id=?)",
    [work_id, work_id],
  );
}

// ---- work 级异常预算 ----

export function getAnomalyBudget(db: Database, work_id: string): AnomalyBudget | null {
  return (db.query("SELECT * FROM work_anomaly_budget WHERE work_id=?").get(work_id) as AnomalyBudget | undefined) ?? null;
}

export function upsertAnomalyBudget(db: Database, work_id: string, patch: AnomalyBudgetPatch, now = Date.now()): void {
  const keys = Object.keys(patch) as (keyof AnomalyBudgetPatch)[];
  const cols = ["work_id", "updated_at", ...keys];
  const vals: unknown[] = [work_id, now, ...keys.map((k) => (patch as Record<string, unknown>)[k as string])];
  // 新行 budget_version 取默认 1；已有行自增，且只回写 patch 中提供的列。
  const updates = ["budget_version = budget_version + 1", "updated_at = excluded.updated_at", ...keys.map((k) => `${k} = excluded.${k}`)];
  db.run(
    `INSERT INTO work_anomaly_budget(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")}) ON CONFLICT(work_id) DO UPDATE SET ${updates.join(",")}`,
    vals,
  );
}

export function incrementTriggerCount(db: Database, work_id: string, now = Date.now()): void {
  db.run("UPDATE work_anomaly_budget SET trigger_count=trigger_count+1, updated_at=? WHERE work_id=?", [now, work_id]);
}

export function consumeContinuationWindow(db: Database, work_id: string, now = Date.now()): number {
  db.run(
    "UPDATE work_anomaly_budget SET continuation_windows_remaining=MAX(0,continuation_windows_remaining-1), updated_at=? WHERE work_id=?",
    [now, work_id],
  );
  const row = db.query("SELECT continuation_windows_remaining AS n FROM work_anomaly_budget WHERE work_id=?").get(work_id) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}
