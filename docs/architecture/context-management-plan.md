# Overload 上下文管理专项开发方案

- 日期：2026-09-22
- 性质：设计方案，本轮只写方案、不实现、不激活。
- 设计内核：Jev 参考材料的显式类型状态、上下文按问题装配而非堆积、visibility ladder（hide/short/long/full）、按需取源、tiered disclosure。
- 基线引用：代码核查（本地审计稿 overload-code-audit-20260922，未入库）；需求综合 `docs/history/plans/requirements-synthesis-20260922.md`；Jev 参考 `docs/research/jev-reference/README.md`（独立整理稿，非权威论文；token 占比/路由算例为示意估算非实测）；产品原则 `AGENTS.md`；核心设计 `docs/architecture/human-decision-design.md`（仅作现有能力参考，不作为本方案范围约束）。

---

## 0. 本方案要解决什么

Overload 的注意力控制面（Work / AttentionItem / Contract / outbox / handoff）已经能把 Agent 运行噪声压缩为决策卡。但目前"上下文"是散落在多处的隐式状态：契约在 `control_works.contract`，证据在 `AttentionItem.evidence`（自由 Record），产物在 `mgmt_artifacts`，现场在 `mgmt_session_binding` / orchestrator tasks。这些对象之间没有统一的类型体系、版本语义、可见性策略和失效传播。

结果：
- 决策卡要给人看什么证据，靠 UI 开发者手工拼 `evidence` JSON，没有"按问题装配"机制；
- Agent 任务输入包（orchestrator 拉起一个子任务时喂什么）目前是空白——runner 拿到 task_id 后自己查库，没有显式装配；
- 恢复输入包（进程崩溃后续跑）散落在 `task_recovery`、`submit_result`、`approval` 多处，没有一个聚合包；
- 一个事实变了（如 PR 状态更新、测试结果重跑），哪些决策卡失效、哪些 Agent 输入过期，靠 `invalidateAcceptances` 等局部规则，没有统一传播。

本方案把上下文（工作目标、约束、事实、决策、产物、现场）作为**显式类型对象**纳入 Overload，设计其管理机制：对象模型、选择与投影、失效传播、跨问题共享、与现有代码的集成。

---

## 1. 概念区分

### 1.1 "问题空间 channel" vs "投递 channel"

| | 问题空间 channel（problem channel / branch） | 投递 channel（delivery channel） |
|---|---|---|
| 是什么 | 一个用户问题被分解为多个子问题/子任务后，在**问题空间**形成的分支。父问题 → 子问题 A、子问题 B…… | 通知/交互的**投递渠道**：loopback Web、Feishu、CLI、macOS 系统通知等。 |
| 代码对应 | 本方案新增的 `control_context_problems` 树（见 §2、§5）。 | 现有 `src/adapters/*`（ChannelAdapter、feishu.ts、pi.ts）。 |
| 生命周期 | 随问题分解产生，随问题解决收敛。 | 随运行时存在，与问题结构无关。 |
| 跨 channel 共享 | 子问题继承父问题的上下文引用（显式 shareable 标记 + 引用，非隐式复制）。 | 决策权威状态在共享 DB，channel 卡片只是投影；答案带 (item_id, revision) 回到同一份控制存储。 |

**全文用词纪律**：
- "分解为子问题/分支"→ 问题空间 channel，用 `problem_id` / `parent_problem_id`。
- "投递到 Feishu / loopback / CLI"→ 投递 channel，用 `channel_kind` / `channel_instance`。
- 不允许出现"channel A 分解了子任务 B"这种混写。

### 1.2 用户需要决策 × 目标推进阻塞（两轴独立）

这两个维度**互相独立**，不是二选一。

**轴 1：是否存在需要人做出的未决决策（user_needs_decision）**
- true = 存在需要人做出的决策（验收、方向选择、风险确认、工具批准），不只是等人输入。
- false = 没有需要人决策的事项。
- 注意：user_needs_decision=true 但 goal_blocked=false 是可能的——人可以稍后决策，Agent 先做其他不依赖该决策的子任务。

**轴 2：目标推进是否被阻塞（goal_blocked）**
- blocked = 目标推进被阻塞（被人决策阻塞、被前置依赖阻塞、被资源阻塞）。
- not_blocked = 目标可继续推进。

**轴 3：Agent 运行状态（runtime state）**
- live = 进程在跑（含 blocked-on-ask 等工具输入，也含后台等工具/跑命令）。
- terminated = 进程确认终止（分 success / failure / unknown 三种结局）。
- unknown = 活性不可判（liveness unknown）。
- queued = 新排队任务，尚未启动（可能在等前置决策完成才能开始）。

| | live | terminated | unknown | queued |
|---|---|---|---|---|
| **user_needs_decision=true, goal_blocked=true** | blocked-on-ask：jump 回原现场，不重启 | 恢复输入包（三条件同时满足时，见下）；或失败/unknown 结局需人介入 | 先对账四源（ledger/incarnation/jsonl/surface），不 spawn 不恢复 | 等前置决策完成后调度 |
| **user_needs_decision=true, goal_blocked=false** | 后台执行，决策进 Inbox 不打断 | 决策进 Inbox，Agent 可先做其他子任务 | 对账后交人决策 | 等前置决策 |
| **user_needs_decision=false, goal_blocked=true** | 后台等资源/依赖，不打断 | failure/unknown 结局需人介入（不能直接归档） | 对账 | 正常调度 |
| **user_needs_decision=false, goal_blocked=false** | 后台执行，不打断 | success → 结果回流，自动归档 | 对账后归档 | 正常调度启动 |

