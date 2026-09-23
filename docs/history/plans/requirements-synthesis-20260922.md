# Overload 人类决策控制：需求综合（交接稿）

日期：2026-09-22。性质：只读梳理，不改任何代码。本稿从既有设计文档中提取可交接需求，不引入新决策。

## 0. 来源文档与状态图例

**必读清单（本次实际通读）**

| 编号 | 路径 | 性质 |
|---|---|---|
| HD | `docs/architecture/human-decision-design.md` | 核心设计，claude-opus-5 三轮审查后 R3 APPROVE（仅设计放行）；§16 为 R2/R3 修订，**冲突处以 §16 为准** |
| IC | `docs/architecture/implementation-contract.md` | 四个 owner 的文件边界与共享 API，与 HD §16 一致 |
| R3 | `docs/history/reviews/20260906-opus-review-r3.md` | R3 终审正文（APPROVE，无剩余阻塞） |
| F1–F4 | `docs/history/contracts/p1-freeze.md` … `p4-freeze.md` | 历史契约；文首自注「部分能力已从代码中移除」 |
| DA | `docs/history/plans/20260831-decision-answer.md` | 已 superseded（文件回答协议 → answers mailbox） |
| REC | `docs/architecture/reconcile.md` | orchestrator lease/活性/恢复语义定稿 |
| ORCH | `docs/architecture/orchestrator.md` | orchestrator v1 实施计划（v2 修订） |
| MGMT | `docs/architecture/artifact-management-tech-design.md` | 外部 session 纳管/产物/跨 agent 交接技术方案 v4 |
| UXP | `docs/history/plans/20260907-operator-ledger-ux.md` | 界面重设计稿，标注「不代表已实现」 |
| CFG | `docs/guides/configuration.md` | 配置项现状 |
| INT | `docs/guides/integrations.md` | Feishu channel / pi / omp / claude 集成现状 |
| AGENTS | `AGENTS.md` | 产品原则，**优先级高于一切具体设计** |
| R1–R4 | `docs/research/`（external-survey / fleet-inventory / path-comparison / probe-findings） | 调研材料 |
| JEV | `docs/research/jev-reference/README.md` + 7 图 | 独立整理稿（见 §18） |

**状态图例**：`已批准` = HD 经 R3 设计放行且 IC 已冻结边界；`设计稿` = 未实现、待实施；`历史` = 已 superseded 或代码中已移除；`冲突` = 文档间不一致，已按规则标注、未自行调和。

**全局前提（来自 agent-hint 与 AGENTS.md，贯穿全文）**：
- 核心目标：把大量 Agent 运行噪声压缩为少量、适时、可执行、可续跑的人类决策。八项注意力调度原则（仅在必要时打断 / 只找正确的人 / 区分现在与稍后 / 压缩而非转发噪声 / 让决策可直接执行 / 保留现场连续性 / 异常必须有预算 / 完成必须主动回流）是验收任何方案的第一排序。
- **活会话（blocked-on-ask）跳转原现场，不重启；进程已终止才讨论 checkpoint 恢复保证。**
- IC 中跨机器路径一律以 `<repo-root>` 表示；下文引用一律用仓库相对路径。
- 调研材料中的定量数字：本地 probe 数字为实测；外部 survey 数字为转引；凡设计中的目标值与方案估算均标注「示意估算，非实测」。

---

## 1. 任务契约（Contract）

**要求**

- 最小字段（HD §4）：`objective`、`beneficiary`（可显式未知）、`acceptance`、`non_goals`、`scope`、`budget`、`stop_conditions`、`decision_owner`（默认当前操作员）、`revision`、`created_by`、`change_reason`。内容用版本化 JSON，常用关联字段单列。
- IC 冻结的精确类型：`Contract={objective, beneficiary?, acceptance:Array<{id, kind:'check'|'artifact'|'human', description, evidence?}>, non_goals[], scope:{repo?,cwd?,allowed_effects?,human_only_effects?}, budget:{retry_limit?,deadline_at?,cost_limit?,cost_mode?:'hard'|'soft'|'unknown'}, stop_conditions:Array<{id,kind:'hard'|'judgment',description}>, decision_owner}`。
- acceptance 三类语义（HD §4）：`check`=已配置检查及退出状态；`artifact`=交付物版本与来源；`human`=显式人工验收。**检查通过不证明充分**；修改验收脚本属于验收变更，不能给自己降门槛；品味不伪装成可自动测。
- 变更语义（HD §4）：承重目标/范围/验收/预算变化 → 创建新版本（`reviseContract(workId, expectedRevision, contract, reason)`），不覆盖；旧范围/证据的未消费批准失效；已消费批准不撤销已发生效果；措辞微调不强制重审。
- 契约并非对所有任务强制（HD §3；MGMT §2.4）：普通观察会话不强制契约；托管执行与自动授权才检查必需字段。`control_works.contract` 可为 NULL；discovered Work 以 `candidate` + `contract=NULL` 创建，经 `promoteWork` 单向升级为 `active` 契约治理，无逆向路径。

**来源**：HD §4/§3；IC「Types」段；MGMT §2.4/§2.4.1/§3。
**状态**：字段与类型 `已批准`；discovered 轻量契约模式 `设计稿`（MGMT v4，未实现）。
**验收**：M1「合并承重澄清；变更失效旧批准；改检查不能沿旧依据；check 通过 human 条件未满足不完成」（HD §14）。

---

## 2. 注意力项（Attention Item）

**要求**

- 状态机（HD §5；IC AttentionItem）：`state ∈ open|applying|resolved|superseded`。`expired/denied/failed` 只作原因与结果，不塞进状态枚举。
- `effect_state ∈ not_started|applying|succeeded|failed|unknown`。**unknown 不等同失败，不是自动重试授权**。
- IC 冻结完整载荷：`item_id, work_id, revision, state, effect_state, urgency:'now'|'inbox', conclusion, trigger, impact, recommendation?, options[], owner, expires_at, defer_until, acknowledged_at, source_link, approval_id, consumer_owner:'extension'|'orchestrator'|null, contract_revision, decision_mode:'human_only'|'scoped_auto', evidence:Record, created_at, updated_at`。
- 动作（IC `actOnAttention`）：`ack|defer|resolve`。**resolve 必须拒绝 open 的外部效果批准/unknown 效果；ack 永远不是回答**（HD §16.9：ack 只存 `acknowledged_at`，仅代表已阅）。
- 投影语义（HD §5）：Now = 有紧迫风险/即将失效/损失扩大证据；Inbox = 普通决策、最终验收、可批处理；Done = 已解决或被取代且无剩余动作。**正在等人不自动紧急，默认 Inbox**；`applying` 不重复提醒；失败/未知重开原项，不新建孤立卡片。
- 延期（HD §5）：`defer_until` 不停止等待计时、不延长批准有效期；到期回待处理；重大新风险可唤回；显示延期是否继续阻塞。
- 决策卡最小载荷（AGENTS.md；HD §3/§6；ORCH §4.3 落点表）：一句话结论、触发原因+关键证据、不处理的影响、建议动作/结构化选项、唯一责任人与时效、返回原现场入口、决策后续跑状态。
- 排序（HD §6）：确定性可解释排序（扩大风险→临近失效→阻塞关键任务→普通等待），同级稳定；**禁止黑盒紧急分**。

