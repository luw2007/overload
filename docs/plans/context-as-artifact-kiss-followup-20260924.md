# context-as-artifact KISS 收尾三项实现报告



* 日期：2026-09-24

* 性质：开发实现记录。本文记录 P0-MVP 之后 KISS 收敛三项的最终实现、接口 /schema/ 事件契约、owner、测试证据、未做项和风险。

* 依据：


  * 独立代码审计（三份）：


    * `docs/plans/audit-kiss-task1-rootproblem-20260924.md`

    * `docs/plans/audit-kiss-task2-artifact-projection-20260924.md`

    * `docs/plans/audit-kiss-task3-attention-barewrites-20260924.md`

  * P0-MVP 实现报告：`docs/plans/context-as-artifact-mvp-implementation-20260924.md`

  * 四 owner 契约：`docs/architecture/implementation-contract.md`

* 执行纪律：主调度只做需求、分发、验收；所有读码、写码、测试由 subagent 完成。每项实现配独立 reviewer/tester，不能自验。全量 bun test 由独立测试 subagent 执行。



***

## 1. 实现范围（KISS 三项）

KISS 核对结论只做三项，禁止顺手做 chunk、Jev 评分、candidate\_log、sensitivity 表重建、retention、子问题树、grant UI、推送通道、远程 resume。

### 任务 1（正确性 hotfix，优先独立先合）：存量 work 根 problem 回填

**现象**：v4 迁移不为已有 active work 建根 problem；createWork 命中已存在的幂等返回分支也不补。orchestrator 无条件注入 rootProblemId (work\_id)，reducer linkProblemObject 因 problem 不存在失败，fact 进 quarantine；collector cursor 已推进，永不重投 → 升级后 fact 静默断流。

**审计额外发现**：redirectWork activate 分支同样漏建根 problem。

**实现**：



1. `CONTROL_SCHEMA_VERSION` 4→5，新增 v5 迁移：先 `UPDATE control_schema_meta SET version=5`（防止 ensureRootProblem→ensureControlSchema 重入时仍读 4 形成无限递归），再遍历 `control_works` 全状态行（active/candidate/stopped/completed），逐行 `ensureRootProblemLocked` 幂等建根 problem。版本更新与回填同事务，失败整体回滚。

2. `createWork` 幂等返回分支：命中已存在 work 且 state==="active" 时，return 前补 `ensureRootProblemLocked`。candidate 不补（与新建 candidate 路径一致，promoteWork 已建）。

3. `redirectWork` activate 分支：state 落为 active 后补 `ensureRootProblemLocked`，覆盖 stopped/completed→active 复活。

4. `promoteWork` 审计确认已建根 problem，无需改。

**archived 范围决策**：control\_works schema CHECK 只有 candidate/active/stopped/completed 四个状态，不存在 archived。v5 迁移无 WHERE 遍历全部行，覆盖所有状态。理由：collector 无状态、不按 work state 过滤；redirectWork 可复活 stopped work；orchestrator 无条件注入 rootProblemId。

**无新表 / 新列 /destructive 操作。**

### 任务 2（任务 1 完成后）：mgmt artifact 版本投影进 context 问题池

**现象**：on-demand-fetcher 已支持 artifact:@ 快照字节读取 + sha256，但无 producer 发这种 reference，决策卡看不到交付物 / 文件证据。

**审计关键事实**：mgmt\_artifacts.work\_id 是直接 NOT NULL FK，无需走 session 链路。零 schema 变更即可投影。

**实现**：



1. 新增 `src/control/artifact-projection.ts`，导出 `projectArtifactVersions(db, work_id, now?): { projected, skipped }`。

2. 查 `mgmt_artifact_versions JOIN mgmt_artifacts WHERE a.work_id=?`，按 observed\_at 排序。

3. 分流：`stored` 投影完整对象；`reference_only` 投影占位对象；`pending/too_large/lost/pruned/withheld_sensitive/write_failed` 跳过计 skipped。

4. 投影字段：

* `reference` = `artifact:<artifact_id>@<version_id>`（与 fetcher 正则严格匹配）

* `ctype` = `'artifact'`，`source_type` = `'artifact'`

