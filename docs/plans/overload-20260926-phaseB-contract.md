# Overload Phase B 工程契约：有界条件等待与原现场恢复

日期：2026-09-27  
范围：`docs/plans/overload-20260926-attention-product.md` §8–§9、§14–§15 B01–B09  
状态：实施契约，**尚未实现、未启用、未部署，也未通过生产或真实外部渠道验收**

## 1. 目的、词义与边界

本契约把“等准确条件成立后回到原事项”冻结成可实施接口。实现必须只增加一个由 control 拥有的等待事实，复用现有 Work、Attention、mailbox、spool/outbox、维护周期和运行器；不得增加第二套 Todo、Work 生命周期、通用调度器或 LLM 轮询。

本文使用：

- **EXISTING**：当前源码已经存在且本契约依赖的事实；不是对部署状态或真实外部能力的声明。
- **NEW**：Phase B 必须新增的规范；本文没有声称已经落地。
- 所有时间均为 Unix epoch 毫秒；所有 JSON 在入库前必须校验为本文的闭合联合类型，持久化时使用 canonical JSON。
- `ready` 只表示观察条件相对创建时基线成立；**不授予执行权限，也不等于 Work、Attention、验收或效果完成**。

### 1.1 明确不做

1. 不支持任意自然语言谓词、条件组合、推断 DAG、周期性 Agent/模型调用或无截止时间观察。
2. 不从等待结果创建 Work、Todo、后继任务、attempt 或批准。
3. 不把 PR URL、标题、聊天内容、进程退出、单个检查通过、management archive 或命令接受当作更强事实。
4. 不增加外部 provider 的伪实现、降级猜测或“看起来可恢复”的按钮。
5. 现有时间型 `defer_until` 仍只负责呈现延期，不创建 `control_waits`。

## 2. 当前事实与缺口

### 2.1 EXISTING：权威边界

| 事实 | 当前权威与位置 | 本契约如何使用 |
| --- | --- | --- |
| Work/Contract/Attention | `src/control/types.ts`、`src/control/store.ts`; control schema 当前版本为 6 | 等待只以 `work_id`、`item_id` 关联，不复制其生命周期 |
| Work 状态 | `control_works.state ∈ candidate, active, stopped, completed` | `completed` 是 Work 条件唯一可接受的完成值；当前没有独立、明确的公开 completion writer，见 §12 |
| 控制事件 | `src/control/outbox.ts` 的实体版本唯一键、payload hash、lease 与 spool 发布 | 等待状态与 outbox 在同一 control DB 事务提交 |
| 检查结果 | orchestrator DB 的 `attempt_check_results` 和 `attempt_signal_samples`；`result_set_version` 由 `getNextResultSetVersion` 单调分配 | 只读取准确 attempt/check/definition/result-set 事实 |
| PR 查询 | `src/orchestrator/pr.ts::checkPr(prUrl, executor)` 调用 `gh pr view` | 当前 URL/`state` 检查不足；Phase B 使用新 provider，不复用它作为生产判定 |
| 决策消费 | `src/decision-bot/mailbox.ts` 的 target/version/expiry/Work revision/receipt/effect observation | 等待不复制批准；自动续跑必须引用并重新验证已有、未过期、未消费的授权快照 |
| 活 blocked ask | adapter `runtime_decisions` → mailbox → `AdapterService.tick()` → `SessionHandle.answer()` | 有真实 consumer 时回答；普通 ledger Q1 只跳回原现场 |
| 通用 resume | `src/shared/resume.ts` `inspectResume` 是唯一三态门：live/remote/orchestrator-owned/非 pi·omp/缺字段为 `unsupported`；无 incarnation、dead pid 无 `session_ended`、`session_ended` 后 pid 仍可见为 `unknown/liveness_unknown`；权威终止但无 runtime checkpoint probe 为 `unknown/checkpoint_probe_unavailable`。wait recovery 读同一函数；Sessions/Hung/Zombie 仅在 `resumable:true` 时显示 Resume，`POST /api/resume-session` 对其余一律 409 且不调用 executor | 当前没有 checkpoint probe，故通用 Resume 实际不可用；现有 API 即便未来可用也只证明 cmux 启动接受，不符合自动恢复完整门槛；不能直接由 ready 调用 |
| 恢复分析 | orchestrator recovery package 能区分 live/terminated/unknown 并组装 checkpoint/效果/预算建议 | 只作为证明输入；当前没有从 package 到可验证执行效果的 Web 执行链 |
| 维护周期 | `scripts/maintenance.sh`: 45s 有界 recon → nudge → watchdog；launchd 每 60s | Phase B observer 复用此周期，且必须自身有界、非阻塞 |
| Web 信任 | exact loopback Host + same-origin 是 CSRF 防护；`options.actor` 才是服务端可信 actor | 等待写入不能从 body/header/query 接受 actor 或 owner |

### 2.2 REQUIRED prerequisite：修复检查结果全局键

当前 `attempt_check_results` 的 `PRIMARY KEY(result_set_version,check_id)` 与 `getNextResultSetVersion(db,work_id)` 的 per-Work 分配域冲突：两个 Work 的本地 version/check ID 会全局碰撞。Phase B 冻结 durable identity 为 **`(work_id,result_set_version,check_id)`**；`work_id` 必须是非空 canonical control Work ID，`result_set_version` 只在该 Work 内单调，source identity 仍是 `{orchestrator_db:'local',work_id,task_id,attempt_id,check_id,check_def_version}`。B-CHECK 不得在旧键上实现或测试。

命名 prerequisite slice **B-ORCH-CHECK-PK** 是这条迁移的唯一 owner，且必须先于 B-CHECK 落地：

1. 修改 `src/orchestrator/schema.sql`，令 `attempt_check_results.work_id TEXT NOT NULL` 且 `PRIMARY KEY(work_id,result_set_version,check_id)`；
2. 在 `src/orchestrator/store.ts::openStore` 的既有 idempotent ensure/migration path 中、任何 `db.exec(schema)` 写入或 producer/reader 使用连接**之前**，用一个 transaction 检查 `PRAGMA table_info/table_xinfo` 与 PK 次序；旧表时创建新表、复制全部字段、校验行数与 identity、替换旧表并重建 `idx_check_results_work`。旧 `work_id` 缺失时，只可用 `task_id` 精确连接现有 tasks 表且该 task 的 `work_id` 非空，确定性补齐；否则迁移 fail closed 并保持旧表，不能猜 Work、丢行或 `INSERT OR IGNORE`；若新键重复也同样 fail closed。`schema.sql` 的 `CREATE TABLE IF NOT EXISTS` 不会重建旧表，不能把它当作迁移；新建 DB 直接取得新 DDL。
3. 将 `insertCheckResults` 的 `work_id` 改为 required non-empty `string`；所有 producer 必须传入准确 Work ID。将 `getCheckResults` 冻结为 `getCheckResults(db:Database,workId:string,resultSetVersion:number)` 并更新 anomaly monitor 等所有 reader，使 result-set 查询不能跨 Work；`getLatestCheckResults/getResultSetVersions/pruneSignalHistory` 继续显式按 Work；
4. 更新 `src/orchestrator/anomaly-store.test.ts` 及受影响 producer/reader focused tests：两个 Work 可各写 `(version=1,check_id='ci')` 而不碰撞；同 Work 同 version/check 仍冲突；旧库迁移保留所有行并验证可证的 task→Work 回填；无法回填的 NULL/空 Work 和歧义旧库 fail closed；reader 不泄漏另一 Work 同版本结果。

这个 prerequisite 只修 orchestrator durable identity/migration 和直接调用者；不得顺带实现 wait adapter。B-CHECK 在 prerequisite 的 migration/collision/reader tests 通过后才可开始，并始终只读该已修复 schema。

### 2.3 NEW：唯一的等待聚合

`control_waits` 是等待状态的唯一写入所有者。来源数据库继续拥有 PR 响应、检查结果、Work 状态、session/runtime、批准与效果事实；observer 只保存绑定基线、最后一次观察快照和等待状态，不重写这些来源事实。

## 3. 单一 schema owner 与 additive migration

### 3.1 NEW：schema 版本

`src/control/store.ts` 的 `CONTROL_SCHEMA_VERSION` 从 6 增至 **7**，新增非破坏性 `to:7` migration。迁移只创建以下表/索引并在同一 immediate transaction 内更新 `control_schema_meta`; 不回填、不自动创建等待、不触发恢复。旧程序看到 schema 7 必须沿现有 `version > supported` 路径拒绝执行性写入，不能回退绕过新约束。

### 3.2 NEW：规范 DDL