**来源**：HD §5/§6；IC「Types / Functions」；AGENTS.md「决策卡最小载荷」；UXP §3。
**状态**：`已批准`（状态机与载荷）；UXP 的问句模板化、个人中位数并置、批量「Resolve all bounded」`设计稿`。
**验收**：M2「普通阻塞不紧急；无事实不重复；延期不延有效期；风险唤回；浏览器回答冲突延期归档失败回流」（HD §14）。

---

## 3. 身份与关联

**要求**

- 关联骨架（HD §5）：`work_id` 关联 `contract_revision`、可选 `task_id`、`stable_id`/`attempt_id`、`item_id`、`request_uid`/`approval_id`、`receipt_id` 与证据。**重试保留 work_id、更换 attempt_id**。同一决策原地更新；同任务独立问题可多项但按任务分组；不同风险/效果不得强合并；旧数据不猜关联。
- 事件身份（HD §16.1）：业务事件键 = `producer_id + entity_id + entity_version + event_kind`；重发不得改变身份或 payload；ledger 新增 `applied_control_events(event_id PRIMARY KEY, payload_hash)`，**同键异 payload 属完整性错误，不能覆盖**。
- 跨库批准缝隙（HD §16.1）：mailbox receipt 是消费事实；orchestrator 在推进任务的同一事务写 `applied_receipts(receipt_id UNIQUE)` 与结果 outbox；崩溃后凭 receipt 对账，不能依赖再次 consume 返回答案；`mailbox.applied_at` 是可重建回执投影，不能先写成功再推进任务。
- MGMT 内容寻址身份（§5.1）：`work_id=randomUUID()`；`execution_id=sha256(work_id+stable_id+writer_id+attempt_no)[:32]`；`artifact_id=sha256(work_id+kind+canonical_key)[:32]`；`version_id=sha256(artifact_id:content_kind:content_sha256)`，**observed_source 不入身份**（同内容经 ledger/jsonl/git 观察到均为同一 version，来源记 `mgmt_observations`）；`manifest_id` = 内容 canonical JSON 的 sha256。`mgmt_session_binding(stable_id PRIMARY KEY, work_id)` 保证一个 Session 最多属一个 Work。
- 既有身份沿用：`request_uid=<stable_id>#<writer_id>#<tool_call_id>`（DA，历史）；`approval_id` 同时是 spool 事件 request_id（ORCH §3.2）；消费 receipt 是决策线性化点——人答先于消费则赢，消费后答收到 `already_consumed` 且不能撤回效果（CFG）。

**来源**：HD §5/§16.1；IC「Event transport」；MGMT §4.2/§5.1；DA（历史）；ORCH §3.2/§3.9；CFG 末段。
**状态**：HD/IC 部分 `已批准`；MGMT 身份体系 `设计稿`。DA `历史`。
**验收**：HD §16.1 注入式验收——源事务后/发布后/ledger 提交后/确认前逐一崩溃；重复、乱序、同键异内容、spool 被清除均有明确结果；一项业务事件最多一次改变投影。

---

## 4. 授权与预算

**要求**

- 三层授权（HD §7）：低成本可逆 → 已授权范围直接做；有边界自主 → 额度内做；必须人工 → 指定高风险/超预算/方向变更。按**影响/范围/可逆性**，而非命令名字；现有精确命令/路径匹配继续复用（CFG decision_bot 规则）。
- 策略优先级（HD §7）：有效性 → 明确禁止 → 必须人工 → 有效人工答案 → 明确自动授权 → 等待人。过期/证据不符人工也不能消费；bot 停用不阻塞合法人答；**策略变化不能撤销已发生副作用**。
- human_only 权威（HD §16.8）：`approval_targets` 持久保存 `decision_mode=human_only|scoped_auto`，attention_items 只作展示投影；契约及策略版本纳入 `targetVersion`；bot 提议前拒绝 human_only，**consumeDecision 消费时再次检查当前权威模式、策略和版本**；只检查 matchingRule 不足以拦截已存在或失效竞争中的提案；默认无授权等同必须人答。
- 授权晋升（HD §7）：历史样本 → 精确候选 → 回放解释 → 人确认 → 先观察 → 人启用。**不能由经常批准自动变永久权限**。
- 预算（HD §7）：重试次数持久化；托管时间到期禁止新受控动作，按已授权方式停自启任务；调用成本仅在有可信计量和执行入口时硬限制；不透明外部会话仅软阈值/unknown；暂停/kill 本身可有副作用，只管自启且身份核验的进程；不可中断效果不能原子撤回；**不通过新 attempt/task 绕预算**；人工扩预算记录原因新版本。
- retry_budget 消耗口径（REC §4）：扣预算 = `runner_dead`、`runner_exit` 且 evidence 不完整、`bind_timeout`；不扣 = 崩溃前重跑、`liveness_unknown`、`spawn_unverified`、`spawn_fail`/`worktree_fail`、`check_absent`。预算耗尽落点 `blocked`（非 `failed`），人 `human_reopen` 重置为 2。

**来源**：HD §7/§16.8；IC「Receipt/effect cross-task contract」；CFG「Restricted decision bot」；REC §4；ORCH §3.3。
**状态**：`已批准`（HD/IC）；CFG 描述的 exact-match bot 规则是现状实现，HD 三层模型是目标态——两者关系为「现有精确匹配继续复用，之上加优先级与 human_only 复验」。
**验收**：M3「human_only bot 不消费；重启额度不重置；旧证据契约过期不消费；人 bot 并发一次消费；未知成本不硬承诺；不 kill 外部」（HD §14）；HD §16.8 必须含「先有合法 bot 提案、再改 human_only、最后 consume」不放行。

---

## 5. 执行闭环与恢复

**要求**

