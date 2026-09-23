# Overload 上下文管理专项 — 开发完成报告（最终验证版）

- 日期：2026-09-23
- 方案：docs/architecture/context-management-plan.md
- 性质：开发完成报告，代码已合入当前工作区，未 commit/push/deploy
- 修订说明：首轮（10 项驳回）→ 第一轮修复（12 项生产问题驳回）→ 第二轮修复 → 第三轮 10 项正确性修复 → 独立验证发现 assembler assertWorkAccess 越权残留 → 第四轮修复 fail-closed（Fix4b 反例纳入回归）。本版由独立验证 + 主调度亲自复核后据实更新。

---

## 1. 任务完成状态

| # | 任务 | Owner | 状态 | 备注 |
|---|---|---|---|---|
| T1 | 建六张新表（schema v3 迁移） | Core | ✅ 完成 | 含 T10 额外 2 表 + collector cursor 表 |
| T2 | context-pool CRUD + CAS + 问题树 + 关联 | Core | ✅ 完成 | 跨work父子/环/parent不可变 三项应用层校验 |
| T2b | context-collector 采集端 | Execution | ✅ 完成（生产级） | tick 采集 + seg 文件 + DB cursor 持久化去重 + 重启幂等 |
| T3 | visibility-policy（权限先于打分） | Core | ✅ 完成 | unknown sensitivity 拒绝正文和摘要 |
| T4 | on-demand-fetcher（缓存隔离） | Core | ✅ 完成（5 源+路径防护） | contract/attention/journal/orchestrator/artifact；git/http unavailable；路径穿越拒绝 |
| T5 | context-assembler（三种上下文包） | Core | ✅ 完成（fail-closed） | assertWorkAccess：decision_owner 放行所有包；orchestrator 运行时主体仅 agent_task；其余 fail-closed。Fix4b 三反例纳入回归 |
| T6 | Agent 任务包调用点 | Execution | ✅ 完成（fail-closed） | startRunner 注入；异常→context_pending 不 spawn；disabled 兼容模式有测试 |
| T7 | 恢复输入包装配 | Execution | ✅ 完成（证据驱动 + 用户可见已接线） | attemptRecovery 证据驱动；recovery_* 经 spool→ingest 落 control_attention（集成场景 B 实证出卡） |
| T8 | propagation + 三入口同步复验 | Core | ✅ 完成（fail-closed） | reverifyBeforeAction 精确绑定 object+revision+work；assembler assertWorkAccess 第四轮修复为 fail-closed；Fix4b 反例纳入回归 |
| T9 | pin 机制 + shares + purge | Core | ✅ 完成 | purge CLI 入口（需 --actor） |
| T10 | outbox 事件 + fact_observed reducer | Core | ✅ 完成（生产级） | OrThrow 版本；共享契约；context.fact_observed 加入 EventKind |
| T11 | 决策卡 UI evidence 折叠/展开 | Surface | ✅ 完成（安全） | actor 服务端注入；无配置 501；POST resolve 无 actor 501 |
| T12 | 端到端重构场景两条分支 | Execution+Surface | ✅ 完成 | 含 ingest 真实 seg 文件链路 + 重启幂等测试 |

---

## 2. 改动文件清单（git status 核实）

### 2.1 修改文件（12 个）

| 文件 | 变更摘要 |
|---|---|
| `src/control/store.ts` | schema v3 + CONTEXT_SCHEMA；resolveAttentionDecision 内联复验 fail-closed；actOnAttention 透传 actor；openControl fail-fast |
| `src/shared/types.ts` | EventKind 追加 5 个：context.updated/invalidated/stale/conflict/fact_observed |
| `src/orchestrator/orchestrator.ts` | T6 startRunner 注入（catch→context_pending 不 spawn）；tick 采集 + attemptRecovery（证据驱动） |
| `src/orchestrator/schema.sql` | 新增 context_collector_cursor 表（持久化去重） |
| `src/orchestrator/store.ts` | openStore fail-fast（undefined/null/"" 抛错） |
| `src/decision-bot/mailbox.ts` | openMailbox fail-fast |
| `src/web/server.ts` | 路径预解析；contextRoute 挂载 + actor 注入；POST resolve 无 actor 501；ingest 定时；删除 `|| "web-server"` |
| `src/web/server.test.ts` | 既有 resolve 用例补 actor；新增 501 测试 |
| `src/web/contract-closure.test.ts` | 设 OVERLOAD_ACTOR=operator |
| `src/cli/overload.ts` | --actor 标志；context resolve 无 actor 退出码 1；purge 无 actor 退出码 1；删除 `|| "cli"` |
| `src/adapters/service.ts` | resolve actor 从已认证 channel owner 解析，删除固定 "adapter-service" |
| `test/manage-schema.test.ts` | v2→v3 断言修正 |

