# 只读审计：收编剩余裸写 control_attention（KISS Task 3）

- 审计时间：2026-09-24
- 范围：`src/manage/` 全目录；对照 `src/control/store.ts`、`src/control/outbox.ts`、`src/control/types.ts`
- 约束：只读，未修改任何文件、未跑测试、未 commit
- 行号为本次重新 grep 核对结果（P0 报告里的 relations.ts:55 / manifest.ts:323 / launch.ts:69 已漂移，以本文为准）

---

## 0. 核心结论（先读）

`src/manage/` 下剩余直接写 `control_attention` 的裸写共 **3 处**：

| # | 位置 | 所在函数 | 语义 |
|---|------|----------|------|
| B1 | `src/manage/relations.ts:55` | `aliasWork` | 批量 supersede：work 被 alias 时，把该 canonical work 下所有 open 的 `mgmt:accept:*` 卡置 superseded |
| B2 | `src/manage/manifest.ts:311` | `invalidateAcceptances` | 单卡 supersede：manifest 工件版本漂移，把该 `mgmt:accept:*` 卡置 superseded |
| B3 | `src/manage/launch.ts:96`（`reconcileLaunches` 内） | `reconcileLaunches` | 外部效果确认：未知 handoff 启动后来绑定成功，把 `:unknown` 卡置 resolved/succeeded |

`src/manage/` 内 **没有** 任何直接写 `control_attention_events` 或 `control_outbox` 的 SQL（grep 命中 0）。
`src/manage/` 内 **没有** 任何 `UPDATE control_works`（全部为 SELECT / FK DDL），本次无需触碰 `control_works`。

P0 已收编的三处复核确认均已改调 Core API、无裸写：
- `submit.ts:450 openEffectsCard` → `upsertAttention`（`submit.ts:461`）；对 `control_works` 仅 `SELECT revision`（`submit.ts:452`）
- `manifest.ts:247 recordAcceptance` → `recordAttentionResolution`（`manifest.ts:282`）
- `launch.ts:53 unknownAttention` → `upsertAttention`（`launch.ts:59`）

Core 当前 **缺两个导出 API**：(a) 按 item_id / 按 work+prefix 的 supersede；(b) 外部成功确认式 resolve（幂等、可在卡已终止时 no-op）。`supersedeAttention` 在 Core 内已有实现但是 private（`store.ts:330`），不导出。

---

## 1. `src/manage/` 下直接操作 control_attention / events / outbox 的 SQL 全量清单

grep 关键词：`control_attention`、`control_outbox`、`attention_events`、`INSERT INTO`、`UPDATE`、`DELETE FROM`。

### 1.1 写操作（裸写，需收编）

#### B1 — relations.ts:55（批量 supersede）
- 函数：`aliasWork`（`relations.ts:38-58`），整段包在 `db.transaction(()=>{...}).immediate()`（`relations.ts:43,57`）
- SQL 原文（`relations.ts:55`）：
  ```sql
  UPDATE control_attention
     SET state='superseded', revision=revision+1, updated_at=?
   WHERE work_id=?
     AND item_id LIKE 'mgmt:accept:%'
     AND state='open'
  ```
- 参数：`(now, canonicalId)`
- 语义：work 别名合并时，把 canonical work 下**所有** open 验收卡批量 supersede。
- 问题：
  - 无 expectedRevision CAS（虽然 `revision=revision+1`，但 WHERE 只按 `state='open'`，不校验 revision）；
  - **不写 `control_attention_events`**；
  - **不入 `control_outbox`**（无 `attention.superseded` 事件）；
  - 批量按 `work_id + LIKE`，无法对单卡带证据。

#### B2 — manifest.ts:311（单卡 supersede）
- 函数：`invalidateAcceptances`（`manifest.ts:289-317`），在 `apply()` 内按 stale manifest 循环调用；事务边界 `manifest.ts:316`（已在事务内则直跑）
- SQL 原文（`manifest.ts:311`）：
  ```sql
  UPDATE control_attention
     SET state='superseded', revision=revision+1, updated_at=?
   WHERE item_id=?
     AND state='open'
  ```
