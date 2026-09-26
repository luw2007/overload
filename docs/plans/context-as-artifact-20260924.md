# 上下文进入产物（context-as-artifact）完整方案

- 日期：2026-09-24
- 性质：只读分析 + 方案文档。本文不修改 `src/` 业务代码，不 commit / push / deploy。
- 依据：
  - 审计报告 A《Manage / Artifact 体系与跨切面事件流》（`docs/plans/audit-manage-20260924.md`，下称"审计 A"）
  - 审计报告 B《Context 上下文系统全链路》（`docs/plans/audit-context-20260924.md`，下称"审计 B"）
  - 项目指导原则 `AGENTS.md`（注意力调度原则为第一优先级）
  - 既有契约 `docs/architecture/implementation-contract.md`（四 owner 红线）、`src/shared/context-contract.ts`（content_hash 权威定义）

---

## 0. 目标模型（产品判断，全文以此为方向）

```
Artifact（权威内容：交付产物 / 过程产物 / 运行产物；owner、版本、hash、sensitivity、保留策略）
  └ ArtifactVersion（内容寻址：content_sha256 + snapshot）
      └ ContextChunk（只读投影：字节/语义范围、chunk hash、摘要、邻接关系、所属版本）
          └ ContextCandidate（某次问题/查询下的候选与评分：建议 hide/short/long/full、概率、理由）
```

四条铁律：

1. **三类产物都是 Artifact**：交付物（代码/diff/PR）、过程产物（人的决定、决策依据版本、证据快照、checkpoint、恢复包、对账结果）、运行产物（日志、测试结果、工具回执）。
2. **上下文不是独立权威内容，而是产物版本的检索投影**。chunk 永远从属某个 artifact_version，产物更新后旧 chunk 标 stale，绝不原地改。
3. **pin 钉住 artifact_version + chunk_range**，不是整对象 revision。
4. **评分只能在已通过权限检查的候选里建议可见级别**，不能借评分越权提权。

---

> **现状快照（2026-09-24 晚补注）**：本 plan 成文后，P0-MVP + KISS 三项 hotfix 已落地：artifact-projection.ts 投影器、v5 根 problem 迁移、3 个 attention 收编 API。chunk 切分与自动失效传播仍未实现。下文为历史设计快照，关键矛盾段落已逐条标注。

## 1. 现状与差距判定

### 1.1 产物权威表与上下文对象表：双轨，且两侧都在空转

**答案：双轨。**

- 权威产物侧是 mgmt 库：`mgmt_artifacts` / `mgmt_artifact_versions`。但 `kind` DDL 声明 4 值（`file|git_commit|git_dirty|external`，`src/manage/schema.ts:44`），实际只写 `file` 和 `git_dirty`（`src/manage/collect.ts:58-61`）；`git_commit`、`external` 无写入点（审计 A §1）。
- 上下文对象侧是 control 库：`control_context_objects` / `control_context_object_versions`，六张表 DDL 齐全（`src/control/store.ts:59-137`），但 `createObject` 全仓生产调用方为 0；唯一生产写入路径 `src/control/context-reducer.ts:198-200` 硬编码 `ctype='fact'`（审计 B §1、§7）。 [已过时 2026-09-24 晚]：新增 src/control/artifact-projection.ts，ctype='artifact' 由 requestAcceptance（manifest.ts:247）投影写入，createObject 不再零调用。
- 两侧之间没有同步任务。context 不维护 artifact 从属关系，mgmt 也从不把新 version 投影成 context object（审计 B §10）。

### 1.2 control_context_object_versions.reference 如何指向 mgmt artifact

目前是**松耦合字符串反查，无 FK、无投影任务**：

- `reference` 是裸 TEXT（`src/control/context-pool.ts:93,143`），格式由可见性策略白名单正则承认：`artifact:<id>@<version>`（`src/control/visibility-policy.ts:48`，正则 `/^artifact:.+@.+/`）。
- 真正取源时才解析：`src/control/on-demand-fetcher.ts:211-222` 用 `^artifact:([^@]+)@([^@]+)$` 拆出 artifactId/versionId，同库 JOIN `mgmt_artifacts a JOIN mgmt_artifact_versions v`，并强制 `a.work_id = 当前 work_id` 做跨 work 绑定。
- 生产中没有任何代码写入 `reference="artifact:..."`（审计 B §1）。即这条反查路径只有解析器，没有生产上游。 [已过时 2026-09-24 晚]：新增 src/control/artifact-projection.ts，ctype='artifact' 由 requestAcceptance（manifest.ts:247）投影写入，createObject 不再零调用。

### 1.3 决定 / pin / checkpoint 等过程产物是否已纳入统一产物归档

**没有。** 它们散落在三张互相不通的地方：

- 人的决定：`mgmt_inputs.kind` DDL 声明 7 值，实际只写 `user_message`（`src/manage/store.ts:33-34`）；`decision/approval/acceptance` 无生产写入（审计 A §3）。人的验收单独存在 `mgmt_acceptances`（`src/manage/manifest.ts:247-299`），与 inputs 两套并存。
- checkpoint / 恢复包：存在 `mgmt_handoffs.packet` 和 git patch 磁盘文件（`src/manage/handoff.ts:43-48`、`src/manage/launch.ts:37-40`），不进 `mgmt_artifacts`，无法享受版本化 / shareable / sensitivity 处理（审计 A G8）。
- 对账结果：`mgmt_external_effects`（`src/manage/submit.ts:488-515`）已有逻辑，但不是 Artifact 一等公民。
- 运行产物：`mgmt_exec_records` 整表空转（DDL 在 `src/manage/schema.ts:114-119`，grep 无任何 INSERT/SELECT，审计 A §4）；日志 / 测试结果 / 工具回执散在 ledger 的 `journal` 表和 `src/orchestrator/evidence.ts:95` 落盘文件里，不进 mgmt。

### 1.4 是否存在真正的 chunk 切分

**完全不存在。** 全仓非测试代码 grep `chunk`，命中全部是 I/O 字节缓冲（审计 B §2）。`control_context_object_versions` 只有单行 `reference` + `summary_short` + `summary_long` + `content_hash`（`src/control/store.ts:90-107`），对象是整对象粒度。没有 chunk 表、没有 chunk hash、没有字节/语义范围列、没有邻接关系。`summary_long` 注释说"由 assembler 按需生成"（`src/control/context-reducer.ts:218`），实际生产无人写 long。

### 1.5 是否存在模型相关性评分

**没有。** 现状是规则分桶 + 预算对半砍：

