import { createHash } from 'node:crypto'

export type SignalKind = 'fix_loop_exhausted' | 'divergence_detected'
export type SignalConfidence = 'machine' | 'weak'
export type CheckStatus = 'pass' | 'fail' | 'unknown' | 'not_run'

export type CheckResultItem = {
  check_id: string
  status: CheckStatus
  fingerprint: string | null // fail 时归一化后的指纹；pass/unknown/not_run 为 null
  check_def_version: string // 检查定义版本哈希，防止改脚本制造进展
}

export type SignalSample = {
  window_at: number // 采样窗时间戳
  commit_count: number // git rev-list --count base..HEAD
  diff_added: number // git diff --numstat 求和
  diff_deleted: number
  result_set_version: number // 关联 attempt_check_results 的结果集版本
  checks: CheckResultItem[] // 该窗采集到的逐项检查结果
}

export type SignalSnapshot = {
  sampled_windows: number
  commit_count: number
  churn_rate: number // 当前窗 churn 相对近若干窗中位数的倍数
  checks_passed: number
  checks_failed: number
  passed_delta_last_windows: number // 近 N 窗 fail→pass 次数，停滞时为 0
  fix_rounds_same_fingerprint: number
  first_seen_at: number
  triggered_at: number
}

export type BlockedInvariant = {
  check_id: string
  last_failure_summary: string
  evidence_ref: string | null
}

export type AnomalyResult = {
  kind: SignalKind | null // null 表示未触发
  confidence: SignalConfidence
  fingerprint: string | null // fix_loop_exhausted 时为卡滞指纹；divergence 可省略
  snapshot: SignalSnapshot | null
  blocked_invariant: BlockedInvariant | null
}

export type AnomalyThresholds = {
  fix_loop_same_fingerprint_limit: number
  signal_sample_window_ms: number
  churn_median_multiplier: number
  invariant_flat_windows: number
  continue_budget_windows: number
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  fix_loop_same_fingerprint_limit: 5,
  signal_sample_window_ms: 60000,
  churn_median_multiplier: 3,
  invariant_flat_windows: 3,
  continue_budget_windows: 2,
}

// §8/§12：阈值与判定逻辑版本指纹。默认阈值或判定逻辑变化时手动 bump LOGIC_VERSION，
// 使触发账本可追溯本次判定依据的阈值版本。
const THRESHOLD_LOGIC_VERSION = 1
export const THRESHOLD_VERSION = `thr_${createHash('sha256').update(JSON.stringify(DEFAULT_THRESHOLDS) + '#v' + THRESHOLD_LOGIC_VERSION).digest('hex').slice(0, 12)}`

// 归一化失败指纹：剥离绝对路径、时间戳、行号、临时目录，保留错误类别、断言标识、调用栈关键帧。
// 用 SHA-256 取前 16 字符 hex。
export function normalizeFingerprint(raw: string): string {
  let s = raw.toLowerCase()
  // 临时目录与绝对路径（unix）
  s = s.replace(/\/(tmp|var\/folders|users)[^\s:)]*/g, ' ')
  // windows 绝对路径
  s = s.replace(/[a-z]:\\[^\s:)]*/g, ' ')
  // ISO 时间戳与裸日期
  s = s.replace(/\b\d{4}-\d{2}-\d{2}t[\d.:+z-]+\b/g, ' ')
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ')
  // 大数字 unix 时间戳
  s = s.replace(/\b\d{10,}\b/g, ' ')
  // file.ts:12:34 形式的行列号
  s = s.replace(/[\w.-]+\.\w+:\d+(?::\d+)?/g, ' ')
  // 残留的 :行号
  s = s.replace(/:\d+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(s).digest('hex').slice(0, 16)
}

type Streak = { count: number; firstSeenAt: number }
type Trigger = { kind: SignalKind; windowAt: number; fingerprint: string | null; firstSeenAt: number; rounds: number }

