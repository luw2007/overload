# Overload 外部 Session 纳管、产物管理与跨 Agent 交接：技术方案

状态：设计稿 **v4**（2026-09-12 窄修订，落实用户对 D1/D2/D5 的决定并为其余 D 项确认推荐默认值；v3 的结论除本版明列处外保持不动）。本文只做调研与方案，不改业务代码。逐条处置见 **§18 修订记录**（本版 **§18.3**）。
调研基线：提交 `d7b4e85`（fix: exclude tool argument deltas from channel output）+ 当前工作区未提交改动（主要是 `src/orchestrator/coordinator.ts`、`src/adapters/coordinator.ts`、`src/adapters/worker-runtime.ts`、`src/extension/coordinator.ts` 等 coordinator 系列文件，以及 `src/orchestrator/orchestrator.ts`、`src/adapters/pi-broker.ts` 的增量修改）。文中凡引用未提交文件，均标注 **[工作区]**。

引用约定：

- **代码证据**：有 `file:line` 支撑、且被引用行本身即可证明该断言的事实。
- **环境观察**：本机文件系统 / sqlite / CLI `--help` 的一次性只读观察。不是仓库事实，换一台机器可能不同；每条给出可复现命令（§16.1）。
- **推断**：由代码或环境观察合理推出，但没有单一行可直接断言。
- **方案建议**：本文提出的设计，尚未实现。

行号以本次读取时的文件内容为准；同一文件后续变更后请以符号名重新定位。

---

## 1. 摘要、目标、非目标、已确认范围、待决策边界

### 1.1 摘要

现有内核已解决"Session 生命周期采集 → 决策卡"。对"外部启动的 Session 自动变成可交接、可追溯的任务，并带产物版本在 Agent 间接力"，三处结构性差距：① **任务容器存在但无自动纳管入口**——`control_works` 已是长期容器（身份、状态机、`(source,source_id)` 去重、契约修订、Attention、outbox），但只由人/渠道显式创建（`src/control/store.ts:129-146`）；`orchestrator.tasks` 是"一次受管执行"（`src/orchestrator/schema.sql:3-14`）；外部 Session 只停在 `sessions`/`current`（`src/ingest/schema.sql:13-15,49-55`）。② **没有产物模型**——extension 只记 `tool_activity{tool,change}`（`src/extension/overload.ts:748-755`）与 `commit_observed{sha,repo}`（`:661`），不记路径/内容/diff；`artifacts/<task_id>/` 是受管 Task 的 evidence，**覆盖式、无版本**（`src/orchestrator/evidence.ts:18-24`）。③ **没有跨 Agent 交接**——`resumeSession`（`src/shared/resume.ts:37-45`）只做同 Agent `--resume`；coordinator 的"交接"是根 Work 对子 Task 的派发（[工作区] `coordinator.ts:327-349`）。

**核心结构决策：不新增第四种任务容器。**

- **任务 = `control_works`** + 新增 **discovered（契约轻量）来源模式**：纳管时以 `state='candidate'`、`contract=NULL` 建 Work，1:1 侧表 `mgmt_work_profile` 承载纳管字段。升级为契约治理是**单向**动作，复用现成的 `promoteWork`（`src/control/store.ts:337-350`）。
- **执行 = `mgmt_executions`**（显式命名的执行表，不是第二个任务表），一行 = 一个 `(stable_id, writer_id, attempt_no)`，挂在 Work 下并记录其依据的输入版本与交付物基线。
- **单一结案责任人** `closeout_owner ∈ {mgmt, coordinator, orchestrator}`（v2 叫 `completion_owner`，**本版改名**），建 Work 时确定、升级时**恰好转移一次**；非 owner 一律不得写 Work 终态，消灭"同一目标在三处各自完成"的歧义。**`closeout_owner='mgmt'` 只拥有 tracking closeout（profile 归档），永不拥有 Work completion**——见 §2.4.1。
- 产物/关联/交接/验收/提交由 `mgmt_*` 承载，全在 control DB 内，**带外键与组合唯一约束**（§12.1）。ledger 保持只读观察源，`~/.overload/artifacts/` 作快照根，新增只读的 `src/manage/` 采集进程。

不新增服务、不新增数据库文件、不引入对象存储/向量库/队列。

### 1.2 目标

外部（非 Overload 启动）的 pi/omp/Claude Session 在纳管范围内被自动发现并自动建立 discovered `control_works`，不要求逐个确认；为每个 Work 维护输入版本、执行记录（引用 journal 与原始 session 文件）、产物及版本（快照 + 摘要）、关联证据；支持任务级跨 Agent 交接（可验证交接点、新 Agent 以新执行接续同一 Work、产物成新版本、结果回流）；验收绑定具体交付物清单且产物变化后失效；与现有 `submitTask` PR 链路衔接而不扩张成发布平台；保持 Now/Inbox/Done，普通发现/同步/进度不产生决策卡。

### 1.3 非目标

不做通用文件盘、不归档整个工作目录、不做日志平台；不承诺恢复未记录/已丢失/权限外的历史；不承诺任意 Agent 内部状态（pi thinking、Claude sidechain）无损迁移；不做远端/云端分布式平台（D1）；不重写 orchestrator/coordinator/control/ingest，**不并行新增第二套任务系统**（本版删除了 v1 的 `mgmt_tasks`）；**不承诺正则脱敏能消除密钥泄露**——共享安全性靠"默认不可分享 + 显式授权导出"，不靠扫描器召回率（§7.4）。

### 1.4 已确认范围（来自 Prompt §二）

自动发现、输入管理、执行过程管理、产物管理、自动关联规则、跨 Agent 交接、能力分级与安全边界、UI 与注意力原则——逐项落地，对应章节见 §17 自查表。

### 1.5 待决策边界（摘要，详见 §15）

D1 第一版范围 → **本机 + ssh 远程主机**（用户 2026-09-12 决定，落地见 §6.4）；D2 首批 Agent → **仅 pi/omp/claude**（prime/cmux 退为事件层注记，不入首批）；D3 默认回溯 → 7 天内有活动；D4 快照上限 → 单文件 2 MiB / 单 Work 64 MiB / 保留 30 天；D5 交接是否自动启动 → **需 UI 确认，demo 级确认对话框即可**；D6 模型摘要 → 仅交接时一次且可关；D7 停止原 Agent → 本期不提供；D8 自动纳管是否创建 Work → **是，discovered 模式**；D9 Claude hook 归属；D10 受管 evidence 版本化 → 只读引用；**D11** discovered Work 初始状态 → `candidate`，且 mgmt 仅拥有 tracking closeout（代价见 §2.4.1）；**D12** Work 合并 → 不可变 alias，拆分本期不做；**D13** 是否全局开 `PRAGMA foreign_keys=ON` → 是。

---

## 2. 当前架构与差距（附代码依据）

### 2.1 事件与 Session 观察源

**代码证据**：`stable_id = <host>:<runtime>:<session-uuid>`（`src/shared/types.ts:14-15`；`src/ingest/ingest.ts:284`），journal 去重键 `UNIQUE(host, emitter_id, seq)`（`src/ingest/schema.sql:5-11`）。ingest 按文件名 cursor 增量读 spool，**事件插入与 cursor 推进在同一 immediate 事务**（`ingest.ts:159-176`），不再打开已读完的文件（`:154`）；节奏 `DEFAULT_SCAN_INTERVAL_MS = 2_000`（`:14`），由 `scan_interval_ms` 覆盖（`:67`），循环在 `:350` sleep（**P2-1 修正**）。pull rsync 拉远端 spool（`src/pull/pull.ts:48-53`），失败达阈值发 `source_outage`（`:64-67`）。recon 用 `kill -0` + `ps comm` 判死（`src/recon/recon.ts:514-522`），`emitter_dead` → 5 分钟 grace + spool 读完 → `emitter_drained`（`:132-153`），`session_vanished` 只在完整平台快照证明缺席时发（`:376-383`）。

**源故障与 recon 的关系（P2-3 收窄）**：`source_outage`/`source_recovered` 由 recon 的源快照失败/恢复（`recon.ts:176-206`）或 pull 失败阈值（`pull.ts:58-67`）发出，reducer 落入 `incidents`（`src/ingest/reducer.ts:97-105`）；当某 source（取 `detail.platform`，否则取 `stable_id` 的 runtime 段）有未关闭 incident 时，**仅 `RECON_EVENTS`**（`:8`：`emitter_dead/drained/stalled`、`telemetry_gap`、`session_vanished`、`turn_hung`、`dead_connection`）被丢弃（`:40-42,143`）。**普通会话事件不受影响。**

**状态投影（P2-2 修正）**：reducer 单游标顺序应用（`:67-80`）。`current` 是派生表；`:145-147` 只证明**重放已反映行不会重复转移**，**不证明存在重建入口**。完整重建需清空 `current`/`queue_transitions` 等派生表并重置 `reducer_cursor`（`src/ingest/schema.sql:23,49-57`）后重跑 `reduceJournal`；仓库无此入口，故本文按 **推断** 处理。

**采集能力（代码证据）**：extension 采 `session_started{lease,cwd,branch,parent,host}`、`working`、`settled{text≤500B,change_evidence,handoff}`、`tool_activity{tool,change,class}`（5 秒节流）、`decision_requested/resolved`、`commit_observed{sha,repo}`、`session_ended`（`src/extension/overload.ts:686-817`），**不采集**工具参数、路径、结果；`HANDOFF.md` 只取 TASK/STATUS/NEXT_OWNER/UNCERTAINTIES 计数（`:591-631`）；cmux workstream 只翻译 sessionStart/sessionEnd/stop 及三种决策类事件（`src/ingest/cmux.ts:142-169`）；pi-broker 经 `get_state` 取得 `sessionFile` 写入 metadata（`src/adapters/pi-broker.ts:300-308`）；受管 Task 的 prompt 写到 `artifacts/<task_id>/prompt-<attempt>.txt`（`src/orchestrator/runner.ts:39-40`）。

**环境观察**（复现见 §16.1）：本机仍有 Claude hook 在写 spool（`~/.overload/bin/overload-hook.sh` 存在、settings 中 5 处 overload 引用、spool 中 357 个 `claude-*` 目录），把 SessionStart/Stop/SubagentStop/PreToolUse/PostToolUse/PermissionRequest 映射为对应事件且 PermissionRequest 只记 key 不记值；但仓库文档称"专用 hook 已移除，只通过 cmux workstream 观察"（`docs/integrations.md:72-76`）——**hook 是已安装的本机产物，不在仓库源码中**。原始对话在各 Agent 自己的文件：pi `~/.pi/agent/sessions/<slug>/<ts>_<uuid>.jsonl`（首行 `{"type":"session","id","cwd"}`，消息行含 `toolCall{id,name,arguments}`/`toolResult{toolCallId,toolName,content,isError}`，602 目录）；omp 同 v3 格式（304 目录）；Claude `~/.claude/projects/<slug>/<sessionId>.jsonl`（含 `cwd`/`sessionId`/`gitBranch`/`tool_use`/`tool_result`，9 目录）。本机 ledger 的 `journal`/`sessions` 为 0 行、`ingest.heartbeat` 不存在 → **推断**：ingest 未运行、760 个 emitter 目录未被消费，限制了生产数据验证能力（§16）。

**差距**：`sessions` 无"任务"概念也无任务外键，`origin` 只是父 Session/平台线索（`ingest.ts:293`；`reducer.ts:126-133`），仅用于 Q 分类；journal 只存窄载荷（`src/shared/types.ts:88`："NEVER full tool payloads"）；没有"输入版本"实体——`control_contract_revisions`（`src/control/store.ts:28-31`）是**契约**版本而非用户输入版本；仓库无任何 session jsonl 读取器；**事实源层次未写死**，下游容易把投影当事实（§5.0）。

### 2.3 产物采集与存储

**代码证据**：runner 退出后 `collectEvidence` 采 `diff.patch/commits.txt/status.txt/checks.txt/runner.log` 到 `~/.overload/artifacts/<task_id>/`，`writeFileSync` **覆盖**（`src/orchestrator/evidence.ts:18-24`）；`runner-<attempt>.log`/`prompt-<attempt>.txt`/`report-<attempt>.txt` 按 attempt 区分（`runner.ts:39,44`；[工作区] `orchestrator.ts:81`）。coordinator review 把证据绑为 `{path,sha256}` 并校验路径归属 worktree 或 artifacts（[工作区] `coordinator.ts:271-288`），`readiness` 在交付前重校 hash、变化则标 `evidence_changed`（`:296`）。`submitTask` 先 `ls-remote` 比对远端 HEAD 再 push、先 `gh pr list` 再 `gh pr create`，每步落 `submit.json`（`src/orchestrator/submit.ts:11-28`）；`checkPr` 5 分钟一次（`orchestrator.ts:226-253`）。

**推断（基于仓库搜索）**：在 `rg -n 'sha256' src --type ts` 的命中集（coordinator、control/projection、control/outbox、decision-bot/mailbox、extension、ingest/cmux 及测试）中，只有 `coordinator.ts:278-288` 把 hash 校验用作**审核结论的前置条件**，其余为事件去重/载荷指纹。这是搜索结论而非局部代码事实（复现见 §16.1）；无论唯一性如何，该实现**可复用**。**（P2-4 修正：不再声称"仓库唯一"）**

**核实 Prompt §四三条先前观察**：① evidence 保存到 `~/.overload/artifacts/<taskId>/`——**成立**（`evidence.ts:18`、`runner.ts:26`），但只是"最近一次采集"，覆盖式、非版本化。② 人工审核后显式推分支/建 PR 的链路——**成立**（`awaiting_human(ready)` → `approve` → `submitted` → `pollSubmitted` → `submitTask`，`store.ts:18-19`、`orchestrator.ts:217-225`），但仅对 orchestrator 自建 worktree 的受管 Task 生效；coordinator 子任务 `disposition='local'` 不走此链路（[工作区] `coordinator.ts:400-402` 直接 `done`）。③ Coordinator 最终接受只完成根 Work、不提交发布——**成立**（`acceptDelivery` 只置 `control_works.state='completed'` 并发 `work.completed`，[工作区] `coordinator.ts:436-449`；`deliver` 的 impact 明写 "No merge or push is performed by coordinator"，`:417`）。

**差距**：外部 Session 无 worktree、无 `orchestrator.check`，`evidenceReady` 的前提（干净 worktree + check 脚本，`evidence.ts:28-34`）不成立；无产物身份/版本/来源/审核绑定的持久模型（`coordinator_reviews` 绑的是 `(task_id, attempt_id, evidence_digest)`）；无本地文件内容快照（只有 diff）；无并发修改的归属表达。

### 2.4 Work / Task / Session / 子任务语义

| 实体 | 表 | 语义 | 创建方 |
|---|---|---|---|
| Work | `control_works`（`src/control/store.ts:22-27`） | 人类审批的工作契约容器，candidate/active/stopped/completed | 人/渠道/CLI（`createWork`） |
| Task | `orchestrator.tasks`（`src/orchestrator/schema.sql:3-14`） | 一次受管执行：repo/base_ref/worktree/branch/attempt | `addTask`；coordinator `dispatch` |
| Session | `ledger.sessions`（`src/ingest/schema.sql:13-15`） | 一个 Agent 进程的一次会话 | ingest 由 `session_started` 创建 |
| 子任务 | `coordinator_children`（[工作区] `coordinator.ts:112-124`） | 根 Work 下的 ship/scout 子 Task | coordinator |
| Attention | `control_attention` | 决策卡 | 各生产者 `upsertAttention` |

Task ↔ Session：`bindRunnerSession` 按 `sessions.origin='orch:task:<id>:<attempt>'` 反查（`src/orchestrator/runner.ts:58-69`）。Work ↔ Task：`tasks.work_id + contract_revision`（`store.ts:38-42`）。

**结论（代码证据 + 推断）**：`control_works` 就是 Prompt 要求的"长期容器"，且**契约并非强制**——`contract` 可为 NULL（`store.ts:22-26`），`createWork` 仅在 `input.contract` 存在时才调 `validateContract`（`:132`）并支持 `candidate:true`（`:142`），故**契约轻量的 discovered Work 在现有代码下即可创建，无需改 `validateContract`**；单向升级已有现成实现 `promoteWork`（要求 `state==='candidate'`，校验契约并转 `active`，`:337-350`），无逆向路径，正好匹配"discovered → contract-governed 不可逆"；`(source, source_id)` 部分唯一索引（`:27`）直接提供发现去重（`source='discovered'`、`source_id=<首个 stable_id>`，重复扫描命中 `createWork` 的已存在分支并原样返回，`:134-141`）。`orchestrator.tasks` **不适合**当外部执行容器：`repo/base_ref/worktree/branch` 是非空语义，且 `tasks_repo_active` 对活跃态做了每 repo 唯一约束（`src/orchestrator/schema.sql:5,16-18`），同 repo 多个外部 Session 会互斥。故外部执行用**显式命名的** `mgmt_executions`。

### 2.4.1 结案权威与转移不变式（方案建议，P0-1 核心）

**唯一规则（P0-1 残留项的最终裁定）：`closeout_owner='mgmt'` 意味着仅拥有 tracking closeout，永不拥有 Work completion。**

即：manage **任何情况下都不得写 `control_works.state`**（不写 `completed`，也不写 `stopped`）。mgmt 的终态只落在 `mgmt_work_profile.track_state='archived'`。`control_works` 状态机上的变迁只有三个合法写者：人（通过 `resolveAttentionDecision` 或 `redirectWork`）、coordinator（`acceptDelivery`，[工作区] `src/orchestrator/coordinator.ts:436-447` 的 `UPDATE control_works SET state='completed' … WHERE …`）、orchestrator。采集器不在内。

**为何选这一边而不是"允许 mgmt 把 candidate 推向终态"**（两条理由均有代码依据）：

1. **技术上可行，语义上不成立。** `control_works.state` 的 CHECK 约束允许 `candidate → stopped`（`src/control/store.ts:24`），且 `redirectWork(action='stop')` 对 candidate **确实会成功**——它只校验 `revision`，不校验 `state`（`:173-180`，本次已实测：对新建 candidate 调用后 `state='stopped'`）。但 `stopped` 在现有语义里是"人决定停止该 Work"（与 `resolveAttentionDecision` 的 `selected_option='stop'` 同一终态，`:303`），采集器写它就是冒充人类决策。`completed` 更严重：它是验收结论。
2. **`candidate` 本就没有完成语义。** 一个从未被人确认契约的自动发现 Work，不存在"验收通过"的对象（`contract=NULL` → 无 acceptance criteria）。要让它能被完成，必须先 `promoteWork`（`:337-350`）变成 `active` 并拥有契约——而那一步是**用户动作**，不是采集器动作。

**因此 mgmt 不在 `control_works` 状态机上占任何位置。** 发现的 Work 在 `control_works` 层面永远停在 `candidate`，直到用户升级它（→`active`）或显式停止它（→`stopped`，人工动作）。

**字段含义与权限表**（`closeout_owner` 写在 `mgmt_work_profile`）：

| closeout_owner | 拥有什么 | 可写 | 不可写 |
|---|---|---|---|
| `mgmt` | **仅 tracking closeout** | `mgmt_work_profile.track_state='archived'` + `archived_at` + `archive_reason` | `control_works.state`（任何值） |
| `coordinator` | Work completion | `control_works.state='completed'`（只能通过 `acceptDelivery`） | mgmt 不得干预；此时 mgmt 也不归档 profile（不变式 ③） |
| `orchestrator` | 受管 Task 完成 | `tasks` 状态机 + 其已有链路 | 同上 |

不变式（均为单行条件更新，不依赖读后写）：① `origin_mode` 只能 `discovered → contract_governed`（`UPDATE … WHERE origin_mode='discovered'`，`changes=0` 即拒绝；与 `promoteWork` 同事务）；② `closeout_owner` 只能 `mgmt → coordinator`，恰好一次，只在 coordinator 首次 `dispatch` 时发生，反向不允许；③ manage 写 `track_state='archived'` 前必须附加 `AND closeout_owner='mgmt'`，故 coordinator 接管后 mgmt 归档自动失效，不与 `acceptDelivery` 竞争；④ **manage 的所有 SQL 中不得出现 `UPDATE control_works`**（可由 `src/manage/*.ts` 的源级抖动断言固定，见 §13.1）；⑤ 一个 Work 同时只能有一条活跃交接（§12.1 部分唯一索引）。

**用户可见语义（UI 必须如实表达，§11.3）**：归档的 discovered Work 在 Done 区显示为"**已归档（未作为正式 Work 完成）**"，**不得**显示为"已完成"；卡上并列"升级为 Work"入口，告知"升级后才能走验收与完成流程"。若用户确实需要一个"完成"结论，路径是：升级（`promoteWork`）→ 建 manifest → 验收卡 → 人工 accept，全程人在环。

**已知代价（D11，非 blocker）**：`candidate` Work 下 `resolveAttentionDecision` 会因 `work.state!=='active'` 抛 `blocked`（`src/control/store.ts:293`），`recordStopCondition` 需要 `work.contract` 非空（`:184`）。因此 mgmt 卡用 `upsertAttention` 创建（它只要求 Work 存在且 `contract_revision===work.revision`，**不要求 contract 非空或 active**，`:191`），解卡走 mgmt 自持 immediate 事务——与 [工作区] `coordinator.ts:436-446` 的直接条件 UPDATE 形态一致，但**不包含其中的 `UPDATE control_works`**。代价是 mgmt 卡不能使用契约收窄（narrow）；用户需先"升级为 Work"。UI 必须如实显示该限制。

**未发现阻断性 blocker**：`validateContract`、Work 状态机、`control_works_source` 唯一索引均不阻止本方案，因此**不保留 `mgmt_tasks`**。

### 2.5 多数据库与写入方向

`~/.overload/spool/**`（extension/hook/recon/orchestrator SpoolWriter/pull 写，传输层可剪除，`src/ingest/prune.ts:13-15`，L0）· `ledger.db`（ingest 写；web 只读 + `closeouts`；journal = L1，其余 L2）· `orchestrator.db`（orchestrator/coordinator，受管 Task 状态机与 coordinator 表，L3）· `orchestrator-answers.db`（control DB；web/CLI/daemon/orchestrator/notify 共同打开；Work、Attention、mailbox、outbox、conversations + 本方案 `mgmt_*`，L3）· `artifacts/<task_id>/`（受管 Task evidence）· `runtime/`（pi-broker）。

方向：control 事件经 outbox 发到 spool（`src/control/outbox.ts:52`），ingest 重放到 `control_attention` 投影（`src/ingest/schema.sql:25-37`）。**ledger 不反向写 control**；本方案保持该方向性（manage 只读 ledger）。

### 2.6 现有链路小结

```
受管 Task: claim → ensureWorktree → spawnRunner → bindRunnerSession → runner 退出 → collectEvidence
  → evidenceReady → requestApproval(ready) → approve → submitted → submitTask(push + gh pr) → checkPr → done
coordinator 子 Task: dispatch → runner_exit → coordinator_review(sha256 证据) → local: done / pr: submit
  → deliver → acceptDelivery → control_works.completed
```

**可复用**：worktree 幂等创建、evidence 采集、`{path,sha256}` 证据校验、`submitTask` 幂等 push/PR、`checkPr`、approval mailbox、Attention/outbox、`promoteWork` 单向升级。**确实缺失**：外部 Session 的任务化入口、产物版本模型、交付物清单、交接点与启动幂等、跨 Agent 启动绑定、session 文件读取器。

---

## 3. 可行路径比较与选择

