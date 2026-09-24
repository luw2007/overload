# 独立代码审计：context-as-artifact P0-MVP 当前代码真实状态

- 审计时间：2026-09-24
- 审计范围：`/Users/luwei.will/ai/overload/src`
- 审计方式：只读，逐文件读源码；不信任外部 review 结论，全部用 `file:line` 复核。
- 结论摘要：外部 review 的 5 个 Blocker 中，B1/B2 确认；B3 描述的是 outbox→ledger 投影的既定设计，不是 bug；B4 行号错位（实际无未守卫 ALTER 在 control 迁移链）；B5 由本次 6 节收敛。

---

## 1. 根 problem get-or-create

### 1.1 当前代码事实

**`createProblem` 实现** — `src/control/context-pool.ts:172-226`

```ts
172 export function createProblem(
173   db, input: { work_id; parent_problem_id?; title; root_problem_id? }, nowTs = now()
176 ): Problem {
180   const parent_id = input.parent_problem_id ?? null;
181   const new_id = problemId(input.work_id, parent_id, input.title);
183   const tx = db.transaction(() => {
184     if (getProblem(db, new_id)) throw new ControlError("conflict", "problem already exists");
186     if (parent_id === null) {
187       root_problem_id = new_id;
...
192     const parent = getProblem(db, parent_id);
193     if (!parent) throw new ControlError("not_found", "parent problem not found");
194     if (parent.work_id !== input.work_id) throw new ControlError("conflict", "cross-work parent is not allowed");
199     // 环检测：向上遍历
200     const visited = new Set<string>();
...
221     db.query("INSERT INTO control_context_problems(...) VALUES (...)").run(...);
```

- `problemId` — `context-pool.ts:93-95`：`sha256(work_id + (parent??"") + title)`。**id 由哈希派生，调用方不可指定**。
- 幂等性：`context-pool.ts:184` 命中即抛 `conflict`，**不是 get-or-create，是 create-or-conflict**。重放同 (work_id, parent, title) 第二次必抛错。
- root/parent/环校验：`186-208`。root 分支自指 root；parent 分支校验 work_id 一致 + 向上 visited 集合环检测。**逻辑齐全，但只在 create 路径跑**。
- DDL：`src/control/store.ts:60-72`。`problem_id TEXT PRIMARY KEY`，`parent_problem_id TEXT`，`root_problem_id TEXT NOT NULL`，CHECK `parent_problem_id != problem_id`，FK 自引用。**无 UNIQUE(work_id, parent_problem_id, title)**，即哈希碰撞由 problemId 函数自己兜底。

**work 激活/创建路径是否建根 problem：否。**

- `createWork` — `store.ts:223-241`：INSERT control_works + control_contract_revisions + emitWork。**无任何 problem 创建**。
- `promoteWork` — `store.ts:475-488`：reviseContract + UPDATE state='active' + emitWork。**无 problem 创建**。
- 全仓非测试代码 grep `createProblem|problemId(`：仅命中 `context-pool.ts:93,172,181` 自身。**生产代码从未调用 createProblem**。

**`context-reducer.ts` 是否直接 INSERT problem 行：否。**

- reducer 只 INSERT `control_context_objects`（`context-reducer.ts:197-200`）和 `control_context_object_versions`（203-221）。problem 引用是 `payload.problem_id` 可空外键（200 行 `primary_problem_id`），不创建 problem 行。176-182 行只做 `getProblem` 存在性校验。

### 1.2 问题判定

- B1 **确认**：`createProblem` 不幂等（撞 key 抛 conflict），id 由哈希派生不可指定（`context-pool.ts:181,93`）。
- 更严重：**整个系统当前没有任何根 problem 被创建**。work 激活后 `control_context_problems` 为空，reducer 里 `payload.problem_id` 总是 null（见 §2），`resolveAttentionDecision` 里 `workHasContext`（`store.ts:392`）永远 false。

### 1.3 精确改动点

