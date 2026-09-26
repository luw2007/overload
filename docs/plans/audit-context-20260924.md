# Context 上下文系统全链路只读审计

- 日期：2026-09-24
- 范围：`src/control/*`、`src/shared/*`、`src/orchestrator/context-collector.ts`、`recovery-context.ts`、`agent-task-context.ts`、`src/web/context-routes.ts`
- 方式：只读通读，未修改任何文件。所有结论附 `file:line`。

## 0. 文件存在确认与行数

| 文件 | 存在 | 行数 | 备注 |
|---|---|---|---|
| src/control/store.ts | 是 | 652 | 含 `CONTROL_SCHEMA` + `CONTEXT_SCHEMA`；context CRUD 不在此文件。[后续行数已漂移，原 482→652] |
| src/control/types.ts | 是 | 82 | **无任何 context 类型**，只有 Work/Attention/Contract |
| src/control/context-pool.ts | 是 | 433 | problem/object/version/pin(部分)/share 的 CRUD。[原 407→433] |
| src/control/context-assembler.ts | 是 | 730 | 三类包装配主逻辑 |
| src/control/context-reducer.ts | 是 | 266 | FactObserved → pool 投影 + 幂等/隔离 |
| src/control/context-ingest.ts | 是 | 273 | spool NDJSON 摄入 |
| src/control/context-pin.ts | 是 | 275 | pin + share + purge |
| src/control/context-propagation.ts | 是 | 237 | stale 检测 + 三入口复验 |
| src/control/context-events.ts | 是 | 23 | outbox 事件别名 |
| src/control/visibility-policy.ts | 是 | 163 | hide/short/long/full 可见性梯 |
| src/control/on-demand-fetcher.ts | 是 | 411 | full 取源 + content_hash 校验。[原 375→411] |
| src/control/projection.ts | 是 | 59 | outbox 消费侧投影（attention） |
| src/control/outbox.ts | 是 | 105 | control_outbox 队列 |
| src/shared/context-contract.ts | 是 | 122 | FactObservedPayload + content_hash 权威定义 |
| src/shared/types.ts | 是 | 119 | journal/session 信封，非 context |
| src/shared/queries.ts | 是 | 264 | Q1–Q5 journal 查询，与 context pool 无关 |
| src/shared/jump.ts | 是 | 145 | 终端聚焦 deep link（平台级） |
| src/shared/resume.ts | 是 | 62 | 通用 session resume（journal 级） |
| src/shared/redact.ts | 是 | 11 | 正则脱敏 |
| src/orchestrator/context-collector.ts | 是 | 459 | observation 采集 → spool |
| src/orchestrator/recovery-context.ts | 是 | 376 | 恢复包聚合。[原 377→376] |
| src/orchestrator/agent-task-context.ts | 是 | 142 | Agent 任务包 + prompt 注入。[原 143→142] |
| src/web/context-routes.ts | 是 | 123 | 2 个只读 GET 端点 |

---

## 1. context 对象模型与 artifact ↔ mgmt 关系

**结论：ctype 枚举齐全，但 ctype='artifact' 在生产中无任何写入方。**

- 枚举定义：`control_context_objects.ctype` CHECK 在 `store.ts:80`（objective|constraints|fact|decision|artifact|scene）；TypeScript 镜像在 `context-pool.ts:7,101`。[行号 +2，原 :78→:80]
- fact_subtype 约束：`store.ts:79,85-86`（fact 必须带 subtype，其余必须为 NULL）。
- **artifact 对象与 mgmt_artifacts 的关系是松耦合的字符串引用，没有 FK、没有同步任务。**
  - `control_context_object_versions.reference` 是裸 TEXT，无格式校验（`context-pool.ts:93,143`）。
  - reference 格式由 `visibility-policy.ts:37-61` 的 `isAuthoritativeReference` 正则白名单承认：`artifact:<id>@<version>`（`visibility-policy.ts:48`，正则 `/^artifact:.+@.+/`）。
  - 真正取源时才解析：`on-demand-fetcher.ts:211-222` 用 `^artifact:([^@]+)@([^@]+)$` 取出 artifactId/versionId，**同库 JOIN `mgmt_artifacts a JOIN mgmt_artifact_versions v`**，并强制 `a.work_id = 当前 work_id` 做跨 work 绑定（`on-demand-fetcher.ts:218-220`）。
  - 即：context object → `reference="artifact:<artifact_id>@<version_id>"` → full 取源时才反查 mgmt 表。context 不维护 artifact 从属关系，mgmt 表独立演进。