```sql
CREATE TABLE IF NOT EXISTS control_waits (
  wait_id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL,
  item_id TEXT NOT NULL,

  condition_kind TEXT NOT NULL
    CHECK (condition_kind IN ('github_pr_merged','check_new_result','work_completed')),
  condition_json TEXT NOT NULL,
  source_identity TEXT NOT NULL,
  source_identity_hash TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  baseline_established_at INTEGER NOT NULL,
  baseline_generation INTEGER NOT NULL CHECK (baseline_generation >= 0),
  source_generation INTEGER NOT NULL CHECK (source_generation >= baseline_generation),

  observed_json TEXT,
  observed_fingerprint TEXT,
  observed_generation INTEGER NOT NULL DEFAULT 0 CHECK (observed_generation >= 0),
  unchanged_count INTEGER NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  last_observed_at INTEGER,
  last_confirmed_at INTEGER,
  state TEXT NOT NULL DEFAULT 'watching'
    CHECK (state IN ('watching','ready','unavailable','expired','cancelled')),
  state_reason TEXT,
  ready_at INTEGER,
  ready_observation_fingerprint TEXT,

  deadline_at INTEGER NOT NULL,
  next_check_at INTEGER,
  transient_failures INTEGER NOT NULL DEFAULT 0 CHECK (transient_failures >= 0),
  transient_budget INTEGER NOT NULL DEFAULT 3 CHECK (transient_budget BETWEEN 1 AND 3),
  last_error_kind TEXT
    CHECK (last_error_kind IS NULL OR last_error_kind IN
      ('transient','rate_limited','permission_denied','unsupported_provider',
       'configuration','invalid_response','identity_mismatch','source_missing','unknown')),
  last_error_detail TEXT,
  retry_after_at INTEGER,

  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  actor TEXT NOT NULL,
  decision_owner TEXT NOT NULL,
  disposition TEXT NOT NULL
    CHECK (disposition IN ('redecide','authorized_resume')),
  authorization_json TEXT,

  disposition_state TEXT
    CHECK (disposition_state IS NULL OR disposition_state IN
      ('pending','redecision_recorded','dispatching','dispatched',
       'effect_succeeded','effect_failed','effect_unknown')),
  disposition_claim_id TEXT,
  dispatch_id TEXT,
  disposition_detail TEXT,
  disposition_at INTEGER,
  effect_observed_at INTEGER,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (work_id) REFERENCES control_works(work_id),
  FOREIGN KEY (item_id) REFERENCES control_attention(item_id),
  CHECK (json_valid(condition_json)),
  CHECK (json_valid(source_identity)),
  CHECK (json_valid(baseline_json)),
  CHECK (observed_json IS NULL OR json_valid(observed_json)),
  CHECK (deadline_at > created_at),
  CHECK (next_check_at IS NULL OR (next_check_at >= created_at AND next_check_at < deadline_at)),
  CHECK (baseline_established_at <= created_at),
  CHECK (last_observed_at IS NULL OR last_observed_at >= baseline_established_at),
  CHECK (last_confirmed_at IS NULL OR last_confirmed_at >= baseline_established_at),
  CHECK (last_confirmed_at IS NULL OR last_observed_at IS NOT NULL),
  CHECK (ready_at IS NULL OR ready_at >= created_at),
  CHECK (retry_after_at IS NULL OR retry_after_at <= deadline_at),
  CHECK (length(wait_id) > 0 AND length(work_id) > 0 AND length(item_id) > 0),
  CHECK (length(source_identity_hash) = 64),
  CHECK (length(actor) > 0 AND length(decision_owner) > 0),
  CHECK (state_reason IS NULL OR length(state_reason) <= 500),
  CHECK (last_error_detail IS NULL OR length(last_error_detail) <= 2000),
  CHECK ((disposition='redecide' AND authorization_json IS NULL) OR
         (disposition='authorized_resume' AND authorization_json IS NOT NULL)),
  CHECK (authorization_json IS NULL OR json_valid(authorization_json)),
  CHECK (disposition_detail IS NULL OR json_valid(disposition_detail)),
  CHECK ((state='ready' AND ready_at IS NOT NULL AND
          ready_observation_fingerprint IS NOT NULL AND next_check_at IS NULL) OR
         (state<>'ready' AND ready_at IS NULL AND
          ready_observation_fingerprint IS NULL)),
  CHECK ((state='watching' AND next_check_at IS NOT NULL) OR
         (state<>'watching' AND next_check_at IS NULL)),
  CHECK ((state IN ('watching','cancelled') AND disposition_state IS NULL) OR
         (state IN ('ready','unavailable','expired') AND disposition_state IS NOT NULL)),
  CHECK (state='ready' OR disposition_state NOT IN
         ('dispatching','dispatched','effect_succeeded','effect_failed','effect_unknown')),
  CHECK ((disposition_state IN ('dispatching','dispatched','effect_succeeded',
          'effect_failed','effect_unknown') AND disposition_claim_id IS NOT NULL
          AND dispatch_id IS NOT NULL) OR
         (disposition_state IS NULL OR disposition_state IN ('pending','redecision_recorded'))),
  CHECK (disposition_at IS NULL OR disposition_at >= created_at),
  CHECK (effect_observed_at IS NULL OR effect_observed_at >= created_at),
  CHECK (disposition_state <> 'redecision_recorded' OR disposition_at IS NOT NULL),
  CHECK (disposition_state NOT IN ('effect_succeeded','effect_failed','effect_unknown')
         OR effect_observed_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS control_waits_exact_unsettled
  ON control_waits(work_id, item_id, condition_kind, source_identity_hash)
  WHERE state='watching' OR disposition_state IN ('pending','dispatching','dispatched','effect_failed','effect_unknown');

CREATE INDEX IF NOT EXISTS control_waits_due
  ON control_waits(next_check_at, wait_id)
  WHERE state='watching';

CREATE INDEX IF NOT EXISTS control_waits_item
  ON control_waits(item_id, updated_at DESC, wait_id DESC);

CREATE INDEX IF NOT EXISTS control_waits_work
  ON control_waits(work_id, updated_at DESC, wait_id DESC);

CREATE TABLE IF NOT EXISTS control_work_dependencies (
  work_id TEXT NOT NULL,
  prerequisite_work_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','revoked')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (work_id, prerequisite_work_id),
  FOREIGN KEY (work_id) REFERENCES control_works(work_id),
  FOREIGN KEY (prerequisite_work_id) REFERENCES control_works(work_id),
  CHECK (work_id <> prerequisite_work_id)
);

CREATE INDEX IF NOT EXISTS control_work_dependencies_prerequisite
  ON control_work_dependencies(prerequisite_work_id, state, work_id);
```

### 3.3 列语义与不变量

- `wait_id`: server-generated UUID；客户端不能指定。
- `work_id` / `item_id`: 创建时必须分别存在，且 Attention 的 `work_id` 必须相同。终态记录保留审计，不 cascade 删除。
- `condition_json`: 完整 typed condition；`source_identity` 是从 condition 规范化后 canonical JSON；hash 是其 SHA-256。两者由服务端派生，不接受客户端值。
- `baseline_established_at`: adapter 在 INSERT 前取得的 `WaitBaselineSnapshot.established_at`；必须 `<= created_at`，且初始 observation/confirmation 时间以它为下界。创建 mutation 的 `created_at` 在 baseline 返回后取时钟；若时钟回退致 `established_at > created_at`，拒绝创建而非改写 sample 时间。它不是由 INSERT 时钟重写的 `created_at`。
- `baseline_json` / `baseline_generation`: 创建事务前由对应 source adapter **实时读取**。读取失败则创建失败，不能以空或零伪造；因此旧事件、缓存的“已变化”或创建前已合并状态不能唤醒新等待。
- `observed_json`: 最后一次成功、已验证身份的 source snapshot。错误不会清空它。
- `observed_fingerprint`: source snapshot 的 canonical semantic fingerprint；同 fingerprint 只增加 `unchanged_count`、更新时间并安排下一次检查，不增加 `observed_generation`。
- `baseline_generation` / `source_generation`: source-specific monotonic high-water marks；前者固定为创建时基线，后者只前进不回退。映射固定为 GitHub baseline observation/merge timestamp 毫秒、check `result_set_version`、Work `revision`。GitHub 在未合并时保持 baseline generation，不能用普通 poll 时间制造“新事件”。
- `observed_generation`: 等待本地的实质 snapshot 代次，仅 semantic fingerprint 变化时加 1，不替代来源 high-water。
- `transient_failures`: **连续** transient/rate-limit/unknown 失败数；成功观察归零；重启不归零。`transient_budget` 固定为 `1..3`，默认 3，并固定于创建时。
- `last_confirmed_at`: 最近一次成功校验来源身份并得到可分类事实的时间；任何错误不更新。
- `version`: 每次持久变化（包括相同结果的观察计数、错误、状态转换、取消和 disposition）加 1，作为 CAS 和 outbox `entity_version`。
- `actor` 与 `decision_owner`: 创建时由服务端可信 actor 和当前 Work contract 固定。actor 必须等于当前 `contract.decision_owner`；缺 actor、缺 contract/owner、owner 不匹配一律拒绝。它们不因客户端 payload 改写。
- `authorization_json`（domain codec 映射为 `resume_grant`）: 仅 `authorized_resume`; 保存**创建前已经存在**的授权标识和精确范围快照，不保存新授权，也不能单独证明仍可用。这里的 `authorized_resume` 是“经原执行入口继续”的 umbrella，可能是回答仍活着的 exact blocked ask，也可能是恢复已停止的 exact checkpoint；绝不是 generic restart。

本期“一个准确条件一个未结 wait”的唯一性是 `(work_id,item_id,condition_kind,source_identity_hash)`：`watching`、待 disposition、正在 dispatch、已 dispatch 未取得效果和 `effect_failed/effect_unknown` 都占用唯一键。同一 Work 可有多个独立 item/condition。重复 create 返回 `409 active_wait_exists` 和已有 `wait_id/version`，不默默复用；若 hash 相同而 canonical identity 不同则作为 identity collision fail closed。只有 `cancelled`、`redecision_recorded` 或 `effect_succeeded` 才可新建；`effect_failed/effect_unknown` 必须先通过 `recordWaitRedecision` 将原 Attention 人工责任落地并转换成 `redecision_recorded`。新 wait 必须重新采样基线并得到新 `wait_id`，旧同意不能转移。取消只允许 `watching` 且由当前 decision owner CAS 转成 `cancelled`；不撤销外部效果、不取消 Work/Attention、不关闭批准。

## 4. Typed conditions、身份和创建基线

### 4.1 NEW：闭合 TypeScript 类型