- 选对象：`src/control/context-assembler.ts:245-251 selectPoolObjects`，有 problem_id 就 `listObjectsByProblem`（`src/control/context-pool.ts:351-372`），顺序即 DB 返回序（`po.created_at, object_id`）。
- 进包后按 role（实际就是 ctype）分桶（`context-assembler.ts:348-402, 567-621`），无相关性打分、无 top-K 重排。唯一"相关性"是 agent-task 侧事后子串 grep（`src/orchestrator/agent-task-context.ts:39-50 factMatchesScope`），注释自承"本专项不做语义匹配"。
- 预算裁剪超限后对可选数组对半砍（`applyDecisionViewBudget` `context-assembler.ts:430-449`、`applyAgentTaskBudget` L640-656），必需字段不砍。
- 可见级别已有四级梯 `hide|short|long|full`（`src/control/visibility-policy.ts:6,21-26`），但级别是按 ctype 静态定的（defaultVisibility L81-94），不是按问题相关性评出来的。

### 1.6 full 取源与产物快照路径如何衔接

**半通，且哈希对象错位。**

- 契约定义 `content_hash = sha256(canonical_source_bytes)`，且 artifact 源约定为"被 fetch 时该行 `JSON.stringify(row)` 的字节"（`src/shared/context-contract.ts:28`）。
- 实际 artifact 分支取源（`on-demand-fetcher.ts:214-219`）SELECT 固定 9 列（artifact_id/kind/canonical_key/version_id/content_kind/content_sha256/snapshot_path/snapshot_state/sensitivity），返回 `JSON.stringify(row)`。**它不读 `snapshot_path` 指向的快照文件字节**，snapshot_path 只是作为一列字符串出现在行 JSON 里。 [已过时]：fetcher artifact 分支已重写为读 snapshot_path 字节并 sha256 复验（on-demand-fetcher.ts:211-258），context-contract.ts:28 已同步。
- 因此 artifact 的 content_hash = sha256(9 列行 JSON)，与 `mgmt_artifact_versions.content_sha256`（快照文件字节哈希）**无校验关系**。mgmt 侧真正读快照字节复核 sha256 只发生在 `src/manage/submit.ts:166-167`（发布校验），与 context 闭环无关（审计 B §4）。
- 另外 code_state / external_state 两类 reference 在 fetcher 里没有 handler，full 恒为 unavailable（`on-demand-fetcher.ts:229-230`）。

### 1.7 两条最致命断裂（方案必须优先接上）

1. **pool 生产空转**：collector 从不传 `problem_id`（`src/orchestrator/context-collector.ts:127` 用 `ctx.problem_id ?? null`，而 `src/orchestrator.ts:316-320` 的 `collectContextFacts` 不传）→ reducer 的 `linkProblemObject`（`context-reducer.ts:223-225`）永不执行 → `control_context_problem_objects` 恒空 → `selectPoolObjects` 恒空。`createProblem` 零生产调用方。结果是三类包退化为"contract 直读 + 空数组"。 [已过时]：根 problem 已由 v5 迁移（store.ts:166-168）+ createWork/redirectWork/promoteWork 补建（store.ts:250,257,292），orchestrator.ts:326 注入 rootProblemId，linkProblemObject 已改 upsert（context-pool.ts:424）。
2. **失效传播是孤儿函数**：`markObjectUpdated` / `isStale` / `getStaleObjects`（`src/control/context-propagation.ts:15-96`）均无生产调用方；无 stale 列、无后台扫描、`staleness_ms` 列无人读（审计 B §8）。

---

## 2. 目标架构

### 2.1 统一 Artifact 类型体系

以现有 `mgmt_artifacts` 为权威表，**不新建平行产物库**。在 `mgmt_artifacts` 上新增一个分类列 `artifact_class`（纯追加，不破坏现有 kind），把三类产物显式化：

| artifact_class | 包含什么 | 现有落地 |
|---|---|---|
| `delivery`（交付产物） | 源码文件、脏工作区、git commit、外部系统产物（PR/MR） | file/git_dirty 已有（`collect.ts:58-61`）；git_commit/external 需补采集（审计 A G7） |
| `process`（过程产物） | 人的决定（decision）、批准（approval）、验收（acceptance 记录）、决策依据版本、证据快照、checkpoint/恢复包、对账结果 | 证据快照已有（`collect.ts:26,62-63`）；acceptance 在 `mgmt_acceptances`；对账在 `mgmt_external_effects`；handoff packet 需升格为 artifact（G8）；decision/approval 需补入库（G2） |
| `runtime`（运行产物） | 日志、测试结果、工具回执、task_event 摘要 | `mgmt_exec_records` 空表待启用（审计 A §4）；orchestrator 落盘的 diff.patch/checks.txt/runner.log（`evidence.ts:95`）需入库 |

`kind` 列继续做细粒度形态区分，扩值为：`file | git_commit | git_dirty | external | decision | approval | acceptance_record | checkpoint | recovery_packet | reconciliation | tool_receipt | test_result | log`。这些值在 DDL 注释里声明，运行时由采集函数硬编码写入，不靠用户填。

> 设计理由：decision/approval 之所以历史上放在 `mgmt_inputs`（"喂给 agent 的上下文"），是因为它们本质是"给后续执行的输入约束"。本方案不否定这一点——decision/approval 同时是 Artifact（有内容、有版本、有 sensitivity）和 Input（约束后续执行）。做法是：它们先登记为 process 类 Artifact 拿到 version，再由 `mgmt_inputs` 用 `UNIQUE(work_id, kind, version)`（`src/manage/schema.ts:38`）引用该 version，而不是把正文复制一份。这样既消灭 G2，又保留 inputs 的版本链语义。

### 2.2 ArtifactVersion 设计

**复用现有 `mgmt_artifact_versions`**，不另建表。它已经具备内容寻址骨架：

- PK `version_id = hash(artifact_id, content_kind, content_sha256)`（`src/manage/identity.ts:7`），INSERT OR IGNORE 幂等（`collect.ts:62`）——同一内容重复采集不产生新版本。
- 已有 `content_sha256`（快照字节哈希）、`snapshot_path`、`snapshot_state`（8 值，现仅用 3 个）、`sensitivity`、`producer`、`observed_at/evidence_at`、`stale_capture`。

本方案对它的修正（详见 §3）：

- 补齐 `scanner_version` 写入（现恒 0，`collect.ts:62` INSERT 列清单遗漏；且 `classify.ts:1` 导出字符串 `"1"` 与 DDL INTEGER 类型不匹配——统一为 INTEGER）。
- 修正 `shareable`：从"恒 0"改为由授权流程翻转（见 §3.5）。
- `content_kind='metadata_only'`、`snapshot_state` 的 lost/too_large/pruned/write_failed 补齐写入点。
- **关键修正**：`content_sha256` 必须成为 chunk 哈希闭环的基准（见 2.4），不再被 context 侧绕过。

### 2.3 ContextChunk 设计（新增表）

chunk 是 artifact_version 的**只读投影**，表放 control 库（与 mgmt 同库，迁移见 `store.ts:157 ensureMgmtSchema`），命名 `control_context_chunks`：

