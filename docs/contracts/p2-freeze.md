> **历史文档**：本文件描述的部分能力（如 outbox/digest/attrib/Island 原生面板）已从代码中移除，不代表当前实现。

# P2 冻结契约（owner 独占；worker 只读）

依据：`docs/plans/overload-20260813-tech-solution.md` §2.2/§2.4a-c/§2.5/§3/§4-P2。
执行契约：`src/shared/types.ts`（P2 扩展已冻结）。P1 契约（p1-freeze.md）继续有效。

## 模块边界与独占权

| 路径 | 独占 owner | 内容 |
|---|---|---|
| `src/shared/types.ts`, `docs/**`, `.dispatch/**` | Owner（冻结） | — |
| `src/ingest/**`, `src/cli/**` | N5 | schema 演进、reducer 全状态机、classifier、queue CLI |
| `src/recon/**` | N6 | 对账守护（只写 admin spool 事件，不写 DB） |
| `src/notify/**`, `scripts/**`, `launchd/**` | N7 | outbox 投递守护、osascript sink、watchdog |
| `test/**` | N8 | 六注入验收 + P2 单测 |

跨模块导入规则：N6/N7 可 **只读 import** `src/ingest/ingest.ts` 导出的 `initializeLedger`/`openLedger` 与 `src/shared/types.ts`；不得修改他人文件。

## Schema 增量（N5 实现，字段名冻结）

```sql
CREATE TABLE IF NOT EXISTS current(
  stable_id TEXT PRIMARY KEY, writer_id TEXT, state TEXT NOT NULL,
  queue TEXT, q5_reason TEXT, origin TEXT NOT NULL DEFAULT 'unknown',
  last_ingest_seq INTEGER, last_event_at INTEGER, last_heartbeat_at INTEGER, frozen INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS queue_transitions(
  id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, queue TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN('entered','left')), at INTEGER NOT NULL,
  source_seq INTEGER NOT NULL, classifier_version INTEGER NOT NULL,
  UNIQUE(subject, queue, direction, source_seq, classifier_version));
CREATE TABLE IF NOT EXISTS classifier_activations(
  version INTEGER PRIMARY KEY, activated_at_journal_seq INTEGER NOT NULL, activated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notifications(
  notification_uid INTEGER PRIMARY KEY AUTOINCREMENT, request_uid TEXT NOT NULL,
  sink TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('initial','reminder')),
  reminder_seq INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK(state IN('pending','attempting','sent','failed_permanent')),
  attempt_at INTEGER, sent_at INTEGER, retry_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(request_uid, sink, kind, reminder_seq));
CREATE TABLE IF NOT EXISTS attachments(
  stable_id TEXT NOT NULL, platform TEXT NOT NULL, binding TEXT NOT NULL,
  observed_at INTEGER NOT NULL, valid INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(stable_id, platform));
CREATE TABLE IF NOT EXISTS incidents(
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, opened_at INTEGER NOT NULL,
  closed_at INTEGER, detail TEXT, UNIQUE(source, opened_at));
CREATE TABLE IF NOT EXISTS coverage_gaps(
  id INTEGER PRIMARY KEY AUTOINCREMENT, stable_id TEXT, emitter_id TEXT NOT NULL,
  from_seq INTEGER, from_at INTEGER, to_at INTEGER NOT NULL, reason TEXT NOT NULL);
ALTER TABLE requests ADD COLUMN next_reminder_at INTEGER;  -- 已在 P1 DDL 者跳过
```

## 协议（跨节点，逐条对照终版方案）