| 文件:行 | 改什么 | 改成什么 |
|---|---|---|
| `src/control/context-pool.ts:172` | 新增导出函数 `ensureRootProblem(db, work_id, title?, nowTs?)`，紧邻 `createProblem` 之后（约 227 行后） | 幂等 get-or-create：先 `SELECT * FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL`；命中即返回；未命中则用固定 title（缺省用 `getWork(work_id).title` 或 `"root:"+work_id`）调 `createProblem(db,{work_id,parent_problem_id:null,title})`。**注意**：title 必须稳定，否则 problemId 派生值漂移。建议 root problem title 固定为 `"root"`，再用 problemId(work_id, null, "root") 做确定性查询，避免扫表。 |
| `src/control/context-pool.ts:93` | `problemId` 签名不动 | 导出一个 `rootProblemId(work_id)=problemId(work_id,null,"root")` 便捷函数供 ensureRootProblem 与 collector 共用。 |
| `src/control/store.ts:237`（createWork INSERT works 后） | 建 work 时若非常驻 candidate，不建 problem；改为在 promoteWork 成功后建 | 见下条。 |
| `src/control/store.ts:475-488`（promoteWork 事务内，`emitWork(db, promoted, "work.promoted")` 之前约 485 行） | 在 promoteWork 事务内调 `ensureRootProblem(db, workId)` | 根 problem 与 work 激活同事务，同 revision 落点。 |
| `src/control/store.ts:223-241`（createWork 非 candidate 路径） | 若 `input.candidate===false` 直接 active，也需 ensureRootProblem | 与 promoteWork 共用一个内部 helper `ensureRootProblemLocked(db, workId, now)`（同事务调用，不另开事务）。 |
| `src/orchestrator/orchestrator.ts:316-319`（collectAndSpool 调用） | 传入 `problem_id: rootProblemId(row.work_id)` | collectContextFacts 在 SELECT work_id 后，对每个 work 调一次 `ensureRootProblem`（通过 control store API，只读侧）或直接在 CollectorContext 注入已解析的 root problem_id。**红线**：orchestrator 不直接写 control 表；root problem 必须由 Core 在 promoteWork/createWork 时建好，orchestrator 只在 collectContextFacts 时 `SELECT problem_id FROM control_context_problems WHERE work_id=? AND parent_problem_id IS NULL`（经 control store 读 API 或只读连接），注入 ctx。 |
| `src/orchestrator/context-collector.ts:29` | `problem_id?: string` 已经是可选字段 | orchestrator.ts:317 构造 ctx 时填入 rootProblemId；`buildEvent` 127 行已透传，无需改。 |

### 1.4 相关测试

- `src/control/context-pool.test.ts`（234 行）— createProblem/环测试。新增 ensureRootProblem 幂等用例应加在这里。
- `src/control/store.test.ts`、`store-extra.test.ts`、`store-guard.test.ts` — work/promote 路径。
- `src/orchestrator/context-collector.test.ts`（431 行）— ctx.problem_id 透传用例。

---

## 2. problem_id 链路 + problem_objects 主键冲突

### 2.1 当前代码事实

**orchestrator 调用点** — `src/orchestrator/orchestrator.ts:310-324`

```ts
316   collectAndSpool(
317     { orchestratorDb: this.db, work_id: row.work_id, actor: "orchestrator", runtime_id: this.owner },
318     this.spool.dir,
319   );
```

**未传 `problem_id`**。CollectorContext 定义在 `context-collector.ts:25-34`，`problem_id?: string` 可选。

**collector 透传** — `context-collector.ts:125-142`

```ts
125   return {
126     work_id: ctx.work_id,
127     problem_id: ctx.problem_id ?? null,
```

**reducer fact 处理** — `context-reducer.ts:176-225`

```ts
176   if (payload.problem_id) {
177     const problem = getProblem(db, payload.problem_id);
...
189   const existingObj = getObject(db, object_id);
190   const revision = existingObj ? existingObj.revision + 1 : 1;
...
193   if (existingObj) {
194     db.query("UPDATE control_context_objects SET revision=?, updated_at=? WHERE object_id=?").run(...);
196   } else {
197     db.query(`INSERT INTO control_context_objects(...) VALUES (...)`).run(..., payload.problem_id ?? null, ...);
201   }
203   db.query(`INSERT INTO control_context_object_versions(...) VALUES (...)`).run(object_id, revision, ...);
223   if (payload.problem_id) {
224     linkProblemObject(db, { problem_id: payload.problem_id, object_id, revision, role: "fact" }, now);
225   }
```

**linkProblemObject** — `context-pool.ts:374-402`

```ts
398   db.query("INSERT INTO control_context_problem_objects(problem_id,object_id,revision,role,created_at) VALUES (?,?,?,?,?)")
399     .run(input.problem_id, input.object_id, revision, input.role, nowTs);
```

普通 INSERT，**无 ON CONFLICT**。

**problem_objects 主键** — `store.ts:108-117`

```sql
108 CREATE TABLE IF NOT EXISTS control_context_problem_objects(
109   problem_id  TEXT NOT NULL,
110   object_id   TEXT NOT NULL,
111   revision    INTEGER NOT NULL,
112   role        TEXT NOT NULL,
113   created_at  INTEGER NOT NULL,
114   PRIMARY KEY (problem_id, object_id, role),
```

**PK 不含 revision**。

### 2.2 问题判定 — B2 确认（但当前是潜伏炸弹，不是现网故障）

精确触发路径：

