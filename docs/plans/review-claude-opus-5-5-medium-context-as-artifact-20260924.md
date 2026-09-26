# 外部代码评审：context-as-artifact 方案

> 本报告由外部模型通过 acpx CLI 实际调用 pi agent（
>
> `claude_sub2api/claude-opus-5-5`
>
> ，thinking=medium）生成。评审过程只读取项目文件，未修改任何项目源码。

## 主调度摘要



* **调用方式**：`acpx --format json --timeout 1200 --max-turns 80 --approve-reads --non-interactive-permissions fail pi exec -f <prompt>`，cwd=`/Users/luwei.will/ai/overload`。

* **模型是否真实调用成功**：是。退出码 0，`stopReason=end_turn`，共 30 次工具调用（read/bash），实际读取了 src/ 下多个文件核对 file:line。

* **核心结论**：**方向基本正确，但现在不能进入开发**。用 `mgmt_artifacts` 做权威层、上下文作为版本投影是对的；但 P0 对几处代码理解有误，照着写会导致生产写入报错、事件发错库、迁移无法重跑。

* **问题统计**：**Blocker 5 条**（B1-B5）、**Major 18 条**（M1-M18）、**Minor 6 条**（m1-m6）。

* **最严重的分歧点**：

1. `createProblem` 不幂等、id 不可指定（模型说方案 §4.3/§6 P0 假设错误）。

2. `linkProblemObject` 用普通 INSERT，fact 第二次 revision 会撞主键打挂整个 ingest 事务。

3. `applyControlEvent` 运行在 ledger 库，不是 control 库的权威 attention 表；方案 §3.4 的 outbox 设计根本接不上。

4. SQLite `ALTER TABLE ADD COLUMN` 不可重跑，"降版本号回退" 会导致再次启动失败。

5. `withheld → confirmed_secret` 映射语义错误（启发式命中≠人工确认），会导致敏感内容被整段展示。

* **MVP 建议**：模型建议把 P0 缩小为 "接通问题链路（幂等）+ attention 走 control store API + fetcher 读真实字节复验 + 证据版本清单 + pin 版本"，chunk 表和模型评分延后。



***

## 模型原始输出

**总体结论：方向基本正确，但现在还不能进入开发。** 用 `mgmt_artifacts` 做权威层、把上下文当作版本投影是对的。问题在 P0：方案对几处代码的理解有误，照着写会导致生产写入报错、事件发错库、迁移无法重跑或回退。另外 "模型评分 + 持久化 chunk 表" 做得太早，也没接上已有的 `mgmt_observations` / `mgmt_summaries`。核查报告写的 "28/28 成立、0 部分成立" 过于乐观。



***

## 1) 核心产品判断



* **成立的部分**


  * 用 `mgmt_artifacts` / `mgmt_artifact_versions` 作为唯一内容权威，不再新建一套平行产物库，这是对的。

  * 现有基础可以直接用：


    * 内容寻址的 `version_id`（`src/manage/collect.ts:62` 用 INSERT OR IGNORE 写入）；

    * 复合唯一索引 `mgmt_versions_artifact_version`（`src/manage/schema.ts:57`），可作为 chunk 复合外键的目标；

    * manifest 只取 `kind IN ('file','git_dirty')`（`src/manage/manifest.ts:106`）。所以往产物表里加过程类、运行类产物，不会污染 manifest digest。

  * "上下文从属于产物版本，pin 钉住某个版本"，可以直接支撑 AGENTS.md 第 6 条（保留现场连续性）。

* **不成立或过度的部分**


  * **把 "人的决定" 做成快照文件的 Artifact 太重。** 决定是结构化的小记录，本来就属于 `mgmt_inputs`（kind 里已经有 `decision` / `approval`）。真正需要版本化的是 "做决定时依据的那批证据版本"，即一组 `version_id` 的清单，不是决定正文本身。

  * **持久化的 chunk 表加模型评分，并不是产品闭环的必需品。** 当前最大的问题是上下文池没有数据（pool 空转）、full 取源的哈希对不上，不是缺少相关性排序。