- 三时刻分离（HD §8）：`answered`、`consumed`、`effect confirmed` 分离，**第三步才算落实**。消费前可在目标有效时再取答案；消费后无结果先 unknown 核查；部分效果从已确认步骤续，不从头重放；无法查询是否发生则人处理；幂等可核验才在预算内恢复；不承诺外部 exactly-once，保证消费去重、步骤留痕、unknown 不盲重放。
- 部分效果逐步核实（HD §16.3）：提交结果按 `push` 与 `pr_create` 两步各自记录 not_started/applying/succeeded/failed/unknown + 证据 + 目标 commit/remote/branch/PR URL。gh 报错不能断言 PR 未创建（网络失联可能远端成功）；远端存在同名分支不能证明目标 commit 已推送，应比对 SHA；不同版本需重新授权。卡片字段 `confirmed_effects` / `pending_or_unknown_effects`。
- CI 选项（HD §16.4）：`ci_anomaly` 选项迁移为 `recheck / manual-followup / abandon`——recheck 只承诺重新查询状态、不承诺重跑 CI；manual-followup 保持 blocked 给现场入口、不标 done；abandon 只停止托管跟进、不声称关闭 PR。**不自动建后继任务**；旧未消费 CI 目标关闭并注册新版，旧答案不得转换成新语义。
- 工具效果核实（HD §16.5）：extension 把 receipt_id 关联 toolCallId/attempt，消费时只记 `applying`；真实 tool_result hook 记录完成证据；`effect_observed` 事件经来源/目标版本/工具关联校验后更新回执与注意力项；**不加任意客户端自报成功接口**；丢 tool_result/宿主死亡/期限耗尽由持久 outstanding receipt 对账转 unknown；人工 deny = 策略拦截成功但工具效果仍 `not_started`。
- 跨库（HD §8）：`ledger.db`=遥测投影；`orchestrator.db`=执行事实；`orchestrator-answers.db`=答案凭据。源状态变更**同事务**写 outbox；事件字段 event_id/work_id/可选 item_id/task_id/attempt_id/entity_version/kind/occurred_at/payload；失败可重发，乱序不倒退，旧 attempt 不覆盖新；ingest 单向，不混命令回写。
- 外部效果账本（MGMT §9.6.4）：`mgmt_external_effects` 每类有 reconcile 谓词——git_push 用 `git ls-remote`（同 sha=confirmed/异=superseded/命令失败=unknown）；pr_create 用 `gh pr list`；pr_comment/release/http_post 无可靠 reconcile → 一律 unknown 并人工标注；**unknown 副作用不得被任何自动流程重放**。

**来源**：HD §8/§16.3/§16.4/§16.5；IC「Event transport / Receipt contract」；MGMT §9.6.4/§10.2；ORCH §3.8/§3.9。
**状态**：`已批准`。
**验收**：M0a/M0b 全套（HD §16.10）；HD §16.3「push 成功后 PR 明确拒绝」与「PR 创建后丢响应」两种结果分别覆盖。

---

## 6. 通知与提醒

**要求**

- 原则（HD §6）：新增 Now 聚合提醒；无承重变化不重复；有效期阈值有限提醒；普通进度和自动恢复不提醒；非紧急完成更新原项并入摘要；静默时段的风险突破需明确配置；记录通知触发依据和版本，**失败不得记已送达**；当前仅支持 macOS，缺通知能力显式显示。
- 投影式通知（HD §16.9）：通知改读 attention 投影，持久 `urgency/expires_at/defer_until/risk_revision/last_notified_revision/threshold`；**跨越有效期阈值是一个可去重的变化，时间推进可触发一次通知，不必换 item_id**。ack 另存 `acknowledged_at`，不改变答案状态。
- 界面层（UXP §8）：系统通知只发 Now 新增与即将过期；正文一行（问句+剩余时效），无摘要无进度；Inbox 变化仅改 Dock 数字。
- 既有机制（P2 历史）：notifications 表状态机 pending/attempting/sent/failed_permanent，at-least-once，第 6 次失败 → failed_permanent 置顶；nudge 按集合差而非空→非空触发（ORCH §2.4 A2）。

**来源**：HD §6/§16.9；UXP §8；F2（历史）；ORCH §2.4。
**状态**：HD 目标态 `已批准`；P2 的 notifications outbox 属历史实现，HD 新 outbox 是重建设计（见 §16 冲突说明）。
**验收**：M2「无事实不重复；延期不延有效期；风险唤回」（HD §14）。

---

## 7. 方向变化与停止

**要求**

- 候选池（HD §9）：仅一句话/来源/价值；默认不抢占不提醒，启动才补契约，不造排期平台。UXP §6：新建只填标题，升格 Work 必须填 objective + 至少一条 acceptance；旧候选不催促只计数。
- 在途改向呈现（HD §9）：显示暂停/失效任务、已有交付、需要重做检查批准、已知成本耗时，未知写未知；记录原因。
- 硬停止条件（HD §9）：权限/额度/禁止类在受控边界停新动作；价值假设不足等判断条件提出继续/缩小/停止；**证据到期不自动判死亡**。
- 停止动作（HD §9）：取消未消费批准；禁止新 attempt；已授权流程停自启进程；保留产物/原因/未决外部效果；无剩余风险归档；删工作区继续 clean/terminal/进程核验约束，不立即删证据。
- 改版不提前释放占用（HD §16.7）：契约 revision 在原 work_id 递增，不自动建新任务；先 `supersede_requested` + 禁止新动作 + 未消费目标失效；**保持执行占用直到可核实自启 runner 已停止且旧 attempt 被围栏隔离**；owner lease 过期 ≠ 进程死亡。批准失效用 `closed/invalidation_reason`，不伪写 `consumed_at` 或 actor='superseded'。
- 有界升级出口（HD §16.7；R3 B-1）：supersede 停止核实有持久 deadline；到期或观测不可恢复时创建唯一 human_only 占用处理决定：`confirm-stopped`（人在原现场核实指定 pid/boot_id/attempt 停止并提交证据后释放；探测证实活着则拒绝）/ `keep-held`（保留占用并给下次期限）。不能用「愿意冒险」覆盖已知仍活进程；两者都没有则保持占用，UI/CLI 明示 work_id、责任人、期限与入口，**不无限自动重试、不生成重复审批**。该出口不依赖 M0b，复用既有 approvals/mailbox + 占用门类型 + human_only 消费约束，CLI `orch show/answer` 同期可用。
- Work 合并/拆分（MGMT §8.4，D12）：本期不做真合并真拆分；合并用不可变 alias `mgmt_work_alias`（只合并展示，不重写 artifact_id，禁链式/环形，重扫不复活）；拆分推荐新 Session 用 `Overload-Work:` 标记新建。