1. MVP 接入 §1 后，`orchestrator.ts:317` 开始传 `problem_id=<root>`。
2. fact v1 到达：`existingObj=null` → 插入 object（revision=1）→ 插入 version(1) → `linkProblemObject(problem_id, object_id, revision=1, role='fact')` 成功。
3. 同一 `source_event_id` 的 content_hash 变化（如测试重跑），collector 侧 `context-collector.ts:109` `revision=row.observation_revision+1=2`，idempotency_key 因含 observation_revision 而不同（`context-reducer.ts:22-31`），**不命中 dedup**。
4. reducer：`existingObj` 存在 → object.revision=2 → INSERT version(2) → 调 `linkProblemObject(problem_id, object_id, revision=2, role='fact')`。
5. `context-pool.ts:398` INSERT 撞 PK `(problem_id, object_id, role)`（v1 那行还在）→ SQLite UNIQUE constraint 异常，整个事务回滚，包括 version(2) 行。

重放同 v1（同 observation_revision）走 dedup 快路径 `context-reducer.ts:123-126`，不触发 link，安全。**只有 v1→v2 演进时才炸**。

### 2.3 精确改动点

| 文件:行 | 改什么 | 改成什么 |
|---|---|---|
| `src/control/context-pool.ts:398-399` | 普通 INSERT 改 upsert，把 revision 指向最新 | `INSERT INTO control_context_problem_objects(problem_id,object_id,revision,role,created_at) VALUES (?,?,?,?,?) ON CONFLICT(problem_id,object_id,role) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at`。语义：同一 problem+object+role 只保留一条最新 revision 指针（与 `control_context_objects.revision` 头指针对齐）。**不要**把 revision 加进 PK——那会让 v1/v2 两条链接同时存在，listObjectsByProblem（351-372）会重复枚举同一 object。 |
| `src/control/context-pool.ts:404-407`（unlinkProblemObject） | 现状 DELETE 按 (problem_id, object_id, role)，与 upsert 后一致 | 不动。 |
| `src/control/context-reducer.ts:223-225` | 不动调用方 | upsert 后此处自然幂等。 |
| `src/control/store.ts:108-117` | DDL | 不改 PK（保留 `(problem_id, object_id, role)`）。如要留痕历史 revision 链接，另建 append-only 表，本期不做。 |

### 2.4 相关测试

- `src/control/context-reducer.test.ts`（366 行）— 新增 "同 object 第二次 fact 到达（problem_id 非空）不撞 PK，problem_objects.revision 指到 v2" 用例。
- `src/control/context-pool.test.ts` — linkProblemObject 重复链接 upsert 语义。

---

## 3. attention 写路径（manage 裸写）

### 3.1 当前代码事实

全仓 grep `control_attention` 写操作（非测试、非 control/ 自身）：

**(a) `src/manage/submit.ts:450-472` — openEffectsCard**

```ts
459   db.query(
461    `INSERT OR IGNORE INTO control_attention(item_id,work_id,revision,state,effect_state,urgency,conclusion,trigger,impact,recommendation,options,owner,contract_revision,decision_mode,evidence,created_at,updated_at) VALUES (?,?,?,'open','unknown','now','外部效果未知','提交前发现未确认的外部副作用','继续提交可能重复执行外部副作用','先人工核对远端状态','[]',?,?, 'human_only','{}',?,?)`,
462   ).run(`mgmt:effects:${workId}:unknown`, workId, work.revision, owner, work.revision, now, now);
```

问题：
- 缺列：`expires_at / defer_until / acknowledged_at / source_link / approval_id / consumer_owner` 全靠 NULL 默认。
- `effect_state='unknown'`（schema 允许，`store.ts:36`）。
- **INSERT OR IGNORE 静默吞冲突**：第二次提交时若 work.revision 已涨，旧卡不更新，contract_revision 漂移到旧值。
- **不写 control_attention_events，不 enqueue outbox 事件**——下游 ledger/web 看不到这张卡。

**(b) `src/manage/relations.ts:55` — aliasWork 批量 supersede**

```ts
55  db.query("UPDATE control_attention SET state='superseded',revision=revision+1,updated_at=? WHERE work_id=? AND item_id LIKE 'mgmt:accept:%' AND state='open'").run(now, canonicalId);
```

问题：绕过 CAS（不带 WHERE revision=?）、不写 attention_events、不 enqueue outbox。`revision+1` 与并发 upsertAttention 可能跳号/撞 revision。

**(c) `src/manage/launch.ts:53` — unknownAttention**

```ts
53 function unknownAttention(db,handoff,now){db.query(`INSERT INTO control_attention(...) VALUES (?,?,1,'open','unknown','now',...) ON CONFLICT(item_id) DO UPDATE SET updated_at=excluded.updated_at`).run(...);}
```

问题：
- `ON CONFLICT DO UPDATE` 只刷 updated_at，不刷 revision、不刷 contract_revision、不写 events/outbox。
- `owner='decision_owner'` 是字面字符串，不是真实 owner（应从 contract 取）。
- 缺列同 (a)。

**(d) `src/manage/launch.ts:69` — reconcileLaunches 里 resolved**

