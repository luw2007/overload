# 上下文进入产物方案 — 独立代码有效性核查报告

- 核查日期：2026-09-24
- 核查人：独立第三方（未参与方案撰写与前期审计）
- 方式：只读分析，逐条回到 `src/` 真实代码验证，不信任方案与审计报告中的断言
- 待核查方案：`docs/plans/context-as-artifact-20260924.md`

---

## 1. 核查范围与方法

通读方案全文，提取所有"已有/复用/现状"类关键断言共 28 条，覆盖方案指定的全部断言类别。每条断言回到对应 `file:line` 验证，输出对照表。未修改任何文件。

---

## 2. 逐条断言对照表

### 2.1 mgmt_artifacts.kind 枚举与实际写入值

| 项目 | 内容 |
|---|---|
| 方案断言 | "kind DDL 声明 4 值（file\|git_commit\|git_dirty\|external，schema.ts:44），实际只写 file 和 git_dirty（collect.ts:58-61）" |
| 代码证据 | `schema.ts:44` 注释 `-- kind ∈ file\|git_commit\|git_dirty\|external`；`identity.ts:6` 类型 `kind: "file"\|"git_commit"\|"git_dirty"\|"external"`；`collect.ts:58` INSERT `'file'`（read 路径）；`collect.ts:59` INSERT `'file'`（attempted_modify 路径）；`collect.ts:61` `row.kind` 来自 `capture()`，而 `capture()` 的 kind 参数由 `collect.ts:50` 传 `"file"`、`collect.ts:53` 传 `"git_dirty"`。grep 全仓无 `'git_commit'` 或 `'external'` 的 INSERT。 |
| 判定 | ✅成立 |
| 备注 | `manifest.ts:106` 只聚合 `kind IN ('file','git_dirty')`，进一步佐证 git_commit/external 不在 manifest 范围内。 |

### 2.2 mgmt_artifact_versions 字段语义与写入点

| 项目 | 内容 |
|---|---|
| 方案断言 | 已有 content_sha256、snapshot_path、sensitivity、producer、stale_capture；scanner_version 现恒 0（INSERT 列遗漏）；shareable 恒 0（无授权流程）；snapshot_state 8 值现仅用 3 个 |
| 代码证据 | `collect.ts:62` INSERT 列清单：`version_id, artifact_id, content_kind, content_sha256, snapshot_path, staging_name, snapshot_state, sensitivity, producer, stale_capture, observed_at, evidence_at`。**未包含 scanner_version、shareable、history_available** → 三者取 DDL 默认值（0/0/1）。`collect.ts:61` snapshotState 三分支：`pending`（有 snapshot）/ `withheld_sensitive`（敏感）/ `reference_only`（兜底）；`collect.ts:70` rename 后 UPDATE 为 `stored`。`classify.ts:1` 导出 `SCANNER_VERSION = "1"`（字符串），DDL 是 INTEGER（`schema.ts:53`），且未传入 INSERT。 |
| 判定 | ✅成立 |
| 备注 | snapshot_state 实际命中的运行时值为 pending→stored 与 withheld_sensitive 共 3 个；reference_only 是理论兜底分支（sensitivity=none 时 snapshot 必然已设置，见 `collect.ts:26`），实际可能不触发。方案说"现仅用 3 个"准确。 |

### 2.3 mgmt_exec_records 是否空转

| 项目 | 内容 |
|---|---|
| 方案断言 | "整表空转（DDL 在 schema.ts:114-119，grep 无任何 INSERT/SELECT）" |
| 代码证据 | `grep -rn "mgmt_exec_records" src/` 仅命中 `schema.ts:114` 一处（DDL 定义）。无任何 INSERT/UPDATE/SELECT。 |
| 判定 | ✅成立 |

### 2.4 mgmt_inputs.kind 实际写入值

| 项目 | 内容 |
|---|---|
| 方案断言 | "DDL 声明 7 值，实际只写 user_message（store.ts:33-34）" |
| 代码证据 | `schema.ts:39` 注释 `-- kind ∈ user_message\|reference\|constraint\|decision\|approval\|acceptance\|feedback`；`store.ts:33-34` 硬编码 `'user_message'`：`INSERT OR IGNORE INTO mgmt_inputs(...,kind,...) VALUES(...,'user_message',...)`。 |
| 判定 | ✅成立 |

### 2.5 sensitivity 双词汇表（mgmt vs control）

