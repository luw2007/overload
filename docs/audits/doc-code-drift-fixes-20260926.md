# 文档 vs 代码漂移修复记录

修复日期：2026-09-26
依据审计报告：`docs/audits/doc-code-drift-20260926.md`
修复范围：仅文档。未修改任何 src/ 下代码。未执行 git commit/stash/checkout。

## 修复统计

| 类别 | 总数 | 已修复 | 未采纳/未决 |
|---|---|---|---|
| 主清单矛盾 | 30 | 30 | 0 |
| Omission | 23 | 20 补充 | 3 不补（O5 代码内部不一致、O7 已覆盖、O16 标注死配置） |
| Low 项 | 18 | 11 采纳修复 | 7 未采纳（验证后无需改或不可证伪） |
| 涉及文档 | 22 份 | — | — |
| 总行数变化 | +209 / -100 | — | — |

## 一、主清单 30 条修复明细

### 根文档与运维指南（3 条）

| # | 文件:行 | 修复内容 |
|---|---|---|
| 1 | README.md:24 | `scripts/setup.sh --install` → `scripts/setup.sh` |
| 2 | docs/guides/integrations.md:85 | 远程 pull 配置从 "in ~/.overload/config.json" → "as CLI flags to src/pull/pull.ts" |
| 3 | docs/guides/operations.md:103 | 句尾追加 orchestrator 日志写 ~/.overload/logs/ |

### 核心运行时架构（7 条）

| # | 文件:行 | 修复内容 |
|---|---|---|
| 4 | docs/architecture/orchestrator.md:190-191,287,434 | CI 审批选项 rerun/new-task → recheck/manual-followup；状态转移同步 |
| 5 | docs/architecture/orchestrator.md:97,425 | D1 验收改为 closeout 视图描述，注明原 404 意图与现状偏差待产品确认 |
| 6 | docs/architecture/orchestrator.md:151 | approvals.gate CHECK 扩为四值（+confirm_stopped/keep_held） |
| 7 | docs/architecture/orchestrator.md:275,284 | mailbox 单表→多表；不自建→openMailbox 首次建库；删除 7d 清理断言 |
| 8 | docs/architecture/orchestrator.md:333 | ingest schema 14 张表→17 张表，加注 control 投影表 |
| 9 | docs/architecture/orchestrator.md:135-138 | tasks 建表 SQL 补 8 列（work_id/contract_revision/budget_deadline_at/ci_observation_failures/stop_*） |
| 10 | docs/architecture/tech-solution.md:96 | §2.5 补【已移除】outbox 标注 |

### 上下文与人因（7 条）

| # | 文件:行 | 修复内容 |
|---|---|---|
| 11 | docs/architecture/artifact-management-tech-design.md:277,417 | task_max_bytes → work_max_bytes（3 处） |
| 12 | docs/architecture/artifact-management-tech-design.md:277,417 | retention_days:30 → retain_ms:2592000000 |
| 13 | docs/architecture/artifact-management-tech-design.md:273,472,611 | 删除 freshness_ms 配置键；谓词改为硬编码 120s（handoff.ts:19），标注不读配置 |
| 14 | docs/architecture/artifact-management-tech-design.md:624,1131 | archive_reason='closeout' → 'all_executions_ended' |
| 15 | docs/architecture/artifact-management-tech-design.md:673 | POST /manifests/<id>/accept → /acceptance |
| 16 | docs/architecture/artifact-management-tech-design.md:113 | 不变式③改为 SELECT 阶段限定 closeout_owner，UPDATE 未内联 |
| 17 | docs/decisions/managed-decision-bot.md:47 | prompt 传参从 "literal after --" → "@0600 临时文件（runner.ts:115,131）" |

### plans 跨文档共性矛盾（5 条，覆盖多份文档）

