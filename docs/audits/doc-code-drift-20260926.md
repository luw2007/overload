# 文档 vs 实际代码 一致性审计报告

审计日期：2026-09-26
审计仓库：`/Users/luwei.will/ai/overload`
审计方式：只读。未修改任何源码或文档。

## 审计范围

**文档（29 份，约 8173 行）：**
- 根目录：README.md、CONTRIBUTING.md、SECURITY.md、AGENTS.md
- docs/README.md
- docs/architecture/ 9 份
- docs/guides/ 3 份
- docs/decisions/ 2 份
- docs/plans/ 11 份 .md

**代码依据：** src/ 全部（约 33k 行 TS + 2 个 schema.sql）、scripts/*.sh、launchd/*、package.json。

**排除：** docs/history/、docs/research/、docs/superpowers/、docs/demos/、根目录 REVIEW*.md（历史归档）。docs/plans/ 下 .html/.json/_shots/ 不在范围。

## 方法

1. 从文档摘录可证伪的事实性断言（命令、参数、路径、标识符、表名/字段、配置键、默认值、端口、队列/状态名、行为时序）。
2. 在代码中定位实现，给出 file:line 证据。
3. 文档断言与代码实际行为直接冲突 → contradiction。代码有但文档没写 → omission（单独归类）。愿景/风格/无法证伪表述不报。
4. 每条标注 high/medium/low。主清单收 high/medium，low 放附录。
5. 每条给出外科手术式修复建议（精确到文件行）。
6. 同一矛盾被多份文档重复引用 → 归为一条，列出全部出处。

## 未覆盖项

- 未执行 `bun test`（只读审计，不运行测试套件）。
- docs/plans/ 中测试计数类断言（如 "1136 pass"）无法只读证伪，归入 low。
- 前端 UI 行为（app.js 渲染逻辑）仅做静态 grep 核对，未在浏览器中验证。

## 一句话总结

**主清单 30 条矛盾（high 13 / medium 17），omission 23 条，low 18 条。** 根文档与架构文档的矛盾集中在配置键名、路由路径、schema 字面值过时；plans 11 份文档绝大多数矛盾属"代码已变更（P0-MVP + KISS 三项 hotfix 于 2026-09-24 晚落地），文档快照过时"，而非文档当时读错。

---

# 一、跨文档共性矛盾（同一矛盾出现在多份文档）

以下 5 条矛盾在 docs/plans/ 多份文档中重复出现，合并为一条并列出全部出处。

## C1. [high] "无 ctype=artifact 生产写入 / createObject 零调用方"已被 artifact-projection.ts 推翻

**全部出处：**
- `docs/plans/audit-context-20260924.md:49-51` — "生产中没有任何代码创建 ctype='artifact'""createObject 全仓非测试调用方=0"
- `docs/plans/audit-context-20260924.md:162-163` — "反向（mgmt→context）：无任何代码把新 artifact version 投影成 ctype='artifact' 的 context object"
- `docs/plans/audit-kiss-task2-artifact-projection-20260924.md:198,124` — "非测试调用 createObject 为 0""没有任何 producer 写入 reference 为 artifact:... 的行"
- `docs/plans/audit-mvp-current-code-20260924.md:41-45` — "createWork 无任何 problem 创建"（关联根 problem，见 C3）
- `docs/plans/context-as-artifact-20260924.md:38,47,75-78,82` — §1 现状断言
- `docs/plans/verification-context-as-artifact-20260924.md` §2 对照表 2.11/2.12 — "createObject 生产调用方为 0""唯一生产写入 ctype='fact'"

**代码实际：** `src/control/artifact-projection.ts:103` 调用 `createObject({..., ctype: "artifact", ...})`，由 `src/manage/manifest.ts:247` 在 `requestAcceptance` 中触发。

**矛盾说明：** 代码已变更。KISS task2 落地后，artifact 投影器已生产化。文档描述的 2026-09-24 早间快照不再成立。

**外科手术修复：** 在每份文档的相关段落后追加标注：`[已过时 2026-09-24 晚]：新增 src/control/artifact-projection.ts，ctype='artifact' 由 requestAcceptance（manifest.ts:247）投影写入，createObject 不再零调用。` 无需改旧结论（其为历史快照）。

---

## C2. [high] "fetcher 返回 JSON.stringify(row)、不读 snapshot 字节、content_hash 闭环缺失"已被推翻

**全部出处：**
- `docs/plans/audit-context-20260924.md:91-95` — "artifact 分支取源返回 JSON.stringify(row)""不读 snapshot_path 指向的文件字节""闭环=完全缺失"
- `docs/plans/audit-context-20260924.md:83` — "artifact:<id>@<ver> → JSON.stringify(row)（L28）"
- `docs/plans/audit-mvp-current-code-20260924.md:273-290` — 引用 `return { payload: JSON.stringify(row) }`
- `docs/plans/context-as-artifact-20260924.md:75-78` — §1.6 现状
- `docs/plans/verification-context-as-artifact-20260924.md` §2 对照表 2.17/2.18 — "artifact 分支哈希 9 列行 JSON、不读 snapshot 字节"

**代码实际：** `src/control/on-demand-fetcher.ts:245` `bytes = readFileSync(resolved)`；`:249` `sha256(bytes)` 比对 `row.content_sha256`；`:257` `return { payload: bytes.toString("utf8") }`。`src/shared/context-contract.ts:28` 注释已改为"原始文件字节（sha256 = content_sha256）"。

**矛盾说明：** 代码已变更。被引用的 `return { payload: JSON.stringify(row) }` 行已不存在。

**外科手术修复：** 每份文档相关段落追加：`[已过时]：fetcher artifact 分支已重写为读 snapshot_path 字节并 sha256 复验（on-demand-fetcher.ts:211-258），context-contract.ts:28 已同步。`

---

## C3. [high] "根 problem 从未创建 / collector 不传 problem_id / problem_objects 恒空"已被 v5 迁移推翻

**全部出处：**
- `docs/plans/audit-context-20260924.md:118` — "collector 从不设置 problem_id""linkProblemObject 永不执行，control_context_problem_objects 恒空"
- `docs/plans/audit-kiss-task1-rootproblem-20260924.md` §3/§5/§9.2 — "v4 迁移不回填存量 active work""createWork 幂等分支不补根 problem""redirectWork activate 分支不建根 problem"
- `docs/plans/audit-mvp-current-code-20260924.md:41-45,54` — "生产代码从未调用 createProblem""整个系统当前没有任何根 problem 被创建"
- `docs/plans/audit-mvp-current-code-20260924.md:119-126` — "linkProblemObject 普通 INSERT，无 ON CONFLICT"
- `docs/plans/context-as-artifact-20260924.md:82` — §1.7 现状
- `docs/plans/verification-context-as-artifact-20260924.md` §2 对照表 2.21/2.22/2.23 — "orchestrator 不传 problem_id""createProblem 零生产调用方""problem_objects 恒空"
- `docs/plans/review-claude-opus-5-5-medium-context-as-artifact-20260924.md:135-136` §8 B1/B2 — "createProblem 不幂等""linkProblemObject 普通 INSERT 撞 PK"

**代码实际：** `src/orchestrator/orchestrator.ts:326` 传 `problem_id: rootProblemId(row.work_id)`；`src/control/store.ts:166-168` v5 迁移遍历 `control_works` 逐行 `ensureRootProblemLocked`；`store.ts:250,257,292,648` 在 createWork/redirectWork/promoteWork 事务内补建；`src/control/context-pool.ts:424` `linkProblemObject` 已改 `INSERT ... ON CONFLICT(problem_id,object_id,role) DO UPDATE`。

**矛盾说明：** 代码已变更。KISS task1（根 problem 回填）+ MVP 已落地。

**外科手术修复：** 每份文档相关段落追加：`[已过时]：根 problem 已由 v5 迁移（store.ts:166-168）+ createWork/redirectWork/promoteWork 补建（store.ts:250,257,292），orchestrator.ts:326 注入 rootProblemId，linkProblemObject 已改 upsert（context-pool.ts:424）。`

---

## C4. [high] "manage 直写 control_attention 绕过 revision 锁"已全部收编为 Core API

**全部出处：**
- `docs/plans/audit-kiss-task3-attention-barewrites-20260924.md` §0 B1/B2/B3 — `relations.ts:55`、`manifest.ts:311`、`launch.ts:96` 三处裸写
- `docs/plans/audit-manage-20260924.md:139-145,209-216` — 列出 6 处：`manifest.ts:284,323`、`relations.ts:55`、`launch.ts:53,69`、`submit.ts:461`
- `docs/plans/verification-context-as-artifact-20260924.md` §2 对照表 2.8 — "六处 manage 裸写绕过 CAS"

**代码实际：** `relations.ts:55` 现调 `supersedeOpenAttentionByWork`；`manifest.ts:317` 现调 `supersedeAttentionById`；`launch.ts:96` 现调 `resolveAttentionByExternalSuccess`；`submit.ts` 改 `upsertAttention`；`manifest.ts:286` 改 `recordAttentionResolution`；`launch.ts:53` 改 `upsertAttention`。`grep UPDATE control_attention src/manage/` 零命中。3 个新 Core API 在 `src/control/store.ts:432,466,490`。

**矛盾说明：** 代码已变更。MVP + KISS task3 已把 6 处全部收编。

**外科手术修复：** 每份文档相关段落顶部加：`[已完成 2026-09-24 晚]：6 处裸写全部改走 control store 权威 API（supersedeOpenAttentionByWork / supersedeAttentionById / resolveAttentionByExternalSuccess / upsertAttention / recordAttentionResolution），manage/ 对 control_attention 仅剩 SELECT。`

---

## C5. [medium] CONTROL_SCHEMA_VERSION 已从 3/4 变为 5

**全部出处：**
- `docs/plans/audit-kiss-task1-rootproblem-20260924.md` §1 L40 — "CONTROL_SCHEMA_VERSION = 4"
- `docs/plans/audit-mvp-current-code-20260924.md:350,500` — "CONTROL_SCHEMA_VERSION = 3"，迁移链 v1→v2→v3
- `docs/plans/context-as-artifact-mvp-implementation-20260924.md:105,190` — "3→4""手置 version=5 → 抛 blocked newer than supported 4"
- `docs/plans/verification-context-as-artifact-20260924.md` §2 对照表 2.26 — "CONTROL_SCHEMA_VERSION = 3（store.ts:18）"

**代码实际：** `src/control/store.ts:20` `export const CONTROL_SCHEMA_VERSION = 5`。迁移链 v1→v2→v3→v4→v5。拒启文案为 `newer than supported 5`。

**矛盾说明：** 代码已变更。MVP 升 v4，KISS task1 升 v5。

**外科手术修复：** 每份文档版本号处改为 5，注明 v4（收编 ensureContextReducerSchema）、v5（回填根 problem，store.ts:166-168）。

---

# 二、根文档与运维指南

## README.md

### [high] Quick start 让用户执行 `scripts/setup.sh --install`，但 setup.sh 不接受 `--install`

- **文档位置：** README.md:24 — 原文：`scripts/setup.sh --install`
- **代码实际：** scripts/setup.sh:19-24 — `case "${1-}" in "") ;; --dry-run) ... ;; -h|--help) ... ;; *) usage >&2; exit 2 ;; esac`。`--install` 落入 `*)` 分支，打印 usage 后 exit=2。无参数即默认 install。
- **矛盾说明：** 按 README Quick start 复制粘贴，第三步必然失败。
- **外科手术修复：** README.md:24 改为 `scripts/setup.sh`（与 setup.sh:8 usage `Usage: setup.sh [--dry-run]` 一致）。

## docs/guides/integrations.md

### [high] 远程 pull 配置被写成放进 `~/.overload/config.json`，实际 pull.ts 只读 CLI flag

- **文档位置：** integrations.md:85 — 原文："Configure the remote, spool path, destination, command paths, failure threshold, and timeout in `~/.overload/config.json`"
- **代码实际：** src/pull/pull.ts:231-257 `loadConfig(args)` 仅从 `values.get(...)`（argv）取值，整文件无 `readFile(...config.json)`。install-launchd.sh:66 生成的 pull plist 只传 `--once`。
- **矛盾说明：** 按文档把这些键写进 config.json 无任何效果。且与同仓库 configuration.md:41（正确说法：CLI flags）直接冲突。
- **外科手术修复：** integrations.md:85 改为 "Configure the remote, spool path, destination, command paths, failure threshold, and timeout as CLI flags to `src/pull/pull.ts` (see [configuration.md](configuration.md))"。

## docs/guides/operations.md

### [medium] "Service stdout and stderr are in /tmp/overload-*.{log,err}" 对可选 orchestrator 不成立

- **文档位置：** operations.md:103 — 原文："Service stdout and stderr are in `/tmp/overload-*.{log,err}`."
- **代码实际：** scripts/install-launchd.sh:79-80 — orchestrator 的日志写到 `~/.overload/logs/orchestrator.{log,err}`（logs_dir=$HOME/.overload/logs，line 47）。默认四个服务（ingest/web/maintenance/pull）确实落 /tmp。
- **矛盾说明：** 仅在 `--with-orchestrator` 安装时偏差。
- **外科手术修复：** operations.md:103 句尾加："The optional orchestrator job writes its logs under `~/.overload/logs/` instead."

## CONTRIBUTING.md / SECURITY.md / AGENTS.md / docs/README.md / docs/guides/configuration.md

无可证伪矛盾。configuration.md 中配置键逐项核对（scan_interval_ms=2000、web_port=4870、approval_gate.timeout_ms=1800000 等）均与代码一致。

---

# 三、核心运行时架构文档

## docs/architecture/orchestrator.md

### [high] CI 异常审批选项与状态转移名全部对不上

- **文档位置：** orchestrator.md:267 — `options ["rerun","new-task","abandon"]`；:186 — `awaiting_human(ci) | answer=rerun | submitted`；:187 — `answer=new-task | done`。
- **代码实际：** src/orchestrator/orchestrator.ts:290,301 注册选项为 `["recheck","manual-followup","abandon"]`；src/orchestrator/store.ts:18 转移表为 `"answer=recheck":"submitted"`、`"answer=manual-followup":"blocked"`。不存在 `answer=rerun` 或 `answer=new-task`。
- **矛盾说明：** 文档承诺的三个选项名、`new-task→done` 落点在代码里都不存在。
- **外科手术修复：** orchestrator.md:186-187,267 — `answer=rerun`→`answer=recheck`；`answer=new-task | done`→`answer=manual-followup | blocked(manual_followup)`；options 改为 `["recheck","manual-followup","abandon"]`。

### [high] D1 验收「/api/q2 返回 404」未达成，queryQ2 仍在

- **文档位置：** orchestrator.md:97 — "验收：/api/q2 返回 404"；:421 — 删除 `queryQ2`、`/api/q2`、CLI `q2`。
- **代码实际：** src/web/server.ts:323 仍有 `if (request.method === "GET" && url.pathname === "/api/q2")`；src/shared/queries.ts:210 仍导出 `queryQ2`；src/web/server.ts:217 `/api/summary` 仍返回 `q2: queryQ2(db).length`。
- **矛盾说明：** D1 被描述为用户裁定且 M0 必达验收，实际 q2 路由/查询/字段全部保留（语义改作 closeout 视图，而非删除）。
- **外科手术修复：** orchestrator.md:97 验收句改为「/api/q2 现为 closeout 视图（origin=unknown 或已 closeout 的 q2 行），不再是 Inbox 待收尾区」；:421 删除条目改为「q2 区从 Inbox 待收尾语义改为 closeout 视图，路由保留」。若产品意图确实是删除，则建议改代码 server.ts:323、queries.ts:210-213、server.ts:217（不在本轮动手）。

### [medium] approvals.gate CHECK 约束文档只列两个值，实际有四个

- **文档位置：** orchestrator.md:147 — `CHECK(gate IN ('ready','ci_anomaly'))`
- **代码实际：** src/orchestrator/schema.sql:30 — `CHECK(gate IN ('ready','ci_anomaly','confirm_stopped','keep_held'))`
- **矛盾说明：** 文档 SQL 字面值与现网 CHECK 不一致；后两个 gate 来自 anomaly-monitor 波次。
- **外科手术修复：** orchestrator.md:147 CHECK 列表扩为 `('ready','ci_anomaly','confirm_stopped','keep_held')`。

### [medium] §3.9 mailbox 描述「单表」「7 天清理」「web 不自建文件」均与代码不符

- **文档位置：** orchestrator.md:271 — "独立文件…单表""文件不存在时静默失败而不是自建"；:280 — "保留策略：每 tick 删除 at < now-7d 的残留行"。
- **代码实际：** src/decision-bot/mailbox.ts:28-42 在同一文件内建 `answers/approval_targets/answer_metadata/bot_identity/bot_control/bot_attempts/bot_proposals/decision_receipts/receipt_effect_observations/policy_candidates/policy_candidate_samples/policy_rule_state/policy_rule_events/effect_reconcile_cursor` 等 15 张表；全仓无 `DELETE FROM answers ... at < now-7d` 类保留清理（mailbox.ts:75 只在消费后 `DELETE FROM answers WHERE approval_id=?`）；`openMailbox`（mailbox.ts:27）`mkdirSync + new Database(...,{create:true})`，web 侧 server.ts:380 直接 `openAnswersDb(controlPath)`，文件缺失即自建。
- **矛盾说明：** 三条事实性承诺全部不成立。`answers` 表列结构与文档一致，但「单表」「7d 清理」「web 不自建」是后续 decision-bot/control 波次打破的初版设计。
- **外科手术修复：**
  1. orchestrator.md:271「单表」改为「初版单表，现由 decision-bot mailbox 扩展为多表（approval_targets/decision_receipts/bot_* 等），文件路径不变」；
  2. :271「文件不存在时静默失败而不是自建」改为「web 与 orchestrator 共用 `openMailbox`，首次访问即建库建表」；
  3. :280 删除「保留策略：每 tick 删除 at < now-7d 的残留行」，或改为「当前无 7d 残留行清理；过期 target 由 `expireActiveTargets`（mailbox.ts:85）关闭而非删除」。

### [medium] §4.2 称 ingest schema 有「14 张表」，实际 17 张

- **文档位置：** orchestrator.md:329 — "`src/ingest/schema.sql` 的 14 张表一律不写"
- **代码实际：** src/ingest/schema.sql 含 17 个 `CREATE TABLE`（journal、cursors、sessions、session_incarnations、requests、reducer_cursor、applied_control_events、control_attention、control_attention_feedback、current、queue_transitions、classifier_activations、attachments、session_hosts、incidents、coverage_gaps、source_generations）。
- **矛盾说明：** 数量过时；后三张 control 投影表是 control 波次加入。
- **外科手术修复：** orchestrator.md:329「14 张表」改为「全部表」（或实际数量 17，并加注 control_* 为投影表）。

### [medium] §3.2 tasks 建表 SQL 缺 8 列

- **文档位置：** orchestrator.md:126-135 的 `CREATE TABLE tasks(...)`
- **代码实际：** src/orchestrator/schema.sql:12-17 多出 `work_id, contract_revision, budget_deadline_at, ci_observation_failures, stop_state, stop_requested_at, stop_deadline_at, stop_reason`；store.ts:33-35 另有 `ALTER TABLE ... ADD COLUMN` 兼容旧库。
- **矛盾说明：** 文档给出的完整建表 SQL 字面值与现网 schema 不符。
- **外科手术修复：** orchestrator.md:135 `created_at ...` 行前补一行 `work_id TEXT, contract_revision INTEGER, budget_deadline_at INTEGER, ci_observation_failures INTEGER NOT NULL DEFAULT 0, stop_state TEXT, stop_requested_at INTEGER, stop_deadline_at INTEGER, stop_reason TEXT,`，注明「由 control/anomaly 波次加入，旧库经 store.openStore 幂等 ALTER」。

## docs/architecture/tech-solution.md

### [medium] §2.5 承诺的 notifications outbox 表与投递状态机不存在

- **文档位置：** tech-solution.md:96-101 — `notifications(notification_uid ... sink, kind, reminder_seq, state, attempt_at, sent_at, retry_count)`，状态机 `pending→attempting→sent|failed_permanent`，退避 1/5/15min，5 次后 `failed_permanent`。
- **代码实际：** src/ingest/schema.sql 无 `notifications` 表；src/notify/nudge.ts 仅按 `request_uid`/`stable_id` 集合差发一次 macOS 通知，无 outbox、无 attempt_at/sent_at/retry_count、无退避重试。
- **矛盾说明：** 文档头已声明「outbox/digest/attrib/Island 原生面板已从代码移除」，但正文 §2.5 仍把 outbox 写成落地契约。
- **外科手术修复：** tech-solution.md:96 §2.5 标题处补一行「【已移除】v1 未实现 outbox；通知由 src/notify/nudge.ts 集合差直投，无重试/退避/failed_permanent」。

## docs/architecture/reconcile.md

逐条核对与代码高度一致（renewLeases SQL、expectOwner CAS、probeRunnerLiveness、task_recovery 四分支、13 行枚举、install-launchd --with-orchestrator），无 high/medium 矛盾。仅文件内 file:line 因后续波次整体漂移约 20–130 行（见 low 附录）。

## docs/architecture/implementation-contract.md / ledger-design.md

implementation-contract.md 与代码目录结构、API 名称对得上，无 high/medium 矛盾。ledger-design.md 头部已自标「已被 tech-solution 取代，保留作演进记录」，其 schema 与现网不符属明示历史，不报。

---

# 四、上下文与人因文档

## docs/architecture/artifact-management-tech-design.md

### [high] 快照配置键 `task_max_bytes` 与代码 `work_max_bytes` 不符

- **文档位置：** artifact-management-tech-design.md:276 — `"snapshot":{"file_max_bytes":2097152,"task_max_bytes":67108864,"retention_days":30}`；同文 :413 两处复用 `task_max_bytes`。
- **代码实际：** src/manage/manage.ts:23 — `work_max_bytes:raw.snapshot?.work_max_bytes??64*1024*1024`；消费处 manage.ts:56 传 `workMaxBytes:cfg.snapshot.work_max_bytes`。
- **矛盾说明：** 用户照文档写 `task_max_bytes` 会被静默忽略、回退默认 64 MiB。
- **外科手术修复：** 文档 :276、:413 三处 `task_max_bytes` 全部改为 `work_max_bytes`。

### [high] 快照保留期配置 `retention_days` 与代码 `retain_ms` 不符

- **文档位置：** artifact-management-tech-design.md:276 — `"retention_days":30`；:413 "`retention_days` 后…blob 删除"。
- **代码实际：** src/manage/manage.ts:23 — `retain_ms:raw.snapshot?.retain_ms??30*DAY`（毫秒）。
- **矛盾说明：** 文档用天数键 `retention_days`，代码用毫秒键 `retain_ms`。照文档写不生效，且单位语义不一致。
- **外科手术修复：** 文档 :276 `"retention_days":30` 改为 `"retain_ms":2592000000`；:413 "`retention_days` 后"改为"`retain_ms` 后"。

### [medium] 配置键 `freshness_ms` 在代码中无任何读取

- **文档位置：** artifact-management-tech-design.md:273 — 顶层 `"freshness_ms":120000`；:468 "可信终止 … `current.last_event_at >= now - freshness_ms`（默认 120 000）"；:607 复用。
- **代码实际：** grep `freshness` 在 src/manage、src/control、src/web 零命中。ManageConfig（manage.ts:15）无 freshness_ms 字段。120s 阈值在 src/manage/handoff.ts:19 硬编码为 `now-last>120_000`。
- **矛盾说明：** 文档把 `freshness_ms` 列为可配置键；代码既不读该键，也无对应谓词（硬编码 120s）。
- **外科手术修复：** 文档 :273 删除 `"freshness_ms":120000,`；:468、:607 把"`freshness_ms`（默认 120 000）"改为"硬编码 120 000 ms（src/manage/handoff.ts:19）"。若要保留可调，建议改代码 manage.ts:15,23 增加 freshness_ms 并在 handoff.ts:19 引用（不在本轮动手）。

### [medium] 归档理由值 `archive_reason='closeout'` 与代码 `'all_executions_ended'` 不符

- **文档位置：** artifact-management-tech-design.md:1125（场景 17）— "`archive_reason='closeout'`"；:621 SQL 草案 `archive_reason='closeout'`。
- **代码实际：** src/manage/archive.ts:23 — `UPDATE mgmt_work_profile SET ... archive_reason='all_executions_ended' ...`。
- **矛盾说明：** 按文档断言查库会查不到。
- **外科手术修复：** 文档 :1125 与 :621 把 `'closeout'` 改为 `'all_executions_ended'`。

### [medium] 验收提交路径 `/manifests/<id>/accept` 与代码 `/acceptance` 不符

- **文档位置：** artifact-management-tech-design.md:669 — "`POST /manifests/<id>/accept {verdict, reason}`"
- **代码实际：** src/web/mgmt-routes.ts:43 路由正则 `/^\/api\/mgmt\/manifests\/([^/]+)\/acceptance$/`，:91-111 处理 POST。
- **矛盾说明：** 客户端按文档拼路由会 404。
- **外科手术修复：** 文档 :669 把 `POST /manifests/<id>/accept` 改为 `POST /manifests/<id>/acceptance`。

### [medium] 归档 UPDATE 未在 WHERE 内联 `AND closeout_owner='mgmt'`

- **文档位置：** artifact-management-tech-design.md:113 不变式③ — "manage 写 `track_state='archived'` 前必须附加 `AND closeout_owner='mgmt'`"
- **代码实际：** src/manage/archive.ts:23 的 UPDATE WHERE 仅 `work_id=? AND track_state='tracking'`，无 `AND closeout_owner='mgmt'`；mgmt 属主过滤来自 :17 的 SELECT（`WHERE p.closeout_owner='mgmt'`），再逐行 UPDATE。
- **矛盾说明：** 文档要求条件更新语句本身带守卫（防读后写竞态），代码把守卫放在前置 SELECT。若两扫描间 profile 被 coordinator 接管，SELECT 结果已固定仍会 UPDATE 一行。
- **外科手术修复：** 二选一——(a) 改文档 :113 措辞为"归档候选 work 在 SELECT 阶段已限定 `closeout_owner='mgmt'`（src/manage/archive.ts:17）"；(b) 建议改代码 archive.ts:23 的 UPDATE 追加 `AND closeout_owner='mgmt'`。倾向 (a)，最小改动。

## docs/decisions/managed-decision-bot.md

### [medium] "prompt 以字面量经 -- 传入"与代码 `@临时文件` 传参不符

- **文档位置：** managed-decision-bot.md:47 — "No @untrusted file expansion; pass prompt as literal message after `--` where supported"
- **代码实际：** src/decision-bot/runner.ts:116-132 构造的 argv 为 `["pi","--no-tools",...,"--system-prompt",systemPrompt,\`@${promptPath}\`]`——prompt 写入私有临时文件（:115 `writeFile(promptPath, prompt, {mode:0o600})`），再以 `@<path>` 传入，argv 中无 `--` 分隔符。
- **矛盾说明：** 文档明确要求不用 `@file` 展开、把 prompt 作为 `--` 后的字面消息传入；代码实际用 `@私有临时文件` 且无 `--`。@ 指向 bot 自写 0600 临时文件，非不可信事件路径，但仍违反文档字面承诺。
- **外科手术修复：** 文档 :47 改为"write prompt to a mode 0600 private temp file and pass `@<tempfile>`（src/decision-bot/runner.ts:115,131）；不引用事件提供的任意路径"。若要严格字面量传参，建议改代码 runner.ts:131（不在本轮动手）。

## docs/architecture/context-management-plan.md / context-interaction-design.md / human-decision-design.md / docs/decisions/git-boundary.md

无 high/medium 矛盾。context-management-plan.md:4 自称"本轮只写方案、不实现"，但代码已落地上下文池（context-pool.ts、context-assembler.ts 等，被 context-routes.ts:12 import）——属状态标注过时，归 low 附录。context-interaction-design 路由与 server.ts:220、context-routes.ts:40 一致。human-decision-design 注意力态/effect_state 与 store.ts:37-38、types.ts:45 一致。git-boundary 自述"立项未排期"，描述目标边界非当前行为。

---

# 五、plans 文档独有矛盾（不与其他文档重复的 medium 项）

以下为 plans 各文档中不落入 C1–C5 跨文档主题的独有发现。

## docs/plans/audit-context-20260924.md

### [medium] §0 文件行数表 4 个文件已漂移

- **文档位置：** L11-33 行数表
- **代码实际：** `store.ts 488→652`、`context-pool.ts 407→433`、`on-demand-fetcher.ts 375→411`；`recovery-context.ts 377→376`、`agent-task-context.ts 143→142`。
- **矛盾说明：** 代码已变更。store.ts +164（v5 迁移 + 3 个 attention 新 API）。
- **外科手术修复：** 更新三行：`store.ts 652`、`context-pool.ts 433`、`on-demand-fetcher.ts 411`。

### [medium] store.ts DDL 区所有 file:line 整体下移 +2，决策复验区大幅后移

- **文档位置：** L41（ctype CHECK :78）、L79-86、L113、L131、L135、L157（决策入口复验 store.ts:390-416）
- **代码实际：** ctype CHECK `store.ts:80`；pins DDL `:120`；shares DDL `:130`；权限复验 `resolveAttentionDecision` 现位于 `store.ts:549-593`。
- **矛盾说明：** problems 表新增 root_problem_id/state/revision 列导致 DDL 区 +2；:388 之后新增约 +164 行把复验区顶到 :549+。
- **外科手术修复：** DDL 区行号统一 +2；`store.ts:390-416` 改为 `store.ts:549-593`。

## docs/plans/audit-kiss-task2-artifact-projection-20260924.md

### [medium] 落地实现与本文 §9.2 建议存在偏离（plan vs 实现）

- **文档位置：** §9.2 — 建议函数名 `projectManifestArtifacts(db, manifestId, now)`、按 manifest entries 投影、在 upsertAttention 之前调用。
- **代码实际：** 函数名为 `projectArtifactVersions(db, work_id, now)`（artifact-projection.ts:67），按 work 投影全部 stored/reference_only version，在 `manifest.ts:247` upsertAttention（:214）之后调用。
- **矛盾说明：** 非矛盾，属实现选择偏离建议。文档为 plan，不强制对齐。
- **外科手术修复：** 无需改文档；若要留痕，在 §9.2 注一句实际实现。

### [medium] 建议 withheld→confirmed_secret，实际实现为 withheld→unknown

- **文档位置：** §7 L259 — 建议映射 `withheld → confirmed_secret`
- **代码实际：** artifact-projection.ts:28 `withheld: "unknown"`（注释自承"绝不映射成 confirmed_secret"）；withheld_sensitive 快照不进投影白名单（:83 只收 stored/reference_only）。
- **矛盾说明：** 实现主动采纳了 review-claude M6 的反对意见，偏离本审计建议。plan 性质，非错误。
- **外科手术修复：** 无需改。

## docs/plans/audit-kiss-task3-attention-barewrites-20260924.md

### [medium] store.ts 内 API 行号全部后移

- **文档位置：** §0 L28（supersedeAttention store.ts:330）、§3 表（recordAttentionResolution :376-406、resolveAttentionDecision :408-496、actOnAttention :498-515）
- **代码实际：** `supersedeAttention` 现 `store.ts:342`；`recordAttentionResolution` `:388-418`；`resolveAttentionDecision` `:527-615`；`actOnAttention` `:617-634`。
- **外科手术修复：** 行号整体校订为上述新值。

## docs/plans/audit-manage-20260924.md

### [medium] §0 文件行数表 3 个文件漂移

- **文档位置：** L11-33 表
- **代码实际：** `manifest.ts 373→367`、`launch.ts 69→96`、`submit.ts 558→572`。
- **外科手术修复：** 三行行数校订为 367/96/572。

### [medium] sensitivity CHECK 行号 :95 → :97

- **文档位置：** L147、L429 — `src/control/store.ts:95`
- **代码实际：** `store.ts:97`
- **外科手术修复：** `:95` 改为 `:97`。

## docs/plans/context-as-artifact-20260924.md

### [medium] 证据索引行号漂移

- **文档位置：** 附 L494-505 — `control sensitivity CHECK store.ts:95`、`ctype CHECK store.ts:78`
- **代码实际：** `:97`、`:80`
- **外科手术修复：** +2 校订。

## docs/plans/context-as-artifact-mvp-implementation-20260924.md

（除 C5 schema 版本外，与当前代码高度一致。rootProblemId、linkProblemObject upsert、fetcher 前 8KB NUL 拒二进制、contract.ts:28 改快照字节——全部与代码一致。）

## docs/plans/review-claude-opus-5-5-medium-context-as-artifact-20260924.md

### [medium] §9 引用核对表中 store/pool 行号漂移

- **文档位置：** §9 L311-326 — `store.ts:114 PK`、`store.ts:118 pins`、`store.ts:284 upsertAttention`、`context-pool.ts:181`
- **代码实际：** `:116`、`:120`、`:292`；createProblem 起始 `:205`、problemId `:93-95`。
- **外科手术修复：** 按上列校订。

## docs/plans/verification-context-as-artifact-20260924.md

### [low] 2.10/2.5 行号漂移

- **文档位置：** §2.10 L98（ctype CHECK store.ts:78）、§2.5 L57（sensitivity CHECK store.ts:95）
- **代码实际：** `:80`、`:97`
- **外科手术修复：** +2 校订。

## docs/plans/context-as-artifact-kiss-followup-20260924.md

与当前代码高度一致，无 high/medium 矛盾。§4.4 测试计数（1136 pass 等）为时点数字，无法只读证伪，归 low。

---

# 六、Omission 简表（代码有、文档未写，不计入 contradiction）

| # | 文档 | 遗漏内容 | 代码证据 |
|---|---|---|---|
| O1 | README.md:60-61 | `attention <id> feedback <json>` 动作 | overload.ts:76 |
| O2 | README.md:63 | `candidate <id> approve\|enable <json>` 子动作 | overload.ts:60-63 |
| O3 | README.md:56-74 | `show <stable_id>` 只读命令 | overload.ts:295 |
| O4 | README.md:65 | `mgmt works --track <tracking\|paused\|archived>` 过滤 | mgmt.ts:14 |
| O5 | README.md 全文 | `orch ...` 子命令入口（orchestrator CLI） | overload.ts:277 |
| O6 | configuration.md / README.md | `--since` 支持 `s`/`m` 后缀（文档只列 ms/h/d） | audit.ts:113 |
| O7 | operations.md | orchestrator 日志路径不在 /tmp | install-launchd.sh:79-80 |
| O8 | orchestrator.md §3.2 | 未记新表：applied_receipts、approval_intents、context_collector_cursor、attempt_signal_samples、attempt_check_results、work_anomaly_budget、anomaly_card_intents | schema.sql:47-127 |
| O9 | orchestrator.md §3.9 | 未记 decision-bot mailbox 的 approval_targets/decision_receipts/bot_* 等表与回执机制 | mailbox.ts:28-42 |
| O10 | orchestrator.md §4 | 未记 control_event outbox 投影（outbox.ts、projection.ts、ledger applied_control_events/control_attention） | src/control/outbox.ts |
| O11 | orchestrator.md §3.3 | 未记 contract_superseded_occupancy_held、budget_deadline_at、no_attempt、context_pending 等运行态事件 | store.ts:16-20 |
| O12 | tech-solution.md §2.4c | 未记 Q5Reason 新增 turn_hung/dead_connection/handoff_blocked | types.ts:57 |
| O13 | reconcile.md | 未记 orchestrator.ts 后来加入的 superseded()/deadlineExceeded()/attemptRecovery() | orchestrator.ts |
| O14 | context-management-plan §3.1 | AttentionItem 代码另含 approval_id、consumer_owner 两列 | store.ts:41 |
| O15 | artifact-management-tech-design :270-276 | ManageConfig 含 snapshot_root（默认 ~/.overload/artifacts/mgmt）、home_root（env OVERLOAD_HOME_ROOT） | manage.ts:23 |
| O16 | artifact-management-tech-design :273 | follow_new 配置被读取但 scanOnce 未使用——死配置 | manage.ts:23 |
| O17 | context-interaction-design §3/§4 | 前端未接线 DecisionViewPackage（app.js 无 decision-package/fetch-full/scene_entry/jump_target/performJump 调用） | app.js:348 |
| O18 | artifact-management-tech-design :669 | POST /works/<id>/inputs、/handoffs/<id>/reconcile、/handoffs/<id>/bind、GET /versions/<id>/content、POST /works/<id>/share-package 均无对应路由 | mgmt-routes.ts |
| O19 | plans（早期文档） | 新增 src/control/artifact-projection.ts（263 行投影器） | artifact-projection.ts |
| O20 | plans（早期文档） | v5 迁移 + 根 problem 回填 | store.ts:166-168 |
| O21 | plans（早期文档） | 3 个 attention 收编 API | store.ts:432,466,490 |
| O22 | plans（早期文档） | ensureRootProblem/rootProblemId 导出 | context-pool.ts:98,236 |
| O23 | README.md:65 | mgmt scan usage 字符串写了 `[--once]` 但 mgmt.ts:13 实际未解析该 flag（代码内部不一致） | mgmt.ts:13,17 |

---

# 七、Low 置信度附录

## 根文档与指南

1. **[low]** configuration.md / README.md — `--since` 文档只列 `7d`/`24h`/毫秒，代码还接受 `s`、`m`（audit.ts:113 正则 `/^(\d+)(ms|s|m|h|d)?$/`）。omission，不构成冲突。
2. **[low]** remote_probe_cmd 默认脚本中 `ps` 命中时 `exit 4`，recon 视为 unknown（recon.ts:698 默认模板、:508-509 只把 0 当 alive、3 当 dead）。文档契约与 recon 一致，仅边角行为未展开。
3. **[low]** install-launchd.sh 对 legacy 反向 DNS 标签的清理未在 README/operations 主流程提及（launchd/README.md:47-48 已写）。

## 核心运行时架构

4. **[low]** orchestrator.md:117 引 `src/pull/pull.ts:36` 为 source_outage 位置，实际在 :65。行号漂移。
5. **[low]** orchestrator.md:255 工件名 `runner.log`，实际按 attempt 分文件 `runner-<attempt_id>.log`（runner.ts:46，evidence.ts:91 取最新一个，回退才用 runner.log）。
6. **[low]** tech-solution.md:89 「Q4 v1 关闭」与代码实际开启 q4 冲突（classifier.ts:77-79 `state==="done" && origin==="agent" && has_change_evidence===false` → `queue:"q4"`）。属历史文档演进。
7. **[low]** reconcile.md 文档内 file:line 普遍漂移约 20–130 行（orchestrator.ts 现 500 行、store.ts 现 112 行）。语义全部对得上。
8. **[low]** ledger-design.md 历史 schema 与现网不符（已被文档头免责）。
9. **[low]** orchestrator.md:106 spool 读取预算「4 MiB 窗口 / 64 KiB 行长上限」已落地（ingest.ts:18-19）——一致，仅备查。
10. **[low]** tech-solution.md:49 emitter/writer 分离、liveness_domain 与 session_incarnations 表一致——备查。

## 上下文与人因

11. **[low]** context-management-plan.md:4 自称"本轮只写方案、不实现、不激活"，但代码已落地上下文池（context-pool.ts 等被 context-routes.ts:12 import）。状态标注过时。
12. **[low]** artifact-management-tech-design.md:665 称 checkOrigin 在 server.ts:109-116，实际 :112-119。行号漂移 3 行。
13. **[low]** artifact-management-tech-design.md:725 称 dashboardRoute 在 server.ts:339-341，实际 :424-426。行号漂移。
14. **[low]** artifact-management-tech-design.md:382 称 Overload-Session trailer 在 overload.ts:770-773，实际 :768。行号漂移。

## plans

15. **[low]** context-as-artifact-kiss-followup §4.4 测试计数（1136 pass / 1 skip / 149 文件 / 3808 expect）——时点数字，未重跑验证。
16. **[low]** audit-context §0 行数表 recovery-context 377→376、agent-task-context 143→142——差 1 行，疑空行变动。
17. **[low]** context-as-artifact 设计文档 §2.8 建议 problem_id 命名 `prob:<work_id>`，实际实现为 `sha256(work_id+"root")` 派生——plan 与实现的命名选择差异，非事实错误。
18. **[low]** verification §2.10/§2.5 行号 :78→:80、:95→:97——纯位移。

---

# 八、跨文档共性问题

1. **行号漂移是最普遍的失真形式。** reconcile.md、artifact-management-tech-design.md、全部 11 份 plans 文档中的 file:line 引用因后续代码波次（v5 迁移 +164 行、DDL 区 +2 行）整体后移。语义多数仍对得上，但精确行号已失效。建议在文档头部加"行号为 YYYY-MM-DD 基线快照，后续漂移以符号名为准"声明，或批量刷新。

2. **plans 11 份文档的矛盾模式高度一致：代码已变更，文档快照过时。** 2026-09-24 早间的审计/review/verification 文档描述的是 v3 schema、无根 problem、fetcher 返回行 JSON、manage 裸写 attention 的状态。当日晚间 P0-MVP（→v4）+ KISS 三项 hotfix（→v5）落地后，绝大多数"缺失"断言已被推翻。这些文档作为历史记录有价值，但需在头部明确标注快照时间与后续变更。

3. **配置键命名不一致集中在 artifact-management-tech-design.md。** `task_max_bytes`→`work_max_bytes`、`retention_days`→`retain_ms`、`freshness_ms`（死键）三处均为文档示例配置与代码实际读取键不符。用户照文档配置会静默失效。

4. **schema 字面值过时集中在 orchestrator.md。** tasks 表缺 8 列、approvals.gate CHECK 缺 2 个值、ingest 表数量 14→17、mailbox 单表→15 表——均为后续波次加表加列后文档未回写。

5. **"建议改代码"的发现共 3 处：** (a) orchestrator.md D1 /api/q2 若产品意图是删除则需改代码；(b) freshness_ms 若要保留可调需改代码；(c) managed-decision-bot prompt 传参若要严格字面量需改代码。其余均为文档侧修复。

---

# 九、计数汇总

| 类别 | 数量 |
|---|---|
| high 矛盾（主清单） | 13 |
| medium 矛盾（主清单） | 17 |
| **主清单合计** | **30** |
| omission | 23 |
| low（附录） | 18 |

其中跨文档共性矛盾 C1–C5 覆盖 plans 中 14 条 high + 9 条 medium 的重复出处，归并为 5 条。