- 参数：`(now, 'mgmt:accept:'+canonicalWork+':'+manifest_id)`
- 语义：被 invalidate 的 manifest 对应的 open 验收卡 supersede。触发方：`collect.ts:67`（存新版本工件后）。
- 问题：与 B1 相同——无 per-item revision CAS、无 events、无 outbox。

#### B3 — launch.ts:96（外部成功确认式 resolve）
- 函数：`reconcileLaunches`（整文件压缩为一行，`launch.ts:96`），每个 handoff 包在 `db.transaction(()=>{...}).immediate()`
- SQL 原文（`launch.ts:96` 尾部）：
  ```sql
  UPDATE control_attention
     SET state='resolved', effect_state='succeeded', updated_at=?
   WHERE item_id=?
  ```
- 参数：`(now, 'mgmt:handoff:'+handoff.handoff_id+':unknown')`
- 语义：之前 launch 结果未知开的 `:unknown` 卡，在后续 reconcile 发现 session 真的绑定成功后，标记 resolved/succeeded。
- 问题（最严重）：
  - **无 `state=...` 守卫**：若卡已 resolved/superseded，会被盲目覆盖回 resolved/succeeded；
  - **不动 revision**：绕过 CAS，直接覆盖；
  - **不写 events、不入 outbox**；
  - 卡可能根本不存在（从未 unknown 过），UPDATE 静默 no-op——这是期望的幂等行为，新 API 需保留。

### 1.2 读操作（非裸写，仅 expectedRevision 来源）

| 位置 | SQL | 用途 |
|------|-----|------|
| `manifest.ts:202-206` | `SELECT revision FROM control_attention WHERE item_id=?` | `requestAcceptance` 取现有 revision 作 `upsertAttention` 的 `expected_revision` |
| `manifest.ts:276-280` | `SELECT revision FROM control_attention WHERE item_id=?` | `recordAcceptance` 取 revision 传给 `recordAttentionResolution` |
| `archive.ts:21` | `... NOT EXISTS(SELECT 1 FROM control_attention a WHERE a.work_id=p.work_id AND a.state='open' AND a.item_id LIKE 'mgmt:%')` | 归档守卫 |
| `manage.ts:79` | `SELECT * FROM control_attention WHERE work_id IN (...) AND state!='resolved'` | 列表聚合 |

### 1.3 events / outbox 写操作
- `src/manage/` 下 `INSERT INTO control_attention_events`：**0 处**
- `src/manage/` 下 `control_outbox` 任何 SQL：**0 处**

> 含义：三处裸写产生的状态变更完全不进事件流 / outbox，下游 projection、通知、订阅都看不到。这正是要收编的根因。

---

## 2. `src/manage/` 下直接 UPDATE control_works 的位置

grep `control_works` 在 `src/manage/` 命中 10 处，逐处核对：

| 位置 | 语句 | 类型 |
|------|------|------|
| `submit.ts:452` | `SELECT revision FROM control_works WHERE work_id=?` | 读（openEffectsCard 取 contract_revision） |
| `handoff.ts:44` | `SELECT w.title,p.* FROM control_works w JOIN mgmt_work_profile p ...` | 读 |
| `manage.ts:65` | `SELECT w.work_id,... FROM control_works w JOIN mgmt_work_profile p ...` | 读 |
| `manage.ts:68` | `SELECT w.*,p.* FROM control_works w ...` | 读 |
| `manage.ts:72,73` | JOIN control_works 的 alias/hints 查询 | 读 |
| `schema.ts:9,12,22,23` | 注释 + `CREATE TABLE ... REFERENCES control_works(work_id)` | DDL/FK |

**结论：`src/manage/` 无任何 `UPDATE control_works`。本次收编不触碰 `control_works`。** Core 内部 `UPDATE control_works` 仅存在于 `store.ts:265`（reviseContract）、`store.ts:487`（resolveAttentionDecision）、`store.ts:527`（promoteWork），均不在 manage 层。

---

## 3. `src/control/store.ts` 导出的 attention 相关 API 清单