| 路径 | 优点 | 缺点 |
|---|---|---|
| A. 为每个外部 Session 建**契约化** `control_works` + `orchestrator.tasks` | 复用最多 | `validateContract` 要求 objective/acceptance/decision_owner，自动纳管填不出真实契约（伪造契约违反"不冒充用户已确认"）；`tasks_repo_active`（`src/orchestrator/schema.sql:16-18`）让同 repo 多个外部 Session 互斥；`tasks` 假定自己拥有 worktree |
| B. 新建独立管理服务 + 独立 DB（含 v1 的 `mgmt_tasks`） | 边界清晰 | **已否决**：与 `control_works`/`orchestrator.tasks` 形成三套任务状态且无同步权威；违反 Prompt"不并行新增语义相同的任务系统"（`docs/plans/overload-artifact-management-prompt.md:141`） |
| **C. 扩展 `control_works`（discovered 契约轻量模式）+ `mgmt_executions` 执行表 + `mgmt_*` 产物/交接表，全在 control DB** | 无第四个任务容器；不新增服务与 DB；与 Attention 同库同事务（使 §12.1 外键可行）；复用 `promoteWork` 单向升级；orchestrator 不动 | `candidate` Work 不能走 `resolveAttentionDecision`（§2.4.1 代价，D11）；需新增一个采集进程；control DB 体积增大 |

**选择 C**。理由：直接遵守 Prompt 对"不并行新增任务系统"的禁止；control DB 已是 Work/Attention 事实源，任务与决策卡同库能保证"产物版本 → 验收 → 决策卡"一次事务写入，并使外键约束可行；ledger 保持只读，不破坏 §2.5 的方向性。

采集进程形态（方案建议）：新增 `src/manage/manage.ts`，与 ingest/recon 同样的 `--once`/循环模式，独立 launchd plist；**不**塞进 web 进程（web 目前只做 1 秒 outbox publish，`src/web/server.ts:124-132`）。

---

## 4. 领域模型与现有实体映射

| 概念 | 落点 | 复用/新增 | 说明 |
|---|---|---|---|
| 任务（长期容器） | **`control_works`** | **复用** | 自动纳管以 `source='discovered'`、`candidate`、`contract=NULL` 创建（`src/control/store.ts:129-146`）。**不新增任务表** |
| 纳管专有字段 | `mgmt_work_profile`（1:1） | 新增 | `origin_mode`、`closeout_owner`、`decision_owner`、`track_state`、`repo_root`、`cwd`、`host`、`input_head`。不重复 Work 已有字段 |
| Session（稳定身份） | `ledger.sessions` | 复用（只读） | 不复制；mgmt 只引 `stable_id` |
| **执行** | `mgmt_executions` | 新增 | 一行 = `(stable_id, writer_id, attempt_no)`，对应 `session_incarnations` 允许的多 writer（`src/ingest/schema.sql:16-19`）；含 `input_head_at_start`、起止、`exec_state`、`source_coverage`、`parent_handoff_id` |
| 输入版本 | `mgmt_inputs` | 新增 | 用户消息/附件引用/约束变更/审批/验收反馈；`supersedes` 链 |
| 执行记录 | `ledger.journal`（引用）+ `mgmt_exec_records` | 复用 + 新增 | 原始记录不复制；只存来源引用（jsonl 路径 + 行号 + sha256）与派生摘要 |
| 产物 / 产物版本 | `mgmt_artifacts` / `mgmt_artifact_versions` | 新增 | 版本**内容寻址**，身份不含观察来源（§5.1） |
| 观察证据 | `mgmt_observations` | **本版新增** | 仅追加；"何时、从哪个源、以何方式看到某版本"，与版本身份解耦 |
| 关联证据 | `mgmt_links` | 新增 | (subject, relation, object, evidence, observed_at, confidence) |
| 交付物清单 | `mgmt_manifests` (+`_entries`) | **本版新增** | 不可变；验收与提交的绑定对象（§10.1） |
| 交接点 / 启动尝试 | `mgmt_handoffs` / `mgmt_handoff_launch_attempts` | 新增（后者本版新增） | 后者为不可变尝试日志 + 幂等键 + `unknown` 态（§9.6） |
| 外部副作用 | `mgmt_external_effects` | **本版新增** | 归一化账本 + 每类型 reconcile 谓词 |
| 验收 / 提交 | `mgmt_acceptances` / `mgmt_submissions` | 新增 | 绑 `manifest_id`（**不再是单个版本**）；提交前重算比对 |
| 决策卡 | `control_attention` | 复用 | `upsertAttention`，`item_id` 前缀 `mgmt:` |

**不新增**：任务容器**不新增**：任务容器（复用 Work）、Session（复用）、Attention（复用）、审批 mailbox（复用）、worktree（复用 `ensureWorktree`，仅交接时可选创建）。

### 4.1 关系（文字 ER）

```
control_works 1─1 mgmt_work_profile ；1─n mgmt_executions n─1 ledger.sessions（stable_id 快照校验）
control_works 1─n mgmt_inputs（版本链）；1─n mgmt_artifacts 1─n mgmt_artifact_versions 1─n mgmt_observations
mgmt_artifact_versions n─n mgmt_links ── execution_id / input_id
control_works 1─n mgmt_manifests 1─n mgmt_manifest_entries ─1 mgmt_artifact_versions
mgmt_manifests 1─n mgmt_acceptances 1─n mgmt_submissions
control_works 1─n mgmt_handoffs 1─n mgmt_handoff_launch_attempts ；1─n mgmt_external_effects
control_works 0..1 ── orchestrator.tasks（coordinator 接管后，closeout_owner 转移）
```

### 4.2 执行身份与 Session 身份的区分（P1-5）

- **Session 身份** = `stable_id`，跨 `--resume` 不变（`src/ingest/ingest.ts:284`）。
- **执行身份** = `(stable_id, writer_id, attempt_no)`。`session_incarnations` 以 `PRIMARY KEY(stable_id, writer_id)` 显式允许同一 Session 多 writer（`src/ingest/schema.sql:16-19`），故执行必须独立建模。`attempt_no` 在相同 `(stable_id, writer_id)` 下按 `session_started` 递增，处理 writer 重用。
- 每个执行必填 `input_head_at_start`（开始时的 `mgmt_inputs` 头版本）与 `baseline_manifest_id`（若有），回答 Prompt「每次执行应能明确其依据的输入版本」。
- `exec_state ∈ {running, ended_ok, ended_failed, vanished, unknown}`，`unknown` 是一等公民（§9.1）；`source_coverage ∈ {ledger_full, file_only, ledger_stale, gapped}` 直接驱动交接门禁。

---

## 5. 数据所有权与生命周期

### 5.0 事实源层次（P1-3，方案建议，构成全文术语基准）

| 层 | 内容 | 性质 | 依据 |
|---|---|---|---|
| L0 外部原始源 | spool ndjson、Agent 的 session jsonl、git 工作区、cmux workstream | 不拥有，只读，可被外部删除/截断 | `src/ingest/prune.ts:13-15` |
| L1 耐久观察账本 | `ledger.journal`、`mgmt_observations`、`mgmt_exec_records` | **仅追加**，Overload 拥有，重放基准 | `src/ingest/schema.sql:5-11` |
| L2 投影/索引 | `current`、`sessions`、`session_incarnations`、`requests`、`attachments`、`incidents` | 由 L1 归约，可丢弃重建（**推断**，无重建入口） | `src/ingest/reducer.ts:67-79` |
| L3 控制面事实 | `control_works`、`mgmt_*`（profile/executions/artifacts/versions/manifests/handoffs/acceptances/submissions） | **事实源**，人与采集器共同写入，有状态机 | `src/control/store.ts:22-27` |
| L4 展示派生 | `mgmt_summaries`、ledger 内的 `control_attention` 投影 | 可重建，不得作为决策依据 | `src/ingest/schema.sql:25-37` |

**三种语义必须区分**（全文统一）：`unavailable`（源无法读取：权限/IO/锁/损坏/incident 未关闭）——**永不等于空，永不触发删除或 vanished**；`empty`（可读且确实无数据）；`stale`（可读但最新观察早于新鲜度阈值，默认 120 s）。**L2 的任何字段（含 `current.state`）不得单独作为安全门禁结论**，须搭配新鲜度与覆盖度（§9.1）。

| 数据 | 所有者 | 层 | 删除/归档语义 |
|---|---|---|---|
| journal | ingest | L1 | 不删（spool 可剪）。本方案不改 |
| sessions / incarnations / current | ingest | L2 | 投影；可重建（推断） |
| Agent 原始 session jsonl | 各 Agent | L0 | 只读；被清理时 `mgmt_exec_records.source_state='missing'`，**不删记录** |
| `control_works` + `mgmt_work_profile` | manage（创建）、用户（停跟踪/归档/升级） | L3 | `track_state` tracking/paused/archived；**永不物理删除**；改变发现范围只影响新建 |
| `mgmt_executions` | manage | L3 | 仅追加；`exec_state` 只向终态或 `unknown` 转 |
| `mgmt_inputs` / `mgmt_observations` / `mgmt_links` | 采集器（+用户） | L3 / L1 / L3 | 仅追加；link 纠错 = 追加 `supersedes` 新行，不删旧行 |
| `mgmt_artifact_versions` + 快照 | 采集器 | L3 | 快照按保留策略清理（§7.5）时行保留、`snapshot_state='pruned'` |
| `mgmt_manifests` | 用户触发生成 | L3 | **不可变**；生成后任何字段不得 UPDATE |
| `mgmt_handoffs` / `_launch_attempts` / `_external_effects` | 用户触发、采集器回填 | L3 | attempts 与 effects 仅追加；状态机见 §9 |
| `mgmt_acceptances` / `mgmt_submissions` | 用户 / submit 回写 | L3 | 仅追加；失效 = `invalidated_at` |
| `mgmt_summaries` | 采集器 | L4 | 可重建 |
| `control_attention` `mgmt:*` | manage | L3（卡本体）/ L4（ledger 投影） | 现有 resolved/superseded 语义 |

### 5.1 身份规则（P1-1 修正）

`work_id` = `randomUUID()`（由 `createWork` 生成，`src/control/store.ts:142`）。`execution_id` = `sha256(work_id + stable_id + writer_id + attempt_no)` 前 32 hex。`artifact_id` = `sha256(work_id + kind + canonical_key)` 前 32 hex，`canonical_key` 为仓库根相对路径（file，非仓库内则绝对路径）/ `repo_root@sha`（git_commit）/ 规范化 URL（external）。

**`version_id`（修正）** = `sha256(artifact_id + ':' + content_kind + ':' + content_sha256)`，`content_kind ∈ {content, deleted, metadata_only}`：`content` 取文件内容哈希；`deleted` 取 `sha256('\0deleted\0' + 前一版 version_id)`（**删除是有身份的版本**，且同位置反复删/建不碰撞）；`metadata_only` 取 `sha256(size + '\0' + mtime_ms + '\0' + 外部版本标识)`，用于 `too_large`/`withheld_sensitive`/`external`。**`observed_source` 不入身份**——同内容无论从 ledger、jsonl 还是 git 观察到，均为同一 `version_id`，来源写入 `mgmt_observations`（可多条）。这使"截断重读只对新内容哈希产生新版本"成为**身份层保证**而非口头约定。

`manifest_id` = canonical JSON `{work_id, entries:[{artifact_id, version_id}] sorted, git:{repo_root, head, base_ref, tree_sha}, verification:[…] sorted}` 的 `sha256`；内容相同即同一 manifest（幂等）。

**去重**：

- Session → Work：`mgmt_executions` 上 `UNIQUE(stable_id, writer_id, attempt_no)`，并在 `mgmt_session_binding(stable_id PRIMARY KEY, work_id)` 保证一个 Session 最多属于一个 Work。
- 发现去重：`createWork({source:'discovered', source_id:<首个 stable_id>})` 命中部分唯一索引时原样返回（`src/control/store.ts:27,134-141`）。注意：该分支在 title/state/contract 不一致时抛 `conflict`，故采集器重试时**必须传入与首次完全相同的 title**（由 `mgmt_work_profile` 记录首次 title 供重放）。

**不确定关联**：`mgmt_links.confidence IN ('strong','weak','uncertain')`；`uncertain` 不进 Attention、不进产物列表默认视图，只在任务页"现场材料"折叠区显示。

---

## 6. 发现与采集

### 6.1 Agent 能力矩阵

"目标等级"是本方案**建议达到**的接入级别。**当前 mgmt 实现：全部未实现**——仓库中不存在 `src/manage/`、不存在任何 session jsonl 读取器、不存在 `mgmt_*` schema。"原材料"列是**可读取的素材**，不是已实现的采集。

| Agent | 事件源 | 稳定身份 | 原材料 | 文件改动可见性 | 同 Agent 续跑 | **目标等级** |
|---|---|---|---|---|---|---|
| pi | extension → spool | `<host>:pi:<uuid>`，uuid = `sessionManager.getSessionId()`（`src/extension/overload.ts:687`） | pi jsonl 含 toolCall/toolResult（环境观察） | jsonl 中 `edit/write` 的 `path` + `commit_observed` | `pi --resume <uuid>`（`src/shared/resume.ts:42`） | 完整接入 |
| omp | 同 extension（`:65-70`） | `<host>:omp:<uuid>` | 同 v3 格式（环境观察） | 同上 | `omp --resume`（环境观察） | 完整接入 |
| Claude Code | 本机 hook → spool（**非仓库源码**）；cmux workstream | `<host>:claude:<session_id>` | claude jsonl（环境观察） | Edit/Write 的 `file_path`；无 `commit_observed` | `claude --resume`（环境观察）；Overload 现不支持（`resume.ts:29-31`） | 部分接入 |
| prime-agent | extension（路径未验证，`docs/operations.md:47-49`） | `<host>:prime:<uuid>` | 未验证 | 未验证 | 不支持 | 事件层（不入首批） |
| cmux 托管会话 | workstream.jsonl（`src/ingest/cmux.ts:37`） | `local:cmux:<workstreamId>` | 无 | 无 | 不支持 | 事件层 |
| herdr / orca | recon 快照（`src/recon/recon.ts:188-192`） | 绑定到已有 stable_id | 无 | 无 | 不支持 | 平台线索 |
| 远端 devbox pi/omp | pull rsync（`src/pull/pull.ts`） | `devbox:pi:<uuid>` | **本机不可读** | 不可采集 | `remote_host_unsupported`（`resume.ts:30`） | 部分接入（D1） |
| **远端 pi/omp（ssh）** | 远端 extension → 远端 spool，事件经 pull 回流；**原材料经 ssh 直读**（§6.4） | `<remote_host>:pi:<uuid>`，`<remote_host>` = 远端 `~/.overload/host` 内容（`src/extension/overload.ts:222-223`） | 远端 jsonl，经 `SourceFs.readRange` 读取 | 远端 jsonl 的 `edit/write` path + 远端 `git status`（`SourceFs.exec`） | `ssh <remote> 'cd <cwd> && <agent> --resume=<uuid>'`（§6.4.6） | **完整接入** |
| Claude Code（远端） | 无 hook 回流保证；仅 ssh 直读 jsonl | `<remote_host>:claude:<session_id>` | 远端 claude jsonl | Edit/Write 的 `file_path`；无 `commit_observed` | 远端 `claude --resume`（环境观察，未在远端复核） | 部分接入 |
| prime-agent / cmux | 见上两行 | — | — | — | — | **事件层注记（D2：不入首批）** |

**注意**（环境观察）：本机 `~/.overload/host` 内容是 `devbox`，即当前机器自视为 devbox。方案中"本机"指 `host` 文件所标识的 host，而非字面 `local`。

**D2 落定**（用户 2026-09-12）：首批 Agent **只有 pi / omp / claude**。prime-agent 与 cmux 托管会话仍会通过既有 ingest 链路进入 ledger（事件层），但 **manage 不为其建 Work、不采集产物、不生成交接包**：`manage.agents` 的取值域收窄为 `["pi","omp","claude"]`，其余 runtime 在发现阶段一律记 `mgmt_discovery_log(reason='runtime_out_of_scope')`（§6.3 ③ 同一路径），不产生 Attention。

### 6.2 范围配置

方案建议，`~/.overload/config.json` 新增：

```json
{"manage":{"enabled":false,"agents":["pi","omp","claude"],
  "hosts":[{"host":"devbox","kind":"local"},
           {"host":"builder","kind":"ssh","remote":"builder","ssh_cmd":"ssh"}],
  "lookback_ms":604800000,"follow_new":true,"freshness_ms":120000,"archive_grace_ms":1800000,
  "cwd_allow":["/data00/home/luwei.will/ai","/data00/home/luwei.will/orca/workspaces"],
  "cwd_deny":["/","/tmp"],
  "snapshot":{"file_max_bytes":2097152,"task_max_bytes":67108864,"retention_days":30}}}
```

- 默认 `enabled:false`，与 `approval_gate`、`decision_bot` 一致（`docs/configuration.md`）。
- `hosts[]` 由 v3 的字符串数组改为对象数组（D1，§6.4.1）；`kind:"local"` 最多一项，其 `host` 必须等于本机 `~/.overload/host` 的内容。
- `cwd_allow` 为空表示全部；**没有 `cwd_allow` 时仍拒绝 `$HOME` 根与 `/`**。
- 三种范围分离：`agents/hosts/lookback/follow_new` = **发现范围**；`mgmt_work_profile.track_state='tracking'` = **持续同步范围**；UI 查询参数 = **筛选**。改变前两者不删除任何 `mgmt_*` 行与任何 Work。

### 6.3 历史回填与持续增量

**发现候选**（每轮）：① ledger 只读查询 `sessions × current`，条件 `host IN hosts AND runtime IN agents AND COALESCE(current.last_event_at, sessions.first_seen_at) >= now - lookback`（**按活动而非创建时间**）；② 对 pi/omp/claude 扫 session 目录取 `mtime >= now - lookback` 的 jsonl，解析首行 `id`/`cwd`（pi/omp）或首个含 `sessionId`+`cwd` 的行（claude），推出 `stable_id`——这一步能发现 ledger 里没有的 Session（ingest 未运行、hook 未装），这类执行标 `source_coverage='file_only'`，**其启动判定永远是 `unknown`，因而永远不得同目录启动；只能走隔离 worktree + 人工风险确认路径**（统一策略见 §9.1.1）；③ `cwd` 不在 allow 或在 deny 的候选跳过并记 `mgmt_discovery_log(reason='cwd_out_of_scope')`（不产生 Attention）。

**去重**：`mgmt_session_binding.stable_id` 已存在 → 不重建 Work；但仍检查是否出现新 `(writer_id, attempt_no)`，是则追加 `mgmt_executions` 行。**关联到 Work**：§8。

**增量 cursor**（`mgmt_cursors`）：ledger → `source_key='journal'`，cursor = `ingest_seq`；session jsonl → `source_key='<runtime>:<stable_id>'`，cursor = `{bytes, line_no, head_fp, tail_fp}`，截断或首/尾行指纹变化则视为新一代从 0 重读（照搬 `src/ingest/cmux.ts:49-81` 的 generation 机制）；git → `source_key='git:<repo_root>'`，cursor = HEAD sha + `git status --porcelain` 的 sha256。**重读不会产生重复版本**，因为 `version_id` 已不含观察来源（§5.1）；重复观察只在 `mgmt_observations` 追加一行并受 `UNIQUE(version_id, evidence_ref)` 保护。

#### 6.3.1 采集原子性协议（P1-2，方案建议）

三阶段，对齐 ingest 已有的"事件 + cursor 同事务"契约（`src/ingest/ingest.ts:159-176`）：① **Stage**（DB 外）内容写 `…/<artifact_id>/<version_id>.blob.staging-<uuid>`（0600）并 `fsync`，此时无任何 DB 行；② **Commit**（一个 `immediate` 事务，包含且仅包含）`INSERT OR IGNORE` 一批 `mgmt_observations` + 对应 `mgmt_artifact_versions`（`snapshot_state='pending'`、`staging_name` 非空）+ `mgmt_exec_records`/`mgmt_links`，并 `UPDATE mgmt_cursors` 推进本批所有 `source_key`——事务失败则 staging 成孤儿、cursor 未推进、下轮重做（幂等，因身份是内容寻址）；③ **Finalize**（DB 外 + 一次小事务）`rename(staging → <version_id>.blob)` 后 `UPDATE … SET snapshot_state='stored', staging_name=NULL WHERE version_id=? AND snapshot_state='pending'`。

**启动双向对账**（必须实现，否则协议无效）：方向 A（行有文件无）扫 `pending` 行——目标 blob 已存在则转 `stored`；staging 存在则重做 rename；两者都无则转 **`lost`**（**不是 `stored`**）并保留 `content_sha256` 供日后重新观察。方向 B（文件有行无）删除无对应版本行的 `*.blob` 与超过 1 小时的 `*.staging-*`。

**不变式**：`stored` ⟹ 文件存在且哈希匹配。导出/交接/验收只接受 `stored` 或显式标记的非存储态，**永不把 `pending`/`lost` 当已存储**。

#### 6.3.2 重启恢复与日志截断

所有 cursor 在 control DB；重启先跑双向对账再从 cursor 继续。jsonl 均为追加式；size 缩小按 generation 机制重读。

#### 6.3.3 数据源不可用的完整分类（P1-10.2）

每个 `source_key` 每轮产生一个 `source_status`，写入 `mgmt_cursors.last_status` 与 `mgmt_discovery_log`：**`unavailable`**——ledger 不存在/`EACCES`/`SQLITE_CANTOPEN`/`SQLITE_BUSY`（跳过 ledger 来源，仅依赖 ledger 的执行转 `gapped`）、jsonl 目录 `EACCES`/`ENOTDIR`（该 runtime 的 file 发现跳过）、**单个 jsonl** `EACCES`/`EIO`/中途读失败（对应执行 `gapped` 且 cursor **不推进**）；前两类连续 ≥ 5 轮开 Inbox 健康卡，单文件类不开卡（在任务页显缺口）。**`corrupt`**——ledger 可开但 `integrity_check` 失败/表缺失，同 `unavailable` 但**立即**开卡。**`partial`**——jsonl 行 JSON 解析失败，记 `unparsable_line`、cursor 跳过该行并记缺口，不开卡。**`outage`**——该 source 有未关闭 `incidents`（`src/ingest/reducer.ts:40-42`），该平台全部执行 `gapped` 且 `exec_state` 不得改写，不开卡。**`stale`**——ledger 可读但 `current.last_event_at` 早于阈值，`source_coverage='ledger_stale'`，不开卡。control DB 打不开 → 进程本轮退出、下轮重试；无法开卡（卡就在该库），只写 stderr。

**硬规则**：以上任何一种都**不得**导致 Work 归档、执行标 `vanished`、产物行删除或版本被"当前内容"冒充历史。

**迟到事件与跨源重复**：同一 Session 既在 ledger（hook/extension 事件）又在 jsonl（文件）出现，按 `stable_id` 合并，`source_coverage='ledger_full'`；jsonl 中的 tool 记录作为 `mgmt_exec_records` 的引用，ledger 的 `tool_activity` 只作时间线；两者都指向同一 `version_id` 时写入两条 `mgmt_observations`（不同 `evidence_ref`），**版本仍只有一个**。

**有预算的重试与失败呈现**：每个 `source_key` 维护 `failures`；单轮内失败不重试；连续失败 ≥ 5 → 一次 Inbox 卡（`item_id='mgmt:health:<source_key>'`，原地更新，不重复开卡）；恢复后 `resolve`。

---

### 6.4 ssh 远程主机接入（D1 已决定，方案建议）

用户 2026-09-12 决定：纳管范围 = **本机 + ssh 远程主机**。本节只定义远程接入的可执行契约；采集语义、原子性（§6.3.1）、不可用分类（§6.3.3）、信任边界（§7.4）与交接门禁（§9.1）**完全不变**，只是把 fs 调用换成同一个 `SourceFs` 抽象。

#### 6.4.1 SourceFs 与配置形状