```text
control_context_chunks(
  chunk_id          TEXT PRIMARY KEY,          -- sha256(artifact_id|version_id|byte_start|byte_end)
  artifact_id       TEXT NOT NULL,
  version_id        TEXT NOT NULL,
  -- 从属关系：复合 FK 指向 artifact version
  FOREIGN KEY(artifact_id, version_id) REFERENCES mgmt_artifact_versions(artifact_id, version_id),
  byte_start        INTEGER NOT NULL,          -- 快照字节范围
  byte_end          INTEGER NOT NULL,
  semantic_unit     TEXT NOT NULL,             -- 切分单位：file_region | diff_hunk | log_segment | decision_text | ...
  chunk_sha256      TEXT NOT NULL,             -- sha256(该字节区间内容)，等于父 version content_sha256 的一个切片哈希
  summary_short     TEXT,                       -- 该 chunk 的短摘要（一行/一段）
  summary_long      TEXT,                       -- 该 chunk 的长摘要（可由模型生成，见 2.5）
  prev_chunk_id     TEXT,                      -- 邻接：前一个 chunk（同 version 内有序）
  next_chunk_id     TEXT,
  stale             INTEGER NOT NULL DEFAULT 0, -- 产物出新版后置 1，绝不原地改正文
  derived_at        INTEGER NOT NULL,
  UNIQUE(artifact_id, version_id, byte_start, byte_end)
)
```

要点：

- **永远从属 artifact_version**：复合 FK 保证 chunk 不能悬空引用不存在的版本。产物更新 = 新 version 行 + 全新一组 chunk；旧 version 的旧 chunk 整组保留，`stale=0` 的历史语义不变，供 pin 旧版回放。
- **chunk hash 闭环**：`chunk_sha256` 直接对快照文件字节切片算 sha256，与 `mgmt_artifact_versions.content_sha256`（整文件）同源。这样 §1.6 那个"哈希 9 列行 JSON"的错位被纠正——chunk 投影读的是 `snapshot_path` 的真实字节。
- **幂等切分**：chunk_id 由 `(artifact_id, version_id, byte_start, byte_end)` 内容寻址，重跑切分任务 INSERT OR IGNORE，同一 version 同一切片不会重复派生。
- **邻接关系**：prev/next 让装配器能在"需要更多上下文"时按字节序展开相邻 chunk，而不是整对象拉取。

### 2.4 ContextCandidate 设计（运行时结构 + 审计落库）

Candidate 不是持久权威，而是"某次问题/某次装配请求下，某个 chunk 的一份评分建议"。默认是**运行时结构**，同时落一份审计记录供可解释性与人审反馈。

运行时结构（装配器内存中）：

```text
ContextCandidate {
  chunk_ref:        { artifact_id, version_id, byte_start, byte_end }
  pass_visibility:  boolean      -- 是否已通过 visibility-policy 权限过滤（在评分之前）
  suggested_level:  hide|short|long|full   -- 模型建议，未经权限封顶不生效
  confidence:       number      -- 0..1，模型对该建议的置信度
  noul:             boolean     -- "not our understanding / 不确定"标记
  reasons:          string[]    -- 可解释理由（命中了问题里哪些词/语义、为什么这个级别）
  score:            number      -- 相关性分（仅用于已授权候选之间排序）
}
```

审计落库表 `control_context_candidate_log`（纯追加，不参与权威判断）：

```text
control_context_candidate_log(
  request_id      TEXT,          -- 一次装配请求一批候选同 request_id
  problem_id      TEXT,
  chunk_ref       TEXT,          -- artifact_id|version_id|range
  suggested_level TEXT,
  confidence      REAL,
  noul            INTEGER,
  reasons_json    TEXT,
  decided_level   TEXT,          -- 最终采用级别（确定性策略/人审覆盖后）
  decided_by      TEXT,          -- model | rule_floor | human_override
  created_at      INTEGER
)
```

这张表的用途：(a) 决策卡上"为什么这段只给 short"可回溯；(b) 收集 model vs human 的分歧，用于后续校准评分；(c) 满足 AGENTS.md"决策可解释"要求。

### 2.5 评分建议模型（含 noul / 不确定）+ 确定性策略兜底

**顺序红线：先权限，后评分。**

```
候选集来源：artifact_version → chunks
   → 第一步：visibility-policy 权限过滤（sensitivity / grant / share / work 绑定）
   → 第二步：只在 pass_visibility=true 的子集上跑评分
   → 第三步：确定性规则做下限兜底，模型只做增量建议
```

- **权限过滤复用现有 `src/control/visibility-policy.ts:98-163 checkVisibility`**，不改其判定语义（除修复 confirmed_secret 死锁，见 §3.5）。未通过权限的候选 `pass_visibility=false`，评分模型根本看不到它的正文，只能看到"存在一个不可见 chunk 挡住了相关证据"——**模型无法借评分把 confirmed_secret 的内容建议成 full**。
- **确定性策略（规则地板）兜底**：
  - 必需 chunk（决策卡载荷里的 conclusion/trigger/impact/options/owner 对应证据）不得建议 `hide`；
  - sensitivity 封顶沿用 `SENSITIVITY_CAP`（confirmed_secret→full、suspected→short、clean→full，`visibility-policy.ts:29-33`），模型建议不得越过 cap；
  - 预算硬上限沿用 assembler 的 budget 对半砍逻辑，模型建议级别只在预算内排序，不突破字节预算。
- **模型建议（Jev 风格，含 noul）**：在已授权候选上，模型输出 `suggested_level + confidence + noul + reasons`。
  - `noul=true` 或 `confidence < 阈值`：不自动选级别，把该候选连同"模型不确定"标记交给确定性地板规则，并在决策卡上显式标注"此处模型不确定，请人工判断证据级别"。**绝不用黑盒排序把不确定项静默塞进 Now 或 Inbox。**
  - 模型理由必须是结构化短句（命中问题词、语义相似 chunk、邻接上下文），进 candidate_log，供 UI 折叠展开。

### 2.6 权威源与投影边界

| 角色 | 表/模块 | 写权限 | 说明 |
|---|---|---|---|
| 权威：Artifact | `mgmt_artifacts` / `mgmt_artifact_versions` / `mgmt_acceptances` / `mgmt_exec_records` | manage 采集器（+ orchestrator 运行产物上报） | 唯一内容权威。chunk/candidate 都可从它重建 |
| 只读投影：Chunk | `control_context_chunks` | Core（投影任务） | 从 mgmt snapshot 字节切分派生；artifact_version 一变就重建新版 chunk，旧版标 stale |
| 只读审计：Candidate | `control_context_candidate_log` | Core（装配时写） | 不回写权威，只记录建议与最终决定 |
| 恢复现场：pin | `control_context_pins`（扩展到 chunk range） | Core | 钉 artifact_version + chunk_range |