**关键纪律**：
- 恢复输入包只在 **terminated + checkpoint 有效 + runner 支持恢复** 三者同时满足时才装配。
- terminated 不等于归档：success 才自动归档；failure / unknown 结局需人介入或对账后再决定。
- liveness unknown 时先对账（查 ledger / incarnation / jsonl / surface 四源），不 spawn、不恢复。
- queued 可能在等上游人决策完成才能开始，不是"不适用"。
- live + goal_blocked（blocked-on-ask）时 jump 原现场（`shared/jump.ts`），**不用恢复包**——进程还在，跳过去就是原现场。
- 误判风险：把 live 判成 terminated → 重启 → 两个进程竞争同一工作区；把 terminated 判成 live → 人点 jump 但进程早已死 → 跳转失败。判定入口是 `manage/handoff.ts` 的 `blocked_on_ask` / `liveness_unknown` 分类。

---

## 2. 上下文对象模型与持久化

### 2.1 六类上下文对象

| 类型 | ctype | 语义 | 示例 | 权威源 |
|---|---|---|---|---|
| 工作目标 | `objective` | 任务要达成什么 | "把 parseConfig 重构为纯函数并补单测" | `control_works.contract.objective` |
| 约束 | `constraints` | non_goals、scope、budget、stop_conditions、权限边界 | "不改公共 API 签名"；retry_limit=3 | `control_works.contract` 的 scope/budget/stop_conditions 子段 |
| 事实 | `fact`（带 fact_subtype） | 代码状态、测试结果、外部系统状态、观测证据 | "test_parseConfig 退出码=0" | 采集端持久存储：ledger effect_observed 事件、orchestrator submit_result / runner_invocations、pr.ts 观测 |
| 决策 | `decision` | 人或 Agent 做出的决策记录 | "人接受公共 API 变更" | `control_attention`（人答）+ decision-bot mailbox |
| 产物 | `artifact` | 代码 diff、文件、PR、文档 | "PR #42 diff" | `mgmt_artifacts` + `mgmt_artifact_versions` |
| 现场 | `scene` | session_reference、binding、checkpoint、对话历史位置 | "pi session stable_id=abc, turn=42" | `mgmt_session_binding`、orchestrator tasks（runner_pid/stable_id/checkpoint） |

`fact` 的子类型（`fact_subtype`）：
- `code_state`：代码状态（git HEAD、文件内容哈希）。
- `test_result`：测试/检查退出码。
- `external_state`：外部系统状态（PR checks、远端分支）。
- `observation_evidence`：观测证据（grep 命中、CI 日志摘要、tool_result）。

### 2.2 每个上下文对象的七项强制属性

1. **权威源（authoritative source）**：谁是这个事实的 owner，从哪里取。facts 的权威源是持久存储（ledger 事件、orchestrator submit_result），不是 runner 内存 map。
2. **引用（reference/handle）**：不复制全文，用已注册的权威源 handle，不是裸文件路径。格式：`journal:<seq>` / `orchestrator:submit_result:<attempt_id>` / `git:<repo>@sha` / `artifact:<artifact_id>@<version_id>`。
3. **版本（revision）**：CAS 递增。变更创建新版本，不覆盖旧版本。
4. **权限（sensitivity）**：`unknown / clean / suspected / confirmed_secret` 四档。`shareable` 默认 0；`confirmed_secret` 默认不可跨工作共享。
5. **有效期（expires_at / staleness_ms）**：facts 带 collected_at + staleness_ms；过期标 stale 不删除。
6. **派生来源（derived_from）**：JSON 数组，引用列表，派生链可追溯。
7. **冲突检测**：见 §4.4——stale（同源新版）≠ conflict（多源矛盾）。

### 2.3 完整 DDL

