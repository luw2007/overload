import { expect, test } from 'bun:test'
import {
  DEFAULT_THRESHOLDS,
  evaluateAnomaly,
  normalizeFingerprint,
  type CheckResultItem,
  type SignalSample,
} from './anomaly'

function failCheck(id: string, fingerprint: string, def = 'v1'): CheckResultItem {
  return { check_id: id, status: 'fail', fingerprint, check_def_version: def }
}
function passCheck(id: string, def = 'v1'): CheckResultItem {
  return { check_id: id, status: 'pass', fingerprint: null, check_def_version: def }
}
function unknownCheck(id: string): CheckResultItem {
  return { check_id: id, status: 'unknown', fingerprint: null, check_def_version: 'v1' }
}
function sample(at: number, checks: CheckResultItem[], over: Partial<SignalSample> = {}): SignalSample {
  return { window_at: at, commit_count: 1, diff_added: 10, diff_deleted: 5, result_set_version: 1, checks, ...over }
}

const ERROR_A = 'expected status 200 but got 500 at api handler'
const ERROR_B = 'assertion failed: user balance should be positive'
const FP_A = normalizeFingerprint(ERROR_A)
const FP_B = normalizeFingerprint(ERROR_B)

// 1. 同一指纹累计 5 轮无进展 → fix_loop_exhausted
test('same fingerprint 5 rounds no progress triggers fix_loop_exhausted', () => {
  const windows = [1, 2, 3, 4, 5].map(i => sample(i, [failCheck('c1', FP_A)], { window_at: i * 60000 }))
  const result = evaluateAnomaly(windows)
  expect(result.kind).toBe('fix_loop_exhausted')
  expect(result.fingerprint).toBe(FP_A)
  expect(result.confidence).toBe('machine')
  expect(result.snapshot?.fix_rounds_same_fingerprint).toBe(5)
  expect(result.snapshot?.first_seen_at).toBe(60000)
  expect(result.snapshot?.triggered_at).toBe(5 * 60000)
  expect(result.blocked_invariant?.check_id).toBe('c1')
})

// 2. 检查项恢复通过后连续计数清零
test('fail→pass resets streak, no circuit', () => {
  const windows = [
    ...[1, 2, 3, 4].map(i => sample(i * 60000, [failCheck('c1', FP_A)])),
    sample(5 * 60000, [passCheck('c1')]),
    ...[6, 7, 8, 9].map(i => sample(i * 60000, [failCheck('c1', FP_A)])),
  ]
  const result = evaluateAnomaly(windows)
  expect(result.kind).toBeNull()
})

// 3. 高 churn 单独出现不触发
test('high churn alone does not trigger', () => {
  const windows = [
    sample(1, [failCheck('c1', FP_A)], { diff_added: 10, diff_deleted: 0 }),
    sample(2, [passCheck('c1'), failCheck('c2', FP_B)], { diff_added: 10, diff_deleted: 0 }),
    sample(3, [failCheck('c2', FP_B)], { diff_added: 100, diff_deleted: 0 }),
  ]
  const result = evaluateAnomaly(windows)
  expect(result.kind).toBeNull()
  expect(result.snapshot?.churn_rate).toBe(10) // 100 / median([10,10,100])
})

// 4. 高 churn + 连续 3 窗无检查进展 → divergence_detected
test('high churn + 3 flat windows triggers divergence_detected', () => {
  const windows = [1, 2, 3, 4].map(i =>
    sample(i * 60000, [failCheck('c1', FP_A)], { diff_added: i === 4 ? 100 : 10, diff_deleted: 0 }),
  )
  const result = evaluateAnomaly(windows)
  expect(result.kind).toBe('divergence_detected')
  expect(result.snapshot?.fix_rounds_same_fingerprint).toBe(0)
  expect(result.snapshot?.passed_delta_last_windows).toBe(0)
})

// 5. 失败总数不变但失败集合替换时，按 check_id 识别真实 fail→pass
test('replaced failure set still recognizes check_id-based fail→pass', () => {
  const windows = [
    sample(1, [failCheck('c1', FP_A)]),
    sample(2, [passCheck('c1'), failCheck('c2', FP_B)]),
    sample(3, [failCheck('c2', FP_B)]),
    sample(4, [failCheck('c2', FP_B)]),
    sample(5, [failCheck('c2', FP_B)]),
    sample(6, [failCheck('c2', FP_B)]),
  ]
  const result = evaluateAnomaly(windows)
  expect(result.kind).toBe('fix_loop_exhausted')
  expect(result.fingerprint).toBe(FP_B)
  expect(result.blocked_invariant?.check_id).toBe('c2')
})