* **更简单的替代方案（建议作为 MVP）**

1. 接通 problem 链路，并让它幂等。

2. 对交付类产物，写一个 fact 对象，`reference="artifact:<id>@<ver>"`。取源解析器已经存在（`src/control/on-demand-fetcher.ts:211-222`）。

3. fetcher 的 full 路径改为读 `snapshot_path` 的真实字节，并用 `content_sha256` 复验。

4. 需要局部内容（diff hunk、日志尾部）时，在装配时临时按确定性规则切片，不落库。

5. 等 "决策卡阅读量" 指标证明包太长，再建 chunk 表和评分。

**Blocker：无　Major：M1 decision 的 Artifact 化过重；M2 chunk 表 + 评分不是 MVP 必需　Minor：无**

## 2) 领域边界



* **方案完全忽略了已有的表**（方案全文检索 `mgmt_observations`、`mgmt_summaries` 均为 0 处）：


  * `mgmt_observations`（`src/manage/schema.ts:109-112`，`collect.ts:63` 在生产中写入）已经就是 Observation 概念：记录 "哪个版本在哪个来源、以什么证据被观察到"，并有 `UNIQUE(version_id, evidence_ref)`。候选生成、溯源、"运行 fact 桥接" 都应基于它，而不是在 `control_context_objects` 里再造一份。

  * `mgmt_summaries(subject_id, subject_version, generator)`（`src/manage/schema.ts:162-163`）天然适合存 chunk 或版本的摘要，而且区分生成器（规则或模型）、按版本不可变。方案却在 chunk 表里内嵌 `summary_short` / `summary_long`，两处都存摘要，而且模型改写摘要时就必须原地修改投影行。

  * `mgmt_links`（`src/manage/schema.ts:129-136`）已经记录了 read /attempted\_modify 等关系，可以直接用来产出 "与问题相关的产物" 候选。

* **Chunk 的&#x20;**`stale`**&#x20;列本身矛盾。**


  * §2.3 同时说 "旧 chunk 标 stale=1" 和 "`stale=0` 的历史语义不变 "。

  * 投影行应当不可变，stale 应在读时推导：版本不是该产物的最新版本即为 stale。

  * 但当前 "最新版本" 只是 `ORDER BY observed_at DESC` 推出来的（`manifest.ts:106`），没有明确的最新版本指针。

* **不应进入 Artifact 的东西：**


  * attention 卡片本身、授权 grant /share/pin（这些是控制状态）；

  * 心跳和进度事件、原始 journal 事件（运行噪声）；

  * candidate 评分（派生的审计数据）；

  * 人决策的正文（放 input，只记它引用的证据版本清单）；

  * 未经筛选的完整日志（最多存 `reference_only` 加尾部片段，并设 retention）。

* **Decision Package 没有定义实体。** 建议定义为 "某次决策所用证据版本清单 + 决定"，本身就是一个 process Artifact，其内容是 `(artifact_id, version_id, range)` 的有序列表。这比把每个 decision 都存成快照更准确。

**Blocker：无　Major：M3 忽略&#x20;**`mgmt_observations`**、**`mgmt_summaries`**、**`mgmt_links`**；M4 chunk 的 stale 可变且语义自相矛盾；M5 Decision Package 未定义　Minor：m1 缺少明确的最新版本指针**

## 3) 代码现状判断

逐项核对结果：