```sql
-- ========== 上下文对象池 ==========
-- 注意：所有外键需 PRAGMA foreign_keys=ON 生效（连接启动时设置）。
-- 建表顺序按外键依赖排列：problems（自引用）→ objects → versions → problem_objects → pins → shares。

-- 问题树先建（objects.primary_problem_id 和 problem_objects 引用它）
CREATE TABLE IF NOT EXISTS control_context_problems (
  problem_id         TEXT PRIMARY KEY,              -- sha256(work_id + parent_problem_id + title)[:32]
  work_id            TEXT NOT NULL,
  parent_problem_id  TEXT,                          -- 可空=根问题
  root_problem_id    TEXT NOT NULL,
  title              TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','superseded')),
  revision           INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  CHECK (parent_problem_id IS NULL OR parent_problem_id != problem_id),
  FOREIGN KEY (parent_problem_id) REFERENCES control_context_problems(problem_id)
);

CREATE INDEX IF NOT EXISTS idx_context_problems_work ON control_context_problems(work_id, root_problem_id);

CREATE TABLE IF NOT EXISTS control_context_objects (
  object_id              TEXT PRIMARY KEY,          -- sha256(work_id + ctype + canonical_key)[:32]
  work_id                TEXT NOT NULL,
  primary_problem_id     TEXT,                      -- 主归属问题（可空）；多引用走 control_context_problem_objects
  ctype                  TEXT NOT NULL CHECK (ctype IN ('objective','constraints','fact','decision','artifact','scene')),
  fact_subtype           TEXT CHECK (fact_subtype IS NULL OR fact_subtype IN ('code_state','test_result','external_state','observation_evidence')),
  revision               INTEGER NOT NULL DEFAULT 1,
  purged_at              TEXT,                      -- 正文已清除时间戳（ISO8601）；非空时仅保留 content_hash + 元数据
  tombstone_reason       TEXT,                      -- 清除原因：expired/revoked/retention_policy
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK (ctype != 'fact' OR fact_subtype IS NOT NULL),
  CHECK (ctype = 'fact' OR fact_subtype IS NULL),
  CHECK (purged_at IS NULL OR tombstone_reason IS NOT NULL),
  FOREIGN KEY (primary_problem_id) REFERENCES control_context_problems(problem_id)
);

CREATE TABLE IF NOT EXISTS control_context_object_versions (
  object_id              TEXT NOT NULL,
  revision               INTEGER NOT NULL,
  reference              TEXT NOT NULL,             -- 权威源 handle（每版独立）
  source_type            TEXT NOT NULL,             -- 'contract'|'attention'|'artifact'|'ledger_event'|'orchestrator'|'extension'
  sensitivity            TEXT NOT NULL DEFAULT 'unknown' CHECK (sensitivity IN ('unknown','clean','suspected','confirmed_secret')),
  shareable              INTEGER NOT NULL DEFAULT 0,
  expires_at             INTEGER,
  staleness_ms           INTEGER,
  collected_at           INTEGER,
  derived_from           TEXT,                      -- JSON 数组
  summary_short          TEXT,
  summary_long           TEXT,
  content_hash           TEXT NOT NULL,             -- 权威源内容哈希（非摘要哈希）
  created_at             INTEGER NOT NULL,
  PRIMARY KEY (object_id, revision),
  FOREIGN KEY (object_id) REFERENCES control_context_objects(object_id)
);

-- 问题-对象多对多关联（一个对象可被多个兄弟问题引用；记录关联时的版本，不取 latest）
CREATE TABLE IF NOT EXISTS control_context_problem_objects (
  problem_id         TEXT NOT NULL,
  object_id          TEXT NOT NULL,
  revision           INTEGER NOT NULL,                 -- 关联时锁定的版本，不因对象出新版而漂移
  role               TEXT NOT NULL,                 -- 'objective'|'constraints'|'fact'|'decision'|'artifact'|'scene'
  created_at         INTEGER NOT NULL,
  PRIMARY KEY (problem_id, object_id, role),
  FOREIGN KEY (problem_id) REFERENCES control_context_problems(problem_id),
  FOREIGN KEY (object_id, revision) REFERENCES control_context_object_versions(object_id, revision)
);

-- ========== pin ==========

CREATE TABLE IF NOT EXISTS control_context_pins (
  pin_id             TEXT PRIMARY KEY,
  object_id          TEXT NOT NULL,
  revision           INTEGER NOT NULL,                  -- pin 住的版本
  pinned_by          TEXT NOT NULL,
  purpose            TEXT NOT NULL CHECK (purpose IN ('decision_evidence','recovery_checkpoint','other')),
  expires_at         INTEGER,
  created_at         INTEGER NOT NULL,
  FOREIGN KEY (object_id, revision) REFERENCES control_context_object_versions(object_id, revision)
);

-- ========== 跨工作共享 ==========

CREATE TABLE IF NOT EXISTS control_context_shares (
  share_id           TEXT PRIMARY KEY,
  object_id          TEXT NOT NULL,
  revision           INTEGER NOT NULL,                 -- 分享限定版本，不能取 latest
  shared_with_work   TEXT NOT NULL,
  granted_by         TEXT NOT NULL,
  granted_at         INTEGER NOT NULL,
  UNIQUE (object_id, revision, shared_with_work),
  FOREIGN KEY (object_id, revision) REFERENCES control_context_object_versions(object_id, revision)
);
```

**迁移验证**：全部 `CREATE TABLE IF NOT EXISTS`，旧库下次启动自动获得新表，旧表不 ALTER。迁移后断言：(1) 六张新表存在（objects / object_versions / problems / problem_objects / pins / shares）；(2) `control_works` / `control_attention` / `mgmt_artifacts` 行数和 schema 不变；(3) 自引用外键可建（插入父子节点成功）；(4) CHECK 约束生效（插入 ctype='test_result' 到 objects 表被拒绝，因为 ctype 枚举不含 test_result）；(5) problem_objects 和 shares 的复合外键生效（插入不存在的 object_id+revision 被拒绝）。

**应用层校验**（跨 work 父子一致性与环检测为设计选择——使用应用事务校验，在 `createProblem` / `linkProblemObject` 的事务内做递归环检测和 work_id 一致性断言，而非数据库触发器）：
- `root_problem_id` 与 `work_id` 一致性：创建子问题时断言 `parent.root_problem_id == child.root_problem_id` 且 `parent.work_id == child.work_id`。
- 问题树不允许跨 work：子问题的 work_id 必须等于根问题的 work_id。
- **parent 不可变**：问题节点创建后 `parent_problem_id` 不可 UPDATE，只能 superseded 后重建。
- **环检测**：创建/关联时用 `WITH RECURSIVE` 向上遍历 parent 链，断言新 parent 不在当前节点的后代中（无环）。
- `shareable` 与 sensitivity 一致：`confirmed_secret` 对象 shareable 必须为 0。
- 对应测试：插入合法父子边通过；插入跨 work 子问题拒绝；插入环（A→B→A）拒绝；尝试 UPDATE parent_problem_id 拒绝。

### 2.4 schema 迁移与回退

- 纯追加，不 ALTER 现有表。
- **旧二进制回退**：如果新表承担权限门禁（context 权限校验），旧二进制打开含新表的 DB 时必须拒绝执行。由启动器门禁（launcher 检查 schema_version 兼容性后才启动二进制）——旧二进制检测到 DB schema_version 高于自身支持版本 → refuse to start，不能静默降级绕过门禁。不承诺二进制自检。
- 功能回退：`context.assembly_enabled=false` 时新表保留数据但装配器不读不写；但权限门禁一旦上线，不能靠配置开关关闭。