| # | 涉及文档 | 修复内容 |
|---|---|---|
| 18 | audit-context, audit-kiss-task2, context-as-artifact, verification（8 处） | C1：追加 [已过时] artifact-projection.ts 已生产写入 ctype='artifact' |
| 19 | audit-context, audit-mvp-current-code, context-as-artifact, verification（6 处） | C2：追加 [已过时] fetcher 读 snapshot 字节并 sha256 复验 |
| 20 | audit-context, audit-kiss-task1, audit-mvp-current-code, context-as-artifact, review-claude, verification（14 处） | C3：追加 [已过时]/[已修复] 根 problem v5 迁移已落地 |
| 21 | audit-kiss-task3, audit-manage, verification（5 处） | C4：追加 [已完成] 6 处 manage 裸写已收编 Core API |
| 22 | audit-kiss-task1, audit-mvp-current-code, context-as-artifact-mvp, verification（6 处） | C5：追加 [已变更] CONTROL_SCHEMA_VERSION=5 |

### plans 独有 medium（8 条）

| # | 文件:行 | 修复内容 |
|---|---|---|
| 23 | docs/plans/audit-context-20260924.md §0 | 行数表更新：store.ts 652、context-pool.ts 433、on-demand-fetcher.ts 411 |
| 24 | docs/plans/audit-context-20260924.md §1/§9 | DDL 行号 +2；决策复验 store.ts:549-593 |
| 25 | docs/plans/audit-kiss-task2-artifact-projection-20260924.md §7/§9.2 | 注实际实现 projectArtifactVersions(db,work_id)；withheld→unknown |
| 26 | docs/plans/audit-kiss-task3-attention-barewrites-20260924.md §0/§3 | 标题加[已完成]；API 行号校订（supersedeAttention :342 等） |
| 27 | docs/plans/audit-manage-20260924.md §0 | 行数表更新：manifest.ts 367、launch.ts 96、submit.ts 572；sensitivity CHECK :97 |
| 28 | docs/plans/context-as-artifact-20260924.md §1/附录 | §1 顶部加现状快照声明；附录行号 +2 |
| 29 | docs/plans/context-as-artifact-mvp-implementation-20260924.md §2.5 | 加[后续] KISS task1 升 v5 |
| 30 | docs/plans/review-claude-opus-5-5-medium-context-as-artifact-20260924.md §8/§9 | B1/B2 加[已修复]；引用行号校订 |

## 二、Omission 补充（20 条）

| # | 补充位置 | 内容 |
|---|---|---|
| O1 | README.md:62 | 补 attention <id> feedback <json> |
| O2 | README.md:64-65 | 补 candidate <id> approve\|enable <json> |
| O3 | README.md:71 | 补 show <stable_id> 只读命令 |
| O4 | README.md:68 | 补 mgmt works --track 过滤 |
| O6 | README.md:90 + configuration.md:31-32 | 补 --since 支持 ms\|s\|m\|h\|d |
| O8 | orchestrator.md:162-171 | 补后续波次新表清单（7 表） |
| O9 | orchestrator.md:282-284 | 补 decision-bot mailbox 多表与回执机制 |
| O10 | orchestrator.md:341-343 | 补 control_event outbox 投影 |
| O11 | orchestrator.md:200-207 | 补运行态事件（contract_superseded/budget_deadline/no_attempt/context_pending） |
| O12 | tech-solution.md:91 | 补 Q5Reason 新增 turn_hung/dead_connection/handoff_blocked |
| O13 | reconcile.md §1.6（新增） | 补 superseded()/deadlineExceeded()/attemptRecovery() |
| O14 | context-management-plan.md:230 | AttentionItem 补 approval_id、consumer_owner |
| O15 | artifact-management-tech-design.md:284 | 配置示例补 snapshot_root、home_root |
| O17 | context-interaction-design.md:107 | 标注前端未接线 DecisionViewPackage |
| O18 | artifact-management-tech-design.md:675 | 标注 5 个 API 属后续阶段未实现 |
| O19 | audit-context 末尾 | 追加「后续新增」section（artifact-projection/v5/收编 API/ensureRootProblem） |
| O20 | audit-manage 末尾 | 同上 |
| O21 | verification 末尾 | 同上 |
| O22 | （含于 O19-O21） | ensureRootProblem/rootProblemId 导出 |

