# 只读代码审计：存量 work 根 problem 回填 hotfix

- 审计日期：2026-09-24
- 范围：只读，未改任何文件、未跑测试、未 commit。
- 目标：为「存量 work 根 problem 回填 hotfix」建立当前代码事实。

---

## 0. 核心结论（先读）

根因**成立**，且实际比怀疑的多一个缺口：

1. **v4 迁移不回填**（`src/control/store.ts:161`）：只调 `ensureContextReducerSchema(db)`（建 dedup/quarantine 表），不为升级前已存在的 active work 建根 problem。
2. **createWork 幂等返回分支不补根 problem**（`src/control/store.ts:241`）：命中已存在 `(source,source_id)` 的 work 直接 `return work`，跳过 `ensureRootProblemLocked`。
3. **额外发现：redirectWork 的 activate 分支也不建根 problem**（`src/control/store.ts:279-280`）：可把任意状态 work 翻成 active，无根 problem。

断流链路已逐行核实：orchestrator 无条件注入 `rootProblemId(work_id)`（`orchestrator.ts:326`）→ reducer 发现 problem 行不存在抛 `ControlError("invalid","problem not found")`（`context-reducer.ts:178`）→ 事务回滚、无 dedup 行 → ingest 侧把该行进 sidecar `.quarantine`（`context-ingest.ts:256,263`），主 seg 文件仍被改名 `.processed`（`context-ingest.ts:269`）→ collector cursor 已推进（`context-collector.ts:119-122`），同 content_hash 下次直接跳过（`:104-107`）。升级后该 work 的 fact **静默断流**。

**需要新 schema 版本 v5**，在迁移里幂等回填所有缺根 problem 的 work。

---

## 1. control/store.ts：schema 版本与迁移

- `CONTROL_SCHEMA_VERSION = 4`：`src/control/store.ts:20`。
- `CONTROL_MIGRATIONS` 数组：`src/control/store.ts:157-162`。
  - v1 `:158` 建 `CONTROL_SCHEMA` + outbox。
  - v2 `:159` `ensureMgmtSchema`。
  - v3 `:160` `db.exec(CONTEXT_SCHEMA)`（建 `control_context_problems` 等 context 池表）。
  - **v4 `:161`**：
    ```ts
    {to:4,destructive:false,apply(db){ensureContextReducerSchema(db);db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(4,Date.now());}},
    ```
    **确认：v4 只调 `ensureContextReducerSchema(db)`（DDL：dedup/quarantine 表 + ALTER 补列，见 `context-reducer.ts:33-57`），完全不遍历 `control_works`、不调 `ensureRootProblem`。** 升级前已存在的 active work 不会被补根 problem。
- 迁移执行器 `ensureControlSchema`：`src/control/store.ts:163-171`。`:166` 版本已 current 直接 return；`:167` 只跑 `to>version` 的迁移。因此**要对存量 v4 库一次性回填，必须新增 `to:5` 迁移**。

---

## 2. createWork 全返回路径

函数：`src/control/store.ts:231-250`。事务起点 `:235`（`tx.immediate()`）。

| 路径 | 位置 | 状态/动作 | 是否建根 problem |
|---|---|---|---|
| A. 命中已存在 work（幂等返回） | `:237` SELECT 现有 → `:238-242` 校验冲突后 **`:241 return work`** | 任意已存在 work（active/candidate/…） | **否（缺口）** |
| B. 新建 active | `:244` 构造 work（state=active）→ `:245` INSERT → **`:247` `if(work.state==="active") ensureRootProblemLocked(...)`** | 新 active | **是** |
| C. 新建 candidate | `:244` state=candidate → `:247` 条件不满足，跳过 | 新 candidate | 否（正确，promote 时再建） |

- **无 `INSERT OR IGNORE` 后 SELECT 的路径**：幂等分支是先 SELECT（`:237`）命中即返回，不是 IGNORE 后回读。`return work` 在 `:241`。
- 冲突分支 `:240`（title/state/contract 不一致）抛 `conflict`，不建根 problem（无需）。