* `content_hash` = mgmt `content_sha256`

* `sensitivity`（读取侧单向安全映射，硬约束）：`none/clean→clean`、`suspect→suspected`、`withheld→unknown`（**绝不映射成 confirmed\_secret**，拒绝摘要）、其他→`unknown`

* 挂到 `rootProblemId(work_id)`，role=`artifact`，投影前 `ensureRootProblem` 防御兜底

1. 幂等：按 reference 查重；已投影跳过；同 artifact 新 version 走 `updateObject` 推进 revision 并 `linkProblemObject` upsert 指针，历史 version 行保留可追溯。

2. 触发点：`src/manage/manifest.ts` 的 `requestAcceptance` 中，upsertAttention 之后、return 之前调用 `projectArtifactVersions(db, manifest.work_id, now)`。manage 不直写 control 表，仅按名调用 Core 导出。

3. 零 schema 变更，CONTROL\_SCHEMA\_VERSION 保持 5。

### 任务 3（可与 2 并行但共享冻结契约，实际串行避免 manifest.ts 冲突）：收编剩余裸写 control\_attention

**现象**：manage 下 relations.ts、manifest.ts、launch.ts 仍有 3 处绕过 control store API、直接 UPDATE control\_attention 的裸写，均不写 events/outbox、绕过或半绕过 CAS。

**实现**：



1. Core 新增 3 个导出 API（`src/control/store.ts`），均复用 `persistAttention`→`emitAttention`→`enqueueControlEvent` 范式，同事务 CAS+events+outbox：

* `supersedeAttentionById(db, itemId, expectedRevision, {reason, actor, evidence?}, now?)`：open/applying→superseded，不改动 effect\_state；同 reason 重复 supersede 已 superseded 的卡幂等返回（不 bump、不重复发事件）。

* `supersedeOpenAttentionByWork(db, workId, {reason, actor, evidence?}, now?)`：选该 work 下 `state IN ('open','applying')` 逐张 CAS supersede，返回张数；不碰 resolved/superseded。

* `resolveAttentionByExternalSuccess(db, itemId, expectedRevision, {actor, evidence?}, now?)`：守卫 `effect_state='failed'`→抛 invalid；`state='superseded'`→return old 不复活；已 resolved/succeeded 且 revision 匹配→幂等返回；非 open/applying→抛 invalid；stale revision→conflict；成功→resolved/succeeded+events+outbox+revision+1。

1. manage 三处改调：

* `relations.ts` aliasWork：原 `UPDATE control_attention ... LIKE 'mgmt:accept:%'` → `supersedeOpenAttentionByWork`。**行为变更**：范围从仅 mgmt:accept:% 前缀扩大到该 work 下所有 open/applying 卡（契约明示）。

* `manifest.ts` invalidateAcceptances：先 `SELECT revision ... AND state='open'`，再 `supersedeAttentionById`。未触碰任务 2 的 requestAcceptance 投影。

* `launch.ts` reconcileLaunches：先 `getAttention` 读 revision，再 `resolveAttentionByExternalSuccess`；失败 catch 路径走 unknownAttention 建卡，不调 resolve API。

1. grep 确认 `src/manage/` 对 control\_attention/control\_attention\_events/control\_outbox 的 INSERT/UPDATE/DELETE = 0，仅剩 SELECT 读。无 UPDATE control\_works。



***

## 2. 冻结的接口 /schema/ 事件契约

### 2.1 任务 1：schema 变更



```
// src/control/store.ts
export const CONTROL_SCHEMA_VERSION = 5; // 4→5

// CONTROL_MIGRATIONS 追加：
{ to: 5, destructive: false, apply(db) {
    db.query("UPDATE control_schema_meta SET version=?, migrated_at=? WHERE id=1").run(5, Date.now());
    const rows = db.query("SELECT work_id FROM control_works").all() as {work_id:string}[];
    for (const {work_id} of rows) ensureRootProblemLocked(db, work_id, Date.now());
}}
```



* 关键：必须先推进版本号再回填，否则 ensureRootProblem→ensureControlSchema 重入时仍读 4，再次命中 v5 形成无限递归。

* 无新表 / 新列 /destructive。

