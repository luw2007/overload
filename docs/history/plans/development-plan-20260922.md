# Overload 人类决策控制：开发交接方案

日期：2026-09-22。性质：开发方案，不改业务代码。供其他开发者按此实施。

## 0. 输入与前提

**已核查输入**
- 代码只读核查（本地审计稿 overload-code-audit-20260922，未入库）（覆盖 src/ 全部 12 个模块，约 1.8 万行 TS）
- 需求综合：`docs/history/plans/requirements-synthesis-20260922.md`（14 类设计文档通读，17 维度提取）
- 参考材料：`docs/research/jev-reference/`（README + manifest + 7 图，独立整理稿，非权威论文；其中 token 占比与路由算例为示意估算，非实测）

**关键前提（贯穿全文）**
- 产品目标：把 Agent 运行噪声压缩为少量、适时、可执行、可续跑的人类决策。八项注意力调度原则（AGENTS.md）是验收第一排序。
- **活会话 blocked-on-ask → 跳转原现场，不重启；进程已终止才讨论 checkpoint 恢复保证。**
- 设计基线：`overload-20260906-human-decision-design.md` 经 claude-opus-5 三轮审查 R3 APPROVE（仅设计放行），§16 为 R2/R3 修订，冲突处以 §16 为准。
- 所有权基线：`overload-20260906-implementation-contract.md` 定义 Core/Execution/Authorization/Surface 四 owner 文件边界与共享 API。
- 仓库内存在三套 M 编号（HD 决策控制 M0–M4 / ORCH 编排器 M0–M5 / MGMT 纳管阶段 0–4），本方案仅覆盖轨道 A（HD），排期时必须带轨道前缀。

---

## 1. 现状基线：已有能力

代码核查确认以下能力已建成且与设计对齐：

| 能力域 | 状态 | 代码位置 |
|---|---|---|
| Work / AttentionItem / Contract 类型与状态机 | ✅ | `src/control/types.ts` |
| revision CAS（契约与注意力项） | ✅ | `src/control/store.ts` |
| outbox（稳定 event_id / lease / payload_hash / 确认删除） | ✅ | `src/control/outbox.ts` |
| outbox 同键异 payload=完整性错误（throw 不覆盖） | ✅ | `src/control/outbox.ts:40-45` |
| reducer 事务路由 + ledger 投影 | ✅ | `src/ingest/reducer.ts`、`src/control/projection.ts` |
| expires_at / approval TTL | ✅ | `src/control/types.ts`、`src/orchestrator/approval.ts` |
| 任务状态机 / attempts 预算 | ✅ | `src/orchestrator/store.ts` |
| PR 观测 observation_failed 分类 | ✅ | `src/orchestrator/pr.ts` |
| human_only 不自动消费 / bot 只 propose | ✅ | `src/decision-bot/{mailbox,service}.ts` |
| applied_receipts 与任务迁移同事务 | ✅ | `src/orchestrator/approval.ts:50` |
| takeover CLI | ✅ | `src/cli/overload.ts` |
| approval_gate fail-closed | ✅ | `src/extension/overload.ts` |
| effect_observed 经 spool 上报 | ✅ | `src/extension/overload.ts` |
| manifest acceptance / 版本 invalidate | ✅ | `src/manage/manifest.ts` |
| cross-agent handoff 前置条件（含 blocked_on_ask 判定） | ✅ | `src/manage/handoff.ts` |
| Now/Inbox/Done UI + 决策卡 | ✅ | `src/web/static/app.js` |
| pluggable channels（Feishu）+ 决策状态共享 | ✅ | `src/adapters/{types,store,feishu}.ts` |
| 活会话 jump / 死会话 resume | ✅ | `src/shared/{jump,resume}.ts` |
| 只读后台 recon / pull | ✅ | `src/recon/recon.ts`、`src/pull/pull.ts` |

---

## 2. 差距与待建能力

代码核查确认四个主要差距（均带代码位置），按优先级排列：

### G1：提交后两步 effect 未回流决策卡（§16.3 半截）
- `src/orchestrator/submit.ts` 已区分 push 与 pr_create 两步，产出 `result.effects` 清单（含 SHA 比对、push:confirmed）。
- `src/orchestrator/orchestrator.ts` pollSubmitted 只读 `result.ok` / `result.pr_url` 做状态迁移，**丢弃了 `result.effects`**。
- 决策卡 `evidence.confirmed_effects / pending_or_unknown_effects` 不会被两步记录填充。
- UI 目前合并为 "verified/pending" 二态，未分列 confirmed vs pending effects。