**来源**：HD §9/§16.7；R3；IC「Functions（redirectWork/recordStopCondition）」；MGMT §8.4；UXP §6/§7。
**状态**：`已批准`（HD §16.7 + R3）；MGMT alias `设计稿`。
**验收**：M4「不抢占；可定位变更返工；等待不重计；unknown 不归责；规则不自启；停止保留外部效果证据」（HD §14）；R3 验收场景（恒 unreadable：期限内一个人工项、CLI 显示占用、确认前 claim 被挡、具名证据后放行、旧外部效果保留）。

---

## 8. 指标与审计

**要求**

- 指标集（HD §10）：人类等待（需人→有效答案消费，不含执行）、落实延迟（消费→核验）、阻塞占比（区间并集）、指令变更返工（明确契约变更归因）、优先级抖动（改向暂停替换及已知损失）、可下沉比例（明确候选，≠自动批准率）、停止延迟（条件触发→停止决定）、无效打断率（用户明确反馈，未反馈单列）、恢复成功率（可观测恢复样本）。
- 数据源固定（HD §16.6）：audit 只读 ledger，不联查多个写库。事件 kind：`attention_required / decision_consumed / effect_observed / recovery_outcome / contract_revised / work_redirected / stop_condition_triggered / work_stopped / attention_feedback / notification_delivered / policy_candidate_evaluated`。等待/阻塞取 required→consumed 区间并集；延迟取 consumed→可核实 effect；恢复率只取 recovery_outcome 可观测样本；返工需 contract_revised 明确归因链接；停止延迟 trigger→决定与→实际停止分别统计；无效提醒取 feedback 对 delivered 的链接。**缺任一端点不造值，显示 coverage/unknown；禁止用 received_at 替代发生时间**。
- UX 呈现（UXP §4）：Ledger 页五指标（Waiting / Rework you caused / Redirects / Sunk to rules / Death delay）一行五格 + 7 天稀疏折线；数据不全写 `coverage 61%` 不补值；不做排名、不做趋势评语、不做「做得好」。
- audit 建议（HD §10）：主动输出少量建议（重复操作可授权、验收频繁变更、停止条件已触发未决定），只经主动查看或 Inbox 摘要，不添通知。

**来源**：HD §10/§16.6；IC「Ownership（audit.ts 属 Core）」；UXP §4。
**状态**：指标定义 `已批准`；UXP 五指标是其展示子集；audit.ts 缺计算属待实现。
**验收**：先建基线（人工次数、等待/落实延迟、恢复成功率、无效打断、阅读跳转、自动清退），不捏造减少目标（HD §15）。

---

## 9. 跨 channel 共享边界

**要求**

- Feishu channel（INT）：daemon 走 lark SDK WebSocket 长连接，无公网入端口；授权文件映射 `{instanceId, tenantId, userId, ownerId}`，**按 app+instance+tenant+user+chat 联合匹配**，不授权同用户在其他 chat；未知发送者回 access-denied，不静默注册。群消息需显式 @bot。
- 同一 mailbox（INT；IC）：channel daemon 与 Web 控制 DB 共用 `OVERLOAD_ANSWERS_PATH`；native select/confirm 创建既有控制注意力项、消费 mailbox receipt、回写 Feishu 卡片；**发送文本永不批准请求或转向进行中的 turn**；`/cancel` 先关闭 pending native 批准再取消 runtime，不自动重试。
- 关键隔离（INT）：native 确认只验证答案送达与 runtime 完成，**不验证任意工具效果或业务验收**；extension HTTP `approval_gate` 是另一协议，不得把 Feishu 上的 native 确认当成工具批准已送达；runtime input/editor 请求保持 unknown，不伪造答案。
- 共享内容边界（MGMT §7.4）：采集与共享是**两个独立信任边界**，默认全部不可分享；`shareable=1` 仅当 file 且人工标 `clean`，或 git_commit/external 仅导出引用+哈希；工具结果/assistant 文本/diff/dirty/runner.log 默认 `shareable=0`；`buildSharePackage` 白名单拼装，不接受「读全部再过滤」。
- Surface 不得基于浏览器输入降级权威字段（IC）。

**来源**：INT 全文；IC「Receipt/effect cross-task contract」；MGMT §7.4/§11.1。
**状态**：Feishu 现状 `已批准`（运行文档）；MGMT 共享边界 `设计稿`。
**验收**：场景 18「敏感信息不进入可分享产物或交接包」（MGMT §17）——断言的是导出边界，不是扫描器召回率。

---

## 10. 来源 / 版本 / 有效期 / 权限 / 冲突与失效

**要求**

- 来源与版本：Work 有 `(source, source_id)` 部分唯一索引（发现去重）；契约有 `revision` + `expectedRevision` CAS；注意力项有 `revision` + `expected_revision` + `contract_revision`；事件有 `entity_version`；approval_targets 持久 `decision_mode` + `targetVersion`（含契约与策略版本）；证据有 `evidence_version`（HD §6）。
- 有效期：gate 默认 24h 未答 → `blocked(gate_expired)`（ORCH §3.3）；attention item `expires_at` 可空；defer_until 不延长有效期（HD §5）；过期证据/契约的人工答案也不能消费（HD §7）。
- 权限：`decision_owner` 字段；mgmt 所有 `/api/mgmt/*` 写操作与内容读取要求调用方 = `mgmt_work_profile.decision_owner`；`artifact cat` 是 owner 授权操作（MGMT §7.4/§11.1）。
- 冲突检测：所有变更版本 CAS；`ControlError` 四码 `not_found/conflict/invalid/blocked` → HTTP 404/409/400/409（IC）；事件同键异 payload = 完整性错误；`manifest_drift` → 409 并列差异条目；`workspace_contention` → 409。
- 失效传播：契约承重变更使未消费批准失效（HD §4）；manifest 任一 artifact 出新版本、git_head/base_sha 变化、verification 证据哈希变化 → 该 manifest 下 accepted 行写 `invalidated_at` + `invalidated_reason='superseded_by:...'`，相关未消费卡置 superseded（MGMT §10.1）；旧 CI 目标关闭注册新版，旧答案不转新语义（HD §16.4）。
- 源可用性三分（MGMT §5.0）：`unavailable`（读不了）永不等于空、永不触发删除或 vanished；`empty`（可读确实无数据）；`stale`（可读但超新鲜度阈值，默认 120s）。`source_coverage ∈ ledger_full/file_only/ledger_stale/gapped` 直接驱动交接门禁。

**来源**：HD §4/§5/§7；IC 错误码段；MGMT §5.0/§10.1/§11.1；ORCH §3.3。
**状态**：`已批准`（HD/IC）；MGMT 失效传播 `设计稿`。
**验收**：MGMT §17 场景 15（另一文件/base/生成物/验证结果变化四种全部 409 manifest_drift）、场景 10（源不可用八变体均不变 vanished）。