**只读投影如何重建**：给定任意 artifact_version，重跑切分函数即可从 `snapshot_path` 字节幂等重建全部 chunk。chunk 表被清空后可无损再生——这正是"上下文是投影"的意义。重建不影响 pin：pin 钉的是 version + range，重建同 range 的 chunk_sha256 一致。

### 2.7 写 owner 边界（遵守既有四 owner 红线）

依据 `implementation-contract.md`：

- **Core**（`src/control/*`、shared 事件 kind）：拥有 `control_context_chunks`、`control_context_candidate_log` 的 DDL 与投影/装配逻辑；拥有 `CONTROL_SCHEMA_VERSION` 迁移；消费 mgmt 事件派生 chunk。**不得碰 mgmt 表的内容写入**（只在投影时读 snapshot 字节）。
- **Execution**（`src/orchestrator/*`）：context-collector 运行产物上报；补传 `problem_id`（修 1.7 断裂）；把 evidence.ts 落盘的运行产物登记为 runtime 类 Artifact。
- **Authorization**（`src/decision-bot/*`、extension）：评分模型建议本身（suggested_level/confidence/noul/reasons）作为一个可插拔评估器，输入是已通过权限过滤的候选摘要，**无权读未授权正文、无权改 visibility**。
- **Surface**（`src/web/*`、queries、notify、cli）：装配决策卡/任务包/恢复包的 UI 呈现，消费 Core 暴露的装配 API。
- **manage 采集器红线**：对 `control_works` 保持零写入（现状已遵守，审计 A §8）；**本方案要求把 manage 对 `control_attention` 的直写 SQL（`manifest.ts:284,323`、`relations.ts:55`、`launch.ts:53,69`、`submit.ts:461`）改为走 outbox 事件**，不再绕过 revision 乐观锁（见 §3.4）。

### 2.8 Problem（问题根）的创建、owner 与时机

这是 pool 从"恒空"变"可用"的关键缺口：`control_context_problem_objects` 需要先有 problem 行，`linkProblemObject`（`context-reducer.ts:223-225`）才有东西可挂。现状 `createProblem` 零生产调用方（核查报告 §2.22）。本方案明确：

- **谁创建**：**Core 拥有 problem 表与 `createProblem` 的生产入口**，但 problem 的"诞生信号"来自 Execution 侧的 work/task 生命周期，而非 Core 凭空造。
- **何时创建（三条触发路径，都幂等）**：
  1. **work 激活时建根问题（主路径）**：Execution 把一个 candidate work 激活为 active（`createWork`/`promoteWork` 已在 `control/store.ts`）时，同事务由 Core 调 `createProblem`，以 `problem_id = "prob:" + work_id` 为业务键建一条根 problem，绑定 work_id。这是"一个 work = 一个根问题树"的锚点，对应界面 Works 页的根节点。
  2. **首个 observation 到达时按需补建（兜底路径）**：若某条 `fact_observed` 事件带了 `problem_id` 但该 problem 行还不存在（例如老 session 先有 fact、work 后激活），Core reducer 在 `linkProblemObject` 前做一次 `INSERT OR IGNORE` 兜底建根，`problem_id` 沿用事件带来的值，`work_id` 从 payload 反查。这条路径只补不建全新语义，防止事实事件因缺 problem 行被丢进 quarantine。
  3. **人开新问题分支时建子问题**：Surface 在 Works 页"新建问题分支"（context-interaction-design §2.4）时调 Core 的 createProblem，挂到父 problem 下。
- **幂等策略**：`problem_id` 为业务主键，三条路径全部 `INSERT OR IGNORE`；重复到达的激活信号/observation 不产生重复 problem。`problem_id` 命名稳定（`prob:<work_id>`），保证 work 重激活、resume、handoff 续跑都钉到同一条 problem 行，而不是每次新开会话建一个新问题。 [未采纳，plan 性质命名选择差异]：实际实现为 sha256 派生 problem_id（context-pool.ts:181），非 prob:<work_id> 格式。
- **为什么不让 orchestrator 直接写 problem 行**：problem 表在 control 库，按四 owner 红线只有 Core 能写 control 库；orchestrator 只负责"发出激活/有事实"的信号（经事件或在调用 Core API 时传入），由 Core 落 problem 行。这样 problem 的并发创建仍走 Core 的事务与 revision，不出现 orchestrator 直写 control 表的越界。

---

## 3. 与现有实现的整合 / 迁移路径

### 3.1 选择：扩展 mgmt_artifacts，而不是新建平行层

**明确选择：在 `mgmt_artifacts` 上扩 `artifact_class` 与扩 `kind` 值，并新增 chunk/candidate 投影表。**

理由：

1. mgmt 已有完整的内容寻址、复合 FK（`mgmt_manifest_entries` 的 `(artifact_id, version_id)` FK，`src/manage/schema.ts:65-68`）、manifest digest、acceptance 失效链（`manifest.ts:301-329`）。新建平行产物库等于重写这套已验证的机制。
2. chunk 表放在 control 库做投影，权威仍在 mgmt，符合"上下文是投影"。
3. `control_context_objects` 现有的 ctype 体系不废弃——它承载 fact/objective/constraints/decision/scene 等**问题空间结构**；本方案新增的是"artifact → chunk"这条从属投影，两者通过 `problem_id` + `chunk_ref` 关联，不是替代关系。

### 3.2 schema 迁移策略（追加为主，敏感字段约束走单独的表重建迁移）

迁移分两类操作，不能都叫"纯追加"：

**A 类：真正的纯追加 DDL（在 schema version 3→4 内一次完成）。**
- 新增 `mgmt_artifacts.artifact_class` 可空列（TEXT，先可空）。
- 新增 `control_context_chunks`、`control_context_candidate_log` 两表（`CREATE TABLE IF NOT EXISTS`）。
- `control_context_pins` 扩可空列 `chunk_byte_start` / `chunk_byte_end`。
- 以上均为 SQLite 原生支持的非破坏性操作。

**A 类事务内必须紧跟一次回填（不能只加列不回填）：**
在 `ALTER TABLE mgmt_artifacts ADD COLUMN artifact_class TEXT` 之后，**同一事务内**立即执行基于现有 `kind` 列的幂等 CASE 回填：

```sql
UPDATE mgmt_artifacts
SET artifact_class = CASE
  WHEN kind IN ('file','git_commit','git_dirty','external') THEN 'delivery'
  WHEN kind IN ('decision','approval','acceptance_record','checkpoint',
                'recovery_packet','reconciliation')        THEN 'process'
  WHEN kind IN ('tool_receipt','test_result','log')          THEN 'runtime'
  ELSE 'delivery'   -- 历史只有 file/git_dirty，兜底 delivery
END
WHERE artifact_class IS NULL;
```