### G2：PR 观测精细化字段未落库（§16.2 半截）
- `src/orchestrator/pr.ts` 已返回 `observation_failed`，schema 有 `ci_observation_failures` 计数器。
- **缺少** `pr_observation_failures`（需从 `ci_observation_failures` 拆出 PR 观测失败）、`last_observed_at`、`last_known_pr_state` 列。
- `unknown_ticks`（`task_recovery` 表，runner 活性不可判计数）已持久化、跨重启累计，与 `ci_observation_failures` 已是两个独立列、互不扣减（`src/orchestrator/orchestrator.ts:37`、`:230-243`）。确认不互相清零即可，无需新建独立性。

### G3：通知层无 per-item 节流预算（§16.9）
- `src/notify/nudge.ts` 当前是"已通知 ID 集合"的扁平文件 diff，空→非空发一条聚合通知。
- **缺少** per-item 的 `urgency / expires_at / defer_until / risk_revision / last_notified_revision / threshold` 持久化预算。
- "同一卡片多轮 bump 只在超阈值后再提醒"的节流逻辑未实现。

### G4：审计指标是状态快照聚合，非事件间隔（§16.6）
- `src/cli/audit.ts` 只读 ledger 做状态快照聚合（pass rate、max awaiting、control 投影计数）。
- **缺少**从事件流算的间隔序列：`attention_required→decision_consumed`（人类等待）、`consumed→effect_observed`（落实延迟）、`recovery_outcome` 计数、`contract_revised` 归因、`work_redirected` 抖动。
- 缺任一端点不造值，应显示 `coverage/unknown`。

### G5（增强建议，非现有需求）：permission 内容审查与敏感度→channel 路由
- approval_gate 只按命令/路径 pattern 匹配，**无命令内容审查**（不读待执行脚本内容、不识别网络 egress）。
- `mgmt_artifacts.sensitivity` 字段已存在，但**未映射到决策卡分发渠道**——restricted 敏感工作的决策卡当前仍可被任意 channel（Feishu 等）投递。
- 此条来自 Jev 参考材料的 security-aware routing 启示，属增强建议，不在 HD 已批准范围内，需单独决策是否纳入。

---

## 3. 分阶段交付计划（轨道 A：HD M0–M4）

依赖链：M0a → M0b → M1 → (M2 ∥ M3) → M4。M0a→M0b 是严格依赖顺序，不是可漏告警上线的阶段。接口固定后 M2/M3 可并行。

### M0a：已确认缺陷修复与反向测试

**范围**
- G1 前半：orchestrator pollSubmitted 不丢弃 `result.effects`，回写决策卡 evidence 的 `confirmed_effects` / `pending_or_unknown_effects`（后端 evidence 写入，可经 SQL/API 断言；UI 分列留 M0b）。
- G2 前半：schema 补 `pr_observation_failures`（从 `ci_observation_failures` 拆出 PR 观测失败）、`last_observed_at`、`last_known_pr_state`。`unknown_ticks`（runner 活性计数）与 `ci_observation_failures` 已各自独立持久化，确认不互相清零即可。
- CI 异常选项语义补全：选项字符串 `recheck/manual-followup/abandon` 已在代码中（`orchestrator.ts:227`），需补 HD §16.4 尚未实现的语义——recheck 只重查不重跑 CI、不建后继任务；旧未消费目标关闭注册新版、旧答案不转新语义。
- 稳定事件键与审批事务（已落地，补回归）：outbox 同键异 payload 已 throw（`outbox.ts:40-45`）；applied_receipts 与任务迁移已同事务（`approval.ts:50`）；ledger `applied_control_events` 已存在。补崩溃注入、重复/乱序/同键异内容/spool 清除等回归测试，确认不回归为覆盖。
- pr.test.ts 正向断言（已存在，补回归）："observation failure is never treated as clean" 断言已在（`pr.test.ts:12-15`），确认不被误删。
- 顺手修复：`promoteWork` 调用 `emitWork` 时第 4 参 `{reason}` 被静默丢弃（`store.ts:351` 四参调三参函数），修正签名或 payload，使 `work.promoted` 事件含 reason。

**Owner**：Execution（orchestrator）+ Core（schema/projection）。
**依赖**：无。
**验收条件**
- gh 失败不返回 clean；push 成功 PR 失败如实卡片（后端 evidence 已写入 confirmed/pending，可经 SQL/API 断言）。
- PR 创建后丢响应 → push confirmed + pr_create unknown，不标 failed。
- CLI 占用出口存在、确认前 claim 被挡（supersession 正式启用后的完整恒 unreadable 留 M1）。
- 源事务后/发布后/ledger 提交后/确认前逐一崩溃：重复、乱序、同键异内容、spool 被清除均有明确结果；一项业务事件最多一次改变投影。
- `work.promoted` 事件 payload 含 reason。

