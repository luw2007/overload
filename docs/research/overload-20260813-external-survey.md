# 外部方案调研：多 agent 舰队管理与 HITL 模式

日期：2026-08-13。web 调研 + 官方文档。与本地探测报告（`overload-20260813-probe-findings.md`）配套。

## 1. 业界共识（定量）

- 人的 review 带宽是唯一硬约束：无操作面单人 2-3 个 agent 即失控；有完整操作面（kanban + 注册表 + 告警）约 10-20 个；上百必须靠分层队列 + 阈值自动批准 + 批处理审批（[Knowlee 编排指南](https://www.knowlee.ai/blog/ai-agent-orchestration-guide-2026)）。
- 批量审批适用于"有用但可逆"的动作，单批 10-50 项（[getclaw HITL](https://getclaw.sh/blog/human-in-the-loop-ai-agents-approvals-2026)）。
- 审批门槛的风险法则：不可逆 / 高成本 / 受监管 / 大爆炸半径才要人批（[StackAI](https://www.stackai.com/insights/human-in-the-loop-ai-agents-how-to-design-approval-workflows-for-safe-and-scalable-automation)）。
- 本地实测印证：cmux workstream.jsonl 17,390 事件中可介入者 31 个（0.18%）。

## 2. 舰队管理工具

| 工具 | 形态 | 关键机制 | 对本项目的适用性 |
|---|---|---|---|
| [Claude Code Agent View](https://claudefa.st/blog/guide/agents/agent-view)（2026-05 官方） | 终端全屏 dashboard（`claude agents`） | 后台 session 列表：working / needs-input / done；supervisor 进程保活；不打断 peek | 仅覆盖 claude CLI；pi 启动的 worker 不可见。**状态三分法与 herdr 枚举同构**，验证了统一词汇 |
| Claude Code native agent teams（2026-02） | 单 team session 内 agent 互发消息 | 层级编排原语官方化 | 仅 claude 生态；模式可参考 |
| [Conductor](https://parallelcode.app/blog/multi-agent-coding-tools-2026) | macOS 桌面 app | 隔离 workspace + review/merge 面板 | 假设自己是 launcher，与 orca 职能重叠，不可叠加 |
| [Vibe Kanban](https://nimbalyst.com/blog/best-agent-management-tools-2026) | web 看板 | 多 CLI（claude/gemini/codex）并行/串行执行、实时状态 | 同上：要求经它派发任务才可见 |
| Claude Squad / Emdash / Baton 等 | 终端编排器 | tmux/worktree 包装 | 与 herdr 职能重叠 |
| Omnara | 移动端 mission control | 远程 approve/steer | 通道价值（手机批准），非 ledger 价值 |

**共性结论**：所有现成工具都假设自己是 session 的 launcher/host，可见性来自"经我启动"。用户的舰队分布在 orca+herdr+cmux 三个既有 host 上，任何单一工具替换 = 全量迁移工作方式。**没有现成的"跨 host 聚合层"产品**——这层只能自建（或用 cmux 的 hook 架构近似，见 §4）。

## 3. HITL 审批框架（模式提取）

- **[HumanLayer](https://agentic-patterns.com/patterns/human-in-loop-approval-framework)**：`@hl.require_approval(channel=...)` 装饰器；执行暂停 → 富上下文卡片发到 Slack/邮件/dashboard → 人批后恢复；超时默认拒绝 + 可升级；`needs_approval` 可为异步可调用（程序化自动批准）；全量审计。→ 关键模式：**审批判定函数与审批通道解耦；auto-approve 是判定函数返回值，不是 LLM 决定**。
- **[OpenAI Agents SDK interruptions](https://openai.github.io/openai-agents-python/human_in_the_loop)**：run 中断点模型 + 程序化 approval callback。
- **[Temporal HITL](https://docs.temporal.io/ai-cookbook/human-in-the-loop-python)**：workflow signal 送决策、durable 等待。→ 模式：**审批等待必须可持久化、可恢复，不能靠内存信号量长期挂起**（cmux 的 120s 软等待正是因为它只有内存信号量）。
- **cmux Feed 软等待**（本地文档）：≤120s 无决策 → 回落 agent 原生 TUI，永不冻死。→ 模式：**桥式审批必须有原生兜底**，与 pull-adapter skill 的 terminalNative 原则一致。

## 4. 事件/观测管道

- **Claude Code OTel**（[OpenObserve](https://openobserve.ai/blog/claude-agent-sdk-observability-opentelemetry)、[General Analysis](https://generalanalysis.com/guides/claude-code-control-observability-opentelemetry)）：`CLAUDE_CODE_ENABLE_TELEMETRY=1` + OTLP exporter → traces（agent loop/工具调用）+ metrics（token/成本）+ logs（`prompt.id` 串联审计）；`agent_needs_input` / `agent_completed` hook 事件用于舰队拼接；Grafana 成本看板 + 空转检测（stall detection）。
  - 适用性：观测/成本/空转维度的成熟方案，但**OTel 不是审批通道**（单向遥测，无决策回传）。且仅 claude CLI 原生支持；pi 需扩展自报。
- **cmux 事件总线**（本地实测）：`cmux events --cursor-file --reconnect` 是现成的 durable 消费端；`workstream.jsonl` 是现成的审计层。三平台里唯一开箱即用的组合。
- **hook 生态方向**：cmux 的 16-agent hook 矩阵、herdr 的 16-integration 矩阵、orca 的 agent-hooks server——三家都收敛到"agent CLI 侧装钩子、host 侧收事件"。**agent 侧事件源（对用户即 pi 扩展）是三家共同的最大公约数**。

## 5. 陈海超方案（助理 agent）的外部对应物

"定制监控规则 + 定时总结需介入 session"= 业界的 supervisor/triage agent 模式。外部实现一致的约束：
- supervisor 只做摘要与优先级，不做 approval 决策（漏报不可接受）；
- 规则蒸馏产出物是配置/代码（HumanLayer 的 `needs_approval` 可调用），不是 prompt；
- supervisor 自身用确定性 watchdog 监控，不递归套 agent。