```ts
export type GithubPrMergedCondition = {
  kind: 'github_pr_merged';
  source: {
    provider: 'github';
    host: 'github.com' | string;
    owner: string;
    repo: string;
    number: number;
  };
};

export type CheckNewResultCondition = {
  kind: 'check_new_result';
  source: {
    orchestrator_db: 'local';
    work_id: string;
    task_id: string;
    attempt_id: string;
    check_id: string;
    check_def_version: string;
  };
};

export type WorkCompletedCondition = {
  kind: 'work_completed';
  source: {
    prerequisite_work_id: string;
    dependency_revision: number;
  };
};

export type WaitCondition =
  | GithubPrMergedCondition
  | CheckNewResultCondition
  | WorkCompletedCondition;

export type PrBaseline = {
  provider: 'github'; host: string; owner: string; repo: string; number: number;
  state:'OPEN'|'CLOSED'|'MERGED'; merged_at:string|null; updated_at:string; observed_at:number;
};
export type CheckBaseline = {
  attempt_id: string; check_id: string; check_def_version: string;
  result_set_version: number; observed_at: number | null;
};
export type WorkBaseline = {
  prerequisite_work_id: string; dependency_revision: number;
  work_revision: number; state: Work['state']; observed_at: number;
};
export type WaitBaseline = PrBaseline | CheckBaseline | WorkBaseline;
export type WaitBaselineSnapshot<B extends WaitBaseline = WaitBaseline> = {
  baseline:B;
  baseline_generation:number;
  fingerprint:string;
  established_at:number;
};
```

`host/owner/repo` 在服务端做 trim、host lower-case、GitHub owner/repo case-insensitive canonicalization；`number` 必须为正安全整数。不得仅保存 URL。`source_identity` 分别为：

```ts
{ provider:'github', host, owner, repo, number }
{ orchestrator_db:'local', work_id, task_id, attempt_id, check_id, check_def_version }
{ prerequisite_work_id, dependency_revision }
```

### 4.2 NEW：创建输入与预授权快照

```ts
export type WaitDispositionInput =
  | { kind: 'redecide' }
  | {
      kind: 'authorized_resume';
      authorization: {
        consumer_owner: 'extension' | 'orchestrator';
        approval_id: string;
        target_version: string;
        approved_effect: 'answer_blocked_request' | 'resume_checkpoint';
        work_revision: number;
        attention_revision: number;
        attempt_id: string;
        checkpoint_reference: string;
        execution_owner: string;
        expires_at: number;
      };
    };

export type CreateWaitInput = {
  work_id: string;
  item_id: string;
  condition: WaitCondition;
  deadline_at: number;
  disposition?: WaitDispositionInput; // omitted means {kind:'redecide'}
  transient_budget?: number;          // omitted means 3; integer 1..3
};
```

创建规则：
创建 route/service 先调用 `adapter.establishBaseline`，再把 snapshot 交给同步 store mutation；外部 IO 不在 SQLite transaction 中：
`createWait(db,input,{actor,adapters,mailbox,now,signal}) → establishBaseline → 从显式 mailbox DB 验证 target/receipt → createConditionWait(db,input,{actor,baseline,now})`。


1. `deadline_at > now`; 无 deadline 拒绝。建议轮询间隔为 5 分钟，但第一次 `next_check_at = min(now + interval, deadline_at)`；内部事件可在安全接收后提前置为 due，不另建 scheduler。
2. Work 必须存在且为 `active`; item 必须为该 Work 的现有 open/applying责任，且当前 `contract_revision == work.revision`。
3. 服务端 actor 必须存在并等于 `work.contract.decision_owner`; input 不含 actor/owner。
4. source adapter 在 INSERT 前取得 `WaitBaselineSnapshot`。创建 row 时 `baseline_json=canonicalJson(baseline)`、`baseline_generation=baseline_generation`、`baseline_established_at=established_at`、`source_generation=baseline_generation`, `observed_json=canonicalJson(baseline)`, `observed_fingerprint=fingerprint`, `observed_generation=1`, `last_observed_at=last_confirmed_at=established_at`；`created_at` 在此 sample 之后取得并检验 `>= established_at`。若 PR 已合并、Work 已完成，或创建时已有结果，基线记录当前事实并开始观察；**创建前事实绝不立即 ready**。
5. `authorized_resume` 必须在创建时从传入的 mailbox DB 读取完全相同 target/receipt scope：未过期、尚未消费/关闭/撤销，target version、Work/Attention revision、attempt、checkpoint、effect、execution owner 全相等，且批准明确写的是“该 condition 成立后执行该确切 effect”。`authorization_json` 只是已验证授权标识与精确范围的审计快照，绝不是 target/receipt 的权威来源。普通 ack/defer、历史人工批准、`scoped_auto` 标签、条件结果或模型建议都不构成授权。验证失败则整个 create 拒绝；不得静默降级成 auto。调用方可明确改用 `redecide` 重试。
6. 插入 wait 和 `wait.created` outbox 必须同一 immediate transaction；source baseline 是 transaction 之前的外部读，入库前再次验证本地 Work/item revision。创建语义以 adapter 取得的 snapshot 为线性化基线：其后 provider 返回 `mergedAt > established_at` 才 ready；若 PR 恰在 snapshot 与 INSERT 之间合并，这仍是相对该基线的后续变化。若 provider timestamp 不能证明先后则保持 watching/unknown 并人工核查，不能猜。check/Work 使用单调 source version，因此下一观察的严格较大版本可确定地捕获。

### 4.3 NEW：显式 dependency edge 前置条件

Work complete 条件不能只凭两个 Work ID 推断关系。本期不建通用 DAG；单用途 prerequisite edge 由 control schema v7 与同一 B-SCHEMA owner 持久化，冻结接口为：

```ts
export type WorkDependencyEdge = {
  work_id: string;
  prerequisite_work_id: string;
  revision: number;
  state: 'active' | 'revoked';
  created_by: string;
  created_at: number;
};

export function getActiveDependencyEdge(
  db: Database,
  workId: string,
  prerequisiteWorkId: string,
): WorkDependencyEdge | null;

export function createWorkDependency(
  db:Database,
  input:{ work_id:string; prerequisite_work_id:string; actor:string; now?:number },
):WorkDependencyEdge;

export function revokeWorkDependency(
  db:Database,
  workId:string,
  prerequisiteWorkId:string,
  expectedRevision:number,
  input:{ actor:string; reason:string; now?:number },
):WorkDependencyEdge;
```

两者只由 control owner 实现：可信 actor 必须等于 dependent Work 当前 decision owner；create/revoke 均以 immediate CAS transaction 增 revision，并在同事务发包含完整 edge snapshot 的 `work.dependency_created` / `work.dependency_revoked` outbox。重复 active create、stale revoke、owner 不符必须 typed conflict/permission error，不能静默成功。

wait 创建时必须存在 `state:'active'` edge，并把 `revision` 写进 condition；观察时 revision/state 变化是 `unavailable(configuration)`，不是 ready。该 edge 只是“允许等待此依赖”的关系，不拥有 Work 生命周期，也不自动启动后继 Work。edge 的具体持久化 owner 必须是 control schema v7 同一 owner；不得塞进 management alias/handoff，因为它们当前不代表依赖。

## 5. 等待类型、观察结果和复制即用 API

### 5.1 NEW：domain 类型

```ts
export type WaitState =
  | 'watching' | 'ready' | 'unavailable' | 'expired' | 'cancelled';

export type WaitErrorKind =
  | 'transient' | 'rate_limited' | 'permission_denied'
  | 'unsupported_provider' | 'configuration' | 'invalid_response'
  | 'identity_mismatch' | 'source_missing' | 'unknown';

export type WaitResumeGrant = Extract<WaitDispositionInput,
  {kind:'authorized_resume'}>['authorization'];

export type WaitDispositionState =
  | 'pending' | 'redecision_recorded' | 'dispatching' | 'dispatched'
  | 'effect_succeeded' | 'effect_failed' | 'effect_unknown';

export type ConditionWait = {
  wait_id: string; work_id: string; item_id: string;
  condition: WaitCondition;
  source_identity: Record<string, unknown>;
  baseline_established_at: number;
  baseline: WaitBaseline; baseline_generation: number; source_generation:number;
  observed: Record<string, unknown> | null;
  observed_fingerprint: string | null;
  observed_generation: number; unchanged_count: number;
  last_observed_at: number | null; last_confirmed_at: number | null;
  state: WaitState; state_reason: string | null;
  ready_at: number | null; ready_observation_fingerprint: string | null;
  deadline_at: number; next_check_at: number | null;
  transient_failures: number; transient_budget: number;
  last_error_kind: WaitErrorKind | null; last_error_detail: string | null;
  retry_after_at: number | null;
  version: number; actor: string; decision_owner: string;
  disposition: 'redecide' | 'authorized_resume';
  resume_grant: WaitResumeGrant | null;
  disposition_state: WaitDispositionState | null;
  disposition_claim_id: string | null; dispatch_id: string | null;
  disposition_detail: Record<string,unknown> | null;
  disposition_at: number | null; effect_observed_at: number | null;
  created_at: number; updated_at: number;
};

export type WaitObservation =
  | { kind:'same'; observed:Record<string,unknown>; fingerprint:string; source_generation:number; observed_at:number }
  | { kind:'changed_not_ready'; observed:Record<string,unknown>; fingerprint:string; source_generation:number; observed_at:number }
  | { kind:'ready'; observed:Record<string,unknown>; fingerprint:string; source_generation:number; observed_at:number }
  | { kind:'error'; error_kind:WaitErrorKind; detail:string; observed_at:number; retry_after_at?:number };
```

### 5.2 NEW：control store API（同步、事务边界明确）