- 为什么必须在迁移事务内回填：P1 采集器/投影任务上线后会读 `artifact_class` 做分支，列存在但值为 NULL 会导致新行无法归类。`WHERE artifact_class IS NULL` 保证脚本可重复执行不覆盖新写入。
- **NOT NULL 约束的时机**：回填完成后**不**在 v4 立即加 `NOT NULL`（SQLite 加 NOT NULL 同样要重建表，见 B 类）。v4 阶段用应用层断言"新写入必须带 artifact_class"兜底；待 B 类表重建时一并把 `artifact_class` 固化为 NOT NULL。

**B 类：需要表重建的约束（不放在 v4，推迟到后续 schema version）。**
- SQLite **不支持 `ALTER TABLE ADD CHECK`，也不支持给已有列加 NOT NULL/CHECK**。凡是要给已有表补列约束的，都必须走"建新表 → 拷数据 → 删旧表 → 改名 → 重建索引/FK"的 12 步流程。
- 因此 §3.5 说的"给 `mgmt_artifact_versions.sensitivity` 补 CHECK"**不是纯追加 DDL，需要表重建**。本方案决定：
  - **v4 只做写入边界映射**（mgmt 写入时把 none/suspect/withheld 翻译成 clean/suspected/confirmed_secret，见 §3.5），**不加 CHECK、不重建表**。这样 v4 保持 A 类纯追加语义，旧行的旧词汇在写入边界被翻译，跨表查询靠翻译层而非 DB 约束。
  - **真正的 CHECK 固化推迟到后续 schema version（v5+）**，作为一次独立的表重建迁移：在一个事务内 `CREATE TABLE mgmt_artifact_versions_new`（带 sensitivity CHECK、artifact_class NOT NULL）→ 用映射后的 sensitivity 值 `INSERT INTO ... SELECT` 拷贝 → `DROP TABLE` 旧表 → `ALTER TABLE ... RENAME` → 重建复合唯一索引与所有外键引用。重建前先做整库备份，事务内 `PRAGMA foreign_keys=OFF` 重建后再 `ON`，失败整体回滚。
  - 这样既不违背"v4 纯追加可回退"，又把高风险的表重建隔离到独立版本、可单独回滚。

- **版本拒启**：复用现有机制——`src/control/store.ts:18 CONTROL_SCHEMA_VERSION = 3`，`ensureControlSchema` 在 `store.ts:162-163` 对"库版本 > 支持版本"抛 `blocked`、对相等直接返回；迁移链在 `store.ts:155-159 CONTROL_MIGRATIONS` 数组。v4 迁移函数（追加 DDL + artifact_class 回填）跑完后写 `control_schema_meta.version=4`。
  - 旧二进制遇到 v4 库：`version > 支持版本` → 拒启动（已有行为，无需新写）。
  - 新二进制遇到 v3 库：在事务内幂等执行 A 类 DDL 与回填，升级到 v4。
  - **回退**：A 类纯追加可回退——回退 = 把 `control_schema_meta.version` 降回 3 并停用新投影任务（新列/新表留着不删，不影响旧逻辑）。B 类表重建若发生在 v5，回退 = 恢复重建前备份。
- **mgmt 库 schema**：mgmt 侧 DDL 在 `src/manage/schema.ts`，本次只做 A 类（加 `artifact_class` 列 + 回填 + kind 注释扩值），不动现有 NOT NULL / FK；sensitivity 的 CHECK 固化随 B 类推迟。

### 3.3 现有 control_context_* 数据如何映射

- `control_context_objects` 里 `ctype='fact'` 的行：**保留不动**。它们是 runtime fact（test_result/code_state/...），本方案把对应的运行产物升级登记为 runtime Artifact 后，fact 对象用 `reference` 指向新 artifact_version，作为桥接；旧 fact 行继续可装配，不迁移历史数据。
- `ctype='artifact'` 的对象：生产本就零写入（审计 B §1），无历史包袱。新模型下不再用"整对象 + reference 字符串"表示产物，改用 chunk 从属投影。保留表结构，新写入路径写 chunk；旧测试 fixture 清理。
- `control_context_pins`：扩列 `chunk_byte_start` / `chunk_byte_end`（可空，空 = 钉整 version）。现有钉 object+revision 的行语义不变，新 pin 同时钉 version + range。
- `control_context_problem_objects`：保持表结构，**修复上游 problem_id 断裂后开始有数据**（见 4.3）。

### 3.4 事件与幂等、CAS、outbox、ingest 衔接（修复 manage 断点）

这是审计 A §7 / G3 指出的事件流断点：manage 不写 outbox，直写 `control_attention` 绕过 revision 锁。

- **mgmt 侧新增 outbox 事件**：manage 在 INSERT 新 artifact_version（`collect.ts:62`）成功后，同事务内 `enqueueControlEvent`（复用 `src/control/outbox.ts`）发 `artifact.version_stored`，payload 含 `{work_id, artifact_id, version_id, artifact_class, content_sha256, snapshot_path, sensitivity}`。
- **直写 SQL 改为事件**：`manifest.ts:284,323`、`relations.ts:55`、`launch.ts:53,69`、`submit.ts:461` 这些对 `control_attention` 的裸 SQL，改为发 outbox 事件（如 `attention.superseded` / `attention.upsert`），由 Core 的 `applyControlEvent`（`src/control/projection.ts:20-59`）在带 revision 的事务里投影，消除多 owner revision 竞争丢失。
- **ingest 衔接**：`artifact.version_stored` 事件经现有 outbox → spool → ledger 回执管道（`outbox.ts:52-105 publishControlEvents`）到达 Core，Core 消费后触发 chunk 投影任务。幂等沿用现有 envelope 校验（`src/ingest/ingest.ts:270-276` 要求 event_id/payload_hash/payload）。
- **CAS**：所有 attention 变更继续走 `upsertAttention` 的 `expected_revision` 乐观锁（`implementation-contract.md` 契约），manage 不再绕过。

### 3.5 sensitivity / grant / pin / purge / retention 统一（修复双词汇表）

