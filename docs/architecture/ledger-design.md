> **已取代**：本文档是初版设计，已被 `overload-20260813-tech-solution.md`（sol 对齐终版）取代；队列谓词与 schema 在终版 §2 中有实质修订（emitter/writer 分离、requests/outbox 契约、封段 spool 等）。保留作演进记录。

# Overload: 统一 Session Ledger + 注意力路由设计

目标：100+ agent session 场景下，把人工触点压到每天 ≤30 个决策；修掉「approve/done 之后找不到会话」。
原则：①② 层全部确定性代码，不含 LLM；LLM 只出现在 ③ digest 层。approval 通道永不经过 LLM 判断。

## 0. 量化目标与验收

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 人工触点 | ≤30 决策/天 | ledger 统计 Q1+Q2 出队数 |
| approval 推送延迟 | p95 ≤ 30s | 事件时间戳 vs 推送时间戳 |
| 漏报 | 0（任何 blocked session 必入 Q1/Q5） | 注入测试：人为 block 一个 session，验证告警 |
| terminal session 可查 | 100% | done/approve 后按 stable_id 查 journal 必命中 |

## 1. 架构

```
orca adapter ─┐
herdr adapter ─┼→ events journal (append-only) → current view → classifier → Q1..Q5 → sinks
cmux adapter ─┘         (SQLite)                  (派生表)      (纯规则)          ├ Q1: 即时推送
                                                                                ├ Q2: 定时 digest
                                                                                └ Q5: watchdog 告警
```

- 存储：单文件 SQLite（`~/ai/overload/ledger.db`）。无服务、无队列中间件。
- 采集：每个 adapter 一个轮询循环（间隔配置化，默认 15s）；herdr 额外用 `agent wait --until blocked` 做低延迟 blocked 监听。
- journal 只追加；current view 由 journal 派生。session 进入 terminal 态是追加一条 event，**永不删除行** —— 这直接修「done 后找不到会话」。

## 2. Ledger Schema

```sql
-- 权威身份表。stable_id = "<platform>:<native_id>"
CREATE TABLE sessions (
  stable_id     TEXT PRIMARY KEY,   -- e.g. "herdr:term_658e6387cc95e4"
  platform      TEXT NOT NULL,      -- orca | herdr | cmux
  native_id     TEXT NOT NULL,      -- 平台内 join 键，见 §4
  origin        TEXT NOT NULL,      -- human | agent
  parent_id     TEXT,               -- origin=agent 时指向父 session stable_id
  title         TEXT,
  cwd           TEXT,
  repo          TEXT,
  branch        TEXT,
  created_at    INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL
);

-- append-only 事件流。分类器与 UI 的唯一事实来源。
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  stable_id  TEXT NOT NULL REFERENCES sessions(stable_id),
  at         INTEGER NOT NULL,
  kind       TEXT NOT NULL,  -- 见 §3 事件类型
  detail     TEXT             -- 窄 JSON：state、tool、prompt 摘要；禁止整段 payload
);

-- 派生 current view（物化，采集循环内重算受影响行）
CREATE TABLE current (
  stable_id      TEXT PRIMARY KEY,
  state          TEXT NOT NULL,  -- idle|working|blocked|done|failed|unknown|vanished
  blocked_on     TEXT,           -- approval|review|input|NULL
  queue          TEXT NOT NULL,  -- Q1..Q5|archived
  last_event_seq INTEGER NOT NULL,
  last_output_at INTEGER,
  unread         INTEGER DEFAULT 0
);
```

## 3. 事件类型与 diff 契约

统一状态词汇采用 herdr 枚举：`idle | working | blocked | done | unknown`，各平台映射见 §4。

事件类型（snapshot diff 产生，遵循 pull-adapter skill 契约）：

- `discovered` — unseen → any
- `state_changed` — 状态迁移，detail 记 from/to
- `blocked` — → blocked，detail 记 blocked_on 与触发物（工具名/prompt 摘要）
- `unblocked` — blocked → working/idle
- `terminal` — → done/failed。**与 pending blocked 竞态时，先发 `unblocked` 再发 `terminal`**
- `vanished` — 上一轮完整 snapshot 存在、本轮完整 snapshot 缺失。只有 lifecycle source 读取成功才允许发；enhancer 不可用时**冻结现状，不清任何 state**
- `source_unavailable` — 平台探测失败，全平台 session 状态冻结并计数；连续 N 轮（默认 4）不可用 → 自身入 Q5 告警

## 4. Adapter 契约（per pull-adapter skill Data Source Rules）

### 4.1 herdr（已探明，置信度高）

- 端点：`herdr agent list --json`（轮询）＋ `herdr agent wait <target> --until blocked --timeout <ms>`（事件监听）
- native_id：`terminal_id`（稳定）；辅助键 `pane_id`、`workspace_id`
- 状态源：`agent_status ∈ {idle, working, blocked, done, unknown}` —— **直接就是统一词汇，零映射**
- `state_change_seq` 单调递增：用于跳过无变化行、检测漏拉
- 可创建 session：否（只观测）。可删除：否
- unavailable = CLI 非零退出/socket 拒绝；empty = `agents: []`（合法，代表无 agent）
- blocked_on 细分（approval vs input）需读 `herdr agent read` 尾部输出判别 → **P2 前先只标 blocked，不猜细分**

### 4.2 orca（部分探明）