```ts
export function createConditionWait(
  db: Database,
  input: CreateWaitInput,
  context: { actor:string; baseline:WaitBaselineSnapshot; now?:number },
): ConditionWait;

export function cancelConditionWait(
  db: Database,
  waitId: string,
  expectedVersion: number,
  context: { actor:string; reason:string; now?:number },
): ConditionWait;

export function getConditionWait(
  db: Database,
  waitId: string,
): ConditionWait | null;

export function listConditionWaits(
  db: Database,
  filter?: { work_id?:string; item_id?:string; state?:WaitState; limit?:number },
): ConditionWait[];

export function listDueConditionWaits(
  db: Database,
  now:number,
  limit:number,
): ConditionWait[];

export function observeConditionWait(
  db: Database,
  waitId:string,
  expectedVersion:number,
  observation:WaitObservation,
  schedule:{ next_check_at:number|null },
  now?:number,
): { wait:ConditionWait; became_ready:boolean };

export function expireConditionWait(
  db: Database,
  waitId:string,
  expectedVersion:number,
  reason:'deadline'|'transient_budget_exhausted',
  now?:number,
): ConditionWait;

export function recordWaitRedecision(
  db:Database,
  waitId:string,
  expectedVersion:number,
  input:{ attention_revision:number; reason:string; now?:number },
):ConditionWait;

export function claimWaitDispatch(
  db:Database,
  waitId:string,
  expectedVersion:number,
  claimId:string,
  dispatchId:string,
  now?:number,
):ConditionWait;

export function recordWaitDispatch(
  db:Database,
  waitId:string,
  expectedVersion:number,
  claimId:string,
  result:RecoveryDispatchResult,
  now?:number,
):ConditionWait;

export function recordWaitEffect(
  db:Database,
  waitId:string,
  expectedVersion:number,
  claimId:string,
  effect:{ state:'succeeded'|'failed'|'unknown'; evidence:Record<string,unknown>; observed_at:number },
):ConditionWait;
```

所有 mutation 调用 `ensureControlSchema` 并用 immediate transaction + `WHERE wait_id=? AND version=?`; CAS 失败抛 `ControlError('conflict','stale wait version')`。`cancel` 只有 `watching` 可转，重复取消以当前状态返回 409；ready 之后不能取消来抹除 ready 事实。`observe` 仅允许 `watching`；`expire` 仅允许 `watching`。列表按 `updated_at DESC, wait_id DESC`，默认 limit 100、最大 200。ready/unavailable/expired 首次写 `disposition_state='pending'`；`recordWaitRedecision` 允许 `pending|effect_failed|effect_unknown -> redecision_recorded`，且必须在同一事务已将原 Attention 责任落地。自动执行必须先用随机 `claimId` 和预生成 `dispatchId` CAS `pending -> dispatching`，再执行外部调用，之后仅相同 claim 可写 `dispatched/effect_*`；崩溃后 `dispatching/dispatched` 只能按同 `dispatchId` reconcile，禁止再生成新 dispatch。重复相同 effect evidence 幂等，冲突 evidence fail closed。这样 at-most-once 不只覆盖 ready 状态，也覆盖 ready 后的外部 effect。

### 5.3 NEW：source adapter API

```ts
export type ObserveContext = {
  now:number;
  signal:AbortSignal;
};

export interface WaitSourceAdapter<C extends WaitCondition = WaitCondition,
  B extends WaitBaseline = WaitBaseline> {
  readonly kind:C['kind'];
  establishBaseline(condition:C, ctx:ObserveContext):Promise<WaitBaselineSnapshot<B>>;
  observe(wait:ConditionWait & {condition:C; baseline:B}, ctx:ObserveContext):Promise<WaitObservation>;
}

export type WaitSourceAdapters = {
  github_pr_merged: WaitSourceAdapter<GithubPrMergedCondition,PrBaseline>;
  check_new_result: WaitSourceAdapter<CheckNewResultCondition,CheckBaseline>;
  work_completed: WaitSourceAdapter<WorkCompletedCondition,WorkBaseline>;
};
export async function createWait(
  db:Database,
  input:CreateWaitInput,
  deps:{ actor:string; adapters:WaitSourceAdapters; mailbox:Database; now?:()=>number; signal:AbortSignal },
):Promise<ConditionWait>;

```

Adapters 只观察，不能写 wait、Attention、Work 或启动执行；runner/service 是这些 store mutation 的唯一调用 owner：runner 调用 `observeConditionWait/expireConditionWait`，create service 调用 `createConditionWait`，Web cancel 调用 `cancelConditionWait`，recovery coordinator 调用 disposition/effect APIs。超时使用 AbortSignal，不能留下 detached subprocess。

## 6. 三个生产 source adapter

### 6.1 NEW：GitHub PR merged provider

生产实现使用现有 `CommandExecutor`，但新增独立接口而非修改 `checkPr` 的 anomaly 语义：

```ts
export type GithubPrSnapshot = {
  provider:'github'; host:string; owner:string; repo:string; number:number;
  state:'OPEN'|'CLOSED'|'MERGED'; merged_at:string|null; updated_at:string;
  url:string; observed_at:number;
};

export async function observeGithubPr(
  identity:GithubPrMergedCondition['source'],
  executor:CommandExecutor,
  ctx:ObserveContext,
):Promise<GithubPrSnapshot>;
```

命令必须为参数数组，不拼 shell：

```text
gh pr view <number> --repo <owner>/<repo> --json number,state,mergedAt,updatedAt,url
```

随后必须验证：

1. condition `provider === 'github'`; 首版只实现 host `github.com`。GitHub Enterprise 未实现时返回 `unsupported_provider`，不得把 host 悄悄发给 github.com。
2. 请求使用 condition 中准确 `owner/repo/number`；响应 `number` 必须与输入完全相等。
3. 从响应 `url` 解析出的 provider=`github`、host、owner、repo、number 与规范化 identity 完全相等；这是对 `--repo` 目标的回读验证。任何偏差为 `identity_mismatch`。
4. ready 仅当 `state === 'MERGED'`、`mergedAt` 为合法非空时间，并且 `mergedAt` 严格晚于 baseline 的 `merged_at`（baseline 为 null 时，merged timestamp 必须严格晚于 baseline `observed_at`）。`source_generation` 取 `Date.parse(mergedAt)`；若 baseline 已有 `merged_at`，baseline generation 取其时间，否则取 baseline `observed_at`。semantic fingerprint 只含验证后的 identity、state、mergedAt，不含 `updatedAt`/poll time，因此普通 PR 元数据更新时间不制造实质变化。这确保创建前已合并 PR 不触发。
5. OPEN/CLOSED 且身份有效是 `same` 或 `changed_not_ready`; 在未出现 merge timestamp 前 `source_generation` 保持 baseline generation，不用 `updatedAt`/poll time 前进。CLOSED 不伪装成 source error，也不满足 merged。

`gh` 不存在/凭据或 repo 不可见必须按 stderr/exit 明确分类：认证/授权为 `permission_denied`（直接 unavailable），不可支持 host 为 `unsupported_provider`（直接 unavailable），429/明确临时网络为 transient/rate-limit；无法可靠分类为 `unknown`，不能当“未合并”。错误 detail 必须脱敏且有界，不保存 token/完整 stderr。

### 6.2 NEW：指定检查出现新结果

观察只读 orchestrator DB，条件必须精确匹配 `work_id,task_id,attempt_id,check_id,check_def_version`，并且只允许在 B-ORCH-CHECK-PK 已把 durable key 迁移为 `(work_id,result_set_version,check_id)` 后运行。创建 baseline 保存该 Work 当前最大 `result_set_version`（跨 sample/results；没有则 0）和同一准确 tuple 的最后 `observed_at`；任何 result-set reader 都必须同时带 `work_id`，不得仅按 version 查询。

ready 的必要且充分条件是存在一行：

```text
row.work_id === condition.source.work_id
row.task_id === condition.source.task_id
row.attempt_id === condition.source.attempt_id
row.check_id === condition.source.check_id
row.check_def_version === condition.source.check_def_version
row.result_set_version > baseline.result_set_version
```

且该 `result_set_version` 必须也严格大于已持久化的 `source_generation`；ready observation 的 `source_generation` 就是该 result set version，semantic fingerprint 为 exact identity + result_set_version + status + result fingerprint + evidence ref。只比较 status/fingerprint 不够；相同 `status/fingerprint` 的**新结果集**仍是 `ready`，因为条件是“出现新结果”。反之，旧 attempt、不同定义、不同 check、重复/乱序版本一律 quiet。创建 condition 的 `check_def_version` 必须是非空且不等于 `'unknown'`；来源行 `NULL/'unknown'` 不能证明准确检查定义，按 `invalid_response` 进入 unavailable，而不是与一个模糊 condition 匹配。真实定义变化也不能映射成旧定义结果。

找不到 orchestrator DB/表为 `configuration/source_missing`；SQLite busy 可 transient；permission 为 `permission_denied`；畸形行/重复版本内容冲突为 `invalid_response`。adapter 不运行 `orchestrator.check`，不生成新 sample，也不调用模型。

若运行时检测到旧 PK、nullable/空 `work_id` 或不能证明 B-ORCH-CHECK-PK migration 已完成，adapter 返回 `unavailable(configuration)`；绝不尝试兼容读取或在 adapter 内迁移。

### 6.3 NEW：前置 Work complete

adapter 在同一 control DB 中读取：

- 当前 wait 对应 Work 仍存在；
- `getActiveDependencyEdge(work_id, prerequisite_work_id)` 仍是创建时 `dependency_revision`；
- prerequisite `control_works` 存在。

ready 仅当 prerequisite 当前 `state === 'completed'`，其当前 `revision > baseline.work_revision` 且严格大于持久 `source_generation`，并在 control DB 的 `control_outbox` 中有同一 `entity_id=prerequisite_work_id`、`work_id=prerequisite_work_id`、`entity_version=revision`、`kind='work.completed'` 的权威 transition。adapter 必须解析 `payload` 为对象，用 `src/control/outbox.ts` 导出的同一 `canonicalJson` 规则计算 `SHA-256(canonicalJson(payload))` 并与该 row 的 `payload_hash` 完全相等；随后要求 `payload.work.work_id === prerequisite_work_id`、`payload.work.revision === entity_version === prerequisite revision`、`payload.work.state === 'completed'`。event 的 producer/entity/version/kind 与 payload 任一不一致、payload 畸形或 hash 不符均为 `invalid_response`，绝不 ready；实现应复用 control owner 导出的 shared payload verifier，不复制第二套 canonical/hash 算法。ready observation 的 `source_generation` 是当前 Work revision，semantic fingerprint 为 dependency identity/revision + prerequisite work/revision/state + completion event ID。`stopped`、management `ended_ok`/archive、session/runner exit、Attention resolved、单个检查 pass 都不是 completed。重复 `work.completed` 事件或乱序旧 revision 不再推进。