| 项目 | 内容 |
|---|---|
| 方案断言 | "mgmt 用 none/suspect/withheld（classify.ts:3），control 用 clean/suspected/confirmed_secret（store.ts:95）" |
| 代码证据 | `classify.ts:3` `export type Sensitivity = "none" \| "suspect" \| "withheld"`；`store.ts:95` `CHECK (sensitivity IN ('unknown','clean','suspected','confirmed_secret'))`。两套词汇无映射层。 |
| 判定 | ✅成立 |

### 2.6 manage 是否写 control_outbox

| 项目 | 内容 |
|---|---|
| 方案断言 | "manage 不写 outbox" |
| 代码证据 | `grep -rn "enqueueControlEvent" src/manage/` 零命中。manage 模块对 control 库的写入只有 control_attention 直写 SQL，不经过 outbox。 |
| 判定 | ✅成立 |

### 2.7 manage 对 control_works 是否零写入

| 项目 | 内容 |
|---|---|
| 方案断言 | "manage 对 control_works 保持零写入（审计 A §8）" |
| 代码证据 | `grep -rn "INSERT INTO control_works\|UPDATE control_works" src/manage/` 零命中。manage 仅通过 `store.ts:12` 调用 `createWork()`（control store 函数）间接创建 work，不直接写 SQL。 |
| 判定 | ✅成立 |

### 2.8 manage 对 control_attention 是否有裸 SQL 绕过 revision

| 项目 | 内容 |
|---|---|
| 方案断言 | "manifest.ts:284,323、relations.ts:55、launch.ts:53,69、submit.ts:461 直写 SQL 绕过 revision 乐观锁" |
| 代码证据 | `manifest.ts:284` `UPDATE control_attention SET state='resolved',effect_state='succeeded',revision=?,...`（手动管理 revision，不经过 upsertAttention 的 expected_revision 校验）；`manifest.ts:323` `UPDATE control_attention SET state='superseded',revision=revision+1,...`；`relations.ts:55` `UPDATE control_attention SET state='superseded',revision=revision+1,...`；`launch.ts:53` `INSERT INTO control_attention ... ON CONFLICT(item_id) DO UPDATE SET updated_at=excluded.updated_at`（revision 硬编码为 1）；`launch.ts:69` `UPDATE control_attention SET state='resolved',effect_state='succeeded',updated_at=? WHERE item_id=?`（不更新 revision）；`submit.ts:461` `INSERT OR IGNORE INTO control_attention(...,revision,...) VALUES(...,1,...)`（revision 硬编码为 1）。 |
| 判定 | ✅成立 |
| 备注 | 这 6 处确实绕过了 `upsertAttention` 的 CAS（expected_revision）机制。但注意：`manifest.ts:213` 的 `requestAcceptance` 是走 `upsertAttention` 的（带 revision 检查），`manifest.ts:284` 的 `recordAcceptance` 才是直写。 |

### 2.9 acceptance 失效路径

| 项目 | 内容 |
|---|---|
| 方案断言 | "acceptance 失效三路径：artifact 新版本（manifest.ts:319）、提交漂移（submit.ts:118）、work 合并/alias（relations.ts:54）" |
| 代码证据 | `manifest.ts:319` `UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason=? WHERE manifest_id=? AND verdict='accepted' AND invalidated_at IS NULL`；`submit.ts:118` `UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason='manifest_drift' WHERE acceptance_id=? AND invalidated_at IS NULL`；`relations.ts:54` `UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason='work_scope_changed' WHERE work_id=? AND verdict='accepted' AND invalidated_at IS NULL`。 |
| 判定 | ✅成立 |

### 2.10 control_context_objects ctype 枚举

| 项目 | 内容 |
|---|---|
| 方案断言 | "ctype CHECK ∈ (objective\|constraints\|fact\|decision\|artifact\|scene)" |
| 代码证据 | `store.ts:78` `CHECK (ctype IN ('objective','constraints','fact','decision','artifact','scene'))`。 |
| 判定 | ✅成立 |

### 2.11 createObject 生产调用方数量

| 项目 | 内容 |
|---|---|
| 方案断言 | "createObject 全仓生产调用方为 0" |
| 代码证据 | `grep -rn "createObject(" src/ --include="*.ts"` 排除 `.test.ts` 和定义本身，零命中。唯一生产写入路径是 `context-reducer.ts:197-200` 直接 INSERT（不经过 createObject 函数）。 |
| 判定 | ✅成立 |