- **生产中没有任何代码创建 ctype='artifact' 的 context object：**
  - `createObject(` 全仓非测试调用方 = 0（仅 `context-pool.ts:284` 定义本身）。
  - 唯一的生产写入路径 `context-reducer.ts:198-200` 硬编码 `ctype="fact"`。
  - `reference` 字符串 `"artifact:..."` 的生产写入方 = 0（仅 `shared/context-contract.ts:28` 注释里描述）。
  - [已过时 2026-09-24 晚]：新增 src/control/artifact-projection.ts，ctype='artifact' 由 requestAcceptance（manifest.ts:247）投影写入，createObject 不再零调用。
- 判定：**ctype 表结构与 artifact reference 解析 = 已有实现；artifact 对象的生产写入 = 完全缺失（仅测试可达）。**

## 2. 是否存在 chunk 切分

**结论：完全不存在 chunk 概念。**

- 全 `src/` 非测试代码 grep `chunk`，命中全部是 I/O 字节缓冲（`decision-bot/runner.ts:143`、`ingest/cmux.ts:209`、`adapters/pi-broker.ts:15`、`manage/source.ts:159`），与 context 无关。
- 无 chunk 表、无 chunk hash、无字节/语义范围列、无邻接关系。`control_context_object_versions` 只有单行 `reference` + `summary_short` + `summary_long` + `content_hash`（`store.ts:90-107`），对象是**整对象粒度**。
- summary 是预生成的两段文本（short/long），不是切分结果；`summary_long` 注释明确“由 assembler 按需生成”（`context-reducer.ts:218`），但实际生产无人写 long。
- 判定：**chunk = 完全缺失。**

## 3. 上下文装配逻辑

**结论：纯规则筛选（按 role 分桶）+ 预算对半裁剪；无模型相关性评分；存在 hide/short/long/full 四级可见。**

- 选对象：`context-assembler.ts:245-251 selectPoolObjects`。有 problem_id 就 `listObjectsByProblem(problem_id)`（`context-pool.ts:351-372`，按 `po.created_at, po.object_id` 排序）；无 problem_id 就展开整个 problem tree 后拼接。
- **没有相关性排序/打分。** 进入包后按 `role`（= problem_objects.role，实际就是 ctype）分桶：fact→trigger_evidence/relevant_facts、decision→prior_decisions、artifact→artifacts、scene→scene（`context-assembler.ts:348-402, 567-621`）。顺序即数据库返回顺序。
- 唯一“相关性”是 agent-task 侧事后的子串过滤：`agent-task-context.ts:39-50 factMatchesScope`（reference+summary 里 grep cwd/repo/effect 关键词），注释自承“本专项不做语义匹配”。
- 预算裁剪：默认 decision 2048B / agent_task 8192B（`context-assembler.ts:341,553`）；超限后对可选数组**对半砍**（`applyDecisionViewBudget` L430-449、`applyAgentTaskBudget` L640-656），必需字段（conclusion/trigger/impact/options/owner）不砍。无 top-K 重排。
- 可见级别：`visibility-policy.ts:6` 定义 `hide|short|long|full`，逐级 order 0–3（L21-26）。
  - defaultVisibility：objective/constraints/scene→long，fact/decision/artifact→short（`visibility-policy.ts:81-94`）。
  - assembler 请求级别：decision_view 全请求 `short`（L354,369,380,392）；agent_task objective/constraints/scene 请求 `long`（L465,501,613），其余 short。
  - full 才触发 `fetchOnDemand`（`context-assembler.ts:285-301`）。