### M0b：outbox 发布/投影/确认、源对账、效果及日志

**范围**
- G1 后半：UI 决策卡分列 `confirmed_effects` / `pending_or_unknown_effects`，不再合并为 verified/pending 二态。
- G2 后半：PR 观测失败持久化与有限重试；瞬时故障重试，权限/工具错误直接升级，耗尽显示 `pr_unobservable`；最后已知状态标过时。
- outbox 发布器：lease + 租约认领；按 retained_bytes 保留尾部；确认靠 ledger `applied_control_events` 回执删除；未确认记录不可因 spool 保留期被永久删除。
- 源对账：`applied_receipts(receipt_id UNIQUE)` 与结果 outbox 同事务；崩溃后凭 receipt 对账，不依赖再次 consume 返回答案。
- effect 对账：`reconcileEffectEvents` 读 ledger control_event effect_observed，按 toolCallId/attempt 匹配更新回执；outstanding receipt 超时 → unknown，不假装 applied。
- 事件发出（M4 指标前提）：消费即发 `decision_consumed`（Core `actOnAttention`，当前发 `attention.resolve`，需对齐 HD §16.6 词表或建映射）；恢复终态发 `recovery_outcome`（Execution）。

**Owner**：Core（outbox/projection）+ Execution（对账）+ Authorization（receipt effect）+ Surface（UI 分列）。
**依赖**：M0a 完整通过。
**验收条件**
- 发布前后崩溃不丢不重卡；unknown 不重放。
- 一项业务事件最多一次改变投影；只有真实未决项留在收件箱。
- 丢 tool_result / 宿主死亡 / 期限耗尽 → outstanding receipt 对账转 unknown；重启不自动重放。
- 人工 deny = 策略拦截成功，工具效果仍 not_started。

### M1：契约、证据版本、变更、停止、legacy

**范围**
- 契约字段完整落地：`objective / beneficiary / acceptance(check|artifact|human) / non_goals / scope / budget / stop_conditions / decision_owner`。
- 契约变更：承重目标/范围/验收/预算变化 → `reviseContract` 创建新版本，不覆盖；旧范围/证据的未消费批准失效；已消费批准不撤销已发生效果。
- 证据版本：`evidence_version` 纳入决策包；runner 证据按 attempt 记录，重试不覆盖旧证据。
- supersession 正式启用：契约 revision 在原 work_id 递增；先 `supersede_requested` + 禁止新动作 + 未消费目标失效；保持执行占用直到可核实自启 runner 已停止；有界升级出口（`confirm-stopped` / `keep-held`，human_only）。
- legacy 兼容：旧批准不扩大权限；不匹配自动提案失效；legacy 可观测跳转。
- 事件发出：停止条件触发发 `stop_condition_triggered`（Execution/Core，`recordStopCondition` 已存在，确认 enqueue 事件）。

**Owner**：Core（契约/supersession）+ Execution（占用释放）+ Surface（契约编辑 UI）。
**依赖**：M0(a+b) 完整。
**验收条件**
- 合并承重澄清；变更失效旧批准；改检查不能沿旧依据。
- check 通过但 human 条件未满足不完成。
- 恒 unreadable：期限内一个人工项、CLI 显示占用、确认前 claim 被挡、具名证据后放行、旧外部效果保留。
- legacy 可观测跳转。

### M2：分区、决策包、延期、提醒（可与 M3 并行）

**范围**
- G3 完整实现：通知改读 attention 投影，持久 `urgency / expires_at / defer_until / risk_revision / last_notified_revision / threshold`；跨越有效期阈值是可去重的变化，时间推进可触发一次通知。
- Now/Inbox/Done 投影语义：Now = 紧迫风险/即将失效/损失扩大；Inbox = 普通决策/最终验收/可批处理；Done = 已解决/被取代且无剩余动作。正在等人不自动紧急，默认 Inbox。
- 决策包完整载荷：`conclusion / trigger / impact / recommendation / options / owner / expires_at / source_link / contract_revision / evidence_version / effect_state`。
- 延期：`defer_until` 不停止等待计时、不延长批准有效期；到期回待处理；重大新风险可唤回。
- 排序：确定性可解释（扩大风险→临近失效→阻塞关键任务→普通等待），同级稳定；禁止黑盒紧急分。
- 事件发出：通知投递成功发 `notification_delivered`（Surface，含 item_id/revision/threshold，失败不记已送达）。