---

## 3. 三种按问题装配的上下文包

同一个上下文对象池，按消费者问题不同装配出三种包。**装配 = 权限预检 → 从对象池选对象 → 按 visibility ladder 投影 → 按需取源**。

### 3.1 人类决策视图包（decision card payload）

**消费者身份**：`consumer_type='decision_ui'`，`consumer_id=attention_item_id`。

这是现有 `AttentionItem` 的扩展。AttentionItem 已有字段（`src/control/types.ts`）：conclusion、trigger、impact、recommendation、options、owner、expires_at、defer_until、acknowledged_at、source_link、contract_revision、effect_state、decision_mode、evidence（自由 Record）。这些**复用**。本方案新增的是 evidence 的结构化投影和场景入口。

**装配规则**：
1. 权限预检（§4.2）：actor 必须是该 work 的 decision_owner 或显式共享方。无权限直接返回 blocked，不给摘要。
2. 从 `control_attention` 取 item 权威行（复用现有字段）。
3. 按 `work_id + problem_id` 从上下文池捞出相关对象：facts（触发原因证据）、decisions（前置决策）、artifacts（产物引用）、scene（现场入口）。
4. 按 visibility ladder 投影。
5. 必需字段不可被排序或预算抹掉；如果必需字段因权限/源不可用无法获取 → 返回 `blocked(reason=needs_context)`，不执行不占位继续。

**必需字段**：

| 字段 | 状态 | 说明 |
|---|---|---|
| 一句话结论 | 复用 AttentionItem.conclusion | "要决定什么" |
| 触发原因 + 关键证据引用 | 新增（从 context-pool facts 投影） | 为什么现在问 |
| 不处理的影响 | 复用 AttentionItem.impact | |
| 建议动作 / 结构化选项 | 复用 AttentionItem.options + recommendation | |
| 唯一责任人与时效 | 复用 owner + expires_at | |
| 现场入口 | 新增（从 scene 对象投影 → jump target / source_link） | 一步回到原现场 |
| 决策后续跑状态 | 复用 effect_state + contract_revision | |

**visibility 默认级别**：conclusion/trigger/options/owner/expires_at = long；evidence 明细 = short（摘要+引用），人展开才 long/full；scene 入口 = short。

**大小预算**：目标 ≤ 2KiB 渲染文本。超出时降级 evidence 到 short，标 `budget_limited`。

### 3.2 Agent 任务输入包（agent task context）

**消费者身份**：`consumer_type='agent_task'`，`consumer_id=task_id`。

这是 orchestrator 拉起 runner 时喂给 Agent 的输入。

**装配规则**：
1. 权限预检：actor=orchestrator，work_id + task_id 匹配。
2. 按任务 scope 条件装配：scope 决定哪些 constraints/facts 相关（类似 Jev conditional instructions）。
3. 从上下文池捞 objective、constraints、facts 引用、decisions 引用、artifacts 引用、scene 恢复点。
4. **硬约束结构化注入**：budget 上限、stop_conditions、权限边界、scope 作为结构化字段注入 agent 启动参数/系统提示，不只给链接。对支持扩展协议的 runtime（pi）可逐轮注入；对不支持的 runtime，只在交接点传递。

**必需字段**：

| 字段 | 说明 |
|---|---|
| objective 引用 | 任务目标（指向 contract_revision） |
| constraints 结构化字段 | non_goals / scope / budget / stop_conditions / human_only_effects——直接注入系统提示 |
| 相关 facts 引用列表 | 代码状态、测试结果——带版本和有效期 |
| 已有 decisions 引用列表 | 前置决策 + owner + 依据版本 |
| artifacts 位置引用 | 产物在哪，content_hash |
| 现场恢复点 | session_reference / binding / checkpoint（checkpoint_reference 仅恢复场景必填，新任务可空） |

**visibility 默认级别**：objective/constraints = long（结构化注入）；facts = short；decisions = short；artifacts = reference；scene = long。

**大小预算**：≤ 8KiB 结构化文本。

### 3.3 恢复输入包（recovery context）

**消费者身份**：`consumer_type='recovery'`，`consumer_id=attempt_id`。

**触发条件**：runtime state = terminated + checkpoint 有效 + runner 支持恢复。活会话（live + user-blocked）不用此包——jump 回原现场（§1.2）。liveness unknown 先对账，不恢复。

**装配规则**：
1. 输入必须含 `work_id + attempt_id + checkpoint_reference`（不能只靠 problem_id）。
2. 从 orchestrator task_recovery + submit_result + approval + outstanding receipts 聚合。
3. 区分四类：已确认效果、未完成步骤、unknown 项、binding + checkpoint。
4. **入口复验**：恢复前必须同步复验当前安全约束（§4.2）：权限是否被撤销、约束是否变更、证据是否过期。复验失败 → 拒绝恢复，标 `stale_or_revoked`。

**必需字段**：

| 字段 | 说明 |
|---|---|
| checkpoint_reference | 进程终止前最后的 checkpoint 位置 |
| work_id + attempt_id | 定位恢复目标 |
| session_reference + binding | stable_id → work_id 绑定 |
| 已确认效果列表 | push/pr/write 已核实效果，带 ledger 事件引用 |
| 未完成步骤列表 | checkpoint 往后哪些步骤没做 |
| unknown 项列表 | 如实列出，不重放 |
| 恢复预算状态 | attempts、unknown_ticks、retry_budget 剩余 |
| 恢复动作建议 | "从 step 5 续跑" / "先对账" / "预算耗尽交人" |