```ts
// src/manage/source.ts
export type SourceHost = { host: string; kind: "local" } | { host: string; kind: "ssh"; remote: string; ssh_cmd?: string };
export interface SourceFs {
  readonly host: SourceHost;
  listFiles(dir: string, opts: { sinceMs: number; suffix: string }): Promise<SourceFile[]>;
  readRange(path: string, fromByte: number, maxBytes: number): Promise<{ bytes: Uint8Array; nextByte: number; eof: boolean; generation: string } | null>;
  readFile(path: string, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean; sha256: string } | null>;
  exec(cwd: string, argv: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }>;
}
```

配置以 `manage.hosts[]` 承载（§6.2），每项就是一个 `SourceHost`：`{host, kind:"local"|"ssh", remote, ssh_cmd}`。`remote`/`ssh_cmd` 仅 `kind:"ssh"` 有意义，`ssh_cmd` 缺省 `"ssh"`。**manage 只能通过 `SourceFs` 访问数据源**：采集层不得直接调 `node:fs`，否则本机与远程行为会分叉。

#### 6.4.2 ssh 调用约定（复用 pull）

`sshSourceFs` 的每次调用都走与 `pull` 完全相同的参数形状（`src/pull/pull.ts:42-47`）：`commandWords(ssh_cmd)` 拆词（`:122-126`）后拼 `-o BatchMode=yes -o ConnectTimeout=5 -- <remote> <cmd>`。`--` 终止选项解析，使以 `-` 开头的 `remote` 不能注入 ssh 选项（同 `pull.ts:48-52` 的 Review P3 M1 理由）。进程执行与超时形态同 `runCommand`（`:134-145`）：`Bun.spawn` + 计时器 `proc.kill()`，超时抛错而非返回空结果。`exec(cwd, argv)` 在 ssh 上把 `argv` 逐个 shell-quote 后拼成 `cd <quoted cwd> && <quoted argv>` 单个远程命令（quote 形态同 `src/shared/resume.ts:51`）；**本机 `exec` 永远不走 shell**，直接 argv 数组。

#### 6.4.3 stable_id 中的 host 必须等于远端自报的 host

`stable_id = <host>:<runtime>:<uuid>`（§5.1，格式与 `src/ingest/ingest.ts:284` 一致）。这里的 `<host>` **不是** hostname、**不是** ssh 配置里的主机名，而是 **远端机器自己 `~/.overload/host` 文件的内容**：

- 远端 extension 启动时读 `join(homedir(), ".overload")/host`，仅当内容为 `devbox` 时把 `this.host` 置为 `devbox`，否则（缺失/不可读/其它值）回落 `local`（`src/extension/overload.ts:220-226`，字段声明在 `:194`）；随后 spool 目录就是 `~/.overload/spool/<host>/<emitter_id>/`（`:227-229`），且每条 envelope 写入 `host: this.host`（`:250`），stable_id 在 extension 侧同样拼成 `${spool.host}:${runtime}:${session}`（`:692`）。
- 同一个文件被 orchestrator spool（`src/orchestrator/spool.ts:12`）、ingest 主循环（`src/ingest/ingest.ts:335`）、classifier（`src/ingest/classifier.ts:103-107`）与 recon（`src/recon/recon.ts:647-650`）读取。

**因此：`manage.hosts[].host` 必须与远端 `cat ~/.overload/host` 的输出逐字相等，也就是与远端 `spool/<host>/` 目录名相等。** 否则同一个 Session 会在"事件层路径（pull 回流的 envelope）"与"文件层路径（ssh 直读 jsonl）"产生两个不同 `stable_id`，违反 §6.3.3 的跨源合并规则。启动校验（必须实现）：对每个 `kind:"ssh"` 主机跑一次 `exec("~", ["cat", "~/.overload/host"])`，输出 trim 后 ≠ 配置 `host` 则该主机直接标 `unavailable` + 一张健康卡（`mgmt:health:host:<host>`），**不降级、不猴式改写 stable_id**。远端文件缺失时远端自报为 `local`，此时配置必须写 `host:"local"`；在多台远端都是 `local` 的情况下这会撞车，**故接入前必须先在远端写入唯一的 `~/.overload/host`**（这是部署前提，不是代码可修复的问题）。注：`HostId` 当前是 `"local"|"devbox"` 枚举（`src/shared/types.ts:10`），多远端主机需把它放宽为 `string`，并同步放宽 `spool.ts:12`、`recon.ts:650` 的两处硬校验（**阻断实现项**，属阶段 1）。

#### 6.4.4 发现、增量读取与 generation

- **发现**：`listFiles(sessionDir, {sinceMs: now - lookback, suffix: ".jsonl"})`。ssh 实现用一条 `find <dir> -type f -name '*.jsonl' -newermt @<sec> -printf '%p\t%T@\t%s\t%i\n'` 一次拿全（一次 ssh 往返，不按文件开连接）；目录不存在 ⇒ `[]`（同本机语义）。
- **readRange**：远端 `dd`/`tail -c +N` 取区间，一次最多 `maxBytes`；返回 `nextByte/eof`。
- **generation = `inode:size`**，与本机 `${stat.dev}:${stat.ino}` 的用法同一机制（`src/ingest/cmux.ts:49`，判变逻辑 `:54-55`）：`inode` 变化或 `size < cursor_bytes` ⇒ 新一代，从 0 重读。ssh 上 inode 不可得时（文件系统不报）退化为首 4 KiB 的 sha（契约允许），语义与首/尾行指纹一致（`cmux.ts:58-64`）。**重读不会产生重复版本**（§5.1 内容寻址）。
- **git**：一律走 `exec(repo_root, ["git", …])`，不做任何本机 git 调用。`git:<repo_root>` 的 cursor 仍为 HEAD sha + `git status --porcelain` 的 sha256（§6.3），只是执行位置在远端。
- **snapshot**：`readFile(path, file_max_bytes)`，D4 限额 **完全不变**（单文件 2 MiB、单 Work 64 MiB、保留 30 天，§7.5）：超限同样只存 sha256/size + `snapshot_state='too_large'`，**不因为是远端就放宽或收紧**。敏感度分类（§7.4）在**本机**对取回的字节执行，远端不跑扫描器。

#### 6.4.5 失败语义（严格对齐 §6.3.3）

ssh 不可达（连接拒绝、`ConnectTimeout` 超时、认证失败、`ssh` 二进制缺失、命令超时）→ 该主机的所有 `source_key` 本轮记 **`unavailable`**，**永不返回空列表**：`listFiles` 抛错而不是返回 `[]`，`readRange`/`readFile` 返回 `null`。直接后果：该主机上的执行转 `gapped`、cursor **不推进**，且适用 §6.3.3 硬规则——**不得归档 Work、不得标 `vanished`、不得删产物行、不得用当前内容冒充历史**。区分：远端目录不存在（ssh 成功、`find` 返回空）是真的空，这才是 `[]`；ssh 本身失败永远不是空。重试走 §6.3.3 的**同一套预算**：单轮内不重试，连续失败 ≥ 5 → 一张 Inbox 健康卡（`item_id='mgmt:health:host:<host>'`，原地更新不叠加），恢复后 `resolve`；计数器语义与 `pull` 的 `state.failures` / `fail_threshold` 一致（`src/pull/pull.ts:19`）。**每主机一张卡**，不为同一台主机的每个文件开卡。

#### 6.4.6 远端主机上的交接启动

启动执行器在远端主机上运行 `ssh -o BatchMode=yes -o ConnectTimeout=5 -- <remote> 'cd <cwd> && OVERLOAD_PARENT=mgmt:handoff:<id> <agent> --resume=<uuid>'`（参数形态同 `src/pull/pull.ts:42-44`，命令串的 quote 形态同 `src/shared/resume.ts:42,51`）。三条不变：

1. **未知结果语义完全不变**（§9.6）：先写 `requested` 行再执行外部命令；ssh **连接阶段**失败（`ENOENT`、`ConnectTimeout`、`Permission denied`，能证明远端命令从未开始）才是 `failed_no_effect`；**ssh 连上之后的一切失败（超时、连接中断、退出码不可解释）一律 `unknown`**——远端进程可能已起。`unknown` 永不自动重试，只走 §9.6.2 reconcile 与 §9.6.3 的三选项卡（`jump`/`attach`/`abandon`）。ssh 把远端退出码 255 同时用于"ssh 自身错误"与"远端命令返回 255"，**故 255 一律归 `unknown`**，不得当作 `failed_no_effect`。
2. **OVERLOAD_PARENT 传递**：以环境赋值前缀写在远端命令串内（`ssh` 不传递本机 env），远端 extension 读 `process.env.OVERLOAD_PARENT` 写 `detail.parent`（`src/extension/overload.ts:701`），随后置为自身 stable_id 供子进程继承（`:707`，子命令注入见 `:774-775`）。远端事件经远端 spool → pull 回流 → ingest 写 `sessions.origin`，绑定路径与本机完全相同（§9.5），**只是延迟多一个 pull 周期**：故 `receipt_known` → `unknown` 的 5 分钟阈值对 ssh 主机需加上一个 pull 周期的宽延（配置项，默认 +60s）。
3. **工作区一致性与隔离（§9.4）在远端执行**：`workspace_fp` 的重算、`ensureWorktree` 等价动作均通过 `SourceFs.exec` 在远端跑；patch 失败仍回退 `stale`，**不降级为同目录**。`resumeSession` 的 `host !== "local"` 早期拒绝（`src/shared/resume.ts:30`）是**通用 Resume 路径**的约束，不是 mgmt 交接路径；mgmt 自己生成启动命令，不复用 `resumeSession`，故不受该行限制（也 **不修改** 该行）。

#### 6.4.7 本节不改变的东西

身份规则（§5.1）、原子性三阶段与双向对账（§6.3.1）、信任边界与默认不可分享（§7.4）、file-only 唯一策略（§9.1.1）、派生结束（§9.8.0）、schema（§12.1.1，**无新增列**）。远程主机不引入新的状态机，只引入一个 `SourceFs` 实现与一条启动路径。

---

## 7. 产物捕获与存储

### 7.1 产物类型与来源

| kind | 来源证据 | canonical_key | 版本内容 |
|---|---|---|---|
| `file` | jsonl 中 `edit`/`write`（pi/omp）、`Edit`/`Write`/`MultiEdit`（claude）的 path 参数 + 工具结果非错误；bash 重定向仅作 `weak` 线索 | 仓库相对路径（在 `git rev-parse --show-toplevel` 内）或绝对路径 | 观察时刻的内容快照 + sha256 + size + mtime |
| `git_commit` | `commit_observed{sha,repo}`；jsonl 中 bash `git commit` 成功后 `git rev-parse HEAD`；`Overload-Session` trailer（`src/extension/overload.ts:770-773`）为**强证据** | `repo_root@sha` | `git show --stat --format=fuller <sha>` + `git diff <sha>^..<sha>`（受大小限制） |
| `git_dirty` | 采集时 `git status --porcelain` + `git diff` + 未跟踪列表 | `repo_root@dirty` | diff 快照（未跟踪只记路径与 sha256，除非已是 `file` 产物） |
| `external` | jsonl 中 bash `gh pr create`/`gh pr view` 输出 URL；`tasks.pr_url`；用户手填 | 规范化 URL | `{url, provider, id, title?, state?, observed_at}`；历史不可取 → `history_available=false` |

### 7.2 一致性与并发

- 快照写入路径：`~/.overload/artifacts/mgmt/<work_id>/<artifact_id>/<version_id>.blob`，0600；stage/commit/finalize 协议见 §6.3.1。
- 采集器单实例：复用 pull 的 `flock` 模式（`src/pull/pull.ts:218-232`）。
- **多 Session 并发修改同一文件**：`artifact_id` 只与路径相关，`mgmt_links` 允许多个 `execution_id` 对同一 `version_id` 建 `modified` 关系。若观察窗口内有 ≥ 2 个执行对同一路径有修改证据而无法按时间分离，则该版本 `producer='multiple'`，每个执行的 link `confidence='uncertain'`，任务页显示"多个执行触碰"，**不选一个当唯一生产者**。
- 快照时刻与工具执行时刻不一致（采集延迟）：版本行记录 `observed_at`（快照时刻）与 `evidence_at`（工具调用时刻）；两者差 > 60 秒时标 `stale_capture=true`，UI 提示"内容可能已被后续修改"。

#### 7.2.1 并发写者之后的交接一致性（P1-10.1）

`producer='multiple'` 不只是归因保守，它是**交接门禁输入**：生成交接包时，若 manifest 中任一 `version_id` 的 `producer='multiple'` 或存在 `uncertain` 的 `modified` link，则交接包 `workspace.contention` 非空。`contention` 非空时**同目录续跑被禁止**，仅两条路径：① `isolate=true` 建隔离 worktree（`src/orchestrator/worktree.ts:21-31`）并把 `git_dirty` 快照作为 patch 应用，patch 失败 → `handoff.state='stale'`，**不降级为同目录启动**；② 人类显式确认覆盖，写 `override_reason`/`override_actor`，决策卡 impact 如实写"另一执行可能仍持有该目录，重复写入风险由你承担"。无论哪条，`gaps` 必须列出全部争用文件与对应的两个 `execution_id`。

### 7.3 避免错误归因共享工作目录的所有变更

规则（方案建议）：① 只有 jsonl 中**该执行自己的**写工具调用（path 明确）才产生 `modified/created` 强关系；② `git status` 发现的 dirty 文件若无任何执行的写证据 → 作为 `git_dirty` 产物挂在 Work 上，link `relation='present_in_workspace'`、`confidence='uncertain'`，**不归属任何执行**；③ `read`/`grep`/`cat` → `relation='read'`，**永不升级为 `modified`**；④ 同 cwd 的另一个 Work 的执行在时间上更接近某次 dirty 变更时，**不迁移归属**，只在两个 Work 都记 `uncertain`。

### 7.4 采集边界与共享边界（P0-3，两个独立信任边界）

**诚实前提**：现有 `scrub`（`src/extension/overload.ts:89-93`）与 `redact`（`src/ingest/cmux.ts:182-186`）只覆盖有限的前缀式 token 模式与 `key=value` 形式，**不是文件内容密钥扫描器，也不构成任何泄露保证**。密钥常见于普通 `.ts`/`.md`、日志、diff、工具结果、URL query 与生成报告中，**纯黑名单必然漏**。因此本方案不宣称"敏感信息不会进入产物"，而是把采集与共享拆成两个边界，用**默认拒绝**而非扫描召回率承载安全性。

**边界一：采集**——目标是"可用于本机回溯"，不是"可分享"。采集到本机 0600 目录即可，默认不外发。路径黑名单（`.env*`、`*.pem`、`*.key`、`id_rsa*`、`*credentials*`、`*secret*`、`channel-auth.json`、`feishu-app.json` 等）命中 → `snapshot_state='withheld_sensitive'`，只存 sha256 + size（这是降低本机留存面，**不是共享保证**）。工具参数/结果摘录先 `scrub` 再截断 ≤ 2 KiB；URL 一律剥离 query string 与 userinfo。

**敏感度分类（每 blob / 每摘录）**：`sensitivity`（`unknown` 默认 / `clean` / `suspected` / `confirmed_secret`，**默认 `unknown` 而非 `clean`**）、`scanner_version`（升级扫描器后旧行不自动变 `clean`）、`shareable`。分类器纯本地无模型：路径/扩展名规则 + 现有 `scrub` 正则 + provider 前缀集（`sk-`/`ghp_`/`github_pat_`/`xox[baprs]`/`AKIA`/`-----BEGIN * PRIVATE KEY-----`）+ 高熵串（长度 ≥ 32 且 Shannon 熵 ≥ 4.0 bits/char）。命中任一 → `suspected`；命中 provider 前缀或 PRIVATE KEY → `confirmed_secret`。**全部未命中只降到 `unknown`，不降到 `clean`**；`clean` 只能由人工在导出构建器中显式标记。

**边界二：共享/导出**——**默认全部不可分享**。`shareable=1` 仅当 (1) `kind='file'` 且 `sensitivity='clean'`（人工确认过），或 (2) `kind ∈ {git_commit, external}` 且只导出引用与哈希。硬规则：**工具结果、assistant 文本、diff/patch、`git_dirty` 内容、`runner.log` 默认 `shareable=0`**（即使未命中任何正则）；`sensitivity='unknown'` 的 blob **永不**进共享包，导出时降级为 `{path, size, content_sha256}` 引用；`artifact cat`（§9.3、§11.2）是**授权操作**——loopback + `checkOrigin`（`src/web/server.ts:109-116`）+ 调用方必须是 `decision_owner`，非 `stored` 态返回 404 + state；**导出构建器** `buildSharePackage(work_id, manifest_id)` 是唯一允许产出共享内容的函数，且必须是**白名单拼装**（只从 `shareable=1` 的行读内容），不接受"读全部再过滤"，新增字段默认不进包；交接包（§9.2）是共享包的一种，只含版本引用 + 哈希 + 经 scrub 的摘录，不内嵌 blob。**测试义务**（`export-boundary.test.ts`）见 §17 场景 18——它证明的是**边界**，不是扫描器召回率。

### 7.5 大小与保留

单文件 > `file_max_bytes`（默认 2 MiB）→ 只存 sha256/size，`snapshot_state='too_large'`；单 Work 快照总量 > `task_max_bytes`（64 MiB）→ 新版本只存哈希并发一次 Inbox 卡 `mgmt:budget:<work_id>`；`retention_days` 后非 `accepted`、非 manifest/handoff 绑定的版本 blob 删除、行保留、`snapshot_state='pruned'`，被验收或被 manifest 引用的版本永久保留；忽略 `node_modules/`、`.git/`、`dist/`、`build/`、`target/`，lock 文件保留（lock 是产物）。

### 7.6 历史版本不可取得

首次纳管一个已运行很久的 Session 时，jsonl 中早期 `edit` 对应的中间内容已不可复现：为每个此类调用建 `mgmt_exec_records`，但**不**伪造 `artifact_version`；只建一个当前内容的 version，`history_available=false`，并在 link 上记 `evidence_at` 早于 `observed_at`。`external`（PR）历史 review/commit 状态不可回溯 → 同样 `history_available=false`。

**部分历史的确定行为（P1-10.3）**：`history_available=false` 本身**不阻止交接**，但会 ① 在交接包 `gaps[]` 写入 `{kind:'missing_history', artifact_id, first_known_observed_at, missing_before}`；② 把该产物在决策卡 evidence 中标为 `history:partial`；③ 若该产物同时进入 manifest，则 manifest 的 `verification[]` 必须显式包含 `{kind:'history_gap_acknowledged', actor, at}`，否则 `POST /accept` 返回 409 `history_gap_unacknowledged`。这是"可纳管但明确缺口"的可执行定义，而非 UI 文案。

---

## 8. 自动关联算法

### 8.1 Session/执行 → Work

按顺序取第一个命中的**强证据**（命中后写 `mgmt_session_binding` + 一行 `mgmt_executions`）：

| 序 | 证据 | 来源 | 结果 |
|---|---|---|---|
| 1 | `sessions.origin = 'orch:task:<id>:<attempt>'` | ingest（`src/ingest/ingest.ts:293`；`runner.ts:24`） | 绑定到该受管 Task 已有的 `tasks.work_id`（`src/orchestrator/store.ts:38-42`）；**不另建 Work**；`role='orch_runner'`，`closeout_owner` 保持为 orchestrator/coordinator |
| 2 | `sessions.origin` 是另一个 `stable_id`（父 Session，`OVERLOAD_PARENT`，`src/extension/overload.ts:704,710,778`） | ingest | 加入父 Session 所属 Work，`role='child'` |
| 3 | 同 `stable_id` 的新 incarnation（`--resume` 或新 writer） | `session_incarnations` | 同 Work、同 Session、**新执行行**（`attempt_no+1`），`role='resumed'` |
| 4 | `mgmt_handoffs.new_stable_id = 该 stable_id`（交接启动时预登记，§9） | mgmt | 加入交接源 Work，`role='successor'` |
| 5 | jsonl 首条用户消息含 `Overload-Work: <work_id>` 标记行 | jsonl | 加入该 Work，`role='explicit'` |
| 6 | git commit trailer `Overload-Session:` 指向已归属 Session 的仓库提交，且本 Session 在同一分支继续提交 | git | 弱证据，仅 `hint`，**不自动合并** |
| 7 | 无以上 | — | **新建独立 discovered Work**（`createWork({source:'discovered', source_id:<stable_id>, candidate:true})`），`title` 取首条用户消息前 120 字（scrub 后），`role='origin'` |

同仓库/时间接近/文本相似 → 只写入 `mgmt_work_hints(work_id, other_work_id, reason, score)`，在任务页展示"可能相关"。

### 8.2 执行 → 输入 / 执行记录 / 产物

`role=user` 文本 → `input(kind='user_message')` 新版本（strong）；含附件/URL/文件路径 → `input(kind='reference')`（strong，引用存在性另测）；`ask` 工具 answer / `decision_resolved.selected` → `input(kind='decision')`（strong）；写工具成功（`isError=false`）→ `modified`/`created`（strong，按文件先前是否存在）；写工具失败 → `attempted_modify`（strong，记录失败）；读工具 → `read`（strong）；bash 含 `git commit` 且随后 HEAD 变化或 trailer 命中 → `committed`（trailer strong / 仅 HEAD 变化 weak）；bash 含 `gh pr create` 且输出 URL → `submitted_external`（strong）；bash 含 `git push` 成功输出 → `pushed`（weak，不解析远端状态）；采集时 dirty 但无写证据 → `present_in_workspace`（uncertain）；`tool_activity{change:true}` 但 jsonl 不可读 → `modified_unknown_path`（uncertain）。

### 8.3 不确定性表达、纠错、幂等、可追溯

- 每条 `mgmt_links` 含 `evidence_ref`（`journal:<ingest_seq>` / `jsonl:<path>#<line>` / `git:<repo>@<sha>` / `user:<actor>@<ts>`）、`observed_at`、`confidence`。
- 纠错：`POST /api/mgmt/links/<link_id>/correct`，写新行 `supersedes=<link_id>`、`actor`、`reason`；旧行保留并 `superseded_at`；采集器再次观察同一证据时看到已被人纠错的 `evidence_ref` 不再自动恢复（实现：`mgmt_corrections(evidence_ref PRIMARY KEY, decided_at, actor)` 的存在即阻止重建）。
- 幂等：link 唯一键 `(subject, relation, object, evidence_ref)`；重复扫描 `INSERT OR IGNORE`。
- 不确定关联不制造噪声：`uncertain` 永不开 Attention；任务页默认折叠；仅在生成交接点时列入"上下文缺口"。

### 8.4 独立自动创建任务的冲突处理（P1-9）

**本期明确不做合并与拆分**（D12）。理由：`artifact_id` 含 `work_id`（§5.1），合并必然改变产物身份，而产物身份已被 manifest / acceptance / handoff 引用，重写会使已签发的验收与交接包失效。

取而代之提供**不可变的 alias 映射** `mgmt_work_alias(alias_work_id PK, canonical_work_id, reason, actor, created_at)`（§12.1）：① alias 的 Work **仍然存在**，`track_state='archived'`、`archive_reason='aliased'`，其产物/版本/验收/交接记录全部原地不动，`artifact_id` **永不重写**；② UI/API 读 canonical 时额外展示 alias 的产物与时间线并标清来源——**不合并存储，只合并展示**；③ 新的 Session 绑定、新版本、新 manifest 一律写 canonical，已有的不迁移；④ manifest **允许**跨 alias（entries 只引 `version_id`），但 `manifest.work_id` 必须是 canonical，且入口校验每个 `version_id` 所属 Work ∈ {canonical} ∪ alias 集，否则 409；⑤ alias 行不可删不可改（只允许插入），写入时要求 alias 尚未作为任何行的 `canonical_work_id`（**禁止链式/环形**）；⑥ **重扫不能复活**——发现器建 Work 前先查 `mgmt_session_binding`，已绑定到 alias 的 `stable_id` 不重建也不被静默改挂到 canonical，只有新出现的 `stable_id` 走 §8.1；⑦ 每次 alias 写入追加 `mgmt_discovery_log(reason='work_aliased', detail={alias, canonical, actor})`。