- **sensitivity 词汇表统一**：现状 mgmt 用 `none/suspect/withheld`（`classify.ts:3`），control 用 `clean/suspected/confirmed_secret`（`src/control/store.ts:95`）。本方案**以 control 四值为唯一权威词汇**（unknown/clean/suspected/confirmed_secret，与 `shared/context-contract.ts:12 Sensitivity` 类型对齐）。v4 阶段在 mgmt **写入边界做映射**：`none→clean`、`suspect→suspected`、`withheld→confirmed_secret`，跨表查询靠翻译层，**不在 v4 补 DB CHECK**（SQLite 加 CHECK 需重建表，已推迟到 §3.2 的 B 类后续版本）。旧历史行保留旧词汇，读取时经同一映射函数归一。
- **修复 confirmed_secret 死锁**：现状建对象/share 禁止 confirmed_secret 带 grant（`context-pool.ts:301`、`context-pin.ts:205-207`），而 visibility 又要求 grant（`visibility-policy.ts:122-125`）→ 恒 forbidden（审计 B §6）。统一后：confirmed_secret 的授权路径显式开放——share 三元组 `(object_id, revision, shared_with_work)` 对 confirmed_secret 允许由 decision_owner 本人授予（fail-closed 只认 decision_owner，见 `context-pin.ts:168-180` 既有注释）；`SENSITIVITY_CAP[confirmed_secret]=full` 不再是死代码。
- **shareable**：新增授权 API 把 `mgmt_artifact_versions.shareable` 从 0 翻 1（修复 G4，现状恒 0）；跨 host handoff 时 `buildSharePackage`（`classify.ts:31-40`）的 shareable 维度才真正生效。
- **pin**：扩为钉 `artifact_version + chunk_range`；过期不再只靠读时返回 expired，增加后台清扫（见 4.6）。
- **purge / retention**：purge 现有 `purgeObjectContent`（`context-pin.ts:265-275`）置 `purged_at` 保留行；统一 retention 策略：chunk 随其 artifact_version 的保留策略走，version 被 prune 时 chunk 级联标 stale → purge。

---

## 4. 关键流程端到端

每步标注现有代码支撑点与缺口。

### 4.1 Agent 产出 / 人决策 / 工具回执 → 登记 Artifact/Version

- **交付产物（文件/脏区）**：已有。`collect.ts:42-72 collectExecution` 采集，`collect.ts:62` INSERT version。
- **运行产物（工具回执/测试结果/日志）**：缺口 → 启用空表 `mgmt_exec_records`（`schema.ts:114-119`）。Execution 的 `evidence.ts:77-97` 落盘后，追加一行 runtime Artifact（artifact_class=runtime，kind=tool_receipt/test_result/log），source_ref 去重。
- **人的 decision/approval**：缺口 → Surface/Authorization 记录人决策时，先登记 process Artifact（kind=decision/approval）拿 version，再写 `mgmt_inputs.kind=decision` 引用该 version（修复 G2；现 `store.ts:33` 只写 user_message）。
- **checkpoint/恢复包**：缺口 → 把 `mgmt_handoffs.packet` + git patch（`launch.ts:37-40`）升格为 process Artifact（kind=recovery_packet/checkpoint），享受版本化。
- **登记后**：发 `artifact.version_stored` outbox 事件（§3.4）。

### 4.2 切 chunk（何时切、谁切、幂等）

- **何时切**：消费 `artifact.version_stored` 事件后异步切；snapshot 未落盘（sensitivity 高 / snapshot_state≠stored）的 version 不切 chunk，chunk 投影留空并标记"正文不可投影"。
- **谁切**：Core 的投影任务（读 `snapshot_path` 字节，按语义单位切：文件按行/函数边界、diff 按 hunk、日志按段、decision 按段落）。
- **幂等**：chunk_id = sha256(artifact_id|version_id|byte_start|byte_end)，INSERT OR IGNORE；重跑不重复（§2.3）。切完算 `chunk_sha256`，与父 version 的 `content_sha256` 同源校验。

### 4.3 按问题生成候选与权限过滤

- **先有 problem 行**：work 激活时 Core 以 `problem_id="prob:<work_id>"` 建根 problem（§2.8 路径 1）；首个 observation 若带 problem_id 而行缺失，reducer 在 link 前 `INSERT OR IGNORE` 兜底（路径 2）。没有这一步，`linkProblemObject` 仍无行可挂。
- **修 problem_id 断裂**（最优先）：Execution 的 `orchestrator.ts:316-320 collectContextFacts` 调用时必须带上 problem_id（即 `prob:<work_id>`）；collector（`context-collector.ts:127`）透传；reducer 的 `linkProblemObject`（`context-reducer.ts:223-225`）开始执行，`control_context_problem_objects` 不再恒空。
- **生成候选**：装配时由 problem_id 选出相关 artifact_version → 展开其 chunks → 过 `checkVisibility`（权限过滤在前）→ 只对 pass 的候选评分。

### 4.4 模型建议可见级别

- 评分评估器（Authorization）输入：已授权 chunk 的 summary_short + 问题文本，输出 `suggested_level/confidence/noul/reasons`（§2.5）。
- 确定性规则地板叠加 cap 与预算；noul/低置信度不自动选级，交人（§5.4）。
- 结果写 `control_context_candidate_log` 审计。

### 4.5 人类决策卡 / Agent 任务包 / 恢复包按需装配

- **决策卡包**：复用 `assembleDecisionView`（`context-assembler.ts:325-427`），证据从空数组改为按 candidate 选出的 chunks；三级展开 short→long→full 沿用现有 fetchOnDemand（`context-assembler.ts:285-301`），但 full 取源改为读 chunk 对应字节区间（而非 9 列行 JSON），并用 `chunk_sha256` 复验（修复 §1.6 错位）。
- **Agent 任务包**：复用 `assembleAgentTask`（`context-assembler.ts:546`），objective/constraints 仍先找 pool、miss 回退 contract（L477-487,528-542），facts/decisions/artifacts 改为 chunk 候选。
- **恢复包**：现状 `assembleRecovery`（`context-assembler.ts:660-702`）**完全不读 pool**，纯透传 Execution 聚合（`recovery-context.ts:138-254`）。本方案让恢复包在透传之外，按需引用 checkpoint/recovery_packet 类 Artifact 的 chunk，使"从原 checkpoint 续跑"有产物版本可回溯（修复 AGENTS.md 闭环第 6 步的现场连续性）。

### 4.6 版本更新失效传播

- 产物出新 version → `collect.ts:67` 现有的 acceptance 失效（`invalidateAcceptances`，`manifest.ts:301-329`）保留。
- **补 chunk 失效**：新 version 入库后，旧 version 的 chunks 不删，但该 artifact 的新 chunk 组挂到新 version；装配时默认取最新 version 的 chunks。旧 version 的 chunk 仅被 pin 引用时才回放（pin 钉旧版，见 4.7）。
- **接通孤儿函数**：`markObjectUpdated` / `isStale` / `getStaleObjects`（`context-propagation.ts:15-96`）接入 `artifact.version_stored` 事件——事件到达即调用 `markObjectUpdated` 刷新 problem.updated_at，并在 chunk 表把被超越 version 的相关 chunk 标 stale。后台定期扫 `staleness_ms` 与过期 pin，不再只靠读时惰性判定（修复审计 B §8）。

### 4.7 决策后续跑与结果回流归档

- pin 钉 `artifact_version + chunk_range` → 人点"回到现场"走 jump 活会话（`shared/jump.ts`）；进程已终止的走 resume（`shared/resume.ts` + handoff checkpoint），从 pinned checkpoint 续跑，而非静默重启（AGENTS.md 闭环第 6 步）。
- 续跑结果：Execution 回执经 outbox 回流 → 决策卡变 done/succeeded/failed（`context-ingest.ts:243-247` 现有 upsert attention）→ 不再需要注意力的项自动归档（AGENTS.md 闭环第 8 步）。

