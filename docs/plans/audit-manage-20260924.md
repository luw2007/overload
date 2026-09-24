# Manage / Artifact 体系与跨切面事件流 — 只读代码审计

审计日期：2026-09-24
审计范围：`src/manage/` 全部 13 个文件 + `src/ingest/{reducer,ingest,classifier}.ts` + `src/decision-bot/policy.ts` + `src/orchestrator/evidence.ts` + `src/web/mgmt-routes.ts`
审计方式：只读通读，未修改任何文件。

---

## 0. 文件存在确认与行数

| 文件 | 存在 | 行数 | 备注 |
|---|---|---|---|
| `src/manage/schema.ts` | 是 | 180 | DDL 全量 |
| `src/manage/manifest.ts` | 是 | 373 | digest / acceptance / invalidate |
| `src/manage/collect.ts` | 是 | 72 | 行极长（压缩风格），实际逻辑密度高 |
| `src/manage/submit.ts` | 是 | 558 | 提交/漂移校验/external effects |
| `src/manage/relations.ts` | 是 | 114 | alias / link correction / hints |
| `src/manage/source.ts` | 是 | 160 | local + SSH SourceFs |
| `src/manage/handoff.ts` | 是 | 69 | preconditions / packet / create |
| `src/manage/identity.ts` | 是 | 13 | id 派生 |
| `src/manage/launch.ts` | 是 | 69 | launch / worktree / reconcile |
| `src/manage/archive.ts` | 是 | 26 | closeout + archive |
| `src/manage/classify.ts` | 是 | 40 | sensitivity 扫描 |
| `src/manage/manage.ts` | 是 | 81 | scanOnce 主编排 |
| `src/manage/store.ts` | 是 | 43 | createDiscoveredWork / bindExecution / addInputs |
| `src/ingest/reducer.ts` | 是 | 236 | journal → current/queue |
| `src/ingest/ingest.ts` | 是 | 357 | spool 入站主流程 |
| `src/ingest/classifier.ts` | 是 | 119 | Q1–Q5 判定 |
| `src/decision-bot/policy.ts` | 是 | 193 | 规则 + candidate 生命周期 |
| `src/orchestrator/evidence.ts` | 是 | 105 | diff/commit/checks 证据收集 |
| `src/web/mgmt-routes.ts` | 是 | 170 | mgmt HTTP API |
| `src/decision-bot/policy-candidate.ts` | **否** | — | 仅有 `policy-candidate.test.ts`；生产逻辑内联在 `policy.ts:129-145` |
| `src/decision-bot/propose-from-attention.ts` | **否** | — | 仅有 `propose-from-attention.test.ts`；生产函数 `proposeRuleFromAttention` 内联在 `policy.ts:170-185` |

---

## 1. mgmt_artifacts.kind 枚举

**结论：枚举声明 4 个值，实际只写入 2 个。**

- DDL 注释声明：`kind ∈ file|git_commit|git_dirty|external` — `src/manage/schema.ts:44`
- TS 类型签名同样允许 4 值：`artifactId(workId, kind: "file"|"git_commit"|"git_dirty"|"external", canonicalKey)` — `src/manage/identity.ts:6`
- **实际写入点**：
  - `collect.ts:58,59`：硬编码 `'file'`（read / attempted_modify 路径）
  - `collect.ts:61`：`row.kind` 来自 `capture()`，而 `capture()` 的 `kind` 参数由 `collect.ts:50` 传 `"file"`、`collect.ts:53` 传 `"git_dirty"`
  - 没有任何代码写入 `git_commit` 或 `external`
- `computeManifest` 只聚合 `a.kind IN ('file','git_dirty')` — `manifest.ts:106`，进一步说明 git_commit/external 不在 manifest 范围内。

**三类产物覆盖情况**（对照目标模型"交付产物 / 过程产物 / 运行产物"）：

