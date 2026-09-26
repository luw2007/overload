# Audit — KISS Task2: mgmt artifact 版本投影进 context 问题池

- 日期：2026-09-24
- 模式：只读代码审计，未修改任何文件、未跑测试、未 commit。
- 范围：为「把 `mgmt_artifact_versions` 中 stored 版本投影为 `control_context_objects/object_versions`」建立当前代码事实。
- 关键红线复核：`manage/*` 不直接裸写 `control_context_*` 表；投影器必须是 `src/control/*` 导出的 Core 函数，manage 仅按名调用（与现有 `upsertAttention` 调用方式一致，见 manifest.ts:213）。

---

## 1. mgmt schema DDL

文件：`src/manage/schema.ts`（由 migration v2 建表，`src/control/store.ts:159`）。

### `mgmt_artifacts`（schema.ts:41-44）

```sql
CREATE TABLE mgmt_artifacts(
  artifact_id  TEXT PRIMARY KEY,
  work_id      TEXT NOT NULL REFERENCES mgmt_work_profile(work_id),
  kind         TEXT NOT NULL,          -- file | git_commit | git_dirty | external（schema.ts:44 注释）
  canonical_key TEXT NOT NULL,
  display_path TEXT,
  created_at   INTEGER,
  UNIQUE(work_id,kind,canonical_key)
);
```

- **存在 `work_id` 直接列**（schema.ts:42），FK 到 `mgmt_work_profile.work_id`。
- `artifact_id` 派生：`artifactId(workId, kind, canonicalKey) = sha256(workId+kind+canonicalKey)[:32]`，`src/manage/identity.ts:6`。
- 无 `content_sha256 / snapshot_* / sensitivity` 列——这些全在 versions 表。

### `mgmt_artifact_versions`（schema.ts:47-57）

```sql
CREATE TABLE mgmt_artifact_versions(
  version_id      TEXT PRIMARY KEY,
  artifact_id     TEXT NOT NULL REFERENCES mgmt_artifacts(artifact_id),
  content_kind    TEXT NOT NULL CHECK(content_kind IN ('content','deleted','metadata_only')),
  content_sha256  TEXT NOT NULL,
  snapshot_path   TEXT,
  staging_name    TEXT,
  snapshot_state  TEXT NOT NULL CHECK(snapshot_state IN
                    ('pending','stored','lost','too_large','withheld_sensitive','pruned','reference_only','write_failed')),
  sensitivity     TEXT NOT NULL DEFAULT 'unknown',
  scanner_version INTEGER NOT NULL DEFAULT 0,
  shareable       INTEGER NOT NULL DEFAULT 0,
  producer        TEXT NOT NULL,          -- <execution_id> | 'multiple' | 'unknown'
  history_available INTEGER NOT NULL DEFAULT 1,
  stale_capture   INTEGER NOT NULL DEFAULT 0,
  observed_at     INTEGER,
  evidence_at     INTEGER
);
CREATE UNIQUE INDEX mgmt_versions_artifact_version ON mgmt_artifact_versions(artifact_id, version_id); -- :56
CREATE INDEX mgmt_versions_artifact ON mgmt_artifact_versions(artifact_id, observed_at);              -- :57
```

重点列落点：
- `content_sha256`：schema.ts:50。
- `snapshot_path`：schema.ts:50（可空）。
- `snapshot_state`：schema.ts:51-52。
- `sensitivity`：schema.ts:53，默认 `'unknown'`。
- 版本表**没有 summary 列**；摘要在 `mgmt_summaries(subject_id, subject_version, generator, text, created_at)`（schema.ts:162-163），本期投影不依赖。
- `created_at` 在 artifacts 表（schema.ts:43）；versions 用 `observed_at/evidence_at`。

---

## 2. mgmt artifact → work 绑定

**结论：直接列绑定，无需走 session/binding。**

```sql
-- 等价于 on-demand-fetcher.ts:215-220 的连接
SELECT a.work_id FROM mgmt_artifacts a WHERE a.artifact_id=?;
-- 或按 version：
SELECT a.work_id FROM mgmt_artifact_versions v JOIN mgmt_artifacts a ON a.artifact_id=v.artifact_id
 WHERE v.version_id=?;
```