- 判定：**规则筛选 + 预算裁剪 + 四级可见 = 已有实现；模型相关性评分/排序 = 完全缺失。**

## 4. content_hash 闭环

**结论：定义清晰，full 取源有 sha256 复验；但 artifact 分支哈希对象是“行 JSON”而非 snapshot 字节，且 mgmt content_sha256 不参与闭环。**

- 权威定义（`shared/context-contract.ts:16-37`）：
  - `content_hash = sha256(canonical_source_bytes)`。
  - 逐源字节约定：`orchestrator:task_event:<id>` → `task_events.detail` 原文（L24）；`journal:<seq>` → `journal.detail`（L25）；`contract:<w>@<rev>` → `control_contract_revisions.contract` 原文（L26）；`attention:<id>@<rev>` → `JSON.stringify(row)`（L27）；`artifact:<id>@<ver>` → `JSON.stringify(row)`（L28）。[已过时]：fetcher artifact 分支已重写为读 snapshot_path 字节并 sha256 复验（on-demand-fetcher.ts:211-258），context-contract.ts:28 已同步。
  - 纪律：collector 算 hash，reducer 只存比不算（L31-34）。
- collector 侧实际：
  - test_result / observation_evidence：`sha256(task_events.detail ?? "")`（`context-collector.ts:211,313`），与 fetcher 返回的 `detail` 列逐字节一致（fetcher L193-201）。
  - code_state / external_state：hash 的是 `stableStringify(tasks 字段投影)`（`context-collector.ts:232-237,265-269`），reference 为 `orchestrator:task:<id>:branch/:pr`——**fetcher 无此 handler，full 取源恒为 unavailable**（fetcher L229-230 兜底；collector L80-82,225,258 注释自认）。这两类的 content_hash 仅作版本签名，闭环断裂。
- reducer 只透传：`context-reducer.ts:203-221` 把 `payload.content_hash` 原样写入 version 行；不重算（符合契约 L33）。
- on-demand 复验（`on-demand-fetcher.ts:335-352`）：
  - full 级别才走 `fetchFromSource`，取回 payload 后 `sha256(payload)` 与 `version.content_hash` 不等 → `blocked("content_hash mismatch", "needs_context")`（L348-351）。
- **artifact 分支的取源路径**（`on-demand-fetcher.ts:210-222`）：
  - 从 control DB **同库**查 `mgmt_artifacts JOIN mgmt_artifact_versions`，SELECT 固定 9 列（artifact_id/kind/canonical_key/version_id/content_kind/content_sha256/snapshot_path/snapshot_state/sensitivity），返回 `JSON.stringify(row)`。
  - **不读 snapshot_path 指向的文件字节**。`snapshot_path` 仅作为字符串出现在行 JSON 里。
  - 因此 artifact 的 content_hash = sha256(这 9 列固定顺序行的 JSON)，**不是** mgmt_artifact_versions.content_sha256（后者是 snapshot 文件字节哈希），二者无校验关系。
  - mgmt 侧真正读 snapshot 文件字节算 sha256 只发生在 `manage/submit.ts:166-167`（发布校验），与 context 闭环无关。
  - [已过时]：fetcher artifact 分支已重写为读 snapshot_path 字节并 sha256 复验（on-demand-fetcher.ts:211-258），context-contract.ts:28 已同步。
- 判定：task_event/journal/contract/attention 四条链 = 已有实现且闭环；artifact 行 JSON 闭环 = 已有实现但脆弱（依赖 SELECT 列集合与 collector 计算时完全一致，无测试/契约锁死该列序）；code_state/external_state 的 full 闭环 = 缺失；对 mgmt content_sha256/snapshot 字节的闭环 = 完全缺失。

## 5. pin 机制

**结论：pin 钉住 (object_id, revision) 整版本；过期只读时返回 expired，不自动清理；purpose 枚举齐全。**