function medianOf(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function effectiveChecks(sample: SignalSample): CheckResultItem[] {
  return sample.checks.filter(c => c.status === 'fail' || c.status === 'pass')
}

// 主判定函数：纯函数，输入采样序列，输出信号类型与级别。
export function evaluateAnomaly(samples: SignalSample[], thresholds?: Partial<AnomalyThresholds>): AnomalyResult {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds ?? {}) }
  const empty: AnomalyResult = { kind: null, confidence: 'weak', fingerprint: null, snapshot: null, blocked_invariant: null }
  if (samples.length === 0) return empty

  const machineReadable = samples.some(s => effectiveChecks(s).length > 0)
  const streaks = new Map<string, Streak>()
  const progressHistory: number[] = []
  let flatCount = 0
  let trigger: Trigger | null = null
  let triggerFailItem: CheckResultItem | null = null

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    progressHistory.push(0)
    const effective = effectiveChecks(s)
    if (effective.length === 0) continue // unknown/not_run/空窗：不产生进展，也不断裂连续轮数

    const failItems = effective.filter(c => c.status === 'fail')

    if (i > 0) {
      const prevMap = new Map(effectiveChecks(samples[i - 1]).map(c => [c.check_id, c]))
      for (const cur of effective) {
        const prev = prevMap.get(cur.check_id)
        // fail→pass 才算进展：unknown、not_run、缺项、check_def_version 变化都不算
        if (prev && prev.status === 'fail' && cur.status === 'pass' && prev.check_def_version === cur.check_def_version) {
          progressHistory[i]++
          if (prev.fingerprint && streaks.has(prev.fingerprint)) streaks.delete(prev.fingerprint)
        }
      }
    }

    const currentFps = new Set<string>()
    for (const item of failItems) {
      if (!item.fingerprint) continue
      currentFps.add(item.fingerprint)
      const existing = streaks.get(item.fingerprint)
      if (existing) existing.count++
      else streaks.set(item.fingerprint, { count: 1, firstSeenAt: s.window_at })
    }
    // 指纹消失：连续轮数断裂
    for (const fp of [...streaks.keys()]) if (!currentFps.has(fp)) streaks.delete(fp)

    const progressCount = progressHistory[i]
    flatCount = progressCount > 0 || failItems.length === 0 ? 0 : flatCount + 1

    if (!trigger) {
      for (const [fp, st] of streaks) {
        if (st.count >= t.fix_loop_same_fingerprint_limit) {
          trigger = { kind: 'fix_loop_exhausted', windowAt: s.window_at, fingerprint: fp, firstSeenAt: st.firstSeenAt, rounds: st.count }
          triggerFailItem = failItems.find(c => c.fingerprint === fp) ?? null
          break
        }
      }
    }

    // divergence：高 churn AND invariant 停滞，两者同时成立
    if (!trigger && samples.length >= 3) {
      const churns = samples.slice(0, i + 1).map(x => x.diff_added + x.diff_deleted)
      const med = medianOf(churns)
      const cur = churns[churns.length - 1]
      const high = med === 0 ? cur > 0 : cur >= t.churn_median_multiplier * med
      if (high && flatCount >= t.invariant_flat_windows && failItems.length > 0) {
        trigger = { kind: 'divergence_detected', windowAt: s.window_at, fingerprint: null, firstSeenAt: s.window_at, rounds: 0 }
        triggerFailItem = failItems[0]
      }
    }
  }

  const last = samples[samples.length - 1]
  const churns = samples.map(s => s.diff_added + s.diff_deleted)
  const med = medianOf(churns)
  const curChurn = churns[churns.length - 1]
  const snapshot: SignalSnapshot = {
    sampled_windows: samples.length,
    commit_count: last.commit_count,
    churn_rate: med > 0 ? curChurn / med : curChurn,
    checks_passed: last.checks.filter(c => c.status === 'pass').length,
    checks_failed: last.checks.filter(c => c.status === 'fail').length,
    passed_delta_last_windows: progressHistory.slice(-t.invariant_flat_windows).reduce((a, b) => a + b, 0),
    fix_rounds_same_fingerprint: trigger?.kind === 'fix_loop_exhausted' ? trigger.rounds : 0,
    first_seen_at: trigger?.firstSeenAt ?? last.window_at,
    triggered_at: trigger?.windowAt ?? last.window_at,
  }

  const kind = machineReadable ? trigger?.kind ?? null : null
  const blocked: BlockedInvariant | null =
    kind && triggerFailItem
      ? {
          check_id: triggerFailItem.check_id,
          last_failure_summary:
            kind === 'fix_loop_exhausted'
              ? `check "${triggerFailItem.check_id}" still failing after ${trigger!.rounds} rounds with fingerprint ${trigger!.fingerprint}`
              : `invariant stalled while churn spiked; check "${triggerFailItem.check_id}" still failing`,
          evidence_ref: triggerFailItem.fingerprint,
        }
      : null

  return {
    kind,
    confidence: machineReadable ? 'machine' : 'weak',
    fingerprint: kind === 'fix_loop_exhausted' ? trigger?.fingerprint ?? null : null,
    snapshot,
    blocked_invariant: blocked,
  }
}