**未补 omission（3 条）：**
- O5：mgmt scan --once — mgmt.ts:13 未解析该 flag 但 usage 字符串写了，代码内部不一致，不补文档。
- O7：orchestrator 日志路径 — 已被主清单第 3 条覆盖。
- O16：follow_new 死配置 — 已在 artifact-management-tech-design.md:285 标注"被读取但 scanOnce 未使用，属死配置"，不新增功能描述。

## 三、Low 项处理（18 条）

### 采纳并修复（11 条）

| # | 位置 | 修复 |
|---|---|---|
| Low 1/O6 | README + configuration.md | --since 后缀补全（与 O6 合并） |
| Low 4 | orchestrator.md:117 | pull.ts:36 → :65 |
| Low 5 | orchestrator.md 工件表 | runner.log → runner-<attempt_id>.log |
| Low 6 | tech-solution.md:89 | Q4 v1 关闭 → Q4 已落地（判据 done∧agent∧无变更证据） |
| Low 7 | reconcile.md 头部 | 加行号基线快照声明 |
| Low 11 | context-management-plan.md:4 | "不实现" → "已实现（T1–T7）" |
| Low 12 | artifact-management-tech-design.md:669 | checkOrigin 行号 :109-116 → :112-119 |
| Low 13 | artifact-management-tech-design.md:729 | dashboardRoute 行号 :339-341 → :424-426 |
| Low 14 | artifact-management-tech-design.md:386 | trailer 行号 :770-773 → :767-770 |
| Low 16 | audit-context §0 行数表 | recovery-context 376、agent-task-context 142 |
| Low 18 | verification §2.10/§2.5 | 行号 :78→:80、:95→:97 |

### 未采纳（7 条，附理由）

| # | 位置 | 理由 |
|---|---|---|
| Low 2 | configuration.md remote_probe | 文档契约（0=alive/3=dead/其他=unknown）与 recon.ts:508-509 一致，exit 4 落入 unknown 属预期边角，无需改 |
| Low 3 | README legacy 标签清理 | launchd/README.md:47-48 已覆盖，主 README 不重复属合理 |
| Low 8 | ledger-design.md | 头部已有「已被 tech-solution 取代」免责，历史 schema 不符属明示 |
| Low 9 | orchestrator.md spool 预算 | 文档与 ingest.ts:18-19 一致，备查项无需改 |
| Low 10 | tech-solution.md emitter/writer | 与 session_incarnations 表一致，备查项无需改 |
| Low 15 | kiss-followup §4.4 测试计数 | 时点数字（1136 pass 等），只读审计无法证伪，不修改 |
| Low 17 | context-as-artifact §2.8 problem_id 命名 | plan 建议 prob:<work_id> vs 实现 sha256 派生，属设计选择差异非事实错误 |

## 四、未决项结论（用户 2026-09-26 拍板，代码已落地）

原 3 项未决项全部给结论：

1. **/api/q2 读取面删除**（用户裁定：按 D1 原意图删除，不保留 closeout 现语义）。落地：
   - `src/web/server.ts`：删 `GET /api/q2` 路由；`/api/summary` 的 q2 字段改为内联 `SELECT count(*) FROM current WHERE queue='q2'`（不再依赖 queryQ2）；dashboardRoute 白名单去掉 `q2`。
   - `src/shared/queries.ts`：删 `queryQ2` 函数与 `Q2Row` 类型；`queryArchive` 谓词不动。
   - `src/web/static/app.js`：删 `state.q2`、agents 页 fetch keys 的 `'q2'`、Closeout 区块（closeoutCard）、bulk-closeout 按钮与处理逻辑、LEGACY_ZONE 中 q2 条目；"Clear selection" 保留并移到 Decision requests 区。
   - `POST /api/closeout` 路由**保留**（server.ts，资格仍基于 queue='q2'），UI 无入口是预期状态。
   - 保留不动：`classifier.ts:80` 继续产出 `queue='q2'`；`queryArchive` 已含 q2 行投影；`QueueName` 不动。
   - 测试：`src/web/server.test.ts`、`src/shared/queries.test.ts` 移除 queryQ2 import 与断言；CLI 已无 q2 子命令。