- DDL：`control_context_pins`（`store.ts:120-129`），FK 到 `(object_id, revision)`，purpose CHECK `decision_evidence|recovery_checkpoint|other`（L125），`expires_at` 可空。[行号 +2，原 :118-127]
- 创建：`context-pin.ts:59-84 pinContext`，显式要求 revision，校验版本存在。
- **钉粒度 = object + 具体 revision，不是更细粒度（无 chunk、无 range）。** `getPinnedVersion` JOIN 到 pinned revision 而非 latest（`context-pin.ts:96-115`，注释 L92-95 明确“对象出新版后 pin 仍取旧版”）。
- 过期处理：`readPinnedContent`（`context-pin.ts:146-183`）是**读取时惰性判定**：
  - 对象 purged → `{status:"purged"}`（L155-161）；
  - `pin.expires_at < now` → `{status:"expired"}`，仅回 content_hash，不回正文（L164-166）；
  - actor ≠ decision_owner → `{status:"revoked"}`（L171-180，注释 L168-170 说明 share 无 actor 列、fail-closed 只认 decision_owner）。
- **没有后台任务清扫过期 pin**；过期行留在表里，只在读时暴露。`unpin` 手动删除（L117-120）。
- 判定：pin 数据结构 + 读时状态机 = 已有实现；过期自动失效/清扫 = 缺失。

## 6. share / grant 与 sensitivity

**结论：share 是 (object_id, revision, shared_with_work) 三元授权；confirmed_secret 在当前约束下自相矛盾，实际永远不可见。**

- DDL：`control_context_shares`（`store.ts:130-139`），UNIQUE(object_id, revision, shared_with_work)，无 actor 列。[行号 +2，原 :128-137]
- 授权：`context-pin.ts:187-228 shareObject`；**confirmed_secret 禁止 share**（L205-207 抛错）。
- 建对象时同样禁止：`context-pool.ts:301`（createObject）与 `context-pool.ts:336`（updateObject）都强制 `confirmed_secret && shareable≠0 → invalid`。
- visibility 过滤（`visibility-policy.ts:98-163 checkVisibility`）：
  1. reference 必须过白名单正则，否则 unavailable（L111-113）。
  2. actor 身份必填（L116-118）。
  3. **sensitivity=='unknown' → 直接 unavailable**（L126-128）。
  4. **sensitivity=='confirmed_secret' → 要求 `hasValidGrant(object, revision, work)`，否则 forbidden**（L122-125）。
  5. 跨 work 对象要求 `shareable==1` 且有 share（L138-145）。
  6. 级别被 `SENSITIVITY_CAP` 封顶：confirmed_secret→full、suspected→short、clean→full（L29-33,148-160）。
- **死锁**：confirmed_secret 对象既被建表/建对象时禁止 share（pool L301、pin L205），又在 checkVisibility 要求 share（L123）。两条约束合起来 = confirmed_secret 对象在装配时恒为 forbidden，full 正文永不可达。`SENSITIVITY_CAP[confirmed_secret]="full"` 是死代码。
- 决策入口复验另有独立 fail-closed：`store.ts:549-593`（context 决策必须 decision_owner 本人）与 `context-propagation.ts:131-154`（share 必须精确绑 object_id+revision+work，禁止”B 名下任意 share 放行”）。[行号大幅后移，原 :390-416→:549-593]
- 判定：share 三元授权 + visibility 梯 + 跨 work 绑定 = 已有实现；confirmed_secret 闭环 = 自相矛盾（仅有表结构与两处互斥校验，无可用路径）。

## 7. 事件流全链路