### 2.12 context-reducer 硬编码 ctype='fact'

| 项目 | 内容 |
|---|---|
| 方案断言 | "唯一生产写入路径 context-reducer.ts:198-200 硬编码 ctype='fact'" |
| 代码证据 | `context-reducer.ts:197-200` `INSERT INTO control_context_objects(...,ctype,...) VALUES(...,?,...)` 其中第 4 个参数是字面量 `"fact"`。 |
| 判定 | ✅成立 |

### 2.13 reference="artifact:<id>@<ver>" 格式

| 项目 | 内容 |
|---|---|
| 方案断言 | "visibility-policy.ts:48 正则 /^artifact:.+@.+/" |
| 代码证据 | `visibility-policy.ts:48` `if (/^artifact:.+@.+/.test(reference)) return true;`。`on-demand-fetcher.ts:211` 用 `^artifact:([^@]+)@([^@]+)$` 拆解。 |
| 判定 | ✅成立 |

### 2.14 是否存在 chunk 表/函数/元数据

| 项目 | 内容 |
|---|---|
| 方案断言 | "完全不存在 chunk 切分。全仓非测试代码 grep chunk，命中全部是 I/O 字节缓冲" |
| 代码证据 | `grep -rn "chunk" src/ --include="*.ts"` 排除 test 和 I/O 相关词（chunked/chunk_size/buffer/readChunk/writeChunk），命中全部在 `decision-bot/runner.ts:143-162`（Uint8Array 拼接）、`ingest/cmux.ts:209-232`（文件读取分块）、`adapters/pi-broker.ts:14-165`（流处理）。与 context 无关。无 chunk 表、无 chunk hash、无字节范围列。 |
| 判定 | ✅成立 |

### 2.15 context-assembler 是否有模型相关性评分

| 项目 | 内容 |
|---|---|
| 方案断言 | "没有模型相关性评分，纯规则分桶 + 预算对半砍" |
| 代码证据 | `context-assembler.ts:245-251` `selectPoolObjects` 按 problem_id 查 `listObjectsByProblem`，顺序即 DB 返回序（`po.created_at, po.object_id`）。`context-assembler.ts:348-402` 按 role（=ctype）分桶，无打分。`context-assembler.ts:430-449` `applyDecisionViewBudget` 对半砍。`agent-task-context.ts:39-50` `factMatchesScope` 是子串 grep，注释 L37 自承"本专项不做语义匹配"。 |
| 判定 | ✅成立 |

### 2.16 context-assembler 的 hide/short/long/full 四级可见

| 项目 | 内容 |
|---|---|
| 方案断言 | "可见级别已有四级梯 hide\|short\|long\|full（visibility-policy.ts:6,21-26）" |
| 代码证据 | `visibility-policy.ts:6` `export type VisibilityLevel = "hide" \| "short" \| "long" \| "full"`；`L21-26` LEVEL_ORDER 映射 0-3。`L81-94` `defaultVisibility`：objective/constraints/scene→long，fact/decision/artifact→short。 |
| 判定 | ✅成立 |

### 2.17 content_hash 闭环（artifact 分支哈希的是行 JSON 还是快照字节）

| 项目 | 内容 |
|---|---|
| 方案断言 | "artifact 的 content_hash = sha256(9 列行 JSON)，与 mgmt_artifact_versions.content_sha256（快照文件字节哈希）无校验关系" |
| 代码证据 | `on-demand-fetcher.ts:214-221` SELECT 固定 9 列（artifact_id/kind/canonical_key/version_id/content_kind/content_sha256/snapshot_path/snapshot_state/sensitivity），返回 `JSON.stringify(row)`。`context-contract.ts:28` 注释 `artifact:<id>@<ver> → JSON.stringify(row) 的字节`。`submit.ts:166-167` 才真正读 snapshot 文件字节算 sha256 做发布校验。两者无交叉校验。 |
| 判定 | ✅成立 |

### 2.18 on-demand-fetcher 的 full 取源路径

| 项目 | 内容 |
|---|---|
| 方案断言 | "artifact 分支不读 snapshot_path 指向的快照文件字节，snapshot_path 只是作为一列字符串出现在行 JSON 里" |
| 代码证据 | `on-demand-fetcher.ts:214-221` 确实只做 SQL 查询 + JSON.stringify，不读文件系统。`on-demand-fetcher.ts:229-230` 对 git:/http:/未知 handle 返回 `unavailable`。code_state/external_state 的 reference 无 handler。 |
| 判定 | ✅成立 |