| 断言                                                                          | 实际情况                                                                                                                                                                                                                                                                                      | 判定                                                                                                                               |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| createProblem 可以 "幂等" 建出 `prob:<work_id>`                                   | `src/control/context-pool.ts:181` 的 id 由 `problemId(work_id, parent, title)` 哈希得出（`:93-94`），不能指定 `prob:<work_id>` 这种 id；`:184` 已存在时会抛出 `conflict "problem already exists"`                                                                                                                | **错误**。它不幂等，id 格式也对不上                                                                                                            |
| 接通 problem\_id 后 link 就能工作                                                  | `linkProblemObject` 用的是普通 INSERT（`context-pool.ts:397`），主键是 `(problem_id, object_id, role)`（`src/control/store.ts:114`）。同一个 fact 第二次出新 revision 时（`context-reducer.ts:189-194` 会递增 revision），再次 link 会撞主键并抛错，导致整条摄入事务回滚，经 `ingestFactObservedOrThrow` 冒泡成摄入失败                             | **遗漏，P0 会引入生产故障**                                                                                                                |
| manage 改发 outbox 事件后，由 `applyControlEvent` 带 revision 投影                    | `applyControlEvent` 是在 ingest reducer 里对 journal 行执行的（`src/ingest/reducer.ts:84`），运行在 **ledger 库**（`src/control/outbox.ts:56-63` 从 `ledgerPath` 读回执）。它只做 "revision 大的覆盖" 的镜像，没有 `expected_revision` 这种乐观锁校验（`src/control/projection.ts:42-49`）。control 库里的权威 `control_attention` 并不会因此被更新 | **错误**。应改为在 control 库同一事务内调用 `upsertAttention`（`src/control/store.ts:284`），它会同时写事件和 outbox                                       |
| manage 直写的真实危害                                                              | `manifest.ts:284,323`、`relations.ts:55` 的裸 UPDATE 既不写 `control_attention_events`，也不写 outbox，导致 ledger 镜像和 Web 事件时间线（`src/web/ledger.ts:6`）与权威表分叉                                                                                                                                          | 方案只说了 "revision 竞争"，低估了影响                                                                                                        |
| sensitivity 的取值                                                             | mgmt 分类器实际输出 `none` / `suspect` / `withheld`（`src/manage/classify.ts:3,19,22,27`），DDL 默认值是 `'unknown'`（`schema.ts:52`）。其中 `suspect` 包含 "binary"（二进制文件），`withheld` 来自路径黑名单或疑似密钥的启发式规则                                                                                                      | 方案把 `withheld` 映射成 `confirmed_secret` **语义错误**：启发式命中不等于人工确认。再叠加方案 "开放 confirmed\_secret 授权，上限可到 full"，会造成误判内容被整段展示               |
| `mgmt_inputs.version`                                                       | 是 `INTEGER`，按 `(work_id, kind)` 单调递增的序号（`schema.ts:35,38`，`src/manage/store.ts:28-33`）                                                                                                                                                                                                    | §2.1 说 " 用 `UNIQUE(work_id, kind, version)` 引用 artifact 的 version" 是**类型错误**：`version_id` 是 TEXT 哈希。需要新增 `artifact_version_id` 列 |
| pin 通过加 range 列就能钉住 artifact\_version                                       | `control_context_pins` 的 `object_id` / `revision` 为 NOT NULL，并有外键指向 `control_context_object_versions`（`store.ts:118-126`）                                                                                                                                                                 | 只加两列字节范围，**无法**引用 artifact\_version。要么加 `artifact_id` / `version_id` 列并保证二选一，要么经桥接对象中转                                           |
| 其余断言（chunk 不存在、fetcher 只哈希 9 列行 JSON、pool 空转、schema 版本拒启、`SENSITIVITY_CAP`） | 抽查后引用准确                                                                                                                                                                                                                                                                                   | 成立                                                                                                                               |

**Blocker：B1 createProblem 不幂等且 id 不可指定；B2 link 主键冲突会在 P0 后打挂摄入；B3 outbox 事件发到了错误的库　Major：M6&#x20;**`withheld→confirmed_secret`**&#x20;误映射；M7&#x20;**`mgmt_inputs.version`**&#x20;类型不匹配；M8 pin 外键结构不支持 version + range　Minor：m2 核查报告全部判为成立，结论可信度被高估**

## 4) schema / 迁移