**Owner**：Surface（web/notify/CLI）+ Core（投影字段）。
**依赖**：M1（接口固定后与 M3 并行）。
**验收条件**
- 普通阻塞不紧急；无事实不重复；延期不延有效期。
- 风险唤回；浏览器回答冲突延期归档失败回流。
- 通知失败不更新已送达；缺通知能力显式显示。

### M3：策略优先级、预算、能力、候选规则（可与 M2 并行）

**范围**
- 三层授权：低成本可逆→已授权范围直接做；有边界自主→额度内做；必须人工→指定高风险/超预算/方向变更。按影响/范围/可逆性，而非命令名字。
- 策略优先级：有效性→明确禁止→必须人工→有效人工答案→明确自动授权→等待人。过期/证据不符人工也不能消费；策略变化不能撤销已发生副作用。
- human_only 消费复验：consumeDecision 消费时再次检查当前权威模式、策略和版本；只检查 matchingRule 不足以拦截。
- 预算执行：重试次数持久化；托管时间到期禁止新受控动作；不通过新 attempt/task 绕预算；人工扩预算记录原因新版本。
- 授权晋升：历史样本→精确候选→回放解释→人确认→先观察→人启用。不能由经常批准自动变永久权限。
- 事件发出：策略候选评估发 `policy_candidate_evaluated`（Authorization，含候选 ID/匹配样本/人确认状态）。

**Owner**：Authorization（decision-bot/extension）+ Execution（预算执行）。
**依赖**：M1（接口固定后与 M2 并行）。
**验收条件**
- 先有合法 bot 提案、再改 human_only、最后 consume → 不放行。
- 重启额度不重置；旧证据契约过期不消费。
- 人 bot 并发一次消费；未知成本不硬承诺；不 kill 外部进程。

### M4：候选池、变更影响、停止、audit

**范围**
- G4 完整实现：audit 从事件流算间隔序列（人类等待、落实延迟、阻塞占比、返工、抖动、可下沉比例、停止延迟、无效打断率、恢复成功率）；缺任一端点显示 coverage/unknown，不造值。
- **事件发出口径（M4 前置依赖）**：HD §16.6 词表与代码实际 kind 名需建映射，避免审计按字面名字查空：

  | HD §16.6 词表 | 代码实际 kind | 发出方 / 里程碑 |
  |---|---|---|
  | attention_required | attention.opened | Core（已有） |
  | decision_consumed | attention.resolve（需对齐或建映射） | Core / M0b |
  | effect_observed | effect_observed（经 extension spool） | Authorization（已有） |
  | recovery_outcome | （未发出，需新增） | Execution / M0b |
  | contract_revised | contract.revised | Core（已有） |
  | work_redirected | work.redirected | Core（已有） |
  | stop_condition_triggered | （recordStopCondition 已存在，确认 enqueue） | Execution/Core / M1 |
  | work_stopped | work.stopped | Core（已有） |
  | attention_feedback | attention.feedback | Core（已有） |
  | notification_delivered | （未发出，需新增） | Surface / M2 |
  | policy_candidate_evaluated | （未发出，需新增） | Authorization / M3 |

  在事件发出口径冻结前，M4 间隔指标只能交付 coverage/unknown 骨架，不能宣称算出恢复率/无效打断率。
- 候选池：仅一句话/来源/价值；默认不抢占不提醒，启动才补契约。
- 改向影响呈现：显示暂停/失效任务、已有交付、需要重做检查批准、已知成本耗时，未知写未知。
- 停止：取消未消费批准；禁止新 attempt；已授权流程停自启进程；保留产物/原因/未决外部效果；无剩余风险归档。
- audit 建议：重复操作可授权、验收频繁变更、停止条件已触发未决定——只经主动查看或 Inbox 摘要，不添通知。

**Owner**：Core（audit.ts）+ Surface（候选池 UI/CLI）+ Execution（停止执行）。
**依赖**：M2 + M3。
**验收条件**
- 候选不抢占；变更返工可归因；unknown 不归责。
- 规则不自启；停止保留外部效果证据。
- 先建基线（人工次数、等待/落实延迟、恢复成功率、无效打断、阅读跳转、自动清退），不捏造减少目标。

---

## 4. 关键设计决策

### 4.1 用户被阻塞 vs Agent 等待

- **活会话 blocked-on-ask（进程仍在跑）**：pi 扩展在 ask 工具里进程自身阻塞等待；Overload 只做遥测（decision_requested/resolved）与 jump 入口，**不重启**。`src/manage/handoff.ts` `blocked()` 把 pending ask / awaiting / blocked 判为 `blocked_on_ask`，禁止 handoff，正确做法是 `jump` 回原现场。
- **进程终止后的恢复**：受控 runner 走 orchestrator tasks 状态机 + attempts 预算；checkpoint 续跑依赖 session_reference / binding / checkpoint 字段。spawn 前先写 `task_recovery.spawn_state='intent'`，崩溃落在 intent/spawned 之间是结构性不确定，只能降级不能消除。
- **区分原则**：正在等人不自动紧急，默认 Inbox；applying 不重复提醒；失败/未知重开原项，不新建孤立卡片。