拆分（一个 Work 实为两件事）本期不提供；推荐在新 Session 用 `Overload-Work:` 标记新建 Work，旧 Work 保留历史。文档必须如实告知该限制。

---

## 9. 跨 Agent 交接协议

### 9.1 前置条件（全部必须满足才允许"启动新 Agent"）

门禁基于 §5.0 三分与 `source_coverage`，**不允许只读 `current.state`**。

**可信终止**：执行 `E` 可信终止当且仅当 (1) `source_coverage='ledger_full'`；(2) 该平台无未关闭 `incidents`（`src/ingest/reducer.ts:40-42`）；(3) `current.last_event_at >= now - freshness_ms`（默认 120 000）；(4) 满足其一——`state='done'|'failed'` 且有 `session_ended`；或 `state='idle'` 且该 `(stable_id, writer_id)` 的 `pid` 为 NULL 或 `process.kill(pid,0)` 失败（复用 `src/shared/resume.ts:26,47-49`）；或 `state='vanished'` **且**有进程级证明（pid 已死或 `emitter_drained`）——**仅凭平台快照缺席不足**，`session_vanished` 只表示平台视图缺席（`src/recon/recon.ts:374-383`）。不满足任一条 → `exec_state='unknown'`。

| 场景 | 判定 | 同目录启动 | 隔离 worktree |
|---|---|---|---|
| 可信终止 | `terminated` | 是 | 是 |
| `current.state='working'` | `live` | **否**，返回原现场 | 否 |
| `awaiting_human`（blocked-on-ask） | `live_blocked` | **否**，返回原现场跳转目标（`queryJumpTarget`，`src/shared/queries.ts`） | 否 |
| `file_only` / `ledger_stale` / 平台 incident 未关闭 / `telemetry_gap` 覆盖该窗 / `vanished` 无进程证明 | `unknown` | **否（无例外）** | 是，且**仅**此一条路：隔离 worktree + 显式人类风险确认（§9.1.1） |
| `origin` 以 `orch:` 开头 | `orchestrator_owned` | 否 | 否，提示走 coordinator rework（同 `src/shared/resume.ts:29`） |

**`unknown` 的人类确认路径**：UI 必须展示"为什么是 unknown"（具体是 file_only / stale / outage / gap / no-process-proof 哪一条）、风险文案"原执行可能仍在写入该目录"，并要求显式勾选。确认后**只能**走 `isolate=true`；`override_reason`/`override_actor` 记录该确认。**永不提供"在 unknown 下同目录启动"的按钮。**

#### 9.1.1 file-only / unknown 的唯一策略（P1-4 残留项，全文只此一份）

v2 在 §6.3 写"file-only 永远不能通过启动门禁"，而 §9.1 / §11 API 又给 `isolate_with_confirmation`，两种读法矛盾。**本版最终定义（其他章节均以此为准）**：

> `file_only` 与其他一切 `unknown` 判定：**禁止同工作区（同目录）启动，无例外、无覆盖选项；但可以在“隔离 worktree + 显式人类风险确认”下启动。**

即：**不是绝对禁止交接，是绝对禁止同目录交接。** 三条推论：

1. `POST /works/<id>/handoffs` 在 `isolate=false` 且判定为 `unknown` 时一律 `409 liveness_unknown`，`allowed` 恒为 `["isolate_with_confirmation"]`——该字符串的含义是"**只剩这一条路**"，不是"可选之一"。
2. 走该路径必须同时满足：`isolate=true`（建 `overload/mgmt-<work_id>` worktree，`src/orchestrator/worktree.ts:21-31`）**且** 请求体携带 `override_reason` 与 `override_actor`（`override_actor` 必须等于 `mgmt_work_profile.decision_owner`）。缺任一 → `409 confirmation_required`。
3. 该确认**不降低证据级别**：交接包 `gaps[]` 必须含 `{kind:'liveness_unknown', cause:'file_only'|'ledger_stale'|'outage'|'telemetry_gap'|'no_process_proof'}`，且新 Agent 的系统提示必须写明"原执行可能仍在原目录运行"。

**为什么不选绝对禁止**：Claude Session 在本方案内天然是 `file_only`（§6.1 “部分接入”）；绝对禁止等于声明 Claude 永不可交接，与 §14 阶段 3 的交付目标矛盾。隔离 worktree 已消除真正的危险（两个 Agent 写同一工作区），剩余风险是"原 Agent 可能继续在旧目录干活"，属于人类可以知情承担的范围。

**受影响章节已同步**：§6.3（发现）、上表 `unknown` 行、§11.1 API 示例、§13 场景 13 与新增场景 13b、§14 阶段 3。

其余前置：Work `track_state='tracking'`；目标 cwd 无其他 Work 的 `live`/`live_blocked` 执行；无 `{ready_to_launch, launching, launch_unknown, bound}` 的在途交接；§7.2.1 的 `contention` 检查。主动停止原执行**不在本期**自动做（D7），UI 只给"跳转到原现场"。

### 9.2 交接点格式（示例）

`mgmt_handoffs.packet`（JSON，由 §7.4.3 导出构建器产出；**blob 不内嵌**）：

```json
{ "handoff_id":"h_5f3c…", "work_id":"w_9a1e…", "manifest_id":"m_77…", "created_at":1789137600000,
  "source":{"agent":"pi","execution_id":"e_4b…","stable_id":"devbox:pi:01a090e4-…",
            "final_state":"terminated","coverage":"ledger_full","last_event_at":1789137589000},
  "objective":{"text":"为 Overload 编写产物管理技术方案","input_version":"in_v7","derived":true},
  "constraints":[{"input_version":"in_v3","text":"只做调研，不改业务代码"}],
  "inputs":{"current_head":"in_v7","chain":["in_v1","in_v3","in_v7"]},
  "artifacts":[{"artifact_id":"a_1c…","kind":"file","path":"docs/plans/…-tech-design.md","version_id":"v_88…",
      "sha256":"…","size":51234,"snapshot_state":"stored","shareable":false,"acceptance":null},
    {"artifact_id":"a_2d…","kind":"git_dirty","version_id":"v_91…","files":15,"shareable":false}],
  "done":[{"text":"读取 src/ingest、src/orchestrator…","evidence":["jsonl:…#12-40"]}],
  "verified":[{"text":"bun test …evidence.test.ts 通过","evidence":["jsonl:…#210"]}],
  "open":[{"text":"§11 API 示例未写","evidence":[]}], "blockers":[], "next_steps":["补充 §11 API 示例"],
  "external_effects":[{"effect_id":"x_3a…","kind":"git_push","target":"origin/feature-x","state":"confirmed",
      "idempotency_key":"push:origin:feature-x@abc123","reconcile_cmd":"git ls-remote --heads origin feature-x"}],
  "workspace":{"cwd":"…","repo_root":"…","branch":"master","head":"d7b4e85","dirty_files":15,"untracked":18,
      "required_env":["bun"],"contention":[],"warnings":["工作区包含他人未提交修改"]},
  "gaps":[{"kind":"missing_history","artifact_id":"a_1c…","missing_before":1789130000000},
          {"kind":"uncertain_links","count":2}],
  "budget":{"packet_bytes":18422,"artifact_refs":2,"excerpt_bytes":6100} }
```

### 9.3 上下文预算与按需读取

交接包本体 ≤ 64 KiB；超出则 `done/verified/open` 只保留最近 N 条 + 引用。新 Agent 通过 `overload mgmt handoff show <id> --section artifacts|inputs|records` 按需读取；产物内容通过 `overload mgmt artifact cat <version_id>`——该命令受 §7.4.3 授权约束（owner 才可读，非 `stored` 返回 404+state）。模型摘要（D6）仅在生成交接点时可选调一次，写 `mgmt_summaries(generator='model:<id>')`，与 `generator='rules'` 并存，UI 默认展示规则版。

### 9.4 工作区一致性

生成交接点时记录 `workspace.head` 与 `dirty_files` 的 sha256 列表，汇总为 `workspace_fp`；启动前重算，不一致 → `handoff.state='stale'`，要求重新生成（不自动覆盖旧交接点）。若用户选"在隔离 worktree 中继续"：复用 `ensureWorktree(repo, work_id, 'overload/mgmt-<work_id>', head)`（`src/orchestrator/worktree.ts:21-31`），把 dirty diff 快照作为 patch 应用；**patch 失败则回退为 `stale`，不降级为同目录**。

### 9.5 新 Session 绑定

启动命令由 manage 生成，注入 `OVERLOAD_PARENT=mgmt:handoff:<handoff_id>`（复用 extension `detail.parent` 读取，`src/extension/overload.ts:701`）与首条消息 `Overload-Work: <work_id>` 标记。采集器看到 `sessions.origin='mgmt:handoff:<id>'` → §8.1 规则 4 命中，`new_stable_id` 回填、`state='bound'`。Claude Code 无 extension：依赖首条消息标记（规则 5）或用户在 UI 手动绑定。

### 9.6 启动幂等与未知结果（P0-2）

**"告诉新模型不要重复"不是幂等机制**，只是提示。真正的幂等由两张持久表承载。

**9.6.1 启动尝试日志**：每次点"启动"先**在事务内**插入一行 `requested`，**再**执行任何外部命令（表见 §12.1；`idempotency_key = sha256(handoff_id + workspace_fp + target_agent + attempt_no)`，并记 `command/args`、`target_cwd`、`target_surface`、`receipt`、`observed_pid/boot_id`）。单向迁移：`requested` →（executor ok 且回执可解析）`receipt_known` →（ledger 出现 `origin=mgmt:handoff:<id>`）`bound`；`receipt_known` 5 分钟无绑定 → `unknown`；executor **证明未执行**（`ENOENT`、spawn 前参数校验失败、连接被拒且无子进程）→ `failed_no_effect`；executor 超时 / 崩溃 / 无法判断是否已 spawn → `unknown`。

关键区分（P0-2 核心）：`failed_no_effect` **只允许**在能证明目标进程从未启动时使用，这类可自动重试；其余一切（含 executor 超时、manage 在 spawn 与写 receipt 之间崩溃）一律 `unknown`，**`unknown` 永不自动重试**。崩溃恢复：manage 启动时把 `state='requested' AND requested_at < now-60s` 的行一律转 **`unknown`**（不是 `failed_no_effect`）——这正是"进程已启动但 receipt 丢失"的情形。

**9.6.2 reconcile-before-retry**：`unknown` 不允许直接重试，须先按序只读 reconcile：① ledger 是否有 `sessions.origin='mgmt:handoff:<id>'` 且 `created_at >= requested_at` 的行 → 有则直接 `bound`；② `session_incarnations` 是否有 `started_at >= requested_at` 且 cwd 匹配的活进程 → 有则进入手动绑定；③ 目标 Agent 的 session 目录是否有 `mtime >= requested_at` 且 cwd 匹配的新 jsonl → 有则 `file_only` 绑定；④ 若有 `target_surface`，只读探测其存在性（不发送输入）。全部为否**且** ledger/文件源均可用（非 `unavailable`，§6.3.3）→ 才允许人类选"重新启动"（生成 `attempt_no+1` 新行）。**任一源 `unavailable` 时不得判定"未启动"**，保持 `unknown`。

**9.6.3 一张决策卡，三个选项**：`unknown` 只产生**一张** Attention 卡（`item_id='mgmt:handoff:<handoff_id>'`，原地更新不叠加）——结论「交接启动结果未知：可能已有一个 `<agent>` 在 `<cwd>` 运行」；触发「executor 未返回可信回执；reconcile 未找到新 Session」；影响「重试可能产生第二个写同一目录的 Agent，并重复外部副作用」；选项**恰好三个**：`jump` / `attach`（把已存在的 `stable_id` 手动绑为 successor）/ `abandon`（写 `abandoned`，之后才解锁重启）。**没有 `retry` 选项**；重试只在 `abandon` 之后且 reconcile 判定确无新 Session 时出现。

**9.6.4 外部副作用日志**：`mgmt_external_effects`（§12.1）归一化记录 `kind`/`target`/`idempotency_key`/`state`/`reconcile_cmd`。每种 kind 有**效果专属 reconcile 谓词**，与 `submitTask` 已有做法一致（`src/orchestrator/submit.ts:11-28`）：`git_push` → `git ls-remote --heads <remote> <branch>`（远端 sha 相同 `confirmed`、不同 `superseded`、命令失败 `unknown`）；`pr_create` → `gh pr list --head <branch> --json url`（有 URL `confirmed`、空 `observed`、失败 `unknown`）；`pr_comment`/`release`/`http_post` → **无可靠 reconcile**，一律 `unknown` 并在交接包标注"无法确认是否已发生，请人工核对"。硬规则：`state='unknown'` 的副作用**不得**被任何自动流程重放；交接包据此生成新 Agent 的系统提示，但系统提示只是**辅助**，真正的防重在 §10.2 的提交前 reconcile。

### 9.7 失败恢复矩阵

| 失败点 | attempt.state | handoff.state | 恢复 |
|---|---|---|---|
| 生成交接包失败（快照 `pending`/`lost`/不可读） | 无行 | 不写行 | 报错并列出缺失项（§6.3.1 不变式） |
| executor 证明未启动（ENOENT/参数非法） | `failed_no_effect` | `ready_to_launch` | 可自动重试；同一 `handoff_id`，`attempt_no+1` |
| executor 超时 / 崩溃 / 回执不可解析 | `unknown` | `launch_unknown` | §9.6.2 reconcile → §9.6.3 决策卡；**不自动重试** |
| 启动成功但 5 分钟内无 Session 绑定 | `unknown` | `launch_unknown` | 同上 |
| 新 Session 绑定后失败/消失 | `bound` | `ended` | Work 保持 `tracking`；可再生成新交接点 |
| manage 在 spawn 与写 receipt 之间崩溃 | 启动时由 `requested` 超时转 `unknown` | `launch_unknown` | 同上（这是 P0-2 指出的危险路径，被显式覆盖） |

### 9.8 结果回流与自动归档（P1-6）

新执行的产物版本自动挂到同一 Work（规则 4）。归档是**真实的状态转移**，不是视图过滤。

#### 9.8.0 idle 执行的派生结束转移（P1-6 残留项）

**问题**：`session_ended` 只由 extension 在自己的生命周期钩子里发（`src/extension/overload.ts:686-817`）。外部 Session、被 `kill -9` 的 Session、无 extension 的 Claude Session **经常永远不发 `session_ended`**；reducer 只在 `session_ended` 时写 `state='done'`（`src/ingest/reducer.ts:163`），`settled` 只写 `state='idle'`（`:160`），且 `SESSION_TERMINALS = {done, failed, vanished}`（`:7`）不包含 `idle`。因此一个正常干活干完、进程退出的外部 Session 会永久停在 `current.state='idle'`，而 §9.8.1 要求 `exec_state ∈ {ended_ok, ended_failed}` —— **archive 永不可达**。

**解法：定义一条显式的派生转移，把 §9.1 已有的"可信终止"证据落为 `exec_state`。** 该转移只写 `mgmt_executions`（L3），**不回写 ledger**，符合 §6.3.2 “`exec_state` 是本地派生且不可回写”与 §2.5 的写入方向性。

**谓词 `derived_closeout(E)`**（全部成立才转，逐条对应已有语义）：

| # | 条件 | 依据（当前行号） |
|---|---|---|
| 1 | `source_coverage='ledger_full'` 且该平台无未关闭 `incidents` | §9.1；reducer 对 open incident 丢弃 `RECON_EVENTS`（`src/ingest/reducer.ts:8,143`） |
| 2 | `current.state='idle'`（不接受 `working`/`awaiting_human`） | `reducer.ts:160,162` 写 idle；`:161` 写 awaiting_human |
| 3 | **writer 已死或已排干**：`session_incarnations.pid` 为 NULL 或 `process.kill(pid,0)` 失败；**或** journal 已有该 `writer_id` 的 `emitter_drained` | `src/shared/resume.ts:47-49` 的 `kill(pid,0)` 探测；recon 的 `emitter_dead`（`src/recon/recon.ts:136-140`）与 `emitter_drained`（`:143-150`，要求 `now - graceOrigin >= drain_grace_ms` **且** spool 已读到 EOF） |
| 4 | **grace 已过**：`now - current.last_event_at >= max(drain_grace_ms, archive_grace_ms)`；`drain_grace_ms` 默认 5 分钟（`src/shared/types.ts:53` 的 `DRAIN_GRACE_MS = 5 * 60_000`） | 同上；`recon.ts:144` 使用该预算 |
| 5 | **无 pending ask**：`requests` 中该 `(stable_id, writer_id)` 无 `state='pending'` 行 | `src/ingest/schema.sql:20-22`；`emitter_drained` 会把 pending 转 `orphaned`（`reducer.ts:185,227`），故正常排干后该条自然成立 |
| 6 | 无更新的同 `stable_id` incarnation 在运行（避免把 `--resume` 后的新 writer 误判为旧执行结束） | `session_incarnations` 的 `PRIMARY KEY(stable_id, writer_id)`（`src/ingest/schema.sql:16-19`） |

**结果分类**：

- `derived_closeout(E)` 成立 ∧ 最后一条 `settled` 无失败标记 → `exec_state='ended_ok'`；
- `derived_closeout(E)` 成立 ∧ （有 `turn_hung`/`dead_connection` 未恢复，或最后一次写工具 `isError=true` 且无后续成功）→ `exec_state='ended_failed'`；
- 任一条不成立 → **保持 `running` 或 `unknown`**，永不猜测。

**证据必须写入**：转移在一个 `immediate` 事务内完成，同时写 `mgmt_executions.closeout_evidence`（JSON，§12.1.1）：

```json
{"rule":"derived_closeout","decided_at":1789137600000,"verdict":"ended_ok",
 "current_state":"idle","last_event_at":1789137000000,
 "writer_proof":{"kind":"emitter_drained","journal_seq":88412},
 "pid_probe":{"pid":48213,"alive":false,"at":1789137590000},
 "grace_ms":1800000,"pending_asks":0,"coverage":"ledger_full"}
```

写入语句为单行条件更新，且 `closeout_evidence` 与 `exec_state` **同时**置位（`closeout_evidence IS NOT NULL` 是 `ended_*` 的必要条件，由 §13.1 `archive.test.ts` 断言）：

```sql
UPDATE mgmt_executions SET exec_state=:verdict, ended_at=:decided_at, closeout_evidence=:evidence
 WHERE execution_id=:eid AND exec_state='running';   -- changes=0 即放弃本轮
```

**可逆性**：若该 `(stable_id, writer_id)` 后续又出现 `working`/`tool_activity`，说明判断错误 → 该执行回 `running`、`closeout_evidence` 追加 `revoked_at` 并保留原证据，同时触发 §9.8.3 的 reopen。这是本方案**唯一**允许从 `ended_*` 退回 `running` 的路径，必须留审计。

**与 §9.1 启动门禁的关系**：两者用同一组证据但阈值不同——§9.1 的"可信终止"要求 `last_event_at >= now - freshness_ms`（**新鲜**，默认 120 s，因为要立刻启动新 Agent）；§9.8.0 相反要求 `last_event_at <= now - grace`（**陈旧**）。两者不冲突：前者是"刚结束，可以接力"，后者是"结束很久，可以归档"。实现上是两个独立谓词，不得共用一个布尔函数。

**file_only 执行**：条件 1 不成立（`source_coverage≠'ledger_full'`），故 `derived_closeout` 永远不成立，其 Work 不自动归档。这是有意的：没有 ledger 就没有进程级证据。用户可在 UI 显式"手动归档"（写 `archive_reason='manual'` + `actor`），这是人类动作而非派生转移。

#### 9.8.1 closeout 资格谓词

`eligible_for_archive(work)` 需同时满足：(1) 所有 `mgmt_executions.exec_state ∈ {ended_ok, ended_failed}` 且每个执行 `source_coverage='ledger_full'`（存在 `unknown`/`gapped` 即不合格）——**该条件对从不发 `session_ended` 的外部 Session 由 §9.8.0 的派生转移满足，不再依赖 `session_ended` 事件**；(2) 无 `state='open'` 的 `mgmt:*` Attention（含健康卡、预算卡、验收卡、launch unknown 卡）；(3) 无 `mgmt_handoffs` 处于 `{ready_to_launch, launching, launch_unknown, bound}`；(4) 无 `mgmt_submissions` 处于 `{pending, pushed}`；(5) 存在结果记录（一条 `mgmt_inputs(kind='acceptance'|'feedback')`，或一个 `accepted` 的 acceptance，或最后一个执行 `settled` 且 `HANDOFF status=complete`，或最后一个执行的 `closeout_evidence.verdict='ended_ok'`）；(6) `now - last_terminal_event_at >= archive_grace_ms`（默认 30 分钟；派生转移取 `closeout_evidence.decided_at`）。

#### 9.8.2 归档转移

满足谓词 → manage 在一个事务内**只做一件事**：

```sql
UPDATE mgmt_work_profile SET track_state='archived', archived_at=?, archive_reason='closeout'
 WHERE work_id=? AND track_state='tracking' AND closeout_owner='mgmt';
```

**manage 在任何情况下都不写 `control_works.state`**（§2.4.1 不变式 ④）——不写 `completed`，也不写 `stopped`，无论 Work 处于 `candidate` 还是 `active`。v2 的"仅当 active 时附带写 completed"已**删除**：`closeout_owner='mgmt'` 只拥有 tracking closeout。

- `closeout_owner='coordinator'` 时连 profile 也不归档（上述 `AND closeout_owner='mgmt'` 使 `changes=0`）；该 Work 的结案完全由 `acceptDelivery` 负责（[工作区] `coordinator.ts:436-447`）。
- `work.state` 保持原值。已 promote 的 Work 想要 `completed`，走人工验收卡（§10.1），不由采集器代写。
- 同时 `resolve` 所有 `mgmt:*` deferred 卡，并 enqueue 一条 `work.archived` control 事件（复用通用 outbox，`src/control/outbox.ts:52` 的 `publishControlEvents`）供渠道回流。注：该引用只证明存在通用发布入口，**不证明**任何现有消费者能理解新的 `work.archived` kind；消费端支持属于实现项。

#### 9.8.3 迟到事件与 reopen

归档后若出现：该 Work 任一 `stable_id` 的新 `session_started`/`working`/`tool_activity`；或新的 `mgmt_artifact_versions` 行；或 `checkPr` 观察到 PR 状态变化（`src/orchestrator/pr.ts:9-48`）→ **自动 reopen**（`track_state='tracking'`，`archive_reason='reopened:<cause>'`，追加 `mgmt_discovery_log`）。

reopen **不回滚** `control_works.state`：若已 `completed`（由 coordinator 或人写入）则保持 `completed`，只在任务页顶部显示"已完成任务出现新活动"。这是刻意的不对称——完成是人类/coordinator 的决定，采集器既无权写入也无权撤销（§2.4.1）。reopen 同时按 §9.8.0 的可逆性规则处理相关执行的 `exec_state` 与 `closeout_evidence.revoked_at`。

- 若新执行留下 `HANDOFF.md status=partial/blocked` 或 `uncertainties>0`，沿用现有 `handoff_blocked` Inbox 语义（`src/ingest/classifier.ts:51-60`），此时谓词 2 不成立，不会归档。


---

## 10. 验收与提交

### 10.1 验收绑定不可变交付物清单（P1-7）