* `CONTROL_SCHEMA` 加 `export`（供迁移测试回放 v1 DDL）。

### 2.2 任务 2：新增接口



```
// src/control/artifact-projection.ts（新增文件）
export function projectArtifactVersions(
  db: Database,
  work_id: string,
  now?: number,
): { projected: number; skipped: number };
```



* 读 mgmt 只读，写 control 通过 context-pool API（createObject/updateObject/linkProblemObject/ensureRootProblem）。

* reference 格式 `artifact:<artifact_id>@<version_id>` 与 on-demand-fetcher.ts:212 正则 `/^artifact:([^@]+)@([^@]+)$/` 严格匹配。

* sensitivity 映射：withheld→unknown（硬约束，审计曾建议 confirmed\_secret，已覆盖）。

* 幂等键：reference（含 version\_id）。每个 mgmt version 对应一个 object\_version；同 artifact 多 version 对应同一 object 的多 revision。

* 无新事件 kind（投影同步写，不发 outbox）。

### 2.3 任务 3：新增接口



```
// src/control/store.ts（新增导出）
export function supersedeAttentionById(
  db: Database, itemId: string, expectedRevision: number,
  input: { reason: string; actor: string; evidence?: Record<string, unknown> },
  now?: number,
): AttentionItem;

export function supersedeOpenAttentionByWork(
  db: Database, workId: string,
  input: { reason: string; actor: string; evidence?: Record<string, unknown> },
  now?: number,
): number;

export function resolveAttentionByExternalSuccess(
  db: Database, itemId: string, expectedRevision: number,
  input: { actor: string; evidence?: Record<string, unknown> },
  now?: number,
): AttentionItem;
```



* 三者均带 revision CAS、control\_attention\_events、outbox，在同一事务内。

* 事件 kind 复用现有 attention.superseded/attention.resolved（按代码风格）。

* state 机守卫：failed 不可 resolve、superseded 不可复活、rejected 不可变 resolved。

### 2.4 事件契约



* 不新增事件 kind。

* 任务 1 ensureRootProblem 不发 outbox（problem 是 work 隐含附属）。

* 任务 2 投影不发 outbox（同步写）。

* 任务 3 复用现有 attention.superseded/attention.resolved 事件机制。



***

## 3. Owner 分工



| 模块                           | Owner                                               | 职责                                                                        |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| Core（src/control/）           | 任务 1/2/3 实现 subagent                                | v5 迁移、createWork/redirectWork 补建、artifact-projection.ts、3 个 attention API |
| manage（src/manage/）          | 任务 2/3 实现 subagent                                  | manifest.ts 触发点、relations.ts/manifest.ts/launch.ts 裸写收编                   |
| Execution（src/orchestrator/） | 无改动                                                 | 任务 1 不改 orchestrator（无条件注入是正确的，根 problem 必须存在）                            |
| Surface（src/web/）            | 无改动                                                 | —                                                                         |
| 测试                           | 独立 reviewer/tester subagent ×3 + 独立全量测试 subagent ×1 | 反例覆盖 + 全量 bun test                                                        |



***

## 4. 测试命令和结果

> 所有数字由独立验收者（未参与实现）重新运行得出。实现者自跑数字不作为验收证据。

### 4.1 任务 1 独立验收



* 新增测试 `src/control/root-problem-backfill.test.ts`：**9 pass / 0 fail**（27 expect），0.41s。

* control 全量 `bun test src/control/`：**219 pass / 0 fail**，16 文件，3.87s。

* shared：**39 pass / 0 fail**，3 文件。

* manage（test/manage-\*.test.ts）：**91 pass / 0 fail**，19 文件（修复 test/manage-schema.test.ts 版本号遗漏后）。

* orchestrator：198 pass / 1 fail（`evidenceReady accepts complete evidence collected from real git` 全量并行下 5s 超时，隔离复跑 2 次均 19/19 通过，确认为 git 子进程资源争用 flaky，与本改动无关）。

* 反例验证：v3 库插 active work 无 root problem → 升级后 version=5、root id 匹配 → fact 投递 `created`、quarantine 0 行，退出码 0。