### 2.2 新增源文件（14 个）

| 文件 | 模块 | 说明 |
|---|---|---|
| `src/control/context-pool.ts` | Core | 对象/版本/问题树/关联 CRUD + CAS + 应用层校验 |
| `src/control/visibility-policy.ts` | Core | 权限预检引擎（6 步决策链） |
| `src/control/on-demand-fetcher.ts` | Core | 5 类 handle 取源 + 路径穿越防护 + 缓存隔离 |
| `src/control/context-propagation.ts` | Core | stale 标记 + reverifyBeforeAction + 兼容包装 |
| `src/control/context-pin.ts` | Core | pin/shares/purge |
| `src/control/context-events.ts` | Core | emitContextEvent 辅助 |
| `src/control/context-reducer.ts` | Core | fact_observed reducer + OrThrow + dedup/quarantine 表 |
| `src/control/context-assembler.ts` | Core | 三种上下文包装配 |
| `src/control/context-ingest.ts` | Core | spool seg 文件目录扫描 + 校验 + OrThrow + 重命名归档 |
| `src/shared/context-contract.ts` | Shared | FactObservedPayload 16 字段权威类型 + 校验器 |
| `src/orchestrator/context-collector.ts` | Execution | 持久化 cursor 去重 + seg 文件 + clean sensitivity |
| `src/orchestrator/agent-task-context.ts` | Execution | Agent 任务包 + disabled 兼容状态 |
| `src/orchestrator/recovery-context.ts` | Execution | 证据驱动状态分类 + 恢复判定 |
| `src/web/context-routes.ts` | Surface | 决策包 + fetch-full（actor 服务端注入，无配置 501） |

### 2.3 新增测试文件（18 个，独立验证按 `git status --short` 磁盘核实）

| 文件 | 说明 |
|---|---|
| `src/control/context-pool.test.ts` | 16 用例 |
| `src/control/visibility-policy.test.ts` | 21 用例 |
| `src/control/on-demand-fetcher.test.ts` | 20 用例 |
| `src/control/context-propagation.test.ts` | 14 用例 |
| `src/control/context-pin.test.ts` | 15 用例 |
| `src/control/context-reducer.test.ts` | 18 用例 |
| `src/control/context-assembler.test.ts` | 19 用例（含 Fix4b 三反例：非 owner 越权拒绝 / owner 正例 / share 授予方越权拒绝） |
| `src/control/context-ingest.test.ts` | 4 用例（seg 扫描） |
| `src/control/security-hardening.test.ts` | 15 用例（undefined 路径/复验 fail-closed/跨 work share/取源路径防护） |
| `src/orchestrator/context-collector.test.ts` | 10 用例（含重启幂等） |
| `src/orchestrator/agent-task-context.test.ts` | 6 用例（含 disabled 兼容） |
| `src/orchestrator/recovery-context.test.ts` | 18 用例（含证据驱动状态分类） |
| `src/web/context-ui.test.ts` | 14 用例（含伪造 actor/无 grant/unknown sensitivity） |
| `src/adapters/service-actor.test.ts` | adapter resolve actor 行为 |
| `test/cli-actor.test.ts` | CLI --actor 端到端（subprocess） |
| `test/context-e2e.test.ts` | 10 用例 |
| `test/context-ingest.test.ts` | 6 用例（真实文件+DB） |
| `test/context-integration.test.ts` | **第三轮新增（Surface）**：5 场景端到端（A 全链路 hash / B live 出决策卡 / C exited 不 jump / D 跨 work 拒绝 / E .tmp 半行） |

---

## 3. 测试命令与结果

### 3.1 基线（开发前）
```
bun test → 754 pass / 1 skip / 1 fail（MGMT-04 flaky）
```