单个 `artifact_version_id` 不足以代表一次交付：PR 通常依赖一组文件、一个 commit/tree、一个 base 分支和一组验证证据；任一其他文件、base 变化或验证结果变化都应使旧结论失效，单版本绑定做不到。`submitTask` 本身也是对 worktree HEAD/branch 操作而非单个文件（`src/orchestrator/submit.ts:11-28`）。因此验收绑定 **manifest**（`mgmt_manifests` + `mgmt_manifest_entries` + `mgmt_acceptances`，结构见 §12.1）：

- **不可变**：两表只允许 INSERT。`manifest_id` 即内容 digest（§5.1），故"重算并比对"等价于"重建 manifest 并比 id"。
- 构建时校验（一个事务内）：每个 `version_id` 必须属于对应 `artifact_id`（由复合 FK + `(artifact_id, version_id)` 组合唯一索引强制），且每个 `artifact_id.work_id ∈ {work_id} ∪ alias 集`（§8.4）。
- `verification[]` 每项形如 `{kind:'check'|'test'|'human'|'history_gap_acknowledged', cmd?, exit_code?, evidence_sha256?, actor?, at}`。验证结果变化 → digest 变 → 旧 manifest 不再等于当前，acceptance 自动不适用。
- 验收动作通过 Attention 卡 `mgmt:accept:<work_id>:<manifest_id>`（Inbox，`human_only`），选项 `accept/reject/defer`；`evidence` 列出每个 entry 的 `{artifact_id, version_id, path, sha256}` 与 `git_head`/`base_sha`/`verification`。
- **失效**：采集器为 manifest 中任一 `artifact_id` 产生新 `version_id`，**或**观察到 `git_head`/`base_sha` 变化，**或**任一 `verification` 证据哈希变化时，把引用该 manifest 的 `accepted` 行写 `invalidated_at` 与 `invalidated_reason='superseded_by:<…>'`，相关未消费的卡置 `superseded`（因 discovered Work 可能是 `candidate`，实际以 mgmt 自持事务写，见 §2.4.1 代价）。这条规则覆盖评审指出的缺口：**另一个文件、base 分支、生成文件、验证结果变化都会失效**。

### 10.2 提交前重新校验（P0-4）

仅当 Work 有 `repo_root` 且用户选"提交为 PR"时：若 Work 已由 coordinator 接管（`closeout_owner='coordinator'`）→ 复用 orchestrator 的 `submitted` 流程，mgmt 不重复实现；否则创建 `mgmt_submissions`（§12.1），执行 `submitTask` 的等价步骤（抽出 `src/orchestrator/submit.ts` 的纯函数部分复用；它已按步骤落 `submit.json` 并区分 push/pr `confirmed`/`unknown`，`:7,27`）。

**生效前的强制重算**（同一 `immediate` 事务内取快照，事务外执行外部命令，外部命令前再比一次）：① `acceptance.invalidated_at IS NULL` 且 `verdict='accepted'`；② 用同一算法、同一输入集合重建 manifest，`recomputed_manifest_id` 必须**等于** `acceptance.manifest_id`，不等 → 409 `manifest_drift` 并列出差异条目；③ 每个 entry 的当前文件 sha256 必须等于 `version.content_sha256`（`stored` 时用快照比对，否则现读文件）；④ 当前 `git rev-parse HEAD` 必须等于 `manifest.git_head`，`base_ref` 解析出的 sha 必须等于 `manifest.base_sha`；⑤ 该 Work 下 `state='unknown'` 的 external effect 必须先 reconcile（§9.6.4），仍 `unknown` 则**阻止提交**并开决策卡（不猜测、不重放）；⑥ `idempotency_key = sha256(manifest_id + target_kind + target)` 唯一，防同一 manifest 重复提交。

状态如实呈现：`pending` ≠ `pushed` ≠ `pr_created` ≠ `merged`；`merged` 由 `checkPr` 观察（`src/orchestrator/pr.ts:9-48`）回写，观察失败保持上一状态并计数，**不乐观推进**。提交结果写回 `mgmt_external_effects`（带 `reconcile_cmd`），使下一次交接包能如实列出。未支持目标（GitLab MR、Lark 文档发布等）→ `state='unsupported'`，卡上显示"需要人工发布"并给出产物快照路径。**不扩张成通用发布平台。**

---

## 11. API / CLI / UI 最小变更

### 11.1 API（web server，loopback，同源校验沿用 `checkOrigin`，`src/web/server.ts:109-116`）

所有 `/api/mgmt/*` 的写操作与内容读取额外要求调用方为该 Work 的 `mgmt_work_profile.decision_owner`（§7.4.3）。

`GET /works?track=&agent=&since=` 列表 · `GET /works/<id>` 详情（输入头、产物最新版本、manifest/验收状态、执行列表含 `source_coverage`、交接记录、跳转目标、缺口）· `POST /works/<id>/track` · `POST /works/<id>/promote {contract, reason}`（转调 `promoteWork`，`src/control/store.ts:337-350`）· `POST /works/<id>/inputs` · `POST /works/<id>/manifests {artifact_ids[], verification[]}` → `manifest_id` · `POST /works/<id>/handoffs {target_agent, isolate?, manifest_id?}`（**只生成不启动**）· `POST /handoffs/<id>/launch`（写 `_launch_attempts`）· `POST /handoffs/<id>/reconcile`（§9.6.2 只读）· `POST /handoffs/<id>/bind {stable_id}` · `POST /handoffs/<id>/abandon {attempt_id, reason}` · `POST /links/<id>/correct` · `POST /manifests/<id>/accept {verdict, reason}` · `POST /acceptances/<id>/submit {target, base?}`（先跑 §10.2 重算）· `GET /versions/<id>/content`（非 `stored` 或敏感态返回 404+state）· `POST /works/<id>/share-package {manifest_id}`（§7.4.3 白名单拼装）。

关键响应差异（省略成功包体）：

```http
POST /works/w_9a1e/handoffs {"target_agent":"omp","isolate":false}
200 {"handoff_id":"h_5f3c","state":"ready_to_launch","packet":{…},
     "preconditions":{"termination":"terminated","coverage":"ledger_full","freshness_ms":8400,
                      "workspace_consistent":true,"contention":[]},
     "launch_command":"cd /data00/… && OVERLOAD_PARENT=mgmt:handoff:h_5f3c omp"}
409 {"error":"source_blocked_on_ask","termination":"live_blocked","jump":{…}}   # 源执行 awaiting_human
409 {"error":"liveness_unknown","termination":"unknown","cause":"file_only",    # 亦用于 stale/outage/gap/vanished 无进程证明
     "allowed":["isolate_with_confirmation"],   # §9.1.1：唯一剩余路径，不是可选项之一
     "same_workspace":"forbidden",               # 同目录启动无例外、无覆盖选项
     "requires":["isolate=true","override_reason","override_actor=decision_owner"],
     "risk":"原执行可能仍在写入该目录"}

# 同一个 file_only 源，带齐确认后的正向请求（§9.1.1 第 2 条）
POST /works/w_9a1e/handoffs {"target_agent":"omp","isolate":true,
     "override_reason":"Claude 会话无 ledger 证据，已确认终端已关","override_actor":"luwei.will"}
200 {"handoff_id":"h_7a21","state":"ready_to_launch","isolate":true,
     "preconditions":{"termination":"unknown","coverage":"file_only","confirmed_by":"luwei.will"},
     "gaps":[{"kind":"liveness_unknown","cause":"file_only"}],
     "launch_command":"cd /…/worktrees/overload-mgmt-w_9a1e && OVERLOAD_PARENT=mgmt:handoff:h_7a21 omp"}
409 {"error":"confirmation_required","termination":"unknown",   # isolate=true 但缺 override_*
     "missing":["override_reason"]}
409 {"error":"workspace_contention","files":["x.ts"],"executions":["e_1","e_2"],"allowed":["isolate"]}

POST /handoffs/h_5f3c/launch                                                    # executor 超时
202 {"attempt_id":"la_1","state":"unknown","attention_item_id":"mgmt:handoff:h_5f3c",
     "options":["jump","attach","abandon"],"note":"不会自动重试；请先 reconcile"}

POST /acceptances/ac_7/submit                                                   # 产物已变
409 {"error":"manifest_drift","accepted_manifest_id":"m_77…","recomputed_manifest_id":"m_91…",
     "changed":[{"artifact_id":"a_1c…","from":"v_88…","to":"v_9d…"}]}
```

### 11.2 CLI（`src/cli/overload.ts` 新增子命令 `mgmt`）

```
overload mgmt scan [--once] | works [--track tracking] | show <work_id> | track <work_id> on|off
overload mgmt promote <work_id> --contract <file> --reason "…"        # 单向升级
overload mgmt manifest build <work_id> --artifacts a1,a2 --verify checks.txt
overload mgmt handoff create <work_id> --to omp [--isolate] [--manifest <id>]
#   unknown/file_only 源必须同时给 --isolate --override-reason "…" --override-actor <owner>（§9.1.1）；
#   无 --isolate 时直接报 liveness_unknown 并退出非 0，没有强制同目录启动的开关
overload mgmt handoff show <id> [--section artifacts|inputs|records] | launch <id>
overload mgmt handoff reconcile <id>                                   # unknown 专用，只读
overload mgmt handoff attach <id> --stable-id <sid> | abandon <id> --attempt <aid> --reason "…"
overload mgmt artifact cat <version_id>                                # 需 owner 授权；非 stored 返回 state
overload mgmt accept <manifest_id> --verdict accepted|rejected --reason "…"
overload mgmt submit <acceptance_id> --target github_pr
overload mgmt share-package <work_id> --manifest <id> --out <dir>
overload mgmt correct <link_id> --remove --reason "…"
```

### 11.3 UI（沿用 Now/Inbox/Done + 新增 `Tasks` 页；`dashboardRoute` 加 `tasks`，`src/web/server.ts:339-341`）

任务卡自上而下：① 一句话结论 + 状态；discovered（`candidate`）显示"未契约治理"徽章与"升级为 Work"入口。② 当前输入头版本（摘录 ≤ 200 字）与已确认约束。③ 产物列表：路径、版本 sha 前 8 位、"较上版 +12/-3 行"、验收徽章（草稿/待验收/已接受/已失效）、提交徽章（未提交/已推送/PR #n/已合并/提交失败）、共享徽章（**默认"不可分享"**）。④ 验证结果。⑤ 待决策：该 Work 下 open 的 Attention（内联）。⑥ Agent 接力记录：**执行**时间线（agent、`(stable_id, writer_id, attempt_no)`、起止、`exec_state`、`source_coverage`、跳转按钮）；`exec_state` 由 §9.8.0 派生得出时附"依据"浮层，展示 `closeout_evidence` 的判据（idle 时长、writer 证明、无待回答），**不得只写"已结束"**。⑦ 交接：选目标 Agent → 展示前置条件（`termination`/`coverage`/`freshness`）+ 缺口 → 生成交接包 → 启动；不满足时按钮禁用并显示具体原因 + "返回原现场"；`unknown`（含全部 file-only 源）时界面上 **不存在**同目录启动控件，只有一个"在隔离 worktree 中继续"按钮 + 必填风险确认勾选与理由（§9.1.1）。⑧ 折叠：完整执行记录、现场材料（uncertain）、可能相关任务、alias 来源历史。

**Done 区文案（§2.4.1 的 UI 契约）**：被 mgmt 归档的任务显示为"**已归档**"，并在副文写明"未作为正式 Work 完成（可升级后走验收）"；**不得**使用"已完成"字样。只有 `control_works.state='completed'`（由人或 coordinator 写入）的任务才显示"已完成"。两者在 Done 区共存但徽章不同。

注意力规则：发现/同步/新版本**不**开卡；只有验收请求、交接启动未知（§9.6.3）、健康告警、预算超限开卡；同任务卡 `item_id` 固定、原地 `upsertAttention` 更新。

---

## 12. 持久化与迁移

### 12.1 Schema 草案（control DB，`CONTROL_SCHEMA_VERSION` 1 → 2；沿用 `CONTROL_MIGRATIONS` 机制，`src/control/store.ts:71-81`）

**完整性前提（P0-4）**：SQLite 默认不强制外键。`openControl` 当前只设 `busy_timeout/journal_mode/synchronous`（`src/control/store.ts:86`），**必须**追加 `PRAGMA foreign_keys=ON`（每连接一次，不是每库一次）。由于所有写 control DB 的进程都走 `openControl`（`src/cli/overload.ts`、`src/web/server.ts`、`src/notify/nudge.ts` 等），一处修改即可覆盖。若因兼容原因不能全局开启，则每个 mgmt 写入函数必须在其 `immediate` 事务内显式做等价存在性检查——**不允许两者都不做**。

#### 12.1.0 建表顺序与引用环的显式处理（P0-4 残留项）

**SQLite 的真实行为（本次实测，sqlite3 3.53.4，复现命令见 §16.1）**：`CREATE TABLE` 允许 `REFERENCES` 指向尚不存在的表，建表语句本身**不报错**；但该表第一次被 DML 触碰时会失败 `no such table: main.<parent>`（即使插入的 FK 列值为 NULL 也失败）。v2 的 `apply` 只执行 `CREATE`，因此 v1 草案的乱序在迁移当下不报错、却在**第一次写入时**崩溃——等价于不可落地。故本版把 §12.1.1 的 DDL 重排为**拓扑序**：任何 `REFERENCES` 的目标表都在其之前创建，且**整份草案已按写出的顺序实际执行通过**（正向事务 + `PRAGMA foreign_key_check` 干净 + 4 项负向拒绝）。

**唯一的真实环：`mgmt_work_profile.input_head` ↔ `mgmt_inputs.work_id`。** 处理方式：**取消 `input_head` 上的物理外键**，`input_head` 降级为**可空的普通指针列**，由 §12.2 的事务不变式 ④ 强制。理由与代价：

- **为什么不用拓扑序解**：环在定义层，任何排列都有一端前向引用，拓扑序不可能存在。
- **为什么不用 `DEFERRABLE INITIALLY DEFERRED`**：实测可用（延后到 COMMIT 校验），但它只解决**同一事务内**的插入次序，并不解决**建表次序**——被引用表仍必须先于第一次 DML 存在；且 SQLite 的 deferred FK 只在显式事务边界生效，与现有 `db.transaction(...).immediate()` 形态叠加后更难推理。**不采用。**
- **实际写法**：`input_head` 为普通 `TEXT`（可空），在**同一 `immediate` 事务**内按 `profile(input_head=NULL)` → `inputs` → `UPDATE profile SET input_head=?` 三步写入（已实测通过）。`mgmt_inputs.work_id` 的物理 FK **保留**（方向 inputs → profile 无环）。
- **代价（如实记录）**：`input_head` 指向一个不存在的 `input_id` 不会被数据库拒绝（已实测：该 `UPDATE` 被接受）。因此 §12.2 新增不变式 ④：任何写 `input_head` 的语句必须在同一事务内附加 `AND EXISTS(SELECT 1 FROM mgmt_inputs WHERE input_id=? AND work_id=?)`，`changes=0` 即回滚。这是本方案中**唯一**一处以事务检查替代外键的位置，必须由 `schema.test.ts` 专项覆盖。

**同时修正的其他前向引用**（评审只点名两处，此处为全表复核结果）：`mgmt_executions` 曾引 `binding/inputs/manifests/handoffs` 四张后声明的表；`mgmt_observations` 曾引 `versions/exec`；`mgmt_manifest_entries` 曾引 `versions`；`mgmt_handoffs` 曾引 `exec/manifests`；`mgmt_handoff_launch_attempts` 曾引 `handoffs`；`mgmt_external_effects`/`mgmt_exec_records`/`mgmt_inputs`/`mgmt_artifacts`/`mgmt_links`/`mgmt_work_hints` 曾引 `W`；`mgmt_acceptances`/`mgmt_submissions` 曾引 `manifests`/`acceptances`。重排后全部满足"目标先建"。

**第二处降级：`mgmt_executions.parent_handoff_id`。** `executions` 与 `handoffs` 也互相引用（`handoffs.source_execution_id → executions`，`executions.parent_handoff_id → handoffs`）。这里选**拓扑序 + 单向降级**：`handoffs` 在 `executions` 之后创建并保留其物理 FK（交接必须有真实源执行）；`parent_handoff_id` 取消物理 FK，改为普通可空列，由 §12.2 不变式 ⑤ 在绑定 successor 的事务内校验 `EXISTS(mgmt_handoffs WHERE handoff_id=?)`。选择理由：源执行是交接的**成立前提**（不可为空，必须 DB 级强制），而 `parent_handoff_id` 只是溯源指针（可空，事后回填），降级它的风险更低。

#### 12.1.1 可执行的 v2 DDL（按此顺序）

```sql
-- 顺序即执行顺序。生产实现加 IF NOT EXISTS（此处省略以保持可读）。
-- SENS 在真实 DDL 中展开为 sensitivity TEXT NOT NULL DEFAULT 'unknown'
--                        + scanner_version INTEGER NOT NULL DEFAULT 0（§7.4）。
-- 描述性列（excerpt/actor/meta 等）保留但不逐一注释。
-- control_works 是 v1 已有表（src/control/store.ts:22-27），不重建。

-- ① 只引用 v1 既有表
CREATE TABLE mgmt_work_profile(work_id TEXT PRIMARY KEY REFERENCES control_works(work_id),
  origin_mode TEXT NOT NULL CHECK(origin_mode IN ('discovered','contract_governed')),
  closeout_owner TEXT NOT NULL CHECK(closeout_owner IN ('mgmt','coordinator','orchestrator')),
  track_state TEXT NOT NULL CHECK(track_state IN ('tracking','paused','archived')),
  decision_owner TEXT NOT NULL, discovered_title TEXT NOT NULL,
  input_head TEXT,               -- 无 FK：环已拆除，由 §12.2 不变式 ④ 强制
  archived_at INTEGER, archive_reason TEXT, updated_at INTEGER NOT NULL);
  -- 另有 repo_root/cwd/host/primary_agent/created_at
CREATE INDEX mgmt_work_profile_track ON mgmt_work_profile(track_state, updated_at);

CREATE TABLE mgmt_work_alias(alias_work_id TEXT PRIMARY KEY REFERENCES control_works(work_id),
  canonical_work_id TEXT NOT NULL REFERENCES control_works(work_id),
  reason TEXT NOT NULL, actor TEXT NOT NULL, created_at INTEGER NOT NULL,
  CHECK(alias_work_id<>canonical_work_id));   -- §8.4，永不重写 artifact 身份

-- ② 只引用 profile
CREATE TABLE mgmt_session_binding(stable_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  role TEXT NOT NULL, evidence_ref TEXT NOT NULL, bound_at INTEGER NOT NULL);
  -- PK 保证一个 Session 最多属一个 Work。role: origin|child|resumed|successor|explicit|orch_runner

CREATE TABLE mgmt_inputs(input_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  kind TEXT NOT NULL, version INTEGER NOT NULL, supersedes TEXT REFERENCES mgmt_inputs(input_id),
  execution_id TEXT,             -- 无 FK：executions 尚未创建；由 §12.2 不变式 ⑤ 同样方式校验
  source TEXT, evidence_ref TEXT, excerpt TEXT, ref_uri TEXT, actor TEXT, at INTEGER NOT NULL, SENS,
  UNIQUE(work_id,kind,version));
  -- kind ∈ user_message|reference|constraint|decision|approval|acceptance|feedback

CREATE TABLE mgmt_artifacts(artifact_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  kind TEXT NOT NULL, canonical_key TEXT NOT NULL, display_path TEXT, created_at INTEGER NOT NULL,
  UNIQUE(work_id,kind,canonical_key));   -- kind ∈ file|git_commit|git_dirty|external

-- ③ 引用 artifacts
CREATE TABLE mgmt_artifact_versions(version_id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL REFERENCES mgmt_artifacts(artifact_id),
  content_kind TEXT NOT NULL CHECK(content_kind IN ('content','deleted','metadata_only')),
  content_sha256 TEXT NOT NULL, snapshot_path TEXT, staging_name TEXT,
  snapshot_state TEXT NOT NULL CHECK(snapshot_state IN
    ('pending','stored','lost','too_large','withheld_sensitive','pruned','reference_only','write_failed')),
  SENS, shareable INTEGER NOT NULL DEFAULT 0, producer TEXT NOT NULL,   -- <execution_id>|multiple|unknown
  history_available INTEGER NOT NULL DEFAULT 1, stale_capture INTEGER NOT NULL DEFAULT 0,
  observed_at INTEGER NOT NULL, evidence_at INTEGER);
CREATE UNIQUE INDEX mgmt_versions_artifact_version ON mgmt_artifact_versions(artifact_id, version_id);  -- P0-4 基础
CREATE INDEX mgmt_versions_artifact ON mgmt_artifact_versions(artifact_id, observed_at);

-- ④ 引用 profile + versions
CREATE TABLE mgmt_manifests(manifest_id TEXT PRIMARY KEY,   -- P1-7；= digest，只 INSERT
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  repo_root TEXT, git_head TEXT, git_tree_sha TEXT, base_ref TEXT, base_sha TEXT,
  verification TEXT NOT NULL, built_by TEXT NOT NULL, built_at INTEGER NOT NULL);

CREATE TABLE mgmt_manifest_entries(manifest_id TEXT NOT NULL REFERENCES mgmt_manifests(manifest_id),
  artifact_id TEXT NOT NULL, version_id TEXT NOT NULL,
  PRIMARY KEY(manifest_id, artifact_id), UNIQUE(manifest_id, version_id),
  FOREIGN KEY(artifact_id, version_id) REFERENCES mgmt_artifact_versions(artifact_id, version_id));
  -- ↑ 复合 FK 证明该 version 确属该 artifact（P0-4 核心缺口，已实测拒绝跨 artifact 引用）

-- ⑤ 引用 profile + binding + inputs + manifests（全部已创建）
CREATE TABLE mgmt_executions(execution_id TEXT PRIMARY KEY,   -- P1-5
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  stable_id TEXT NOT NULL REFERENCES mgmt_session_binding(stable_id),
  writer_id TEXT NOT NULL, attempt_no INTEGER NOT NULL,
  exec_state TEXT NOT NULL CHECK(exec_state IN ('running','ended_ok','ended_failed','vanished','unknown')),
  source_coverage TEXT NOT NULL CHECK(source_coverage IN ('ledger_full','file_only','ledger_stale','gapped')),
  input_head_at_start TEXT REFERENCES mgmt_inputs(input_id),
  baseline_manifest_id TEXT REFERENCES mgmt_manifests(manifest_id),
  parent_handoff_id TEXT,        -- 无 FK：executions↔handoffs 环的降级端，§12.2 不变式 ⑤
  ledger_evidence TEXT NOT NULL, -- 跨库快照，§12.4
  closeout_evidence TEXT,        -- §9.8.0 派生终止证据；仅 ended_ok/ended_failed 时非空
  agent TEXT, cwd TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, last_observed_at INTEGER,
  UNIQUE(stable_id, writer_id, attempt_no));
CREATE INDEX mgmt_executions_work ON mgmt_executions(work_id, started_at);

-- ⑥ 引用 executions
CREATE TABLE mgmt_handoffs(handoff_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  source_execution_id TEXT NOT NULL REFERENCES mgmt_executions(execution_id),
  manifest_id TEXT REFERENCES mgmt_manifests(manifest_id), target_agent TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('ready_to_launch','stale','launching','launch_unknown','launch_failed','bound','ended','abandoned')),
  packet TEXT NOT NULL, packet_sha256 TEXT NOT NULL, workspace_fp TEXT NOT NULL,
  isolate INTEGER NOT NULL DEFAULT 0, override_reason TEXT, override_actor TEXT, new_stable_id TEXT);
CREATE UNIQUE INDEX mgmt_handoffs_inflight ON mgmt_handoffs(work_id)   -- v1 漏掉 launch_unknown
  WHERE state IN ('ready_to_launch','launching','launch_unknown','bound');

CREATE TABLE mgmt_handoff_launch_attempts(attempt_id TEXT PRIMARY KEY,   -- P0-2 不可变尝试日志
  handoff_id TEXT NOT NULL REFERENCES mgmt_handoffs(handoff_id),
  idempotency_key TEXT NOT NULL UNIQUE, attempt_no INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN
    ('requested','started','receipt_known','unknown','bound','abandoned','failed_no_effect')),
  command TEXT NOT NULL, command_args TEXT NOT NULL, target_cwd TEXT NOT NULL, target_surface TEXT,
  receipt TEXT, observed_pid INTEGER, observed_boot_id TEXT, bound_stable_id TEXT,
  reconciled_at INTEGER, reconcile_result TEXT, requested_at INTEGER NOT NULL, resolved_at INTEGER,
  UNIQUE(handoff_id, attempt_no));

CREATE TABLE mgmt_observations(observation_id INTEGER PRIMARY KEY AUTOINCREMENT,   -- P1-1 来源与身份解耦
  version_id TEXT NOT NULL REFERENCES mgmt_artifact_versions(version_id),
  execution_id TEXT REFERENCES mgmt_executions(execution_id), observed_source TEXT NOT NULL,
  evidence_ref TEXT NOT NULL, observed_at INTEGER NOT NULL, UNIQUE(version_id, evidence_ref));

CREATE TABLE mgmt_exec_records(record_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  execution_id TEXT NOT NULL REFERENCES mgmt_executions(execution_id), kind TEXT NOT NULL,
  source_ref TEXT NOT NULL UNIQUE, source_state TEXT NOT NULL DEFAULT 'available',
  tool TEXT, excerpt TEXT, is_error INTEGER, at INTEGER NOT NULL, SENS,
  shareable INTEGER NOT NULL DEFAULT 0);   -- **默认不可分享**（§7.4）

CREATE TABLE mgmt_external_effects(effect_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  execution_id TEXT REFERENCES mgmt_executions(execution_id), kind TEXT NOT NULL, target TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('observed','confirmed','unknown','superseded')),
  evidence_ref TEXT NOT NULL, reconcile_cmd TEXT, reconciled_at INTEGER, observed_at INTEGER NOT NULL,
  UNIQUE(work_id, kind, target, idempotency_key));

CREATE TABLE mgmt_links(link_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  subject TEXT NOT NULL, relation TEXT NOT NULL, object TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('strong','weak','uncertain')),
  evidence_ref TEXT NOT NULL, observed_at INTEGER NOT NULL,
  supersedes TEXT REFERENCES mgmt_links(link_id), superseded_at INTEGER, actor TEXT, reason TEXT,
  UNIQUE(subject,relation,object,evidence_ref));
CREATE INDEX mgmt_links_object ON mgmt_links(object, relation);

-- ⑦ 引用 manifests / acceptances
CREATE TABLE mgmt_acceptances(acceptance_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  manifest_id TEXT NOT NULL REFERENCES mgmt_manifests(manifest_id),
  verdict TEXT NOT NULL CHECK(verdict IN ('accepted','rejected')), actor TEXT NOT NULL,
  evidence TEXT NOT NULL, invalidated_at INTEGER, invalidated_reason TEXT,
  UNIQUE(manifest_id, verdict, actor));

CREATE TABLE mgmt_submissions(submission_id TEXT PRIMARY KEY,
  acceptance_id TEXT NOT NULL REFERENCES mgmt_acceptances(acceptance_id),
  manifest_id TEXT NOT NULL REFERENCES mgmt_manifests(manifest_id),
  target_kind TEXT NOT NULL, target TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','pushed','pr_created','merged','failed','unsupported')),
  steps TEXT NOT NULL, external_ref TEXT,
  submitted_manifest_digest TEXT NOT NULL,   -- 生效瞬间重算值，供审计
  idempotency_key TEXT UNIQUE);

CREATE TABLE mgmt_work_hints(work_id TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  other_work_id TEXT NOT NULL, reason TEXT NOT NULL, score REAL, created_at INTEGER NOT NULL,
  PRIMARY KEY(work_id, other_work_id, reason));

-- ⑧ 无外键辅助表（顺序任意）
CREATE TABLE mgmt_corrections(evidence_ref TEXT PRIMARY KEY, decided_at INTEGER NOT NULL,
  actor TEXT NOT NULL, reason TEXT);   -- 阻止采集器自动恢复已被人纠错的关联
CREATE TABLE mgmt_summaries(subject_id TEXT NOT NULL, subject_version TEXT NOT NULL, generator TEXT NOT NULL,
  text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(subject_id, subject_version, generator));
CREATE TABLE mgmt_cursors(source_key TEXT PRIMARY KEY, cursor TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0, last_status TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE mgmt_discovery_log(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL,
  stable_id TEXT, reason TEXT NOT NULL, detail TEXT);
```