| 目标类别 | 落地位置 | 状态 |
|---|---|---|
| 交付产物（源码文件） | `mgmt_artifacts(kind='file')` + `mgmt_artifact_versions` | 已有实现 |
| 交付产物（脏工作区） | `mgmt_artifacts(kind='git_dirty')` + versions | 已有实现 |
| 交付产物（git commit） | `mgmt_artifacts(kind='git_commit')` | **仅有表结构无逻辑**（DDL/类型声明，无写入路径） |
| 交付产物（外部系统产物） | `mgmt_artifacts(kind='external')` | **仅有表结构无逻辑** |
| 过程产物（人的决定/decision） | `mgmt_inputs(kind='decision')` | **仅有表结构无逻辑**（见 Q3） |
| 过程产物（approval/acceptance） | `mgmt_acceptances` + `mgmt_inputs(kind='acceptance')` | acceptance 表有完整逻辑（`manifest.ts:247-299`）；inputs.kind='acceptance' 无写入 |
| 过程产物（证据快照） | `mgmt_artifact_versions.snapshot_path` + `mgmt_observations` | 已有实现（`collect.ts:26,62-63`） |
| 过程产物（checkpoint / 恢复包） | `mgmt_handoffs.packet` + git patch（`launch.ts:37-40`） | 已有实现，但 handoff packet 不进 mgmt_artifacts |
| 过程产物（对账结果） | `mgmt_external_effects` | 已有实现（`submit.ts:488-515`） |
| 运行产物（日志/测试结果/工具回执） | `mgmt_exec_records` | **仅有表结构无逻辑**（见 Q4） |
| 运行产物（journal 事件） | ledger.db 的 `journal` 表（ingest 侧），不在 mgmt 库 | 已有实现，但与 mgmt 体系割裂 |

---

## 2. mgmt_artifact_versions 字段语义与写入点

**DDL** — `schema.ts:47-56`：

| 字段 | 语义 | 写入点 |
|---|---|---|
| `version_id` | PK，`hash(artifact_id, content_kind, content_sha256)` — `identity.ts:7` | `collect.ts:62` INSERT |
| `artifact_id` | FK → mgmt_artifacts | 同上 |
| `content_kind` | CHECK ∈ `('content','deleted','metadata_only')` — `schema.ts:49` | `collect.ts:24` 对删除传 `'deleted'`；`collect.ts:27` 对正常文件传 `'content'`；`metadata_only` **无写入点** |
| `content_sha256` | 内容哈希 | `collect.ts:24,27`（来自 `file.sha256`） |
| `snapshot_path` | 快照落盘路径 | `collect.ts:26` 仅当 `sensitivity==='none'` 时设置；否则 NULL |
| `staging_name` | 临时文件路径，落盘后清 NULL | `collect.ts:62` 写入 tmp 路径；`collect.ts:70` rename 后 UPDATE 为 NULL |
| `snapshot_state` | CHECK ∈ 8 值 — `schema.ts:51-52` | `collect.ts:61`：`pending`（待 rename）/`withheld_sensitive`（敏感不落盘）/`reference_only`（git_dirty 无文件）；`collect.ts:70` 落盘后 UPDATE 为 `stored`；`lost/too_large/pruned/write_failed` **无写入点** |
| `sensitivity` | 默认 `'unknown'` — `schema.ts:53` | `collect.ts:62` 写入 `row.sensitivity`（来自 `classifyContent`，值为 `none/suspect/withheld`） |
| `scanner_version` | 默认 `0` — `schema.ts:53` | **collect.ts 从未写入此字段**，永远为 0。`classify.ts:1` 定义 `SCANNER_VERSION="1"`（字符串），但既未传入 INSERT，类型也不匹配（DDL 是 INTEGER） |
| `shareable` | 默认 `0`（不可分享）— `schema.ts:53` | **无任何代码写入此字段**，永远为 0。`buildSharePackage`（`classify.ts:31-40`）读 `shareable` 字段并基于它决定是否省略，但因为永远为 0，所有非敏感产物也会被省略 |
| `producer` | `<execution_id>\|multiple\|unknown` — `schema.ts:53` 注释 | `collect.ts:50` 传 execution_id；`collect.ts:53` 传 `"unknown"`（git_dirty）；`collect.ts:40` 竞争时 UPDATE 为 `"multiple"` |
| `history_available` | 默认 1 | **无写入点**，恒为 1 |
| `stale_capture` | 默认 0 | `collect.ts:61`：`now - row.evidenceAt > 60_000` 时置 1 |
| `observed_at` | 采集时间 | `collect.ts:62` 写 `now` |
| `evidence_at` | 事件原始时间 | `collect.ts:62` 写 `row.evidenceAt` |