### 2.19 pin 粒度（object+revision）

| 项目 | 内容 |
|---|---|
| 方案断言 | "pin 钉住 (object_id, revision) 整版本，不是更细粒度" |
| 代码证据 | `store.ts:118-127` `control_context_pins` FK 到 `(object_id, revision)`。`context-pin.ts:59-84` `pinContext` 要求 object_id + revision。`context-pin.ts:96-115` `getPinnedVersion` JOIN 到 pinned revision 而非 latest。无 byte_start/byte_end/range 列。 |
| 判定 | ✅成立 |

### 2.20 confirmed_secret 死锁问题

| 项目 | 内容 |
|---|---|
| 方案断言 | "建对象/share 禁止 confirmed_secret 带 grant，而 visibility 又要求 grant → 恒 forbidden" |
| 代码证据 | `context-pool.ts:301` `if (sensitivity === "confirmed_secret" && shareable !== 0) throw ... "confirmed_secret objects cannot be shareable"`；`context-pin.ts:205-207` `if (version.sensitivity === "confirmed_secret") throw ... "confirmed_secret cannot be shared"`；`visibility-policy.ts:122-125` `if (sensitivity === "confirmed_secret") { if (!hasValidGrant(...)) return { allowed: false, code: "forbidden", ... } }`。三条合起来 = confirmed_secret 对象永远拿不到 grant，装配时恒 forbidden。 |
| 判定 | ✅成立 |

### 2.21 collector 不传 problem_id

| 项目 | 内容 |
|---|---|
| 方案断言 | "collector 从不传 problem_id（context-collector.ts:127 用 ctx.problem_id ?? null，而 orchestrator.ts:316-320 的 collectContextFacts 不传）" |
| 代码证据 | `context-collector.ts:127` `problem_id: ctx.problem_id ?? null`；`orchestrator.ts:316-320` `collectAndSpool({ orchestratorDb, work_id, actor, runtime_id }, spoolDir)` — 调用参数中无 problem_id 字段。 |
| 判定 | ✅成立 |

### 2.22 createProblem 零调用方

| 项目 | 内容 |
|---|---|
| 方案断言 | "createProblem 零生产调用方" |
| 代码证据 | `grep -rn "createProblem(" src/ --include="*.ts"` 排除 `.test.ts` 和 `export function createProblem` 定义，零命中。 |
| 判定 | ✅成立 |

### 2.23 control_context_problem_objects 恒空

| 项目 | 内容 |
|---|---|
| 方案断言 | "collector 不传 problem_id → linkProblemObject 永不执行 → control_context_problem_objects 恒空" |
| 代码证据 | `context-reducer.ts:223-225` `if (payload.problem_id) { linkProblemObject(...) }`。因 collector 侧 problem_id 恒为 null（见 2.21），此分支永不进入。表存在但生产无数据。 |
| 判定 | ✅成立 |

### 2.24 失效传播函数无生产调用方

| 项目 | 内容 |
|---|---|
| 方案断言 | "markObjectUpdated / isStale / getStaleObjects 均无生产调用方" |
| 代码证据 | `grep -rn "markObjectUpdated\|isStale(\|getStaleObjects" src/ --include="*.ts"` 排除 test 和定义本身，零命中。`context-assembler.ts:309-321` 内联了 `buildStaleMap`（等价逻辑），但不调用 `getStaleObjects`。 |
| 判定 | ✅成立 |

### 2.25 恢复包不读 pool

| 项目 | 内容 |
|---|---|
| 方案断言 | "assembleRecovery 完全不读 pool，纯透传 Execution 聚合（recovery-context.ts:138-254）" |
| 代码证据 | `context-assembler.ts:660-702` `assembleRecovery` 只用 `input.recovery_aggregated`，不调 `selectPoolObjects`，不查 control_context_* 表。`grep "control_context" src/orchestrator/recovery-context.ts` 零命中。 |
| 判定 | ✅成立 |

### 2.26 CONTROL_SCHEMA_VERSION 拒启机制

