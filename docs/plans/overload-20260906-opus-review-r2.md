**REQUEST_CHANGES**（接近放行，仅一项真阻塞）

### 已解除的八项

P0-1：§16.1 正面否掉我原修法（emit 每次分新 seq，UNIQUE(host,emitter_id,seq) 不按业务键去重），改用 `producer_id+entity_id+entity_version+event_kind` 与 ledger `applied_control_events`，同键异 payload 判完整性错误；published_at ≠ delivered_at、发布器只读 ledger 判确认、不新增反向通道，比我提的方案更严。跨库消费补 `applied_receipts` 凭 receipt 对账、不依赖再次 consume，解除。

P0-2：删除反向断言、`unknown` 与 `effect_state=unknown` 分离、预算独立于 runner `unknown_ticks`、时钟注入，解除。

P0-3：拒绝我的 `pushed:boolean`（不可知不能压成布尔）、指出 `ls-remote` 分支存在不证明目标 commit 已推送需比对 SHA，正确且更强，解除。

P0-4：拒绝清空 `pr_url`（`submitTask` 只会发现现有 PR，不重跑 CI）与自动 `addTask`（复制错误目标与预算），改选项语义为 recheck/manual-followup/abandon、异常指纹不变不新建项，解除。

P1-1：拒绝放行前 `markReceipt(applied)`（重犯 answered=effect），改 applying→真实 `tool_result`→`effect_observed`，解除。P1-2 指标端点固定 ledger 且缺端点不造值，解除。P1-4 消费时复验权威模式并含「先合法提案后改 human_only」用例，解除。P1-5 澄清是改造而非已实现、ack 另存 `acknowledged_at`，解除。

P1-3：拒绝旧任务直接 `blocked` 释放 repo 锁——活 runner 仍可写工作区、旧 submitted PR 仍有外部效果——正确；`supersede_requested` 先禁新动作、核实 runner 停止后才释放占用，且失效用 `closed/invalidation_reason` 而非伪写 `consumed_at`/`actor='superseded'`（否则账本把失效当人已回答），比我原方案正确，此点解除。

### 唯一剩余阻塞

**B-1（源自 P1-3 的新引入死锁，§16.7 与 §16.10 冲突）**

§16.7 要求：无法核实 runner 已停止则**保持占用并升级**，且不得以 owner lease 过期等同进程死亡。这条本身正确，但与 `schema.sql:14-16` 的 `tasks_repo_active` 唯一索引叠加后，产生无出口状态：`probeRunnerLiveness` 返回 `unreadable`（ledger 不可读）或 `absent` 时，永远无法核实停止，repo 活跃锁被无限期持有，该 repo 上**任何**新 attempt 都无法 `claim`——包括为解决此事而派的工。而 §16.10 把「审批事务与稳定事件键」放在 M0a、outbox 发布与对账放在 M0b，意味着 M0a 落地后、M0b 之前，升级路径本身依赖尚未建成的投影，升级只能落到日志。

这违反 AGENTS.md「异常必须有预算」与「不得无限重试、静默失败」，也与 §9「硬停止条件在受控边界停新动作」的有界语义不符。

**最小修正（仅改方案文本）**：§16.7 补一句有界升级：核实不能达成时，`supersede_requested` 在有限时限内转为**显式人类决策项**（选项至少为「确认 runner 已停止并释放占用」「保持占用继续等待」），该项本身即是升级出口；并写明该决策项在 M0a 阶段以现有 approvals 门承载，不依赖 M0b 的 attention 投影。占用释放只由人的显式确认或可核实停止触发，二者皆无则该 repo 明确显示为「被 <work_id> 占用，等待人确认」，而非静默不可用。

**验收**：令 `probeRunnerLiveness` 恒返回 `unreadable` → 提交契约新 revision → 断言旧 work 进入 `supersede_requested` 且不接受新动作；断言在时限内生成一条 human 决策项而非仅日志；断言在人确认前新任务 `claim` 失败且 UI/CLI 显示占用原因与责任人；断言人确认后新 attempt 成功 `claim`，且旧 work 的未决外部效果证据被保留。

补上此段即可 APPROVE（设计放行，不含实现验证）。