后者已是现成工具函数 `objectOwner(db, objectId)`（`src/manage/relations.ts:60-62`）。

写入侧证据（绑定总是 canonical work）：
- `collect.ts:43`：`ownerWorkId=canonicalWorkId(db,workId)`。
- `collect.ts:61`：`INSERT OR IGNORE INTO mgmt_artifacts(...,work_id,...)` 用 `ownerWorkId`。
- 即 artifacts 行的 `work_id` 永远是 canonical work id；alias 不重写 artifact 身份（schema.ts:25 注释）。

调用链（采集→绑定）：
```
scanOnce (manage/manage.ts:38)
  → per session file: bindExecution (manage.ts:53-54) / strongWork (manage.ts:28-36)
  → collectExecution (manage.ts:56 → manage/collect.ts:42)
    → capture (collect.ts:21) 计算 aid/vid/sha
    → BEGIN IMMEDIATE (collect.ts:55)
      → INSERT mgmt_artifacts (collect.ts:58/59/61)
      → INSERT mgmt_artifact_versions (collect.ts:62)
    → COMMIT (collect.ts:68)
  → [事务外] rename tmp→final + UPDATE versions SET snapshot_state='stored' (collect.ts:70)
```

拿不到 work 归属的场景：
- artifacts 表 `work_id` NOT NULL FK，理论上不存在无归属行。
- 唯一边界：`version_id` 级别反查（relations.ts:61）已覆盖；跨 work 访问由 on-demand-fetcher.ts:219 `AND a.work_id=?` 强校验。
- alias 场景：卡片 `work_id` 必为 canonical（manifest.ts:135 强制），与 artifacts 写入侧一致，无错配。

---

## 3. on-demand-fetcher.ts 的 `artifact:<id>@<ver>` 分支

文件：`src/control/on-demand-fetcher.ts:211-258`。

- reference 正则：`/^artifact:([^@]+)@([^@]+)$/`（:212）。
- 归属校验查询：join `mgmt_artifacts a` / `mgmt_artifact_versions v`，`WHERE a.artifact_id=? AND v.version_id=? AND a.work_id=?`（:215-220）；不命中 → `forbidden`（:221）。
- snapshot_state 检查：仅 `'stored'` 放行，其余 → `unavailable: snapshot not stored: <state>`（:222-225）。
- 路径安全：
  - `snapshot_path` 非空且无 NUL（:226-229）；
  - `snapshotRoot = $OVERLOAD_SNAPSHOT_ROOT || ~/.overload/artifacts/mgmt`（:230）；
  - 拒绝 `..` 段（:232-234）、拒绝逃逸 root / 绝对 rel（:235-238）；
  - 拒绝 symlink（:241-244）；read 失败 → unavailable（:246-248）。
- sha256 校验：`createHash('sha256')` 比对 `v.content_sha256`（:249-252）。
- 二进制拒绝：前 8KB 含 NUL → unavailable（:254-256）。
- 返回 utf8 payload（:257）；外层 `fetchOnDemand` 再对 payload 复算 sha256 与 `version.content_hash` 比对（:384-387）。

合约定义：`src/shared/context-contract.ts:28`（`artifact:<id>@<ver>` → snapshot 原始字节，sha256=content_sha256）。

**当前缺口：没有任何 producer 写入 reference 为 `artifact:...` 的 `control_context_object_versions` 行**（见第 5 节），故该分支虽可用但不可达。[已过时 2026-09-24 晚]：新增 src/control/artifact-projection.ts，ctype='artifact' 由 requestAcceptance（manifest.ts:247）投影写入，createObject 不再零调用。

---

## 4. control 侧三张表 DDL

文件：`src/control/store.ts`，`CONTEXT_SCHEMA`（:61-139，migration v3，store.ts:160）。

### `control_context_objects`（store.ts:76-91）

```sql
object_id          TEXT PRIMARY KEY,
work_id            TEXT NOT NULL,
primary_problem_id TEXT,                       -- FK→control_context_problems
ctype              TEXT NOT NULL CHECK (ctype IN
                     ('objective','constraints','fact','decision','artifact','scene')),  -- :80 已含 'artifact'
fact_subtype       TEXT CHECK (... IN ('code_state','test_result','external_state','observation_evidence')),
revision           INTEGER NOT NULL DEFAULT 1,
purged_at          TEXT,
tombstone_reason   TEXT,
created_at         INTEGER NOT NULL,
updated_at         INTEGER NOT NULL
```