```ts
db.query("UPDATE control_attention SET state='resolved',effect_state='succeeded',updated_at=? WHERE item_id=?").run(now, `mgmt:handoff:${handoff.handoff_id}:unknown`);
```

问题：不带 revision CAS、不写 attention_events、不 enqueue outbox。

**(e) `src/manage/manifest.ts:283-294` — recordAcceptance 里 resolved**

```ts
283   db.query("UPDATE control_attention SET state='resolved',effect_state='succeeded',revision=?,acknowledged_at=?,updated_at=? WHERE item_id=?").run(next, now, now, itemId);
287   db.query("INSERT INTO control_attention_events(item_id,revision,kind,detail,created_at) VALUES(?,?,?,?,?)").run(itemId, next, "resolved", JSON.stringify({selected_option: verdict, actor}), now);
```

问题：手写 attention_events 但**不 enqueue outbox**（无 `attention.resolved` 事件到 ledger）；CAS 用的是事务内 SELECT 出来的旧 revision，但未在 UPDATE WHERE 带 revision=old（只带 item_id），并发下会覆盖。

**(f) `src/manage/manifest.ts:323` — invalidateAcceptances 批量 supersede**

```ts
323   db.query("UPDATE control_attention SET state='superseded',revision=revision+1,updated_at=? WHERE item_id=? AND state='open'").run(now, `mgmt:accept:${canonicalWork}:${manifest_id}`);
```

同 (b)：无 CAS、无 events、无 outbox。

**对照权威 API**：
- `upsertAttention` — `store.ts:284-292`：事务内 SELECT → CAS UPDATE/INSERT → 写 attention_events → `emitAttention` enqueue outbox。
- `persistAttention` — `store.ts:359-362`：CAS UPDATE + attention_events + emitAttention。
- `supersedeAttention` — `store.ts:321-330`：内部 helper，调 persistAttention。
- outbox 机制 — `outbox.ts:31-50`：`enqueueControlEvent` 幂等（producer+entity+version+kind 唯一），`publishControlEvents` 52-105 投递到 ledger。

### 3.2 问题判定

确认：manage 层有 6 处裸写 control_attention（a-f），全部绕过 CAS + attention_events + outbox。其中 (e) 写了 attention_events 但漏 outbox。

### 3.3 精确改动点

**本阶段（P0-MVP）必须改**：

| 文件:行 | 现状 | 改成 |
|---|---|---|
| `src/manage/submit.ts:450-472` | openEffectsCard 裸 INSERT OR IGNORE | 改调 `upsertAttention(db, { item_id: 'mgmt:effects:'+workId+':unknown', work_id, state:'open', effect_state:'unknown', urgency:'now', conclusion:'外部效果未知', trigger:'pre_submit_unconfirmed_effects', impact:'继续提交可能重复执行外部副作用', recommendation:'先人工核对远端状态', options:['continue','reconcile','abort'], owner, contract_revision: work.revision, decision_mode:'human_only', evidence:{} }, now)`。注意 upsertAttention 要求 `consumer_owner` 可空、`recommendation` 必须 string。 |
| `src/manage/manifest.ts:283-294` | recordAcceptance 裸 UPDATE + 裸 events INSERT | 改调 `actOnAttention(db, itemId, card.revision, 'resolve', { reason: verdict }, actor, now)`。注意 actOnAttention 的 resolve 分支会走 `resolveAttentionDecision`（`store.ts:455`），要求 old.state==='open' && effect_state==='not_started'——而 requestAcceptance 建卡时 effect_state 就是 'not_started'，匹配。若 verdict='rejected' 语义不是 stop/narrow/continue，需要扩展 AttentionDecisionInput 或新增一个 `recordAcceptanceResolution` 权威 API（建议后者：在 store.ts 新增 `recordAttentionResolution(db, itemId, expectedRevision, {verdict, actor, evidence}, now)`，内部走 persistAttention + emitAttention）。 |
| `src/manage/launch.ts:53` | unknownAttention 裸 INSERT ... ON CONFLICT | 改调 `upsertAttention`，同 submit.ts 模式。`owner` 从 `mgmt_work_profile.decision_owner` 或 control_works.contract.decision_owner 取（不要写字面量 'decision_owner'）。 |

**可暂缓（P1）**：

| 文件:行 | 原因 |
|---|---|
| `src/manage/relations.ts:55` | 批量 alias supersede 路径，不在 fact/artifact MVP 主链路上。当前裸写 revision+1 不破坏单卡状态机（state='open'→'superseded' 终态），但 outbox 缺失会让 ledger 审计少一条事件。P1 补一个 `bulkSupersedeAttention(db, workId, itemIdPrefix, reason, now)` 权威 API。 |
| `src/manage/launch.ts:69` | reconcileLaunches 把 unknown 卡 resolved。同样不在 MVP 主链路；但语义上与 (c) 配对，建议随 (c) 一起改：调 `actOnAttention(db, itemId, expectedRevision, 'ack'|'resolve', ...)`。 |
| `src/manage/manifest.ts:323` | invalidateAcceptances 批量 supersede，同 relations.ts:55。P1 处理。 |