* `ALTER ADD COLUMN`**&#x20;不能重复执行（Blocker）**


  * 方案 P0 的验收写着 "迁移脚本可重复执行" 和 "回退 = 把版本号降回 3"。但回退后，新二进制再次运行 v4 迁移时，`ADD COLUMN artifact_class` 会报 duplicate column，启动失败。

  * 如果同时把 `artifact_class` 写进 `MGMT_SCHEMA` 的 CREATE 语句，全新库在 v2 迁移（`ensureMgmtSchema`，`store.ts:157`）时就已经有这一列，v4 迁移同样失败。

  * 另外 `ensureMgmtSchema` 在各处被直接调用（如 `manifest.ts:307`），`MGMT_SCHEMA` 里不能放 ALTER。

  * 修正：v4 迁移先用 `PRAGMA table_info` 判断列是否存在；列定义只放在迁移里，不放进 CREATE DDL。

* **"回退后 v3 二进制能正常启动" 与拒启机制矛盾。** 旧二进制遇到版本 4 会直接拒启（`store.ts:162`）。回退依赖手工改版本号，没有可执行的流程。建议写成：先做 `VACUUM INTO` 备份（`store.ts:150-153` 已有该机制），回退 = 恢复备份。

* **回填的兜底&#x20;**`ELSE 'delivery'`**&#x20;会把未知 kind 悄悄归类**，应当写 NULL 并告警，或者迁移失败。

* **sensitivity 在 v4 写入时翻译，会造成同一列新旧词汇混存。** 所有读取方必须同时改，例如 `collect.ts:65` 的 `row.sensitivity !== "none"`、`classify.ts` 里的 `buildSharePackage`。更安全的做法：v4 不改存储，只在 mgmt 进入 control 的读取边界做单向适配；v5 表重建时一次性转换。

* **B 类表重建风险高。** `mgmt_artifact_versions` 被 manifest entries、observations、chunks 的外键引用。在 `foreign_keys=OFF` 下重建后，必须跑 `PRAGMA foreign_key_check`。当前迁移框架是在事务里执行，而 `PRAGMA foreign_keys` 在事务内修改无效，必须在事务外设置。方案没有指出这一点。

**Blocker：B4 迁移不可重跑、不可回退　Major：M9 同一列混存两套词汇；M10 表重建时事务内设置外键开关无效　Minor：m3 回填兜底会悄悄错分**

## 5) 工程细节



* **outbox 与投影时序（Major）**


  * `collect.ts:62` 插入版本时，`snapshot_state='pending'`，只有在事务提交、文件 rename 之后才改成 `stored`（`collect.ts:70`）。如果在同一事务里发出 `version_stored` 事件，它其实早于快照真正落盘。

  * chunk 投影也不应该绕 ledger 一圈。建议在 control 库维护一张本地待投影队列，或者直接扫描 "`stored` 且还没有 chunk" 的版本。

* **owner 边界。** 过程产物也会走插入新版本的路径。如果共用 `collect.ts:67` 的 `invalidateAcceptances`，那么记录一次验收或决定就会让现有验收失效，形成循环。必须限定只有 delivery 类的新版本才触发失效。

* **幂等 / 乐观锁。** 根 problem 需要 "不存在就创建" 的 get-or-create 语义；link 要改成 upsert（冲突时更新 revision），或者把 revision 放进主键。reducer 里用 `INSERT OR IGNORE` 直接插 problem 行，会绕过 `root_problem_id` 和环检测等不变量。

* `content_hash`**&#x20;的规范化字节。** §2.3 说 "`chunk_sha256` 等于父 `content_sha256` 的一个切片哈希 "，这句话不成立：整文件哈希推不出切片哈希。应定义为：先用整文件 `content_sha256` 校验字节，再算切片哈希。`src/shared/context-contract.ts:28` 对 artifact 的规范化字节定义（行 JSON）也要改成快照字节。