### createWork 所有「返回已存在 work」分支清单 + 是否需补
1. **`:241` 幂等返回 existing（source_id 命中）** —— **需补**：在 `return work` 前加 `if(work.state==="active") ensureRootProblemLocked(db, work.work_id, now);`。这是升级后存量 active work 被 createWork 重复调用时补根 problem 的兜底点。
2. promoteWork 转正（见 §3）——已建，无需补。
3. redirectWork activate（见 §3 末尾）——非 createWork 路径，但属激活缺口，需补。

---

## 3. promoteWork 与其它激活路径

### promoteWork：`src/control/store.ts:519-533`
- `:521-524` 校验存在且 state=candidate、revision 匹配。
- `:526` `reviseContract(...)`（嵌套事务/savepoint）。
- `:527` `UPDATE control_works SET state='active' ... WHERE state='candidate'`。
- **`:529` `ensureRootProblemLocked(db, workId, now);`** —— 建根 problem。
- 结论：promoteWork 已建根 problem，幂等。

### 其它会把 work 翻成 active 的写路径（grep `UPDATE control_works`）
- `:265` reviseContract —— 不改 state。
- `:280` **redirectWork**：`:279` `state = action==="activate" ? "active" : action==="stop" ? "stopped" : old.state`；`:280` 无 state 前置守卫地 UPDATE。**activate 分支不调 `ensureRootProblemLocked`（缺口）**。可把 candidate/stopped/completed work 直接翻成 active。
- `:487` resolveAttentionDecision —— 前置 `:475 work.state!=="active" throw`，只在 active 内转 stopped，不产生新激活。
- `:527` promoteWork —— 已建。

---

## 4. ensureRootProblem / ensureRootProblemLocked / rootProblemId

- `rootProblemId(work_id)`：`src/control/context-pool.ts:98-100` = `problemId(work_id, null, "root")`。
- `problemId`：`src/control/context-pool.ts:93-95` = `sha256(work_id + "" + title)` 前 32 位。纯函数派生，**不查 DB**。
- `ensureRootProblemLocked`：`src/control/store.ts:227-229`，薄封装，要求在已有事务内调用。
- `ensureRootProblem`：`src/control/context-pool.ts:236-250`：
  - `:239` `SELECT * FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL`。
  - `:240` 命中即返回（幂等 get）。
  - `:242` 否则 `createProblem({work_id, parent_problem_id:null, title:"root"})`，新 id = `problemId(work_id,null,"root")` = `rootProblemId`。
  - `:243-248` 并发 `conflict` 兜底重查。
- **幂等性**：SELECT-then-INSERT；并发撞 `problem_id` PK（=rootProblemId）被 `createProblem` 抛 conflict 后重查返回。注意：唯一根 problem 约束**无 DB 层 UNIQUE(work_id,parent) 支撑**，纯应用层 + PK 碰撞兜底。

---

## 5. orchestrator 注入 problem_id

- `collectContextFacts()`：`src/orchestrator/orchestrator.ts:314-336`。
  - `:316-318` `SELECT DISTINCT work_id FROM tasks WHERE work_id IS NOT NULL` —— **来自 orchestrator DB 的 tasks 表，不 join control_works，不按 state 过滤**。任何有 task 行的 work_id 都会被收集。
  - `:320-331` 对每个 work 调 `collectAndSpool({... problem_id: rootProblemId(row.work_id) ...})`。
  - **`:326` 无条件注入 `problem_id: rootProblemId(row.work_id)`**，无「problem 行是否存在」的判断。注释 `:324-325` 假设 Core 已建行。
- `CollectorContext.problem_id` 是可选字段（`context-collector.ts:29`），但 orchestrator 总是传值；`buildEvent` `:127` 透传 `ctx.problem_id ?? null`。

---

## 6. context-reducer linkProblemObject / problem 缺失行为