**版本如何创建**：纯 INSERT OR IGNORE（`collect.ts:62`），以 `version_id`（内容哈希）为幂等键。同一文件同一内容重复采集不会创建新版本；内容变化 → 新 sha256 → 新 version_id → 新行。

**版本失效传播机制**：
- `collect.ts:67`：当 `insertedVersion` 为 true（即本次有新版本入库），调用 `invalidateAcceptances(db, ownerWorkId, "artifact_version_changed", now)`
- `manifest.ts:301-329` `invalidateAcceptances`：找出"已被同 artifact 后续版本超越"的 manifest，把其 `mgmt_acceptances.invalidated_at` 置时间戳，并把对应 `control_attention` 卡片置为 `superseded`
- **但版本行本身不做软删除/失效标记**：旧 version 行永久保留，靠 `observed_at` 排序由 `computeManifest`（`manifest.ts:106`）取最新

---

## 3. mgmt_inputs.kind 枚举与 decision/approval/acceptance 归属

**DDL 注释声明**：`kind ∈ user_message|reference|constraint|decision|approval|acceptance|feedback` — `schema.ts:39`

**实际写入点**：`store.ts:33-34` 硬编码 `'user_message'`。仅此一个 kind 有生产写入路径。

- `reference`、`constraint`、`decision`、`approval`、`acceptance`、`feedback`：**完全缺失生产写入逻辑**（仅有 test 可能覆盖）。

**为什么 decision/approval/acceptance 放在 inputs 而不是 artifacts？**

设计意图（从 schema 注释和 `handoff.ts:45` 的 packet 构造推断）：
- `mgmt_inputs` 是"喂给 agent 的上下文"，按 `UNIQUE(work_id, kind, version)` 做版本链（`schema.ts:38`），`supersedes` 指向上一版本（`store.ts:34`）
- 人的决定本质上是"给后续执行的输入约束"，所以归入 inputs 而非 artifacts
- 但当前实现里：
  - **人的 acceptance 实际存在 `mgmt_acceptances` 表**（`manifest.ts:267`），不在 `mgmt_inputs`
  - `mgmt_inputs.kind='acceptance'` 是一个**未兑现的占位设计**——acceptance 同时被建模为 inputs（按设计）和 acceptances 表（按实现），两套模型并存但后者独立演进
  - decision / approval 没有独立的表，也没有 inputs 写入路径——**完全缺失**

---

## 4. mgmt_exec_records

**DDL** — `schema.ts:114-119`：
- `kind TEXT NOT NULL`：**无 CHECK 约束**
- `source_ref TEXT NOT NULL UNIQUE`
- `source_state` DEFAULT `'available'`
- `tool`、`excerpt`、`is_error`
- `sensitivity` / `scanner_version` / `shareable`：与 artifact_versions 同构字段，shareable 默认 0

**实际使用**：`grep -rn "mgmt_exec_records" src/` 仅命中 `schema.ts:114` 一处。**无任何 INSERT/UPDATE/SELECT**。

结论：
- **kind 无约束**：DDL 没写 CHECK，且因为表根本没被使用，也没有运行时校验
- **存了什么**：设计上打算存工具回执、日志、测试结果等运行产物
- **sensitivity/shareable**：字段已建，但永远是默认值（unknown / 0）
- **状态**：**仅有表结构无逻辑**。运行产物目前散落在 ledger.db 的 `journal` 表（ingest 侧）和 `orchestrator/evidence.ts` 落盘的 diff.patch / checks.txt / runner.log（`evidence.ts:95`），但这些都不进入 mgmt 库。

---

## 5. sensitivity 体系一致性

**mgmt 侧**：
- DDL：`sensitivity TEXT NOT NULL DEFAULT 'unknown'`，**无 CHECK** — `schema.ts:53`、`schema.ts:118`、`schema.ts:37`
- 分类器输出：`"none" | "suspect" | "withheld"` — `classify.ts:3`
- 路径 denylist 直接返回 `withheld` — `classify.ts:19`
- 二进制检测返回 `suspect` — `classify.ts:22`
- 密钥模式命中返回 `withheld` — `classify.ts:27`