* **chunk 重建。**


  * `chunk_id` 不包含切分器版本。切分策略升级后，同一版本会出现两组互相重叠的 chunk，应把 `chunker_version` 纳入 id。

  * "可以无损重建" 只在 `snapshot_state='stored'` 时成立。`pruned` / `lost` / `withheld_sensitive` / `too_large` / `reference_only` 状态下无法重建，被 pin 住的旧版本会断链。

* **权限先于评分：原则正确，但封顶规则有歧义。** `SENSITIVITY_CAP[confirmed_secret]='full'`（`src/control/visibility-policy.ts:30`）意味着拿到授权就能看全文。结合上面 withheld 的误映射，风险被放大。评分器的输入还包括 `summary_short`，摘要本身也会泄漏敏感信息，方案仅在风险一节提到 redact，没有写成硬性契约。

* **pin range。** 字节范围与切分边界不一定对齐，需要说明 pin 保存的是原始字节范围，与 chunk 边界无关。

* **retention。** "版本被 prune 时 chunk 级联标 stale 再 purge" 与 "pin 必须能回放旧版" 冲突。需要一条规则：被 pin 的版本禁止 prune，或者 prune 后在决策卡上明确显示 "证据已清退"。

**Blocker：无（B2 已计入）　Major：M11 事件早于快照落盘；M12 过程产物会触发验收失效；M13 chunk\_id 缺切分器版本、重建前提不成立；M14 retention 与 pin 冲突　Minor：m4 切片哈希表述错误；m5 摘要进入评分器缺少硬性脱敏**

## 6) 用户体验



* **能减少重建现场成本的部分：** 有版本的证据、pin 住旧版、full 取源真实校验，直接降低 "回到现场" 的成本，这部分有价值。

* **反向增加打断的部分（Major）：** §2.5 和 §5 在决策卡上显示 "模型不确定，请人工判断证据级别"，把系统内部的可见性分级当成元工作推给人，违背 "只在必要时打断" 和 "压缩而非转发噪声"。


  * 模型不确定时应当静默走确定性规则兜底。

  * 只有当必需证据因权限被挡住时，才以 "是否授权查看 X" 这样一个可执行的二选一问题出现。

* **Now / Inbox / Done 的纯度。** 方案在 §5 又说 "降级为 short 或进 Inbox"，把证据可见级别和工作项的注意力分区混在一起。这是两个维度：证据级别不应该影响卡片进 Now 还是 Inbox。§7.4 第 1 条的未决问题本身就说明概念混淆。

* **决策卡上 "为什么只给 short" 应默认折叠或只放在调试视图**，否则就是在增加监控信息。

* **验收失效后的重新验收路径未回应**（核查报告已指出）。产物小改就要人重新走完整的四步验收，是明显的无效打断。

**Blocker：无　Major：M15 把模型不确定性推给人；M16 证据级别与注意力分区混淆；M17 缺少一步重新验收路径　Minor：m6 评分理由默认外露**

## 7) P0–P4 排序



* **P0 塞得太多。** 它同时包含问题链路接通、sensitivity 统一、attention 写路径改造、chunk 表和 candidate 表建表。后两者跟 P0 的目标无关，而且会提前锁定尚未验证的 schema。

* **必须最先做（P0'）：**

1. 根 problem 的 get-or-create，加上 link 的 upsert 修复；

2. `collectContextFacts` 透传 problem\_id；

3. manage 对 attention 的裸 SQL 改为调用 control store API（同一库、同一事务、写事件、带乐观锁）；

4. fetcher 读快照字节并复验哈希。

* **P1 可以缩小：** 先只做 runtime 类的 `test_result` / `tool_receipt`（接到 `mgmt_exec_records`）和一个 "decision-basis 证据版本清单"。git\_commit 采集、shareable 授权 API 往后放。

* **P2 / P3 建议合并并延后：** 先做装配时的临时切片（diff hunk、日志尾部），持久化 chunk 表等指标驱动再做；模型评分放到最后。