### 3.4 相关测试

- `src/control/store.test.ts`、`store-extra.test.ts` — upsertAttention/actOnAttention 用例。
- manage 侧测试：`src/manage/manifest.ts` 对应测试（`src/cli/mgmt.test.ts` 等）。

---

## 4. artifact full 取源

### 4.1 当前代码事实

**fetcher artifact 分支** — `src/control/on-demand-fetcher.ts:211-222`

```ts
211   const artifactMatch = reference.match(/^artifact:([^@]+)@([^@]+)$/);
212   if (artifactMatch) {
213     const [, artifactId, versionId] = artifactMatch;
214     const row = db.query(
215       `SELECT a.artifact_id, a.kind, a.canonical_key, v.version_id, v.content_kind, v.content_sha256, v.snapshot_path, v.snapshot_state, v.sensitivity
216        FROM mgmt_artifacts a
217        JOIN mgmt_artifact_versions v ON v.artifact_id = a.artifact_id
218        WHERE a.artifact_id=? AND v.version_id=? AND a.work_id=?`,
219     ).get(artifactId, versionId, work_id);
220     if (!row) return { blocked: true, reason: "cross-work: artifact not bound to this work", code: "forbidden" };
221     return { payload: JSON.stringify(row) };
222   }
```

**当前返回 `JSON.stringify(row)`（一行元数据 JSON），不读 snapshot_path 文件字节。**

后续 hash 校验 — `on-demand-fetcher.ts:347-351`

```ts
348   const actualHash = createHash("sha256").update(payload).digest("hex");
349   if (actualHash !== version.content_hash) {
350     return { blocked: true, reason: "content_hash mismatch", code: "needs_context" };
351   }
```

对 artifact 引用：`payload = JSON.stringify(row)` 的 sha256 必然 ≠ `version.content_hash`（后者是 manage/collect.ts:26 写入的 `file.sha256`，即原始文件字节 sha256）。**所以任何 artifact: 引用走 full 可见性必然 needs_context**。

**manage 侧 snapshot 写入** — `src/manage/collect.ts:21-70`

```ts
26   snapshot = join(limits.snapshotRoot, workId, aid, file.sha256);
      tmp = `${snapshot}.pending-...`; writeFile(tmp, file.bytes, ...);
61   const snapshotState = row.snapshot ? "pending" : row.sensitivity !== "none" ? "withheld_sensitive" : "reference_only";
62   INSERT INTO mgmt_artifact_versions(..., content_sha256, snapshot_path, staging_name, snapshot_state, ...)
70   for (const file of staged) {
        rename(file.tmp, file.final);
        UPDATE mgmt_artifact_versions SET snapshot_state='stored', staging_name=NULL WHERE snapshot_path=? AND snapshot_state='pending';
      }
```

状态机：`pending`（DB 行已插，文件还在 tmp）→ `stored`（rename 完成）。其他终态：`lost / too_large / withheld_sensitive / pruned / reference_only / write_failed`（DDL `manage/schema.ts:51-52`）。

**shared 契约** — `src/shared/context-contract.ts:28`

> `artifact:<id>@<ver>` → 该行被 fetch 时 `JSON.stringify(row)` 的字节。

**这条注释与 MVP 目标冲突**：契约当前定义 canonical bytes = row JSON，但 content_hash 实际由 collector 算的是文件字节 sha256（manage/collect.ts:25 `file.sha256`）。契约注释是错的/过时的。

### 4.2 问题判定

- fetcher 当前不读 snapshot_path，返回元数据 JSON → **确认是缺口**。
- content_hash 校验闭环因此对 artifact 永不通过。
- 路径安全：当前分支根本不碰文件系统，无穿越风险；但一旦加读文件，snapshot_path 来自 DB（manage 写入），仍需防御性校验。

### 4.3 精确改动点

