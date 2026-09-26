# context-as-artifact MVP 实现报告

- 日期：2026-09-24
- 性质：开发实现记录。本文记录 P0-MVP 的最终实现范围、接口/schema/事件契约、owner、测试命令和结果、未做项和风险。
- 依据：
  - 独立代码审计：`docs/plans/audit-mvp-current-code-20260924.md`
  - 外部 review：`docs/plans/review-claude-opus-5-5-medium-context-as-artifact-20260924.md`（5 个 Blocker）
  - 原方案：`docs/plans/context-as-artifact-20260924.md`
  - 核查报告：`docs/plans/verification-context-as-artifact-20260924.md`
  - 四 owner 契约：`docs/architecture/implementation-contract.md`

---

## 1. 实现范围（P0-MVP 收敛版）

外部 review 指出原 P0 有 5 个 Blocker，不能照做。本轮采用收敛 MVP，先打通权威证据和问题链路。

### 必做（P0-MVP）

1. **根 problem get-or-create**：新增 `ensureRootProblem(work_id)`，幂等生成/获取根 problem，业务键稳定为 `rootProblemId(work_id) = problemId(work_id, null, "root")`。work 激活/创建时由 Core 同事务建立根 problem。
2. **problem_id 链路**：Execution collector 实际把根 problem_id 传入 fact 事件；fact v1/v2 都能幂等关联到问题。修复 `control_context_problem_objects` 普通 INSERT 在同一 object 多 revision 下主键冲突——改为 upsert 跟踪当前选定 revision。
3. **attention 写路径**：manage 中核心 acceptance/manifest 路径的裸写 `control_attention` 改为调用 control store 权威 API，带 revision CAS 与事件。
4. **artifact full 取源真实闭环**：on-demand-fetcher 的 artifact 分支读取 snapshot_path 对应快照字节，用 `mgmt_artifact_versions.content_sha256` 校验完整内容。snapshot 状态为 stored 才可读；路径安全限定在受管 snapshot。
5. **schema 迁移安全**：CONTROL_SCHEMA_VERSION 3→4，迁移可重入（PRAGMA table_info 守卫），把游离的 `ensureContextReducerSchema` 收编进版本链。 [已变更]：当前 CONTROL_SCHEMA_VERSION=5（store.ts:20），迁移链 v1→v2→v3→v4→v5。v4 收编 ensureContextReducerSchema，v5 回填根 problem（store.ts:166-168）。
6. **owner 红线**：Core 写 control 权威逻辑；Execution 只发事件/写 orchestrator 自有 DB；manage 不直写 control_works；Surface 只读/调 API。

### 明确不做（后续阶段）

- 持久化 `context_chunks` 表
- `context_candidate_log` 表
- 模型相关性评分 / embedding / 自动 chunker
- Jev 模型评分
- grant 管理 UI / retention 定时任务
- git/HTTP 外部源
- sensitivity 表重建 / mgmt withheld 直接映射成 confirmed_secret
- manage 批量 supersede 路径收编（relations.ts:55、manifest.ts:323、launch.ts:69）—— P1

---

## 2. 冻结的接口 / schema / 事件契约

> 以下契约由独立代码审计（`audit-mvp-current-code-20260924.md` §8）确认，所有实现 subagent 必须严格遵守。

### 2.1 新增接口

```ts
// src/control/context-pool.ts（新增导出）
export function rootProblemId(work_id: string): string;
// = problemId(work_id, null, "root")，确定性派生，供 Core 与 Execution 共用

export function ensureRootProblem(db: Database, work_id: string, nowTs?: number): Problem;
// 幂等 get-or-create：先查 work_id + parent_problem_id IS NULL 的根 problem；
// 命中即返回；未命中则以 title="root" 调 createProblem。
// 必须在 createWork(active 路径) / promoteWork 事务内调用（同事务，不另开事务）。
```

```ts
// src/control/store.ts（新增导出，用于替代 manifest.ts 裸写）
export function recordAttentionResolution(
  db: Database,
  itemId: string,
  expectedRevision: number,
  input: { verdict: "accepted" | "rejected"; actor: string; evidence: Record<string, unknown> },
  now?: number,
): AttentionItem;
// 语义：CAS 更新 attention 卡 state（accepted→resolved/succeeded, rejected→superseded），
// 写 control_attention_events + enqueue outbox(attention.resolved)。
// 替代 src/manage/manifest.ts:283-294 的裸 UPDATE + 裸 events INSERT。
```

### 2.2 修改接口

```ts
// src/control/context-pool.ts — linkProblemObject（签名不变，SQL 改）
// 原：INSERT INTO control_context_problem_objects(...) VALUES (...)
// 改：INSERT ... ON CONFLICT(problem_id, object_id, role)
//          DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at
// 语义：同一 problem+object+role 只保留一条最新 revision 指针。
// 不把 revision 加入 PK——否则 listObjectsByProblem 会重复枚举同一 object。
```