* **P4 的 pin 能力应提前到 P1 之后。** 续跑和回到现场是 AGENTS.md 第 6 条，优先级高于评分。

* **sensitivity 统一**：v4 只做读取边界的适配器，表重建放到 v5。

**Blocker：B5 P0 含未验证的 schema，且带着 B1–B4 的缺陷　Major：M18 pin / 续跑排在评分之后，优先级倒置　Minor：无**

## 8) 汇总问题表



| #   | 级别      | 标题                                                       | 位置                                                                | 建议修正                                                                                       |
| --- | ------- | -------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| B1  | Blocker | createProblem 不幂等，且无法指定 `prob:<work_id>`                 | `context-pool.ts:181,184,93`；方案 §4.3 / §6 P0                      | 新增 `ensureRootProblem(work_id)`，做 get-or-create，id 由哈希派生并返回；禁止 reducer 直接 INSERT problem 行 | [已修复] [已过时]：根 problem 已由 v5 迁移（store.ts:166-168）+ createWork/redirectWork/promoteWork 补建（store.ts:250,257,292），orchestrator.ts:326 注入 rootProblemId，linkProblemObject 已改 upsert（context-pool.ts:424）。
| B2  | Blocker | link 主键冲突，fact 出新 revision 时摄入失败                         | `context-pool.ts:397`、`store.ts:114`、`context-reducer.ts:189-224` | 改为 `ON CONFLICT(problem_id, object_id, role) DO UPDATE SET revision`；补充 rev1→rev2 的测试反例    | [已修复] [已过时]：根 problem 已由 v5 迁移（store.ts:166-168）+ createWork/redirectWork/promoteWork 补建（store.ts:250,257,292），orchestrator.ts:326 注入 rootProblemId，linkProblemObject 已改 upsert（context-pool.ts:424）。
| B3  | Blocker | outbox / `applyControlEvent` 在 ledger 库，不是权威 attention 表 | `reducer.ts:84`、`outbox.ts:56-63`、`projection.ts:42-49`；方案 §3.4   | manage 调用 `upsertAttention` 及对应的状态流转 API，在同一 control 库事务内完成，带 `expected_revision`          |
| B4  | Blocker | `ADD COLUMN` 不可重跑、回退不可行                                  | 方案 §3.2 / P0；`store.ts:155-163`                                   | 用 `PRAGMA table_info` 守卫；列只放在迁移里；回退 = 恢复 `VACUUM INTO` 备份                                  |
| B5  | Blocker | P0 范围过大、依赖有缺陷的设计                                         | 方案 §6 P0                                                          | 拆成 P0'（见第 7 节），chunk /candidate 表后移                                                        |
| M1  | Major   | decision 快照化过重                                           | 方案 §2.1 / §4.1                                                    | decision 留在 `mgmt_inputs`，新增 "证据版本清单" 作为 process Artifact                                  |
| M3  | Major   | 忽略 `mgmt_observations` / `mgmt_summaries` / `mgmt_links` | `schema.ts:109,129,162`、`collect.ts:63`                           | 候选与溯源基于 observations /links；摘要存入 `mgmt_summaries`                                          |
| M4  | Major   | chunk 的 stale 可变且自相矛盾                                    | 方案 §2.3 / §4.6                                                    | 删除 stale 列，读时按最新版本推导；补充最新版本指针                                                              |
| M6  | Major   | `withheld→confirmed_secret` 误映射                          | `classify.ts:19-27`、`visibility-policy.ts:30`                     | `withheld→suspected`（或新增 `withheld` 值）；`confirmed_secret` 只能由人工确认                          |
| M7  | Major   | `mgmt_inputs.version` 是整数序号                              | `schema.ts:35,38`、`store.ts:28-33`                                | 新增 `artifact_version_id TEXT` 列，外键指向 versions                                              |
| M8  | Major   | pin 外键不支持 version + range                                | `store.ts:118-126`                                                | 新增 `artifact_id` / `version_id` 及原始字节范围，与 object 引用二选一，在应用层断言                              |
| M9  | Major   | 同一列混存两套 sensitivity 词汇                                   | 方案 §3.5；`collect.ts:65`                                           | v4 不改存储，只在读取边界适配                                                                           |
| M10 | Major   | 表重建时事务内设置外键开关无效                                          | 方案 §3.2 B 类                                                       | 在事务外关闭外键，重建后跑 `foreign_key_check`，并先备份                                                     |
| M11 | Major   | `version_stored` 事件早于快照落盘                                | `collect.ts:62,70`                                                | 改为 control 库本地待投影队列，或扫描 `stored` 状态的版本                                                     |
| M12 | Major   | 过程 / 运行产物会触发验收失效                                         | `collect.ts:67`、`manifest.ts:301`                                 | 失效只由 delivery 类的新版本触发                                                                      |
| M13 | Major   | chunk\_id 缺切分器版本；重建依赖快照存在                                | 方案 §2.3 / §2.6                                                    | id 包含 `chunker_version`；非 `stored` 状态明确标记为不可重建                                             |
| M14 | Major   | retention 与 pin 冲突                                       | 方案 §3.5                                                           | 被 pin 的版本禁止 prune，或在卡片上显式标注 "证据已清退"                                                        |
| M15 | Major   | 模型不确定性推给人                                                | 方案 §2.5 / §5                                                      | 静默走规则兜底；只把 "是否授权" 作为二选一交给人                                                                 |
| M16 | Major   | 证据级别与 Now / Inbox 混淆                                     | 方案 §5 / §7.4 第 1 条                                                | 两个维度解耦                                                                                     |
| M17 | Major   | 缺少一步重新验收路径                                               | 核查报告 §4.4                                                         | 产物更新后在原卡上一键 "基于新版本重新验收"                                                                    |
| M18 | Major   | pin / 续跑排在评分之后                                           | 方案 §6                                                             | pin 与恢复包提前到评分之前                                                                            |
| M2  | Major   | 持久化 chunk 表 + 评分不是 MVP 必需                                | 方案 §2.3–2.5                                                       | 先做装配时临时切片，由指标决定何时落库                                                                        |
| M5  | Major   | Decision Package 未定义                                     | 方案 §0 / §2                                                        | 定义为证据版本清单加决定                                                                               |
| m1  | Minor   | 最新版本靠 `observed_at` 排序推断                                 | `manifest.ts:106`                                                 | 增加明确的最新版本指针，或用序号                                                                           |
| m2  | Minor   | 核查报告全部判为成立，可信度被高估                                        | 核查报告 §3                                                           | 补充 B1–B3、M7、M8 的核查                                                                         |
| m3  | Minor   | 回填兜底 `ELSE 'delivery'`                                   | 方案 §3.2                                                           | 未知 kind 写 NULL 并告警                                                                         |
| m4  | Minor   | "切片哈希等于父哈希的切片" 表述错误                                      | 方案 §2.3                                                           | 改为 "先校验父哈希，再算切片哈希"                                                                         |
| m5  | Minor   | 摘要进入评分器缺少硬性脱敏                                            | 方案 §7.3                                                           | 把 redact 写进评分器契约                                                                           |
| m6  | Minor   | 评分理由默认外露                                                 | 方案 §2.4                                                           | 默认折叠或只放调试视图                                                                                |