// 6. unknown/not_run/缺项/check_def_version 变化不算进展
test('unknown windows do not reset streak; def change is not progress', () => {
  const windows = [
    sample(1, [failCheck('c1', FP_A)]),
    sample(2, [unknownCheck('c1')]),
    sample(3, [failCheck('c1', FP_A)]),
    sample(4, [unknownCheck('c1')]),
    sample(5, [failCheck('c1', FP_A)]),
    sample(6, [failCheck('c1', FP_A)]),
    sample(7, [failCheck('c1', FP_A)]),
  ]
  const result = evaluateAnomaly(windows)
  expect(result.kind).toBe('fix_loop_exhausted')
  expect(result.fingerprint).toBe(FP_A)

  // check_def_version 变化的 pass 不算进展
  const versionChanged = [
    sample(1, [failCheck('c1', FP_A, 'v1')]),
    sample(2, [passCheck('c1', 'v2')]),
    sample(3, [failCheck('c1', FP_A, 'v2')]),
  ]
  const r2 = evaluateAnomaly(versionChanged)
  expect(r2.kind).toBeNull()
  expect(r2.snapshot?.passed_delta_last_windows).toBe(0)
})

// 7. checks 为空 → weak, kind=null
test('empty checks yields weak confidence and no circuit', () => {
  const windows = [sample(1, []), sample(2, []), sample(3, [unknownCheck('c1')])]
  const result = evaluateAnomaly(windows)
  expect(result.confidence).toBe('weak')
  expect(result.kind).toBeNull()
})

// 8. 新指纹另开计数，不与旧指纹混算
test('new fingerprint starts its own count', () => {
  const windows = [
    ...[1, 2, 3, 4].map(i => sample(i, [failCheck('c1', FP_A)])),
    ...[5, 6, 7, 8, 9].map(i => sample(i, [failCheck('c1', FP_B)])),
  ]
  const result = evaluateAnomaly(windows)
  expect(result.kind).toBe('fix_loop_exhausted')
  expect(result.fingerprint).toBe(FP_B)
  expect(result.snapshot?.first_seen_at).toBe(5)
})

// 9. 中位数计算正确性（含 0 边界）
test('median computation including zero boundary', () => {
  // median = 0 且当前窗 churn > 0 → 高
  const zeroMedian = [1, 2, 3, 4].map(i =>
    sample(i, [failCheck('c1', FP_A)], { diff_added: i === 4 ? 100 : 0, diff_deleted: 0 }),
  )
  const r1 = evaluateAnomaly(zeroMedian)
  expect(r1.kind).toBe('divergence_detected')
  expect(r1.snapshot?.churn_rate).toBe(100)

  // 当前窗未达 multiplier → 不高
  const below = [sample(1, [failCheck('c1', FP_A)], { diff_added: 10, diff_deleted: 0 }), sample(2, [failCheck('c1', FP_A)], { diff_added: 10, diff_deleted: 0 }), sample(3, [failCheck('c1', FP_A)], { diff_added: 12, diff_deleted: 0 })]
  const r2 = evaluateAnomaly(below)
  expect(r2.kind).toBeNull()
  expect(r2.snapshot?.churn_rate).toBe(1.2) // 12 / median([10,10,12])=10

  // 不足 3 窗不判定 churn
  const twoWindows = [sample(1, [failCheck('c1', FP_A)], { diff_added: 100 }), sample(2, [failCheck('c1', FP_A)], { diff_added: 100 })]
  expect(evaluateAnomaly(twoWindows).kind).toBeNull()
})

// 10. 自定义 thresholds 覆盖默认值
test('custom thresholds override defaults', () => {
  const windows = [sample(1, [failCheck('c1', FP_A)]), sample(2, [failCheck('c1', FP_A)])]
  const tight = evaluateAnomaly(windows, { fix_loop_same_fingerprint_limit: 2 })
  expect(tight.kind).toBe('fix_loop_exhausted')

  const loose = evaluateAnomaly(windows, { fix_loop_same_fingerprint_limit: 10 })
  expect(loose.kind).toBeNull()
})

test('normalizeFingerprint strips paths, timestamps and line numbers', () => {
  const a = normalizeFingerprint('Error at /Users/luwei/ai/overload/src/index.ts:42:9 expected 200')
  const b = normalizeFingerprint('error at /tmp/abc123/deep.ts:99 expected 200')
  expect(a).toBe(b)
  expect(a).toHaveLength(16)
  expect(DEFAULT_THRESHOLDS.fix_loop_same_fingerprint_limit).toBe(5)
})

test('empty input returns weak result with null snapshot', () => {
  const result = evaluateAnomaly([])
  expect(result).toEqual({ kind: null, confidence: 'weak', fingerprint: null, snapshot: null, blocked_invariant: null })
})