- `ingestFactObserved`：`src/control/context-reducer.ts:98-248`。
- 事务起点 `:140`。**problem 存在性检查在 `:176-182`**：
  ```ts
  if (payload.problem_id) {
    const problem = getProblem(db, payload.problem_id);
    if (!problem) throw new ControlError("invalid", "problem not found");   // :178
    if (problem.work_id !== payload.work_id) throw new ControlError("conflict", "cross-work problem reference");
  }
  ```
  problem 行不存在 → **抛 `ControlError("invalid","problem not found")`**，在事务内抛出 → `tx.immediate()`(`:247`) 回滚：不写 object/version/**不写 dedup 行**。
- `linkProblemObject` 调用点 `:223-225` 在检查之后；`linkProblemObject` 自身（`context-pool.ts:410-411`）也会 `getProblem` 缺失抛 `ControlError("not_found","problem not found")`，但 fact 路径里 `:178` 先触发，走不到这里。
- 注意 `:178` 的 code 是 **`"invalid"`**，不是 `"conflict"`，也不是 `"not_found"`。

---

## 7. collector cursor 推进与「永不重投」

摄入侧（Core / control）：`src/control/context-ingest.ts:188-273`。
- `:198-200` 整文件读入、逐行处理。
- `:240` 调 `ingestFactObservedOrThrow`。
- `:251-258` catch：
  - `:252-254` 仅当 `err.code==="conflict"` → `stats.quarantined++`（这是 integrity/out-of-order 那类，reducer 已落 `control_context_fact_quarantine` 表）。
  - `:256` 其它（含本 bug 的 `"invalid","problem not found"`）→ `recordFailed` → 进 `failedRows`。
- `:262-265` 把 `failedRows` 写成 sidecar 文件 `<seg>.quarantine.<ts>.ndjson`。
- **`:268-269` 无论本行成败，整文件 `rename` 成 `<seg>.processed.<ts>`**。`findPendingFiles`（`:168-171`）跳过含 `.processed.` 的文件 → **该 seg 永不重读**。

采集侧（orchestrator）cursor：`src/orchestrator/context-collector.ts`。
- `:99-101` 按 `source_event_id` 读 `context_collector_cursor`。
- `:104-107` 同 content_hash → `return null`（不重发）。
- **`:119-122` 在产出事件前 UPSERT cursor（observation_revision/content_hash）**，与下游 ingest 是否成功无关。
- 表结构 `src/orchestrator/schema.sql:63-68`。

结论：fact 因 problem 缺失失败 → 进 sidecar（非 dedup 表）→ seg 文件被消费 → collector cursor 已推进 → 同内容下次跳过。**永不重投，fact 静默断流。** sidecar 无自动重放路径（`findPendingFiles` 只读 `active-context-collector*.ndjson`）。

---

## 8. control_context_problems 表 schema

DDL：`src/control/store.ts:62-75`。
- `problem_id TEXT PRIMARY KEY`（`:63`）
- `work_id TEXT NOT NULL`（`:64`）
- `parent_problem_id TEXT`（`:65`，根为 NULL；`:72` 自环 CHECK）
- `root_problem_id TEXT NOT NULL`（`:66`）
- `state/revision/created_at/updated_at`（`:68-71`）
- `:73` parent 自引用外键。
- **唯一约束**：仅 `problem_id` 主键。`work_id`+`parent_problem_id` **无 UNIQUE**；`:75` `idx_context_problems_work(work_id, root_problem_id)` 是普通索引。「一个 work 一个根 problem」由 `ensureRootProblem` 应用层 SELECT-then-INSERT + `problem_id` PK 碰撞保证。

---

## 9. 审计结论

### 9.1 根因是否成立
**成立。** 升级到 v4 的存量库：v4 迁移不建根 problem（`:161`），createWork 幂等返回不补（`:241`），redirect activate 不补（`:280`）。而 orchestrator 无条件注入 `rootProblemId`（`orchestrator.ts:326`），reducer 对缺失 problem 抛 `invalid`（`context-reducer.ts:178`），ingest 把该行进 sidecar 并消费 seg 文件（`context-ingest.ts:256,269`），collector cursor 已推进不重发（`context-collector.ts:119-122,104-107`）。

### 9.2 精确改动点列表（file:line + 改什么）
1. **新增 v5 迁移回填存量根 problem**（核心 hotfix）
   - `src/control/store.ts:20`：`CONTROL_SCHEMA_VERSION` 4 → **5**。
   - `src/control/store.ts:161` 之后（数组 `:157-162` 内）追加：
     `{to:5,destructive:false,apply(db){ for (const r of db.query("SELECT work_id FROM control_works").all()) ensureRootProblem(db, r.work_id, Date.now()); db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(5,Date.now()); }}`
     （在迁移事务内调用；`ensureRootProblem` 幂等，见 §4。）
2. **createWork 幂等返回补根 problem**：`src/control/store.ts:241` `return work;` 之前插入
   `if (work.state==="active") ensureRootProblemLocked(db, work.work_id, now);`
   （已在 `:235` 事务内，安全。）
3. **redirectWork activate 分支补根 problem**：`src/control/store.ts:280` 之后（`:281` 之前），当 `state==="active"` 时 `ensureRootProblemLocked(db, workId, now);`。

> 注：1 是对存量已部署库的一次性回填；2、3 是堵住今后再次产生「active 但无根 problem」的入口。三者互补，缺一不可——只做 1 不做 2/3，下次 createWork 幂等命中或 redirect activate 又会破。

### 9.3 archived 范围决策
- 「archived」是 mgmt 层 `mgmt_work_profile.track_state='archived'`（`src/manage/archive.ts:23`），**不删 orchestrator 的 tasks 行，也不改 control_works.state**。
- collector 查询 `orchestrator.ts:316-318` 不按 state/archived 过滤，归档 work 仍被枚举；但归档 work 无新 task_events，content_hash 不变 → `context-collector.ts:104-107` 直接跳过，**不会发新 fact**。
- 决策：**v5 回填遍历全部 `control_works` 行（不只 active）**。理由：
  1. `ensureRootProblem` 幂等且每 work 一行，成本可忽略；对 candidate/stopped/completed/archived 建根 problem 无副作用（promoteWork/createWork 后续 `:240` 命中即返回）。
  2. collector 本身 state-unaware，且 redirectWork（`:279-280`）可把任一状态翻回 active——只回填 active 会漏掉「stopped 被 redirect 重新激活」这一边界，导致再次断流。
  3. 严格最小化方案（仅 active）会留 §3 的 redirect 缺口，不推荐。

### 9.4 是否需要新 schema 版本
**需要。** 现有 v4 迁移只做 DDL，无数据回填。迁移框架只跑 `to>version`（`store.ts:167`），要让已部署的 v4 库执行一次性回填，必须 bump 到 v5 并登记 `{to:5,...}`。回填内容是纯幂等 INSERT（缺则补），非破坏性。

---

## 10. createWork「返回已存在 work」分支逐一标注

| # | 分支位置 | 触发条件 | 当前是否建根 problem | 是否需补 |
|---|---|---|---|---|
| 1 | `store.ts:241` `return work`（source_id 命中 existing） | 同 (source,source_id) 已存在 | 否 | **是**（active 时补 `ensureRootProblemLocked`） |
| 2 | `store.ts:240` 冲突抛 `conflict` | title/state/contract 不一致 | —（拒绝） | 否 |
| 3 | promoteWork `store.ts:529`（候选转正，非 createWork 内） | candidate→active | 是 | 否（已建） |
| 4 | redirectWork activate `store.ts:280`（非 createWork 内） | action=activate | 否 | **是**（激活时补） |

新建 active（`store.ts:247`）与新建 candidate（`:247` 跳过，正确）均无问题。