| 函数 | 签名（参数简化） | 语义 | file:line | supersede 覆盖？ | external-success resolve 覆盖？ |
|------|------------------|------|-----------|------------------|----------------------------------|
| `upsertAttention` | `(db, input: Omit<AttentionItem,'revision'|'created_at'|'updated_at'|'defer_until'|'acknowledged_at'> & {expected_revision?}, now?)` → `AttentionItem` | 全字段 upsert；存在则 CAS（`WHERE item_id AND revision=old.revision`），不存在则 insert；写 events `upsert` + emit outbox | `store.ts:293-301` | 间接（可手工传 state='superseded'，但调用方要自己造全字段证据，且无理由字段约定） | 间接（可传 resolved/succeeded，但要自己读 revision、自己判断幂等） |
| `getAttention` | `(db, itemId)` → `AttentionItem\|null` | 按主键读 | `store.ts:302` | — | — |
| `listAttention` | `(db, zone?: 'now'\|'inbox'\|'done', now?)` → `AttentionItem[]` | 列表 + 分区过滤；done = resolved 或 superseded | `store.ts:303` | — | — |
| `recordAttentionResolution` | `(db, itemId, expectedRevision, {verdict:'accepted'\|'rejected', actor, evidence}, now?)` → `AttentionItem` | 单卡带 revision CAS 的结论落地；accepted→resolved/succeeded（记 acknowledged_at）；rejected→superseded/**unknown**；persistAttention 写 events + outbox | `store.ts:376-406` | **半覆盖**：仅 rejected 分支写 superseded，且强制要求 actor、evidence，不适用"工件漂移自动 supersede"（无 actor） | 否 |
| `resolveAttentionDecision` | `(db, itemId, expectedRevision, input: AttentionDecisionInput, now?, actor?)` → `AttentionItem` | 人工决策流：要求 pre-state open+not_started，选中 stop/continue/narrow，会 CAS 改 `control_works.revision` 并 supersede 受影响卡 | `store.ts:408-496` | 内部对 affected 卡调 `supersedeAttention`（`store.ts:488`），但这是合同修订副作用，不是外部触发的 supersede API | 否（会动 control_works，且要求 open+not_started） |
| `actOnAttention` | `(db, itemId, expectedRevision, action:'ack'\|'defer'\|'resolve', input, actor?, now?)` → `AttentionItem` | ack/defer/裸 resolve；resolve 分支对 approval 关联卡有 `effect_state IN (not_started,applying,unknown)` 拦截（`store.ts:506`） | `store.ts:498-515` | 否 | 否（resolve 只置 state='resolved'，不显式置 effect_state='succeeded'，且对 unknown 卡会被 506 行拦截） |
| `recordAttentionFeedback` | `(db, itemId, expectedRevision, useful, reason?, now?)` → void | 反馈；写 control_feedback + enqueue outbox `attention.feedback` | `store.ts:516` | 否 | 否 |
| `recordStopCondition` | `(db, workId, conditionId, evidence, now?, expectedRevision?)` → `AttentionItem` | 开 stop-condition 卡（走 upsertAttention） | `store.ts:285-291` | 否（只开卡） | 否 |
| `getWork` / `listWorks` / `createWork` / `reviseContract` / `redirectWork` / `promoteWork` | — | work 级操作；其中 reviseContract（`store.ts:268`）和 resolveAttentionDecision（`store.ts:488`）内部对 stale 卡调 private `supersedeAttention` | 见各行 | 仅内部使用 | — |

**private 复用件（不导出，但新 API 应复用）：**
- `persistAttention(db, old, item, kind, detail, now)` — `store.ts:368-371`：CAS UPDATE + INSERT events + emitAttention(outbox)。
- `supersedeAttention(db, prior, workRevision, detail, now)` — `store.ts:330-339`：把 prior 置 superseded，evidence 合并 `superseded_by_work_revision`，调 persistAttention。**需要调用方先把 prior 整条 AttentionItem 读出来，且绑定一个 workRevision**——这正是 manage 层不直接用它的原因。
- `emitAttention(db, item, kind)` — `store.ts:224`：enqueueControlEvent，kind 形如 `attention.<kind>`。

**覆盖矩阵结论：**

| 需求 | 现有导出 API 能否直接用 |
|------|--------------------------|
| 单卡 open→superseded，带 reason/evidence，幂等 | ❌ 缺（`supersedeAttention` private 且绑 workRevision） |
| 按 (work_id, item_id LIKE prefix, state='open') 批量 supersede | ❌ 缺 |
| 单卡 open/unknown→resolved/succeeded，卡缺失或已终止时幂等 no-op | ❌ 缺（actOnAttention.resolve 对 unknown 卡被 `store.ts:506` 拦截，且不置 effect_state） |

---

## 4. 相关表 DDL

### 4.1 `control_attention`（`src/control/store.ts:35-45`）
```sql
CREATE TABLE IF NOT EXISTS control_attention(
  item_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','applying','resolved','superseded')),
  effect_state TEXT NOT NULL CHECK(effect_state IN ('not_started','applying','succeeded','failed','unknown')),
  urgency TEXT NOT NULL CHECK(urgency IN ('now','inbox')),
  conclusion TEXT NOT NULL, trigger TEXT NOT NULL,
  impact TEXT NOT NULL, recommendation TEXT, options TEXT NOT NULL,
  owner TEXT NOT NULL, expires_at INTEGER,
  defer_until INTEGER, acknowledged_at INTEGER,
  source_link TEXT, approval_id TEXT, consumer_owner TEXT,
  contract_revision INTEGER NOT NULL,
  decision_mode TEXT NOT NULL CHECK(decision_mode IN ('human_only','scoped_auto')),
  evidence TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS control_attention_work ON control_attention(work_id,state,updated_at);  -- store.ts:45
```
- 注意：DDL 的 CHECK 只约束值域，**不约束状态迁移合法性**（迁移靠应用层）。

### 4.2 `control_attention_events`（`src/control/store.ts:46-49`）
```sql
CREATE TABLE IF NOT EXISTS control_attention_events(
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

### 4.3 `control_outbox`（`src/control/outbox.ts:20-26`，由 `ensureOutbox` 建）
```sql
CREATE TABLE IF NOT EXISTS control_outbox(
  event_id TEXT PRIMARY KEY,
  producer_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  work_id TEXT, item_id TEXT,
  payload TEXT NOT NULL, payload_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  published_at INTEGER, delivered_at INTEGER,
  lease_owner TEXT, lease_until INTEGER,
  UNIQUE(producer_id, entity_id, entity_version, kind)
);
CREATE INDEX IF NOT EXISTS control_outbox_delivery ON control_outbox(delivered_at, lease_until, created_at);
```
- 幂等键：`event_id = sha256(producer_id \0 entity_id \0 entity_version \0 kind)`（`outbox.ts:40-41`）；写入用 `INSERT OR IGNORE`（`outbox.ts:46`）；同 identity 不同 payload 直接抛错（`outbox.ts:44-45`）。
- 即：同一 (item_id, revision, kind) 的事件重入不会重复入队；跨 revision 才算新事件。

---

## 5. 现有 CAS + events + outbox 事务范式（新 API 实现模板）

以 `recordAttentionResolution`（`store.ts:376-406`）为准，完整模式：

```text
db.transaction(() => {
  1. old = getAttention(db, itemId)                  // store.ts:390
     if (!old) throw not_found
     if (old.revision !== expectedRevision) throw conflict   // store.ts:392
  2. 构造 item = { ...old,
                  revision: old.revision + 1,
                  state/effect_state/acknowledged_at/evidence/updated_at }  // store.ts:393-401
  3. persistAttention(db, old, item, kind, detail, now)           // store.ts:402
       ├─ CAS UPDATE control_attention
       │    SET revision=?,state=?,effect_state=?,contract_revision=?,
       │        evidence=?,defer_until=?,acknowledged_at=?,updated_at=?
       │  WHERE item_id=? AND revision=old.revision               // store.ts:369
       │    if (!changes) throw conflict
       ├─ INSERT INTO control_attention_events(item_id,revision,kind,detail,created_at)  // store.ts:370
       └─ emitAttention(db, item, `attention.${kind}`)
            → enqueueControlEvent(entity_id=item_id, entity_version=item.revision,
                                  kind=`attention.${kind}`, payload={attention:item})  // store.ts:224
}).immediate()
```

`recordStopCondition`（`store.ts:285-291`）是"开卡"侧的同款范式：事务内 `getAttention` 取 existing → 拼 `expected_revision` → 走 `upsertAttention`（其内部已含 CAS+events+outbox，见 `store.ts:296-300`）。

**新 API 必须复用 `persistAttention`，不得再裸写 UPDATE。**

---

## 6. attention 状态机合法转换

DDL 值域（`store.ts:37-38` / `types.ts:45-46`）：
- `state ∈ {open, applying, resolved, superseded}`
- `effect_state ∈ {not_started, applying, succeeded, failed, unknown}`

应用层已存在的显式迁移约束：

| 迁移 | 触发点 | file:line |
|------|--------|-----------|
| open/not_started → applying/applying（人工决策进行中） | `resolveAttentionDecision` 先要求 `old.state==='open' && old.effect_state==='not_started'` | `store.ts:417,480-481` |
| applying/applying → resolved/succeeded（决策完成、效果已验证） | `resolveAttentionDecision` | `store.ts:491-492` |
| open/* → resolved/succeeded（accepted 验收，记 acknowledged_at） | `recordAttentionResolution` verdict=accepted | `store.ts:396-398` |
| open/* → superseded/unknown（rejected 验收） | `recordAttentionResolution` verdict=rejected | `store.ts:396-397` |
| open/not_started → superseded（合同修订 / 决策收编受影响卡） | private `supersedeAttention`，被 `reviseContract:268`、`resolveAttentionDecision:488` 调用 | `store.ts:330-339` |
| approval 关联卡 effect_state ∈ {not_started,applying,unknown} 时禁止裸 resolve | `actOnAttention` resolve 分支拦截 | `store.ts:506` |
| done 分区 = resolved ∪ superseded | `listAttention` | `store.ts:303` |

**本任务必须遵守的转换规则（与任务书一致）：**
- 交付接受 / 外部效果确认 → `state=resolved` + `effect_state=succeeded`；
- 重定向或被新卡取代（work alias、manifest 漂移、合同修订）→ `state=superseded`；
- **rejected 绝不能写成 resolved**——现有 `recordAttentionResolution` 已正确把 rejected 映射到 superseded/unknown（`store.ts:396-397`），新 supersede API 不得产出 resolved。
- B3（launch.ts:96）当前把 `:unknown` 卡直接写成 resolved/succeeded，语义属"外部效果确认"，合法，但必须走 CAS+events+outbox。

---

## 7. 每处裸写的收编方案

### B1 — relations.ts:55（批量 supersede）
- 现状：在 `aliasWork` 事务里对 canonical work 下所有 open `mgmt:accept:%` 卡一把 UPDATE。
- 收编：在 Core 新增导出 `supersedeOpenAttentionByWork(db, workId, itemPrefix, detail, now): number`（见 §8 签名建议）。manage 侧把 `relations.ts:55` 一行替换为该调用，detail 带 `{reason:'work_aliased', alias_work_id:aliasId, actor}`。
- expectedRevision 来源：新 API 内部 `SELECT item_id,revision FROM control_attention WHERE work_id=? AND item_id LIKE ? AND state='open'`，逐卡 `getAttention` 后用 `persistAttention` CAS。
- 幂等：第二遍（`aliasWork` 已被 `relations.ts:46` 的 "alias mapping is immutable" 挡住，本就不会重入；即便 collect 类重复触发，新 API 只挑 `state='open'`，已 superseded 的自然跳过；outbox event_id 含 revision，重复 supersede 不会发生在同一 revision 上）。

### B2 — manifest.ts:311（单卡 supersede）
- 现状：`invalidateAcceptances` 循环里对已知 `item_id` 一把 UPDATE，带 `AND state='open'`。
- 收编：Core 新增导出 `supersedeAttentionById(db, itemId, expectedRevision, detail, now): AttentionItem | null`。manage 侧：
  - 先 `SELECT revision FROM control_attention WHERE item_id=? AND state='open'`（复用 `manifest.ts:276-280` 的读法即可）；
  - 若行存在则 `supersedeAttentionById(db, itemId, row.revision, {reason, manifest_id}, now)`；
  - 若不存在（卡已终止或从未开）则 no-op，与现状 UPDATE 无 changes 等价。
- expectedRevision：从同事务内 `SELECT revision` 读（与 `recordAcceptance` 在 `manifest.ts:276-282` 的写法一致）。
- 幂等：collect 重复触发时卡已 superseded，SELECT 不命中，自然 no-op；outbox 不重复入队。

### B3 — launch.ts:96（外部成功确认）
- 现状：`reconcileLaunches` 内对 `mgmt:handoff:<id>:unknown` 一把 UPDATE 成 resolved/succeeded，无守卫、无 revision、无 events。
- 收编：Core 新增导出 `resolveAttentionByExternalSuccess(db, itemId, detail, now): AttentionItem | null`。语义：
  1. `old = getAttention(db, itemId)`；
  2. 若 `old` 不存在 → 返回 null（与现状 UPDATE 0 行等价）；
  3. 若 `old.state==='resolved' && old.effect_state==='succeeded'` → 直接返回 old（**幂等 no-op，不 bump revision、不重复入队 outbox**）；
  4. 否则要求 `old.state==='open'`（其他终态如 superseded 不得覆盖——这是相对现状的行为收紧，符合 state 机），CAS 到 `state=resolved, effect_state=succeeded, revision+1, acknowledged_at=now`，走 persistAttention 写 events + outbox。
- expectedRevision：API 内部读 old.revision 自洽，调用方不传（reconcileLaunches 是轮询，不该要求调用方先读）。
- 幂等：重复 reconcile 命中步骤 3 no-op；outbox 同一 (item_id, revision, kind) 用 `INSERT OR IGNORE` 去重（`outbox.ts:46`）。

---

## 8. 审计结论

### 8.1 裸写总数
**3 处**，精确 file:line：
1. `src/manage/relations.ts:55` — 批量 supersede（work alias）
2. `src/manage/manifest.ts:311` — 单卡 supersede（manifest 漂移）
3. `src/manage/launch.ts:96` — 外部成功确认式 resolve（handoff bind 成功）

无 `control_attention_events` / `control_outbox` 裸写；无 `control_works` UPDATE。

### 8.2 建议新增的 Core API 签名（在 `src/control/store.ts` 导出，复用 private `persistAttention` / `supersedeAttention`）

```ts
// 单卡 supersede：open → superseded，带 revision CAS + events + outbox。
// 卡不存在或已非 open → 返回 null（幂等 no-op），不抛冲突。
export function supersedeAttentionById(
  db: Database,
  itemId: string,
  expectedRevision: number,
  detail: { reason: string; superseded_by?: string; [k: string]: unknown },
  now?: number,
): AttentionItem | null;

// 批量 supersede：按 (work_id, item_id LIKE prefix) 挑所有 open 卡逐张 CAS。
// 返回实际 supersede 张数。供 relations.ts:55 使用。
export function supersedeOpenAttentionByWork(
  db: Database,
  workId: string,
  itemPrefix: string,          // 例如 'mgmt:accept:'
  detail: { reason: string; [k: string]: unknown },
  now?: number,
): number;

// 外部效果确认：open(任意 effect_state) → resolved/succeeded。
// 卡缺失或已 resolved/succeeded → 幂等 no-op；已 superseded → 不覆盖（返回 null）。
export function resolveAttentionByExternalSuccess(
  db: Database,
  itemId: string,
  detail: { evidence: Record<string, unknown>; [k: string]: unknown },
  now?: number,
): AttentionItem | null;
```

> 备注：private `supersedeAttention(db, prior, workRevision, detail, now)`（`store.ts:330`）当前把 `workRevision` 写进 evidence 并要求传入完整 `prior`。新 `supersedeAttentionById` 可在内部 `getAttention` 后复用它，或抽出一个不绑定 workRevision 的轻量 supersede 分支；建议后者，因为 manage 层的 supersede 不是合同修订触发，没有 work revision 语义。

### 8.3 是否有裸写无法被现有/新增 API 覆盖
无。三处都能映射到上述三个新 API：
- B1 → `supersedeOpenAttentionByWork`
- B2 → `supersedeAttentionById`
- B3 → `resolveAttentionByExternalSuccess`

无需要保留裸写的特殊场景。收编后 `src/manage/` 应做到对 `control_attention` 表 **零直接 DML**（仅剩 §1.2 的 SELECT 读）。