### 4.2 来源 / 版本 / 有效期 / 权限 / 冲突与失效

- **版本**：AttentionItem.revision（CAS）、Work.revision + contract_revisions（契约历史）、mgmt_artifact_versions.content_sha256 + manifest_entries 复合外键、事件 entity_version、approval_targets.targetVersion（含契约与策略版本）。
- **有效期**：gate 默认 24h 未答 → blocked(gate_expired)；attention item expires_at 可空；defer_until 不延长有效期；过期证据/契约的人工答案也不能消费。
- **权限**：decision_owner 字段；mgmt 写操作要求调用方 = decision_owner；artifact cat 是 owner 授权操作。
- **冲突检测**：所有变更版本 CAS；ControlError 四码 not_found/conflict/invalid/blocked → HTTP 404/409/400/409；事件同键异 payload = 完整性错误；manifest_drift → 409；workspace_contention → 409。
- **失效传播**：契约承重变更使未消费批准失效；manifest 任一 artifact 出新版本 → accepted 行写 invalidated_at + 相关未消费卡置 superseded；旧 CI 目标关闭注册新版，旧答案不转新语义。
- **源可用性三分**：unavailable（读不了）≠ 空 ≠ stale（超新鲜度阈值）；unavailable 永不触发删除或 vanished。

### 4.3 决策证据

- 决策包扩展：conclusion / trigger / impact / recommendation / owner / expires_at / source_link / contract_revision / evidence_version / effect_state。模型只整理建议，不改权限。证据大则给引用而非全文。
- runner 证据：按 attempt 记录检查命令、退出状态、版本、采集时间；权限/大小/保留期限制；敏感内容展示/入模前处理；不可信事件不能指定任意读取路径；重试不覆盖旧证据。
- PR 观测失败：持久 pr_observation_failures / last_observed_at / last_known_pr_state；观测失败分类用 unknown，不与副作用 effect_state=unknown 混淆；瞬时有限重试，耗尽显示 pr_unobservable。
- 两步 effect：push 与 pr_create 各自记录 not_started/applying/succeeded/failed/unknown + 证据 + 目标 commit/remote/branch/PR URL。gh 报错不能断言 PR 未创建；远端存在同名分支不能证明目标 commit 已推送，应比对 SHA。
- 采集边界：路径黑名单 → withheld_sensitive 只存 sha256+size；工具摘录先 scrub 再截断 ≤2KiB；URL 剥离 query 与 userinfo；单文件 >2MiB → too_large 只存哈希。

### 4.4 跨 channel 共享边界

- **权威状态在共享 control_attention**，channel 卡片只是投影。任何 channel 的决策答案都带 (item_id, revision) 回到同一份控制存储；channel_card_bindings.last_revision 驱动卡片刷新。
- **channel 是投递/回写表面，不持有决策状态**；owner 校验（conversation_owner_mismatch）和 revision CAS 保证跨 channel 不会并发覆盖。
- Feishu channel：daemon 走 lark SDK WebSocket 长连接，无公网入端口；授权按 app+instance+tenant+user+chat 联合匹配，不授权同用户在其他 chat；未知发送者回 access-denied。
- 关键隔离：native 确认只验证答案送达与 runtime 完成，不验证任意工具效果或业务验收；extension HTTP approval_gate 是另一协议，不得把 Feishu 上的 native 确认当成工具批准已送达；runtime input/editor 请求保持 unknown，不伪造答案。
- 共享内容边界：采集与共享是两个独立信任边界，默认全部不可分享；shareable=1 仅当 file 且人工标 clean，或 git_commit/external 仅导出引用+哈希；工具结果/assistant 文本/diff/dirty/runner.log 默认 shareable=0。
- **增强建议（G5，待决策）**：sensitivity 维度向分发渠道延伸——confirmed_secret 证据不进 Feishu 卡，只 loopback 可见。当前未实现，需单独决策是否纳入。

### 4.5 恢复与回流