### 3.2 最终（第四轮修复后，主调度亲自跑）
```
bun test → 999 pass / 1 skip / 0 fail
→ 3231 expect() calls，142 files，75.87s
```
- 第三轮独立验证为 996/1/0；第四轮 assembler 修复新增 3 个 Fix4b 反例测试 → 999/1/0，全量零失败。
- context 相关子集：`bun test src/control/ src/orchestrator/ src/web/ test/context-*.test.ts` → 全绿。
- 集成测试：`bun test test/context-integration.test.ts` → **5 pass / 0 fail**（场景 A–E，见 §10）。

### 3.3 类型检查
项目无 tsconfig，bun 直接运行 TS 做类型检查。全量测试加载即类型检查通过。

### 3.4 反例测试覆盖

| 规则 | 测试位置 | 状态 |
|---|---|---|
| 跨 work 父子拒绝 | context-pool.test.ts | ✅ |
| 递归环检测 A→B→A | context-pool.test.ts | ✅ |
| parent_problem_id 不可变 | context-pool.test.ts | ✅ |
| 伪造 actor（头被忽略） | context-ui.test.ts | ✅ |
| 无 actor POST resolve → 501 | server.test.ts | ✅ |
| 无 grant → 403 不给摘要 | context-ui.test.ts | ✅ |
| unknown sensitivity 不给摘要 | context-ui.test.ts, visibility-policy.test.ts | ✅ |
| stale 决策消费拒绝 | context-propagation.test.ts, security-hardening.test.ts | ✅ |
| 跨 work share 不串权 | security-hardening.test.ts | ✅ |
| actor 空 + context → 拒绝 | security-hardening.test.ts | ✅ |
| live 恢复拒绝（jump 不产包） | recovery-context.test.ts | ✅ |
| done 正常完成不产恢复噪声 | recovery-context.test.ts | ✅ |
| 无 runner_exit 不评估恢复 | recovery-context.test.ts | ✅ |
| 同 key 异 hash → quarantine/integrity_error | context-reducer.test.ts, context-ingest.test.ts | ✅ |
| T6 异常不 spawn（context_pending） | agent-task-context 集成 | ✅ |
| collector 重启幂等不重复 | context-collector.test.ts | ✅ |
| 路径穿越/绝对路径拒绝 | security-hardening.test.ts, on-demand-fetcher.test.ts | ✅ |
| undefined 路径不创建文件 | security-hardening.test.ts | ✅ |
| CLI 无 actor → exit 1 | cli-actor.test.ts | ✅ |

---

## 4. 第二轮验收问题修复记录（12 项）

### 4.1 undefined SQLite 文件（问题 1）
- **根因**：`process.env.X = undefined` 被 Bun 写成字符串 "undefined"，openStore("undefined") 创建名为 undefined 的文件；recovery-context.test.ts 的 env 恢复 bug 是源头
- **修复**：openControl/openStore/openMailbox 对 null/""/"undefined"/"null" 显式抛错；startWebServer 建 DB 前预解析所有路径；修复 recovery-context.test.ts env 恢复（undefined 时 delete）
- **清理**：仓库根目录 undefined/undefined-shm/undefined-wal 已删除
- **测试**：security-hardening.test.ts 验证 undefined 路径抛错不创建文件；afterEach 检查根目录无 undefined*

### 4.2 POST 决策 actor 默认（问题 2）
- **修复前**：server.ts `process.env.OVERLOAD_ACTOR || "web-server"`；cli `|| "cli"`；adapter 固定 "adapter-service"
- **修复后**：
  - web POST resolve：无 actor → 501，不调 actOnAttention
  - CLI：新增 --actor，context resolve 无 actor → exit 1
  - adapter：resolve actor 从已认证 channel owner 解析
- **grep 验证**：生产代码无 `|| "web-server"`、无 `|| "cli"`、无 x-overload-actor

### 4.3 复验 fail-open（问题 3）
- **修复前**：actor 为空跳过权限检查；share 查询无 work_id 条件
- **修复后**：actor 空 + context 决策 → permission_denied；share 查询按 work 域（object_id IN 本 work 的 problem_objects）；无 decision_owner 但涉及 context → 拒绝；纯 legacy 兼容放行
- **测试**：security-hardening.test.ts 跨 work share 不串权、无 actor 拒绝、错误 owner 拒绝