**本次对上面这份草案实际执行的验证**（结果记入 §16.1，同时是 §13.2 的强制断言）：

| 检查 | 结果 |
|---|---|
| 按上述顺序全量建表（`PRAGMA foreign_keys=ON`） | 通过，无 `no such table` |
| 一个 `immediate` 事务写完 profile→inputs→`UPDATE input_head`→binding→execution→artifact→version→manifest→entry→handoff→successor execution→acceptance→submission→observation→exec_record→external_effect→link | 通过 |
| `PRAGMA foreign_key_check` | 空（无违规） |
| 悬挂 `mgmt_manifest_entries(m1, a_ghost, v_ghost)` | 被 FK 拒绝 |
| 跨 artifact 的 entry（`m2` 引 `a2` + 属于 `a1` 的 `v1`） | 被**复合 FK** 拒绝 |
| 悬挂 `mgmt_executions.work_id='w_ghost'` | 被 FK 拒绝 |
| 同 Work 第二条 `ready_to_launch` 交接 | 被 `mgmt_handoffs_inflight` 部分唯一索引拒绝 |
| `UPDATE mgmt_work_profile SET input_head='in_ghost'` | **被接受**（这正是拆环的代价，故必须有 §12.2 不变式 ④） |


### 12.2 关键事务不变式（P0-4 运行时部分）

外键防悬挂，但不防"错误的组合"；另有两条因拆环而**没有**外键保护的指针列（§12.1.0）。以下均必须在 `immediate` 事务内显式检查：① **构建 manifest**——所有 entry 的 `artifact_id.work_id` ∈ `{work_id} ∪ alias 集`，`git_head`/`base_sha` 现读现写，插入后立刻重算 digest 并与主键比对，不等则回滚（防构建函数与 digest 函数漂移）；② **创建 acceptance**——`manifest.work_id = acceptance.work_id`、`invalidated_at IS NULL`、`history_gap_unacknowledged` 检查（§7.6）；③ **创建 submission**——`acceptance.manifest_id = submission.manifest_id` 且 `recomputed_manifest_id = manifest_id`（§10.2 第 ② 步），且该 Work 无 `state='unknown'` 的 external effect。

**拆环后新增的两条（P0-4 残留项，替代被取消的物理外键）**：

④ **写 `mgmt_work_profile.input_head`**——任何语句必须写成单行条件更新，不得读后写：

```sql
UPDATE mgmt_work_profile SET input_head=:input_id, updated_at=:now
 WHERE work_id=:work_id
   AND EXISTS(SELECT 1 FROM mgmt_inputs WHERE input_id=:input_id AND work_id=:work_id);
-- changes=0 → 抛 ControlError('conflict','input_head_target_missing') 并回滚整个事务
```

同理适用于 `mgmt_inputs.execution_id` 的回填（`AND EXISTS(SELECT 1 FROM mgmt_executions WHERE execution_id=:eid AND work_id=:work_id)`）。

⑤ **写 `mgmt_executions.parent_handoff_id`**——只在绑定 successor 的事务内写入，且必须同时成立：

```sql
UPDATE mgmt_executions SET parent_handoff_id=:handoff_id
 WHERE execution_id=:eid AND parent_handoff_id IS NULL
   AND EXISTS(SELECT 1 FROM mgmt_handoffs WHERE handoff_id=:handoff_id AND work_id=:work_id);
-- changes=0 → conflict；且 parent_handoff_id 写入后**不得再改**（港湾指针只写一次）
```

**强制要求**：这两列是全方案仅有的两处"用事务检查代替外键"，必须由 `src/manage/schema.test.ts` 专项断言覆盖（§13.1）：绕过它们直接 `UPDATE` 写入不存在的 id 会被 DB 接受（已实测），因此代码路径必须集中在单一写入函数中，不得在多处展开。

### 12.3 discovered Work 的既有接口约束（§2.4.1）

mgmt 卡用 `upsertAttention` 创建、用 mgmt 自持事务解卡；**不调用** `resolveAttentionDecision`（要求 `work.state='active'`，`src/control/store.ts:293`），**不调用** `recordStopCondition`（要求 contract 非空，`:184`）。升级后（`promoteWork` 成功、`active`、contract 非空）两者自然可用；UI 在升级前如实标注"不可使用契约收窄"。

### 12.4 跨库引用（ledger）的验证方式

`mgmt_executions.stable_id` 指向 ledger DB，SQLite 无法跨库外键。规则：① 写入时从 ledger 读一次并**快照**关键证据到 `ledger_evidence`（`{journal_seq, at, kind, detail_sha256}`），此后 mgmt 侧判断以本地快照为准，不依赖 ledger 仍存在；② 每轮重读时若同一 `journal_seq` 的 `detail_sha256` 不一致（journal 仅追加，理论不应发生）→ 记 `ledger_evidence_mismatch` 并把该执行标 `gapped`，**不覆盖历史快照**；③ ledger 不可用时（§6.3.3）已有快照仍可用于展示与交接包，只是 `source_coverage` 降级，从而自动卡住 §9.1 的启动门禁。

### 12.5 向后兼容、部署顺序与回滚（P1-8）

**事实**：`ensureControlSchema` 在 `version > CONTROL_SCHEMA_VERSION` 时抛 `blocked`（`src/control/store.ts:75`），而 control DB 被 web / CLI / daemon / orchestrator / notify 多个入口打开（`src/web/server.ts:155`、`src/cli/overload.ts:48,51,57,71`、`src/notify/nudge.ts:46`）。因此迁移到 v2 后，**任何仍是 v1 的旧二进制都会打不开该库**，不只是 manage。

- **纯追加**：只 `CREATE TABLE`/`CREATE INDEX`，不 `ALTER`、不改现有表。除新增 `PRAGMA foreign_keys=ON` 外，v1 的所有读写路径在 v2 库上行为不变。
- **`destructive:false`**（修正 v1 的"推荐标 destructive:true"）。该标志在现有代码中的**唯一**作用是触发 `VACUUM INTO` 全库备份（`src/control/store.ts:67-69,78`）。把追加式迁移标成 destructive 是把"要不要备份"伪装成"语义破坏性"，会误导维护者且对大库产生不必要的全量复制。**"需要备份" ≠ "语义破坏"。**
- **备份是部署步骤，不是迁移标志**：升级前手动 `sqlite3 orchestrator-answers.db "VACUUM INTO 'pre-v2.bak'"`，且**必须在所有写者停止时执行**。

**部署顺序（强制）**：① 停止所有打开 control DB 的进程；② 备份；③ 一次性升级**全部**二进制到 v2；④ 启动任一 v2 进程自动跑迁移；⑤ 最后才开 `manage.enabled=true`。

**旧读者行为（如实告知）**：升级后残留的 v1 进程调用 `openControl` 会得到 `ControlError('blocked', 'control schema version 2 is newer than supported 1')`，表现为启动失败或请求 500，**不是静默降级**。**兼容窗口为零**——这是现有机制的性质，非本方案引入。若需非零窗口，须先改 `ensureControlSchema` 允许"已知更高版本且表集合是超集"的只读打开，属独立改动，本期不做。

**回滚（修正 v1）**：**不把整库恢复当作常规回滚**——迁移后 control DB 会继续接受新的 Work/Attention/mailbox/outbox 写入，恢复 `pre-v2.bak` 会丢弃这些写入，代价远大于回滚 mgmt 功能本身。常规回滚 = **功能回滚**：① `manage.enabled=false` 并停 manage；② 保留 v2 二进制与 v2 库（`mgmt_*` 只是未被使用的表）；③ 需要时删 `~/.overload/artifacts/mgmt/` 释放空间（行转 `pruned`/`lost`，不影响其他模块）。其他模块不读 `mgmt_*`，保留零成本。**schema 单向，不提供 down migration**；确需回到 v1 二进制时才用备份恢复，且必须接受"迁移后写入丢失"、在停机窗口内操作——这一条要写进发布说明，**不得以"回滚很简单"的措辞呈现**。历史数据缺口：迁移不回填任何 `mgmt_*` 行；首次 `manage` 运行按发现范围回填。

---

## 13. 测试与验收

**术语纪律**：本节所有 `src/manage/*.test.ts`、`test/harness/e2e-mgmt.ts`、fixture 目录**均为计划中的测试，尚不存在**。仓库现有测试见 §13.6，二者不得混淆。

**13.1 计划新增的单元测试**（`src/manage/*.test.ts`）：`discovery.test.ts`（时间范围按活动而非创建；agents/hosts/cwd 过滤；§6.3.3 八种 `source_status`；任一都不产生 vanished/归档）· `session-readers.test.ts`（pi/omp v3 与 claude jsonl 的 fixture 解析：用户消息、toolCall/toolResult 配对、路径提取、isError）· `identity.test.ts`（同内容经三种来源 → 同一 `version_id` + 三条 `mgmt_observations`；`deleted`/`metadata_only` 身份分离）· `atomicity.test.ts`（§6.3.1：commit 后 finalize 前崩溃 → 对账转 `stored`；两者皆缺 → `lost` 而非 `stored`；孤儿 blob 清理；cursor 与观察行同事务）· `link.test.ts`（§8.1 规则优先级；同仓库近时不合并；read 不升级 modified；并发 → `producer='multiple'`）· `artifact.test.ts`（版本幂等；`too_large`/`withheld_sensitive`；prune 后行保留；删除产生 `deleted` 版本）· `handoff-gate.test.ts`（§9.1 判定矩阵全行；五种 `unknown` 情形同目录启动被拒；§9.1.1：file_only 在 `isolate=false` → 409、`isolate=true` 无 override → 409、三者齐全 → 200 且 cwd 为 worktree）· `launch-idempotency.test.ts`（§9.6 状态机：ENOENT → `failed_no_effect` 可重试；超时与 `requested` 超时 → `unknown` 不可重试；reconcile 找到 → `bound`）· `manifest.test.ts`（digest 稳定；跨 artifact 的 version 被复合 FK 拒绝；另一文件/base/verification 变化 → 旧 acceptance 失效）· `export-boundary.test.ts`（默认 `shareable=0`；`buildSharePackage` 输出不含任何 blob 内容）· `archive.test.ts`（§9.8 谓词六条；真实转 `archived`；`closeout_owner='coordinator'` 时 profile 与 `control_works` 均不被改写；迟到 reopen；**§9.8.0 派生结束**：无 `session_ended` 的 idle+drained+grace → `ended_ok` 且 `closeout_evidence` 非空，四种负向情形保持 `running`，后续 `working` 触发 `revoked_at`）· `authority.test.ts`（§2.4.1：对 `src/manage/**` 做源级扫描，断言**不存在** `UPDATE control_works` 字样；并以真实 DB 断言归档后 `control_works.state` 不变）· `schema.test.ts`（§12.1.1 按序建表可执行；`PRAGMA foreign_key_check` 空；四项负向拒绝；§12.2 不变式 ④⑤：绕过写入函数的悬挂 `input_head`/`parent_handoff_id` 能被 DB 接受，因此写入函数必须拒绝）· `redact.test.ts`（scrub 覆盖已知 token 模式，**只测正则本身，不作为泄露保证**）。

**13.2 计划新增的集成测试**：复用 `test/harness/gen-p2-spool.ts` 造 spool + 假 HOME，`test/harness/ingest-once.ts` 跑真 ingest，再跑 `bun src/manage/manage.ts --once`；断言 `control_works`（`source='discovered'`）/`mgmt_work_profile`/`mgmt_executions` 行数与 link 内容。提供 `test/fixtures/sessions/{pi,omp,claude}/*.jsonl`（脱敏最小样本）。两次 `--once` 行数不变。外键生效验证：`PRAGMA foreign_keys` 返回 1；插入悬挂 `manifest_entry` 被拒。**迁移可执行性验证（P0-4）**：在空库上按 §12.1.1 的书写顺序逐句执行，不得出现 `no such table`；随后在一个 `immediate` 事务内完成 §12.1.1 表中列出的全链写入（含 `input_head` 的后置 `UPDATE`），结束后 `PRAGMA foreign_key_check` 必须为空。

**13.3 计划新增的端到端**：

```sh
HOME=$(mktemp -d) bun test/harness/e2e-mgmt.ts --scenario handoff-pi-to-omp
HOME=$(mktemp -d) bun test/harness/e2e-mgmt.ts --scenario crash-after-launch
HOME=$(mktemp -d) bun test/harness/e2e-mgmt.ts --scenario sensitive-export
HOME=$(mktemp -d) bun test/harness/e2e-mgmt.ts --scenario auto-archive-reopen
HOME=$(mktemp -d) bun test/harness/e2e-mgmt.ts --scenario derived-closeout-no-session-ended   # §9.8.0
HOME=$(mktemp -d) bun test/harness/e2e-mgmt.ts --scenario file-only-isolated-handoff          # §9.1.1
```

**13.4 计划新增的故障注入**：ledger chmod 000 → 本轮跳过、`unavailable`、Work 与执行无状态变化；ledger 表被 DROP（corrupt）→ 立即开卡、不归档任何 Work；单个 jsonl chmod 000 → 该执行 `gapped`、cursor 不推进、交接门禁拒绝；jsonl 截断 → cursor 重置且不产生重复版本；快照目录只读 → `write_failed`、不崩溃、不进 manifest；**commit 后 `kill -9`** → 重启对账转 `stored` 或 `lost`，**绝不留 `pending` 假装已存储**；**executor 已 spawn 但写 receipt 前 `kill -9`** → 该 attempt 转 `unknown`、产生三选项卡、**不自动重启第二个 Agent**；`git ls-remote` 失败 → external effect `unknown`、提交被阻止。

**13.5 通过/失败标准**：所有 `bun test` 通过；e2e 六场景全部断言通过；两次 `--once` 产生的 `mgmt_*` 行数相同；任何场景下 `mgmt:` 卡数量 ≤ 预期（普通进度为 0）；故障注入每条都有对应断言且**断言的是状态而非日志文案**；不依赖人工盯 UI，UI 变更由 `src/web/server.test.ts` 风格的 HTTP 断言覆盖。

**13.6 仓库中已存在的相关测试（不是本方案的产出）**：`src/orchestrator/{submit,evidence,worktree,coordinator,pr,runner,store,approval,orchestrator,cli,spool,coordinator-continuation}.test.ts`、`src/ingest/{ingest,reducer,cmux,classifier,prune}.test.ts`、`src/control/{store,outbox,projection}.test.ts`、`src/shared/{resume,queries,jump}.test.ts`。本方案复用它们作为回归基线（例如 `submit.test.ts` 已覆盖 push/pr 的 confirmed/unknown 区分），但**它们不覆盖任何 mgmt 场景**。

---

## 14. 分阶段实施

**阶段 0：地基（1 周）** · 模块 `src/shared/redact.ts`（抽取）、`src/manage/schema.ts`（迁移 v2 + `PRAGMA foreign_keys=ON`）、`src/manage/classify.ts`（敏感度分类）、`src/manage/readers/{pi,omp,claude}.ts`。交付 schema + 三种 jsonl 读取器 + fixture + 身份函数（§5.1）。验收 `identity.test.ts`、`export-boundary.test.ts`、**`schema.test.ts`**（§12.1.1 顺序可执行 + §12.2 不变式 ④⑤）通过；外键生效验证；对本机 3 类真实文件各抽 1 个做只读解析 smoke；并用现有测试套件验证 D13 风险。风险：jsonl 格式变更 → 读取器需版本字段容错（v3 `type:session`）。本期不做任何采集进程。

**阶段 1：真实端到端接管与交接（2–3 周）——必须跑通** · 范围本机 pi → omp（或反向），源执行已终止且 `source_coverage='ledger_full'`。模块 `src/manage/manage.ts`（发现+采集+link+快照，含 §6.3.1 原子性与双向对账）、`src/manage/handoff.ts`（含 §9.6 启动日志与 reconcile）、web `/api/mgmt/*` 最小集、CLI `mgmt scan|works|show|handoff`、UI `Tasks` 页最小版。端到端路径：① 用户在 cmux 手动启动 `pi`，改两个文件，退出；② `manage --once` 建 discovered Work（`candidate`）+ profile + 1 条执行，提取用户消息为 `in_v1`，两个 `file` 产物各一版本 + `modified` strong link；③ UI 显示产物与版本，点"交给 omp" → §9.1 前置通过（展示 `termination/coverage/freshness`）→ 生成交接包 → 启动（**先写 `requested` 行，再调** cmux new-workspace，复用 `src/shared/resume.ts:43` 的 executor 形态）；④ omp 新 Session 带 `OVERLOAD_PARENT=mgmt:handoff:<id>` 写 spool，ingest 落 `sessions.origin`，manage 绑 successor（attempt 转 `bound`），omp 改文件 → 新版本挂同一 Work；⑤ omp 退出 → 若无 `session_ended` 则由 §9.8.0 派生结束写 `exec_state='ended_ok'` + `closeout_evidence` → §9.8.1 谓词满足 → `track_state='archived'`（**真实状态转移**，且 `control_works.state` 仍为 `candidate`、不被 manage 改写）；期间无普通进度卡。依赖：本机 ingest 运行（当前未运行，§16）；extension 已装到 pi/omp。验收：§13.3 的 `handoff-pi-to-omp` 与 `crash-after-launch` 通过 + 一次真实手动演练记录。风险：session 文件与 ledger `stable_id` 的 uuid 对应关系依赖 `sessionManager.getSessionId()`（`src/extension/overload.ts:687`）与文件名 uuid 一致——**推断**一致（环境观察 `01a090e4-…`），需在阶段 0 用断言固化。本期不做：验收/提交、Claude、并发冲突 UI、模型摘要、alias。

**阶段 1 的 ssh 增量范围（D1，本版新增）**：阶段 1 必须同时交付 `src/manage/source.ts` 的 `localSourceFs` **与** `sshSourceFs`，并对**一台**真实 ssh 主机跑通 **发现 + 快照**（`listFiles` 发现远端 jsonl、`readRange` 增量读、`readFile` 快照产物、`exec` 跑远端 `git status`），以及 §6.4.3 的 host 校验与 `HostId` 放宽。**强制端到端路径仍是本机 `pi → omp`**（上述 ①–⑤ 不变）；远程主机上的**交接启动允许但不强制**（§6.4.6），它进入阶段 3 的强制验收。阶段 1 的 ssh 验收点：对远端一个 pi Session 建出 discovered Work + 至少 1 个 `file` 产物版本，且 `stable_id` 的 host 段等于远端 `~/.overload/host`；拔掉 ssh（或改错 `remote`）后该主机转 `unavailable`、既有 Work **不被归档也不被标 `vanished`**（§6.4.5）。依赖：远端已写入唯一 `~/.overload/host`；本机到该主机的 `BatchMode=yes` 免密可用。

**阶段 2：manifest / 验收与提交衔接（1–2 周）** · 模块 `mgmt_manifests`/`_entries`/`_acceptances`/`_submissions`/`_external_effects`、Attention 验收卡、`submitTask` 纯函数抽取复用、PR 状态回写、§10.2 提交前重算。验收 §17 场景 15/16 的全部 Given/When/Then 与 `manifest.test.ts`。本期不做非 GitHub 目标。