- **三时刻分离**：answered / consumed / effect confirmed，第三步才算落实。消费前可在目标有效时再取答案；消费后无结果先 unknown 核查；部分效果从已确认步骤续，不从头重放。
- **结果回流**：完成/失败/决策后恢复结果必须回到原工作项，不再需要注意力时自动归档。失败和完成结果经 outbox 事件回写原项。
- **自动归档**：归档是真实状态转移（track_state='archived'），不是视图过滤；closeout 六谓词（全部执行 ended_* 且 ledger_full / 无 open 卡 / 无在途交接与提交 / 存在结果记录 / grace 已过）；file_only 永不自动归档，只能人工归档。
- **迟到事件**：归档后新活动自动 reopen 回 tracking，但不回滚 control_works.state——若已 completed 则保持，只在任务页顶部提示"已完成任务出现新活动"。
- **不承诺外部 exactly-once**：保证消费去重、步骤留痕、unknown 不盲重放。

### 4.6 失败处理

- **异常预算**：只对已识别瞬时故障有限自动恢复；预算耗尽后保留现场、明确失败分类、给出恢复动作；不无限重试、不静默失败、不要求用户从头重建上下文。
- **四重限界**：attempt 失败由 retry_budget 限；绑定等待由 BIND_TIMEOUT_TICKS（≈60s）限；活性不可判由持久化 unknown_ticks 限（跨重启累计）；spawn 不可核实由同一持久计数限。每条以带原因的 blocked 交人。
- **观测失败分类**：checkPr 区分成功无异常 / merged / 业务异常 / 观测失败；观测失败不返回 clean；瞬时有限重试，权限/工具问题直接动作，耗尽显示无法确认；最后已知状态标过时。
- **启动失败矩阵**：failed_no_effect 仅在能证明目标进程从未启动时使用、可自动重试；超时/崩溃/回执不可判一律 unknown、永不自动重试，且必须 reconcile-before-retry（先查 ledger/incarnation/jsonl/surface 四源，全部为否且源可用才允许人选择重启）。
- **源失败分类**：ledger 不可读 → 本轮跳过、unavailable、不归档；ledger 表 DROP → 立即开卡；单 jsonl 不可读 → 该执行 gapped、cursor 不推进、门禁拒绝；commit 后 kill -9 → 重启对账转 stored/lost，绝不留 pending 假装已存储。

---

## 5. 开发边界与所有权

IC 冻结的四 owner 边界，互不越界：

| Owner | 独占文件 | 职责 |
|---|---|---|
| **Core** | `src/control/{types,store,outbox,projection}.ts` + 测试/schema；`src/ingest/{ingest,reducer,schema.sql}`；`src/shared/types.ts`（仅加 event kind）；`src/cli/audit.ts` | 契约/注意力/outbox/projection 存储；事件摄入与投影；审计指标计算 |
| **Execution** | `src/orchestrator/*` 全部 | 任务状态机/租约/reconcile/submit/PR 观测；M0a/M0b、M1 supersession、M3 预算执行 |
| **Authorization** | `src/decision-bot/*` + `src/extension/overload.ts` | human_only 消费复验；receipt 效果观测；scoped 策略候选与安全晋升；approval_gate |
| **Surface** | `src/web/*`、`src/shared/queries.ts`、`src/notify/*`、`src/cli/overload.ts` | M1–M4 用户流程/CLI 与界面迁移；通知；决策卡呈现 |

**跨边界硬约束**
- 共享 API 必须逐字实现：`ensureControlSchema/openControl`、Contract/Work/AttentionItem 类型、`createWork/reviseContract/redirectWork/recordStopCondition/upsertAttention/getAttention/listAttention/actOnAttention/recordAttentionFeedback`、`ensureOutbox/enqueueControlEvent/publishControlEvents/applyControlEvent`、`reconcileEffectEvents`。
- 所有写操作须版本 CAS + 同事务 enqueue outbox 事件。
- Authorization 不允许 bot 自降 decision_mode；Surface 权威字段只来自可信 server/core，不按浏览器输入降级。
- orchestrator 只写 orchestrator.db/artifacts/worktrees/自己的 spool；ledger.db 只读；web/recon/ingest/notify/pull/shared 不得 import orchestrator（CI grep 守门）。
- `src/manage/*` 采集器任何 SQL 不得出现 `UPDATE control_works`（authority.test.ts 源级断言）。

---

## 6. 依赖与前置条件

**内部依赖**
- M0a → M0b → M1 → (M2 ∥ M3) → M4。
- M0b 的无损回流验收必须在 M0a 前提齐备后运行。
- M2/M3 接口固定后可并行，但共享 Core API 必须先冻结。
- **隐藏跨里程碑依赖**：M4 审计间隔指标的前提是 M0b/M1/M2/M3 各 owner 先把 HD §16.6 词表事件发进流（见 M4 映射表、U9）。Core 只算不发，事件未发出则 M4 指标永远 coverage/unknown。