| 项目 | 内容 |
|---|---|
| 方案断言 | "ensureControlSchema 对库版本 > 支持版本抛 blocked" |
| 代码证据 | `store.ts:18` `export const CONTROL_SCHEMA_VERSION = 3`；`store.ts:162` `if(version>CONTROL_SCHEMA_VERSION)throw new ControlError("blocked",...)`。版本迁移链在 `store.ts:155-159` CONTROL_MIGRATIONS 数组（v1→v2→v3）。 |
| 判定 | ✅成立 |

### 2.27 manifest digest 计算方式

| 项目 | 内容 |
|---|---|
| 方案断言 | "manifest_id = sha256(canonical_json({work_id, repo_root, git_head, ..., entries sorted, verification sorted})).slice(0, 32)" |
| 代码证据 | `manifest.ts:38-54` `manifestDigest` 函数：entries 按 (artifact_id, version_id) 排序，verification 按 canonical JSON 排序，整体 canonical（递归排序 key）后 sha256 取前 32 hex。 |
| 判定 | ✅成立 |

### 2.28 复合 FK (artifact_id, version_id) 保证

| 项目 | 内容 |
|---|---|
| 方案断言 | "mgmt_manifest_entries 有复合 FK (artifact_id, version_id) → mgmt_artifact_versions" |
| 代码证据 | `schema.ts:65-68` `FOREIGN KEY(artifact_id, version_id) REFERENCES mgmt_artifact_versions(artifact_id, version_id)`；`schema.ts:56` 唯一索引 `mgmt_versions_artifact_version ON mgmt_artifact_versions(artifact_id, version_id)`。 |
| 判定 | ✅成立 |

---

## 3. 统计

| 判定 | 数量 |
|---|---|
| ✅ 成立 | 28 |
| ⚠️ 部分成立 | 0 |
| ❌ 不成立 | 0 |
| 🆕 需新增 | 0 |

**全部 28 条"已有/复用/现状"断言经独立代码验证均成立。** 方案对现状的描述高度准确，file:line 引用精确，无过度乐观或误导性陈述。

---

## 4. 独立方案评审

### 4.1 目标架构合理性

**复用 mgmt_artifacts 加 artifact_class + 新增 control_context_chunks 的选择是否最优？**

方案选择：不新建平行产物库，在现有 `mgmt_artifacts` 上加 `artifact_class` 分类列，新增 `control_context_chunks` 作为只读投影表。

**评审：合理，且优于替代方案。**

理由：
1. mgmt 已有完整的内容寻址（version_id = hash(artifact_id, content_kind, content_sha256)）、复合 FK、manifest digest、acceptance 失效链。新建平行产物库等于重写这套已验证机制。
2. chunk 从属 artifact_version 的方向正确——上下文是投影而非权威，符合 AGENTS.md "决策后能从原 checkpoint 续跑"的现场连续性要求。
3. 替代方案（如把 chunk 直接放在 mgmt_artifact_versions 表里加列）的问题：chunk 粒度远细于 version，一个 version 对应多个 chunk，强行放一行会破坏 1:1 的 version 语义。新建 chunk 表是正确的归一化选择。

**潜在改进点**：方案把 `control_context_chunks` 放在 control 库（与 mgmt 同库，见 `store.ts:157 ensureMgmtSchema`）。这意味着 chunk 投影任务需要跨库读 mgmt 表的 snapshot 文件字节。这个边界是清晰的（Core 只读 mgmt snapshot 文件，不写 mgmt 表），但需要确保投影任务的事务边界正确——读 snapshot 文件 + 写 chunk 表不应在一个 DB 事务里（文件 I/O 不应持锁）。

### 4.2 迁移可行性

**纯追加 DDL + schema version 3→4 是否真的安全？**

**评审：基本安全，但有两个需要注意的点。**

1. **纯追加 DDL 本身安全**：新增列（artifact_class）、新增表（chunks、candidate_log）、扩展 pins 表加可空列——都是 SQLite 支持的非破坏性操作。回退 = 把 schema_meta.version 降回 3，旧表新列留着不删。

2. **需要注意的点一：`artifact_class` 列需要回填**。现有 `mgmt_artifacts` 行的 artifact_class 必须回填为 'delivery'（file/git_dirty）。方案在 §7.2 提到了这一点，要求幂等回填脚本。这是正确的，但回填必须在迁移事务内完成，否则 P1 采集器读 artifact_class 时会遇到 NULL。