* 发现并修复：`test/manage-schema.test.ts:25-26` 硬编码版本 4 遗漏（实现者只更新了 src/control/ 下测试），reviewer 就地改为 5（仅测试文件）。

### 4.2 任务 2 独立验收



* 新增测试 `test/artifact-projection.test.ts`：**10 pass / 0 fail**（38 expect），0.81s。

* control 全量：**219 pass / 0 fail**，16 文件，3.76s（782 expect）。

* 关联测试 `test/manage-manifest.test.ts test/context-integration.test.ts test/context-e2e.test.ts`：**21 pass / 0 fail**，3 文件，0.47s（154 expect）。

* 反例验证：withheld artifact（快照含明文 `TOP-SECRET-PLAINTEXT-42`）投影后 sensitivity='unknown'、full fetch 返回 `{blocked, reason:"sensitivity unknown"}`；跨 work fetch 返回 `{blocked, reason:"cross-work reference not shared", code:"forbidden"}`。9 项断言全过。

### 4.3 任务 3 独立验收



* 新增测试 `src/control/attention-supersede.test.ts`：**12 pass / 0 fail**，56ms。

* 新增测试 `test/manage-attention-consolidation.test.ts`：**3 pass / 0 fail**，36ms。

* store 相关 `bun test src/control/store.test.ts store-extra.test.ts store-guard.test.ts`：**29 pass / 0 fail**，130ms。

* manage 相关 `bun test test/manage-relations.test.ts manage-manifest.test.ts manage-handoff.test.ts`：**15 pass / 0 fail**，88ms。

* 反例验证：(a) failed effect\_state 卡调 resolve → 抛 invalid，状态不变；(b) 同 expectedRevision 连发两次 resolve → 第二次 conflict；(c) aliasWork 后 canonical 开放卡 → superseded、revision+1、outbox 有事件、events kind=superseded。全过。

### 4.4 独立全量测试

命令：`cd /Users/luwei.will/ai/overload && bun test`



| 项目            | 数值         |
| ------------- | ---------- |
| 退出码           | **0**      |
| pass          | **1136**   |
| skip          | **1**      |
| fail          | **0**      |
| 测试文件数         | **149**    |
| expect () 调用数 | **3808**   |
| 耗时            | **73.58s** |



* 唯一 skip：`P4 attribution grades > fixture commits cover all grades and trailer precedence`（test/p4-attrib.test.ts），`describe.skipIf(!available)` 因 `src/attrib/report.ts` 不存在而条件跳过，与本次改动无关。

* 已知 flaky（anomaly-monitor 超时、evidenceReady git 集成、manage-source ssh 探测）本次全量并行下均通过，无超时无失败。

* 工作树：无 undefined\*、无 .db/.bak/.tmp 残留；改动范围与三项任务吻合（其余为用户既有未提交内容）。

* CONTROL\_SCHEMA\_VERSION=5，无 ALTER TABLE/ADD COLUMN，无意外 schema 变更。



***

## 5. 改动文件清单

### 实现文件（7 个）



