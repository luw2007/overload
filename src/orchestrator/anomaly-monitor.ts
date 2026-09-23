import { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getTask, transition, type Task } from "./store";
import { SpoolWriter } from "./spool";
import { defaultPidAlive, type CommandExecutor } from "./worktree";
import { probeRunnerLiveness, taskOrigin } from "./runner";
import {
  DEFAULT_THRESHOLDS,
  evaluateAnomaly,
  normalizeFingerprint,
  THRESHOLD_VERSION,
  type AnomalyResult,
  type AnomalyThresholds,
  type SignalSample,
} from "./anomaly";
import {
  consumeContinuationWindow,
  getAnomalyBudget,
  getCheckResults,
  getNextResultSetVersion,
  getSignalSamples,
  incrementTriggerCount,
  insertCheckResults,
  insertSignalSample,
  pruneSignalHistory,
  upsertAnomalyBudget,
} from "./anomaly-store";
import { parseStructuredCheckOutput } from "./evidence";
import { enqueueControlEvent, getAttention, getWork, reviseContract, upsertAttention } from "../control/store";
import { closeTarget, consumeDecision, getTarget, openMailbox, registerTarget, receipt } from "../decision-bot/mailbox";
import { requestApproval } from "./approval";

const STOP_CONFIRM_GRACE_MS = 5 * 60 * 1000;
const CARD_TTL_MS = 24 * 60 * 60 * 1000;

// §9：弱信号启发式跨窗状态。每条启发式独立计数，连续 N 窗命中才投 weak 卡。
type WeakProbeState = {
  windowAt: number; // 已评估过的最新采样窗 window_at（同窗不重复计数）
  repeatTool: number;
  errorFp: number;
  noGrowth: number;
  projected: boolean; // 已投过卡，避免同条 streak 重复投影
};

type CardIntentRow = {
  item_id: string;
  task_id: string;
  work_id: string | null;
  signal_kind: string;
  fingerprint: string | null;
  stop_state: string;
  evidence: string;
  threshold_version: string;
  created_at: number;
  repaired_at: number | null;
  control_event_id: string | null;
};

// §8：与 approval_intents → repairApprovalIntents 同构。anomaly_card_intents 在 orchestrator DB
// 事务内写入（与 stop_state/events/预算同提交）；本函数把它幂等投影到独立的 answers/control DB。
// 崩溃后重跑不会重复建卡：同 item_id 已存在时用 expected_revision 原地更新，并重置 repaired_at。
export function repairAnomalyIntents(db: Database, answers: Database, now: number = Date.now()): number {
  let repaired = 0;
  const rows = db.query("SELECT * FROM anomaly_card_intents WHERE repaired_at IS NULL").all() as CardIntentRow[];
  for (const row of rows) {
    let evidence: Record<string, unknown>;
    try {
      evidence = JSON.parse(row.evidence) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!row.work_id) continue;
    const work = getWork(answers, row.work_id);
    if (!work || work.state !== "active") continue;
    const task = getTask(db, row.task_id);
    const owner = work.contract?.decision_owner ?? "operator";
    const conclusion = typeof evidence.conclusion === "string" ? evidence.conclusion : `异常信号触发：${row.signal_kind}`;
    const options = Array.isArray(evidence.options) ? (evidence.options as string[]) : ["stop"];
    const urgency = row.stop_state === "stop_unconfirmed" ? "now" : "inbox";
    const existing = getAttention(answers, row.item_id);
    const item = upsertAttention(
      answers,
      {
        item_id: row.item_id,
        work_id: row.work_id,
        state: "open",
        effect_state: "not_started",
        urgency,
        conclusion,
        trigger: `异常信号触发：${row.signal_kind}`,
        impact: `继续运行预计持续消耗预算，现场可能继续偏离验收。stop_state=${row.stop_state}`,
        recommendation: options.includes("clean_restart") ? "clean_restart" : options[0] ?? "stop",
        options,
        owner,
        expires_at: now + CARD_TTL_MS,
        source_link: row.work_id ? `cmux://work/${row.work_id}/task/${row.task_id}` : (task?.worktree ?? null),
        approval_id: row.item_id,
        consumer_owner: "orchestrator",
        contract_revision: work.revision,
        decision_mode: "human_only",
        evidence,
        ...(existing ? { expected_revision: existing.revision } : {}),
      },
      now,
    );
    registerTarget(answers, {
      consumerOwner: "orchestrator",
      approvalId: row.item_id,
      question: conclusion,
      options,
      effect: "anomaly_decision",
      scope: { task_id: row.task_id, work_id: row.work_id, signal_kind: row.signal_kind },
      evidence,
      expiresAt: now + CARD_TTL_MS,
      decisionMode: "human_only",
      workId: row.work_id,
      contractRevision: work.revision,
      attemptId: task?.attempt_id ?? undefined,
    });
    const eventId = enqueueControlEvent(
      answers,
      { entity_id: item.item_id, entity_version: item.revision, kind: "attention.opened", work_id: row.work_id, item_id: item.item_id, payload: { attention: item } },
      now,
    );
    db.run("UPDATE anomaly_card_intents SET repaired_at=?, control_event_id=? WHERE item_id=?", [now, eventId, row.item_id]);
    repaired++;
  }
  return repaired;
}