3. **需要注意的点二：sensitivity 词汇统一不是纯追加**。方案 §3.5 要求给 `mgmt_artifact_versions.sensitivity` 补 CHECK，并在写入边界做映射（none→clean 等）。这涉及：
   - 现有行的 sensitivity 值（none/suspect/withheld）与新 CHECK（unknown/clean/suspected/confirmed_secret）不兼容 → 加 CHECK 前必须先 UPDATE 迁移旧行，或者不加 CHECK 只在写入边界映射。
   - 方案说"补 CHECK"，但 SQLite 加 CHECK 约束需要重建表（SQLite 不支持 ALTER TABLE ADD CHECK）。这实际上不是纯追加 DDL，需要表重建。**这是方案中一个被低估的迁移复杂度点。**

4. **旧 control_context_* 数据桥接策略**：方案说"保留不动，新写入路径写 chunk，旧 fact 行继续可装配"。这是合理的——旧 fact 对象是 runtime fact，不影响新 chunk 投影。但需要确保 chunk 表上线后，assembler 的选对象逻辑同时读 problem_objects（旧路径）和 chunks（新路径），过渡期不会断流。

### 4.3 owner 边界

**Core/Execution/Surface 分工是否违反现有四 owner 红线？chunk 写入谁负责是否明确？**

**评审：基本合规，但有一个灰色地带。**

1. **Core 拥有 control_context_chunks 的 DDL 与投影逻辑**：符合——chunk 表在 control 库，Core 是 control 库的 owner。
2. **Execution 补传 problem_id + 登记 runtime Artifact**：符合——Execution 写 orchestrator DB 和 mgmt exec_records，不碰 control 库的核心表。
3. **Authorization 评分评估器只读已授权候选摘要**：符合——不读未授权正文，不改 visibility。
4. **Surface 消费装配 API**：符合。

**灰色地带**：方案 §3.4 要求"manage 在 INSERT 新 artifact_version 成功后，同事务内 enqueueControlEvent 发 artifact.version_stored"。这意味着 manage 模块要开始写 `control_outbox` 表。当前红线是"manage 不写 control 库（除了 attention 直写）"。写 outbox 是 manage → control 的新写入路径。

方案的理由是正确的（用 outbox 替代直写 attention SQL，走 revision 锁），但需要明确：manage 写 outbox 后，outbox 的消费方（Core 的 applyControlEvent）会投影到 control_attention。这意味着 manage 对 control_attention 的写入从"直写"变成了"事件→投影"，revision 竞争由投影层统一处理。这是改进，但需要确保 `projection.ts:42-49` 的 ON CONFLICT revision 校验能正确处理 manage 事件的 revision 语义。

### 4.4 遗漏检测

**方案是否遗漏了审计中发现的关键问题？**

逐条对照：

| 审计发现 | 方案是否回应 | 位置 |
|---|---|---|
| confirmed_secret 死锁 | ✅ 有回应 | §3.5 "修复 confirmed_secret 死锁" |
| shareable 空转 | ✅ 有回应 | §3.5 "新增授权 API 把 shareable 从 0 翻 1" |
| scanner_version 恒 0 | ✅ 有回应 | §2.2 "补齐 scanner_version 写入" |
| exec_records 空表 | ✅ 有回应 | §2.1 runtime 类、§4.1 "启用空表 mgmt_exec_records" |
| sensitivity 双词汇表 | ✅ 有回应 | §3.5 "sensitivity 词汇表统一" |
| mgmt→outbox 事件断点 | ✅ 有回应 | §3.4 "直写 SQL 改为事件" |
| chunk 完全缺失 | ✅ 有回应 | §2.3 新增 control_context_chunks |
| pool 生产空转（problem_id 断裂） | ✅ 有回应 | §4.3 "修 problem_id 断裂" |
| 失效传播孤儿函数 | ✅ 有回应 | §4.6 "接通孤儿函数" |
| createProblem 零调用方 | ⚠️ 部分回应 | 方案修了 problem_id 传递，但没有明确说"需要新增 createProblem 的生产调用方"。problem_id 从哪来？谁调用 createProblem？方案假设修了 collectContextFacts 传 problem_id 就够了，但如果 control_context_problems 表里根本没有 problem 行，listObjectsByProblem 还是空的。**这是一个遗漏：方案没有说明谁负责创建 problem 行。** |
| checkpoint/恢复包不是一等产物 | ✅ 有回应 | §4.1 "把 mgmt_handoffs.packet 升格为 process Artifact" |
| git_commit 产物未采集 | ✅ 有回应 | §2.1 "git_commit/external 需补采集" |
| acceptance 软失效后无重新验收路径 | ❌ 未回应 | 审计 A G9。方案没有提到"旧 acceptance 被 invalidate 后如何重新验收"的便捷路径。 |
| mgmt_summaries 空表 | ❌ 未回应 | 审计 A G11。方案没有提到 mgmt_summaries 的用途。 |
| mgmt_session_binding.role 未兑现 | ❌ 未回应 | 审计 A G10（resumed/explicit/orch_runner 无写入）。方案 §4.7 提到"从 pinned checkpoint 续跑"，但没有说要不要补 resumed role。 |

