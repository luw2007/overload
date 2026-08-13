# 本地平台真值探测报告

日期：2026-08-13。全部数据来自本机实测命令输出，无推测。对应 plan（`docs/plans/overload-20260813-ledger-design.md`）的 probe 清单 P-1~P-4。

## 结论速览

| 平台 | 生命周期源 | 推送通道 | approval 信号 | 置信度 |
|---|---|---|---|---|
| herdr | `agent list --json` 显式状态机 | `agent wait --until blocked`（阻塞监听） | `blocked` 状态（不细分 approval/input） | 高 |
| orca | `worktree ps --json` 双维状态 | agent-hooks HTTP server（pi 扩展 POST） | `terminal.query-reply-input.v1`（未抓到真值） | 中 |
| cmux | hook-sessions.json + workstream.jsonl | `cmux events --reconnect --cursor-file` | Feed `permissionRequest` 卡（实抓 schema） | 高 |
| pi | `~/.pi/agent/sessions/`（165+ 会话目录） | 扩展系统（3 个现成先例） | 扩展可截获全部事件 | 高 |

## 1. herdr（v socket API）

- `herdr agent list --json` → `result.agents[]`：`agent_status`、`terminal_id`（稳定 join 键）、`pane_id`、`tab_id`、`workspace_id`、`cwd`、`revision`、`state_change_seq`（单调递增，可做增量 diff / 漏拉检测）。
- **状态机显式枚举**（`herdr agent wait --until` 的 possible values）：`idle | working | blocked | done | unknown`。`blocked` = 等人输入/批准，不区分二者。
- `herdr agent wait <target> --until blocked --timeout <ms>`：无轮询阻塞监听，Q1 低延迟推送的现成原语。
- `herdr agent read`：可读终端尾部输出，用于 blocked 细分判别（approval vs question）。
- `herdr integration status` 实测：**pi/omp/claude/codex 等 16 个集成全部未安装**。当前 `agent_status` 来自 herdr 的终端启发式检测（`herdr agent explain` 可解释检测状态）。安装集成（写 `~/.pi/agent/extensions/herdr-agent-state.ts` 等）可获得 hook 级精度。
- 通知面：`herdr notification show <title> [--sound none|done|request]`——只有展示，无收件箱。

## 2. orca（app 1.4.180）

- `orca worktree ps --json` 实测 91 个 worktree。字段全集见 plan §4.2，关键：
  - `worktreeInstanceId`（uuid，稳定 join 键）；`worktreeId` 含路径（重建会变，仅辅助）。
  - **`parentWorktreeId` / `childWorktreeIds`：origin 谱系现成字段**，直接回答"agent 启动 vs 人启动"。
  - `unread`、`lastActivityAt`、`lastOutputAt`、`liveTerminalCount`、`hasAttachedPty`、`comment`、`preview`。
- 状态枚举实测（91 行聚合）：`workspaceStatus ∈ {in-progress(88), in-review(3)}` × `status ∈ {inactive(78), active(9), working(4)}`。workspaceStatus 是看板维度，status 是活动维度。**未观测到 terminal 态枚举值（done/archived 之外的）——需在有完结 worktree 时补抓**。
- `orca terminal list --json` 实测 28 个终端：`handle`、`ptyId`、`incarnationId`、`orphaned`、`connected`、`writable`、`lastOutputAt`、`preview`。**terminal 级无 agent 状态、无 approval 字段**。
- 推送面（读 `~/.pi/agent/extensions/orca-agent-status.ts` 证实）：Orca 跑一个 agent-hooks HTTP server，pi 扩展从 endpoint 文件解析 URL+token，把 Claude hook 风格事件（`tool_name`/`tool_input`）POST 到 `/hook/pi`；server 端做 `deriveToolInputPreview` 驱动 dashboard。latest-only pending slot 防积压。**即 orca 的状态显示本身就是事件驱动的，数据源在 pi 扩展侧**。
- capabilities 含 `terminal.query-reply-input.v1`、`agent-session.session-boundary.v1`、`agent-session.host-authority.v1`、`orchestration.federation.v1`。P-1（approval 真值）仍未抓到：需逮一个真实 pending 的 worktree。

## 3. cmux

- **`~/.cmuxterm/workstream.jsonl`：追加式审计日志，实测 17,390 行**。行 schema（实抓）：
  ```json
  {"kind":"permissionRequest","source":"claude","workstreamId":"claude-<uuid>",
   "status":{"pending":{}},"cwd":"...","ppid":39039,
   "payload":{"permissionRequest":{"toolName":"Bash","toolInputJSON":"...","requestId":"..."}},
   "createdAt":"...","updatedAt":"..."}
  ```
  顶层键：`context, createdAt, cwd, id, kind, payload, ppid, source, status, updatedAt, workstreamId`。