| 文件                                   | 改动摘要                                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/control/store.ts`               | CONTROL\_SCHEMA\_VERSION 4→5；CONTROL\_SCHEMA 加 export；v5 迁移（先推版本再遍历回填）；createWork 幂等返回 active 补 ensureRootProblemLocked；redirectWork activate 补 ensureRootProblemLocked；新增 supersedeAttentionById、supersedeOpenAttentionByWork、resolveAttentionByExternalSuccess 三个导出 |
| `src/control/artifact-projection.ts` | 新增文件，projectArtifactVersions 投影器（mgmt→control，幂等，sensitivity 安全映射）                                                                                                                                                                                                    |
| `src/manage/manifest.ts`             | requestAcceptance 加 projectArtifactVersions 触发点；invalidateAcceptances 裸写改调 supersedeAttentionById                                                                                                                                                                     |
| `src/manage/relations.ts`            | aliasWork 裸写改调 supersedeOpenAttentionByWork                                                                                                                                                                                                                           |
| `src/manage/launch.ts`               | reconcileLaunches 裸写改调 resolveAttentionByExternalSuccess（getAttention 读 revision + CAS + 守卫）                                                                                                                                                                          |

### 测试文件（6 个，新增 4 + 修改 2）



| 文件                                            | 说明                                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `src/control/root-problem-backfill.test.ts`   | 新增，9 用例（v3→v5 升级、fact 可投递、重复创建幂等、幂等返回补建、redirect activate 补建、重入幂等、全状态回填、root id 一致）                                     |
| `test/artifact-projection.test.ts`            | 新增，10 用例（stored 投影、agent 包可见、fetch hash 匹配、重跑幂等、新版本推进、跨 work 跳过、withheld 不露摘要、跨 work 拒绝、非 stored 跳过、reference\_only 占位） |
| `src/control/attention-supersede.test.ts`     | 新增，12 用例（supersede CAS / 幂等 /not\_found、批量只动 open/applying、resolve 正常 / 守卫 / 幂等 / CAS 并发冲突 /not\_found）                 |
| `test/manage-attention-consolidation.test.ts` | 新增，3 用例（aliasWork→supersede、invalidateAcceptances→supersede、reconcileLaunches→resolved/succeeded）                       |
| `src/control/context-pool.test.ts`            | 修改，旧测试硬编码版本 4→5                                                                                                         |
| `src/control/store-guard.test.ts`             | 修改，旧测试硬编码版本 4→5                                                                                                         |
| `test/manage-schema.test.ts`                  | 修改，版本断言 4→5（任务 1 reviewer 发现遗漏并修复）                                                                                      |

### 文档（4 个）



| 文件                                                             | 说明          |
| -------------------------------------------------------------- | ----------- |
| `docs/plans/audit-kiss-task1-rootproblem-20260924.md`          | 任务 1 独立代码审计 |
| `docs/plans/audit-kiss-task2-artifact-projection-20260924.md`  | 任务 2 独立代码审计 |
| `docs/plans/audit-kiss-task3-attention-barewrites-20260924.md` | 任务 3 独立代码审计 |
| `docs/plans/context-as-artifact-kiss-followup-20260924.md`     | 本文档         |



***

## 6. 未做项和风险

### 明确未做（后续阶段）



* 持久化 context\_chunks /context\_candidate\_log

* 模型相关性评分 /embedding/ 自动 chunker

* Jev 模型评分

* sensitivity 表重建 /mgmt schema 版本化

* grant 管理 UI /retention 定时任务

* git/HTTP 外部源

* 子问题树创建

* 证据版本清单（decision basis）

* pin 版本 / 现场连续性桥接

* mgmt\_observations /mgmt\_summaries/mgmt\_links 复用审计

* artifact 二进制 / MIME 支持（fetcher 当前仅 utf8 文本）

* 推送通道 / 远程 resume

* manage 批量 supersede 之外的其他潜在裸写（grep 已确认 manage/ 零 DML 残留）

### 风险与观察



1. **任务 2 投影事务独立性**：projectArtifactVersions 在 requestAcceptance 中独立事务运行，与 upsertAttention 不共享事务。若投影抛错，acceptance 卡已提交但投影未完成。两侧均幂等，重试可恢复。可接受。

2. **任务 3 批量 supersede 范围扩大**：supersedeOpenAttentionByWork 按契约 supersede 该 work 下所有 open/applying 卡（不限于旧裸写的 mgmt:accept:% 前缀）。aliasWork 时 canonical work 下其他 open 卡（如 stop-condition）也会被 supersede。这是契约明示的语义，非笔误。

3. **任务 3 计数信息性偏差**：supersedeOpenAttentionByWork 并发下若选中的 open 卡已被同 reason supersede，幂等 return 仍 count++，计数轻微偏高，仅信息性。

4. **已知 flaky**：anomaly-monitor divergence、evidenceReady real git、manage-source ssh 探测在全量并行下可能超时，单独跑可过，与本次改动无关。本次全量均通过。

5. **v5 迁移递归防护**：必须先 UPDATE version=5 再调 ensureRootProblemLocked，否则 ensureRootProblem→ensureControlSchema 重入无限递归。实现已正确处理，独立评审确认。

6. **工作树有用户既有未提交改动**：三项任务改动与用户既有改动共存，未回退、未触碰用户文件。未 commit。