Outbox identity 验证还必须读取同库 `control_identity.producer_id`，要求 event row 的 `producer_id` 等于它，且 `event_id === SHA-256(producer_id + '\0' + entity_id + '\0' + String(entity_version) + '\0' + kind)`；`item_id` 必须为 NULL（Work event），不存在多条相同 identity 的不同 payload。此为 `enqueueControlEvent` 的字节级 identity 算法；不要只信列名相同。任何 field/hash/identity 验证失败不视为可恢复的“尚未完成”，而是 `invalid_response` 并保留责任。

Shared verifier 的 copyable interface 归 B-SCHEMA/outbox owner：

```ts
export type VerifiedControlOutboxEvent = {
  event_id:string; producer_id:string; entity_id:string; entity_version:number;
  kind:string; work_id:string|null; item_id:string|null;
  payload:Record<string,unknown>; payload_hash:string;
};

export function verifyControlOutboxEvent(
  db:Database,
  row:Record<string,unknown>,
):VerifiedControlOutboxEvent;
```

它执行上述 canonical payload hash、control producer、event ID 和 envelope 类型/identity 校验；projection 与 B-WORK 必须共同调用它。返回前不得宽松 coercion string/number/null；失败抛 typed `invalid_response`，不能返回未经验证的 payload。
**当前源码没有明确且独立的 Work completion writer；在该 writer 和 transition contract 实现前，本 adapter 必须返回 `unavailable(configuration)`，不得通过直写 SQL、management archive 或 inference 造出完成。** 合法 writer 的冻结签名是 `completeWork(db:Database, workId:string, expectedRevision:number, input:{actor:string; evidence:Record<string,unknown>; now?:number}):Work`：只允许 control owner 在 Work `active`、actor 等于当前 decision owner、所有 human acceptance 与剩余 Attention/effect responsibility 已关闭且 evidence 可绑定时 CAS `active -> completed`，revision 加 1，并在同事务发 `work.completed`。否则抛 blocked/conflict；这是 §12 的真实实施前置条件。

## 7. 状态机、幂等、错误与 outbox

### 7.1 NEW：唯一状态转换

```text
watching --ready observation----------------------> ready
watching --permanent source failure---------------> unavailable
watching --deadline-------------------------------> expired
watching --transient count reaches budget---------> expired
watching --authorized owner cancellation----------> cancelled
```

等待主状态不可逆。`ready` 转换用 CAS 且必须在同一事务固定 `ready_at`、`ready_observation_fingerprint` 和新的 `source_generation`; `became_ready` 仅第一次为 true。后续重复、乱序或并发观察因 state/version 不匹配不得再 dispatch。相同事件重放只能得到当前状态，不能产生第二个 ready action。ready/unavailable/expired 后另由 `disposition_state` 跟踪回流/效果；它不改变等待条件的主状态。只有 `ready` 可进入授权自动 dispatch；`unavailable/expired` 的 `pending` 必须走 `recordWaitRedecision`，永不自动执行。

### 7.2 NEW：观察算法

对每个 due wait：

1. 若 `now >= deadline_at`，不访问 source，CAS `expired(deadline)`。
2. 调 source adapter，受单项 timeout/AbortSignal 限制。
3. `same`: 校验 fingerprint 且 `source_generation === 当前持久 source_generation`；`version+1`, `unchanged_count+1`, 更新 observed/last_observed/last_confirmed，成功使 transient count/error/retry-after 清零。若 `now+5m >= deadline_at` 则下一状态直接 expired(deadline)，否则 `next_check_at=now+5m`；不得降低或无依据提高 source/observed generation，不产生 Attention、不通知。若 fingerprint 相同但 source generation 增长（例如新检查结果内容相同），不能归入 same，必须按该 condition 的规则成为 `ready` 或 `changed_not_ready`。
4. `changed_not_ready`: 要求 `source_generation >= 当前 source_generation`；`version+1`, semantic fingerprint 真变化时 `observed_generation+1`, `unchanged_count=0`，更新 snapshot/fingerprint/confirmed 和 source high-water，成功使 transient count/error/retry-after 清零。若 `now+5m >= deadline_at` 则直接 expired(deadline)，否则 `next_check_at=now+5m`；不产生人类待办/通知。相同 fingerprint 且相同 source generation，即使 poll 时间更新仍归入 `same`。
5. `ready`: 要求 observation source generation 严格大于 baseline 和当前持久 high-water；随后单次 CAS `ready`; 不直接执行。
6. error:
   - `permission_denied|unsupported_provider|configuration|invalid_response|identity_mismatch|source_missing` 是 permanent，立即 `unavailable`；保留最后成功 snapshot/time。
   - `transient|rate_limited|unknown` 增加持久 `transient_failures`。计数达到 `transient_budget` 时 `expired(transient_budget_exhausted)`；否则保留 watching。
   - `retry_after_at = min(valid provider retry-after, deadline_at)`；没有可信提示时用有界退避 `min(5m * 2^(failures-1), 30m)` 加确定性 wait-id jitter；`next_check_at = retry_after_at` 且两者不得晚于 deadline。provider 提示或退避若落到/超过 deadline，立即 expired，不安排一个永远不会运行的检查。
7. observer/program crash 在 CAS 前不产生变化；CAS 后 outbox 与 row 同事务，因此重跑安全。

默认 `transient_budget=3`，表示连续可重试失败的最大次数；默认配置下第三次失败即停止观察，不再安排第四次。显式收紧为 1 或 2 时分别在该次数停止；不能超过 3。成功观察归零但历史 error 可由 outbox/audit 查询。错误绝不等价于“条件未变”或“已满足”。

### 7.3 NEW：outbox event 名称

每个 mutation 在同一 control transaction 调 `enqueueControlEvent`：`entity_id=wait_id`, `entity_version=wait.version`, `work_id`, `item_id`, payload `{wait}`。

冻结名称：

- `wait.created`
- `wait.observed`（含 same 与 changed-not-ready；下游不得据此打断）
- `wait.observation_failed`
- `wait.ready`
- `wait.unavailable`
- `wait.expired`
- `wait.cancelled`
- `wait.disposition_redecision`（`recordWaitRedecision`）
- `wait.disposition_claimed`（CAS `pending -> dispatching`，尚不表示外部接受）
- `wait.disposition_dispatched`（外部返回 accepted）
- `wait.disposition_blocked`（revalidation 或 dispatch rejected/unknown；保留精确原因）
- `wait.effect_observed`（succeeded/failed/unknown，含绑定 evidence）

同 `(producer_id,wait_id,version,kind)` 由现有 outbox 唯一约束去重。同 version 不得发两个不同 payload 的同 kind。投影端按 event ID/hash 去重并按 wait version 单调更新；低版本迟到只记 applied，不回退。`wait.ready` 与 disposition 必须是不同 version，确保“条件成立”和“处理结果”不混淆。

通知 owner 只消费 disposition 后原 Attention 的实质变化：`wait.created/observed/observation_failed` 永不直接通知；`wait.ready/unavailable/expired` 先更新原责任，再由现有 material/urgency规则决定是否提醒。相同 ready fingerprint/同一 Attention material generation 只提醒一次。普通条件成立默认回 Inbox、不主动打断；只有当前可证风险/期限把原项置 Now 时才进入既有聚合 nudge。等待 outbox 与 Attention notification 不得形成双链提醒。

## 8. Ready 后的安全边界与恢复

### 8.1 NEW：统一 revalidation 结果

```ts
export type ReadyDisposition =
  | { kind:'redecide'; reason:string; item_id:string; attention_revision:number }
  | { kind:'answer_live_request'; consumer_owner:'extension'; approval_id:string; target_version:string }
  | { kind:'resume_checkpoint'; stable_id:string; runtime:'pi'|'omp'; checkpoint_reference:string; approval_id:string; target_version:string }
  | { kind:'blocked'; reason:
      'stale_target'|'stale_contract'|'stale_evidence'|'permission_denied'|
      'budget_exhausted'|'approval_expired'|'approval_consumed'|'effect_unknown'|
      'process_alive'|'liveness_unknown'|'checkpoint_invalid'|
      'runtime_unsupported'|'execution_owner_mismatch'|'capability_unavailable' };

export function revalidateReadyWait(
  control:Database,
  mailbox:Database,
  ledger:Database|null,
  wait:ConditionWait,
  context:{ actor:string; actor_source:'server'; now:number },
):ReadyDisposition;
```

每次 ready 处理、每次执行尝试前都必须重新读取并验证；尤其在 `claimWaitDispatch` 的 CAS **紧前**，必须从传入的 mailbox DB 重新读取 target 与 receipt（不得信任 `authorization_json`、先前对象或缓存），再完成以下核查：

1. wait 仍为精确 ready version/fingerprint，item/work binding 未变；
2. Work 仍 active，目标/Contract revision/范围/allowed effects/human-only effects/stop conditions 未改变；
3. source evidence 仍绑定准确 identity/generation，未撤销/过期/矛盾；
4. `wait.actor`/`decision_owner` 与当前 Contract owner 一致；人类 write route 的 actor 必须来自 server actor binding。若是此前精确授权的自动 effect，maintenance 只携带固定 service actor，并必须以 `resume_grant.execution_owner`、mailbox target/receipt 和 scope 证明执行权；service actor 不能替代或改写 decision owner；客户端不得提供或覆盖任一 identity；
5. Work retry/deadline/cost budget与执行链 budget 均有余量；等待 transient budget 不是执行预算；
6. approval target 存在、target version 相等、未过期、未消费/closed/revoked，并明确覆盖 exact post-condition effect、attempt、checkpoint；
7. 已发生/unknown effect 先 reconcile；任何 `unknown` 禁止 replay；
8. session liveness 是 live/terminated/unknown 的可信判定，不以租约/PID 缺失单独证明 terminated；
9. checkpoint 来自当前 attempt、内容/引用仍有效，运行器声明相应能力；
10. effect observer 已登记，能够区分 command accepted 与真实结果。