**visibility 默认级别**：全部 long（恢复必须完整）。不设硬截断。

---

## 4. 选择与投影：visibility ladder

### 4.1 四级可见性

| 级别 | 语义 | 存什么 |
|---|---|---|
| **hide** | 不出现 | 对象仍在池里，对这个消费者不可见 |
| **short** | 一句话摘要 | summary_short + 引用 |
| **long** | 结构化摘要 + 关键证据 | summary_long + 关键 facts 引用 |
| **full** | 全文 | 按需从权威源取原文 |

### 4.2 权限先于打分

**权限检查在可见性打分之前执行**。无权限连 short 摘要都不给——confirmed_secret 的摘要本身可能泄密。

权限决策链：
1. **reference 合法性**：reference 必须是已注册的权威源 handle，不是裸文件路径。外部 URL 引用需白名单。
2. **actor 身份校验**：基于 actor identity（decision_owner / orchestrator / owner），不基于 channel。loopback 只证明请求来自本机，不证明调用者是可信模型。**actor 和 purpose 由服务端可信调用上下文注入**（从已认证 session/token 绑定），不允许调用方自填 actor——server-side session lookup，actor 来自已验证身份，不来自请求体。
3. **sensitivity 门控**：
   - `confirmed_secret`：**任何 channel（含 loopback）必须有有效 grant 才能访问**；loopback 不自动授权。无 grant → 连 short 都不给，返回 "unavailable"。
   - `suspected`：默认 short，full 需人确认。摘要继承对象 sensitivity，不降级。
   - `unknown`：**默认拒绝正文和摘要**，只给 "unavailable" 占位。摘要继承对象 sensitivity，不降级。
4. **target_model 白名单**：`fetchOnDemand` 的 `target_model` 参数必须在已注册的 agent runtime ID 白名单内；不在白名单 → 拒绝。
5. **跨 work 引用**：未标记 shareable 的对象不可被其他 work 装配。
6. **缓存隔离**：on-demand fetch 缓存按 actor + work + purpose 隔离；撤销分享后缓存失效。

**必需字段不可读 → blocked**：装配时如果必需字段（决策包的"要决定什么"、执行包的目标/约束）因权限/预算/源不可用而无法获取，返回 `blocked(reason=needs_context)`，不执行不占位继续。

### 4.3 可见性级别选择

选择依据（按优先级）：
1. 问题类型（决策视图 / Agent 任务 / 恢复）——默认级别不同。
2. 对象类型——objective/constraints 对执行必须 long；facts 默认 short。
3. sensitivity 约束（§4.2）。
4. 消费者权限（§4.2）。
5. 上下文预算——接近上限时降级非必需字段。

**模型的角色——只建议，不授权**：
- 模型可建议每个对象的可见性级别（带概率 scoring），但权限检查（§4.2）在打分之前已执行——模型只能在有权限的对象内建议级别。
- 模型不能把 hide 改为 full 来获取敏感信息。`confirmed_secret` 对象策略默认 hide，模型建议无效。
- **Jev 概率化 context scoring 是"上下文选择建议"职责；Overload 决策卡排序是"呈现优先级"职责。** 两者不同——决策卡排序必须确定性可解释，但这不否决模型对"哪些上下文相关"的概率化建议。模型建议，策略/人确认最终级别。

### 4.4 stale vs conflict

| | stale（同源新版） | conflict（多源矛盾） |
|---|---|---|
| 含义 | 同一权威源的 revision 递增，旧版被新版取代 | 不同源对同一引用给出矛盾值，或同键异 payload |
| 处置 | 显示最后已知值 + 采集时间，可触发刷新；不删对象 | 列出矛盾双方（source_a 版本 X vs source_b 版本 Y），交人或策略裁决 |
| 例子 | 测试重跑，旧 exit_code=0 被新 exit_code=1 取代 | git ls-remote 显示 sha=abc 但本地 submit.json 记录 push failed |
| 不做什么 | 不自动选新版覆盖决策依据（pin 保留旧版） | 不自动选一个——选一个就是造值 |

### 4.5 异常处置

| 异常 | 处置 | 不做什么 |
|---|---|---|
| 源不可用 | 标 `unavailable`，占位 | 不造值；不删除；不假装空 |
| 过期（超过 staleness_ms） | 标 `stale`，显示最后已知值 + 时间 | 不删除；不自动刷新 |
| 多源矛盾 | 标 `conflict`，列双方 | 不自动选一个 |
| 预算不足 | 降级可见性，标 `budget_limited` | 不静默截断；不降级必需字段 |
| 权限不足 | 标 `unavailable`，不返回摘要 | 不给 short；不降级 sensitivity |

### 4.6 fetchOnDemand 完整签名

```
fetchOnDemand({
  reference,        // 权威源 handle（必须已注册）
  visibility,       // 'short'|'long'|'full'
  actor,            // 调用者身份（decision_owner / orchestrator / ...）
  work_id,          // 所属 work（跨 work 引用检查）
  problem_id,       // 所属问题
  purpose,          // 'decision_view'|'agent_task'|'recovery'|'audit'
  channel,          // 投递渠道（loopback/feishu/cli）——参考用，不替代 actor 校验
  target_model,     // 目标模型（sensitivity→模型路由用）
  budget,           // {max_bytes, max_fetch_count, deadline_ms}
  version_pin       // 可选：指定 pin 的 revision（取旧版）
}) -> { payload, visibility, budget_limited? } | blocked(reason)
```