## 9) 结论表



| 论断                        | 判定  | 理由                                                                                                            |
| ------------------------- | --- | ------------------------------------------------------------------------------------------------------------- |
| 统一 `mgmt_artifacts` 是正确方向 | 同意  | 已有内容寻址、复合唯一索引、manifest 按 kind 隔离，不需要再建平行库；但 decision 应留在 input，只引用证据版本                                        |
| 上下文作为版本投影而非独立库是正确的        | 同意  | 符合 "内容只有一个权威、投影可重建" 的原则；但要复用 observations /summaries，stale 改为读时推导                                             |
| 代码现状判断准确                  | 不同意 | 大部分引用准确，但 createProblem 幂等性、link 主键冲突、`applyControlEvent` 所在的库、`mgmt_inputs.version` 类型、pin 外键结构这几处关键点判断错误或遗漏 |
| 迁移方案安全可上线                 | 不同意 | `ADD COLUMN` 不可重跑，"降版本号回退" 会导致再次启动失败；`withheld→confirmed_secret` 的映射存在展示越权风险                                  |
| P0–P4 排序合理                | 不同意 | P0 塞进了未验证的 schema；pin / 续跑（AGENTS.md 第 6 条）排在模型评分之后，优先级倒置                                                     |
| MVP 范围合适                  | 不同意 | 应缩小为：接通问题链路（幂等）、attention 走 control store API、full 取源读真实字节并校验、证据版本清单、pin 版本；chunk 表和评分延后                      |