```
orchestrator DB (tasks/task_events, 只读)
  └─ context-collector.collectFacts()            [orchestrator/context-collector.ts:343-352]
       test_result/code_state/external_state/observation_evidence
       └─ buildEvent(): 算 content_hash + cursor 去重/版本号  (L92-143)
       └─ collectAndSpool(): 写 NDJSON seg 文件             (L446-459)
            active-context-collector.<seq>.ndjson  (tmp+fsync+rename, L401-410)
                                    │
                                    ▼  (文件边界，orchestrator 不碰 control DB)
web server ingest loop  ingestContextSpool()        [web/server.ts:175 → control/context-ingest.ts:188]
  ├─ kind=="context.fact_observed" → validateFactObservedPayload (ingest.ts:231-242)
  │      └─ ingestFactObservedOrThrow → ingestFactObserved (reducer.ts:98-248)
  │           ├─ idempotency_key = sha256(type+source_id+event_id+rev)  (reducer.ts:22-31)
  │           ├─ 同 key 异 hash → quarantine 表                          (L127-130)
  │           ├─ out-of-order observation_revision → quarantine         (L161-173)
  │           ├─ INSERT control_context_objects (ctype='fact')           (L193-201)
  │           ├─ INSERT control_context_object_versions                  (L203-221)
  │           ├─ IF payload.problem_id → linkProblemObject(role='fact')  (L223-225)
  │           ├─ INSERT control_context_fact_dedup                       (L227-229)
  │           └─ enqueueControlEvent("context.updated")  ──────────────┐(outbox 介入点)
  └─ kind ∈ context.pending/recovery_* → upsertAttention(决策卡)         (ingest.ts:243-247 → L102-161)
                                    │
                                    ▼
control_outbox 表  [outbox.ts:20-27]
  enqueueControlEvent: event_id=sha256(producer\0entity\0ver\0kind), 同键异 payload 冲突抛错 (outbox.ts:40-45)
  publishControlEvents: 租约 lease_until=+30s, 批 100, emit 成功才标 published_at;
                        ledger.applied_control_events 回执后标 delivered_at (outbox.ts:52-105)
                                    │
                                    ▼
消费者 applyControlEvent()  [projection.ts:20-59]
  payload_hash 重算比对 → ON CONFLICT revision 校验 → upsert control_attention
```

- **outbox 在 reducer 写 pool 之后介入**（`context-reducer.ts:231-242`）：pool 落库与 outbox 入队在同一 immediate 事务内。
- 决策卡侧：collector 的 `spoolContextEnvelope`（`context-collector.ts:424-435`）由 orchestrator.ts:358 调用，发 `context.pending/recovery_jump/recovery_package/recovery_reconcile`，ingest 把它们 upsert 成 `control_attention` 行（item_id=`ctx:<kind>:<work>:<task>`，`context-ingest.ts:126`）。
- **关键断裂**：collector 从不设置 `problem_id`（`context-collector.ts:127` 用 `ctx.problem_id ?? null`，而 `orchestrator.ts:316-320` 的 collectContextFacts 不传 problem_id）。因此 reducer L223 的 linkProblemObject **永不执行**，`control_context_problem_objects` 恒空 → assembler `selectPoolObjects` 恒空。[已过时]：根 problem 已由 v5 迁移（store.ts:166-168）+ createWork/redirectWork/promoteWork 补建（store.ts:250,257,292），orchestrator.ts:326 注入 rootProblemId，linkProblemObject 已改 upsert（context-pool.ts:424）。
- 判定：管道骨架 = 已有实现；pool→problem 绑定这一段 = 实际上空转。

## 8. 失效传播

**结论：有 stale 检测函数，但无自动失效，且无生产调用方。**