权限检查（§4.2）在 fetchOnDemand 内部最前面执行。

---

## 5. 父子问题与跨工作共享

### 5.1 父子问题分解

```
根问题 P0："帮我把 parseConfig 重构并加测试"
├── 子问题 P1："重构 parseConfig 为纯函数"
├── 子问题 P2："为新 parseConfig 补单测"
└── 子问题 P3："确认重构不破坏公共 API"
```

**继承规则**：
- 子问题继承父问题的 objective + constraints（通过 `control_context_problem_objects` 关联表引用，不复制）。
- 子问题有自己的 facts 和 decisions，通过关联表挂到自己的 problem_id。
- 一个对象可被多个兄弟问题引用（多对多关联表支持）；`objects.primary_problem_id` 只是主归属。

**父问题上下文变更传播**：
- 父问题 objective/constraints 更新版本 → 子问题标记 stale。
- **同步复验在三个入口强制执行**（不依赖异步事件）：
  1. `consumeDecision`（决策消费时）：复验当前约束版本与决策依据版本是否一致。
  2. `startControlledAction`（新受控动作时）：复验授权范围与当前约束是否一致。
  3. `resumeFromCheckpoint`（恢复入口时）：复验恢复点记录的约束版本与当前是否一致。
- **复验内容**（不只查约束版本）：
  - 当前权限：actor 是否仍有有效 grant（未被撤销）。
  - contract/policy 版本：契约和策略是否变更。
  - required_evidence_version：决策依据的证据版本是否仍有效。
- **读取—检查—消费绑定事务/CAS**：在 `consumeDecision` 中，先读取当前权限 + 契约 + 策略 + 证据版本，在同一事务内做 CAS 校验（revision 匹配），校验通过才消费；校验失败 → 拒绝并标 `stale_or_revoked`。避免"检查后变化"竞态。
- 复验失败 → 拒绝消费/动作/恢复，标 `stale_or_revoked`，不静默继续。
- `context.updated` / `context.invalidated` 事件异步刷新 UI 和标记 stale，但审批失效是同步逻辑，不依赖事件到达。
- **跨 DB 说明**：orchestrator.db 与 control.db 跨库，以 control.db 的权威门禁为准；不保证外部效果 exactly-once，只保证消费去重和步骤留痕。

### 5.2 跨工作共享边界

- 共享是显式的：`shareable=1` + `control_context_shares` 记录。
- `confirmed_secret` 默认不可跨工作共享。
- 共享的是引用 + 版本，不是内容拷贝。
- 版本更新不主动通知共享方——下次装配时检测 stale。

### 5.3 失效传播

- 对象更新版本 → 引用方标记 stale，不级联写入。
- 复用 `mgmt/manifest.ts` invalidate 模式推广到所有上下文对象。
- **pin 不屏蔽安全约束**：pin 保留旧证据的内容哈希和元数据作审计证据，但决策消费时必须同步复验当前安全约束（权限是否撤销、sensitivity 是否升级、约束是否变更）。pin 保留旧证据内容哈希，不保留旧访问权限——权限被撤销后 pin 持有者只看到 "revoked" + hash，正文已不可取（见 §5.4 清除策略）。

### 5.4 pin 生存期与 retention

- pin 存 `(object_id, revision)`，读取时 JOIN `control_context_object_versions` 取该版的 reference/权限/时效，不回对象表取最新 ref。
- `purpose='decision_evidence'`：审计元数据永久保留；原始正文在 expires_at 后清除，留 hash + tombstone。confirmed_secret 正文保留期更短（默认 7 天，配置声明）。
- `purpose='recovery_checkpoint'`：恢复完成后自动解除。
- pin 不阻止源更新。

**正文清除策略**：
- 清除只清**本系统受管副本**（context-pool 中存的正文/摘要），**不删用户原源文件**（代码仓库、用户文档等）。
- 当前未实现正文加密；清除后留 hash + tombstone，已清除正文不可恢复。如未来加密，密钥管理另行设计。
- 持久字段：`control_context_objects.purged_at`（清除时间）+ `tombstone_reason`（如 'expired' / 'revoked' / 'manual'）。清除 = 设 purged_at + tombstone_reason，versions 行保留但 reference 指向的正文不可取。

**旧二进制回退**：
- 依赖现有 schema_version 拒启机制——旧二进制检测到 DB schema_version 高于自身支持版本 → refuse to start。
- 由启动器门禁（launcher 检查 schema_version 兼容性后才启动二进制），不承诺二进制自检。

### 5.5 并发与 CAS

- 对象更新用 CAS：`WHERE object_id=? AND revision=?`。并发冲突 → 409。
- outbox 事件稳定 event_id；同键异 payload = 完整性错误。

---

## 6. 与现有代码的集成

### 6.1 新增 / 复用模块