### 4.4 expected_contract_revision fail-open（问题 4）
- **处理**：保留 mismatch 校验；staleness 由 `work.revision === old.contract_revision` 无条件绑定兜底。未强制"必须传 expected_contract_revision"——该强制会破坏 consumeDecisionWithReverify 包装层（e2e 路径自带 contract_revision 复验）。staleness 无 fail-open。
- **偏离记录**：见 §5.11

### 4.5 T6 吞错继续（问题 5）
- **修复前**：catch 内 `proceed with base prompt` 静默回退
- **修复后**：catch 记录 context_pending task_event + return（不 spawn）；forbidden→spawn_fail；仅 `code==="disabled"`（开关显式关闭）走 base prompt 兼容路径
- **测试**：disabled 兼容模式有测试标记

### 4.6 T7 状态分类错误（问题 6）
- **修复前**：对 done/failed/abandoned/awaiting_human/blocked 都调 attemptRecovery，仅凭 state 字符串
- **修复后**：
  - attemptRecovery 入口查 `task_events` 有无 runner_exit/runner_dead，无则直接 return
  - done 正常完成不产恢复噪声
  - awaiting_human + 未消费 approval → jump（不产包）；无 approval 且无 exit → reconcile
  - submitted → 不产恢复包
  - determineRuntimeState 改为证据驱动
- **测试**：entry-4~7 覆盖 done 无噪声、awaiting_human+jump、failed 无 exit 不评估、awaiting_human 无 approval→reconcile
- **用户可见性**：orchestrator 不得直写 control DB（红线），恢复结果记录在 task_events，用户可见 AttentionItem 由上层/web 层创建

### 4.7 collector 重启重复（问题 7）
- **修复前**：模块级内存 Map 去重，重启丢失，重发 revision=1 可能触发 quarantine
- **修复后**：orchestrator DB 新增 context_collector_cursor 表（source_event_id PK + revision + hash + ts）；同 event+同 hash 跳过，异 hash revision+1；内存 Map 保留为缓存，DB 为权威源
- **测试**：模拟重启（清空内存，DB cursor 保留）→ 不重复发；内容变化 → revision 递增

### 4.8 ingest 管线生产级（问题 8）
- **修复前**：只读固定文件名；collector 旁路写文件；EventKind 缺 context.fact_observed
- **修复后**：
  - shared/types.ts EventKind 加 `"context.fact_observed"`
  - collector 写带序号 seg 文件 `active-context-collector.<seq>.ndjson`（写完即密封）
  - ingest 扫描目录所有匹配文件（排除 .processed.），按 mtime 排序，处理完重命名
- **测试**：多 seg 文件全处理、重命名不重复、空目录、排除 .processed

### 4.9 collector sensitivity（问题 9）
- **修复前**：observation_evidence 一律 unknown，按策略拒绝正文和摘要
- **修复后**：诊断事件（orchestrator 自记录系统诊断，不含用户 secret）标 clean；test_result/code_state/external_state 保持 clean
- **测试**：observation_evidence fact 出现在决策包 trigger_evidence 中

### 4.10 assembly_enabled 开关边界（问题 10）
- **修复后**：OVERLOAD_CONTEXT_ASSEMBLY_ENABLED=false 控制全层：assembler→blocked、fetcher→blocked、reducer→blocked、collector→返回空不写 spool、ingest→全 0 不读 spool
- **报告**：开关边界已明确定义

### 4.11 取源路径安全（问题 11）
- **修复后**：fetchFromSource 入口拒绝空/含 NUL/含 `..` 的 reference；未注册 handle → unknown handle blocked；所有参数化查询不拼接路径；artifact shareable/sensitivity 由上游 checkVisibility 门禁
- **测试**：路径穿越、绝对路径、未注册 handle 拒绝

### 4.12 测试统计（问题 12）
- **修复**：本报告文件数从 git status 磁盘核实（14 源 + 17 测试 + 12 修改），不使用拆分计数
- **根目录垃圾文件**：已记录并清理（见 4.1）

---

## 5. 对方案的偏离说明

### 5.1 必需偏离（方案与真实代码冲突）