---

## 11. 决策证据

**要求**

- 决策包扩展（HD §6）：在 question/options/effect/scope/evidence 基础上补 `conclusion、trigger、impact、recommendation、owner、expires_at、source_link、contract_revision、evidence_version、effect_state`；模型只整理建议，不改权限；**证据大则给引用而非全文**。
- runner 证据（HD §8）：按 attempt 记录检查命令、退出状态、版本、采集时间；权限/大小/保留期限制；敏感内容展示/入模前处理；**不可信事件不能指定任意读取路径**；重试不覆盖旧证据；进程结束不证明日志完整。
- PR 观测失败（HD §16.2）：持久 `pr_observation_failures、last_observed_at、last_known_pr_state`；观测失败分类用 unknown，但**不与副作用 effect_state=unknown 混淆**；瞬时有限重试，权限/工具错误直接升级，耗尽显示 `pr_unobservable`；`unknown_ticks` 预算独立于 runner 判活，不互相扣减。
- 证据体系（MGMT）：`mgmt_observations`（何时/从哪个源/以何方式看到某版本，与版本身份解耦，仅追加）；`mgmt_links.evidence_ref` ∈ `journal:<seq>|jsonl:<path>#line|git:<repo>@sha|user:<actor>@ts`，confidence `strong/weak/uncertain`，uncertain 不开卡；交接包 `done/verified/open` 各带 evidence 数组；`closeout_evidence` JSON 是 `ended_*` 的必要条件。可复用既有 `{path,sha256}` 审核绑定（coordinator review）。
- 采集边界（MGMT §7.4/§7.5）：路径黑名单 → `withheld_sensitive` 只存 sha256+size；工具摘录先 scrub 再截断 ≤2KiB；URL 剥离 query 与 userinfo；单文件 >2MiB → `too_large` 只存哈希。

**来源**：HD §6/§8/§16.2；MGMT §5.1/§7.4/§7.5/§9.2；ORCH §3.8。
**状态**：`已批准`（HD）；MGMT 证据模型 `设计稿`。
**验收**：M0「gh 失败不 clean；push 成功 PR 失败如实卡片；unknown 不重放」（HD §14）。

---

## 12. 恢复与回流

**要求**

- 关键区分（AGENTS.md；MGMT §9.1；ORCH D2）：**活会话 blocked-on-ask → 409 `source_blocked_on_ask` + 返回原现场跳转目标（queryJumpTarget），绝不静默重启**；只有进程已终止才走 checkpoint/attempt 恢复。orchestrator 托管会话对通用 Resume 关闭（`orch:` 前缀 guard，ORCH §3.10）。
- 进程终止恢复（REC §3.2）：spawn 前先在 orchestrator 库事务内写 `task_recovery.spawn_state='intent'`（独立提交），spawn 结果回写 `spawned/failed`；恢复按状态四分支，`intent` 一律「不 spawn、只探测、有界后交人」；崩溃落在 intent/spawned 之间是结构性不确定，只能降级不能消除。
- 结果回流（HD §1；AGENTS.md 原则 8）：完成/失败/决策后恢复结果必须回到原工作项，不再需要注意力时自动归档。
- 自动归档（MGMT §9.8）：归档是真实状态转移（`track_state='archived'`），不是视图过滤；closeout 六谓词（全部执行 ended_* 且 ledger_full / 无 open 卡 / 无在途交接与提交 / 存在结果记录 / grace 已过）；无 `session_ended` 的外部 idle 会话由 §9.8.0 派生结束谓词（idle + writer 死或 emitter_drained + grace + 无 pending ask + 无更新 incarnation）落 `exec_state` 并强制写 `closeout_evidence`；file_only 永不自动归档，只能人工归档。
- 迟到事件（MGMT §9.8.3）：归档后新活动自动 reopen 回 tracking，但**不回滚** `control_works.state`——若已 completed（人或 coordinator 写）则保持，只在任务页顶部提示「已完成任务出现新活动」。
- 跨任务回流（IC）：失败和完成结果经 outbox 事件回写原项；`work.archived` 事件供 channel 回流。

**来源**：AGENTS.md；HD §5/§8；MGMT §9.1/§9.8/§9.8.0/§9.8.3；REC §3.2；ORCH §3.10；INT。
**状态**：`已批准`（原则与 REC 语义）；MGMT 派生归档 `设计稿`。
**验收**：M0「原项结束回流」；MGMT §17 场景 17/17d/17e/17f。

---

## 13. 失败处理

**要求**

- 异常预算（AGENTS.md 原则 7；HD §7）：只对已识别瞬时故障有限自动恢复；预算耗尽后保留现场、明确失败分类、给出恢复动作；不无限重试、不静默失败、不要求用户从头重建上下文。
- 观测失败分类（HD §8/§16.2）：checkPr 必须区分成功无异常 / merged / 业务异常 / 观测失败；观测失败不返回 clean；瞬时有限重试，权限/工具问题直接动作，耗尽显示无法确认；最后已知状态标过时。
- 四重限界（REC §4）：attempt 失败由 `retry_budget` 限；绑定等待由 `BIND_TIMEOUT_TICKS`（12 tick≈60s）限；活性不可判由**持久化** `unknown_ticks` 限（跨重启累计，不受时钟跳变影响）；spawn 不可核实由同一持久计数限。每条以带原因的 `blocked` 交人。措辞纪律：所有路径到达**决策态或终态**，不是「到达终态」。
- 源失败分类（MGMT §6.3.3）：ledger 不可读 → 本轮跳过、`unavailable`、不归档任何 Work；ledger 表 DROP（损坏）→ 立即开卡；单 jsonl 不可读 → 该执行 `gapped`、cursor 不推进、门禁拒绝；jsonl 截断 → cursor 重置不产生重复版本；快照目录只读 → `write_failed`；**commit 后 kill -9 → 重启对账转 stored/lost，绝不留 pending 假装已存储**。
- 启动失败矩阵（MGMT §9.6/§9.7）：`failed_no_effect` 仅在能证明目标进程从未启动时使用、可自动重试；超时/崩溃/回执不可判一律 `unknown`、**永不自动重试**，且必须 reconcile-before-retry（先查 ledger/incarnation/jsonl/surface 四源，全部为否且源可用才允许人选择重启）。

**来源**：AGENTS.md；HD §7/§8/§16.2；REC §2.2/§4；MGMT §6.3.3/§9.6/§9.7/§13.4。
**状态**：`已批准`（REC/HD）；MGMT 分类 `设计稿`。
**验收**：REC §7 十一条测试（含跨重启 `unknown_ticks` 计数）；MGMT §13.4 故障注入清单。