1. **reducer 状态机（N5）** §2.4a：映射 `working→working / settled→idle / decision_requested(pending)→awaiting_human / session_ended→done / session_vanished→vanished`；终态 sticky；扩展事件 > 对账事件（活状态）；迟到事件只入 journal。origin：session_started.detail.parent > attachment/orca 谱系事件 > unknown（按 agent 处理）。
2. **classifier（N5）** §2.4b/c：纯函数 `(current, event) → transitions`；`CLASSIFIER_VERSION` 常量起版 1，激活时向 admin spool 写 `classifier_activated`（复用 P1 kind）并落 `classifier_activations` 水位；queue_transitions 幂等键=UNIQUE 五元组；重放不清表。Q1=requests.pending；Q2=done∧origin∈{agent,unknown}；Q3=working/idle∧心跳未超；Q5 按 `Q5Reason` 互斥。
3. **orphan 触发（N5 消费，N6 产生）**：唯一触发 = `emitter_drained` 事件（N6 在 kill-0 确认死亡 + `DRAIN_GRACE_MS` + 该 emitter 全部文件 cursor==size 后发出）。reducer 收到后：该 emitter 的 pending requests → orphaned（Q5 orphaned_request）+ 写 coverage_gaps 尾部记录 [last ingested seq at, drained at]。源终态覆盖推断终态规则（P1 已实现）保持。
4. **outbox 入队（N5）** §2.5：reducer 在把 request 置 pending 的**同一事务**插入 notifications(initial, pending, reminder_seq=0)。**提醒插入（N7）**：单事务 {条件: state=pending ∧ 无 pending/attempting 行 ∧ now≥requests.next_reminder_at；动作: 插 reminder 行(reminder_seq=prev+1) + next_reminder_at=now+REMINDER_INTERVAL_MS}。
5. **投递（N7）**：事务标 attempting→执行 sink→事务标 sent；attempting 超 `ATTEMPTING_RETRY_GRACE_MS` 重试；sink 失败按 `SINK_BACKOFF_MIN` 退避（state 回 pending，retry_count++），第 6 次失败→failed_permanent（CLI q1 置顶显示）。at-least-once 显式。sink 接口：`{deliver(n: NotificationRow, ctx): Promise<void>}`，生产实现 osascript `display notification`，测试实现文件 sink（写行到指定路径）——sink 由 `--sink osascript|file:<path>` 选择。
6. **对账（N6）**：每 60s（配置化）拉 `herdr agent list --json`、`orca worktree ps --json`、`~/.cmuxterm/*-hook-sessions.json` + 对已知 live emitter 做 kill-0/comm 比对。产出**只有 admin spool 事件**（kinds 见 types.ts P2 段；envelope runtime="overload"，emitter=`overload-<pid>-<boot8>`，seq 单调，复用 P1 spool 写入约束：换行终止、代际文件、计数器字段置 0）。source_outage 聚合：同一 source 断连期间只发一次，恢复发 source_recovered；期间不得发任何该 source 派生的 per-session 判定（冻结由 reducer 依据 incident 实施）。vanished 只在完整快照（CLI rc=0 且 JSON 解析成功）证明缺失时发。平台 CLI 输出解析失败=该 source outage，不是空快照。
7. **watchdog（N7）**：`scripts/watchdog.sh` + `launchd/` plists（不自动安装，附 README 安装命令）；monotonic 时钟（比对 wall/monotonic 差识别睡眠唤醒）；先 `launchctl list` 确认 ingest 进程态再告警；告警走 osascript。
8. **CLI（N5）**：`overload q1`（pending 请求+failed_permanent 置顶+跳转 binding）、`overload q2`、`overload zombie`（按 reason 分组）、`overload health`（incidents+coverage_gaps+unmanaged 计数）。

## 验收（六注入，N8 实现 harness）

| # | 注入 | 期望 |
|---|---|---|
| 1 | 合成 decision_requested 无 resolve | Q1 出现 + initial 通知行 sent（file sink） |
| 2 | 杀假 emitter（kill -9）后 recon 跑 | emitter_dead→drained（宽限可配短）→orphaned_request + coverage_gap 行 |
| 3 | 活进程无 spool writer（合成 herdr 快照 + 无 spool） | telemetry_gap 事件 + Q5 行；无风暴 |
| 4 | 平台 CLI 不可达（PATH 撤掉/假 CLI rc=1） | 单条 incident；session 冻结标记；恢复后 closed_at 回填；期间零 per-session 告警 |
| 5 | 投递两步间 kill notifier | 重启后 attempting 重试，最终 sent；无重复 initial 行（UNIQUE 兜底） |
| 6 | file sink 强制失败 ×6 | 退避序列正确（attempt_at 间隔）→failed_permanent + q1 置顶展示 |

harness 全部走隔离 HOME（P1 模式），对账 CLI 用可注入的假命令（`--herdr-cmd`/`--orca-cmd` 参数或 PATH shim），绝不碰真实平台状态。

## 完成信号

同 P1：worktree 内 `.done/<attempt_id>`（内容=最终 commit sha），全部工作按逻辑单元提交。