**control 侧**：
- `sensitivity TEXT NOT NULL DEFAULT 'unknown' CHECK (sensitivity IN ('unknown','clean','suspected','confirmed_secret'))` — `src/control/store.ts:95`

**两侧枚举不一致**：

| 维度 | control 侧 | mgmt 侧（实际写入） |
|---|---|---|
| 默认值 | unknown | unknown |
| 非敏感 | `clean` | `none` |
| 可疑 | `suspected` | `suspect` |
| 已确认敏感 | `confirmed_secret` | `withheld` |

mgmt 侧 DDL 没有 CHECK，所以不会报错，但跨表 JOIN 或统一查询时会出现两套词汇表。

**scanner_version 字段作用**：
- DDL 注释（`schema.ts:6-7`）说 §7.4 用于"扫描器版本演进时重扫"
- `classify.ts:1` 定义 `SCANNER_VERSION = "1"`（字符串）
- **但 collect.ts 的 INSERT 从未设置 scanner_version**（`collect.ts:62` 列清单里没有它），永远为 DDL 默认值 0
- 且类型不匹配：DDL 是 INTEGER，classify.ts 导出是字符串

**shareable 默认值与授权流程**：
- 默认 `0`（不可分享）— `schema.ts:53`、`schema.ts:119` 注释明确
- **无授权流程**：没有任何 API 或函数把 shareable 从 0 改为 1
- `buildSharePackage`（`classify.ts:31-40`）虽然读 shareable，但因为所有行都是 0，实际行为等价于"只分享 sensitivity==='none' 的产物"，shareable 字段形同虚设

---

## 6. acceptance / invalidate 机制

**mgmt_acceptances 表** — `schema.ts:139-144`：
- `verdict` CHECK ∈ `('accepted','rejected')`
- `invalidated_at` / `invalidated_reason` 可空
- `UNIQUE(manifest_id, verdict, actor)`

**写入 invalidated_at / invalidated_reason 的三个路径**：

1. **artifact 新版本导致旧 acceptance 失效** — `manifest.ts:319`：
   ```sql
   UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason=?
   WHERE manifest_id=? AND verdict='accepted' AND invalidated_at IS NULL
   ```
   触发点：`collect.ts:67`（采集到新版本时）调用 `invalidateAcceptances(..., "artifact_version_changed", ...)`

2. **提交时漂移（manifest_drift）** — `submit.ts:118`：
   ```sql
   UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason='manifest_drift'
   WHERE acceptance_id=? AND invalidated_at IS NULL
   ```
   触发点：`submit.ts:124-181` 在校验 snapshot/recomputed/git_head/base_sha 任何一项不匹配时

3. **work 合并/alias 导致 scope 变化** — `relations.ts:54`：
   ```sql
   UPDATE mgmt_acceptances SET invalidated_at=?,invalidated_reason='work_scope_changed'
   WHERE work_id=? AND verdict='accepted' AND invalidated_at IS NULL
   ```

**产物更新后旧 acceptance 的处理**：
- acceptance 行本身不删除、不修改 verdict，只打 `invalidated_at` 时间戳（软失效）
- 对应的 `control_attention` 卡片被同步置为 `superseded`（`manifest.ts:323`、`relations.ts:55`）
- `submit.ts:103` 在提交前检查 `acceptance.verdict !== 'accepted'` 或已被 invalidated 时拒绝提交
- `listManifests`（`manifest.ts:364`）返回最新 acceptance 供 UI 展示失效状态

**缺口**：
- 没有"旧 acceptance 对应的 manifest 是否可以重新提交"的路径——必须重新 computeManifest + insertManifest + requestAcceptance + recordAcceptance，整条链路走一遍
- `invalidated_reason` 取值集合未约束（自由文本）

---

## 7. 事件与 outbox

**manage 侧是否写 control outbox？**

`grep -rn "enqueueControlEvent" src/manage/` — **零命中**。

manage 模块**不写 control_outbox**。它对 control 库的写入只有两类：

1. **`control_attention`**：
   - `manifest.ts:213` 通过 `upsertAttention`（走 control store 的 revision 检查路径）
   - `manifest.ts:284`、`manifest.ts:323`、`relations.ts:55`、`launch.ts:53`、`launch.ts:69`、`submit.ts:461`：**直接写 SQL 操作 control_attention**，绕过 control store 的 revision 乐观锁