| 文件:行 | 改什么 | 改成什么 |
|---|---|---|
| `src/control/on-demand-fetcher.ts:211-222` | artifact 分支重写 | 1) 查 row 后，若 `row.snapshot_state !== 'stored'` → return `{blocked:true, reason:\`snapshot not stored: ${row.snapshot_state}\`, code:"unavailable"}`。2) 若 `row.snapshot_path == null` → unavailable。3) 路径安全：`resolved = resolve(row.snapshot_path)`；拒绝 `..`、拒绝 NUL、校验 resolved 在配置的 snapshot_root 之下（root 来自 env `OVERLOAD_SNAPSHOT_ROOT` 或默认 `~/.overload/artifacts/mgmt`，与 `manage/manage.ts:23` 默认值对齐）；拒绝符号链接逃逸（`lstat` 检查）。4) `readFileSync(resolved)` 得 bytes。5) `sha256(bytes)` 必须等于 `row.content_sha256`，不等 → `{blocked:true, reason:'snapshot hash mismatch', code:'unavailable'}`。6) 返回 `{ payload: bytes.toString('utf8') }`（二进制 artifact 本期不支持，MIME 检测后非文本 → unavailable）。 |
| `src/control/on-demand-fetcher.ts:115-122` | 现有 reference 黑名单 `..`/NUL | 保留；snapshot_path 是 DB 值，不在 reference 里，所以单独在 artifact 分支做路径校验。 |
| `src/shared/context-contract.ts:28` | canonical bytes 注释 | 改成：`artifact:<id>@<ver>` → `mgmt_artifact_versions.snapshot_path` 指向的原始文件字节（sha256 = content_sha256）。 |
| `src/manage/collect.ts:61-62,70` | 不动 | 状态机已正确。fetcher 只认 `snapshot_state='stored'`。 |
| `src/control/on-demand-fetcher.ts:215` | SELECT 列 | 增加 `v.snapshot_path, v.snapshot_state`（已在），不需要加列。 |

### 4.4 相关测试

- `src/control/on-demand-fetcher.test.ts`（689 行）— 新增 artifact 分支用例：(a) stored 状态返回文件字节；(b) pending/lost/withheld_sensitive 拦截；(c) snapshot_path 含 `..` 拒绝；(d) 文件 sha256 不匹配 content_sha256 拒绝。

---

## 5. schema 迁移安全

### 5.1 当前代码事实

**`CONTROL_SCHEMA_VERSION = 3`** — `store.ts:18`。

**迁移链** — `store.ts:155-159`

```ts
155 const CONTROL_MIGRATIONS:ControlMigration[]=[
156   {to:1,destructive:false,apply(db){db.exec(CONTROL_SCHEMA);ensureOutbox(db);db.query("INSERT INTO control_schema_meta ...").run(1,...);}},
157   {to:2,destructive:false,apply(db){ensureMgmtSchema(db);db.query("UPDATE control_schema_meta SET version=?,...").run(2,...);}},
158   {to:3,destructive:false,apply(db){db.exec(CONTEXT_SCHEMA);db.query("UPDATE ...").run(3,...);}},
159 ];
```

**拒启逻辑** — `store.ts:160-168`

```ts
161   const version=controlSchemaVersion(db);
162   if(version>CONTROL_SCHEMA_VERSION)throw new ControlError("blocked",`control schema version ${version} is newer than supported ${CONTROL_SCHEMA_VERSION}`);
163   if(version===CONTROL_SCHEMA_VERSION)return;
164   for(const migration of CONTROL_MIGRATIONS.filter(entry=>entry.to>version)){
165     if(migration.destructive)backupForDestructiveMigration(db,migration.to-1,migration.to);
166     const tx=db.transaction(()=>{const current=controlSchemaVersion(db);if(current!==migration.to-1)throw new ControlError("conflict",...);migration.apply(db);});tx.immediate();
167   }
```

**关键事实**：
- v1→v2→v3 全部用 `CREATE TABLE IF NOT EXISTS` + `INSERT/UPDATE control_schema_meta`。**没有 ALTER TABLE**。
- `backupForDestructiveMigration`（150-153）用 `VACUUM INTO` 备份，仅在 `destructive:true` 时触发。当前链里没有 destructive 迁移。
- 迁移可重入：每条迁移包在事务里，且 `ensureControlSchema` 在 `version===CURRENT` 时直接 return（163）。重跑安全。

**B4 复核**：外部 review 称 "ALTER TABLE ADD COLUMN 不可重跑 — 迁移在 store.ts:155-163"。**行号错位**：store.ts:155-163 是迁移数组与 ensureControlSchema，里面没有 ALTER。control 库里唯一的 ALTER 在 `context-reducer.ts:52-55`：

```ts
50   const cols = (db.query("PRAGMA table_info(control_context_fact_dedup)").all() as ...).map(c=>c.name);
52   if (!cols.includes("source_type")) db.exec("ALTER TABLE control_context_fact_dedup ADD COLUMN source_type TEXT");
53   if (!cols.includes("source_id")) ...
54   if (!cols.includes("source_event_id")) ...
55   if (!cols.includes("observation_revision")) ...
```

**这 4 条 ALTER 已经有 PRAGMA 守卫，可重入**。但它们不在版本化迁移框架里，每次 `ingestFactObserved` 都跑（`context-reducer.ts:104`）。

**mgmt 侧** — `manage/schema.ts:170`：`ensureMgmtSchema(db){ db.exec(MGMT_SCHEMA); }`。全是 `CREATE TABLE IF NOT EXISTS`，**无版本号、无迁移链**。新表靠 IF NOT EXISTS 自然重入；新列则无处可加。

### 5.2 问题判定