---

## 14. 里程碑（注意：三条独立编号轨道）

**重要：仓库内存在三套 M 编号，分别属于不同工程，不得混用。**

轨道 A — 人类决策控制（HD §14 + §16.10；与 IC 同批）：
- **M0a**（已确认缺陷与反向测试）：PR 分类、部分效果、CI 选项迁移、审批事务与稳定事件键。
- **M0b**：outbox 发布/投影/确认、源对账、效果及日志；无损回流验收必须在 M0b 前提齐备后运行。
- **M1**：契约、证据版本、变更、停止、legacy；**supersession 正式能力在 M1 才启用**。
- **M2**：分区（Now/Inbox/Done）、决策包、延期、提醒。
- **M3**：策略优先级、预算、能力、候选规则。
- **M4**：候选池、变更影响、停止、audit。
- 依赖：M0(a+b 完整) → M1 → M2/M3（接口固定后可并行）→ M4。M0a→M0b 是依赖顺序，不是可漏告警上线的阶段。

轨道 B — orchestrator v1（ORCH §6）：M0 前置（CSRF 守卫/reducer host 权威/删 q2）→ M1 store+状态机+租约+reconcile+spool（无 spawn）→ M2 worktree+runner spawn+resume 旁路禁用 → M3 evidence+ready gate+CLI 答复 → M4 web 答复面 → M5 submitted push/PR/CI。

轨道 C — 产物纳管/交接（MGMT §14）：阶段 0 地基（schema v2 + 三种 jsonl reader + 身份函数）→ 阶段 1 本机 pi→omp 端到端 + 一台 ssh 主机发现快照 → 阶段 2 manifest/验收/提交衔接 → 阶段 3 Claude file_only 接入 + 纠错 + alias + 远程全量（已完成验收，见 §14 注记）→ 阶段 4 云端 Agent 手动导入。

**来源**：HD §14/§16.10；ORCH §6；MGMT §14。
**状态**：轨道 A `已批准设计，未授权生产激活`（IC 原文：User authorizes all M0–M4 development, not production activation/deploy/push）；轨道 B/C `设计稿/部分已实现`。

---

## 15. 所有权划分

**IC 冻结（轨道 A 四 owner，互不越界）**：
- **Core**：`src/control/{types,store,outbox,projection}.ts` + 测试/schema；`src/ingest/{ingest,reducer,schema.sql}`；`src/shared/types.ts` 仅加 event kind；`src/cli/audit.ts`。不碰 web/orchestrator/extension/decision-bot/queries/CLI。
- **Execution**：`src/orchestrator/*` 全部，集成 core API 与契约，含 M0a/M0b、M1 supersession、M3 预算执行。
- **Authorization**：`src/decision-bot/*` + `src/extension/overload.ts`，实现 human_only 消费复验、receipt 效果观测、scoped 策略候选与安全晋升。
- **Surface**：`src/web/*`、`src/shared/queries.ts`、`src/notify/*`、`src/cli/overload.ts`，实现 M1–M4 用户流程/CLI 与界面迁移。
- 共享 API 必须逐字实现：`ensureControlSchema/openControl`、Contract/Work/AttentionItem 类型、createWork/reviseContract/redirectWork/recordStopCondition/upsertAttention/getAttention/listAttention/actOnAttention/recordAttentionFeedback、ensureOutbox/enqueueControlEvent/publishControlEvents/applyControlEvent、`reconcileEffectEvents`。

**ORCH §4.2 边界**：orchestrator 只写 orchestrator.db/artifacts/worktrees/自己的 spool；ledger.db 只读；`web/recon/ingest/notify/pull/shared` 不得 import orchestrator（CI grep 守门）；两处登记例外 = web 写 answers mailbox、`resume.ts` 的 `orch:` 前缀 guard。

**MGMT §2.4.1 边界**：`src/manage/*` 采集器**任何 SQL 不得出现 `UPDATE control_works`**（authority.test.ts 源级断言）；closeout_owner='mgmt' 只写 profile.track_state='archived'。

**来源**：IC「Ownership / Shared APIs」；ORCH §4.2；MGMT §2.4.1/§13.1。
**状态**：`已批准`（IC）。

---

## 16. 迁移策略

**HD §13（轨道 A 八步）**：① 版本化 schema、备份、统一入口，不在 Web 请求散建表；② 先补身份、事件、outbox，不改行为，验证重放；③ 确定关联才回填；④ legacy 不强补契约，新增授权/预算/验收才要求字段；⑤ 旧批准不扩大权限，不匹配自动提案失效；⑥ UI/通知同时切新投影避免双提醒；⑦ 删旧派生双写、保留历史；ack≠answer、closeout≠验收；⑧ 数据级回退；新强制策略启用后旧程序不理解则拒启，不能降级绕过；回退先停执行受控迁移。

**REC §6（orchestrator 侧）**：`task_recovery` 用 `CREATE TABLE IF NOT EXISTS`，旧库下次启动自动获得、无 ALTER、无回填；旧库无恢复行但 `runner_pid/stable_id` 非空的任务一律按 `intent` 保守处理（不 spawn）；旧代码不认识新表，降级安全。

**MGMT §12.5（control DB v1→v2）**：纯追加（只 CREATE TABLE/INDEX，不 ALTER）；`PRAGMA foreign_keys=ON` 全局开；迁移 `destructive:false`（备份是部署步骤不是语义标志）；部署顺序 = 停全部写者 → VACUUM INTO 备份 → 一次性升级全部二进制 → 启动任一 v2 进程自动迁移 → 最后开 `manage.enabled`；**v1 旧二进制打开 v2 库会被拒（兼容窗口为零），不是静默降级**；常规回滚 = 功能回滚（manage.enabled=false 保留 v2 表），无 down migration，不得以「回滚很简单」对外呈现。

**来源**：HD §13；REC §6；MGMT §12.1/§12.5；F1–F4（历史）。
**状态**：`已批准`（HD/REC）；MGMT `设计稿`。

---

## 17. 安全边界

**要求**