2. **`control_works`**：**零写入**（grep 证实 manage 目录下没有任何 INSERT/UPDATE control_works）

**mgmt 表变更是否产生事件？**

不产生 outbox 事件。但 mgmt 表变更会**直接修改 control_attention**（见上），这是一种"同步副作用"而非"事件流"。ingest reducer 消费的 `control_event` 来自 `control/outbox.ts` 的 `enqueueControlEvent` 调用方（`control/store.ts:220-221,472`、`control/context-events.ts`、`orchestrator/approval.ts:30`、`orchestrator/anomaly-monitor.ts:31`），**不包含 manage 产生的事件**。

**ingest reducer 如何消费 control 事件？**

- `reducer.ts:84`：`if (row.kind === "control_event") { applyControlEvent(db, detail, row.at); return; }`
- `applyControlEvent` 来自 `src/control/projection.ts`（未在本次审计范围，但 reducer.ts:4 import）
- 事件在 spool 里以 envelope 形式出现（`ingest.ts:270-276` 对 `control_event` 的 envelope 做额外校验：必须有 `event_id`、`payload_hash`、`payload`）
- outbox → spool 的发布者是 `publishControlEvents`（`outbox.ts:52-105`），它从 control 库拉 pending 事件、emit 到 spool、等 ledger 回执后打 `delivered_at`

**结论**：mgmt 变更 → control_attention 直写，不经过 outbox；control_attention 的变更也不被 outbox 捕获（`emitAttention` 在 `control/store.ts:221` 只在 control store 自己的 upsertAttention 路径里调用，manage 直写 SQL 时不会触发）。**这是一个事件流断点**。

---

## 8. 四 owner 红线

**manage 采集器是否可以 UPDATE control_works？**

`grep -rn "UPDATE control_works\|INSERT INTO control_works" src/manage/` — **零命中**。

manage 对 control_works 只读（`manage.ts:65,68`、`handoff.ts:44`、`submit.ts:452`）。

**代码中哪里体现了 owner 边界？**

- `store.ts:10-16` `createDiscoveredWork`：通过 control store 的 `createWork()` 函数创建 work（`control/store.ts:237` INSERT），不直接写 SQL
- 所有对 control_attention 的写操作：
  - `manifest.ts:213` 走 `upsertAttention`（带 revision 检查）
  - 但 `launch.ts:53`、`submit.ts:461`、`manifest.ts:284`、`manifest.ts:323`、`relations.ts:55`、`launch.ts:69` **直接写 SQL**，绕过了 control store 的 revision 乐观锁
- `schema.ts:12` `mgmt_work_profile` 以 `work_id` 为 PK 并 `REFERENCES control_works(work_id)`——外键约束保证 mgmt 不能孤儿引用 work

**红线评估**：
- control_works 的写权限：**严格遵守**（manage 不直接 UPDATE/INSERT，只通过 createWork）
- control_attention 的写权限：**部分绕过**——多处直写 SQL 不经过 control store 的 revision 机制，可能导致与其他 owner（orchestrator / decision-bot）的 revision 竞争丢失
- 没有 outbox 事件：manage 产生的 attention 变更对其他消费方不可见

---

## 9. mgmt_session_binding

**DDL** — `schema.ts:28-31`：
- `stable_id` PK（一个 Session 最多属一个 Work）
- `work_id` FK → mgmt_work_profile
- `role TEXT NOT NULL`（无 CHECK）
- `evidence_ref TEXT NOT NULL`
- `bound_at`

**role 枚举（注释声明）**：`origin|child|resumed|successor|explicit|orch_runner` — `schema.ts:31`

**实际写入值**：
- `store.ts:21`：`input.role ?? "origin"`（默认 origin）
- `manage.ts:54`：`role: workId===strongWork(...) ? "child" : "origin"`
- `launch.ts:69`（reconcileLaunches）：硬编码 `'successor'`

**未使用的 role 值**：`resumed`、`explicit`、`orch_runner` — **仅有注释无写入**。