| 模块 | 状态 | 说明 |
|---|---|---|
| `control/store.ts` CAS 模式 | **复用** | 对象版本 CAS。 |
| `control/outbox.ts` 事件机制 | **复用** | 上下文事件走同一 outbox。 |
| `mgmt/manifest.ts` 版本 invalidate | **复用** | 失效传播模式。 |
| `manage/handoff.ts` blocked_on_ask 判定 | **复用** | runtime state 分类。 |
| `shared/jump.ts` | **复用** | 活会话跳转。 |
| `orchestrator/task_recovery` unknown_ticks | **复用** | 恢复包预算状态。 |
| `control/context-pool.ts` | **新增** | 对象存储 CRUD + CAS + 问题树 CRUD + 关联表。Core OWN。 |
| `control/context-assembler.ts` | **新增** | 按问题装配三种包（库和 API）。Core OWN 实现。Execution 在 orchestrator 中调用 Core API 装配，不直接写 assembler 逻辑。 |
| `control/visibility-policy.ts` | **新增** | 权限预检 + visibility ladder 策略引擎。权限先于打分。 |
| `control/on-demand-fetcher.ts` | **新增** | full 级别取源，权限检查在内，按 actor+work+purpose 缓存隔离。 |
| `control/context-propagation.ts` | **新增** | 版本更新 → 引用方 stale 标记；三入口同步复验逻辑。 |
| `orchestrator/context-collector.ts` | **新增** | 采集端：从 orchestrator 持久存储（submit_result / runner_invocations / pr.ts 观测）和 ledger effect_observed 事件提取事实，**不直写 control DB**——产生 `context.fact_observed` 事件写入 orchestrator outbox/spool，Core ingest reducer 事务投影到 context-pool。不从 runner 内存 receiptByToolCall map 取权威数据。 |

### 6.2 接口与事件契约

**新增 API（Core 暴露）**：

```
getContextPackage({
  consumer_type,    // 'decision_ui' | 'agent_task' | 'recovery'
  consumer_id,       // attention_item_id | task_id | attempt_id
  work_id,
  problem_id,
  package_type,      // 'decision_view' | 'agent_task' | 'recovery'
  budget
}) -> ContextPackage | blocked(reason)

getProblemTree(workId) -> ProblemTree
createProblem(workId, parentProblemId, title, rootProblemId?) -> Problem
  // rootProblemId 可空，空时按规则派生：
  //   parentProblemId 为空 → rootProblemId = 新 problem_id（建根问题）
  //   parentProblemId 非空 → rootProblemId 从父问题继承（断言父.root_problem_id 一致）
linkProblemObject(problemId, objectId, revision, role?) -> void
  // 操作 control_context_problem_objects 关联表；revision 必填，不允许隐式 latest
  // 事务内验证：
  //   1. problem 存在且 work_id 与调用上下文一致
  //   2. object_id + revision 在 versions 表中存在（复合 FK 已保证）
  //   3. 跨 work 共享时验证 object 有 share 记录且 revision 匹配
  //   4. 插入 (problem_id, object_id, revision, role, created_at)
  // 不传 revision → 400 invalid

assembleContextPackage(consumer, workId, problemId, scopeFilter) -> ContextPackage
  // Core 提供库；Execution 调用

pinContext(objectId, revision, pinnedBy, purpose, expiresAt?) -> Pin
updateContext(objectId, expectedRevision, patch) -> NewRevision
fetchOnDemand({...}) -> Payload | blocked(reason)   // 见 §4.6
```

**新增事件**：

- `context.fact_observed`（collector → spool → Core reducer）：
  - idempotency_key = sha256(source_type + source_id + source_event_id + observation_revision)
  - **去重规则**：同一 source_event_id + 同一 observation_revision → 去重；同一 source_event_id 新 observation_revision → 创建新版本，不覆盖旧版。
  - payload 必填结构：
    ```
    {
      work_id: TEXT NOT NULL,
      problem_id: TEXT,
      object_canonical_key: TEXT NOT NULL,
      reference: TEXT NOT NULL,              -- 权威源引用（可解析 handle）
      source_type: TEXT NOT NULL,            -- orchestrator / extension / ingest / manual
      source_id: TEXT NOT NULL,              -- 源实例 ID（runtime_id / extension_instance_id）
      source_identity: TEXT NOT NULL,       -- 认证生产者身份（谁发的），区别于 source_id：source_type+source_id 是源的规范引用
      source_event_id: TEXT NOT NULL,        -- 上游事件稳定 ID
      observation_revision: INTEGER NOT NULL,-- 同一 source_event_id 的第 N 次观测
      attempt: TEXT,
      fact_subtype: TEXT NOT NULL,           -- CHECK 枚举
      content_hash: TEXT NOT NULL,
      sensitivity: TEXT NOT NULL,
      collected_at: TEXT NOT NULL,
      expires_at: TEXT,
      derived_from: TEXT
    }
    ```
  - 异常返回：
    - 缺必填字段 → 400 invalid
    - 同 idempotency_key + 同 content_hash → 200 idempotent（返回已有对象）
    - 同 idempotency_key + 异 content_hash → 409 integrity_error（冲突隔离 quarantine，不覆盖已有对象）
    - 跨 work 引用 → 409 conflict
    - sensitivity 无授权 → 403 forbidden
  - Core reducer 按 idempotency_key 去重，事务投影到 control_context_objects + object_versions。

- `context.updated` / `context.invalidated` / `context.stale` / `context.conflict`：走 control outbox。

**三入口同步复验**（不依赖事件到达）：
- `consumeDecision`：消费前复验当前约束版本 + 权限。
- `startControlledAction`：新受控动作前复验授权范围。
- `resumeFromCheckpoint`：恢复前复验恢复点约束版本。
- 复验失败 → 拒绝，标 `stale_or_revoked`。

### 6.3 所有权划分