- 端点：`orca worktree ps --json`（91 行实测）；terminal 级需补探 `orca terminal list --json`
- native_id：`worktreeInstanceId`（uuid，稳定）；`worktreeId` 含路径，重建 worktree 会变，只作辅助
- origin 谱系：`parentWorktreeId` 非空 → origin=agent，parent_id 直接可填 —— **你要的"区分 agent 启动/人启动"在 orca 侧是现成字段**
- 状态映射（待 probe 确认全枚举，禁止 hardcode）：`workspaceStatus=in-progress` → working/idle；`isArchived=true` → archived；`unread=1` ∧ `lastOutputAt` 停滞 → 候选 blocked
- approval 信号：capabilities 含 `terminal.query-reply-input.v1` —— probe 项 P-1：找到一个真实 pending approval 的 worktree，抓 terminal 级字段真值
- unavailable = `orca status --json` 失败或 `runtime.state != ready`；empty ≠ unavailable

### 4.3 cmux（待探）

- approval 信号走 agent hooks → Feed（`cmux docs agents` 证实 "Feed approvals"）
- probe 项 P-2：`cmux hooks setup` 后抓 feed 的读取端点与事件 schema；确认 feed 是否可追溯历史（决定它是 lifecycle source 还是 enhancer）
- 在 P-2 完成前 cmux 标记为 `unsupported`，不写猜测的 SQL/字段

### 4.4 pi（横切）

所有 worker 经 `pi` 启动（orchestration-policy），pi session 状态可能是比终端文本更结构化的 blocked_on 来源。probe 项 P-3：pi 是否暴露 session 级 approval-pending 状态。

## 5. 五队列判定规则（纯谓词，无 LLM）

| 队列 | 谓词 | 介入模式 | SLA/阈值（config.toml，均可调） |
|---|---|---|---|
| Q1 待批准 | `state=blocked ∧ blocked_on∈{approval,input}` | 即时推送（`herdr notification show` / 系统通知） | 推送 ≤30s；15min 未处理重提醒 |
| Q2 待 review | `state=done ∧ origin=agent ∧ ¬auto_verified` | 定时 digest 批处理 | digest 间隔 2h；单批 ≤50 项 |
| Q3 运行中 | `state=working` | 不看 | — |
| Q4 完成免检 | `state=done ∧ auto_verified` | 抽查（digest 尾部附计数+抽样 3 条） | 抽样率 5% |
| Q5 zombie | `state∈{working,unknown} ∧ now-last_output_at > timeout` ∨ `vanished` ∧ 非 terminal ∨ adapter 连续 unavailable | watchdog 告警 | 窄任务 30min，宽任务 120min（沿用 orchestration-policy） |

- `auto_verified` v1 定义（保守起步）：session 输出含测试通过证据 ∧ diff 不触碰配置的敏感路径集（默认：`**/prod*`、`**/.env*`、迁移目录）。判定为**确定性文本/路径规则**，不是 LLM 打分。宁可多进 Q2，不可错进 Q4。
- 风险等级从 runtime 字段推导（改动路径、只读与否、测试证据），禁止 hardcode 工具风险清单。

## 6. Sinks

- Q1：macOS 通知 + `herdr notification show`（herdr 内 session）。点击/命令跳转：`herdr agent focus` / `orca open`。
- Q2/Q4：digest 写 `~/ai/overload/digests/<date>-<hh>.md`，按风险排序，每项带一行摘要 + 跳转命令。P3 起由 LLM 生成摘要；P2 用 preview 字段裸拼。
- Q5：独立 watchdog 脚本（launchd，非 agent）。**watchdog 监控采集循环心跳；采集循环挂 → 直接系统告警。禁止用 agent 监控 agent。**

## 7. 分期

- **P1 ledger + 采集**：schema、herdr adapter（全量）、orca adapter（worktree 级）、journal、current view。验收：done 的 session 可按 stable_id 查到全事件史。
- **P2 队列 + 通知 + zombie watchdog**：五队列谓词、Q1 推送、Q5 扫描。前置：probe P-1（orca approval 真值）。验收：§0 注入测试通过。
- **P3 digest**：定时任务 + LLM 摘要（只读 ledger，无写权限）。前置：probe P-2（cmux feed）、P-3（pi）。
- **P4 规则蒸馏**：分析历史处置记录 → 追加 Q4 免检规则。产出物是 config 规则，不是 prompt。

## 8. 质量门禁

- 必过场景（P2 完成时自动化测试）：source unavailable 不清 state；pending 出现→Q1 事件；pending 消失（完整读取确认）→ unblocked；blocked+terminal 竞态先 unblocked 后 terminal；vanished 只在完整 lifecycle snapshot 后触发。fixture 用 probe 抓的真实行，抓不到 pending 真值就把 probe 列为前置，不猜枚举。
- 人工复核点：`auto_verified` 谓词的敏感路径集；Q1 推送渠道首次接通；各平台状态映射表首版。

## 9. 非目标（v1）

- 不做 approve/deny 写回桥接：批准动作跳转到平台原生界面执行（terminalNative 模式）。写回需先找到稳定写 API + 契约测试，另立任务。
- 不做 web UI：digest 是 markdown 文件，队列查询是 CLI（`overload q1` 等）。
- 不接 Flux Island 之外的通知渠道。

## 10. 待办 probe 清单

| # | 内容 | 阻塞 |
|---|---|---|
| P-1 | orca terminal 级字段 + pending approval 真值（`terminal.query-reply-input.v1`） | P2 |
| P-2 | cmux feed 读取端点 + 事件 schema + 是否可追溯 | P3(cmux) |
| P-3 | pi session 是否暴露 approval-pending 结构化状态 | P3 |
| P-4 | orca `workspaceStatus`/`status`/`cardStatus` 全枚举 | P1(orca 映射表) |