**session 如何绑定到 work**：
1. 扫描新 session 时，`manage.ts:53-54` 先查 `mgmt_session_binding` 已有绑定；没有则通过 `strongWork`（`manage.ts:28-36`）从 ledger 的 `origin` / `parent_stable_id` 反查 handoff 或父 session 绑定；再没有则 `createDiscoveredWork` 新建
2. `bindExecution`（`store.ts:18-25`）INSERT binding + execution
3. handoff reconcile 时（`launch.ts:69`）把新 session 以 `successor` role 绑定

---

## 10. manifest 与版本

**manifest digest 如何计算** — `manifest.ts:38-54`：

```
manifest_id = sha256( canonical_json({
  work_id, repo_root, git_head, git_tree_sha, base_ref, base_sha,
  entries: [{artifact_id, version_id}] sorted by (artifact_id, version_id),
  verification: [...] sorted by canonical_json
}) ).slice(0, 32)
```

- `canonical` 函数（`manifest.ts:28-37`）递归排序对象 key、过滤 undefined、数组保持顺序
- 输入与 manifest_id 内容寻址：相同输入 → 相同 digest → `INSERT OR IGNORE`（`manifest.ts:156`）
- digest 截断为 32 hex（128 bit），碰撞空间足够

**manifest_entry 的复合外键** — `schema.ts:65-68`：

```sql
CREATE TABLE mgmt_manifest_entries(
  manifest_id TEXT NOT NULL REFERENCES mgmt_manifests(manifest_id),
  artifact_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  PRIMARY KEY(manifest_id, artifact_id),
  UNIQUE(manifest_id, version_id),
  FOREIGN KEY(artifact_id, version_id) REFERENCES mgmt_artifact_versions(artifact_id, version_id)
);
```

- 复合 FK `(artifact_id, version_id)` → `mgmt_artifact_versions(artifact_id, version_id)`：保证 version 确属该 artifact
- 前提：`mgmt_artifact_versions` 上有唯一索引 `(artifact_id, version_id)`（`schema.ts:56`）
- `PRIMARY KEY(manifest_id, artifact_id)`：一个 manifest 里每个 artifact 只出现一次
- `UNIQUE(manifest_id, version_id)`：一个 version 不被同一 manifest 重复引用
- `insertManifest` 在事务内还做了应用层校验（`manifest.ts:138-153`）：查 `mgmt_artifact_versions JOIN mgmt_artifacts` 确认 version 属于 artifact 且 work 在 scope 内

---

## 11. 实现成熟度汇总

### 已有实现（生产路径完整）

- `mgmt_work_profile` / `mgmt_work_alias`：采集、alias、canonical 解析（`store.ts`、`relations.ts`）
- `mgmt_session_binding` + `mgmt_executions`：origin/child/successor 三种 role（`store.ts`、`manage.ts:54`、`launch.ts:69`）
- `mgmt_artifacts`(file/git_dirty) + `mgmt_artifact_versions`：采集、快照、竞争标记、stale_capture（`collect.ts`）
- `mgmt_observations`：来源与身份解耦（`collect.ts:63`）
- `mgmt_links`：read/modified/created/attempted_modify/present_in_workspace + correction 链（`collect.ts`、`relations.ts:64-93`）
- `mgmt_corrections`：阻止采集器覆盖人工纠错（`relations.ts:90`）
- `mgmt_manifests` + `mgmt_manifest_entries`：digest 内容寻址、复合 FK（`manifest.ts`、`schema.ts:65-68`）
- `mgmt_acceptances`：request/record/invalidate 完整链路（`manifest.ts:182-329`）
- `mgmt_submissions`：github PR 提交、idempotency、poll merged（`submit.ts`）
- `mgmt_external_effects`：git_push / gh_pr 对账（`submit.ts:399-516`）
- `mgmt_handoffs` + `mgmt_handoff_launch_attempts`：preconditions、packet、launch、reconcile（`handoff.ts`、`launch.ts`）
- `mgmt_work_hints`：same_repo 提示（`relations.ts:104-114`）
- `mgmt_cursors`：增量读取游程（`store.ts:40-43`）
- `mgmt_discovery_log`：work_aliased 事件日志（`relations.ts:53`）
- closeout + archive（`archive.ts`）
- HTTP API（`mgmt-routes.ts`）

### 仅有表结构无逻辑（DDL 存在但无写入路径）