**外部依赖**
- Bun runtime（项目已有）。
- SQLite（项目已有，WAL 模式）。
- macOS 通知（osascript）——当前仅支持 macOS，缺通知能力显式显示。
- pi/omp/Claude Code 扩展（可选集成）。
- Feishu lark SDK（可选 channel）。
- gh CLI（PR 观测与提交）。

**前置条件**
- 设计已 R3 APPROVE（仅设计放行），用户授权 M0–M4 开发，**未授权生产激活/deploy/push**。
- 集成工作区使用隔离 workspace，DISJOINT ownership；no commits, no checkout, no formatter/lint/build/tests during wave。
- 先建基线：人工次数、等待/落实延迟、恢复成功率、无效打断、阅读跳转、自动清退。不捏造减少目标。

---

## 7. 迁移策略

**轨道 A 八步（HD §13）**
1. 版本化 schema、备份、统一入口，不在 Web 请求散建表。
2. 先补身份、事件、outbox，不改行为，验证重放。
3. 确定关联才回填。
4. legacy 不强补契约，新增授权/预算/验收才要求字段。
5. 旧批准不扩大权限，不匹配自动提案失效。
6. UI/通知同时切新投影避免双提醒。
7. 删旧派生双写、保留历史；ack≠answer、closeout≠验收。
8. 数据级回退；新强制策略启用后旧程序不理解则拒启，不能降级绕过；回退先停执行受控迁移。

**orchestrator 侧（REC §6）**
- `task_recovery` 用 `CREATE TABLE IF NOT EXISTS`，旧库下次启动自动获得、无 ALTER、无回填。
- 旧库无恢复行但 runner_pid/stable_id 非空的任务一律按 intent 保守处理（不 spawn）。

**control DB v1→v2（MGMT §12.5，如涉及纳管）**
- 纯追加（只 CREATE TABLE/INDEX，不 ALTER）；`PRAGMA foreign_keys=ON` 全局开。
- 部署顺序：停全部写者 → VACUUM INTO 备份 → 一次性升级全部二进制 → 启动任一 v2 进程自动迁移 → 最后开 manage.enabled。
- v1 旧二进制打开 v2 库会被拒（兼容窗口为零），不是静默降级。
- 常规回滚 = 功能回滚（manage.enabled=false 保留 v2 表），无 down migration。

---

## 8. 安全边界