- B4 **部分否认**：control 迁移链里没有未守卫的 ALTER。但 `ensureContextReducerSchema` 的 4 条 ALTER 游离在版本框架外，应在 v4 迁移里收口。
- mgmt schema 无版本化——后续给 mgmt 表加列会重蹈 control v0→v1 的混乱。本期不要求 mgmt 版本化（P1），但 v4 要把 reducer 的 dedup 表 DDL 正式并入。

### 5.3 v4 迁移应该怎么写

| 文件:行 | 改什么 |
|---|---|
| `src/control/store.ts:18` | `CONTROL_SCHEMA_VERSION = 4`。 |
| `src/control/store.ts:155-159` | 追加 `{to:4, destructive:false, apply(db){ ensureContextReducerSchema(db); db.query("UPDATE control_schema_meta SET version=?,migrated_at=? WHERE id=1").run(4,Date.now()); }}`。 |
| `src/control/context-reducer.ts:33-57` | `ensureContextReducerSchema` 保留，但改为幂等 no-op：v4 迁移已跑过 CREATE TABLE + ALTER 后，此处重复调用 PRAGMA 守卫仍安全。**不要**在 reducer 里再跑裸 ALTER——迁移里跑一次即可。 |
| 守卫模式（如果 v4 需要加新列） | 复制 `context-reducer.ts:50-55` 模式：`const cols = db.query("PRAGMA table_info(<t>)).all().map(c=>c.name); if(!cols.includes("<col>")) db.exec("ALTER TABLE <t> ADD COLUMN <col> <type>");`。SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，必须 PRAGMA 探测。 |
| 备份/回退 | v4 是纯加列/建表（destructive:false），不需要 VACUUM INTO。若未来需要 destructive 迁移，设 `destructive:true`，`ensureControlSchema:165` 会自动备份到 `${path}.control-vX-to-vY-<ts>.bak`（chmod 0600）。回退=关进程、删 DB、把 .bak 复制回原名。 |

### 5.4 相关测试

- `src/control/store.test.ts`、`store-guard.test.ts`、`store-extra.test.ts` — 版本拒启/迁移链用例。
- `src/control/context-reducer.test.ts` — dedup 表 schema。

---

## 6. owner 红线核查

### 6.1 当前代码事实

**Core（src/control/）是否写 orchestrator DB 或 mgmt 表**：否。
- grep `INSERT INTO mgmt_|UPDATE mgmt_|DELETE FROM mgmt_|INSERT INTO tasks|INSERT INTO task_events` in src/control（非测试）：0 命中。
- `on-demand-fetcher.ts:214-219` **读** mgmt_artifacts/mgmt_artifact_versions（SELECT）。这是 Core 跨域读 manage 表，是 §4 改造点，不是写越界。但属于分层异味：Core 依赖 mgmt schema。本期接受（fetcher 已在线），后续可考虑把 artifact 元数据快照进 control_context_object_versions。

**Execution（src/orchestrator/）是否直写 control 库核心表**：否。
- grep `INSERT INTO control_|UPDATE control_|DELETE FROM control_` in src/orchestrator（非测试）：0 命中。
- orchestrator 通过 `import { upsertAttention, enqueueControlEvent, getWork, reviseContract, publishControlEvents } from "../control/store"`（`anomaly-monitor.ts:31`、`approval.ts:10`、`orchestrator.ts:6`）调 Core 权威 API。**这是红线允许的**——调 Core API，不是裸 SQL。
- `orchestrator.ts:333` `openAnswersDb(process.env.OVERLOAD_ANSWERS_PATH)` 打开 control DB **只读**读 decision_owner（330-345），读完 close。
- `anomaly-monitor.ts:426,638,673,914` SELECT control_attention，只读。

**manage（src/manage/）是否写 control_works**：否。
- grep `INSERT INTO control_works|UPDATE control_works` in src/manage（非测试）：0 命中。
- manage 写 control_attention（§3 的 6 处裸写）是越界——manage 应该通过 control store API 写，而不是裸 SQL。这是 §3 要修的。
- manage 读 control_works：`manifest.ts:194 getWork(...)`、`submit.ts:452 SELECT revision FROM control_works`。读是允许的。

**Surface（src/web/）是否直写 control 库**：否。
- web 写的表：`closeouts`（server.ts:79,364）、`conversation_turns`（server.ts:225）、`answers`（server.ts:408 DELETE；answers 表由 decision-bot/mailbox.ts:28 创建，是 decision-bot 自己的收件箱表，不是 control_* 核心表）。
- web 通过 `openControl()` 拿到 db 后调 control store API（如 `server.ts:104` SELECT control_attention 做 approval 反查，只读）。

### 6.2 问题判定

- Core 不写 orchestrator/mgmt：**确认**。
- Execution 不直写 control 表：**确认**（用 Core API）。
- manage 不写 control_works：**确认**；但 manage 裸写 control_attention 是越界（§3 修）。
- Surface 不直写 control：**确认**。