// 异常信号监视器：采样 git churn + 结构化检查，调用纯检测函数，
// 对机器可验的信号围栏（请求 runner 停止并投影决策卡），对弱信号只投 Inbox。
export class AnomalyMonitor {
  private readonly thresholds: AnomalyThresholds;
  private readonly lastSampleAt = new Map<string, number>();
  // §9：弱信号启发式跨窗连续计数。key=task_id。
  private readonly weakProbes = new Map<string, WeakProbeState>();
  // continuation 预算按“采样窗”消费，而非按 tick 消费。记录每个 task 已扣过预算的最新窗 window_at。
  private readonly lastContinuationWindow = new Map<string, number>();

  constructor(
    readonly db: Database,
    readonly spool: SpoolWriter,
    readonly ledgerPath: string,
    readonly worktreeExec: CommandExecutor,
    readonly worktreesDir: string,
    readonly artifactsDir: string,
    thresholds: Partial<AnomalyThresholds> = {},
  ) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  private answersPath(): string | undefined {
    return process.env.OVERLOAD_ANSWERS_PATH;
  }

  // ---- 1.1 采样 ----
  async sampleTask(task: Task, now: number): Promise<void> {
    if (task.state !== "running") return;
    if (!task.worktree || !task.attempt_id) return;
    if (task.stop_state) return; // 已围栏，停止采样
    const last = this.lastSampleAt.get(task.task_id);
    if (last !== undefined && now - last < this.thresholds.signal_sample_window_ms) return;
    this.lastSampleAt.set(task.task_id, now);

    try {
      // commit count（只读）
      let commitCount = 0;
      const rev = await this.worktreeExec("git", ["-C", task.worktree, "rev-list", "--count", `${task.base_ref}..HEAD`]);
      if (rev.ok) {
        const n = Number.parseInt(rev.stdout.trim(), 10);
        if (Number.isFinite(n)) commitCount = n;
      }
      // numstat 求和（二进制行 "-" 计 0）
      let diffAdded = 0;
      let diffDeleted = 0;
      const num = await this.worktreeExec("git", ["-C", task.worktree, "diff", "--numstat", `${task.base_ref}...HEAD`]);
      if (num.ok) {
        for (const line of num.stdout.split("\n")) {
          const parts = line.split("\t");
          if (parts.length < 3) continue;
          const a = parts[0];
          const d = parts[1];
          if (a !== "-" && a.trim() !== "") {
            const n = Number.parseInt(a, 10);
            if (Number.isFinite(n)) diffAdded += n;
          }
          if (d !== "-" && d.trim() !== "") {
            const n = Number.parseInt(d, 10);
            if (Number.isFinite(n)) diffDeleted += n;
          }
        }
      }
      // 结构化检查（存在才执行）
      const checkPath = join(task.worktree, "orchestrator.check");
      let items: { check_id: string; status: string; fingerprint?: string | null; check_def_version?: string | null }[] = [];
      if (existsSync(checkPath)) {
        const out = await this.worktreeExec(checkPath, [], { cwd: task.worktree });
        const parsed = parseStructuredCheckOutput(`${out.stdout}${out.stderr}`);
        if (parsed) items = parsed;
      }
      const workId = task.work_id ?? undefined;
      const nextVersion = workId ? getNextResultSetVersion(this.db, workId) : 1;
      const run = this.db.transaction(() => {
        insertSignalSample(this.db, task.task_id, task.attempt_id, now, commitCount, diffAdded, diffDeleted, nextVersion, workId);
        if (items.length > 0) insertCheckResults(this.db, nextVersion, task.task_id, task.attempt_id, now, items, workId);
        if (workId) pruneSignalHistory(this.db, workId);
      });
      run();
    } catch (error) {
      this.db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [task.task_id, now, task.state, task.state, "anomaly_sample_failed", JSON.stringify({ error: String(error) })],
      );
    }
  }

  // continuation 预算按采样窗消费一次（而非按 tick）。返回消费后剩余窗口数。
  // 同一 window_at 重复调用不重复扣减；扣到 0 时记 anomaly_continuation_expired。
  private consumeContinuationForWindow(task: Task, latestWindowAt: number, now: number): number {
    if (!task.work_id) return 0;
    const budget = getAnomalyBudget(this.db, task.work_id);
    if (!budget) return 0;
    if (this.lastContinuationWindow.get(task.task_id) === latestWindowAt) return budget.continuation_windows_remaining;
    if (budget.continuation_windows_remaining <= 0) return 0;
    const remaining = consumeContinuationWindow(this.db, task.work_id, now);
    this.lastContinuationWindow.set(task.task_id, latestWindowAt);
    if (remaining <= 0) {
      this.db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [task.task_id, now, task.state, task.state, "anomaly_continuation_expired", JSON.stringify({ work_id: task.work_id })],
      );
    }
    return remaining;
  }

  // ---- 1.2 检测与围栏 ----
  async evaluateAndFence(task: Task, now: number): Promise<void> {
    if (!task.work_id || !task.attempt_id) return;
    const rows = getSignalSamples(this.db, task.work_id, 100).slice(-20);
    if (rows.length === 0) return;
    const samples: SignalSample[] = rows.map((r) => {
      const checks = getCheckResults(this.db, r.result_set_version).map((c) => ({
        check_id: c.check_id,
        status: c.status,
        fingerprint: c.fingerprint,
        check_def_version: c.check_def_version ?? "unknown",
      }));
      return {
        window_at: r.window_at,
        commit_count: r.commit_count,
        diff_added: r.diff_added,
        diff_deleted: r.diff_deleted,
        result_set_version: r.result_set_version,
        checks,
      };
    });
    const result = evaluateAnomaly(samples, this.thresholds);
    const latestWindowAt = samples[samples.length - 1].window_at;

    if (result.kind === null) {
      // 无触发：human 追加的观察预算仍按窗扣减（即便本窗无新信号）；耗尽后由下一触发窗重新围栏。
      if (!task.stop_state) this.consumeContinuationForWindow(task, latestWindowAt, now);
      // §7：机器可验信号已解除（检查项 fail→pass 且当前无失败项）→ 自动清退 open 卡。
      if (result.confidence === "machine") {
        await this.autoResolveIfRecovered(task, result, now);
      }
      // §9：弱信号（无机器可验检查）：三条启发式连续 N 窗命中才投 Inbox 卡，不围栏、不停止 runner。
      if (result.confidence === "weak") {
        const fired = await this.detectWeakSignals(task, samples, now);
        if (fired) this.projectCard(task, result, "inbox", now);
      }
      return;
    }

    if (result.confidence === "weak") {
      this.projectCard(task, result, "inbox", now);
      return;
    }

    // 机器可验信号：若 human 仍持有 continuation 观察预算，则本窗消耗一次、不围栏，让 agent 继续跑；
    // 预算耗尽（remaining==0）后才真正围栏，禁止自动续杯。
    if (!task.stop_state) {
      const budget = getAnomalyBudget(this.db, task.work_id);
      if (budget && budget.continuation_windows_remaining > 0) {
        const remaining = this.consumeContinuationForWindow(task, latestWindowAt, now);
        if (remaining > 0) return;
      }
    }

    // 机器可验信号：围栏
    await this.fence(task, result, now, result.kind);
  }

  // ---- §9：弱信号三条启发式 ----
  // 任一启发式连续 invariant_flat_windows 窗命中才返回命中的启发式名；否则返回 null。
  // 所有探测只读；ledger 不可读/日志缺失时静默跳过该条。
  private async detectWeakSignals(task: Task, samples: SignalSample[], now: number): Promise<string | null> {
    const latestWindowAt = samples.length ? samples[samples.length - 1].window_at : now;
    const state = this.weakProbes.get(task.task_id) ?? { windowAt: -1, repeatTool: 0, errorFp: 0, noGrowth: 0, projected: false };
    if (state.windowAt === latestWindowAt) return state.projected ? null : null; // 同窗不重复计数
    state.windowAt = latestWindowAt;

    let repeatTool = false;
    try { repeatTool = this.probeRepeatedTool(task); } catch { repeatTool = false; }
    let errorFp = false;
    try { errorFp = this.probeRepeatedErrorFp(task); } catch { errorFp = false; }
    let noGrowth = false;
    try { noGrowth = this.probeNoGrowth(samples); } catch { noGrowth = false; }

    state.repeatTool = repeatTool ? state.repeatTool + 1 : 0;
    state.errorFp = errorFp ? state.errorFp + 1 : 0;
    state.noGrowth = noGrowth ? state.noGrowth + 1 : 0;

    const threshold = this.thresholds.invariant_flat_windows;
    const fired: string | null =
      state.repeatTool >= threshold ? "repeated_tool"
      : state.errorFp >= threshold ? "repeated_error_fp"
      : state.noGrowth >= threshold ? "no_growth"
      : null;

    if (fired) {
      state.projected = true;
    } else if (!repeatTool && !errorFp && !noGrowth) {
      state.projected = false; // 出现进展，允许未来再次投卡
    }
    this.weakProbes.set(task.task_id, state);
    return fired;
  }

  // 启发式 1：同一工具/命令在无状态变化下连续重复 ≥3 次。
  // 优先读 ledger journal 的 tool_activity；结构不支持时退化为不命中（日志命令行提取与启发式2重叠）。
  private probeRepeatedTool(task: Task): boolean {
    if (!task.attempt_id) return false;
    let db: Database | null = null;
    try {
      db = new Database(this.ledgerPath, { readonly: true });
      const origin = taskOrigin(task.task_id, task.attempt_id);
      const session = db.query("SELECT stable_id FROM sessions WHERE origin=? ORDER BY created_at DESC LIMIT 1").get(origin) as { stable_id: string } | undefined;
      if (!session) return false;
      const rows = db
        .query("SELECT detail FROM journal WHERE stable_id=? AND kind='tool_activity' ORDER BY ingest_seq DESC LIMIT 20")
        .all(session.stable_id) as { detail: string | null }[];
      if (rows.length < 3) return false;
      // rows DESC；转成时间正序，提取 tool 名，change=true 视为有状态变化（打断重复）。
      const tools: string[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        try {
          const d = JSON.parse(rows[i].detail ?? "{}") as { tool?: string; tool_name?: string; change?: boolean };
          if (d.change === true) { tools.push("__change__"); continue; }
          const tool = d.tool ?? d.tool_name;
          if (tool) tools.push(String(tool));
        } catch { /* 跳过坏行 */ }
      }
      let run = 1;
      for (let i = tools.length - 1; i > 0; i--) {
        if (tools[i] === tools[i - 1] && tools[i] !== "__change__") run++;
        else break;
      }
      return run >= 3;
    } catch {
      return false;
    } finally {
      db?.close();
    }
  }

  // 启发式 2：最新 runner 日志中同一归一化错误指纹出现 ≥3 次。
  private probeRepeatedErrorFp(task: Task): boolean {
    const dir = join(this.artifactsDir, task.task_id);
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => /^runner-.*\.log$/.test(f));
    } catch {
      return false;
    }
    if (names.length === 0) return false;
    // 取修改时间最新的日志文件
    let latest: string | null = null;
    let latestMtime = -1;
    for (const n of names) {
      try {
        const st = statSync(join(dir, n));
        if (st.mtimeMs > latestMtime) { latestMtime = st.mtimeMs; latest = n; }
      } catch { /* 跳过 */ }
    }
    if (!latest) return false;
    let text: string;
    try { text = readFileSync(join(dir, latest), "utf8"); } catch { return false; }
    const counts = new Map<string, number>();
    for (const line of text.split("\n")) {
      if (!/error|fail|exception|traceback/i.test(line)) continue;
      const fp = normalizeFingerprint(line);
      counts.set(fp, (counts.get(fp) ?? 0) + 1);
    }
    for (const n of counts.values()) if (n >= 3) return true;
    return false;
  }

  // 启发式 3：采样窗内无产物增长（commit_count 与 diff 近 3 窗均无上升）。
  private probeNoGrowth(samples: SignalSample[]): boolean {
    if (samples.length < 3) return false;
    const last = samples.slice(-3);
    const ccGrew = last[2].commit_count > last[0].commit_count;
    const d0 = last[0].diff_added + last[0].diff_deleted;
    const d2 = last[2].diff_added + last[2].diff_deleted;
    return !ccGrew && d2 <= d0;
  }

  // ---- §7：信号解除自动清退 ----
  // 机器可验信号：checks_failed==0 且近窗有 fail→pass 时，自动 resolved open 的 machine 卡。
  // weak 卡不自动清退（留给人判断）。
  private async autoResolveIfRecovered(task: Task, result: AnomalyResult, now: number): Promise<void> {
    if (!task.work_id) return;
    const checksFailed = result.snapshot?.checks_failed ?? 0;
    const passedDelta = result.snapshot?.passed_delta_last_windows ?? 0;
    if (checksFailed !== 0 || passedDelta <= 0) return;

    let answers: Database | null = null;
    let resolvedAny = false;
    try {
      answers = openMailbox(this.answersPath());
      const open = answers
        .query("SELECT item_id, evidence FROM control_attention WHERE work_id=? AND item_id LIKE 'anomaly:%' AND state='open'")
        .all(task.work_id) as { item_id: string; evidence: string }[];
      for (const row of open) {
        let ev: Record<string, unknown> = {};
        try { ev = JSON.parse(row.evidence ?? "{}") as Record<string, unknown>; } catch { ev = {}; }
        if (ev.signal_confidence !== "machine") continue; // weak 卡留给人
        this.setAttentionState(answers, row.item_id, "resolved", "succeeded", now, { resume_state: "recovered" });
        closeTarget(answers, "orchestrator", row.item_id, "succeeded");
        resolvedAny = true;
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [task.task_id, now, task.state, task.state, "anomaly_resolved", JSON.stringify({ item_id: row.item_id, reason: "checks_recovered" })],
        );
      }
    } finally {
      answers?.close();
    }
    // 已 stopped_confirmed 且无剩余风险 → 清空 stop_state，让任务自然续跑。
    if (resolvedAny && task.stop_state === "stopped_confirmed") {
      this.db.run(
        "UPDATE tasks SET stop_state=NULL, stop_requested_at=NULL, stop_deadline_at=NULL, stop_reason=NULL, updated_at=? WHERE task_id=?",
        [now, task.task_id],
      );
    }
  }

  private async fence(task: Task, result: AnomalyResult, now: number, reason: string): Promise<void> {
    const already = task.stop_state != null;
    const kind = result.kind ?? "weak";
    const fp = result.fingerprint ?? "divergence";
    const itemId = `anomaly:${task.work_id}:${kind}:${fp}`;
    const churnTotal = this.computeChurnTotal(task.work_id);

    if (!already && task.work_id) {
      const evidence = this.buildEvidence(task, result, "stop_requested", now, churnTotal);
      const run = this.db.transaction(() => {
        this.db.run(
          "UPDATE tasks SET stop_state='stop_requested', stop_requested_at=?, stop_reason=?, updated_at=? WHERE task_id=? AND stop_state IS NULL",
          [now, reason, now, task.task_id],
        );
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [task.task_id, now, task.state, task.state, "anomaly_triggered", JSON.stringify({ kind: result.kind, fingerprint: result.fingerprint, snapshot: result.snapshot, threshold_version: THRESHOLD_VERSION })],
        );
        // 仅 fix_loop_exhausted 携带具体卡滞指纹时才回写 fingerprint 与 fix_rounds_consumed。
        // divergence_detected 的 result.fingerprint 为 null；若照写会把既有 fix_loop 指纹清空。
        if (result.kind === "fix_loop_exhausted" && result.fingerprint) {
          upsertAnomalyBudget(
            this.db,
            task.work_id!,
            { fingerprint: result.fingerprint, fix_rounds_consumed: result.snapshot?.fix_rounds_same_fingerprint ?? 0 },
            now,
          );
        }
        incrementTriggerCount(this.db, task.work_id!, now);
        // §8：采样/检查/预算扣减/围栏/outbox 在同一 orchestrator DB 事务提交。
        this.upsertCardIntent(task, result, "stop_requested", itemId, now, churnTotal, evidence);
      });
      run();
    }

    let stopState: string = already ? task.stop_state! : "stop_requested";
    if (!already) {
      const outcome = await this.requestRunnerStop(task, now);
      if (outcome === "stopped") {
        stopState = "stopped_confirmed";
        this.db.run("UPDATE tasks SET stop_state='stopped_confirmed', updated_at=? WHERE task_id=? AND stop_state='stop_requested'", [now, task.task_id]);
      } else if (outcome === "alive" || outcome === "unavailable") {
        // §6.1：进程仍活或无法确认停止（无 pid / 身份不匹配 / 探测不可用）均视为 stop_unconfirmed。
        // 无法确认即未确认，runner 可能仍在写入；卡片进 Now，由人工决策或超时对账收敛。
        stopState = "stop_unconfirmed";
        this.db.run(
          "UPDATE tasks SET stop_state='stop_unconfirmed', stop_deadline_at=?, updated_at=? WHERE task_id=? AND stop_state='stop_requested'",
          [now + STOP_CONFIRM_GRACE_MS, now, task.task_id],
        );
      }
    }

    const fresh = getTask(this.db, task.task_id) ?? task;
    // 探针结果决定最终 stop_state；把最新 evidence 写回 intent（重置 repaired_at 触发投影）。
    this.upsertCardIntent(fresh, result, stopState, itemId, now, churnTotal);
    this.repairIntentsSync(fresh.task_id, now);
  }

  private computeChurnTotal(workId: string | null | undefined): number {
    if (!workId) return 0;
    const rows = getSignalSamples(this.db, workId, 100);
    return rows.reduce((acc, s) => acc + s.diff_added + s.diff_deleted, 0);
  }

  // §6.2/§4.2：churn_total 为该 work_id 全部采样窗 diff_added+diff_deleted 的累计，不得用 commit_count 代替。
  private buildEvidence(task: Task, result: AnomalyResult, stopState: string, now: number, churnTotal: number): Record<string, unknown> {
    const kind = result.kind ?? "weak";
    let conclusion: string;
    if (kind === "fix_loop_exhausted") {
      conclusion = `同一检查连续 ${result.snapshot?.fix_rounds_same_fingerprint ?? 0} 轮未通过，改动未带来新进展`;
    } else if (kind === "divergence_detected") {
      conclusion = `近 ${result.snapshot?.sampled_windows ?? 0} 窗改动量上升至常态 ${(result.snapshot?.churn_rate ?? 0).toFixed(1)} 倍，无检查项转为通过`;
    } else {
      conclusion = "无机器可验结论，依据为行为重复";
    }
    // §6.3：weak 信号无机器预算，选项收敛为 stop；machine 信号保留完整选项。
    const options = result.confidence === "machine"
      ? ["clean_restart", "continue_with_budget", "narrow_or_redirect", "stop"]
      : ["stop"];
    const budgetNow = task.work_id ? getAnomalyBudget(this.db, task.work_id) : null;
    const budgetConsumed = {
      fix_rounds: result.snapshot?.fix_rounds_same_fingerprint ?? budgetNow?.fix_rounds_consumed ?? 0,
      churn_total: churnTotal,
      duration_ms: result.snapshot ? Math.max(0, result.snapshot.triggered_at - result.snapshot.first_seen_at) : 0,
      trigger_count: budgetNow?.trigger_count ?? 0,
    };
    return {
      signal_kind: result.kind,
      signal_confidence: result.confidence,
      fingerprint: result.fingerprint,
      signal_snapshot: result.snapshot,
      budget_consumed: budgetConsumed,
      blocked_invariant: result.blocked_invariant,
      task_id: task.task_id,
      attempt_id: task.attempt_id,
      stop_state: stopState,
      resume_state: "stopped",
      threshold_version: THRESHOLD_VERSION,
      conclusion,
      options,
    };
  }

  private upsertCardIntent(task: Task, result: AnomalyResult, stopState: string, itemId: string, now: number, churnTotal: number, evidence?: Record<string, unknown>): void {
    if (!task.work_id) return;
    const ev = evidence ?? this.buildEvidence(task, result, stopState, now, churnTotal);
    const kind = result.kind ?? "weak";
    const fp = result.fingerprint ?? "divergence";
    // 同 work_id+kind+fingerprint 重复触发：更新 evidence、重置 repaired_at 触发重新投影。
    this.db.run(
      `INSERT INTO anomaly_card_intents(item_id,task_id,work_id,signal_kind,fingerprint,stop_state,evidence,threshold_version,created_at)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(item_id) DO UPDATE SET
         task_id=excluded.task_id, work_id=excluded.work_id, signal_kind=excluded.signal_kind,
         fingerprint=excluded.fingerprint, stop_state=excluded.stop_state, evidence=excluded.evidence,
         threshold_version=excluded.threshold_version, repaired_at=NULL, control_event_id=NULL`,
      [itemId, task.task_id, task.work_id, kind, fp, stopState, JSON.stringify(ev), THRESHOLD_VERSION, now],
    );
  }

  private repairIntentsSync(taskId: string, now: number): void {
    let answers: Database | null = null;
    try {
      answers = openMailbox(this.answersPath());
      repairAnomalyIntents(this.db, answers, now);
    } catch (error) {
      this.db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [taskId, now, "?", "?", "anomaly_repair_failed", JSON.stringify({ error: String(error) })],
      );
    } finally {
      answers?.close();
    }
  }

  // 可被子类覆盖以便测试模拟 runner 存活/死亡。
  protected async requestRunnerStop(task: Task, _now: number): Promise<"stopped" | "alive" | "unavailable"> {
    if (task.runner_pid == null || !task.runner_boot_id || !task.attempt_id) return "unavailable";
    const probe = probeRunnerLiveness(this.ledgerPath, task.task_id, task.attempt_id);
    if (probe.kind !== "found" || !probe.has_incarnation || probe.pid !== task.runner_pid || probe.boot_id !== task.runner_boot_id) {
      return "unavailable";
    }
    try {
      process.kill(task.runner_pid, "SIGTERM");
    } catch {
      // 进程已不存在视为已停止
    }
    await this.waitTick();
    const alive = defaultPidAlive(task.runner_pid);
    const probe2 = probeRunnerLiveness(this.ledgerPath, task.task_id, task.attempt_id);
    const ended = probe2.kind === "found" && probe2.ended;
    if (!alive || ended) return "stopped";
    return "alive";
  }

  protected async waitTick(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  // ---- 1.3 决策卡投影 ----
  // §8：不再直接写 answers/control DB。这里只写 orchestrator DB 的 anomaly_card_intents outbox，
  // 再同步触发 repairAnomalyIntents 投影；崩溃后由 tick 的 repairAnomalyIntents 幂等重放。
  projectCard(task: Task, result: AnomalyResult, stopState: string, now: number): void {
    if (!task.work_id) return;
    const kind = result.kind ?? "weak";
    const fp = result.fingerprint ?? "divergence";
    const itemId = `anomaly:${task.work_id}:${kind}:${fp}`;
    const churnTotal = this.computeChurnTotal(task.work_id);
    this.upsertCardIntent(task, result, stopState, itemId, now, churnTotal);
    this.repairIntentsSync(task.task_id, now);
  }

  // ---- 1.4 / 1.5 决策消费与 stop_unconfirmed 超时 ----
  async consumeDecisions(now: number): Promise<void> {
    let answers: Database | null = null;
    try {
      answers = openMailbox(this.answersPath());
      // §6.1：stop_unconfirmed 超时先收敛，再消费决策。
      const tasks = this.db.query("SELECT * FROM tasks WHERE stop_state IS NOT NULL").all() as Task[];
      for (const task of tasks) {
        const fresh = getTask(this.db, task.task_id) ?? task;
        if (fresh.stop_state === "stop_unconfirmed" && fresh.stop_deadline_at != null && now >= fresh.stop_deadline_at) {
          this.handleUnconfirmedTimeout(fresh, now);
        }
        if (!fresh.work_id) continue;
        const open = answers
          .query("SELECT item_id FROM control_attention WHERE work_id=? AND item_id LIKE 'anomaly:%' AND state='open' ORDER BY updated_at DESC")
          .all(fresh.work_id) as { item_id: string }[];
        for (const row of open) {
          const itemId = row.item_id;
          const target = getTarget(answers, "orchestrator", itemId);
          if (!target || target.state !== "active") continue;
          const prior = answers.query("SELECT receipt_id FROM decision_receipts WHERE consumer_owner='orchestrator' AND approval_id=?").get(itemId) as { receipt_id: string } | undefined;
          if (prior) continue;
          const receipt = consumeDecision(answers, {
            consumerOwner: "orchestrator",
            approvalId: itemId,
            targetVersion: target.targetVersion,
            policyHash: "human_only",
            now,
            liveValid: () => {
              const t = getTask(this.db, fresh.task_id);
              return t != null && t.stop_state !== null;
            },
            policyValid: () => false, // human_only：不接受 policy 自动作答
          });
          if (!receipt) continue;
          await this.applyDecision(fresh, receipt.answer, receipt.receiptId, itemId, answers, now);
        }
      }
      // §9/§6.3：weak 卡不围栏（stop_state 为 NULL），单独遍历 open 的 weak anomaly 卡消费 stop。
      await this.consumeWeakCards(answers, now);
      // §6.1：confirm_stopped 占用处理决定由本监视器消费（任务处于 running/fenced，通用 consumeAnswers 的 awaiting_human liveValid 不会放行）。
      await this.consumeConfirmStopped(answers, now);
    } finally {
      answers?.close();
    }
  }

  private async consumeWeakCards(answers: Database, now: number): Promise<void> {
    const open = answers
      .query("SELECT item_id, evidence FROM control_attention WHERE item_id LIKE 'anomaly:%' AND state='open'")
      .all() as { item_id: string; evidence: string }[];
    for (const row of open) {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(row.evidence) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (ev.signal_confidence !== "weak") continue;
      const taskId = typeof ev.task_id === "string" ? ev.task_id : null;
      if (!taskId) continue;
      const task = getTask(this.db, taskId);
      if (!task || ["done", "failed", "abandoned"].includes(task.state)) continue;
      const target = getTarget(answers, "orchestrator", row.item_id);
      if (!target || target.state !== "active") continue;
      const prior = answers.query("SELECT receipt_id FROM decision_receipts WHERE consumer_owner='orchestrator' AND approval_id=?").get(row.item_id) as { receipt_id: string } | undefined;
      if (prior) continue;
      const receipt = consumeDecision(answers, {
        consumerOwner: "orchestrator",
        approvalId: row.item_id,
        targetVersion: target.targetVersion,
        policyHash: "human_only",
        now,
        liveValid: () => {
          const t = getTask(this.db, taskId);
          return t != null && !["done", "failed", "abandoned"].includes(t.state);
        },
        policyValid: () => false,
      });
      if (!receipt) continue;
      if (receipt.answer === "stop") {
        transition(this.db, taskId, "human_abandon", { reason: "anomaly_weak_stop" }, now);
        this.setAttentionState(answers, row.item_id, "resolved", "succeeded", now, { resume_state: "stopped" });
        this.db.run("INSERT INTO applied_receipts(receipt_id,task_id,answer,applied_at,result) VALUES(?,?,?,?,?)", [receipt.receiptId, taskId, receipt.answer, now, "ok"]);
      }
    }
  }

  private async consumeConfirmStopped(answers: Database, now: number): Promise<void> {
    const approvals = this.db.query("SELECT * FROM approvals WHERE gate='confirm_stopped'").all() as { approval_id: string; task_id: string; consumed_at: number | null }[];
    for (const a of approvals) {
      const processed = this.db
        .query("SELECT 1 FROM task_events WHERE task_id=? AND event='anomaly_confirm_processed' AND detail LIKE ?")
        .get(a.task_id, `%${a.approval_id}%`) as { "1": number } | undefined;
      if (processed) continue;
      const task = getTask(this.db, a.task_id);
      if (!task) continue;
      let r = receipt(answers, "orchestrator", a.approval_id);
      if (!r && a.consumed_at == null) {
        const target = getTarget(answers, "orchestrator", a.approval_id);
        if (!target || target.state !== "active") continue;
        r = consumeDecision(answers, {
          consumerOwner: "orchestrator",
          approvalId: a.approval_id,
          targetVersion: target.targetVersion,
          policyHash: "human_only",
          now,
          liveValid: () => {
            const t = getTask(this.db, a.task_id);
            return t != null && t.stop_state !== null;
          },
          policyValid: () => false,
        });
      }
      if (!r) continue;
      // §16.7：confirm-stopped 必须再次探测；机器确认进程仍活时拒绝。
      let exited = true;
      if (task.runner_pid != null && task.attempt_id) {
        const alive = defaultPidAlive(task.runner_pid);
        const probe = probeRunnerLiveness(this.ledgerPath, task.task_id, task.attempt_id);
        exited = !alive || (probe.kind === "found" && probe.ended);
      }
      const ev = (event: string, detail: Record<string, unknown>) => {
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [task.task_id, now, task.state, task.state, event, JSON.stringify(detail)],
        );
      };
      if (r.answer === "confirm-stopped") {
        if (!exited) {
          ev("anomaly_confirm_rejected", { approval_id: a.approval_id, reason: "runner_still_alive" });
        } else {
          this.db.run("UPDATE tasks SET stop_state='stopped_confirmed', stop_deadline_at=NULL, updated_at=? WHERE task_id=? AND stop_state='stop_unconfirmed'", [now, task.task_id]);
          ev("anomaly_confirm_processed", { approval_id: a.approval_id, answer: "confirm-stopped" });
          this.updateCardUrgency(task, "inbox", now);
        }
      } else if (r.answer === "keep-held") {
        this.db.run("UPDATE tasks SET stop_deadline_at=?, updated_at=? WHERE task_id=? AND stop_state='stop_unconfirmed'", [now + STOP_CONFIRM_GRACE_MS, now, task.task_id]);
        ev("anomaly_keep_held", { approval_id: a.approval_id, next_deadline: now + STOP_CONFIRM_GRACE_MS });
        ev("anomaly_confirm_processed", { approval_id: a.approval_id, answer: "keep-held" });
      }
      if (a.consumed_at == null) {
        this.db.run("UPDATE approvals SET consumed_at=?, actor=? WHERE approval_id=?", [now, r.actor, a.approval_id]);
      }
    }
  }

  private async applyDecision(task: Task, answer: string, receiptId: string, itemId: string, answers: Database, now: number): Promise<void> {
    const dup = this.db.query("SELECT 1 FROM applied_receipts WHERE receipt_id=?").get(receiptId);
    if (dup) return;
    const ev = (event: string, detail: Record<string, unknown>) => {
      this.db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [task.task_id, now, task.state, task.state, event, JSON.stringify(detail)],
      );
    };
    const recordApplied = (result: string) => {
      this.db.run("INSERT INTO applied_receipts(receipt_id,task_id,answer,applied_at,result) VALUES(?,?,?,?,?)", [receiptId, task.task_id, answer, now, result]);
    };
    const clearStop = () => {
      this.db.run("UPDATE tasks SET stop_state=NULL, stop_requested_at=NULL, stop_deadline_at=NULL, stop_reason=NULL, updated_at=? WHERE task_id=?", [now, task.task_id]);
    };

    if (answer === "clean_restart") {
      if (task.stop_state !== "stopped_confirmed") {
        ev("anomaly_decision_rejected", { answer, reason: "not_stopped_confirmed", stop_state: task.stop_state });
        recordApplied("rejected");
        return;
      }
      // §3：retry_budget 是进程级崩溃恢复预算，与异常预算正交。人工 clean_restart 直接旋转 attempt，
      // 不调用 transition(runner_dead)，避免误扣 retry_budget。
      const newAttemptId = randomUUID();
      const rotate = this.db.transaction(() => {
        this.db.run(
          "UPDATE tasks SET state='starting', attempt_id=?, runner_pid=NULL, runner_boot_id=NULL, stable_id=NULL, updated_at=? WHERE task_id=?",
          [newAttemptId, now, task.task_id],
        );
        this.db.run(
          "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
          [task.task_id, now, task.state, "starting", "runner_dead", JSON.stringify({ reason: "anomaly_clean_restart" })],
        );
        this.db.run("DELETE FROM task_recovery WHERE task_id=?", [task.task_id]);
      });
      rotate();
      // 丢弃 worktree 中的脏改动，确保新一轮 attempt 从 base_ref 干净起步。
      // ensureWorktree 发现目录已存在会直接返回，不会 reset；这里显式重置。
      if (task.worktree) {
        try {
          const r1 = await this.worktreeExec("git", ["-C", task.worktree, "reset", "--hard", task.base_ref]);
          if (!r1.ok) throw new Error(`git reset --hard ${task.base_ref} failed: ${r1.stderr}`);
          const r2 = await this.worktreeExec("git", ["-C", task.worktree, "clean", "-fdx"]);
          if (!r2.ok) throw new Error(`git clean -fdx failed: ${r2.stderr}`);
        } catch (error) {
          // 重置失败不阻断状态旋转（attempt 已轮换，下一次 spawn 会重建绑定），但显式记录。
          ev("anomaly_clean_restart_warn", { error: String(error), worktree: task.worktree });
        }
      }
      clearStop();
      ev("anomaly_clean_restart", { receipt: receiptId, attempt_id: newAttemptId });
      this.setAttentionState(answers, itemId, "applying", "applying", now, { resume_state: "clean_attempt" });
      recordApplied("ok");
      return;
    }
    if (answer === "continue_with_budget") {
      // §3：人工选择 continue_with_budget 时创建契约新版本，记录原因和新增窗口数；
      // reviseContract 会自动 supersede 进行中的 anomaly 卡，无需手动 resolved。
      let contractRevision: number | null = null;
      if (task.work_id) {
        const work = getWork(answers, task.work_id);
        if (work?.contract) {
          try {
            const revised = reviseContract(answers, task.work_id, work.revision, work.contract, `anomaly_continue_with_budget: +${this.thresholds.continue_budget_windows} windows`, now);
            contractRevision = revised.revision;
            // 任务随新契约版本续跑，避免下一 tick controlValid 判定为 superseded。
            this.db.run("UPDATE tasks SET contract_revision=?, updated_at=? WHERE task_id=?", [revised.revision, now, task.task_id]);
          } catch (error) {
            ev("anomaly_contract_revision_failed", { error: String(error) });
          }
        }
        upsertAnomalyBudget(this.db, task.work_id, { continuation_windows_remaining: this.thresholds.continue_budget_windows }, now);
      }
      clearStop();
      ev("anomaly_continue_with_budget", { receipt: receiptId, windows: this.thresholds.continue_budget_windows, contract_revision: contractRevision });
      recordApplied("ok");
      return;
    }
    if (answer === "narrow_or_redirect") {
      // §6.3：影响 objective/scope/acceptance 才创建契约新版本；这里不自动闭环——
      // 卡片保持 open、任务保持围栏，等用户通过契约修订入口 reviseContract 时自动 supersede 此卡。
      ev("anomaly_narrow_or_redirect", { receipt: receiptId, reason: "contract_revision_needed" });
      recordApplied("ok");
      return;
    }
    if (answer === "stop") {
      transition(this.db, task.task_id, "human_abandon", { reason: "anomaly_stop" }, now);
      this.setAttentionState(answers, itemId, "resolved", "succeeded", now, { resume_state: "stopped" });
      recordApplied("ok");
      return;
    }
  }

  private setAttentionState(answers: Database, itemId: string, state: "open" | "applying" | "resolved" | "superseded", effect: "not_started" | "applying" | "succeeded" | "failed" | "unknown", now: number, evidencePatch?: Record<string, unknown>): void {
    const existing = getAttention(answers, itemId);
    if (!existing) return;
    const evidence = evidencePatch ? { ...(existing.evidence as Record<string, unknown>), ...evidencePatch } : existing.evidence;
    upsertAttention(answers, { ...existing, expected_revision: existing.revision, state, effect_state: effect, evidence }, now);
  }

  private handleUnconfirmedTimeout(task: Task, now: number): void {
    const ev = (event: string, detail: Record<string, unknown>) => {
      this.db.run(
        "INSERT INTO task_events(task_id,at,from_state,to_state,event,detail) VALUES(?,?,?,?,?,?)",
        [task.task_id, now, task.state, task.state, event, JSON.stringify(detail)],
      );
    };
    let exited = false;
    if (task.runner_pid == null || !task.attempt_id) {
      exited = true;
    } else {
      const alive = defaultPidAlive(task.runner_pid);
      const probe = probeRunnerLiveness(this.ledgerPath, task.task_id, task.attempt_id);
      exited = !alive || (probe.kind === "found" && probe.ended);
    }
    if (exited) {
      this.db.run("UPDATE tasks SET stop_state='stopped_confirmed', stop_deadline_at=NULL, updated_at=? WHERE task_id=? AND stop_state='stop_unconfirmed'", [now, task.task_id]);
      ev("anomaly_stopped_confirmed", { via: "timeout_reprobe" });
      this.updateCardUrgency(task, "inbox", now);
    } else {
      // §6.1/§12：超过持久期限后只产生唯一 human_only 占用处理决定（confirm-stopped / keep-held）。
      // requestApproval 自带去重（同 task+gate 未消费 approval 复用），不再无限刷新 deadline。
      const existing = this.db.query("SELECT approval_id FROM approvals WHERE task_id=? AND gate='confirm_stopped' AND consumed_at IS NULL").get(task.task_id) as { approval_id: string } | undefined;
      if (!existing) {
        requestApproval(
          this.db,
          this.spool,
          task.task_id,
          "confirm_stopped",
          "Runner stop unconfirmed: process identity mismatch or liveness unknown. Occupancy retained.",
          ["confirm-stopped", "keep-held"],
        );
        ev("anomaly_confirm_stopped_requested", { task_id: task.task_id });
      }
    }
  }

  private updateCardUrgency(task: Task, urgency: "now" | "inbox", now: number): void {
    if (!task.work_id) return;
    let answers: Database | null = null;
    try {
      answers = openMailbox(this.answersPath());
      const rows = answers.query("SELECT item_id FROM control_attention WHERE work_id=? AND item_id LIKE 'anomaly:%'").all(task.work_id) as { item_id: string }[];
      for (const r of rows) {
        const existing = getAttention(answers, r.item_id);
        if (existing && existing.urgency !== urgency) {
          upsertAttention(answers, { ...existing, expected_revision: existing.revision, urgency }, now);
        }
      }
    } finally {
      answers?.close();
    }
  }
}