2. **freshness_ms 恢复为 config.json 可调配置**。落地：
   - `src/manage/manage.ts`：`ManageConfig` 增加 `freshness_ms:number`；`loadManageConfig` 读 `raw.freshness_ms ?? 120_000`（顶层键，与 archive_grace_ms 同级）。
   - `src/manage/handoff.ts`：`blocked()` 增加 `freshnessMs=120_000` 参数；`checkHandoffPreconditions` 的 opts 增加 `freshnessMs?` 并透传；`HandoffInput` 增加 `freshnessMs?`；`createHandoff` 透传。
   - `src/web/mgmt-routes.ts`：handoff preconditions 与 handoffs POST 两个调用边界 `loadManageConfig().freshness_ms` 传入（无全局状态）。CLI `src/cli/mgmt.ts` 无 createHandoff/checkHandoffPreconditions 调用点，无需接线。
   - 新增测试 `src/manage/handoff.test.ts`：freshnessMs=5000 时 10s 无事件判 stale；默认 120000 行为不变。
3. **decision-bot prompt 维持临时文件方式**（产品确认：@0600 临时文件传参）——代码无需改动，文档表述保持现状。

## 五、本轮（代码侧）改动验证

1. `bun test`：1137 pass / 1 skip / 1 fail（`test/ext-seal-overflow.test.ts` EXT-14(b) inline seal 1MB 写盘 5s 超时，单独重跑仍超时；属真实 fs 写入环境时序问题，与本轮改动无关，本轮未触碰 src/extension）。本轮相关测试文件（server.test.ts、queries.test.ts、handoff.test.ts）52 pass 0 fail。
2. grep 验证：`src` 与 `src/web/static` 中 `queryQ2`、`/api/q2`、`state.q2` 零残留；`POST /api/closeout` 与 `queue='q2'` 属预期保留。
3. 文档同步：`orchestrator.md:97,445` 改为用户 2026-09-26 裁定结论；`artifact-management-tech-design.md:286,472,611` freshness 表述改为配置键；`configuration.md` 补 manage.freshness_ms 行。

## 六、首轮（仅文档）验证记录

1. **逐条回读**：4 个子代理各改完后回读确认新行号与内容。
2. **全文 grep**：被纠正的错误标识符在主清单涉及文档中零命中——
   - `setup.sh --install`（README）：0
   - `config.json`（integrations.md 远程 pull 段）：0
   - `rerun`/`new-task`（orchestrator.md CI 选项）：0
   - `14 张表`（orchestrator.md）：0
   - `task_max_bytes`（artifact-management-tech-design.md）：0
   - `retention_days`（artifact-management-tech-design.md）：0
   - `archive_reason='closeout'`（artifact-management-tech-design.md）：0
   - `literal message after`（managed-decision-bot.md）：0
3. **plans 标注**：10 份 plans 文档含 [已过时]/[已完成]/[已变更]/[已修复] 标注（kiss-followup 无 C1-C5 涉及，正确为 0）。
4. **src/ 未触碰**：git diff 中 src/decision-bot/mailbox.ts、src/orchestrator/approval.ts、src/web/server.ts 三处为用户预存改动（expireActiveTargets/supersedeAttentionById/closeTarget 功能），与本任务无关。本任务 0 行 src/ 改动。
5. **涉及文件列表（22 份文档）**：
   - README.md
   - docs/guides/configuration.md、integrations.md、operations.md
   - docs/architecture/orchestrator.md、tech-solution.md、reconcile.md、artifact-management-tech-design.md、context-management-plan.md、context-interaction-design.md
   - docs/decisions/managed-decision-bot.md
   - docs/plans/ 全部 11 份 .md