### 4.5 验收反例充分性

**分阶段计划中的验收反例是否真正可执行？是否覆盖了最关键的风险场景？**

**评审：大部分可执行，但有两个缺口。**

P0-P4 各阶段的验收反例覆盖了：
- pool 不再恒空（P0）
- sensitivity 词汇统一（P0）
- revision 竞争不丢失（P0）
- 运行产物入库（P1）
- scanner_version 不再恒 0（P1）
- chunk stale/重建幂等/full 哈希闭环/必需 chunk 缺失 blocked（P2）
- 模型建议不能提权/sensitivity 越权/noul 交人（P3）
- pin 钉旧版/产物更新后旧决策失效/恢复现场连续性（P4）

**缺口一**：P1 的验收反例"人的一次 decision 同时在 process Artifact 与 mgmt_inputs 有版本链"——但 decision/approval 的写入方是谁？方案 §4.1 说"Surface/Authorization 记录人决策时，先登记 process Artifact"，但没有验收反例验证 Surface/Authorization 是否真的会这么做。当前没有任何 Surface 或 Authorization 代码写 mgmt_inputs.kind='decision'。

**缺口二**：P0 的验收反例"manage 触发一次 attention 变更后，其他 owner 不会因 revision 竞争丢失更新"——但方案没有给出具体的测试方法。如何模拟两个 owner 并发修改同一 attention item 并验证不丢失？需要更具体的验收步骤。

### 4.6 与 AGENTS.md 注意力原则的一致性

**方案是否真正减少无效打断、减少重建现场成本？还是增加了内部复杂度但用户无感知收益？**

**评审：方向正确，但当前阶段收益主要是"基础设施打通"而非用户可感知的体验改善。**

对照 AGENTS.md 优先级：

1. **减少无效打断**：方案 P0-P1 主要是修断点和入库，不直接减少打断。P2-P3 的 chunk 投影 + 模型评分才是真正把"海量运行噪声压缩成少量候选 chunk"的机制。但模型评分本身是"仅原型/待验证"（方案 §6 末尾诚实标注）。

2. **减少重建现场成本**：P4 的 pin range + 恢复包引用 checkpoint Artifact 直接对齐 AGENTS.md "保留现场连续性"。这是用户可感知的改进——人不必跳到原现场翻日志。

3. **让决策可直接执行**：决策卡最小载荷（一句话结论/触发原因/证据/建议动作/责任人/deep link）在方案 §5 有明确对齐。

**总体判断**：方案的基础设施投入（P0-P2）是为了让后续的注意力压缩（P3-P4）成为可能。如果只做到 P2 就停，用户感知不到收益——只是多了几张表和一些事件。方案自身在 §6"成熟度诚实标注"中承认了这一点。这是合理的工程节奏，但需要确保 P3-P4 不被无限期推迟。

---

## 5. 与旧认知差异清单

本次核查发现的、与"此前可能存在的旧认知"不同之处：

1. **旧认知可能认为 context pool 已在生产运行 → 实际 pool 生产空转**
   - collector 不传 problem_id → problem_objects 恒空 → assembler selectPoolObjects 恒空。
   - 三类包（decision_view/agent_task）的 pool 侧实际退化为"contract 直读 + 空数组"。
   - 这不是"pool 运行但效果不好"，而是"pool 从未被生产数据填充过"。

2. **旧认知可能认为 mgmt artifact 已覆盖三类产物 → 实际只写 file/git_dirty 两种**
   - mgmt_artifacts.kind DDL 声明 4 值，实际只写 2 个。
   - mgmt_inputs.kind DDL 声明 7 值，实际只写 1 个（user_message）。
   - mgmt_exec_records 整表空转。
   - 即 mgmt 体系当前只追踪"文件和脏工作区"，决策/验收/运行产物全部不在产物体系内。