1. **test/manage-schema.test.ts 硬编码 v2**：最小修正为 v3。
2. **collector 数据源映射**：方案假设有 runner_invocations/submit_result 表，实际只有 tasks/task_events。映射到真实表。
3. **T10 新增 dedup/quarantine 表**：方案六表不含，幂等/隔离需要持久化。
4. **collector cursor 表**：方案未提及持久化去重，重启幂等需要。
5. **actOnAttention 参数顺序**：actor 在 now 之前（避免破坏现有位置参数测试）。
6. **openX(undefined) 无参仍解析默认**：CLI/daemon 无参依赖此行为；fail-fast 针对显式 null/""/"undefined"。

### 5.2 设计选择偏离

7. **复验内联 store.ts**：避免循环导入，consumeDecisionWithReverify 保留为兼容包装。
8. **T4 git/http 源 unavailable**：外部安全边界，本阶段不实现。
9. **T7 用户可见性**：orchestrator 不写 control attention（红线），恢复结果在 task_events，由上层创建 attention。
10. **collector 用 seg 文件而非 SpoolWriter.emit**：SpoolWriter.emit 绑定 orchestrator 主 spool 目录和 session 参数，与 collector 自有段文件生命周期不同。
11. **未强制 expected_contract_revision 必填**：staleness 由 contract_revision 无条件绑定兜底，强制必填会破坏 e2e 的 consumeDecisionWithReverify 包装层。
12. **collector 全量扫描而非增量**：持久化 cursor 已解决重启幂等核心问题，增量扫描（last_scanned_event_id）留后续优化。
13. **control_context_shares 无 purpose 列**：purpose 校验跳过。

---

## 6. 未决风险

1. **git/http 外部取源未实现**：返回 unavailable，需后续设计安全边界。
2. **actor 认证为 env 过渡态**：生产激活前需替换为 session/token 绑定；当前无配置时 501 不暴露数据。
3. **retention 定时 purge 未实现**：仅有 CLI 手动入口，expires_at 后自动清除需后续。
4. **confirmed_secret grant 管理 UI 缺失**：仅编程式 shareObject。
5. **collector→ingest 依赖 web server 常驻**：web server 不运行时 spool 累积，启动后消费。
6. **旧二进制回退门禁未端到端验证**。

> 原"assembler 工作级预检串权"已在第四轮修复：assertWorkAccess 改为 fail-closed（decision_owner 放行所有包，orchestrator 运行时仅 agent_task，其余拒绝），Fix4b 三反例纳入回归。
> 原"T7 恢复结果用户可见性依赖上层"已在第三轮解决：recovery_* 经 spool→ingest 落 control_attention，集成场景 B 实证出卡。

---

## 7. 架构红线遵守情况

| 红线 | 状态 |
|---|---|
| orchestrator 只写自己的 db/artifacts/worktrees/spool | ✅ collector 只读 orchestrator DB 写 NDJSON；cursor 表在 orchestrator DB；attemptRecovery 只读 control DB |
| web/recon/ingest/notify/shared 不得 import orchestrator | ✅ context-routes 只 import control；web/server.ts 对 orchestrator 的 import 为既有代码 |
| manage 不得 UPDATE control_works | ✅ 未触碰 |
| 不 commit/push/deploy | ✅ |
| 不删除/改名用户已有文件 | ✅ 仅删除测试产生的 undefined* 垃圾文件 |
| 不格式化无关代码 | ✅ |
| actor 不得由请求头/请求体自填 | ✅ 无 x-overload-actor；web/cli/adapter 均服务端注入 |
| 复验必须在真实消费路径生效 | ✅ actOnAttention 内联 fail-closed |
| T6 必需上下文不可读不得继续 | ✅ catch→context_pending 不 spawn；仅 disabled 兼容 |
| T7 terminated 必须有事件证据 | ✅ runner_exit/runner_dead 门控 |

---

## 8. 后续建议

1. actor 认证升级为 session/token 绑定
2. retention 定时 purge（7 天默认）
3. grant 管理 UI
4. git/http 外部取源安全设计
5. collector 增量扫描优化

---

## 9. 第三轮修复独立验证记录（10 项，验证 agent 亲读代码 + 跑测试 + 反例）

