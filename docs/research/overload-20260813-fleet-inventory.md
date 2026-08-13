# 舰队盘点：两台机器 × 四个 agent CLI

日期：2026-08-13。插入点：本机 + `ssh devbox`（192.168.1.20）上常用 omp / pi / claude / prime-agent。全部实测。

## 1. 盘点矩阵

| CLI | 本机 | devbox | 运行时血统 | 会话存储 |
|---|---|---|---|---|
| pi | 0.84.1，177 会话 | `~/.ai-devbox/bin/pi`，114 会话 | `@earendil-works/pi-coding-agent` | `~/.pi/agent/sessions/<cwd>/` |
| omp | `~/.bun/bin/omp`，170 会话 | 有，67 会话 | pi 同源（扩展 API 相同，cmux 文档证实） | `~/.omp/agent/sessions/` |
| prime-agent | 0.7.2，`~/.prime/agent` | 有，1 活跃 lease + 会话 | **依赖 `@earendil-works/pi-agent-core/pi-ai/pi-tui`**，`-e --extension` 可加载扩展 | `~/.prime/agent/sessions/*.jsonl` |
| claude | **cmux shim 包壳**（`/T/cmux-cli-shims/.../claude`），72 项目 | `~/.ai-devbox/bin/claude`，11 项目 | Anthropic 独立 | `~/.claude/projects/` |

关键比例：pi 系（pi+omp+prime）会话数 ≈ 530（本机 347 + devbox 182+），claude ≈ 83。**pi 系占舰队 ~86%，且三个运行时共享一套扩展 API**。

## 2. 每 CLI 管理面发现

### prime-agent（0.7.2）——管理原语最强
- `~/.prime/agent/session-leases/<hash>.lock/owner.json`（实抓）：
  ```json
  {"token":"uuid","pid":57953,"processStartId":"ps:Mon Aug 10 11:29:27 2026",
   "activeSessionId":"be5178c26217","sessionPath":".../<uuid>.jsonl","createdAt":"..."}
  ```
  **pid + processStartId = 可验证的会话所有权/存活性**——正是 orchestration-policy 要求的"handle 已消失或失效"判据的现成实现。ledger 的 aliveness 检查应采用此模式（pid 复用免疫）。
- `daemon-workers/`、`--mode daemon|acp`、`prime-agent list`（"No active agents"——有 agent 清单概念）、`telemetry.json`、`session-artifacts/`、`--goal/--goal-token-budget`。
- 结论：prime-agent 不需要被"接入"，它本身就带半个生命周期管理面；扩展口径与 pi 一致（待 V-2' 冒烟确认事件 API 版本差异）。

### claude——本机已被路径 C 覆盖
- 本机 `claude` 解析到 cmux shim → PermissionRequest 已进 `workstream.jsonl`/Feed（探测报告 §3 的 4 条 permissionRequest 即来源于此）。
- devbox 的 claude（`~/.ai-devbox/bin/`）无 cmux → 盲区。选项：devbox 装 herdr integration（`~/.claude/hooks/herdr-agent-state.sh`）或直接给 claude settings 加自有 hook 指向 collector。claude hooks 是官方稳定 API（`agent_needs_input`/`agent_completed`），无需 cmux 也能接。

### devbox——orca 布局复制但 runtime 独立
- devbox 上存在 `/data00/home/operator/orca-workspaces/feishu_ai_workflow-*` worktree 群 + `repos/`，与本机同构。
- 本机 `orca worktree ps` 实测 91 行全部 `hostId=local`——**devbox 的 orca worktree 不在本机 orca 视野内**（federation capability 存在但当前未联通/未启用）。ledger 不能假设 orca 单点全知。

## 3. 提交考古（近 7 天，"检查最近的提交"）

| 仓库 | 身份 | 数量 |
|---|---|---|
| devbox feishu_ai_workflow（--all） | operator | 234 |
| | dryrun@local | 44 |
| | 同事（zhangtong/wangbaotong/liderong 等） | ~60 |
| 本机 feishu_ai_workflow | operator（两种签名） | 59 |
| | dryrun@local | 22 |
| 本机 larkdev-skill | 同事 TRAE CLI（Co-Authored-By trailer） | 5 |

**核心问题：~340 个/周的 `operator` 提交里，人手写的和四个 agent 写的完全不可区分。** 唯一有归因的是同事的 TRAE CLI（走 Co-Authored-By trailer）和 `dryrun@local`（某自动化的独立身份）。

管理含义（直接回答"看提交应该怎么管理"）：
1. **无归因 = 无法管理**。review 队列（Q2）需要按"哪个 agent、哪个 session 产出"分组与追责；现在连输入都没有。
2. 修法零成本且顺手：pi 系三运行时共用的 overload 扩展在 `session_start` 注入 `GIT_COMMITTER_NAME`/trailer（如 `Agent: pi/<session-id>@<host>`），claude 用 settings hook 同理。提交即带 session 回链，Q2 的 digest 可直接从 commit 反查 journal。
3. `dryrun@local` 需要认领：确认是哪条自动化管道的身份，纳入 origin 分类（agent-spawned）。

## 4. 对既有推荐的修订（叠加到 path-comparison）

1. **路径 B 的覆盖率从"pi 系"精确化为三运行时**：一个扩展 → pi + omp + prime-agent（~86% 舰队），先例已证 pi/omp 双兼容，prime 待冒烟（V-2 扩展为 V-2'：三运行时）。
2. **claude 尾部**：本机走既有 cmux shim（零开发）；devbox 走 claude 官方 hooks 直连 collector（不依赖 cmux）。
3. **ledger 加机器维度**：`stable_id = <host>:<runtime>:<native_id>`；collector 每机一个（Unix socket），journal 汇聚两选一：
   - a) devbox collector 落本地 SQLite，本机定时经 ssh 拉增量合并（简单，延迟=拉取间隔，推荐起步）；
   - b) devbox 事件经 SSH 反向隧道实时推本机 collector（低延迟，链路脆弱时靠 a 兜底）。
   对账层本来就要经 ssh 轮询 devbox（`herdr --remote` / ssh CLI），a 与对账可共用通道。
4. **存活性判据采纳 prime lease 模式**：ledger 的 zombie 判定对 pi 系统一记录 `pid + processStartId`，替代纯 last_output 超时启发式（后者仍作 fallback）。
5. **提交归因作为新验收项**：Q2 digest 每项必须携带 commit↔session 回链；无归因提交进入告警（说明有 agent 绕过了扩展）。

## 5. 残留验证

| # | 内容 | 方式 |
|---|---|---|
| V-2' | overload 扩展在 pi/omp/prime 三运行时的事件 API 兼容性 | 10 行打印扩展分别 `-e` 加载冒烟 |
| V-5 | devbox claude hooks 直连 collector（绕开 cmux） | 官方 hooks 配置 + 一次 permission 事件回环 |
| V-6 | `dryrun@local` 身份归属 | 查 CI/自动化配置 |
| V-7 | devbox orca runtime 是否可与本机 federation 联通（若通，orca 对账单点化） | `orca status` on devbox + federation 文档 |