任一失败都不得执行；在同一 control transaction 写 `wait.disposition_blocked`、更新 disposition detail，并通过 `recordWaitRedecision` 把原责任恢复为人类 re-decision/核查。条件结果自身永不授权。人类动作 actor 只能来自与创建 route 相同的服务端可信绑定；maintenance service identity 只能使用创建前已固定的 exact grant，不能冒充 decision owner 或生成新同意。

### 8.2 默认：human re-decision

`disposition='redecide'` 或任何 auto revalidation 失败时：

- 原 `item_id` 是唯一责任链。实现应 CAS 更新/重开该 Attention（或在原项不可合法重开时创建**同 Work 明确关联的当前 Attention revision**），证据含 wait ID、ready/unavailable/expired 原因、最后确认、source snapshot 和需要重新决定的原因。
- 不创建 Work/Todo/attempt，不把 waiting 自身计入人类待办。只有 disposition 阶段使原 Attention 回到 Inbox/Now；紧迫性仍由可证风险/期限决定。
- stale consent 不迁移。用户后续决定必须走现有 Attention material fingerprint、actor、mailbox target/version 与 receipt 流程。

### 8.3 活会话 blocked ask（B07）

- 若 preauthorization 的 exact effect 是 `answer_blocked_request`，且 adapter-owned `runtime_decisions`、有效 ownership lease、live handle、同 request ID、`SessionHandle.answer` capability、mailbox target/version 全部仍匹配，则只走现有 `writeHumanAnswer`/consumer 语义；实际 answer 由 `AdapterService.tick()` 消费并调用 `handle.answer`。HTTP/observer 不直接伪造“已回答”。
- 普通 ledger Q1 没有已注册的 mailbox consumer 时，只返回 `/api/jump/:request_uid` 或 `/api/jump-session/:stable_id` 的现场入口，由人回答。不得把 ack 当 answer。
- 会话 live 且并非 blocked on matching request 时，展示状态/跳转，不启动第二进程。已知 live 无“接受风险继续”的旁路。

### 8.4 stopped local pi/omp checkpoint resume（B08）

自动 resume 仅允许全部成立：

1. 创建 wait **之前**已有 `resume_checkpoint` 精确授权；ready 时仍有效且未消费；
2. 执行 owner、stable/session identity、attempt、provider/model（若 target 固定）、cwd/repo、contract revision 与 authorization 完全相同；
3. 有独立的 terminated 证据；liveness unknown 不算 terminated；
4. checkpoint reference 属于该 attempt 且通过 runtime-specific validity probe；字符串非空不够；
5. runtime 是已验收的本地 pi/omp，且 capability 明确支持该 checkpoint；remote、orchestrator-owned generic path、其他 runtime 拒绝；
6. 对已确认和 unknown external effects 完成 reconcile，保证不会从头重放；
7. 当前权限与执行预算允许 exact effect，且 effect observer/result deadline 已建立。

现有 `resumeSession(db, stableId)` 只检查 local/runtime/session/cwd/PID 并返回 cmux launch acceptance，**不能单独用于此自动路径**。实现必须新增 Work-aware wrapper：

```ts
export type RecoveryDispatchResult =
  | { state:'accepted'; dispatch_id:string; accepted_at:number }
  | { state:'rejected'|'unknown'; reason:string; dispatch_id?:string };

export async function dispatchAuthorizedRecovery(
  input:{ wait:ConditionWait; disposition:Extract<ReadyDisposition,{kind:'resume_checkpoint'}>; result_deadline_at:number },
  deps:{ ledger:Database; executor:ResumeExecutor; processProbe:ProcessProbe },
):Promise<RecoveryDispatchResult>;

export async function observeRecoveryEffect(
  dispatchId:string,
  signal:AbortSignal,
):Promise<{ state:'succeeded'|'failed'|'unknown'; evidence:Record<string,unknown>; observed_at:number }>;
```

`result_deadline_at` 必须来自已有批准/Contract/执行核查期限的最早值，且晚于 dispatch 时刻；不是无限等待。`accepted` 只写 dispatch/Attention `applying`，不能写 succeeded/Work completed。只有绑定 dispatch/attempt/checkpoint 的真实 runtime event、检查结果或明确 effect observation 才写 `wait.effect_observed` 并走现有 receipt/effect projection。超时或来源不明为 `unknown`，保留责任，先核查，绝不自动重放。

### 8.5 unsupported/unknown（B09）

恢复 capability 的 read model 必须是三态，而不是只用当前 boolean：

```ts
export type WaitRecoveryCapability =
  | { state:'available'; action:'answer_live_request'|'resume_checkpoint' }
  | { state:'unsupported'; reason:string; jump_url:string|null }
  | { state:'unknown'; reason:string; jump_url:string|null };
```

只有 `available` 渲染对应 Answer/Resume。`unsupported` 显示不支持和人工出口；`unknown` 显示待核查并只允许 jump/reconcile。隐藏按钮不能被直接 POST 绕过：服务端同样 revalidate 后 fail-closed。

## 9. Maintenance runner：有界且不饿死 nudge

### 9.1 NEW：runner API

```ts
export type ObserveWaitsResult = {
  claimed:number; observed:number; ready:number;
  unavailable:number; expired:number; conflicted:number;
  timed_out:number; duration_ms:number;
};

export async function observeDueWaits(
  deps:{
    controlPath:string;
    orchestratorPath:string;
    ledgerPath:string;
    mailboxPath:string;
    adapters:WaitSourceAdapters;
    now?:()=>number;
  },
  options?:{
    batchSize?:number;       // default 20, max 50
    runBudgetMs?:number;     // default 4000; hard run deadline, outer cleanup grace
    itemTimeoutMs?:number;   // default 2000
  },
):Promise<ObserveWaitsResult>;
```
每轮按 `next_check_at,wait_id` 取有界 batch；control 使用 `openControl(controlPath)`，check adapter 对 `orchestratorPath` 只读打开，recovery/liveness 对 `ledgerPath` 只读打开，ready revalidation 对 `mailboxPath` 打开独立 mailbox DB（target/receipt 每次 claim 紧前重读），所有连接逐轮 `finally close()`。不持 SQLite transaction 跨外部 await。读 row/version → 外部观察 → short CAS transaction。runner 开始时立即创建 run-level `AbortController` 并在 `runBudgetMs` 的**硬 deadline** abort；每次 claim 前必须以 monotonic clock 确认 remaining budget `> 0`，单 item deadline 为 `min(itemTimeoutMs, remaining run budget)` 并链接 run signal。hard deadline 到达后不得再 claim、不得提交迟到 observation/disposition/dispatch，必须 abort 全部 in-flight adapter/child process，等待其 TERM/KILL 与 Promise cleanup 完成后才 return；cleanup 本身由外层 5s process-group deadline 兜底，不能让 late task 延长本轮。新旧 due rows 留待下一周期。单 wait Abort 在 hard deadline 前按 transient error 处理；run deadline abort 只计 `timed_out` 并停止本轮。不得并行无界 spawn；默认并发 2，硬上限 4。内部 Work/check event 可把准确 wait 的 `next_check_at` 提前到 now，但最终评估仍由同一 runner 完成。脚本调用冻结为 `bun run src/waits/cli.ts observe --once`; 该命令只执行一轮、输出单行 `ObserveWaitsResult` JSON，并以非零退出码表示 runner 级失败，不能常驻。


### 9.2 维护脚本接线与已知运营风险

```text
bounded recon（现有 45s process-group 上限）
→ observeDueWaits（独立 process-group hard deadline，总墙钟 ≤5s，失败/timeout 先捕获 status）
→ nudge（无条件继续）
→ watchdog
```

maintenance 为 observer 建立与现有 recon 等价的独立进程组 wrapper：启动时记录 PGID；总墙钟第 4 秒 TERM 整组，第 5 秒仍存活则 KILL 整组并 `wait` 回收，status 记入最终组合退出码。内部 `runBudgetMs` 默认必须留足 TERM/KILL/DB cleanup grace（实现取值 `<=4000ms`，而不是让 5000ms 内部预算再叠加清理时间）；外层从 spawn 到全部 child 回收绝不超过 5s。无论 recon/observer spawn、timeout、非零或 cleanup 失败，都先保存状态而不 `exit`，并继续执行 nudge；最后再组合返回码，因此 nudge progression 不会被前序失败饿死。maintenance 总墙钟 ceiling `<=55s`，不得靠 launchd 合并/延迟重叠。

**现状风险**：launchd 每 60s 启动，而 recon 自身允许 45s，并在 timeout 时 TERM/KILL；脚本随后才运行 nudge/watchdog。真实机器上 recon 已可能超时或吃掉大部分周期。再加 observer 会压缩余量，且 launchd 是否合并/延迟重叠不是正确性保证。因此实施前必须测量 maintenance 全链耗时、确保 observer 总预算和进程组取消生效，并让 nudge 即使 recon/observer 失败仍运行。不能承诺每个外部变化 5 分钟内被观察；source/maintenance 不可用时只显示最后确认时间。

## 10. Web routes、read model 与 UI

### 10.1 NEW：route contracts