- `markObjectUpdated`（`context-propagation.ts:15-45`）：对象出新版后，把所有直接引用它的 problems 的 `updated_at` 刷成 now（**不新增 stale 列**，注释 L27 自认），并发 `context.updated` outbox 事件。
- **零生产调用方**（grep 仅定义本身）。reducer 出新版时直接 `UPDATE objects.revision`（`context-reducer.ts:194`），不调 markObjectUpdated。
- stale 检测是**读时惰性比较**：`isStale`（L59-76）/`getStaleObjects`（L81-96）比 `problem_objects.revision < objects.revision`；assembler 用 `buildStaleMap`（`context-assembler.ts:309-321`）在装配时算，结果塞进 `DecisionViewPackage.stale_objects`（L422）。这两个函数本身也**零生产调用方**，仅 assembler 内联了等价逻辑。
- 旧 version 行本身不被标记 stale/tombstone；`expires_at`/`staleness_ms` 列存在（`store.ts:97-98`）但**无任何代码读取或基于它们失效**。
- purge 是手动动作：`purgeObjectContent`（`context-pin.ts:265-275`）只置 `purged_at` + reason，保留 versions 行。
- 判定：stale 检测/复验函数 = 已有实现；自动失效传播 = 仅有函数无调用（表结构无 stale 列、无后台扫描、无基于 staleness_ms 的过期）。

## 9. 三类上下文包

| 包 | 入口 | 是否读 pool | 调用 assembler 函数 |
|---|---|---|---|
| Agent 任务包 | `agent-task-context.ts:102 buildAgentTaskContext` → `getContextPackage(package_type:"agent_task")` | 是 | `assembleAgentTask`（`context-assembler.ts:546`）：objective/constraints 先找 pool，miss 则回退读 `work.contract`（L477-487,528-542）；facts/decisions/artifacts/scene 遍历 pool；最后 `applyAgentTaskBudget` 对半裁 |
| 恢复包 | `recovery-context.ts:258 determineRecoveryOutcome` → `assembleRecovery` | **否** | `assembleRecovery`（`context-assembler.ts:660-702`）：只做 `reverifyBeforeAction`（L674-684），然后原样透传 Execution 侧聚合的 `recovery_aggregated`。聚合数据全部来自 orchestrator DB（`recovery-context.ts:138-254`：task_events/tasks/task_recovery），**不碰 control_context_* 表** |
| 决策卡包 | `web/context-routes.ts:48 decisionPackage` → `getContextPackage(package_type:"decision_view")` | 是 | `assembleDecisionView`（`context-assembler.ts:325-427`）：以 attention item 为骨架（conclusion/trigger/impact/options/owner），pool 对象分桶为 trigger_evidence/prior_decisions/artifacts/scene_entry，`applyDecisionViewBudget` 裁剪 |

- 决策卡上下文的“证据对象”绑定在 attention.evidence.object_id/revision（`store.ts:390-391,427-430` 复验 purge），但生产中 attention 卡来自 `context-ingest.ts` 的 4 类事件，evidence 里没有 object_id，因此证据复验分支实际不触发。
- 判定：三个包装配函数 = 已有实现；但 agent_task/decision_view 的 pool 侧因第 7 节断裂而恒空，实际行为退化为“contract 直读 + 空数组”。

## 10. 与 mgmt 的衔接

**结论：context 只读 mgmt，且仅在 on-demand full 取源时同库反查一次；不读 snapshot 文件。**

- control 与 mgmt 同库（迁移 v2 `ensureMgmtSchema`，`store.ts:157`）。
- context 侧对 mgmt 表的唯一读：`on-demand-fetcher.ts:214-219` 的 artifact 分支（`mgmt_artifacts JOIN mgmt_artifact_versions`，强制 work_id 绑定）。
- **不访问 `mgmt_artifact_versions.snapshot_path` 指向的文件**；snapshot_path 仅作为 SELECT 出的一列字符串进入行 JSON。
- mgmt 自己的写/读在 `manage/collect.ts:62`（登记版本）、`manage/submit.ts:106,166-167`（发布时读 snapshot 字节复核 sha256），与 context 系统无回调、无事件同步。
- 反向（mgmt → context）：无任何代码把新 artifact version 投影成 ctype='artifact' 的 context object；`context-propagation` 也不监听 mgmt 版本变化。[已过时 2026-09-24 晚]：新增 src/control/artifact-projection.ts，ctype='artifact' 由 requestAcceptance（manifest.ts:247）投影写入，createObject 不再零调用。
- 判定：读路径 = 已有实现；artifact version → context object 的生产投影 = 完全缺失。