| 关注点 | Core | Execution | Authorization | Surface |
|---|---|---|---|---|
| context-pool / assembler 库 / visibility-policy / on-demand-fetcher / propagation | **OWN** `src/control/context-*.ts` | 调用 API，不写 assembler 逻辑 | — | 只读消费 |
| context-collector（采集端 → spool 事件） | reducer 投影入 pool | **OWN** `src/orchestrator/context-collector.ts`，写 orchestrator outbox/spool | extension hook 上报 fact_observed | — |
| Agent 任务包装配调用点 | 暴露 API | **OWN** orchestrator 中调用 assembleContextPackage | — | — |
| 决策视图包 UI 渲染 | 暴露 API | — | — | **OWN** 折叠/展开 |
| 恢复包聚合调用点 | 暴露 API | **OWN** 调用 task_recovery + submit_result | — | — |
| 事件 kind 加在 shared/types.ts | **OWN**（仅增量） | — | — | — |
| 禁止 | 不碰 web/orchestrator | 不直写 control DB，不编 core API | 不碰 core/server | 不做 core 实现 |

---

## 7. 端到端用户例子

用户说："帮我把 `parseConfig` 重构为纯函数并加测试。"

**步骤 1：用户提问，Overload 建根问题 P0。** 写入 objective（reference → contract.objective）和 constraints（reference → contract scope/budget/non_goals）。

**步骤 2：分解为子问题 P1/P2/P3**（问题空间 channel）。每个子问题通过 `control_context_problem_objects` 关联表引用 P0 的 objective + constraints。

**步骤 3：Agent 执行。** collector 从 orchestrator 持久存储和 ledger 事件提取 facts：
- P1 write/edit → ledger `effect_observed: write=succeeded` → collector 发 `context.fact_observed` → Core reducer 入 pool。
- P2 跑测试 → runner_invocations exit_code=0 → fact subtype=test_result。
- P3 检查公共 API → fact subtype=observation_evidence。

**步骤 4：遇到决策点。** P3 发现 export 签名变更与 non_goals 冲突。装配决策视图包：权限预检（actor=owner）→ 捞 facts → short 投影 → 决策卡渲染。

**步骤 5：人决策，pin。** 人选"接受 API 变更"。decision 对象写入，pin 住 fact rev=3 + constraints rev=2。non_goals 更新版本 → 子问题标 stale。

**步骤 6：两种分支。**
- a. 活会话 live + user-blocked → jump 原现场，不重启，不用恢复包。
- b. terminated + checkpoint 有效 → 装配恢复包（work_id + attempt_id + checkpoint_reference），三入口复验通过后从 checkpoint 续跑。

**步骤 7：完成回流。** PR created → checks success → effect_state=succeeded → 人 resolve → 结果回流原工作项。facts 标 stale；decisions pin 保留 hash + tombstone；work 归档。

---

## 8. 开发任务分解

共 **13 项任务**，按依赖顺序排列。

| # | 任务 | Owner | 依赖 | 验收场景 |
|---|---|---|---|---|
| T1 | 建全部新表（objects/versions/problems/problem_objects/pins/shares） | Core | — | 旧库启动后六张新表存在；旧表不变；CHECK/FK 生效；自引用外键可建父子边 |
| T2 | context-pool CRUD + CAS + 问题树 CRUD + 关联表 | Core | T1 | updateContext CAS；并发写 409；createProblem 父子边；linkProblemObject 多对多 |
| T2b | context-collector 采集端（orchestrator 持久存储 → spool 事件 → Core reducer 投影） | Execution | T2, T10 | Agent 跑测试后 pool 出现 fact 对象（ctype=fact, fact_subtype=test_result, source=orchestrator）；collector 不直写 control DB；fact_observed 按 source_event_id+observation_revision 去重 |
| T3 | visibility-policy（权限预检先于打分 + sensitivity 门控 + unknown 默认拒绝） | Core | T2 | confirmed_secret + 非授权 actor → 返回 unavailable 不给摘要；sensitivity=unknown → 默认拒绝正文 |
| T4 | on-demand-fetcher（权限检查在内 + actor+work+purpose 缓存隔离） | Core | T2 | fetchOnDemand 权限拒绝 → blocked；撤销分享后缓存失效 |
| T5 | context-assembler：决策视图包装配 | Core | T3, T4, T2b | getContextPackage 返回必需字段；facts 从 pool 捞出非空；必需字段不可读 → blocked(needs_context) |
| T6 | assembler Agent 任务包调用点（Execution 调 Core API） | Execution | T5 | scope 过滤生效；硬约束结构化注入系统提示 |
| T7 | 恢复输入包装配（Execution 调 Core API + work_id+attempt_id+checkpoint） | Execution | T5 | 三条件同时满足（terminated + checkpoint有效 + runner支持）→ 返回恢复包；live+blocked_on_ask → 409 不产出恢复包；缺任一条件 → 拒绝 |
| T8 | context-propagation：版本更新 → stale 标记 + 三入口同步复验 | Core（策略引擎 OWN）；Authorization/Execution（调用点集成 OWN） | T2 | consumeDecision 复验失败 → 拒绝；父约束变更 → 子问题 stale；复验含权限+contract/policy+evidence 版本 |
| T9 | pin 机制（JOIN versions 取旧版 + 权限不绕过） | Core | T2 | pin 后源更新，pin 持有者见旧版；权限撤销后 pin 只显示 revoked+hash |
| T10 | outbox 事件：context.updated/invalidated/stale/conflict/fact_observed | Core | T2 | fact_observed 按 idempotency_key 去重；同键异 payload → throw |
| T11 | 决策卡 UI：evidence 折叠/展开（short→long→full） | Surface | T5 | 默认 short；展开 long；看全文 on-demand fetch full |
| T12 | 端到端：重构场景两条分支 | Execution + Surface | T6, T7, T8, T9, T10, T11 | 用户提问 → P1/P2/P3 分解；活会话 jump 不重启；死会话 checkpoint 续跑不重写文件 |