- **kind 分布实测**：toolUse 12,703 / toolResult 2,426 / stop 1,012 / userPrompt 592 / sessionStart 339 / sessionEnd 287 / question 22 / exitPlan 5 / permissionRequest 4。**可介入事件（question+exitPlan+permissionRequest=31）占 0.18%**——量化证实"人只该看千分之二的事件"。
- `~/.cmuxterm/<agent>-hook-sessions.json`：session→workspace 映射，含 `agentLifecycle ∈ {running, idle, needsInput, unknown}`、`lastBody`（末条消息摘要）、`launchCommand`（脱敏后的 resume 命令）。
- **`cmux events --category feed --category agent --cursor-file <f> --reconnect`：带 cursor 的可重连事件流**。`feed.item.received` / `feed.item.completed` / `agent.hook.<HookEventName>`。这是三平台中唯一现成的、可断点续传的 push 总线。
- Feed 语义：hook 在 `request_id` 信号量上软等待 ≤120s，超时发 `{}` 回落到 agent 原生 TUI 审批（"soft wait"，永不冻死）。决策回传走 `feed.permission.reply` 等 verb，含 Once/Always/Bypass/Deny。
- hooks 安装矩阵（agent CLI 侧，非 cmux 终端侧）：claude=wrapper 注入 PermissionRequest 桥（阻塞）；codex=telemetry-only（codex 有自己的审批路径）；**pi=只有 tool_execution_start/end telemetry，omp=lifecycle-only——均无 Feed 审批桥**。
- Agent Hibernation：`maxLiveTerminals`(默认12) + `idleSeconds`，空闲后台 agent 杀进程、回访时原生 resume。百 agent 场景的资源治理参考实现。

## 4. pi（0.84.1）

- 会话落盘：`~/.pi/agent/sessions/<cwd-encoded>/`，实测 165+ 目录。`--session <id>`/`--session-id`/`--fork` 可恢复。session 文件内无 pending-approval 状态——pi 本无审批环节，见下文 SDK 结论。
- **扩展系统是事实上的通用事件源**，本机已有三个先例：
  - `flux-bridge.ts`（4.4KB）：桥接生命周期事件到 Flux Island 灵动岛，经 `flux-hooks-relay` 转发 BridgeServer。当前 Flux Island 显示的数据即来源于此。
  - `orca-agent-status.ts`（16KB）：POST 事件到 orca agent-hooks server（见 §2），处理 OMP 运行时判别、WSL curl 绕行、latest-only 队列。
  - cmux 的 `cmux-session.ts`（文档证实）：session restore + tool telemetry。
- 三个先例证明：**pi 扩展可截获 agent 生命周期、工具调用、消息内容全事件流**，且同一扩展 API 兼容 pi/OMP 双运行时。
- 注意：`pi` 在 POSIX shell 下是 fish 包装函数（`__pi_export_keys` 报错），探测需经 `fish -c`。
- **SDK 事件全集（源码证实，`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:874-899`）**：`session_start/compact/shutdown/tree`、`context`、`before_provider_request/headers`、`after_provider_response`、`before_agent_start`、`agent_start/end/settled`、`turn_start/end`、`message_start/update/end`、`tool_execution_start/update/end`、`model_select`、`tool_call`、`tool_result`、`user_bash`、`input`；另有 `registerTool/registerCommand/registerShortcut` 与 UI 控制面。
- **`tool_call` 在工具执行前触发且可拦截**（types.d.ts:685 "Fired before a tool executes. Can block."；`ToolCallEventResult = { block?, reason?, terminate? }`，`event.input` 可原地改参）。含义：扩展可实现完整审批门——按规则放行 / 阻塞等远程决策 / 终止本轮。
- **pi 本体无逐工具原生审批 UI**（`trust.json` 只管扩展信任）。即 pi 系 worker 当前根本没有 approval 环节；"审批"对 pi 舰队是扩展可引入的策略层，而非需要桥接的既有事件。P-3 的问法因此改写：不是"session 文件里有没有 pending 状态"（没有），而是"审批门由谁实现"。

## 5. 残留 probe

| # | 内容 | 影响 |
|---|---|---|
| R-1 | orca pending approval 真值（逮一个活的） | orca 侧 Q1 判定 |
| R-2 | orca worktree 终态枚举（done/archived 表现） | vanished vs terminal 区分 |
| R-3 | ~~pi session 内 pending 状态~~ 已源码收口：无原生审批，`tool_call` 可拦截（见 §4） | 路径 B 升级为审批门宿主 |
| R-4 | herdr integration 安装后 agent_status 精度差异 | herdr 侧误报率 |