### 2.3 manage 裸写收编（本阶段必须改的 3 处）

| 文件:行 | 现状 | 改成 |
|---|---|---|
| `src/manage/submit.ts:450-472` | openEffectsCard 裸 INSERT OR IGNORE | 调 `upsertAttention(db, {...}, now)`，带完整字段 |
| `src/manage/manifest.ts:283-294` | recordAcceptance 裸 UPDATE + 裸 events INSERT | 调 `recordAttentionResolution(db, itemId, expectedRevision, {verdict, actor, evidence}, now)` |
| `src/manage/launch.ts:53` | unknownAttention 裸 INSERT ... ON CONFLICT | 调 `upsertAttention(db, {...}, now)`，owner 从 contract 取 |

**可暂缓（P1）**：`src/manage/relations.ts:55`、`src/manage/launch.ts:69`、`src/manage/manifest.ts:323`——批量 supersede 路径，不在 MVP 主链路上。

### 2.4 artifact full 取源契约

- `src/control/on-demand-fetcher.ts:211-222` artifact 分支重写：
  1. 查 row 后，若 `row.snapshot_state !== 'stored'` → `{blocked:true, reason:"snapshot not stored: <state>", code:"unavailable"}`
  2. 若 `row.snapshot_path == null` → unavailable
  3. 路径安全：resolve 后拒绝 `..`、NUL、符号链接逃逸；校验在 snapshot_root 之下
  4. `readFileSync(resolved)` 得 bytes
  5. `sha256(bytes)` 必须等于 `row.content_sha256`，不等 → `{blocked:true, reason:"snapshot hash mismatch", code:"unavailable"}`
  6. 返回 `{ payload: bytes.toString('utf8') }`（二进制本期不支持，非文本 → unavailable）
- `src/shared/context-contract.ts:28` canonical bytes 注释修正为：`artifact:<id>@<ver>` → snapshot_path 指向的原始文件字节（sha256 = content_sha256）。

### 2.5 schema 变更

- `CONTROL_SCHEMA_VERSION`：3 → 4 [已变更]：当前 CONTROL_SCHEMA_VERSION=5（store.ts:20），迁移链 v1→v2→v3→v4→v5。v4 收编 ensureContextReducerSchema，v5 回填根 problem（store.ts:166-168）。
- v4 迁移（`src/control/store.ts` CONTROL_MIGRATIONS 追加）：
  ```ts
  { to: 4, destructive: false, apply(db) {
      ensureContextReducerSchema(db);  // 收编游离的 dedup/quarantine 表 DDL
      db.query("UPDATE control_schema_meta SET version=?, migrated_at=? WHERE id=1").run(4, Date.now());
  }}
  ```
- `ensureContextReducerSchema`（`context-reducer.ts:33-57`）保留 PRAGMA 守卫，幂等 no-op 安全。
- 无新列、无新表、无 destructive 操作。
- `control_context_problem_objects` PK 不变（仍 `(problem_id, object_id, role)`）。
- mgmt schema 本期不加版本号。

### 2.6 事件契约

- 不新增事件 kind。
- fact 链路继续用 `context.updated`。
- ensureRootProblem 不发 outbox 事件（problem 是 work 的隐含附属）。
- artifact full 取源是读路径，不发事件。
- `recordAttentionResolution` 复用现有 `attention.resolved` outbox 事件机制。

### 2.7 Execution 调用方契约

- `src/orchestrator/orchestrator.ts:316` collectAndSpool 调用时，CollectorContext 必须填 `problem_id`。
- problem_id 获取方式：通过 control store 只读查询 `SELECT problem_id FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL`，或调用 `rootProblemId(work_id)`（Core 导出的确定性函数）。
- **红线**：orchestrator 不直接写 control 表；root problem 由 Core 在 promoteWork/createWork 时建好。
- `src/orchestrator/context-collector.ts:127` 已透传 `problem_id: ctx.problem_id ?? null`，无需改。

---

## 3. Owner 分工

| 模块 | Owner | 职责 |
|---|---|---|
| Core（src/control/） | Core 实现 subagent | ensureRootProblem、linkProblemObject upsert、recordAttentionResolution、fetcher artifact 分支、v4 迁移 |
| Execution（src/orchestrator/） | Execution 实现 subagent | collectContextFacts 注入 problem_id |
| manage（src/manage/） | Core 实现 subagent（跨域修改，需遵守红线） | submit.ts/manifest.ts/launch.ts 裸写收编 |
| Surface（src/web/） | 无改动 | — |
| 测试 | 独立测试 subagent | 反例覆盖 + 全量 bun test |

---

## 4. 测试命令和结果

> 此节由独立测试 subagent 和主调度验收时填写。

### 4.1 最小测试