### `control_context_object_versions`（store.ts:92-109）

```sql
object_id     TEXT NOT NULL,
revision      INTEGER NOT NULL,
reference     TEXT NOT NULL,                     -- :95，自由文本
source_type   TEXT NOT NULL,                     -- :96，无 CHECK（TS 联合见 context-pool.ts:12）
sensitivity   TEXT NOT NULL DEFAULT 'unknown'
              CHECK (sensitivity IN ('unknown','clean','suspected','confirmed_secret')),  -- :97
shareable     INTEGER NOT NULL DEFAULT 0,
expires_at    INTEGER, staleness_ms INTEGER, collected_at INTEGER,
derived_from  TEXT, summary_short TEXT, summary_long TEXT,
content_hash  TEXT NOT NULL,                     -- :105
created_at    INTEGER NOT NULL,
PRIMARY KEY (object_id, revision),               -- :107
FOREIGN KEY (object_id) REFERENCES control_context_objects(object_id)
```

### `control_context_problem_objects`（store.ts:110-119）

```sql
problem_id  TEXT NOT NULL,
object_id   TEXT NOT NULL,
revision    INTEGER NOT NULL,
role        TEXT NOT NULL,
created_at  INTEGER NOT NULL,
PRIMARY KEY (problem_id, object_id, role),        -- :116
FOREIGN KEY (problem_id) REFERENCES control_context_problems(problem_id),
FOREIGN KEY (object_id, revision) REFERENCES control_context_object_versions(object_id, revision)  -- :118
```

upsert 行为：`INSERT ... ON CONFLICT(problem_id,object_id,role) DO UPDATE SET revision=excluded.revision, created_at=excluded.created_at`（`src/control/context-pool.ts:424`，`linkProblemObject`）——同 (problem,object,role) 只保留最新 revision 指针。

---

## 5. 现有 context object 写入路径（范式参考）

生产代码（非测试）写入点只有两处范式：

1. **直接 API（手搓范式）**：`createObject`（`src/control/context-pool.ts:308-340`）
   - `object_id = objectId(work_id, ctype, object_canonical_key) = sha256(work_id+ctype+key)[:32]`（context-pool.ts:102-104）。
   - 事务内：INSERT objects（:331-333）+ INSERT versions（:334-336）。
   - 版本递增用 `updateObject`（context-pool.ts:345-371）：CAS bump objects.revision + INSERT 新 version 行。
   - 关联用 `linkProblemObject`（context-pool.ts:398-428），跨 work 需 share 记录（:417-421）。
   - 约束：`confirmed_secret && shareable!==0` 拒绝（:325/:360）。

2. **事件摄入范式**：`ingestFactObserved`（`src/control/context-reducer.ts:98-248`）
   - INSERT objects（:198-200）/ INSERT versions（:203-221）/ linkProblemObject（:224）/ dedup 表（:227-229）/ enqueue context.updated（:231-242）。
   - 仅服务 `ctype='fact'`，带 idempotency_key / quarantine / 乱序防护。

**除测试外，没有任何地方用 `ctype='artifact'` 调 createObject。** grep 结果中非测试调用 createObject 为 0 处；唯一活写路径是 fact 摄入。投影器应复用范式 1（createObject/updateObject/linkProblemObject），不要走 fact reducer（reducer 强制 fact_subtype，context-reducer.ts:199-200）。[已过时 2026-09-24 晚]：新增 src/control/artifact-projection.ts，ctype='artifact' 由 requestAcceptance（manifest.ts:247）投影写入，createObject 不再零调用。

---

## 6. 投影触发点候选