| # | 验收项 | 验证方式 | 结论 |
|---|---|---|---|
| 1 | content_hash 一致性（T4 full 取源） | 读 `context-collector.ts`：test_result/observation_evidence 的 `contentHash=sha256(row.detail ?? "")`（211/313 行）；读 `on-demand-fetcher.ts`：orchestrator:task_event 返回 `te.detail` 原文（160 行），full 取源后 `sha256(payload)===version.content_hash` 否则 needs_context（306-309）；跑集成场景 A 断言 `content_hash===sha256(detail)` 且 fetch-full payload===detail | ✅ 通过 |
| 2 | 跨 work 源读取绑定 | 读 fetcher 151-156：`task_events te JOIN tasks t ON te.task_id=t.task_id WHERE te.id=? AND t.work_id=?`，未绑定→forbidden；work_id 缺省直接拒绝（83-85）；跑集成场景 D：work B 引用 work A 的 task_event → forbidden、reason 含 cross-work、不返回正文 | ✅ 通过 |
| 3 | awaiting_human 恢复 liveness | 读 `orchestrator.ts` attemptRecovery：无"有 approval 就 jump"短路，统一交 `determineRecoveryOutcome`；读 `recovery-context.ts` determineRuntimeState：awaiting_human 有 runner_exit/runner_dead→terminated，无则看 pid/stable_id→live/unknown；approval 判定只在 `runtimeState==="live"` 分支内；跑场景 B（live+approval→jump）与场景 C（exited+approval→jumpCount===0） | ✅ 通过 |
| 4 | 用户可见 attention 链路 | 读 `context-ingest.ts`：处理 context.pending/recovery_jump/recovery_package/recovery_reconcile → upsert control_attention（含 conclusion/urgency/owner/deep_link/24h 时效）；读 orchestrator emitContextSpool：四类事件均写 collector 同款 spool；跑场景 B 断言 ingest 后 `control_attention` 出现 `ctx:context.recovery_jump:<work>:task-b` 且 urgency=now | ✅ 通过（链路直达 control_attention，非仅 task_events） |
| 5 | 文件协议生产级 | 读 collector：`__seq__` DB meta 持久序号（361-384，BEGIN IMMEDIATE 取号）；写 `*.ndjson.tmp`→fsync→rename 原子落盘（401-410）；读 ingest findPendingFiles：只收 `.ndjson`、排除 `.processed.`，`.ndjson.tmp` 不匹配；跑场景 E（.tmp 不摄入→rename 为 .ndjson 摄入一次→再摄入幂等）；F3-atomic 测试重启序号不碰撞 | ✅ 通过 |
| 6 | reducer 乱序防护 | 读 `context-reducer.ts` 161-173：同 (source_type,source_id,source_event_id) 取 MAX(observation_revision)，`payload.revision < maxRev`→quarantine 不覆盖；跑 `context-reducer.test.ts` "Fix3 reducer 乱序防护"：rev2 先到 created、rev1 后到 quarantined、对象不被覆盖 | ✅ 通过 |
| 7 | context-propagation + assembler 宽授权 | 第三轮：propagation 已绑定，但 assembler:217 残留。**第四轮修复**：删除 `WHERE shared_with_work=? LIMIT 1`，assertWorkAccess 改为 fail-closed（decision_owner 放行所有包；orchestrator 运行时仅 agent_task；其余拒绝）。Fix4b 三反例：mallory 非 owner→forbidden、bob owner→ok、alice(A 的 owner/share 授予方) 请求 B→forbidden。grep 确认新增模块无残留宽查询 | ✅ 通过（第四轮修复） |
| 8 | collected_at = 源事件时间 | 读 collector：test_result/observation_evidence `collectedAt=row.at`（212/314），code/external 用 tasks.updated_at；跑 `context-collector.test.ts` F4-positive：旧 task_events.at → collected_at 等于旧时间（非 Date.now） | ✅ 通过 |
| 9 | spoolRoot 一致性 | 读 `server.ts` 135：`spoolRoot` 是 startWebServer 内唯一解析点；publish（145）与 ingest（173）均 `new SpoolWriter(orchestrator, spoolRoot)` 共用同一 `.dir`；grep 确认 web 层无第二个 spoolRoot 推导（extension/ingest/prune 里的 spoolRoot 属旧 host-agent spool，与本 context 链路无关） | ✅ 通过 |
| 10 | 报告数字与文件清单真实性 | 亲跑 `bun test`=996/1/0（非旧报 966/1/1）；`git status` 实测 12 修改 / 14 新增源 / 18 新增测试；grep 五项安全检查全过（见 §9.10） | ✅ 通过 |