***

## 引用核对（主调度独立核验）

主调度对模型引用的关键 file:line 做了抽查（18 处），结果如下：



| 引用                                                                                                                    | 核验结果 |
| --------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/control/context-pool.ts:205（原 :181，createProblem 起始）` = `problemId(work_id, parent, title)` 哈希派生 id                                       | ✅ 准确 |
| `src/control/store.ts:116（原 :114）` = `PRIMARY KEY (problem_id, object_id, role)`                                              | ✅ 准确 |
| `src/ingest/reducer.ts:84` = `applyControlEvent(db, detail, row.at)`                                                  | ✅ 准确 |
| `src/manage/schema.ts:109` = `CREATE TABLE mgmt_observations`                                                         | ✅ 准确 |
| `src/manage/schema.ts:162` = `CREATE TABLE mgmt_summaries(subject_id, subject_version, generator)`                    | ✅ 准确 |
| `src/manage/classify.ts:3` = `type Sensitivity = "none" \| "suspect" \| "withheld"`                                   | ✅ 准确 |
| `src/manage/collect.ts:62` = `INSERT OR IGNORE INTO mgmt_artifact_versions`                                           | ✅ 准确 |
| `src/control/projection.ts:42` = 读 `control_attention` 当前 revision                                                    | ✅ 准确 |
| `src/control/outbox.ts:56` = `new Database(ledgerPath, {readonly:true})`                                              | ✅ 准确 |
| `src/control/on-demand-fetcher.ts:211` = `reference.match(/^artifact:([^@]+)@([^@]+)$/)`                              | ✅ 准确 |
| `src/control/store.ts:120（原 :118）` = `CREATE TABLE control_context_pins`                                                      | ✅ 准确 |
| `src/control/store.ts:292（原 :284）` = `export function upsertAttention(...)`                                                   | ✅ 准确 |
| `src/manage/schema.ts:57` = `CREATE INDEX mgmt_versions_artifact ON mgmt_artifact_versions(artifact_id, observed_at)` | ✅ 准确 |
| `src/manage/schema.ts:129` = `CREATE TABLE mgmt_links`                                                                | ✅ 准确 |
| `src/manage/manifest.ts:106` = manifest 按 artifact/version 查 kind                                                     | ✅ 准确 |
| `src/control/visibility-policy.ts:30` = `confirmed_secret: "full"`                                                    | ✅ 准确 |

**轻微偏差（非幻觉）**：



* 模型写 "DDL 默认值 `'unknown'`（`schema.ts:52`）"。实际 `sensitivity TEXT NOT NULL DEFAULT 'unknown'` 在 `schema.ts:53`（mgmt\_artifact\_versions 表）；`:52` 是 snapshot\_state 的 CHECK 约束。off-by-one，不影响结论。

**未发现幻觉引用**。模型引用的所有关键 file:line 均真实存在且语义匹配。模型也明确说明自己用 bun 在 /tmp 复现了两个问题（problem\_objects 主键冲突、SQLite ADD COLUMN 不可重跑），这两个结论与源码一致。