| 候选 | 位置 | 调用链 | 评估 |
|---|---|---|---|
| (a) mgmt scan 循环尾部 | manage/manage.ts:63；版本 stored 落盘 collect.ts:70 | scanOnce→collectExecution→commit→rename→UPDATE stored | 拒绝：每次扫描全量投影所有 work 的所有 stored 版本，无界噪声；且 collect.ts:70 在事务外，投影时机碎裂。 |
| (b) ingest loop 内版本插入后 | collect.ts:62/67 | collectExecution 事务内 | 拒绝：manage 事务内直接投影会触碰 control 表（违反红线）；且逐文件投影、时机过早（pending 未落盘）。 |
| (c) **manifest publish / requestAcceptance** | web/mgmt-routes.ts:68-90 → manifest.ts:127 insertManifest → manifest.ts:182 requestAcceptance | `POST /api/mgmt/manifests/:work` → computeManifest → insertManifest → requestAcceptance（upsertAttention，manifest.ts:213） | **推荐**。理由：① manifest entries 已锁定 (artifact_id,version_id) 不可变集合（schema.ts:65-69 复合 FK），投影集有界；② 决策卡此刻才被创建，证据恰需此时出现；③ requestAcceptance 已 import 并调用 Core 导出函数（upsertAttention），新增一个 `projectManifestArtifacts(db, manifestId, now)` Core 导出函数同构；④ 投影失败不阻塞建卡（或失败即 500 显式暴露）。 |
| (d) web recordAcceptance | manifest.ts:247-287 | POST acceptance | 次选：接受发生后投影为时已晚（卡已展示）。 |
| (e) context-assembler 装配时懒投影 | context-assembler.ts:348-402 | getDecisionViewPackage | 拒绝：装配期读 mgmt 库+写 control 库混在一起，幂等/事务边界差；assembly 是读路径。 |

**推荐触发点 (c)**：在 `requestAcceptance`（manifest.ts:213 upsertAttention 之前）调用 Core 新函数 `projectManifestArtifacts(db, manifestId, now)`。manage 只编排，SQL 在 `src/control/` 内。

补充：投影集查询（manifest.ts:196-200 已现成）：
```sql
SELECT e.artifact_id, e.version_id, a.kind, a.canonical_key, a.display_path,
       v.content_kind, v.content_sha256, v.snapshot_state, v.sensitivity, v.shareable
FROM mgmt_manifest_entries e
JOIN mgmt_artifacts a ON a.artifact_id=e.artifact_id
JOIN mgmt_artifact_versions v ON v.version_id=e.version_id AND v.artifact_id=e.artifact_id
WHERE e.manifest_id=?
```

---

## 7. sensitivity 取值与映射

mgmt 侧扫描器：`src/manage/classify.ts:3` → `'none' | 'suspect' | 'withheld'`；DDL 默认 `'unknown'`（schema.ts:53）。
- `none`：路径非 denylist、无 secret 模式（classify.ts:27）。
- `suspect`：二进制（head 含 NUL，classify.ts:22）。
- `withheld`：路径 denylist（:18-20）或命中 secret 模式/高熵 token（:24-27）。

control 侧：`'unknown' | 'clean' | 'suspected' | 'confirmed_secret'`（store.ts:97；context-pool.ts:9；context-contract.ts:12）。
可见性策略：confirmed_secret 需 grant（visibility-policy.ts:122-124）；suspected 不允许 full（:152-156）。

**当前代码中无任何 mgmt→control sensitivity 映射逻辑**（grep 证实）。建议映射表：

| mgmt sensitivity | mgmt snapshot_state 联动 | control sensitivity | shareable |
|---|---|---|---|
| `none` | stored（唯一落盘分支，collect.ts:26） | `clean` | 透传 mgmt.shareable（默认 0） |
| `suspect`（二进制） | withheld_sensitive | `suspected` | 0 |
| `withheld`（denylist/secret） | withheld_sensitive | `confirmed_secret` | 强制 0（pool 校验 :325） |

> 实际实现：withheld→unknown（artifact-projection.ts:28），采纳 review-claude M6 反对意见，绝不映射成 confirmed_secret。
| `unknown`（DDL 默认，如 deleted 行 collect.ts:24） | reference_only | `unknown` | 0 |

---

## 8. snapshot_state 取值与投影决策

DDL CHECK 全集（schema.ts:51-52）+ 产生位置（collect.ts:61 派生）：