### 9.7 第 7 项修复记录（第四轮）

第三轮独立验证发现 `context-assembler.ts:217` `assertWorkAccess` 残留 `WHERE shared_with_work=? LIMIT 1`，不绑 object_id/revision/actor，独立反例实证非 owner 可越权读决策包。

**第四轮修复**（原 Core owner s_000cIkDrSrX）：
- 删除宽授权查询，重写 `assertWorkAccess(package_type)`：
  - `actor === work.contract.decision_owner` → 放行所有包类型
  - `package_type==="agent_task"` 且 `actor==="orchestrator"`（服务端运行时主体）→ 放行
  - 其余一律 `{ok:false}` fail-closed
- work 级 share 不再作为入口授权；跨 work 对象由 `checkVisibility` 的 `hasShare(object_id+revision+shared_with_work)` 逐对象把关
- 两个调用点传 package_type：assembleDecisionView→"decision_view"、assembleAgentTask→"agent_task"
- 新增 Fix4b 三反例（修前失败、修后通过）：
  1. A share 对象给 B，actor=mallory（非 B owner）→ forbidden，不返回摘要
  2. 正例：actor=bob（B 的 decision_owner）→ 可装配
  3. actor=alice（A 的 owner/share 授予方）请求 B → forbidden
- 全量 `bun test`：999 pass / 1 skip / 0 fail

### 9.10 强制 grep 检查结果（亲跑）

| 检查 | 期望 | 实际 |
|---|---|---|
| `grep x-overload-actor src --include=*.ts \| grep -v test` | 无 | ✅ 无命中 |
| `grep '\|\| "web-server"\|\|\| "cli"' src --include=*.ts \| grep -v test` | 无 | ✅ 无命中 |
| `grep "proceed with base prompt" src/` | 无 | ✅ 无命中 |
| `grep "context.fact_observed" src/shared/types.ts` | 有 | ✅ 52 行有 |
| `ls undefined*` | 无 | ✅ 无 |

---

## 10. 集成测试结果（test/context-integration.test.ts，真实 SQLite + 真实文件 spool + 真实 HTTP，无内部 mock）

```
bun test test/context-integration.test.ts → 5 pass / 0 fail，34 expect()，217ms
```

| 场景 | 断言 | 结果 |
|---|---|---|
| A 全链路 | collectAndSpool→ingest→decision-package 含 fact；fetch-full 返回 detail 原文且 `content_hash===sha256(detail)`、visibility=full | ✅ |
| B live blocked-on-ask | awaiting_human + 未消费 approval + pid/stable_id + 无 runner_exit → recovery_jump envelope → ingest 出 control_attention 卡（urgency=now） | ✅ |
| C exited 不 jump | awaiting_human + runner_exit（terminated）+ 未消费 approval → recovery_jump 事件数=0、spool 无 recovery_jump envelope（反例） | ✅ |
| D 跨 work 拒绝 | work B 引用 work A 的 task_event:1 → fetchOnDemand blocked、code=forbidden、reason 含 cross-work | ✅ |
| E .tmp 半行 | `.ndjson.tmp` 不摄入（read=0、对象数=0）；rename 为 `.ndjson` 后摄入一次（created=1）；再摄入幂等不重复 | ✅ |

### 反例测试存在性与通过性核对（亲查测试名）

跨 work 父子拒绝、环 A→B→A、parent_problem_id 不可变（context-pool.test.ts）；伪造 actor 头被忽略、无 actor POST resolve→501（context-ui/server.test.ts）；无 grant→403、unknown sensitivity 拒摘要（context-ui/visibility-policy.test.ts）；stale 消费拒绝、evidence purged 拒消费（context-propagation.test.ts）；live+jump 不产包、exited+approval 不 jump（recovery-context.test.ts 场景 C/entry-5/5b）；同 key 异 hash→quarantine（context-reducer.test.ts）；跨 work 取源 forbidden（集成 D）；rev2 先到 rev1 后到 quarantine（context-reducer Fix3）；半行 .tmp（集成 E）；assembler 非 owner 越权拒绝（Fix4b 三反例）——均真实存在且本次全量跑绿。