**阶段 3：Claude 部分接入 + 纠错 + 并发归属 + alias（1–2 周）** · 模块 claude reader 接入发现；`present_in_workspace`/`multiple` 与 §7.2.1 交接一致性；`/links/*/correct`；`mgmt_work_hints`；`mgmt_work_alias`；**远程 ssh 主机的全量接入（多主机、远端 git、远端隔离 worktree、§6.4.6 启动路径进入强制 e2e）**。验收 Claude Session 以 `file_only` 纳管，且交接门禁按 §9.1.1 行事：`isolate=false` 如实拒绝（409 `liveness_unknown`）、`isolate=true` + 完整 override 时可启动且落在隔离 worktree；并发场景不伪造来源。本期不做 Claude 自动 successor 绑定与 Work 拆分。

**阶段 3 实施验收（2026-09-14）**：已实现 Claude 显式工具结果与跨扫描 pending-call、并发/dirty 归属、纠错 fence、同主机相关提示、不可变 alias 与来源标注、配置 host ID/SSH alias 分离、远端 git/隔离 worktree/packet 传输及默认非交互启动。真实 `koda-dev` 发现 118 Session，重扫零新增；不可达主机零写入。默认远端 Claude 在隔离 worktree 消费密封 packet 并输出 `OVERLOAD_REMOTE_PHASE3_OK`，源树干净。本机 accept-and-submit 六步通过；全工作区 509 pass/1 skip/0 fail，隔离提交树 488 pass/1 skip/0 fail。原未知启动未重放。Claude 不自动绑定 successor；Work 不拆分；alias 只聚合展示，不迁移历史。单份 manifest 仍属单一来源；跨主机 alias 可展示，混合来源 manifest 明确拒绝 `manifest_multiple_sources`，不以单个 SourceFs 错读他机路径。未 push、未部署。

**阶段 4（D1 已决定后的残余）：云端 Agent 手动导入** · D1 已在 2026-09-12 决定为「本机 + ssh 远程主机」，ssh 远程接入已下沉到阶段 1（发现+快照）与阶段 3（全量），故**本阶段只剩「云端 Agent 手动导入」**：无 ssh 可达性的托管 Agent（如浏览器端 / 受管云环境）仅支持人工粘贴会话导出或上传产物，以 `source_coverage='file_only'` 纳管，启动判定永远 `unknown`，只能走 §9.1.1 的隔离 worktree + 人工确认路径。**不做**云端轮询、**不做**反向隧道、**不做**分布式调度。

---

## 15. 未决问题、推荐默认值与用户需要决定的事项

**决策状态（2026-09-12）**：D1 / D2 / D5 由用户显式裁定（下表标 **用户决定**）；**其余 D3、D4、D6–D13 一律采用本表推荐默认值（用户 2026-09-12 授权）**，不再作为待决项阻塞实现。

| ID | 事项 | 决定 / 推荐 | 影响 |
|---|---|---|---|
| **D1** | 第一版范围 | **用户决定：本机 + ssh 远程主机**（v3 的「仅本机」推荐已被推翻）。落地契约见 **§6.4**：统一 `SourceFs` 抽象、`manage.hosts[]` 对象化配置、复用 pull 的 ssh 约定（`src/pull/pull.ts:42-47`）、`stable_id` 的 host 段必须等于远端 `~/.overload/host`（`src/extension/overload.ts:220-229`） | 必须实现：远端 jsonl 发现/增量读/快照（`SourceFs.listFiles/readRange/readFile`）、远端 git（`SourceFs.exec`）、远端启动命令（§6.4.6）、跨机身份放宽（`HostId` 由 `local\|devbox` 枚举放宽为 `string`，`src/shared/types.ts:10`，并同步 `src/orchestrator/spool.ts:12`、`src/recon/recon.ts:650` 的硬校验）、ssh 不可达 ⇒ `unavailable` 而非空（§6.4.5）。云端 Agent 仍只到"手动导入"级（§14 阶段 4）。 |
| **D2** | 首批 Agent | **用户决定：仅 pi / omp / claude**。pi/omp 目标"完整接入"（本机与远端 ssh 同级），Claude"部分接入"；**prime-agent 与 cmux 退为事件层注记，不入首批** | `manage.agents` 取值域收窄为 `["pi","omp","claude"]`，其余 runtime 在发现阶段记 `runtime_out_of_scope` 且不建 Work（§6.1 D2 落定段）。Claude hook 不在仓库，是否回收进 `install-extension.sh` 见 D9。 |
| D3 | 默认回溯范围 | **7d**（采用推荐默认值，用户 2026-09-12 授权） | 30d 会一次性为本机约 900 个历史 Session 建 Work，噪声大。 |
| D4 | 快照上限 | 2 MiB / 64 MiB / 30 天（§7.5）（采用推荐默认值，用户 2026-09-12 授权） | **远端同限**：ssh `readFile` 走同一上限与同一 `too_large` 语义，不因跨机放宽或收紧（§6.4.4）。 |
| **D5** | 交接是否自动启动 | **用户决定：需 UI 确认；确认界面可以是 demo 级对话框**（不要求成品级交互，但"人类显式确认"这一步不可省略、不可加"下次不再提示"的静默开关） | 自动启动违反"不得静默启动另一个 Agent 对同一工作目录写入"。demo 级对话框至少呈现 §9.1 的 `termination/coverage/freshness` 与目标 cwd/host；§9.1.1 要求的 `override_reason`/`override_actor` 仍必须由人输入。 |
| D6 | 模型摘要 | **交接时一次，可关**（采用推荐默认值，用户 2026-09-12 授权） | 成本可控；普通事件不调模型。 |
| D7 | 停止原 Agent 再交接 | **本期不提供**，只跳转原现场（采用推荐默认值，用户 2026-09-12 授权） | 需 pid 归属与 kill 确认，各 Agent 进程模型不一。 |
| **D8** | 自动纳管是否创建 `control_works` | **采用推荐默认值（用户 2026-09-12 授权）：是，以 `source='discovered'` + `candidate` + `contract=NULL`**（v1 的"否"已推翻） | 不需伪造契约（`createWork` 仅在传入 contract 时才校验，`src/control/store.ts:132`）。不这样做就会回到被否决的第四个任务容器。 |
| D9 | Claude hook 归属 | 回收进仓库并更正 docs（采用推荐默认值，用户 2026-09-12 授权） | 影响 Claude 能否由"部分接入"升级；D2 已确认 Claude 在首批内。 |
| D10 | 受管 evidence 是否版本化 | **采用推荐默认值（用户 2026-09-12 授权）：是，但只做只读引用**（`reference_only` + sha256） | 避免改 `collectEvidence` 的覆盖写语义。 |
| **D11** | discovered Work 初始状态与结案权威 | **采用推荐默认值（用户 2026-09-12 授权）：初始 `candidate`；`closeout_owner='mgmt'` 仅拥有 tracking closeout，永不写 `control_works.state`**（本版裁定，§2.4.1） | 代价一：mgmt 卡不能走 `resolveAttentionDecision`（`:293` 要求 active）与 `recordStopCondition`（`:184` 要求 contract），须自持事务解卡（形态同 [工作区] `coordinator.ts:436-446`）。代价二：自动发现的 Work 永远不会自动变成 `completed`，需用户先 `promoteWork` 再走验收。取 `active` 则"从未被人确认的自动任务"与真实治理中的 Work 不可区分；允许 mgmt 写 `stopped`（技术上 `redirectWork` 对 candidate 可行，已实测）则是采集器冒充人类决策，两者都更差。 |
| **D12** | Work 合并 / 拆分 | **采用推荐默认值（用户 2026-09-12 授权）：合并用不可变 alias（阶段 3）；拆分本期不做** | 真合并须重写 `artifact_id`（含 `work_id`，§5.1），会使已签发的 manifest/acceptance/handoff 失效。 |
| **D13** | 是否全局开 `PRAGMA foreign_keys=ON` | **采用推荐默认值（用户 2026-09-12 授权）：全局开**（`src/control/store.ts:86` 的 PRAGMA 行追加） | 影响面超出 mgmt。现有 control schema 无任何 `REFERENCES` 声明，风险低，但**未实测**；需在阶段 0 用现有测试套件验证。 |

---

## 16. 调研与验证的实际限制

### 16.1 环境观察的复现命令

本文标为 **环境观察** 的论据均来自以下只读命令（在调研机执行）。它们**不是仓库事实**，换机器结果可能不同：

```sh
ls -l ~/.overload/bin/overload-hook.sh; grep -c overload ~/.claude/settings.json   # hook 已安装 / 5 处引用
ls ~/.overload/spool/*/ | wc -l; ls -d ~/.overload/spool/*/claude-* | wc -l        # 760 emitter / 357 claude
sqlite3 -readonly ~/.overload/ledger.db 'SELECT count(*) FROM journal; SELECT count(*) FROM sessions'
sqlite3 -readonly ~/.overload/ledger.db "SELECT * FROM heartbeats WHERE component='ingest'"  # ingest 未运行
ls ~/.pi/agent/sessions | wc -l; ls ~/.omp/agent/sessions | wc -l; ls ~/.claude/projects | wc -l  # 602/304/9
head -1 <任一 pi jsonl>; grep -m1 -o '"toolCall"' <同上>                            # jsonl 字段形状
cat ~/.overload/host                                                                # devbox
pi --help | grep -i resume; omp --help | grep -i resume; claude --help | grep -i resume
rg -n 'sha256' src --type ts                                                        # P2-4 搜索范围
sqlite3 --version                                                                   # 3.53.4，§12.1.0 的实测基线
# §12.1.0 的两条行为结论（均在临时库上执行，不碰任何真实 DB）：
sqlite3 /tmp/t.db "PRAGMA foreign_keys=ON; CREATE TABLE c(id TEXT PRIMARY KEY, p TEXT REFERENCES nosuch(id));"  # 建表成功
sqlite3 /tmp/t.db "PRAGMA foreign_keys=ON; INSERT INTO c VALUES('x',NULL);"         # 失败：no such table: main.nosuch
# §12.1.1 全量建表 + 全链事务写入 + foreign_key_check + 四项负向拒绝：按 §12.1.1 表逐条复现
# §2.4.1 理由 1 的实测（bun + :memory:）：createWork(candidate) 后调 redirectWork(action='stop') → state='stopped'
```

### 16.2 本次调研的硬限制

- 本机 `~/.overload/ledger.db` 的 `journal`/`sessions` 为 0 行、`ingest.heartbeat` 不存在；**无法用生产 ledger 数据验证发现/去重逻辑**，仅用 schema、代码与 spool 文件验证格式。
- 未运行任何 Agent、未启动任何进程（按 Prompt 约束）；仅执行了 `bun test src/orchestrator/evidence.test.ts src/shared/resume.test.ts`（12 通过）以确认测试基线可用，及只读 sqlite 查询、只读文件读取、§16.1 的命令。
- Claude Code hook 脚本存在于 `~/.overload/bin/`，不在仓库；其在当前 Claude 版本下是否仍被触发，仅由 spool 中最新 `claude-*` 目录间接支持，未直接验证。
- prime-agent 的 session 文件位置与格式未验证。
- 工作区未提交代码（coordinator 系列）被当作"当前实现"引用，但它们尚未提交，行号与行为可能在提交前变化。
- 未验证 `sessionManager.getSessionId()` 返回值与 jsonl 文件名 uuid 严格一致；仅有一例本机对照（`01a090e4-…`）。
- 未实际开启 `PRAGMA foreign_keys=ON` 跑现有测试套件（D13 的风险未消除）。
- 本次修订（v3）**未修改任何业务代码、未对真实 control DB 跑迁移**；但为核实 P0-4，在 `/tmp` 的一次性临时 sqlite 库上实际执行了 §12.1.1 的全量建表、全链事务写入、`PRAGMA foreign_key_check` 与四项负向用例（命令见 §16.1）；并用 `bun` + `:memory:` 调用 `createWork`/`redirectWork` 核实了 §2.4.1 理由 1。这些均为**临时库上的只读性验证**，不涉及 `~/.overload/*.db`。
- 本次修订未运行仓库测试套件、未启动任何 Agent；只重读了被质疑的 `file:line` 以核实引用。

---

## 17. 自查表（Prompt §五 与 §六 逐条对照）

### §五 必须包含

1 摘要/范围/待决策 → §1；2 架构与差距 → §2；3 路径选择 → §3；4 领域模型（含 §4.2 执行身份）→ §4；5 所有权与生命周期（含 §5.0 事实源层次、§5.1 身份）→ §5；6 发现与采集（含 §6.3.1 原子性、§6.3.3 不可用分类）→ §6；7 产物捕获（含 §7.2.1 并发交接、§7.4 双信任边界）→ §7；8 关联算法（含 §8.4 alias）→ §8；9 交接协议（含 §9.1.1 file-only 唯一策略、§9.6 启动幂等、§9.8.0 派生结束、§9.8 归档）→ §9；10 验收与提交（manifest 绑定）→ §10；11 API/CLI/UI → §11；12 持久化与迁移（含 §12.1.0 建表顺序与拆环、§12.1.1 可执行 DDL、§12.2 不变式、§12.5 回滚）→ §12；13 测试（计划 vs 现有区分）→ §13；14 分阶段 → §14；15 未决问题 D1–D13 → §15（**D1/D2/D5 已由用户裁定，其余采用推荐默认值**；D1 的落地契约在 **§6.4 ssh 远程主机接入**）。

### §六 验收场景：Given / When / Then 状态断言

全部为**计划中的断言**（测试尚未实现，见 §13）。断言对象一律是**数据库状态或 API 响应**，不是日志文案。G=Given，W=When，T=Then。

1. **自动纳管** · G jsonl 在 lookback 内、cwd 在 allow 内，DB 无相关行。W `--once`。T `control_works` +1 行 `source='discovered' AND source_id='<host>:pi:<uuid>' AND state='candidate' AND contract IS NULL`；profile 1 行 `origin_mode='discovered' AND closeout_owner='mgmt' AND track_state='tracking'`；`mgmt_executions` 1 行；`mgmt:%` 卡数 = 0。
2. **按活动回填与范围收窄（D1/D2）** · G A `created_at=now-30d` 但 `last_event_at=now-1h`；B 新但 runtime 不在 `agents`；C 是一个 `prime` Session；D 在一台未列入 `manage.hosts[]` 的主机上。W `lookback=7d, agents=['pi','omp','claude'], hosts=[{host:'devbox',kind:'local'},{host:'builder',kind:'ssh',remote:'builder'}]`。T A 被纳管（证明用活动时间）；B 与 **C**（D2：prime 不入首批）均无任何行且各有一条 `runtime_out_of_scope` 日志；**D** 无任何行且有 `host_out_of_scope` 日志；四者均不产生 Attention。
3. **重复扫描/重启不重复建** · W 再跑两次 `--once`，其间在 commit 与 finalize 之间 `kill -9`。T Work 与执行行数不变；同一内容版本行数 = 1；`mgmt_observations` 可 > 1 但 `(version_id, evidence_ref)` 无重复；**无 `pending` 残留**（全为 `stored` 或 `lost`）。
4. **改变范围不删数据** · W `lookback` 改 1h 重跑。T 3 个 Work 仍 `tracking`；artifacts/versions/links 行数不变。
5. **普通进度不开卡** · W 注入 20 条进度事件与 5 个新版本，跑 5 轮。T `count(*) … item_id LIKE 'mgmt:%' AND state='open'` = 0。
6. **读取不误记为生产** · G 对 `a.ts` 的 `read`、对 `b.ts` 的 `write(isError=false)`。T `a.ts` 只有 `relation='read'`，**不存在**任何指向它的 `modified`/`created`；`b.ts` 有 `modified` + `strong`。
7. **同仓库不因时间接近合并** · G 同 repo、相隔 2 分钟、无父子、无 `Overload-Work:`。T 两个不同 `work_id`；hints 有 `same_repo_near_time`；alias 为空。
8. **并发写者不伪造来源且交接一致**（P1-10.1）· G E1、E2 重叠窗口都对 `x.ts` 有写证据。W `POST /handoffs`。T 版本 `producer='multiple'`；两条 link 均 `uncertain`；`preconditions.contention` 含 `x.ts` 与两个 `execution_id`；`isolate=false` → 409 `workspace_contention`；`isolate=true` 成功且 `isolate=1`。
9. **覆盖/删除后可追溯** · W `x.ts` 改写后再删除。T 3 行版本（v1/v2 content、v3 `deleted`）；v1 仍 `stored` 且 blob 可读；v3 的 `content_sha256 = sha256('\0deleted\0'+v2)`；**无任何版本行被 UPDATE**。
10. **源不可用 ≠ 消失**（P1-10.2）· W 对一个 `running` 执行分别注入 (a) ledger chmod 000；(b) ledger 表 DROP；(c) 单 jsonl chmod 000；(d) 平台 incident 未关闭；(e) 超 freshness，各跑 3 轮。T 五种 `exec_state` **均不变为 `vanished`**，`track_state` 仍 `tracking`，artifacts 行数不变；`source_coverage` 分别 `gapped/gapped/gapped/gapped/ledger_stale`；仅 (b) 立即开 1 张卡，(a)(c) 第 5 轮才开，(d)(e) 不开。**10b（D1，本版新增）ssh 不可达 ≠ 消失** · G 一个 `kind:"ssh"` 主机上有 2 个 `tracking` 的 Work、共 3 个产物版本。W 分别注入 (f) `remote` 改成不可解析的名字；(g) `ssh_cmd` 指向不存在的二进制（`ENOENT`）；(h) 远端 `~/.overload/host` 内容与配置 `host` 不符，各跑 6 轮。T 三种情形下该主机全部 `source_key` 记 `unavailable`、对应执行 `source_coverage='gapped'`、`exec_state` **均不变为 `vanished`**、`track_state` 仍 `tracking`、artifacts/versions 行数 **不变**、cursor **未推进**；`listFiles` **从不返回 `[]`**（空列表只允许来自 ssh 成功且远端目录真为空）；(f)(g) 在第 5 轮开**恰好 1 张** `mgmt:health:host:<host>` 卡（每主机一张，不按文件叠加），(h) 立即开同一张卡；恢复后该卡 `resolved` 且续采从原 cursor 继续（§6.4.5）。
11. **部分历史可纳管但明确缺口**（P1-10.3）· G jsonl 只剩后半段。T `history_available=0`；**无伪造历史版本行**；`gaps[]` 含 `{kind:'missing_history', artifact_id, missing_before}`；未带 `history_gap_acknowledged` 的 accept → 409 `history_gap_unacknowledged`，带上后成功。
12b. **远程主机上的交接（D1，本版新增）** · G 源执行在 `kind:"ssh"` 主机 `builder` 上，`stable_id` 以 `builder:` 开头且等于远端 `~/.overload/host`。W UI 确认（D5）后 `/handoffs` → `/launch`。T `launch_command` 形如 `ssh -o BatchMode=yes -o ConnectTimeout=5 -- builder 'cd <cwd> && OVERLOAD_PARENT=mgmt:handoff:<id> <agent> --resume=<uuid>'`；ssh **连接阶段**失败（`ENOENT`/`ConnectTimeout`/`Permission denied`）→ `failed_no_effect` 且可重试；**退出码 255 或连接建立后的任何失败 → `unknown`**（不得判 `failed_no_effect`），走 §9.6.3 的三选项卡且不自动重试；成功路径上 B 的 envelope 经远端 spool → pull → ingest 落 `sessions.origin='mgmt:handoff:<id>'`，`receipt_known → unknown` 的 5 分钟阈值加上一个 pull 周期宽延后仍能转 `bound`（§6.4.6）。

12. **A 终止后交给 B** · G E1 可信终止；2 个产物版本 + 1 条 `confirmed` 的 `git_push`。W `/handoffs` → `/launch` → B 带 `origin='mgmt:handoff:<id>'` 出现 → 采集。T `handoff.state='bound'` 且 `new_stable_id` 回填；B 的 binding `work_id` = 同一 Work、`role='successor'`；新增执行行且 `parent_handoff_id` 指向该 handoff、`input_head_at_start` = 交接时输入头；`external_effects[0].state='confirmed'`；B 的新版本 `artifact_id` 与 A 相同。
13. **blocked-on-ask 不静默重启** · G E1 `awaiting_human`，freshness 内。T 409 `source_blocked_on_ask` + `termination='live_blocked'` + `jump`；handoffs 与 attempts 均无新行。

13b. **file-only 的唯一策略**（P1-4，三子场景缺一不可）· G 一个只在 jsonl 可见、ledger 无行的 Claude 执行，`source_coverage='file_only'`。**13b-i** W `POST /handoffs {isolate:false}` → T 409 `liveness_unknown`、`cause='file_only'`、`allowed` **精确等于** `['isolate_with_confirmation']`、`same_workspace='forbidden'`；handoffs 与 attempts 无新行。**13b-ii** W `{isolate:true}` 但不传 `override_reason` → T 409 `confirmation_required`；仍无新行。**13b-iii** W `{isolate:true, override_reason, override_actor=decision_owner}` → T **200**；`mgmt_handoffs` 1 行且 `isolate=1`、`override_actor` 非空；`packet.gaps[]` 含 `{kind:'liveness_unknown', cause:'file_only'}`；`launch_command` 的 cwd **不等于**原执行 cwd（证明走的是隔离 worktree）。通用：三个子场景中 **不存在**任何使同目录启动成功的输入组合（`override_*` 也不能解锁 `isolate=false`）。
14. **启动失败可恢复且不重复副作用**（P0-2，三子场景缺一不可）· **14a** executor 返回 `ENOENT` → `failed_no_effect`、handoff 回 `ready_to_launch`；重试后 `attempt_no=2` 而 handoffs 仍 1 行。**14b（危险路径）** executor 已 spawn 成功后 manage 被 `kill -9`（DB 只有 `requested` 行），重启 → 该行转 **`unknown`**（不是 `failed_no_effect`）；`handoff.state='launch_unknown'`；恰好 1 张卡且 `options` **精确等于** `['jump','attach','abandon']`（**不含 retry**）；再跑 10 轮，attempts 仍 1 行（证明不自动重试）。**14c** 14b 后 ledger 出现该 origin 的 Session，`POST /reconcile` → 转 `bound`、卡 `resolved`、无第二次启动。通用：任何路径下 `unknown` 的 external effect 行数不因重试增加，且不被自动流程重放。
15. **产物改变后旧验收失效**（P1-7）· G M1 = {`a.ts@v1`, `b.ts@v1`} + `git_head=H1` + `verification=[checks exit 0]`；A1 accepted。W 分别改变 (i) `a.ts`→v2；(ii) **`b.ts`**→v2（manifest 中的另一个文件）；(iii) `git_head`→H2；(iv) checks 证据哈希变化，然后 submit。T **四种全部** 409 `manifest_drift`（含两个 manifest_id）；A1 `invalidated_at` 非空；无任何 push/PR 发生。(ii)(iii)(iv) 正是单版本绑定会漏掉的。
16. **接受但提交失败不显示成功** · W `git push` 失败。T `state='failed'`；`external_ref IS NULL`；UI 徽章"提交失败"而非"已推送"；对应 external effect `unknown`；后续 submit 被阻止直到 reconcile。
17. **结果回流并自动归档**（P1-6）· G 场景 12 完成，B 已 `session_ended`，无 open Attention、无在途 handoff/submission，存在 `mgmt_inputs(kind='acceptance')`。W 越过 `archive_grace_ms` 后 `--once`。T `track_state='archived'` + `archived_at` 非空 + `archive_reason='closeout'`（**真实状态转移**，非视图过滤）；`control_works.state` **保持原值**（本例仍 `candidate`）——manage 从不写它；outbox 有 `work.archived`。**17b** `closeout_owner='coordinator'` → `changes=0`，**profile 也不归档**，`control_works.state` 更不被 manage 改写。**17c reopen** 归档后出现新 `tool_activity` → 回 `tracking`、`archive_reason='reopened:new_activity'`；若已 `completed`（由 coordinator/人写入）则**保持** `completed`。**17d（本版新增，P1-6 残留项）无 `session_ended` 的外部 Session 也能归档**· G 一个 `source_coverage='ledger_full'` 的 pi 执行，最后事件是 `settled`（故 `current.state='idle'`），**从未出现 `session_ended`**；journal 有该 writer 的 `emitter_drained`；`requests` 无 pending 行。W 越过 `max(drain_grace_ms, archive_grace_ms)` 后 `--once`。T 该执行 `exec_state='ended_ok'` 且 `closeout_evidence` 非空并含 `rule='derived_closeout'`、`writer_proof.kind='emitter_drained'`（§9.8.0）；随后 `track_state='archived'`。**17e 负向** 同样场景但 (i) `requests` 有 pending 行，或 (ii) `pid` 仍存活，或 (iii) grace 未越，或 (iv) `source_coverage='file_only'` → 四种情形下 `exec_state` **仍为 `running`**、`closeout_evidence IS NULL`、`track_state` 仍 `tracking`。**17f 撤销** 17d 后又出现 `working` → `exec_state` 回 `running`、`closeout_evidence.revoked_at` 非空且**原证据字段保留**、Work 回 `tracking`。
18. **敏感信息不进入可分享产物或交接包**（P0-3）· G (a) 普通 `src/x.ts`，密钥由字符串拼接构成、**故意不匹配任何单条正则**；(b) bash 工具结果含 `AWS_SECRET_ACCESS_KEY=…`；(c) 含前两者的 diff；(d) `.env`。W `/share-package` 与生成交接包。T 两者**均不含任何 blob 内容**，只有 `{path, size, content_sha256}` 引用；(a)(b)(c) 行 `shareable=0`（**因默认拒绝，而非因被扫出**）；(d) `withheld_sensitive`；`GET /versions/<id>/content` 对非 owner 403、对 `withheld_sensitive` 404+state。**诚实声明**：该断言证明的是**导出边界**，不是"扫描器能发现所有密钥"（§7.4）。

