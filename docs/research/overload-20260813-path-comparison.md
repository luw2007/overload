# 多路径对比与推荐

日期：2026-08-13。综合本地探测（`overload-20260813-probe-findings.md`）与外部调研（`overload-20260813-external-survey.md`）。目标不变：100+ agent，人工触点 ≤30 决策/天，approval 零漏报，terminal session 100% 可查。

## 候选路径

### 路径 A：自建 pull ledger（现有 plan 的原案）

三平台 CLI 轮询（`herdr agent list` / `orca worktree ps` / cmux 文件）→ SQLite append-only journal → 确定性五队列 → 通知/digest。

- ✅ 完全掌控 source-of-truth；平台故障时冻结语义可控（pull-adapter skill 全套契约适用）。
- ✅ 无需改动任何 agent/平台配置，零侵入。
- ❌ 轮询延迟下限 = 间隔/2；approval p95≤30s 要求 ≤15s 轮询 × 3 平台，常驻开销。
- ❌ herdr 的 `blocked` 不细分 approval/input，需读终端文本启发式判别（脆弱）。
- ❌ orca 侧 approval 真值仍未抓到（R-1），Q1 判定在 orca 侧只能靠 `unread`+停滞启发式。

### 路径 B：pi 扩展事件驱动（新发现，探测后新增）

所有 worker 经 `pi` 启动（orchestration-policy 硬约束）→ 写一个 `overload.ts` pi/OMP 扩展，截获生命周期 + 工具事件 + 审批交互，推送到本地 collector（Unix socket/HTTP）→ 同一个 SQLite journal。

- ✅ **与 host 平台无关**：worker 在 orca/herdr/cmux 哪个终端里跑都被覆盖——绕开了"三平台三套 adapter"的根本复杂度。
- ✅ 三个现成先例（`flux-bridge.ts`、`orca-agent-status.ts`、cmux `cmux-session.ts`）证明扩展 API 能拿到全事件流，且 pi/OMP 双运行时兼容；`orca-agent-status.ts` 的 latest-only pending slot、endpoint 文件、超时防抖等工程问题已有参考实现。
- ✅ 事件里带 cwd/session id/工具输入，approval 事件是结构化的（不是终端文本启发式）。
- ✅ **（源码证实）`tool_call` 事件执行前触发、可 `block`/改参/`terminate`**（`ToolCallEventResult`，types.d.ts:685,778-786）：扩展能直接充当审批门——确定性规则放行低风险、阻塞高风险等远程决策（HumanLayer 的 `needs_approval` 模式原生可落）。pi 本体无逐工具审批 UI，即审批对 pi 舰队是**新增策略层而非桥接**，语义完全自定。
- ❌ 只覆盖 pi 系 agent；直接跑的 claude/codex（如 cmux 里的 codex session）不可见 → 需 cmux hooks 兜底。
- ❌ collector 挂了事件即丢 → 必须配对账（reconciliation）拉取兜底。
- ❌ 扩展崩溃可能影响 pi 本体（先例都用 fire-and-forget + warn-once 防护，风险已知可控）。

### 路径 C：cmux 作为中心收件箱

`cmux hooks setup` 装满 agent CLI 侧钩子 → `workstream.jsonl`（审计）+ `<agent>-hook-sessions.json`（生命周期）+ `cmux events --reconnect`（durable 消费）+ Feed（审批 UI + 原生通知内联按钮）。

- ✅ 基础设施零开发：审计日志、cursor 事件流、审批收件箱、软等待兜底、hibernation 资源治理全部现成。
- ✅ hooks 装在 agent CLI 侧，理论上 orca/herdr 终端里的 claude/codex 也会上报（socket 可达即可）。
- ❌ **致命缺口：pi 桥是 telemetry-only，omp 是 lifecycle-only，均无 Feed 审批卡**——而用户的 worker 全部是 pi 系。堵这个缺口 = 给 cmux 写 pi Feed 桥 ≈ 路径 B 的工作量，却把 source-of-truth 交给第三方 app 的内存信号量（120s 软等待、ring buffer 2000 条）。
- ❌ Feed jump 依赖 `CMUX_SURFACE_ID`，orca/herdr 里的 session 跳转是 no-op。
- ❌ 单点：cmux app 不跑则全瞎。

### 路径 D：迁移到现成舰队工具（Conductor / Vibe Kanban / Claude Squad / Claude Agent View / Omnara）