- 定性（HD §12；ORCH §5.1）：**gate 是工作流边界，不是安全边界**——同 UID 机器上任何同 UID 进程可 curl loopback、可直写 answers，Overload 无机制阻止；不做 sandbox/降权用户。
- 具体措施：保持 loopback + CSRF（POST 要求 Host + Origin 双匹配，缺 Origin 亦拒；GET /api/* 同样校验 Host 防 DNS rebinding，ORCH §2.1 SEC-1）；不暴露无认证控制面；自动授权默认关、新规则显式启用；human_only 不给 bot；源输入不可信；**模型不能改策略/凭据/直接副作用**；runtime input/editor 请求保持 unknown 不伪造答案。
- 跨 host 防护（ORCH §2.2 SEC-2'）：reducer 中 `detail.stable_id` 首段 host ≠ 事件 host 时回落事件自身 stable_id 并记 coverage_gaps——防远端伪造本机会话 vanished/Now 卡。
- 伪造防护（ORCH §3.9）：答复端拒绝 approval_id 在自有 approvals 无行的答复；记 actor ∈ {ui, cli}；accept 后爆炸半径 = 向 bot 分支 push + 一个待人合并的 PR，**合并永远需人在 GitHub 动手**，无 auto-merge。
- 共享侧（MGMT §7.4）：默认不可分享 + 导出白名单拼装；`artifact cat` 要求 owner。
- channel 侧（INT）：未知发送者 access-denied；授权五元组联合匹配。

**来源**：HD §12；ORCH §2.1/§2.2/§5.1/§5.2；IC「Receipt contract」；MGMT §7.4；INT；CFG。
**状态**：`已批准`。

---

## 18. Jev 参考材料要点与对 Overload 的启示

> 材料性质声明：本节来自 `docs/research/jev-reference/`（README.md + manifest.json + 7 图），是对 Diogo Almeida（TypeSafe）设计笔记的**独立整理稿，2026-09，非 TypeSafe 官方论文**。文中 token 占比（Table III）、路由算例（§II.A，4.15 vs 6.19，X=0.65/Y=0.12/Z=0.23）、模型单价（Opus $5/$25、Sonnet $3/$15）均为**示意估算，非实测**；仅 fastcontext 的 56.2%/46.5% 为转引第三方项目报告。Jev 是 coding agent harness 的决策层设计；Overload 是 fleet 注意力控制面，领域不同，下表逐项区分。

### 18.1 Jev 核心概念提取

1. **显式类型状态（explicit typed state / chunk store）**：状态是可寻址、带类型的 chunk 集合，而非 append-only 转录本；Jev 作为旁路决策层，对每个高频决策点返回带概率的**类型化答案**（choice/score/noul），harness 不解析自然语言即可校验、设阈值、分支。
2. **逐轮决策（per-turn questions，Table I）**：每个 chunk 对当前 query 应多可见？缓存前缀复用还是重建？子任务能否离开 frontier 模型？哪个工具匹配意图？命令是否允许运行？任务将触碰哪类文件（敏感度评分）？
3. **visibility ladder（Fig 4）**：同一 chunk 对不同 query 可隐藏 / 短摘要 / 长摘要 / 全文——查询感知的压缩，compaction 是查询前盲压，ladder 是查询后精压。
4. **routing per context rebuild（Fig 2，§II.A）**：按 token 计价的混合路由比纯 frontier 更贵（算例 4.15 vs 6.19，**示意估算**）；路由要可行必须给廉价模型小而专的上下文，且回程不强制重读全部产出。
5. **tiered disclosure（Fig 5）**：工具分三层——snippet（一行能力，常驻便宜）→ 选中后才加载完整 schema → 一次性查询才翻文档；细节用完即移出上下文。
6. **conditional instructions（Fig 6）**：AGENTS.md 片段挂在条件上（碰 `*.tsx`→style guide；在 billing/→billing GOTCHAS），条件持有时重载，且被钉住不被 compaction 摘要掉。skills=「现在做这个」，conditional=「把这个留在记忆里」。
7. **security-aware routing（Table IV，§IX）**：路由第三轴是 trust 而非难度/成本——public docs→任意最便宜模型；应用代码→vetted provider；secrets/env/infra→first-party frontier only；专有研究代码→排除指定厂商。
8. **background processing on shared retrieval（Fig 7，§X）**：跨模型 review、后台 eval 生成、ELI5 讲解、live progress page、流量 shadow——都是只读函数，共享一次「相关信息检索」结果，互不抢锁；因检索占 token 大头（Table III，**示意估算**：读文件 30–40%、搜索 10–18%、命令输出 10–20%），共享检索是最大单项节省。
9. 另：subgoal 注册去重（spawn 前登记，已做/在飞不重复启动）；读写显式分型使并发可控。

### 18.2 逐概念对照

| Jev 概念 | Overload 已有能力 | 可借鉴模式 | 不适用/存疑 |
|---|---|---|---|
| 类型化决策输出（choice/score/noul，harness 校验不解析 prose） | 决策卡 `options[]` 白名单、`ControlError` 四码、`state/effect_state/decision_mode` 封闭枚举——已是「结构化选项 + 封闭枚举」（IC；HD §2「不能混成一个 status」） | 把「人要决定什么」进一步压成结构化选项而非开放文本，与 IC「让 UI 猜」禁令同向 | — |
| visibility ladder / 查询感知呈现 | 卡片默认收起、展开才见证据（UXP §3.2/§3.3）；「证据大则给引用而非全文」（HD §6） | 决策卡证据可按视图分层：列表行=问句+三数字，展开=Why now/Impact/Evidence/Options；MGMT 交接包 64KiB 预算 + 分节按需读（`handoff show --section`）已是此模式 | Jev 的 heatmap/grep 过滤是 agent 内检索问题，不进控制面 |
| routing per context rebuild | 「压缩而非转发噪声」：同任务连续事件聚合去重原地更新、不逐事件转发（AGENTS.md；HD §6） | 「回程成本」提醒：给人的决策必须自带全部上下文，不要求人回原现场翻转录本——与「从提醒回到原现场耗时」指标呼应 | 模型间路由计价与 Overload 无关 |
| tiered disclosure | MGMT 证据引用优先、`artifact cat` 按需且 owner 授权（§7.4/§11.2）；outbox 投影只读、读者不各推一遍 | 通知正文一行问句+时效，详情留 Deep link（UXP §8）已是 snippet-first | — |
| conditional instructions（条件持有、钉住防摘要） | 权威事实在控制库（契约 revision、expected_version CAS、evidence_version、targetVersion），ledger 投影只作展示、可重建——投影被「摘要掉」不影响权威（IC projection 段；HD §16.1） | 「条件持有时重载」对应 `defer_until` 到期自动回待处理、`expires_at` 阈值跨越再提醒（HD §16.9）——已在设计中，无新增需求 | — |
| security-aware routing（按数据敏感度选模型） | MGMT §7.4 双信任边界：每 blob `sensitivity unknown/clean/suspected/confirmed_secret`，`shareable` 默认 0，`unknown` 永不进共享包 | Jev 把「敏感度→允许的消费方」做成路由策略；Overload 可把 sensitivity 维度复用到**决策卡内容分发渠道**（如 confirmed_secret 证据不进 Feishu 卡，只 loopback 可见）——属增强建议，非现有需求 | Overload 不选模型提供商，只选 channel |
| background processing on shared retrieval | notify 消费同一份 ledger 投影；audit 只读 ledger；outbox 投影物化一次供多读者（IC；HD §16.6）——已是「一次检索、多方只读消费」 | 后台派生任务（派生 closeout、健康卡、coverage 统计）共享同一次投影读取，避免每任务重扫——MGMT §9.8.0 已隐含此原则 | — |
| subgoal 去重 | `mgmt_session_binding` 一会话一 Work；handoff 在途部分唯一索引（一 Work 一个在途交接）；事件同键去重；approval 消费一次线性化（CFG） | — | 已覆盖 |
| 概率化 noul 决策（Jev 输出带概率） | **明确相反**：HD §6 禁止黑盒紧急分，排序必须确定性可解释；默认无授权=必须人答 | 无。Overload 不允许模型概率值驱动打断 | 分歧点，记录不改设计 |

### 18.3 结论

Jev 与 Overload 共享同一个底层判断：**上下文（=人/系统的注意力）必须被组装而非堆积**。Overload 的对应物是注意力项的原地更新、证据引用化、投影与权威分离——Jev 从 agent harness 侧独立收敛到了同样模式，可作为外部佐证。真正的可借鉴点只有两个：① sensitivity 维度向**分发渠道**延伸（敏感证据不进 IM 卡）；② 后台派生任务共享单次投影检索。Jev 的模型路由、缓存经济、工具 schema 分层属 coding agent runtime 内部事务，Overload 不做。概率化决策与 Overload 的确定性排序原则直接冲突，不采纳。

---

## 19. M0–M4 里程碑总表（轨道 A：人类决策控制）

| 里程碑 | 范围 | 依赖 | 验收条件（节录） |
|---|---|---|---|
| M0a | PR 观测失败分类；push/PR 部分效果分步核实；ci_anomaly→recheck/manual-followup/abandon；审批事务与稳定事件键 | — | gh 失败不 clean；push 成功 PR 失败如实卡片；确认前 claim 被挡 |
| M0b | outbox 发布/投影/确认、源对账（applied_receipts/applied_control_events）、效果及日志 | M0a | 发布前后崩溃不丢不重卡；unknown 不重放；一项业务事件最多一次改变投影 |
| M1 | 契约字段与三类 acceptance；证据版本；契约变更；supersession（正式启用）；legacy 兼容 | M0(a+b) | 变更失效旧批准；改检查不能沿旧依据；check 通过但 human 条件未满足不完成；legacy 可观测跳转 |
| M2 | Now/Inbox/Done 投影；决策包载荷；延期；Now 聚合通知 | M1（接口固定后与 M3 并行） | 普通阻塞不紧急；延期不延有效期；风险唤回；归档失败回流 |
| M3 | 三层授权与策略优先级；预算执行；human_only 消费复验；能力/候选规则 | M1 | human_only bot 不消费；重启额度不重置；旧证据过期不消费；不 kill 外部进程 |
| M4 | 候选池；改向影响呈现；停止；ledger 指标与 audit | M2/M3 | 候选不抢占；变更返工可归因；unknown 不归责；停止保留外部效果证据 |

## 20. 所有权矩阵（轨道 A，IC 冻结）

| 关注点 | Core | Execution | Authorization | Surface |
|---|---|---|---|---|
| 契约/注意力/outbox/projection 存储 | **OWN** `src/control/*`、`src/ingest/*`、`src/cli/audit.ts` | 集成调用，不改 | — | 只读消费 |
| orchestrator 任务状态机/租约/reconcile/submit | — | **OWN** `src/orchestrator/*`（含 M0a/M0b/M1 supersession/M3 预算） | — | — |
| human_only 复验 / receipt 效果观测 / 策略候选晋升 | — | — | **OWN** `src/decision-bot/*`、`src/extension/overload.ts` | — |
| Web/CLI/notify/queries 呈现与流程 | — | — | — | **OWN** `src/web/*`、`src/shared/queries.ts`、`src/notify/*`、`src/cli/overload.ts` |
| 跨边界硬约束 | event kind 加在 `src/shared/types.ts`（仅增量） | 写操作须版本 CAS + 同事务 enqueue | 不允许 bot 自降 decision_mode | 权威字段只来自可信 server/core，不按浏览器输入降级 |
| 禁止 | 不碰 web/orchestrator/extension/bot | 不编 core API | 不碰 core/server | 不做 core 实现 |

---

## 21. 已登记冲突（未调和）

1. **CI 异常选项**：ORCH §3.8（v1）为 `rerun/new-task/abandon`；HD §16.4 已改为 `recheck/manual-followup/abandon`。以 HD §16 为准（IC 同步「CI actions recheck/manual-followup/abandon」）。
2. **M 编号三轨道并存**：HD M0–M4（决策控制）、ORCH M0–M5（编排器）、MGMT 阶段 0–4（产物纳管）同名不同物，排期时必须带轨道前缀。
3. **答案通道**：DA 的 `${OVERLOAD_ANSWERS_DIR}/<uid>.json` 文件协议已 superseded，现行唯一反向通道是 `orchestrator-answers.db` mailbox（DA 文首自注；ORCH §3.9）。
4. **outbox 新旧两制**：F2（历史）的 notifications outbox 服务于旧队列通知；HD §16.1 的控制 outbox 是新建机制，且明确既有 journal `UNIQUE(host,emitter_id,seq)` 不按业务 event_id 去重——两者不可混为一谈。F1–F4 均自注「部分能力已从代码中移除」。
5. **指标口径**：HD §10 九指标 vs UXP §4 五指标——UXP 是展示子集，不冲突；但 UXP 依赖 `control_contract_revisions`、`control_redirects` 等表名属设计层命名，以 IC/Core 实际表名为准。
6. **视觉重做阻塞**：UXP（2026-09-07）的视觉方案仍受原指定 Fable 版本兼容阻塞（HD §16.10 注记）；UXP 自身标注「不代表已实现」。

## 22. 调研材料数据性质标注

- R3 probe-findings：cmux workstream 17,390 事件、可介入 31（0.18%）为**本机实测**。
- R2 fleet-inventory：pi 系约 530 会话占 86% 为**实测清点**；V-2'/V-5~V-7 为残留验证项。
- R1 external-survey：「2–3 agent 失控 / 10–20 有操作面 / 单批 10–50 项」为外部文献转引；R4 path-comparison：「人工触点 ≤30 决策/天、approval p95≤30s」为**目标值，示意估算，非实测**。
- Jev：见 §18 头部声明，全部算例与 token 占比为示意估算。