- `mgmt_artifacts.kind='git_commit'` / `'external'`
- `mgmt_artifact_versions.content_kind='metadata_only'`
- `mgmt_artifact_versions.snapshot_state` 的 `lost / too_large / pruned / write_failed`（8 值枚举只用了 3 个）
- `mgmt_artifact_versions.history_available`（恒 1）
- `mgmt_inputs.kind` 的 `reference / constraint / decision / approval / acceptance / feedback`（7 值只用了 1 个 user_message）
- `mgmt_exec_records`（整表无写入）
- `mgmt_summaries`（整表无写入）
- `mgmt_session_binding.role` 的 `resumed / explicit / orch_runner`
- `scanner_version` 字段（永远为默认 0）
- `shareable` 字段（永远为默认 0，无授权流程）

### 完全缺失

- **mgmt → control_outbox 事件流**：mgmt 表变更不产生可消费事件，直写 control_attention 绕过 revision 锁
- **运行产物（日志/测试结果/工具回执）的 mgmt 入库**：`mgmt_exec_records` 空表，orchestrator/evidence.ts 落盘的 diff/checks 不进 mgmt 库
- **人的 decision / approval 的 mgmt 入库**：inputs.kind='decision'/'approval' 无写入；control_attention 里的 approval 卡片与 mgmt_inputs 无关联
- **sensitivity 枚举统一**：mgmt（none/suspect/withheld）与 control（clean/suspected/confirmed_secret）两套词汇
- **shareable 授权流程**：无 API、无函数把 shareable 置 1
- **git_commit / external 产物采集**：DDL 和类型已声明，collect 不采集
- **acceptance 失效后的"重新验收"便捷路径**：必须手动重建 manifest

---

## 12. 与"上下文作为产物投影"目标模型的差距清单

目标模型（AGENTS.md）要求把大量 Agent 运行噪声压缩为少量可决策工作项，并保证决策后从原 checkpoint 续跑。当前 manage 体系在以下方面存在差距：

| # | 差距 | 证据 | 影响 |
|---|---|---|---|
| G1 | **运行产物未入库**：工具回执、日志、测试结果、checks 输出散落在 ledger.journal 和 orchestrator 落盘文件，mgmt 库无对应行 | `mgmt_exec_records` 空表（Q4）；`evidence.ts:95` 落盘但不写 mgmt | 决策卡无法在一个视图内呈现"测试结果/工具回执"，人类需要跳到原现场查看 |
| G2 | **人的 decision/approval 未入库**：inputs.kind='decision'/'approval' 无写入；control_attention 的决定不回流为 mgmt_inputs 版本 | Q3；`store.ts:33` 只写 user_message | 后续 handoff packet（`handoff.ts:45`）拿不到"之前的人是怎么决定的"，agent 续跑时缺失决策上下文 |
| G3 | **事件流断点**：mgmt 变更不写 outbox，直写 control_attention 绕过 revision 锁 | Q7；`launch.ts:53`、`submit.ts:461` 直写 SQL | 多 owner（orchestrator / decision-bot / manage）并发修改 attention 时可能丢失更新；其他消费方无法感知 mgmt 产生的卡片 |
| G4 | **shareable 形同虚设**：字段永远为 0，无授权流程 | Q5；`classify.ts:35` 读 shareable 但全为 0 | handoff packet 跨 host/跨 agent 传递时（`handoff.ts:46` 调 buildSharePackage），实际上只传了 sensitivity==='none' 的产物，shareable 维度未生效 |
| G5 | **sensitivity 双词汇表**：mgmt 用 none/suspect/withheld，control 用 clean/suspected/confirmed_secret | Q5；`classify.ts:3` vs `control/store.ts:95` | 跨库查询/统一 UI 时无法直接 JOIN，需要翻译层 |
| G6 | **scanner_version 未生效**：永远为 0，classify.ts 导出字符串 "1" 与 DDL INTEGER 不匹配 | Q2；`collect.ts:62` INSERT 列不含 scanner_version | 扫描器规则升级后无法识别"哪些版本是用旧规则扫的"，无法触发重扫 |
| G7 | **git_commit 产物未采集**：DDL 和类型已声明 | Q1；`manifest.ts:106` 只聚合 file/git_dirty | commit 作为一种重要的产物形态（PR 提交后的最终 commit）不进 manifest，manifest 无法表达"代码已落盘到哪个 commit" |
| G8 | **checkpoint / 恢复包不是一等产物**：handoff packet 和 git patch 存在 mgmt_handoffs.packet 和磁盘文件，不在 mgmt_artifacts 体系内 | Q1；`launch.ts:39` 写 patch 文件 | 无法对恢复包做版本化、shareable、sensitivity 处理；handoff packet 演进时无法复用 manifest 的 digest 机制 |
| G9 | **acceptance 软失效后无"重新验收"路径**：旧 acceptance 被打 invalidated_at 后，必须手动重建整条链路 | Q6 | 产物小幅改动 → 人需要重新走 compute → insert → request → record 四步，打断决策流 |
| G10 | **mgmt_session_binding.role 枚举未兑现**：resumed / explicit / orch_runner 三种 role 无写入路径 | Q9 | "从原 checkpoint 续跑"（AGENTS.md 闭环第 6 步）缺乏 resumed role 的语义承载；orch_runner 场景下 binding 关系不清晰 |
| G11 | **mgmt_summaries 空表**：设计上打算存 subject_id + subject_version 的文本摘要，但无生成/写入逻辑 | Q0 表清单；`schema.ts:162` | 决策卡的"一句话结论"目前由 control_attention.conclusion 承载，与 mgmt 产物版本无关联，无法表达"这个结论是基于哪个版本的产物得出的" |
| G12 | **多 host manifest 校验存在但单 host 绑定脆弱**：`validateManifestHosts`（`manifest.ts:81-87`）只在出现多个 host 时拒绝；单 host 但 host 字符串来自 stable_id.split(":")[0] 的降级逻辑（`manifest.ts:85`）在 ledger_evidence 缺失时不报错 | `manifest.ts:85` | 跨 host handoff 时若 ledger 不可用，manifest 可能把不同 host 的产物混在一个 digest 里 |