| snapshot_state | 产生条件 | 是否投影 full |
|---|---|---|
| `stored` | collect.ts:70 rename 后 UPDATE | **是**：reference 可取字节，full 视图可达 |
| `pending` | collect.ts:61 插入时、tmp 未 rename | 否（瞬态）。投影时若仍 pending 则跳过，等下次 requestAcceptance |
| `withheld_sensitive` | collect.ts:61：`sensitivity!='none'` 且无 snapshot | 投影**占位对象**（identity+hash+summary），full 必然被 fetcher :223 拒绝；sensitivity 按上表映射 |
| `reference_only` | collect.ts:61：`sensitivity='none'` 但无 snapshot（deleted content_kind，collect.ts:24） | 投影占位对象，summary 标注 deleted/无快照 |
| `lost` / `pruned` / `too_large` / `write_failed` | DDL 预留，当前 collect 不产生 | 否，跳过（超出本期） |

---

## 9. 审计结论

### 9.1 work 绑定精确查询
`mgmt_artifacts.work_id` 直接 NOT NULL FK（schema.ts:42），写入恒为 canonical（collect.ts:43/61）。投影按 manifest entries join 即可拿到 `a.work_id`（即 problem/work 归属），无需 session→binding 链路。

### 9.2 推荐触发点
`requestAcceptance`（`src/manage/manifest.ts:213` upsertAttention 之前）调用 Core 新导出函数 `projectManifestArtifacts(db, manifestId, now)`，实现放 `src/control/`（建议新文件 `src/control/artifact-projection.ts`，复用 context-pool 的 createObject/updateObject/linkProblemObject）。

> 实际实现：函数名 `projectArtifactVersions(db, work_id, now)`（artifact-projection.ts:67），按 work 全量投影 stored/reference_only version，触发点 `manifest.ts:247`（在 upsertAttention 之后调用）。

对象建模：
- 一个 mgmt artifact ↔ 一个 control object：`object_id = objectId(work_id, 'artifact', artifact_id)`（canonical_key 用 artifact_id 本身）。
- 一个 mgmt version ↔ 一个 control revision：`reference = \`artifact:${artifact_id}@${version_id}\``，`content_hash = content_sha256`，`source_type='artifact'`。
- 已存在同 reference 的 version 行则跳过（幂等）；同 object 新 version 走 updateObject CAS。
- 关联：`linkProblemObject(problem_id = rootProblemId(work_id), object_id, revision, role='artifact')`——root problem 由 ensureRootProblem 在建 work 时创建（store.ts:247/529）。
- summary_short：`display_path + ' @' + version_id.slice(0,8)`；withheld/deleted 占位写说明文本。

### 9.3 非 stored 处理决策
- `stored`：全投影。
- `pending`：跳过（瞬态，下次发布重试）。
- `withheld_sensitive`：投影占位对象（sensitivity=confirmed_secret，shareable=0），不提供字节，靠 short 摘要展示「存在但已脱敏」。
- `reference_only`（deleted/git_dirty）：投影占位对象，summary 标注无快照。
- `lost/pruned/too_large/write_failed`：跳过。

### 9.4 schema 变更结论
**无需新表、无需新列、无需 bump CONTROL_SCHEMA_VERSION（保持 4）。**
- ctype 枚举已含 `'artifact'`（store.ts:80）。
- source_type 无 CHECK 约束（store.ts:96），可直接写 `'artifact'`。
- sensitivity CHECK 值域（store.ts:97）足以容纳第 7 节映射。
- problem_objects upsert 语义已就绪（context-pool.ts:424）。
- 唯一需注意：投影器必须自管幂等（查现有 latest version.reference），因为 control 侧无 mgmt 侧 dedup 表可复用。

### 9.5 关键 file:line 速查
- mgmt artifacts/versions DDL：`src/manage/schema.ts:41-57`
- sensitivity 扫描器：`src/manage/classify.ts:3,16-28`
- 版本写入 + state 派生：`src/manage/collect.ts:61-62,70`
- work 归属反查：`src/manage/relations.ts:60-62`
- fetcher artifact 分支：`src/control/on-demand-fetcher.ts:211-258`
- control 三表 DDL：`src/control/store.ts:76-119`
- 写范式 createObject/updateObject/linkProblemObject：`src/control/context-pool.ts:308,345,398-428`
- 推荐触发点：`src/manage/manifest.ts:182-245`（requestAcceptance），路由 `src/web/mgmt-routes.ts:68-90`
- assembler 消费 artifact 角色：`src/control/context-assembler.ts:377-388`