3. **旧认知可能认为 content_hash 闭环是完整的 → 实际 artifact 分支哈希对象错位**
   - task_event/journal/contract/attention 四条链有闭环，但 artifact 分支哈希的是 9 列行 JSON 而非 snapshot 字节。
   - mgmt_artifact_versions.content_sha256（快照文件字节哈希）与 context 侧的 content_hash（行 JSON 哈希）是两套独立哈希，互不校验。

4. **旧认知可能认为 confirmed_secret 有授权路径 → 实际是自相矛盾的死锁**
   - 建对象/share 禁止 confirmed_secret 带 grant，visibility 又要求 grant。
   - SENSITIVITY_CAP[confirmed_secret]="full" 是死代码。
   - 即 confirmed_secret 对象在当前代码下永远不可见，不是"可以授权后可见"。

5. **旧认知可能认为 manage 与 control 之间有事件流 → 实际是直写 SQL 绕过锁**
   - manage 不写 outbox，直接 UPDATE control_attention。
   - 6 处裸 SQL 绕过 upsertAttention 的 expected_revision CAS。
   - 多 owner 并发修改同一 attention item 时可能丢失更新。

6. **旧认知可能认为失效传播机制已接线 → 实际是孤儿函数**
   - markObjectUpdated/isStale/getStaleObjects 三个函数写好了但零生产调用方。
   - staleness_ms 列存在但无人读。
   - 旧 version 行不被标记 stale，靠 assembler 装配时内联比较 revision。

7. **旧认知可能认为恢复包有上下文证据 → 实际恢复包纯透传不读 pool**
   - assembleRecovery 不查 control_context_* 表，完全依赖 Execution 侧聚合。
   - 恢复包的"证据"全部来自 orchestrator DB（task_events/tasks），不包含 mgmt artifact 或 context object。

---

## 6. 最终结论

### 方案是否可进入开发？

**可以进入开发，但需要先修正以下问题：**

#### 必须修正（阻塞开发）

1. **sensitivity CHECK 约束不是纯追加 DDL**。方案 §3.2 声称"纯追加 DDL + 旧版拒启"，但 §3.5 要给 `mgmt_artifact_versions.sensitivity` 补 CHECK 约束。SQLite 不支持 ALTER TABLE ADD CHECK，需要重建表。这与"纯追加"矛盾。方案需要明确：要么不加 CHECK（只在写入边界做映射），要么把 sensitivity 迁移列为独立的表重建步骤（需要备份 + 数据拷贝 + 重命名）。

2. **createProblem 的生产调用方未定义**。方案修了 problem_id 传递（P0），但 control_context_problems 表里需要有 problem 行才能 linkProblemObject。谁创建 problem？什么时候创建？方案没有说明。这是 pool 从空转变为可用的关键缺口。

3. **artifact_class 回填必须在迁移事务内完成**。方案 §7.2 提到了回填脚本，但没有把它放入 P0 的 schema 迁移步骤。P1 采集器读 artifact_class 时如果遇到 NULL 会出错。回填必须与 ALTER TABLE ADD COLUMN 在同一事务。

#### 建议修正（不阻塞但需补充）

4. **P1 验收反例中"decision 入库"需要明确写入方**。当前没有任何 Surface/Authorization 代码写 mgmt_inputs.kind='decision'。方案需要说明这个写入逻辑由谁实现、在哪个触发点执行。

5. **acceptance 失效后的"重新验收"路径**（审计 A G9）方案未回应。产物小改 → 人需要重新走 compute → insert → request → record 四步，打断决策流。这与 AGENTS.md "减少无效打断"原则相悖。

6. **chunk 投影任务的事务边界**。方案说"读 snapshot_path 字节 + 切 chunk + 写 chunk 表"，但文件 I/O 不应持 DB 事务锁。需要明确：先读文件算 chunk_sha256，再开事务 INSERT chunk 行。

### 核心结论摘要

方案对现状的 28 条断言全部经独立代码验证成立，file:line 引用精确，无过度乐观。目标架构（复用 mgmt_artifacts + chunk 投影）方向正确，符合"上下文是投影而非权威"的设计原则。主要风险在于：sensitivity 词汇统一的 DDL 复杂度被低估（不是纯追加）、createProblem 生产调用方缺失、以及 P3-P4 的模型评分和恢复包引用目前仍是设计而非已验证原型。建议修正上述 3 个阻塞问题后进入 P0 开发。