---

## 5. 注意力产品约束（AGENTS.md 第一优先级）

chunk / 评分是内部机制，用户界面仍只表达 **Now / Inbox / Done** 与决策卡最小载荷，不暴露 Q1–Q5、ctype、chunk_id。

- **减少无效打断**：chunk 投影把海量运行噪声（日志/工具回执）压缩成少量候选 chunk；模型只在"必需证据缺失"或"noul 不确定"时才建议升级可见级别或提请人。普通进度不打断。
- **减少重建现场成本**：决策卡在一个视图内给出一句话结论、触发原因、关键证据（chunk short/long/full 三级展开）、影响、建议动作、责任人与时效、回现场 deep link、决策后续跑状态（对齐"决策卡最小载荷"）。人不必跳到原现场翻日志。
- **保证决策后续跑回流**：pin 钉 version+range，决策后从 checkpoint 续跑，结果经 outbox 回流归档（§4.7）。
- **评分不确定如何交人**：`noul=true` 或低置信度的候选，绝不靠黑盒排序决定进 Now 还是 Inbox——显式标注"模型不确定"，由确定性地板规则降级为 short/Inbox 并提示人工判断。Now 分区只承载风险/歧义/不可恢复失败/最终验收，不被模型噪声填满。
- **界面分层**：Now=必须立即处理；Inbox=可批量稍后处理；Done=已决策/已归档。chunk 与评分只在 drawer 证据三级展开里出现，不作为顶层导航。

---

## 6. 分阶段开发计划

owner 划分遵循 §2.7。每阶段标注契约与验收反例。

### 阶段 P0：接通断裂、建 problem、统一词汇（基础设施，无新功能）

- owner：Core（problem 表写入、迁移、outbox 投影）+ Execution（补传 problem_id、激活信号）。
- 依赖：无。
- 契约：
  - **problem 行生产化**：work 激活时 Core 调 `createProblem` 建 `prob:<work_id>` 根 problem；reducer 在 linkProblemObject 前对缺失 problem 行做 `INSERT OR IGNORE` 兜底（§2.8）。全部幂等，`problem_id` 为业务键。
  - Execution 在 `collectContextFacts` 补传 `problem_id="prob:<work_id>"`（`orchestrator.ts:316-320`）；collector（`context-collector.ts:127`）透传。
  - sensitivity 统一为 control 四值，v4 只做 mgmt **写入边界映射**（none→clean 等），**不补 DB CHECK**（CHECK 固化随 §3.2 B 类推迟）。
  - manage 对 `control_attention` 的直写 SQL 改走 outbox（§3.4）。
- schema：CONTROL_SCHEMA_VERSION 3→4，迁移事务内做：
  1. `ALTER TABLE mgmt_artifacts ADD COLUMN artifact_class TEXT`（先可空）；
  2. **同事务内**执行 §3.2 的 CASE 回填（file/git_commit/git_dirty→delivery，其余映射后兜底 delivery），`WHERE artifact_class IS NULL` 幂等；
  3. `CREATE TABLE IF NOT EXISTS control_context_chunks / control_context_candidate_log`；
  4. `control_context_pins` 加可空 chunk range 列；
  5. 写 `control_schema_meta.version=4`。NOT NULL / sensitivity CHECK 不在本版本加。
- 验收反例：
  - work 激活后 `control_context_problems` 出现 `prob:<work_id>` 行；重复激活/resume 不产生重复 problem；装配 decision_package 时 `control_context_problem_objects` 不再恒空（fact 对象能被选出）。
  - v4 迁移脚本可重复执行：第二次跑不报错、不重复回填、`artifact_class` 无 NULL；回退后 v3 二进制不读新列也正常启动。
  - 跨表读取 mgmt.sensitivity 经映射后不再出现 none/clean 两种词汇并存（v4 靠翻译层，不依赖 CHECK）。
  - manage 触发一次 attention 变更后，其他 owner 不会因 revision 竞争丢失更新。

### 阶段 P1：统一 Artifact 类型入库

- owner：manage 采集 + Execution。
- 依赖：P0。
- 契约：
  - `mgmt_artifacts` 加 `artifact_class`（delivery/process/runtime）；启用 `mgmt_exec_records`（runtime 产物入库）；decision/approval 登记为 process Artifact；handoff packet 升格。
  - 补写 scanner_version（INTEGER）、shareable 授权 API、git_commit 采集。
  - 每次新 version 发 `artifact.version_stored` 事件。
- 验收反例：
  - 一条工具回执在 mgmt 库有对应 runtime Artifact/Version 行，不再只散落在 ledger/journal。
  - 人的一次 decision 同时在 process Artifact 与 mgmt_inputs 有版本链，handoff packet 能拿到"之前人怎么定的"。
  - scanner_version 列不再恒 0；扫描规则升级后能识别旧扫描版本的 version。

### 阶段 P2：ContextChunk 投影

- owner：Core。
- 依赖：P1。
- 契约：`control_context_chunks` 表（§2.3）；消费 `artifact.version_stored` 异步切 chunk；chunk_sha256 对快照字节切片；full 取源改读字节区间并用 chunk_sha256 复验（修复 §1.6）。
- schema：追加 `control_context_chunks`，版本号已在 P0/P1 升到 4。
- 验收反例（本阶段重点）：
  - **跨版本 chunk stale**：artifact 出 v2 后，v1 的 chunk 保留且标 stale，装配默认取 v2 chunk；重建 v1 chunk 不影响 v2。
  - **chunk 重建幂等**：同 version 重跑切分，chunk_id 去重，行数不翻倍。
  - **full 取源闭环**：篡改 snapshot 文件字节后，full 取源 sha256 复验失败 → blocked(needs_context)，不再是 9 列行 JSON 自洽。
  - **必需 chunk 缺失 blocked**：决策卡必需证据 chunk 因 sensitivity 未授权而不可见时，卡片 blocked 并提示补授权，不造值。

### 阶段 P3：ContextCandidate 评分与可见级别建议

- owner：Authorization（评估器）+ Core（装配接入）。
- 依赖：P2。
- 契约：candidate 运行时结构 + `control_context_candidate_log`；权限过滤先于评分；确定性 cap/预算地板；noul/低置信交人。
- 验收反例：
  - **模型建议不能提权**：对 sensitivity=confirmed_secret 但无 grant 的 chunk，模型建议 full 被 cap 拦截，实际装配仍 forbidden（§3.5 修复后，仅 decision_owner 授予才 full）。
  - **sensitivity 越权**：模型评估器输入里看不到未通过 visibility 的 chunk 正文，只能看到"有不可见证据"。
  - **noul 交人**：低置信候选不被静默排进 Now，卡片显式提示人工判断证据级别。