---

## 附：与“上下文作为产物版本的只读投影（ContextChunk 从属 ArtifactVersion）”目标模型的差距

目标模型：context 是 mgmt artifact version 的只读从属投影，有 chunk 粒度、随 artifact version 自动失效、以 snapshot 字节哈希闭环。现状差距：

1. **从属方向反了/没接上。** 目标是 ArtifactVersion 1:N ContextChunk；现状是 context object 用裸 `reference` 字符串**反向指** mgmt artifact，且生产无任何投影写入（第 1、10 节）。`createObject` 零调用方。
2. **无 chunk。** 目标要求字节/语义范围、chunk hash、邻接关系；现状整对象单行 + short/long 两段 summary（第 2 节）。
3. **content_hash 闭环对象错位。** 目标应对 snapshot 字节哈希；现状 artifact 分支哈希的是 9 列固定行的 JSON，`content_sha256` 不参与校验，snapshot 文件从不读（第 4 节）。
4. **无自动失效。** 目标要求 artifact 出新 version 后旧 chunk 自动 stale；现状 `markObjectUpdated` 无调用方、无 stale 列、`staleness_ms` 列无人读（第 8 节）。
5. **pool 生产空转。** collector 不传 problem_id → problem_objects 恒空 → assembler 选不到任何对象；createProblem 零调用方（第 7 节）。ctype objective/constraints/decision/scene/artifact 五个分支在生产都是死路径，只靠 contract 直读兜底。
6. **confirmed_secret 自相矛盾。** 建对象/share 禁止与 visibility 要求 grant 互斥（第 6 节）。
7. **code_state/external_state 无法 full 取源。** reference 无 fetcher handler，full 恒 unavailable，content_hash 仅签名（第 4 节）。
8. **pin 无过期清扫**，仅读时返回 expired（第 5 节）。

### 落地成熟度汇总

| 模块 | 状态 |
|---|---|
| 六表 DDL + 迁移 | 已有实现 |
| problem/object/version/pin/share CRUD | 已有实现 |
| FactObserved 校验 + 幂等 + quarantine + 乱序防护 | 已有实现 |
| spool 文件管道 + outbox + ledger 回执 | 已有实现 |
| visibility 四级梯 + 跨 work share 绑定 | 已有实现 |
| on-demand full 取源（contract/attention/journal/task_event） | 已有实现 |
| 三类包装配函数 | 已有实现 |
| artifact 行 JSON 反查 mgmt | 仅有解析、无生产写入方 |
| ctype=objective/constraints/decision/artifact/scene 对象生产写入 | 完全缺失 |
| createProblem / problem_objects 生产绑定 | 完全缺失（表在，无人写） |
| chunk 切分 | 完全缺失 |
| artifact version → context 自动投影/失效 | 完全缺失 |
| snapshot 字节级 content_hash 闭环 | 完全缺失 |
| confirmed_secret 可用路径 | 自相矛盾 |

---

## 后续新增（2026-09-24 晚 P0-MVP + KISS 三项 hotfix 落地）

本文成文后，代码新增以下生产文件与 API，早期快照未覆盖：

- `src/control/artifact-projection.ts`（约 263 行投影器）：`projectArtifactVersions(db, work_id, now)` 按 work 全量投影 mgmt stored/reference_only version 为 ctype='artifact' 的 context object，触发点 `manifest.ts:247` requestAcceptance。
- v5 迁移：`store.ts:166-168` 遍历 `control_works` 逐行 `ensureRootProblemLocked` 幂等回填根 problem；`CONTROL_SCHEMA_VERSION` 现为 5。
- 3 个 attention 收编 API：`store.ts:432 supersedeOpenAttentionByWork`、`store.ts:466 supersedeAttentionById`、`store.ts:490 resolveAttentionByExternalSuccess`。
- `ensureRootProblem` / `rootProblemId` 导出：`context-pool.ts:98,236`，幂等 get-or-create 根 problem。