### 模型边界自查

- 不采集/不依赖 thinking（pi jsonl 中的 `thinking` 块在读取器中显式跳过；Claude `thinking` 同）。
- 不声称任何 Agent"已支持"；§6.1 的等级列为 **目标等级**，当前 mgmt 实现为**未实现**。
- 本次未实现任何代码、未运行任何迁移、未运行任何新测试。§13 的全部测试文件为**计划**，§13.6 列出的才是仓库现有测试。
- **§6.4 的 ssh 通道未在本次做任何远程连通性实测**：`SourceFs` 的 ssh 实现是**方案建议**，所引 `file:line` 只证明本机 `pull`/extension/ingest 的既有形态，不证明远端可达或远端目录布局。`HostId` 由枚举放宽为 `string` 是**未实测的阻断项**，须在阶段 1 用 `spool.ts:12` 与 `recon.ts:650` 的现有校验一并验证。

---

## 18. 修订记录

### 18.1 v1 → v2

对应评审 `/tmp/ovl-artifact-review.md`（NEEDS-REVISION，4 P0 / 10 P1 / 4 P2）。**18 条全部处理，无一条被拒绝。**

| ID | 处置与关键代码依据 | 落点 |
|---|---|---|
| **P0-1** 第四个任务容器 | **采纳（重写架构）**：删 `mgmt_tasks`；任务 = `control_works` 的 discovered（契约轻量）模式；外部 Session 以 `mgmt_executions` 附着；`closeout_owner` 单一且单向。**无代码级 blocker**：`contract` 可空（`store.ts:22-26`）、仅传入时才 `validateContract`（`:132`）、`promoteWork` 已是现成单向升级（`:337-350`）、`(source,source_id)` 唯一索引提供去重（`:27`）。唯一代价记入 D11（`:293`/`:184`） | §1.1 §2.4 §2.4.1 §3 §4 §12.1 |
| **P0-2** 启动非幂等 | 不可变 `mgmt_handoff_launch_attempts`（幂等键 / `unknown` 态 / 回执 / 目标进程身份）；`unknown` 永不自动重试；reconcile-before-retry；三选项卡（jump/attach/abandon，**无 retry**）；`mgmt_external_effects` + 每 kind reconcile 谓词（对齐 `submit.ts:11-28`）；在途唯一索引扩到 `launch_unknown` | §9.6 §9.7 §12.1 |
| **P0-3** 脱敏不是安全边界 | 采集与共享拆为两个信任边界；默认 `shareable=0`（工具结果/文本/diff/dirty 一律）；每 blob `sensitivity`+`scanner_version`；`unknown` 永不进包；`artifact cat` 改 owner 授权；`buildSharePackage` 白名单拼装。**明确写出正则脱敏不构成保证** | §1.3 §7.4 §11.1 §17-18 |
| **P0-4** 悬挂/跨任务记录 | 全表 FK；`(artifact_id, version_id)` 组合唯一索引 + `mgmt_manifest_entries` 复合 FK；要求 `PRAGMA foreign_keys=ON`（`store.ts:86`，记为 D13）；三条事务不变式；验收绑不可变 manifest digest，提交前重算 | §12.1 §12.2 §10.1 §10.2 |
| **P1-1** version_id 自相矛盾 | `version_id = sha256(artifact_id:content_kind:content_sha256)`，**移除 `observed_source`**；来源改存 `mgmt_observations`；`deleted`/`metadata_only` 身份分别定义 | §5.1 §12.1 |
| **P1-2** 缺原子性协议 | stage → commit（观察行+版本行+cursor 同一 `immediate` 事务，对齐 `ingest.ts:159-176`）→ finalize；启动双向对账；`pending→stored/lost`；`stored` 不变式 | §6.3.1 |
| **P1-3** 事实源层次含混 | 新增 L0–L4 五层表 + 统一 `unavailable/empty/stale` 三分；L2 不得单独作为门禁结论 | §5.0 §2.1 |
| **P1-4** 交接门禁不安全 | 定义"可信终止"四条件；9 行判定矩阵；`file_only`/`stale`/`outage`/`gap`/`vanished 无进程证明` 一律 `unknown`；`unknown` 禁止同目录启动 | §9.1 §17-10/13 |
| **P1-5** 未建模执行身份 | `mgmt_executions` 键 `(stable_id, writer_id, attempt_no)`（对应 `ingest/schema.sql:16-19`），含 `input_head_at_start`、起止、`exec_state`、`source_coverage`、`parent_handoff_id` | §4.2 §12.1 |
| **P1-6** 自动归档未设计 | 六条 closeout 谓词；真实 `track_state='archived'`；`closeout_owner` 决定是否写 `completed`；`candidate` 不伪造完成；迟到事件 reopen 且不回滚人类完成决定 | §9.8 §17-17 |
| **P1-7** 验收失效欠定义 | 不可变 manifest（版本集合 + git head/tree/base + 验证证据）；另一文件/base/生成物/验证结果变化都会失效 | §10.1 §17-15 |
| **P1-8** 迁移/回滚不现实 | 改回 `destructive:false` 并解释该标志在现有代码中**只触发备份**（`store.ts:67-69,78`）；备份改为部署步骤且要求写冻结；明确部署顺序；如实写出**旧读者兼容窗口为零**（`store.ts:75`）；**常规回滚改为功能回滚** | §12.5 |
| **P1-9** 合并/拆分未定义 | 显式推迟真合并（D12），改为不可变 `mgmt_work_alias`；永不重写 `artifact_id`；禁链式/环形；重扫不复活；每次 alias 追加审计 | §8.4 §12.1 |
| **P1-10** 场景只是清单 | §17 全部 18 场景重写为 Given/When/Then 状态断言，补齐六个点名缺口（并发交接隔离、源不可用八变体、部分历史确定行为、崩溃后未知、真实归档、端到端敏感导出）；计划测试与现有测试分开 | §17 §13 §13.6 |
| **P2-1** 2 秒间隔引用错 | 改引 `ingest.ts:14`（常量）、`:67`（配置）、`:350`（sleep）；扫描/cursor 引 `:159-176` | §2.1 |
| **P2-2** "current 可重建"引用不成立 | 改标 **推断**；说明 `:145-147` 只证明重放不重复转移；补充重建需清空派生表并重置 `reducer_cursor`（`ingest/schema.sql:23,49-57`），注明仓库无此入口 | §2.1 |
| **P2-3** outage 表述过宽 | 收窄为 recon（`recon.ts:176-206`）/pull（`pull.ts:58-67`）发事件 → reducer 落 `incidents`（`:97-105`）→ 仅 `RECON_EVENTS`（`:8`）在该 source incident 未关闭时被丢弃（`:40-42,143`） | §2.1 |
| **P2-4** "仓库唯一"是搜索推断 | 改标 **推断（基于仓库搜索）**，写明搜索命令与命中集合，去掉"唯一"绝对表述，保留"可复用" | §2.3 §16.1 |

### 标签纪律修正

- 新增 **环境观察** 标签类别（文首引用约定）：本机计数、已安装 hook、session 文件格式、CLI `--help` 结论全部改标，并在 §16.1 给出逐条复现命令。
- §6.1 列名"接入等级（推荐）" → **目标等级**，表头写明"**当前 mgmt 实现：全部未实现**"，并区分"可读取的原材料"与"已实现的采集"。
- §13/§17 明确区分**计划中的测试**与**仓库现有测试**（§13.6）。

### 本版新增待决策项

| ID | 内容 | 为何需要用户决定 |
|---|---|---|
| **D11** | discovered Work 初始 `candidate`；`closeout_owner='mgmt'` 仅 tracking closeout | 决定 mgmt 卡不能用契约收窄通道（`store.ts:293,184`），并决定自动发现的任务永不自动进入 `completed`，影响 UI 选项集与 Done 区文案 |
| **D12** | 合并用不可变 alias；拆分本期不做 | 真合并须重写 `artifact_id`，会使已签发 manifest/acceptance/handoff 失效 |
| **D13** | 是否全局开 `PRAGMA foreign_keys=ON` | 影响面超出 mgmt；现有 schema 无任何 `REFERENCES`，风险低但未实测 |

**无被拒绝的评审条目。** 评审判定 OK 的部分（33 条引用审计中的 OK 项、Prompt §四三条先前观察的核实结论、§五 15 项的整体结构）保持不变。

---

### 18.2 修订记录（v2 → v3，第二轮评审的 4 项残留）

对应评审 `/tmp/ovl-artifact-review2.md`（NEEDS-REVISION；旧 18 项复核为 RESOLVED 14 / PARTIAL 3 / NOT-RESOLVED 1）。**本版只窄修这 4 项，未改动其余章节的结论。** v2 已被判 RESOLVED 的 14 项保持原样。

| 残留项 | 评审指出的问题 | v3 处置 | 落点 |
|---|---|---|---|
| **P0-4 残留** §12.1 SQL 草案不可按序创建 | `profile→inputs`、`executions→manifests/handoffs` 等引用尚未创建的表；`profile.input_head` ↔ `inputs.work_id` 成环，草案无法迁移落地 | **重写为可执行的拓扑序 DDL**（§12.1.1），并**实测执行通过**。两处环**显式拆解**：① `mgmt_work_profile.input_head` **取消物理 FK**、降为可空指针，同一 `immediate` 事务内三步写入（profile→inputs→`UPDATE input_head`）；② `mgmt_executions.parent_handoff_id` **取消物理 FK**（保留 `handoffs.source_execution_id` 的强 FK），改由事务校验。取消的 FK 由 §12.2 新增不变式 ④⑤ 以单行条件更新补偿。**全表复核**而非只修点名的两处：另外 12 张表的前向引用一并重排。附实测矩阵（正向全链事务 + `foreign_key_check` 空 + 4 项负向拒绝 + 1 项「拆环代价」如实记录） | §12.1.0 §12.1.1 §12.2 §13.2 §14 阶段 0 §16.1 §16.2 |
| **P0-1 残留** discovered candidate 的完成权威自相矛盾 | §2.4.1 说 candidate 无完成语义，§9.8.2 又只在 active 时写 `completed`，于是 `completion_owner='mgmt'` 拥有一个它永远无法完成的 Work | **二选一中选后者并贯彻到底**：字段改名 `completion_owner` → **`closeout_owner`**；明文规则「`closeout_owner='mgmt'` 仅拥有 tracking closeout（profile 归档），**永不拥有 Work completion**」；**manage 的任何 SQL 都不得出现 `UPDATE control_works`**（新增不变式 ④，由 `authority.test.ts` 源级断言）。§9.8.2 删除 v2 的「active 时附带写 completed」分支。给出为何不选「允许 mgmt 把 candidate 推向终态」的两条依据：`redirectWork(action='stop')` 对 candidate **确实会成功**（`src/control/store.ts:173-180`，本次实测），但 `stopped` 与 `completed` 都是人类/coordinator 决策语义（`:303`、[工作区] `coordinator.ts:436-447`），采集器写入即冒充人类决策；且 `contract=NULL` 的 Work 不存在可验收对象 | §1.1 §1.5 §2.4.1 §9.8.2 §9.8.3 §11.3 §13.1 §13-场景 1/17/17b §15 D11 |
| **P1-4 残留** file-only 门禁自相矛盾 | §6.3 称 file-only「永远不能通过 §9.1 启动门禁」，§9.1 与 §11 API 又给 `isolate_with_confirmation`，可读作绝对禁止或带确认可启动 | **统一为推荐策略并写成唯一定义（§9.1.1）**：*禁止同工作区启动，无例外、无覆盖开关；但可在「隔离 worktree + 显式人类风险确认」下启动*。明确 `allowed:["isolate_with_confirmation"]` 的语义是「只剩这一条路」而非「可选之一」，并加 `same_workspace:"forbidden"` 与 `requires[]` 字段消歧。四处措辞同步改写：§6.3 发现段、§9.1 判定矩阵 `unknown` 行、§11.1 API（补 409 `confirmation_required` 与带齐确认的 200 正例）、§11.2 CLI、§13 场景 13b（三子场景）。保留 file-only 的原因：Claude Session 天然是 `file_only`，绝对禁止等于宣告 Claude 永不可交接，与 §14 阶段 3 冲突 | §6.3 §9.1 §9.1.1 §11.1 §11.2 §11.3 §13.1 §13-场景 13/13b §14 阶段 3 |
| **P1-6 残留** 正常 idle execution 无归档闭环 | §9.8.1 要求 `exec_state ∈ {ended_ok, ended_failed}`，但 reducer 只在 `session_ended` 时写 `done`（`src/ingest/reducer.ts:163`）、`settled` 只写 `idle`（`:160`），`SESSION_TERMINALS` 不含 idle（`:7`）；无 `session_ended` 的外部 Session 永远挡住 archive | **新增 §9.8.0 派生结束转移**：六条谓词（`ledger_full` 且无 open incident / `current.state='idle'` / writer 死或 `emitter_drained` / grace 已过 / 无 pending ask / 无更新 incarnation），全部来自现有 recon 与 reducer 语义（`recon.ts:136-150` 的 dead+drained、`types.ts:53` 的 `DRAIN_GRACE_MS`、`resume.ts:47-49` 的 `kill(pid,0)`、`schema.sql:20-22` 的 requests、`reducer.ts:185,227` 的 drained→orphaned）。结果写 `exec_state` 并**强制**同时写 `closeout_evidence`（新增列，§12.1.1），`closeout_evidence IS NOT NULL` 是 `ended_*` 的必要条件。明确与 §9.1 启动门禁的阈值方向相反（新鲜 vs 陈旧），两者是独立谓词。给出唯一的撤销路径（后续出现 `working` → 回 `running` + `revoked_at`，保留原证据）。`file_only` 不满足条件 1，故不自动归档，只能人工归档 | §9.8.0 §9.8.1(5)(6) §9.8.3 §11.3 §12.1.1 §13.1 §13.3 §13-场景 17d/17e/17f §14 阶段 1 |

### v3 的字段与命名变更（实现方须知）

| v2 | v3 | 原因 |
|---|---|---|
| `mgmt_work_profile.completion_owner` | **`closeout_owner`** | 名字曾暗示「完成 Work」，与实际权限（仅 tracking closeout）不符 |
| `mgmt_work_profile.input_head TEXT REF inputs` | `input_head TEXT`（无 FK） | 拆 profile↔inputs 环；由 §12.2 不变式 ④ 补偿 |
| `mgmt_executions.parent_handoff_id TEXT REF handoffs` | `parent_handoff_id TEXT`（无 FK） | 拆 executions↔handoffs 环；由 §12.2 不变式 ⑤ 补偿 |
| `mgmt_inputs.execution_id REF exec` | `execution_id TEXT`（无 FK） | inputs 先于 executions 创建；同样由不变式 ⑤ 形态补偿 |
| — | `mgmt_executions.closeout_evidence TEXT` | §9.8.0 派生结束的证据，新增列 |

### v3 新增的计划测试

`schema.test.ts`（§12.1.1 顺序可执行、`foreign_key_check` 空、四项负向拒绝、两处拆环列的事务校验）· `authority.test.ts`（`src/manage/**` 源级断言不存在 `UPDATE control_works`）· `handoff-gate.test.ts` 增补 §9.1.1 三子场景 · `archive.test.ts` 增补 §9.8.0 正向/四种负向/撤销 · e2e 新增 `derived-closeout-no-session-ended` 与 `file-only-isolated-handoff`（§13.3 由四场景增至六场景）。

### v3 的引用核验

本版新增或改动的每条 `file:line` 均在本次修订时重读确认：`src/control/store.ts:24`（state CHECK）、`:173-180`（`redirectWork` 不校验 state）、`:184`（`recordStopCondition` 要求 contract）、`:293`（`resolveAttentionDecision` 要求 active）、`:303`（stop 选项写 stopped）、`:337-350`（`promoteWork`）；`src/ingest/reducer.ts:7`（`SESSION_TERMINALS` 不含 idle）、`:8`/`:143`（RECON_EVENTS 与 incident 丢弃）、`:160`（settled→idle）、`:161`（decision_requested→awaiting_human）、`:162`（decision_resolved→idle）、`:163`（session_ended→done）、`:185`/`:227`（drained→orphaned）；`src/recon/recon.ts:136-140`（emitter_dead）、`:143-150`（emitter_drained 需 grace + spool EOF）；`src/shared/resume.ts:47-49`（`kill(pid,0)`）；`src/shared/types.ts:53`（`DRAIN_GRACE_MS = 5 * 60_000`）；`src/ingest/schema.sql:16-19`（incarnations PK）、`:20-22`（requests）；[工作区] `src/orchestrator/coordinator.ts:436-447`（`acceptDelivery` 的条件 UPDATE）；`src/control/outbox.ts:52`（`publishControlEvents`，已如实降级为「通用发布入口，不证明消费端理解 `work.archived`」）。

**本版未处置的评审意见：无。** 评审明确判 RESOLVED 的 14 项与全部 citation spot-check 结论保持不变，未作改动。

---

### 18.3 修订记录（v3 → v4，用户 D1/D2/D5 裁定的落地）

本版**不回应新评审**，只把用户 2026-09-12 的三项决定写进方案并为其余 D 项定档。**未改动 §2–§5、§7–§13 的任何结论**，schema（§12.1.1）**无新增列、无新增表**。

| # | 改动 | 落点 |
|---|---|---|
| 1 | **D1 = 本机 + ssh 远程主机**（v3 推荐的「仅本机」被推翻）。新增 §6.4 给出可执行契约：`SourceFs` 抽象、`manage.hosts[]` 对象化配置（`{host, kind, remote, ssh_cmd}`）、复用 pull 的 ssh 参数形态、`stable_id` host 段 = 远端 `~/.overload/host`、generation = `inode:size`、ssh 不可达 ⇒ `unavailable` 而非空、有预算重试、远程启动路径 | §1.5 §6.1 §6.2 **§6.4（新增）** §14 §15 D1 §17 |
| 2 | **D2 = 仅 pi/omp/claude**。prime-agent 与 cmux 从「目标等级」降为**事件层注记**，`manage.agents` 取值域收窄；越界 runtime 记 `runtime_out_of_scope`、不建 Work、不开卡 | §1.5 §6.1 §15 D2 §17 场景 2 |
| 3 | **D5 = UI 确认，demo 级对话框可接受**。确认这一步不可省略、不可加静默开关；对话框至少呈现 termination/coverage/freshness 与目标 cwd/host；§9.1.1 的 `override_reason`/`override_actor` 仍须人输入 | §1.5 §15 D5 |
| 4 | **D3、D4、D6–D13 全部定档为推荐默认值（用户授权）**，不再作为阻塞待决项；D4 明确「远端同限」 | §15 表头 + 各行 |
| 5 | §6.1 能力矩阵新增两行：**「远端 pi/omp（ssh）」= 完整接入（目标等级）**、**「Claude（远端）」= 部分接入**；原「远端 devbox pi/omp（pull）」行保留为事件层现状 | §6.1 |
| 6 | §14 阶段重排：**阶段 1** 增加「一台 ssh 主机的发现 + 快照」与 `HostId` 放宽（强制 e2e 仍是本机 `pi → omp`，远程启动允许但不强制）；**阶段 3** 承接远程全量接入；**阶段 4** 缩为「云端 Agent 手动导入」 | §14 |
| 7 | §17 自查表：§五 D1–D13 行补注决策状态与 §6.4 指针；场景 2 扩为「按活动回填与范围收窄（D1/D2）」（新增 prime 与越界主机的负向断言）；新增 **场景 10b**（ssh 不可达 ≠ 消失）与 **场景 12b**（远程主机交接，含 255 退出码归 `unknown`）；模型边界自查新增「ssh 通道未实测」的诚实声明 | §17 |

#### v4 新增的 file:line 引用（均在本次修订时重读确认）

`src/pull/pull.ts:42-47`（ssh 预检参数 `-o BatchMode=yes -o ConnectTimeout=5 --`）、`:19`（`fail_threshold`）、`:48-52`（`--` 终止选项解析的 Review P3 M1 理由）、`:122-126`（`commandWords` 拆词）、`:134-145`（`runCommand` 的 spawn + 超时 + 非零退出抛错）；`src/extension/overload.ts:194`（`host: "local"|"devbox"` 字段声明）、`:220-226`（读 `~/.overload/host`，仅 `devbox` 生效、否则回落 `local`）、`:227-229`（spool 目录 `spool/<host>/<emitter_id>/`）、`:250`（envelope 写 `host`）、`:692`（extension 侧 `${spool.host}:${runtime}:${session}`）、`:701`（读 `OVERLOAD_PARENT` 写 `detail.parent`）、`:707`（置为自身 stable_id）、`:774-775`（子命令注入 `OVERLOAD_PARENT`）；`src/ingest/ingest.ts:284`（stable_id 权威格式）、`:335`（ingest 主循环读 host，缺失回落 `local`）；`src/ingest/classifier.ts:103-107`（同一 host 文件的第三处读取）；`src/orchestrator/spool.ts:12`（host 硬校验 `local|devbox`）；`src/recon/recon.ts:647-650`（host 读取 + 硬校验）；`src/shared/types.ts:10`（`HostId` 枚举，需放宽为 `string`）；`src/ingest/cmux.ts:49`（`${stat.dev}:${stat.ino}` 代际标识）、`:54-55`（inode 变化或 size 回退 ⇒ 新一代）、`:58-64`（首/尾行指纹兜底）；`src/shared/resume.ts:30`（`host !== "local"` 的通用 Resume 拒绝，**不适用于 mgmt 自生成的启动命令，且本版不修改该行**）、`:42`（`--resume=<quoted>` 形态）、`:51`（`shellQuote`）。

**本版未新增任何 schema 列、未新增任何数据库、未修改任何源码。** §6.4 全部内容为**方案建议**；ssh 连通性、远端目录布局与 `HostId` 放宽的影响面**均未实测**，见 §17 模型边界自查。