### 阶段 P4：pin range、失效清扫、恢复包引用

- owner：Core + Execution。
- 依赖：P3。
- 契约：`control_context_pins` 扩 chunk range；后台扫过期/stale pin（接通 `markObjectUpdated/isStale`）；恢复包引用 checkpoint Artifact chunk。
- 验收反例：
  - **pin 钉旧版**：artifact 出 v2 后，钉 v1+range 的 pin 仍回放 v1 chunk，读时返回 pinned 而非 latest；过期 pin 被后台清扫而非无限残留。
  - **产物更新后旧决策失效**：v2 入库后，基于 v1 chunk 的决策卡标 stale，无"强制按旧结论走"按钮，只给"基于新依据发起范围变更"（对齐 context-interaction-design §5）。
  - **恢复现场连续性**：进程终止的会话从 pinned checkpoint 续跑；仍在 blocked-on-ask 的活会话 jump 回现场，而非静默重启。

### 成熟度诚实标注

- **底层已有可直接复用**：mgmt 内容寻址/复合 FK/manifest digest/acceptance 失效链、outbox→spool→ledger 回执管道、visibility 四级梯、on-demand 取源骨架、三类包装配函数、CONTROL_SCHEMA_VERSION 拒启。
- **本方案新增**：artifact_class 与 runtime/process 产物入库、control_context_chunks 表与切分投影、ContextCandidate 评分与 candidate_log、pin range、后台失效清扫、manage→outbox 事件改写、sensitivity 词汇统一、shareable 授权。
- **仅原型/待验证**：模型相关性评分器（suggested_level/confidence/noul）目前无生产模型接入，先以确定性规则地板 + 一个可插拔评估器接口落地，真实模型排序是后续迭代；恢复包对 pool 的引用目前是设计，未接线。

---

## 7. 风险与未决问题

### 7.1 技术风险

- **chunk 切分质量**：diff hunk / 日志段 / 代码函数边界的自动切分可能切错语义单元，导致 chunk 与问题相关性错位。缓解：先保守按字节/行切，semantic_unit 作为元数据后续细化；chunk 可重建，切分策略升级后重跑即可。
- **content_hash 迁移窗口**：现网 artifact 行的 content_hash 是 9 列行 JSON 哈希，切到 chunk_sha256（字节切片）后新旧 hash 不一致。缓解：旧 fact/object 行保留旧 hash 不迁移，新投影用新 hash；full 复验按 reference 类型分流。
- **大产物切分成本**：大文件/大日志切 chunk + 算哈希可能拖慢 `artifact.version_stored` 消费。缓解：异步投影任务、限流、超大产物只切边界 chunk 不切全文。

### 7.2 数据迁移风险

- `mgmt_artifacts.artifact_class` 回填已纳入 P0 迁移事务（§3.2 A 类、§6 P0），与 `ADD COLUMN` 同事务完成，`WHERE artifact_class IS NULL` 幂等，P1 采集器不会读到 NULL。回填按现有 `kind` 映射，不改变现有 manifest digest（manifest 由 `(artifact_id, version_id)` 决定，加列不影响 digest）。
- **sensitivity CHECK / artifact_class NOT NULL 是 B 类表重建操作**（§3.2），不在 v4：v4 只做写入边界映射，旧历史行保留旧词汇。表重建（新表→拷数据→删旧→改名→重建索引/FK）需整库备份、事务内完成、可单独回滚，是后续 schema version 的独立风险点。
- 旧二进制遇到 v4 库会拒启动（`store.ts:162`）——这是预期行为，但发布时需确保用户先升二进制再升库，避免误拒。

### 7.3 owner 边界冲突

- manage 改写 attention 写路径为 outbox 后，需与 orchestrator / decision-bot 的 attention 写入共用同一 revision 契约；多 producer 并发 upsert 同一 item 时要确认 `expected_revision` 语义不被事件投影绕过（`projection.ts` 的 ON CONFLICT revision 校验）。
- Authorization 的评分评估器只能拿到已授权摘要，存在"摘要本身泄漏敏感信息"的残余风险——需在摘要生成时过一次 sensitivity redact（`shared/redact.ts`）。

### 7.4 需要产品决策的未决问题

1. **noul/低置信候选的默认去向**：是降级进 Inbox 等人工批量处理，还是直接在决策卡上标注待判断？影响 Now/Inbox 分区纯度。
2. **chunk 摘要由谁生成**：short 摘要用规则抽取还是模型生成？模型生成摘要的成本与 sensitivity 泄漏边界需要产品拍板。
3. **confirmed_secret 授权粒度**：decision_owner 本人授予 share 时，是逐 chunk 授还是整 version 授？
4. **过期 pin 清扫策略**：过期 pin 是直接删除还是归档到 Done？影响历史决策回放能力。
5. **运行产物入库的保留窗口**：日志/工具回执量大，retention 多久后 prune？与 chunk 级联 purge 的边界。

---

## 附：关键证据索引（本方案引用）

- mgmt artifact kind 注释：`src/manage/schema.ts:44`；实际只写 file/git_dirty：`src/manage/collect.ts:58-61`
- artifact_versions DDL：`src/manage/schema.ts:47-56`；version INSERT：`src/manage/collect.ts:62`
- exec_records 空表：`src/manage/schema.ts:114-119`
- inputs 只写 user_message：`src/manage/store.ts:33-34`
- sensitivity 分类器：`src/manage/classify.ts:3,16-28`；control sensitivity CHECK：`src/control/store.ts:97（原 :95→:97）`
- manage 不写 outbox / 直写 attention：`src/manage/manifest.ts:284,323`、`relations.ts:55`、`launch.ts:53,69`、`submit.ts:461`
- acceptance 失效三路径：`manifest.ts:319`、`submit.ts:118`、`relations.ts:54`
- context ctype CHECK：`src/control/store.ts:80（原 :78→:80）`；唯一生产写入 ctype='fact'：`context-reducer.ts:198-200`
- artifact reference 正则：`visibility-policy.ts:48`；full 反查 mgmt：`on-demand-fetcher.ts:211-222`
- 装配规则分桶/预算：`context-assembler.ts:245-251,348-402,430-449`
- content_hash 契约：`src/shared/context-contract.ts:16-37`
- pin：`context-pin.ts:59-84`；confirmed_secret 死锁：`context-pool.ts:301`、`context-pin.ts:205-207`、`visibility-policy.ts:122-125`
- problem_id 断裂：`context-collector.ts:127`、`orchestrator.ts:316-320`、`context-reducer.ts:223-225`
- 失效孤儿函数：`context-propagation.ts:15-96`
- 恢复包不读 pool：`recovery-context.ts:138-254`、`context-assembler.ts:660-702`
- schema 版本拒启：`src/control/store.ts:18,162-163`
- 四 owner 契约：`docs/architecture/implementation-contract.md`