### 6.3 改动点

仅 §3 的 6 处 manage 裸写需收编到 control store API。无其他红线越界。

---

## 7. 外部 review 5 个 Blocker 独立复核结论

| # | 外部结论 | 本审计复核 |
|---|---|---|
| B1 | createProblem 不幂等，id 哈希派生不可指定 — `context-pool.ts:181,93` | **确认**。额外发现：生产代码从未调 createProblem，根 problem 完全缺失。 |
| B2 | linkProblemObject 普通 INSERT，fact 多 revision 撞主键 — `context-pool.ts:397, store.ts:114` | **确认**。实际 INSERT 在 `context-pool.ts:398`（行号差 1）；PK 在 `store.ts:114`（`PRIMARY KEY (problem_id, object_id, role)`，不含 revision）。当前潜伏（collector 不传 problem_id），§1 接通后立即爆。 |
| B3 | applyControlEvent 跑在 ledger 库不是 control 权威表 — `ingest/reducer.ts:84, control/projection.ts:42-49` | **部分否认**。这是 outbox→ledger 投影的既定设计：`outbox.ts:52-105` 把 control DB 事件投递到 ledger.db，`projection.ts` 在 ledger 侧建只读镜像（ledger schema.sql:30-37 有带 event_id 列的 control_attention 投影表）。权威写仍在 control DB。**不是 bug**。 |
| B4 | ALTER TABLE ADD COLUMN 不可重跑 — `store.ts:155-163` | **否认**。store.ts:155-163 是迁移数组，全是 CREATE TABLE IF NOT EXISTS，无 ALTER。control 库唯一的 ALTER 在 `context-reducer.ts:52-55`，已有 PRAGMA table_info 守卫，可重入。真正问题是这 4 条 ALTER 游离在版本化迁移外——§5 v4 收编。 |
| B5 | P0 范围过大含未验证 schema | 本次 6 节收敛后，P0 改动面：约 12 个文件点（见下），可控。 |

---

## 8. 共享契约冻结建议（供实现 subagent 遵守）

### 8.1 新增/修改接口签名

```ts
// src/control/context-pool.ts（新增导出）
export function rootProblemId(work_id: string): string;
export function ensureRootProblem(db: Database, work_id: string, nowTs?: number): Problem;
// 语义：幂等。存在即返回，不存在即以 title="root" createProblem。
// 必须在 createWork(active) / promoteWork 事务内调用。

// src/control/context-pool.ts（修改）
// linkProblemObject 的 INSERT 改 ON CONFLICT(problem_id,object_id,role) DO UPDATE
//   SET revision=excluded.revision, created_at=excluded.created_at
// 函数签名不变。

// src/control/store.ts（新增导出，可选）
export function recordAttentionResolution(
  db: Database,
  itemId: string,
  expectedRevision: number,
  input: { verdict: "accepted"|"rejected"; actor: string; evidence: Record<string, unknown> },
  now?: number,
): AttentionItem;
// 语义：在现有 attention 卡上 CAS 一次 state='resolved'/'superseded' + effect_state='succeeded',
// 写 attention_events + enqueue outbox(attention.resolved)。
// 替代 manifest.ts:283-294 裸写。
```

### 8.2 事件类型

- 不新增事件 kind。fact 链路继续用 `context.updated`（`context-reducer.ts:234`）。
- ensureRootProblem 不发 outbox 事件（problem 是 work 的隐含附属，不是独立决策对象）。如后续需要审计，发 `problem.root_created`，本期不做。
- artifact full 取源成功/失败不发事件（fetcher 是读路径）。

### 8.3 schema 变更

- `CONTROL_SCHEMA_VERSION` 3 → 4。
- v4 迁移：把 `ensureContextReducerSchema` 的 dedup/quarantine 表 DDL 收编进版本链（CREATE TABLE IF NOT EXISTS 已在，ALTER 已守卫）。无新列、无 destructive。
- `control_context_problem_objects` PK 不变（仍 `(problem_id, object_id, role)`），靠 upsert 语义处理 revision 演进。
- mgmt schema 本期不加版本号。

### 8.4 调用方契约

- `orchestrator.collectContextFacts`（`orchestrator.ts:316`）在构造 `CollectorContext` 时必须填 `problem_id` = `rootProblemId(work_id)`（通过 control store 只读查询得到，不自行算哈希）。
- `FactObservedPayload.problem_id` 字段语义：必须是该 work 的 root problem_id（本期不支持子问题路由）。
- artifact reference 的 canonical bytes 定义修正为 snapshot_path 文件字节（见 §4.3）。

### 8.5 不在本期范围

- 子问题树创建（createProblem 公开调用）。
- mgmt schema 版本化。
- manage 批量 supersede（relations.ts:55、manifest.ts:323）收编——P1。
- artifact 二进制/MIME 检测——P1。