```bash
cd /Users/luwei.will/ai/overload
bun test src/control/context-pool.test.ts src/control/context-reducer.test.ts src/control/on-demand-fetcher.test.ts src/control/store.test.ts src/orchestrator/context-collector.test.ts
```

### 4.2 全量测试

```bash
cd /Users/luwei.will/ai/overload
bun test
```

### 4.3 测试结果

> ⚠️ **证据声明**：此前主调度亲跑的 `1102 pass / 1 skip / 0 fail` **不作为验收证据**。本节以下数字全部由**独立验收者**（未参与实现/测试）于 2026-09-24 重新运行得出。

#### 4.3.1 独立全量测试

命令：`cd /Users/luwei.will/ai/overload && bun test`
- 退出码：**0**
- 结果：**1102 pass / 1 skip / 0 fail**
- 测试文件数：**145**；用例数 1103；`expect()` 调用数：**3690**
- 耗时：**73.83s**（real 73.84s）
- 唯一 skip：既有 `P4 attribution grades > fixture commits cover all grades and trailer precedence`（与本次改动无关）

#### 4.3.2 独立最小测试集（12 个改动模块文件）

命令：`bun test src/control/context-pool.test.ts src/control/context-reducer.test.ts src/control/on-demand-fetcher.test.ts src/control/store.test.ts src/control/store-extra.test.ts src/control/store-guard.test.ts src/orchestrator/context-collector.test.ts src/orchestrator/orchestrator.test.ts test/manage-manifest.test.ts test/manage-submit.test.ts test/manage-handoff.test.ts test/context-integration.test.ts`
- 退出码：**0**
- 结果：**168 pass / 0 fail**，**748 expect() 调用**，**12 文件**，1.69s

#### 4.3.3 独立 SQLite schema 验证（临时脚本，已删除）

4 步全部通过，共 34 项断言：
1. **fresh 初始化**：空库 `ensureControlSchema` → `control_schema_meta.version=4`；control_works / control_context_problems / control_context_objects / control_context_object_versions / control_context_problem_objects / control_context_fact_dedup / control_context_fact_quarantine / control_outbox / mgmt_artifacts / mgmt_artifact_versions 等 14 张表全部存在。
2. **v3→v4 升级**：手动回拨 version=3 并 drop v4 专属两表后调 `ensureControlSchema` → 升到 4，两表重建，dedup 表含 source_type/source_id/source_event_id/observation_revision 全部补列。
3. **重入幂等**：再次 `ensureControlSchema` 不报错，版本仍为 4。
4. **version>4 拒启动**：手置 version=5 → 抛 `ControlError`，`code==="blocked"`（"control schema version 5 is newer than supported 4"）。

#### 4.3.4 独立反例抽查（临时脚本，已删除；不依赖已有测试）

8 组共 25 项断言全部通过：
1. **root problem 幂等**：`ensureRootProblem` 连调两次返回同一 id，不抛异常；`rootProblemId(work_id)` 与其一致。
2. **fact rev1→rev2**：同一 object 两个 fact revision（problem_id 非空）→ revision 1→2，problem_objects 不撞 PK。
3. **problem_objects upsert**：同 (problem_id, object_id, role) link 两次 → 不抛 UNIQUE，仅一行且 revision 覆盖为最新。
4. **attention CAS**：错误 expectedRevision → `ControlError("conflict")` 且状态不变；正确 revision → state=resolved / effect_state=succeeded。
5. **artifact snapshot hash 篡改**：篡改快照字节后 fetch → blocked `code="unavailable"`，reason 含 "hash mismatch"。
6. **路径安全**：snapshot_path 含 `..` → blocked `code="unavailable"`（"snapshot path escapes managed root"）。
7. **非 stored 不可读**：snapshot_state="pending" → blocked `code="unavailable"`（"snapshot not stored: pending"）。
8. **跨 work 拒绝**：artifact 属 wA 用 wB 请求 → blocked `code="forbidden"`（在 visibility 层即拦截，"cross-work reference not shared"）。

#### 4.3.5 历史结果（仅存档，非验收证据）

- 最小测试（独立测试 subagent）：8 文件 148 pass / 0 fail。
- 全量测试（主调度验收，2026-09-24）：1102 pass / 1 skip / 0 fail，145 文件，3690 expect，73.53s。
- flaky 检测：主调度连续 3 次复跑一致，无 flaky（独立验收者仅单次全量，未复跑 3 次）。

**实现 bug 修复记录**：
- Bug #1：manage 侧 `openEffectsCard`（submit.ts）和 `unknownAttention`（launch.ts）调 `upsertAttention` 未读旧 revision，重复调用撞 CAS conflict。修复：先 `getAttention` 读旧 revision，存在则传 `expected_revision`（参考 `recordStopCondition` 范式）。修复后全量 0 fail。
- 独立验收者本轮**未发现新的实现 bug**（反例脚本初跑 2 项失败系验收者自身 fixture 缺失 object_version 行所致，修正后通过，非产品代码缺陷）。