所有 mutation 继续经过 exact loopback Host + same-origin；此外 create/cancel 需要 `startWebServer` 注入的可信 `actor`，缺失返回 501。actor/decision owner 不出现在可写 body。GET 只返回经过服务端 actor 可见性策略裁剪的摘要；没有 trusted actor 时不得返回 raw `condition_json`、`observed_json`、authorization、error stderr 或敏感 source identity，返回 501/403 而非客户端自报身份。

```text
POST /api/waits
body: CreateWaitInput
201: { wait: ConditionWait, recovery_capability: WaitRecoveryCapability }
400: typed validation/deadline
403: trusted actor not owner
409: stale work/item, baseline no longer bindable, active_wait_exists, invalid authorization
422: recognized but unsupported source provider/host; wait is not created
501: no server actor binding configured

GET /api/waits?work_id=&item_id=&state=&limit=
200: { items: ConditionWaitReadModel[] }

GET /api/waits/:wait_id
200: ConditionWaitReadModel
404: not_found

POST /api/waits/:wait_id/cancel
body: { expected_version:number, reason:string }
200: { wait: ConditionWait }
409: stale/terminal

POST /api/waits/resume-grant
body: { work_id, item_id, condition, deadline_at, stable_id, transient_budget? }   // 仅此白名单；其余字段一律 400
201: { wait: ConditionWait(authorized_resume), recovery_capability: WaitRecoveryCapability }
400: typed validation；或任一 server-derived 字段出现在 body（checkpoint/grant/attempt/execution owner/actor）→ code:server_derived_field
403: trusted actor not owner，或 Work scope 不允许 resume_checkpoint 自动 effect
409: checkpoint_unavailable（liveness unknown / checkpoint 缺失或无效）、stale work/item、active_wait_exists、baseline no longer bindable、invalid authorization
422: recognized but unsupported source provider/host
501: no server actor binding configured
503: condition waits disabled（同 POST /api/waits 的 §14.1 gate）
```

不得提供 `POST ready`、客户端 observation、客户端 resume disposition 或 override actor 的 route。observer/recovery 是 server internal API。`POST /api/waits/resume-grant` 不是客户端 resume disposition：它只记录 decision owner「条件成立后恢复此 checkpoint」的同意；server 以 `createResumeGrant` 走与 wait create 相同的 owner/Work/item preflight，自行调用 runtime checkpoint probe 钉住 checkpoint 与 `checkpoint_reference`，生成 attempt，并固定 `execution_owner` 为 maintenance service actor，然后以该 grant 创建 `authorized_resume` wait。wait 创建失败时关闭刚钉住的 grant（已有未结算 wait 绑定同一 target version 时除外）。执行只由 maintenance runner 在 ready 后经 §8.1 复核发起；Web 从不直接 resume。

```ts
export type ConditionWaitReadModel = {
  wait:Omit<ConditionWait,'resume_grant'> & { has_resume_grant:boolean };
  condition_summary:string;
  latest_observation:{ summary:string; observed_at:number|null; confirmed_at:number|null };
  schedule:{ next_check_at:number|null; deadline_at:number };
  error:{ kind:WaitErrorKind; detail:string; failures:number; budget:number; retry_after_at:number|null }|null;
  attention:{ item_id:string; current_revision:number; state:AttentionItem['state']; effect_state:AttentionItem['effect_state'] };
  recovery_capability:WaitRecoveryCapability;
  actions:{ cancel:boolean; jump_url:string|null; answer:boolean; resume:boolean };
};
```

`wait` 中的 `condition/source_identity/observed/disposition_detail/last_error_detail` 仍须按 actor 可见性做字段级脱敏；`Omit` 只冻结最小硬边界：`resume_grant` 永不出现在 Web 响应。UI 需要的 effect/target 摘要由 server 派生，不能回传 token、owner credential、完整 stderr 或可重放 checkpoint secret。

### 10.2 NEW：页面行为

- 不增加顶级导航或“Wait queue”。在 Inbox 的默认折叠“跟进”与 Work detail 中展示 waits；waiting 数量不计入待决策 badge。
- 每行显示：准确条件/来源身份、最近确认事实、last confirmed、next check、deadline、error/budget、满足后是“重新判断”还是“已精确授权恢复”。
- watching 且同结果只原位更新时间/计数，不弹通知、不建 Attention。
- ready 默认把原 Attention 带回可判断区；unavailable/expired 提供具名人工出口；cancelled 留历史。
- Answer/Resume 仅由 read-model `actions` 提供，前端不自行从 runtime 字符串推断。unsupported/unknown 禁止渲染 Resume。
- 浏览器刷新必须从 server read model 恢复状态；按钮提交包含 expected wait version。并发冲突显示当前 row，不乐观伪装成功。

## 11. 跨 slice 所有权与 copyable interface freeze

任何实现工单必须遵守以下非重叠边界；共享签名以本文 §§4–10 为准，不允许各 slice 自创名字或 JSON：

| Slice | 唯一 owner / 文件边界 | 交付 | 禁止触碰 |
| --- | --- | --- | --- |
| B-ORCH-CHECK-PK | `src/orchestrator/schema.sql`, `src/orchestrator/store.ts`, `src/orchestrator/anomaly-store.ts` 及其直接 producer/reader focused tests | named prerequisite migration；`(work_id,result_set_version,check_id)` key；required Work ID；所有直接 caller 迁移；collision/legacy migration/read isolation proof | wait adapter、control/Web/maintenance |
| B-SCHEMA | `src/control/types.ts`, `src/control/store.ts`, `src/control/outbox.ts`, `src/control/projection.ts`, 新 `src/waits/create.ts` 及 focused tests | **单一 control owner**：v7 DDL/codecs；全部 control wait mutation/read API 与 `createWait` 外部读取编排（只调用 adapters/mailbox，source-specific IO 留给 adapters）；create/revoke dependency writer；`completeWork`；shared outbox payload verifier；wait/work outbox projection | source-specific IO、Web、maintenance、runtime execution |
| B-PR | 新 `src/waits/sources/github-pr.ts` + focused test | normalized identity、baseline、`gh pr view` verification/error mapping | control mutations、旧 `checkPr` anomaly semantics |
| B-CHECK | 新 `src/waits/sources/check-result.ts` + focused test | 在 B-ORCH-CHECK-PK 完成后使用 exact source identity/key 的 strict-later-generation **只读** adapter | schema/migration、写 orchestrator sample/result、启动 check |
| B-WORK | 新 `src/waits/sources/work-complete.ts` + focused test | read-only exact-edge/completion/outbox payload verification adapter | **所有 control mutation**、dependency DDL/writer、completion writer、projection、management archive 推断、通用 DAG |
| B-RUNNER | 新 `src/waits/runner.ts`、独立 CLI entry、`scripts/maintenance.sh` 接线 | hard run Abort deadline、bounded batch/child cleanup/CAS/error budget/disposition dispatch、observer process-group ≤5s 且 nudge progression | source-specific shell、UI、control schema/mutations |
| B-RECOVERY | 新 `src/waits/recovery.ts`; targeted additions around mailbox/adapters/shared resume | 显式 mailbox DB 的 unified revalidation、live answer/jump、Work-aware authorized recovery + effect proof | generic scheduler、新 runtime、fake capability、control/store/types/outbox/projection |
| B-WEB | `src/web/server.ts`, `src/web/static/app.js`/CSS/HTML as needed | routes/read model/follow-up UI/server gate；向 `createWait`/revalidation 传显式 mailbox DB | condition evaluation、授权推断、control owner 文件 |
| B-VERIFY | focused tests/fixtures only | §13 matrix evidence | production logic、mock-only pass claims |

Integration order：**B-ORCH-CHECK-PK 和 B-SCHEMA 是两个互不重叠的先决 slices**；B-CHECK 必须等待前者的 migration/collision/reader tests，B-WORK 必须等待后者的 dependency/completion/outbox-verifier writer tests。B-PR 可在 frozen interfaces 后并行；B-WORK 永远只读，不能因 writer 未完成而临时接管。B-RUNNER 依赖 B-SCHEMA frozen adapter/store API；B-RECOVERY 依赖 B-SCHEMA ready row/read API 与显式 mailbox DB；B-WEB 最后消费 read model。control 的 store/types/outbox/projection、v7 DDL、wait APIs（含 `src/waits/create.ts`）、dependency create/revoke、`completeWork` 和相关投影只有 B-SCHEMA 可写，任何其他 slice 不得共享编辑。

## 12. Genuine prerequisites / 未决事实（不得编造）

以下不是产品选择空白，而是实施前必须补齐或显式保持 unavailable 的真实先决条件：