- ❌ 全部假设"经我启动才可见"，无跨 host 聚合层；采用 = 放弃 orca+herdr+cmux 既有工作方式，迁移成本与锁定风险最高。
- ✅ 价值在模式验证（Agent View 的 working/needs-input/done 三分法）与单点能力借用（Omnara 的手机审批通道可作为 P3 的 sink）。
- 判定：不作为主路径；保留为通道/模式参考。

### 路径 E：助理 agent（陈海超方案）

LLM supervisor 定时读数据 → digest 需介入项。**不是独立路径**：数据层必须由 A/B/C 之一提供。外部调研确认的约束：supervisor 只做摘要排序，approval 判定走确定性管道；规则蒸馏产出配置不产出 prompt；supervisor 用 watchdog 监控而非套娃。

## 对比矩阵

| 维度 | A pull | B pi 扩展 | C cmux | D 迁移 |
|---|---|---|---|---|
| approval 零漏报 | 中（启发式判 blocked） | 高（结构化事件）+ 需兜底 | pi 系不可用 | — |
| 覆盖率（现有舰队） | 100%（host 级） | ~100%（pi 系 worker）| claude/codex 桥好，pi 缺 | 需迁移 |
| p95 延迟 | 轮询间隔/2 | 秒级 | 秒级 | — |
| 开发量 | 3 个 adapter + journal | 1 个扩展 + collector + journal | 1 个 pi Feed 桥（相当于 B） | 0 但迁移成本最高 |
| source-of-truth 自主 | 完全 | 完全 | 交给 cmux | 交给厂商 |
| 平台演进脆弱性 | CLI 字段变更 ×3 | pi 扩展 API ×1 | cmux 内部行为 | 厂商路线图 |
| terminal 可查（journal） | ✅ | ✅ | jsonl 有但语义他定 | ❌ |

## 推荐：B 为主、A 为对账、C 为过渡（push for latency, pull for truth）

1. **事件主干走路径 B**：`overload.ts` pi 扩展（参照 orca-agent-status.ts 工程模式）→ 本地 collector → SQLite journal。approval/lifecycle 事件结构化、秒级、平台无关。
2. **对账层保留路径 A 的骨架但降级**：轮询从"事件源"降为"reconciliation"——每 60s（配置化）拉三平台 CLI 快照，校正 journal（发现 collector 漏事件、进程死亡、vanished session）。pull-adapter skill 的冻结/vanished 契约只需在对账层实现一次。轮询降频后延迟压力消失（延迟由 push 承担）。
3. **过渡期用路径 C 的现成件**：cmux Feed 继续服务 claude/codex 桥好的 session；`workstream.jsonl` 作为 cmux 侧对账输入之一。不给 cmux 写 pi 桥（工作量等于 B 却失去自主权）。
4. **队列/digest/watchdog 沿用 plan 原设计**（§5-§6 不变），路径 E 的 LLM digest 排 P3。
5. **（2026-08-13 舰队盘点后修订，详见 `overload-20260813-fleet-inventory.md` §4）**：B 的扩展目标是 pi/omp/prime-agent 三运行时（~86% 舰队）；claude 本机走既有 cmux shim、devbox 走官方 hooks 直连；ledger 加 host 维度（`<host>:<runtime>:<native_id>`），devbox 起步用 ssh 增量拉取汇聚；存活性判据采纳 prime-agent lease 的 `pid+processStartId` 模式；提交归因（commit↔session 回链）纳入 Q2 验收。

原 plan 需要的修订：§1 架构图加 collector+扩展事件主干；§4 adapter 降级为对账源；probe 清单换成本报告 §5 的 R-1~R-4。

## 尚待验证的假设（进入实现前必须证伪/证实）

| # | 假设 | 验证方式 |
|---|---|---|
| ~~V-1~~ | 已源码证实：事件全集 25 个，`tool_call` 可拦截（见探测报告 §4）；且 pi 无原生审批，扩展即审批门 | 收口 |
| V-2 | 一个扩展文件可同时服务 pi 与 OMP 运行时（先例已做，但 overload 事件集更大） | PoC 双运行时冒烟 |
| V-3 | collector 断连时扩展 fire-and-forget 不阻塞 agent | PoC 杀 collector 观察 pi TUI |
| V-4 | 对账能从 herdr `state_change_seq` / orca `lastActivityAt` 可靠检测漏事件 | 人为丢事件后跑对账 |