- **定性**：gate 是工作流边界，不是安全边界——同 UID 机器上任何同 UID 进程可 curl loopback、可直写 answers，Overload 无机制阻止；不做 sandbox/降权用户。
- **具体措施**：保持 loopback + CSRF（POST 要求 Host + Origin 双匹配；GET /api/* 同样校验 Host 防 DNS rebinding）；不暴露无认证控制面；自动授权默认关、新规则显式启用；human_only 不给 bot；源输入不可信；模型不能改策略/凭据/直接副作用；runtime input/editor 请求保持 unknown 不伪造答案。
- **跨 host 防护**：reducer 中 detail.stable_id 首段 host ≠ 事件 host 时回落事件自身 stable_id 并记 coverage_gaps——防远端伪造本机会话 vanished/Now 卡。
- **伪造防护**：答复端拒绝 approval_id 在自有 approvals 无行的答复；记 actor ∈ {ui, cli}；accept 后爆炸半径 = 向 bot 分支 push + 一个待人合并的 PR，合并永远需人在 GitHub 动手，无 auto-merge。
- **共享侧**：默认不可分享 + 导出白名单拼装；artifact cat 要求 owner。
- **channel 侧**：未知发送者 access-denied；授权五元组联合匹配。

---

## 9. Jev 参考材料的启示

> 材料性质：`docs/research/jev-reference/` 是对 Diogo Almeida（TypeSafe）设计笔记的独立整理稿，2026-09，非 TypeSafe 官方论文。其中 token 占比（Table III）、路由算例（§II.A，4.15 vs 6.19）、模型单价均为示意估算，非实测；仅 fastcontext 的 56.2%/46.5% 为转引第三方项目报告。

Jev 与 Overload 共享同一个底层判断：**上下文（=人/系统的注意力）必须被组装而非堆积**。Overload 的对应物是注意力项的原地更新、证据引用化、投影与权威分离。

**可借鉴点（两个）**
1. **sensitivity 维度向分发渠道延伸**：Jev 按文件敏感度选模型/通道；Overload 可把 mgmt_artifacts.sensitivity 复用到决策卡内容分发渠道——confirmed_secret 证据不进 Feishu 卡，只 loopback 可见。属增强建议（G5），非现有需求，需单独决策。
2. **后台派生任务共享单次投影检索**：Jev 强调只读后台任务共享一次"相关信息检索"；Overload 目前 notify/audit/outbox 投影已是"一次投影、多方只读消费"，但 recon/pull 仍各自独立扫库，合并共享一次 relevant-change 检索是剩余优化空间。

**不适用**
- 模型间路由计价、缓存经济、工具 schema 分层属 coding agent runtime 内部事务，Overload 不做。
- Jev 的概率化 noul 决策（输出带概率）与 Overload 的确定性排序原则（HD §6 禁止黑盒紧急分）**直接冲突，不采纳**。
- Jev 的 heatmap/grep 过滤是 agent 内检索问题，不进控制面。

---

## 10. 未决问题与风险

| # | 问题 | 影响 | 建议处理 |
|---|---|---|---|
| U1 | G5（permission 内容审查 + sensitivity→channel 路由）是否纳入本方案 | 超出 HD 已批准范围，属增强建议 | 单独决策；如纳入，追加 M3 子任务并更新验收 |
| U2 | 三条 M 编号轨道（HD/ORCH/MGMT）的排期协调 | 同名不同物，排期时易混淆 | 所有排期文档带轨道前缀；本方案仅覆盖轨道 A |
| U3 | UXP 视觉方案仍受 Fable 版本兼容阻塞 | M2/M4 的 UI 呈现可能受限 | 功能先行，视觉重做待 Fable 兼容后单独排期 |
| U4 | CI 真实重跑能力不在此次最小范围 | recheck 只承诺重新查询状态，不承诺重跑 CI | 未来须绑定 run_id、重跑预算和副作用凭据另行设计 |
| U5 | 旧库数据回填范围 | legacy 不强补契约，但关联关系需确定才回填 | M1 阶段确定关联后回填，不确定的标 unknown |
| U6 | 通知能力仅支持 macOS | Linux 目标需单独验收 | 如目标改 Linux，运行/通知需单独验收项 |
| U7 | 参考材料（Jev）中的估算数据不能作为 Overload 实测基线 | 方案中引用时必须标注"示意估算，非实测" | 已在 §9 声明；所有引用处保持标注 |
| U8 | 生产激活未授权 | 开发完成后不能直接上线 | 用户授权 M0–M4 开发，未授权生产激活/deploy/push；激活需单独审批 |
| U9 | HD §16.6 词表中 recovery_outcome / notification_delivered / stop_condition_triggered / policy_candidate_evaluated 尚未发出，decision_consumed 与代码 attention.resolve 不对齐 | M4 间隔指标长期 coverage/unknown，无法算出恢复率/无效打断率 | 各 owner 在对应里程碑补 enqueue（见 M4 映射表）；口径冻结前 M4 只交付骨架 |

---

## 11. 验收总表

| 里程碑 | 核心验收场景 | 对应差距 |
|---|---|---|
| M0a | gh 失败不 clean；push 成功 PR 失败如实卡片；CI 选项迁移；审批事务崩溃注入 | G1 前半、G2 前半 |
| M0b | 发布前后崩溃不丢不重卡；unknown 不重放；effect 对账超时转 unknown；UI 分列 confirmed/pending effects | G1 后半、G2 后半 |
| M1 | 变更失效旧批准；改检查不能沿旧依据；supersession 占用释放有界升级；legacy 可观测跳转 | — |
| M2 | 普通阻塞不紧急；延期不延有效期；风险唤回；通知节流预算；归档失败回流 | G3 |
| M3 | human_only bot 不消费；重启额度不重置；旧证据过期不消费；不 kill 外部进程 | — |
| M4 | 候选不抢占；变更返工可归因；audit 事件间隔指标；停止保留外部效果证据 | G4 |

**总体验证（HD §15）**
- 真实场景：正常执行不巡视；Ask 支持则答否则跳转；人 bot 竞争一次消费；契约变化旧授权无效；消费后崩溃 unknown；PR 服务不可用有限恢复升级；延期保留期限代价；完成原项清退；预算不绕过；重启重放状态不丢。
- 关键边界留回归；真实 CLI/SQLite/spool 完整链路；临时仓库验证提交部分失败，不碰生产；实际浏览器流程；外部故障可控注入；集成后全套测试。
- 先建基线，不捏造减少目标；先证明不漏承重事项、不误放行、不增加噪声。

---

*本方案基于 2026-09-22 代码只读核查与设计文档综合。所有已有能力标注均有代码位置支撑；所有待建能力均来自已批准设计（HD §1–§16）或明确标注为增强建议（G5）。参考材料 Jev 为独立整理稿，算例为示意估算。*