---

## 5. 改动文件清单

### 实现文件（8 个）

| 文件 | 改动摘要 |
|---|---|
| `src/control/context-pool.ts` | 新增 `rootProblemId(work_id)` 确定性派生；新增 `ensureRootProblem(db, work_id, nowTs?)` 幂等 get-or-create（带 conflict 重试兜底）；`linkProblemObject` INSERT 改 `ON CONFLICT(problem_id,object_id,role) DO UPDATE SET revision,created_at` |
| `src/control/store.ts` | `CONTROL_SCHEMA_VERSION` 3→4；CONTROL_MIGRATIONS 追加 v4（收编 ensureContextReducerSchema）；新增内部 `ensureRootProblemLocked`；`createWork` active 路径和 `promoteWork` 事务内建根 problem；新增导出 `recordAttentionResolution(db, itemId, expectedRevision, {verdict, actor, evidence}, now?)` 带 CAS + events + outbox |
| `src/control/on-demand-fetcher.ts` | artifact 分支重写：校验 snapshot_state='stored' → 路径安全（resolve、拒 ../NUL、校验位于 snapshot_root 之下、lstat 拒符号链接）→ readFileSync → sha256 比对 content_sha256 → 前 8KB 含 NUL 拒二进制 → 返回 utf8 payload |
| `src/shared/context-contract.ts` | artifact canonical bytes 注释从「JSON.stringify(row)」改为「snapshot_path 指向的原始文件字节（sha256=content_sha256）」 |
| `src/manage/submit.ts` | `openEffectsCard` 裸 INSERT OR IGNORE 改调 `upsertAttention`（完整字段、CAS 读旧 revision） |
| `src/manage/manifest.ts` | `recordAcceptance` 裸 UPDATE+events INSERT 改调 `recordAttentionResolution`（修正 rejected→superseded 而非 resolved） |
| `src/manage/launch.ts` | `unknownAttention` 裸 INSERT...ON CONFLICT 改调 `upsertAttention`（owner 从 contract/profile 取、CAS 读旧 revision） |
| `src/orchestrator/orchestrator.ts` | `collectContextFacts` 的 CollectorContext 注入 `problem_id: rootProblemId(row.work_id)` |

### 测试文件（19 个）

新增反例测试 25 个，修复旧行为测试 43 个。涉及文件：
`src/control/context-pool.test.ts`、`context-reducer.test.ts`、`store-extra.test.ts`、`store-guard.test.ts`、`on-demand-fetcher.test.ts`、`store.test.ts`、`context-assembler.test.ts`、`context-propagation.test.ts`、`security-hardening.test.ts`、`src/orchestrator/agent-task-context.test.ts`、`src/web/context-ui.test.ts`、`ledger.test.ts`、`server.test.ts`、`test/context-integration.test.ts`、`manage-schema.test.ts`、`manage-manifest.test.ts`、`manage-handoff.test.ts`、`manage-submit.test.ts`、`manage-remote-handoff.test.ts`。

### 文档（2 个）

| 文件 | 说明 |
|---|---|
| `docs/plans/audit-mvp-current-code-20260924.md` | 独立代码审计报告（精确 file:line 改动点） |
| `docs/plans/context-as-artifact-mvp-implementation-20260924.md` | 本文档 |

---

## 6. 未做项和风险

### 未做项（后续阶段）

- 持久化 context_chunks / context_candidate_log
- 模型相关性评分 / embedding / 自动 chunker
- sensitivity 表重建 / mgmt schema 版本化
- manage 批量 supersede 收编（relations.ts:55、manifest.ts:323、launch.ts:69）
- 证据版本清单（decision basis）—— P1
- pin 版本/现场连续性桥接—— P1
- mgmt_observations / mgmt_summaries / mgmt_links 复用审计—— P1
- artifact 二进制/MIME 支持
- 子问题树创建

### 风险（已验证）

1. **fact v1→v2 主键冲突**：已通过 upsert 修复。反例测试验证 v1→v2 不撞 PK、problem_objects.revision 递增、listObjectsByProblem 不重复枚举。
2. **路径安全**：fetcher 已实现路径穿越（`..`）、NUL 字节、符号链接逃逸、snapshot_root 边界校验。反例测试全部覆盖。
3. **manage 裸写收编**：upsertAttention 字段完整性已核对，3 处收编全部带完整 NOT NULL 字段和 CAS。反例测试验证 CAS conflict 和幂等刷新。
4. **v4 迁移**：ensureContextReducerSchema 收编后，旧库 v3→v4 升级、重入幂等、全新库初始化、version>4 拒启动均通过独立临时 SQLite 验证。