1. **Work completion authority**：当前 `control_works` 有 `completed` enum，但未找到独立、明确的合法 completion writer；management closeout 明确不更新它。本文已冻结 `completeWork`，由 B-SCHEMA 实现 control-owned `active -> completed` CAS、验收/剩余责任规则和同事务 `work.completed` outbox；其 focused writer/projection tests 是 B-WORK 的硬依赖，否则 Work condition 保持 unavailable。
2. **Dependency edge activation**：当前 management aliases/handoffs 不是 prerequisite。v7 的 `control_work_dependencies` DDL、`getActiveDependencyEdge` 与可信 owner `createWorkDependency`/`revokeWorkDependency` 都由本文冻结且只归 B-SCHEMA；每次 mutation CAS 增 revision 并同事务发 control outbox。writer focused tests 是 B-WORK 的硬依赖；没有 active edge 时拒绝创建该 condition。
3. **GitHub credentials/host**：真实环境是否安装/auth `gh`、账号是否可读目标 repo、是否需 GitHub Enterprise 尚未验证。首版只能宣称经真实 smoke 验证的 host/provider；其余 unsupported。
4. **Automatic checkpoint validity/effect proof**（已被 checkpoint probe + resume grant 取代）：runtime checkpoint probe（`src/shared/checkpoint.ts` `probeCheckpoint`，按 runtime 会话文件逐字节钉住 file/last_entry_id/byte_len）与 resume grant（`createResumeGrant` → `POST /api/waits/resume-grant`）已实现，精确「checkpoint probe → launch（`dispatchAuthorizedRecovery`）→ 效果回读（`observeRecoveryEffect`）」链已由真实 pi 验收（B08 live）。原“该 adapter 未实现前默认 redecide、一律 fail-closed”的表述不再适用：有效 grant + 通过 probe 的 checkpoint 可自动恢复；缺 grant、probe 失败或复核失败仍默认 redecide，UI 仍不渲染 Resume 按钮（`actions.resume` 恒为 false）。**B08 效果规则（当前实现，待 operator 决策）**：dispatch 后 `RECOVERY_EFFECT_WINDOW_MS`（120s）内必须同时观察到同一 runtime session 的新 `session_started` **且** 被钉住的会话文件增长超过 `byte_len`，才记 succeeded；否则记 `unknown`（fail-safe：原项重开待核查，绝不伪成功、绝不重放）。已知后果：`pi --session <file>` 启动时不追加内容，无人值守时真实恢复会落为 `unknown`，除非 agent 或人在窗口内写入。备选规则——接受 `session_started` + checkpoint 未变 + 新 incarnation liveness，或由恢复后的 runtime 追加 marker entry——须 operator 拍板后再改，拍板前不得放宽。
5. **Liveness unknown**：已统一（B09 修复）：generic `inspectResume` 与 wait recovery 共用同一保守三态证据；无权威终止（liveness unknown）一律非 resumable。checkpoint probe 已存在，故该门不再是“无 probe 即 unknown”，而是“无权威终止或 probe 判无效即非 resumable”；Sessions Resume 与 `POST /api/resume-session` 仍只在同一 gate 判 resumable 时调用 executor。B08 的自动恢复另需 §12.4 的 grant 与效果规则。
6. **Trusted actor deployment**：Web 只有配置了 server-side actor 才能写 wait。loopback/same-origin、消息作者或客户端 body 都不能补洞。

这些先决条件不影响“条件成立 → 原项重新交给人判断”的 PR/check实现，但会限制 Work condition或自动恢复。不得因此缩减 B01–B09 验收；未观测就是未通过。

## 13. B01–B09 验收矩阵与证据等级

除单元测试外，必须使用真实临时 SQLite/control+orchestrator DB、真实 spool/outbox ingest、真实浏览器。模拟 executor/runtime 只证明 deterministic rule，不证明外部效果。每项保留 wait row/version、outbox event IDs、Attention revision、命令/运行时回执和 effect evidence。

| ID | 场景与设置 | 必须断言 | 所需证据 |
| --- | --- | --- | --- |
| B01 | 同一 PR/check/Work snapshot 连续观察；跨维护重启 | `unchanged_count` 增，generation/Attention/通知不增；没有模型调用 | temp DB + runner 两轮 + spool 投影；浏览器跟进原位更新 |
| B02 | condition ready，同一 source event 重放、并发两个 observer、乱序旧版本；两个不同 Work 各产生同 version/check ID 的真实 check result | B-ORCH-CHECK-PK 迁移后两者可同时持久化且 reader 各只见本 Work；每个 wait 只有一次 `watching -> ready`、一个 `wait.ready`、一个 disposition；无 Work/Todo | legacy/new orchestrator SQLite migration + collision/reader tests，real SQLite CAS/outbox/ledger ingest；查询唯一 event/version |
| B03 | source 已变化后才创建 wait，再喂旧“变化”及同代结果；baseline sample 时间早于 INSERT 时间 | `baseline_established_at` 保留真实 sample 时间并满足 DDL；旧 event/≤baseline generation quiet；只严格更新的事实可 ready；Work completion event payload/hash/identity 错误只能 `invalid_response` | 三 source baseline fixture；PR 使用受控真实 read（见下）；outbox corruption/identity tests |
| B04 | 401/403、unsupported host、429 Retry-After、SQLite busy、invalid JSON、unknown error | permanent→unavailable；transient persisted/retry bounded；错误不写 same/ready，保留 last confirmed | deterministic injected classification + controlled real provider permission/rate-limit/read evidence where credentials allow；未真实观测的类别逐项标未通过，不能由 fake 代替；UI 显示分类 |
| B05 | deadline 到达；连续第三次 transient；每次之间重启；另一个 adapter/child 在 run hard deadline 仍运行或返回迟到结果 | 停止观察、expired reason准确、计数不重置；run abort 后无迟到 CAS/dispatch，整组 child ≤5s 清理，原项有人工出口，recon/observer 失败后 nudge 仍运行 | temp DB reopened between runs + real maintenance process-group timeout/descendant harness with bounded wall clock |
| B06 | ready 后 Work revision/owner/approval expiry/target version/evidence或budget变化；claim 前 mailbox target/receipt 被消费或撤销 | 显式 mailbox DB 紧前重读后 revalidation blocked→redecide；不消费旧 target、不启动进程；stale consent不能迁移到新 wait | separate mailbox/control real SQLite + outbox + browser actions absent |
| B07 | adapter live blocked ask；另一个普通 ledger Q1；另一个 live non-blocked session | 第一条仅经 mailbox→AdapterService→`SessionHandle.answer`; 第二条仅 jump；都不 start/resume第二进程 | adapter integration with active handle/lease and real mailbox; browser route; generic resume executor call count 0 |
| B08 | 已有 exact authorization、confirmed terminated、valid checkpoint、budget/contract/effect清晰 | 恢复原入口；launch accepted只显示 applying；随后真实绑定结果才 succeeded；unknown结果不重放 | isolated supported pi/omp runtime integration、真实 checkpoint/launch/runtime event/result evidence；fake runtime/executor 只作回归，不算 B08 pass |
| B09 | runtime unsupported、remote/orchestrator-owned、liveness unknown、checkpoint probe unknown | read model明确 unsupported/unknown；无 Resume；直接 POST 也拒绝；jump/reconcile仍可用 | server+real browser DOM/action check，executor call count 0 |

真实 spool 要求：通过 `enqueueControlEvent` → `publishControlEvents` → test spool ingest/reducer 写入临时 ledger，随后验证 `applied_control_events` 的 event ID/hash、低版本迟到不回退、同 payload 重放不重复；直接查询 `control_outbox` 而不 ingest 只算 store test，不算 B02 端到端证据。

### 13.1 真实 GitHub PR/read smoke 的最小要求

在凭据可用且获得只读许可时，准备测试 repo 中由测试身份控制的 PR，记录准确 `github.com/owner/repo#number`：

1. `gh auth status` 只用于确认能力，输出不得入 artifact；
2. 创建 wait 前读 OPEN baseline；重复 read 证明 B01；
3. 由测试 owner 通过 provider UI/API 在 wait 建立后合并该准确 PR，再读 `number,state,mergedAt,updatedAt,url`，验证 normalized provider/repo/number identity 和 `mergedAt > baseline.observed_at`，只 ready 一次；wait observer 自身仍严格只读，不执行 merge；
4. 另建一个在创建 wait 前已合并的 PR，证明 B03 不触发；若需要后续新条件，必须新 PR/新基线，而不是篡改时间；
5. 用无权限 repo 或隔离凭据（不得破坏现有凭据）验证 permission unavailable；无法安全取得该条件时标记未观测，不以 mock 代替。

若没有 `gh`、只读凭据、可控 repo/PR 或网络，则 external smoke **未执行/未通过**；实现可以通过本地 deterministic tests，但 Phase B §14 的“至少一条真实来源到原项回流链路”发布门槛仍未满足。

### 13.2 真实浏览器与 runtime smoke

浏览器必须启动真实 `startWebServer`（临时 ledger/control 路径和 server-side actor），驱动：创建 wait、折叠跟进、刷新回读、cancel CAS、ready redecision、error/expiry、unsupported/unknown 无按钮、direct POST fail-closed。仅 fetch/DOM snapshot 不能替代浏览器动作验证。

B08 外部 smoke 必须使用隔离的本地 pi/omp session、可验证 checkpoint 和无副作用或可清理的 effect，证明单一恢复进程及 post-launch result。若 runtime 没有 checkpoint validity probe或 effect event，B08 未通过；`cmux new-workspace` 返回 0 不是 pass。

## 14. 发布、关闭与回滚边界

1. migration/schema/API 落地不等于启用。wait 创建入口和 observer 必须有显式 feature/config gate；默认不自动恢复。落地形式：环境变量 `OVERLOAD_CONDITION_WAITS`，仅当值恰为 `"1"` 时启用；未设置、空串或任何其他值均为关闭（默认关）。关闭时 `POST /api/waits` 在解析 body/打开 DB/读 baseline 之前返回 `503 {error:"disabled", code:"condition_waits_disabled"}`；`src/waits/cli.ts observe --once` 不打开任何 DB、不跑 adapter，输出一行 `{"status":"disabled",...}` 并 exit 0（maintenance.sh 照常继续 nudge/watchdog）；GET 列表/详情与 cancel 仍可用。Web server 在启动时读取该变量（改变后需重启 web 服务）；launchd 下可用 `launchctl setenv OVERLOAD_CONDITION_WAITS 1` 后 kickstart 相应服务。
2. Phase B 启用要求 B01–B09 全部有上述等级证据，并至少一条真实 source → wait ready → 原 Attention 回流；B08 只有在所支持 runtime 的真实链路通过后才能对该 capability 启用。
3. 关闭 observer 时，现有 `watching` rows 保留并在 UI 标记观察暂停/最后确认；不自动 ready、cancel 或 resume。再次启用继续持久 budget/deadline，过期项先 expire。
4. schema 7 不做 destructive rollback。旧二进制按既有 newer-schema guard 拒绝写，不允许通过降级跳过期限/批准/效果校验。
5. 本文没有执行任何 B01–B09 测试、外部 PR read、浏览器场景、runtime resume、launchd 修改或生产激活；这些都是后续实现与验收工作。