---

## 附：关键 file:line 索引

- DDL 全集：`src/manage/schema.ts:4-168`
- artifact kind 注释：`src/manage/schema.ts:44`
- inputs kind 注释：`src/manage/schema.ts:39`
- artifact_versions DDL：`src/manage/schema.ts:47-56`
- manifest_entries 复合 FK：`src/manage/schema.ts:65-68`
- exec_records DDL：`src/manage/schema.ts:114-119`
- acceptances DDL：`src/manage/schema.ts:139-144`
- manifest digest：`src/manage/manifest.ts:38-54`
- insertManifest：`src/manage/manifest.ts:127-180`
- invalidateAcceptances：`src/manage/manifest.ts:301-329`
- collectExecution 主循环：`src/manage/collect.ts:42-72`
- 版本 INSERT：`src/manage/collect.ts:62`
- 触发 acceptance 失效：`src/manage/collect.ts:67`
- submit 漂移校验：`src/manage/submit.ts:115-219`
- external effects 写入：`src/manage/submit.ts:488-515`
- sensitivity 分类器：`src/manage/classify.ts:16-28`
- share package：`src/manage/classify.ts:31-40`
- handoff packet 构造：`src/manage/handoff.ts:43-48`
- launch 直写 control_attention：`src/manage/launch.ts:53`
- reconcileLaunches：`src/manage/launch.ts:69`
- archive：`src/manage/archive.ts:5-26`
- scanOnce 主编排：`src/manage/manage.ts:38-64`
- addInputs（只写 user_message）：`src/manage/store.ts:27-38`
- alias 触发 acceptance 失效：`src/manage/relations.ts:54`
- link correction：`src/manage/relations.ts:64-93`
- ingest reducer control_event 分支：`src/ingest/reducer.ts:84`
- ingest classifier Q1-Q5：`src/ingest/classifier.ts:46-83`
- policy candidate 生命周期：`src/decision-bot/policy.ts:129-145`
- proposeRuleFromAttention：`src/decision-bot/policy.ts:170-185`
- evidence 落盘：`src/orchestrator/evidence.ts:77-97`
- mgmt HTTP API：`src/web/mgmt-routes.ts:35-170`
- control outbox：`src/control/outbox.ts:31-50`
- control sensitivity CHECK：`src/control/store.ts:95`
