# Overload Orchestrator v1 实施计划（v2）

日期：2026-09-02（v2 修订）｜基线：`HEAD=5941de0`（`master` 同点，无在途 diff）｜上游：`/tmp/overload-review/{context,arch,security,code,plan-adversarial}.md`
用户裁定：D1（删 q2 Inbox 区）、D2（resume 仅进程已死）、D3（devbox 与多机规模保留）、D4（编排器为硬边界模块 `src/orchestrator/`），以及 plan-adversarial §4/§5 后的 13 条 owner 决定（按其执行，不再复议）。所有对现有代码的论断带 `file:line`，本轮重新核对。

---

## §0 v2 修订说明（对抗评审逐条处置）

### 对 §2「已证伪或夸大」

| # | 结论 | 处置 |
|---|---|---|
| 1 | claim SQL 自锁 | **已修**。改为「partial unique index 强制 + BEGIN IMMEDIATE 内取最老 queued」，`queued` 不持锁。见 §3.4。 |
| 2 | 「写锁释放」夸大、无 owner/lease | **已修**。引入 `owner_instance` / `lease_expires_at` / `heartbeat_at`，启动前强制 reconciliation。见 §3.5。 |
| 3 | Origin/Host 不构成 caller binding | **已修（改为承认）**。§5.1 明写：gate 是**工作流边界，不是安全边界**；同 UID runner 可 curl loopback、可直写 answers 文件，Overload 无机制可阻止。Origin/Host 降级为 CSRF 卫生。 |
| 4 | devbox 伪造 Now 卡 | **部分修 + 部分反驳**。反驳：伪造卡**不可操作**——答复端在 orchestrator 侧要求 `approval_id` 在自有 `approvals` 有行；无行即跳过且不消费。provenance 已由现有字段呈现：`Q1Row.host`（`src/shared/queries.ts:19,98`）与 `stable_id` 首段（`src/ingest/ingest.ts:249` 构造 `host:runtime:session`），`app.js:64` 的 `sessionLink(row.stable_id)` 已渲染该串。v1 不加字段、不加列。 |
| 5 | 里程碑不独立 | **已修**。§6 重排：M1 用 `repo` 路径作 `cwd`（不依赖 M2 worktree）；`awaiting_human` 在 M3 引入且同期就有 CLI 消费方；web 答复（M4）是 M3 的叠加面而非前提。 |
| 6 | submitted 路径缺失 | **已修**。§3.8 定义 push / PR create / `pr_url` 写入 / CI 轮询 / `gh` 缺失 → `blocked(tool_missing)`。 |
| 7 | failed 发 gate 与终态规则矛盾 | **已修**。新增非终态 `blocked`；`failed` 永不发 gate（§3.3）。 |
| 8 | 预算与 follow-up 无限繁殖 | **已修**。ready 拒绝 → `blocked`（不扣预算，由人决定重跑并重置或放弃）；CI 异常 → 一条 `decision_requested`，人选 rerun/new-task/abandon，**不自动建单**、无 ancestry 机制。 |
| 9 | 并发上限计入非活跃态 | **已修**。上限只计 `starting|running`（§3.4）。 |
| 10 | jump 降级不可接受 | **已修**。runner 经 `cmux new-workspace` 启动（与 `src/shared/resume.ts:40` 同一命令形态），会话取得真实 cmux surface，走既有 jump 链路。见 §3.7。 |
| 11 | worktree 永不清理 | **已修**。`creating` 折进 `starting`（幂等探测）；`overload orch gc --older-than` 供人手动清理，orchestrator 自身每 5 分钟扫一次（见 §3.6）。只删 clean + 终态 + 无活进程者，dirty 只列不删。 |
| 12 | 删 migration 不安全 | **接受**。v1 计划中「删 `dropRetiredColumns`」条目撤销，见 §7。 |

### 对 §3「设计缺陷」表

各行落点：审批信任模型 §5.1；claim §3.4；spawn 崩溃恢复 §3.5；submitted §3.8；failed/blocked §3.3；lease + worktree GC §3.5/§3.6；resume 旁路 §3.10（**如实计入核心改动**）；伪造卡 §0-4；spool 无界 §4.1；follow-up 风暴 §3.8（删自动建单）；`gh` 缺失静默成功 §3.8（改 `blocked(tool_missing)`）。

**另补 SEC-2' 影响面**（v1 写窄了，评审正确）：`targetStableId`（`src/ingest/reducer.ts:27-29`）不止影响 `attachment_observed`。`RECON_EVENTS`（`reducer.ts:7`）经 `reducer.ts:132` 同一函数取目标，随后 `reducer.ts:170-171` 直接 `UPDATE current` 的 `state/queue/q5_reason/origin`。因此 devbox 侧任一 emitter 写 `session_vanished` + `detail.stable_id="local:pi:<uuid>"`，即可把本机会话置为 `vanished`；而 `vanished ∈ SESSION_TERMINALS`（`reducer.ts:6`）且 `reducer.ts:144` 对终态直接 `return`，该会话的投影**从此永久冻结**——这是跨主机的持久拒绝服务，严重度高于 attachment 改写。`turn_hung`/`dead_connection` 则可凭空制造 Now 区卡死卡（`queries.ts:130` 的 `queryHung` 只读 `current.q5_reason`）。

### 对 §5「必须在实施前改的三处」

审批信任模型 → §5.1 重写；状态机与恢复协议 → §3.3 全量转移表 + §3.4/§3.5；submitted 路径与里程碑重排 → §3.8 + §6。

### 本次**删除**的 v1 内容

M6 metrics / `queue_transitions` 读取方（决定 3）；plan gate（决定 2）；CI 异常自动 follow-up（决定 3）；删 `dropRetiredColumns`（决定 4）；`approvals.answer` 双写（改为消费即转移，审计留 `task_events`）。

---

## §1 目标与非目标

### 1.1 v1 做什么

把「一句话任务」变成「一个 PR + 一次人类验收决策」的最小状态机：CLI 建任务 → 独立 worktree 起 `pi` → 采集 evidence → **唯一的 ready gate** → 人批准 → push + PR → 轮询 CI → 终态。只经既有 spool `EventEnvelope` 契约向 Overload 说话。

### 1.2 v1 明确不做

| 不做 | 理由 |
|---|---|
| 自动合并、无人值守高风险动作 | `AGENTS.md` 原则 5；且这是 §5.1 信任模型成立的前提 |
| plan gate | 决定 2。任务输入已是人类意图，再问一次只是多一次打断 |
| 自动 follow-up 任务链 / task ancestry | 决定 3。递归任务风暴的成本远大于收益 |
| metrics / `queue_transitions` 读取方 | 决定 3。不属最小闭环 |
| domain bots / charter / memory / playbook | YAGNI，无样本 |
| 远程 runner | runner 只在本机；devbox 是**采集**支线（D3） |
| 并发 > 4 | 硬上限 4，默认 2 |
| 改 Overload 既有表 | 硬边界 §4.2（`src/shared/resume.ts` 的一处 guard 是**唯一**例外，如实计数于 §3.10） |
| 多操作者 / 网络暴露 | 与 `README.md:5` 一致，不撤销 |

### 1.3 README 非目标必须改写（诚实化）

`README.md:5` 第三条「upstream-agent approval system」在 orchestrator 落地后部分不成立。改为：

> It is not a hosted service or a multi-user control plane. Overload never approves, answers, or resumes an agent it did not launch: the ingest path stays one-way. The optional `src/orchestrator/` module launches and steers its own `pi` children, and human gates for those children surface as ordinary Now decisions. That authority is scoped to processes the orchestrator started. These gates are a **workflow** boundary, not a security boundary: on a single-UID machine any same-UID process can bypass them.

`docs/integrations.md:7` 同步加作用域限定。

---

## §2 orchestrator 前置项（仅三项，其余见「并行独立项」）

只有以下三项是 orchestrator 的**发布前提**（决定 5）。

### 2.1 SEC-1：写接口的 Origin / Host 校验（CSRF 卫生）

在 `src/web/server.ts` 的 `fetch` 入口、四个 POST 分支（`:97` jump、`:105` jump-session、`:110` resume-session、`:118` ack）之前插入统一守卫：POST 请求要求 `Host === "127.0.0.1:<port>"` 且 `Origin === "http://127.0.0.1:<port>"`（缺 `Origin` 亦拒），不匹配 403 且不产生任何副作用。端口取 `options.port ?? DEFAULT_WEB_PORT`（`server.ts:75`、`:11`）。**同时覆盖 GET `/api/*`** 的 `Host` 校验（不覆盖 `/` 与 `/static/`）——`Q1Row.request_uid`（`queries.ts:19,98`）含 `request_id`，DNS rebinding 下的跨站读取会泄露它。

`Origin` 挡跨站表单/fetch，`Host` 挡 DNS rebinding；二者都**不是身份认证**（§5.1）。

**验收**：`src/web/server.test.ts`：(a) 正确头 POST `/api/ack/<uid>` → 200 且 `requests.state='acked'`；(b) `Origin: https://evil.example` → 403 且状态不变；(c) 错误 `Host` → 403；(d) 无 `Origin` → 403；(e) 正确 `Host` 的 GET `/api/q1` → 200，错误 `Host` → 403。

### 2.2 SEC-2'：reducer 中 `detail.stable_id` 的 host 权威

`reducer.ts:27-29` 的 `targetStableId`：若 `detail.stable_id` 首段（`split(":")[0]`）≠ `row.stable_id` 首段，**忽略 `detail.stable_id`，回落 `row.stable_id`**，并写一条 `coverage_gaps`（复用现有表）。该函数是 `applyAttachment`（`reducer.ts:111`）与 `applySessionEvent`（`reducer.ts:132`，含全部 `RECON_EVENTS`）的共同入口，一处修复覆盖两条路径，含 §0 所述的 `vanished` 永久冻结。

**为什么不在 ingest 修**：`parseEnvelope`（`ingest.ts:239-241`）已保证 envelope 的 host/emitter 与 spool 路径一致；缺的是 `detail` 内的跨主体引用，属 reducer 语义层。**验收**：构造 `host=devbox` 的 `session_vanished`，`detail.stable_id="local:pi:x"` → `current` 中 `local:pi:x` 不存在或状态未变、`coverage_gaps` +1；同 host（`devbox:pi:x`）正常生效。attachment 用例同构。

### 2.3 D1：删除 Inbox 的 q2 区，重定义 Done

1. `app.js:102-110` `renderInbox()`：删 `q2Html` 与 `<h3>待收尾</h3>`，只保留 Zombie 分组与 orphaned_request（后者有动作）。删 `state.q2`（`app.js:6`）与取数。
2. `server.ts:83` `/api/summary` 的 `q2` 字段、`:87` `/api/q2` 路由删除；`tile-inbox`（`app.js:34`）改为 zombie + orphaned 计数。
3. `queries.ts:145-147` 删 `queryQ2`；`queryArchive`（`:150-152`）谓词改为 `queue IN ('q2','q4')`。CLI `q2` 子命令（`src/cli/overload.ts:49-53`）删除，`printQ4`（`:54-58`）保留。`src/shared/types.ts:50` 的 `QueueName` 加 `"q4"`（`classifier.ts:64-66` 已实际产出）。

**Done 的新定义**：会话已终结，Overload 不再需要你的注意力；它是审计视图，不是待办。终态 sticky（`reducer.ts:144`）保证进入即不再离开。**验收**：`/api/q2` 返回 404；`/api/archive` 同时含 `q2` 与 `q4` 行。

### 2.4 并行独立项（**不阻塞** orchestrator，各自独立提交）

| 项 | 改动摘要 | 行数 |
|---|---|---|
| I1 dashboard 自动刷新 | `app.js:289` 定义的 `refresh()` 加 15s `setInterval` + `visibilitychange` 立即刷新（回归自 `f5e67b7`） | +6 |
| I2 `busy_timeout` | `src/ingest/schema.sql` 加 `PRAGMA busy_timeout=5000`，并在 `openLedger`（`ingest.ts:86`）与 `server.ts:120` 的可写连接上显式执行（PRAGMA 是连接级） | +5 |
| A2 nudge 改集合 | `nudge.ts:37` 的 `previous === 0 && count > 0` 改为按 `request_uid`/`stable_id` 的集合差；state 文件存当前集合 | +25 |
| spool 读取预算 | `ingest.ts:215` 的 `Buffer.alloc(stat.size-start)` 改 4 MiB 窗口；`parseEnvelope` 前加 64 KiB 行长上限（超限丢弃 + `coverage_gaps`）；`pull.ts` rsync 加 `--max-size=8m` | +30 |
| 文档漂移 | `docs/operations.md:86`、`launchd/README.md:14`（「emits no macOS notifications」已不实）、`docs/integrations.md:7,22-25`（hook 已删的孤儿段）、`README.md:73` 起代码围栏未闭合（全文 ```` ``` ```` 计数为 11，奇数）、`AGENTS.md:29` 加 D2 限定、`docs/contracts/*` 与旧 plan 顶部加「历史文档」标注 | +20/−10 |

---

## §3 编排器架构

### 3.1 进程模型

独立 launchd 作业 `works.earendil.overload.orchestrator`（与现有四个同构，`KeepAlive=true`，`ProcessType=Background`，日志落 `~/.overload/logs/`）。单进程、单事件循环、**5s tick**，无线程、无 worker pool（并发 ≤4 = 最多 4 个受管会话）。

独立进程而非 ingest 模块：(a) 爆炸半径隔离，orchestrator 是唯一持 repo 写权限并起长生命周期子进程的组件；(b) ingest 是无状态 2s 管道，混入有状态服务会让其重启不安全；(c) 它挂掉时可由 recon 的 `source_outage`（`src/pull/pull.ts:36`）报成 incident，Overload 侧零改动即可观测。

### 3.2 数据模型

**`~/.overload/orchestrator.db`（独立文件，0600）**。理由：`initializeLedger`（`ingest.ts:95-101`）每次启动 `db.exec(schema.sql)` + `dropRetiredColumns`（`:104-114`）——这个仓库会做破坏性 DDL，两个进程在同一文件上互不知情地迁移是不可接受的；且独立文件让写锁完全分离，回滚成本为零（`rm` 即可）。代价：无法 join 会话；需要时以 `{readonly:true}` 打开 `ledger.db`（同 `server.ts:61` 模式），单向只读。

```sql
PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS tasks(
  task_id TEXT PRIMARY KEY, title TEXT NOT NULL, repo TEXT NOT NULL, base_ref TEXT NOT NULL,
  worktree TEXT, branch TEXT, state TEXT NOT NULL,
  attempt_id TEXT,                  -- 每次 spawn 前生成并持久化（spawn-before-record 防护）
  owner_instance TEXT,              -- orchestrator 实例 id（启动时 randomUUID）
  lease_expires_at INTEGER, heartbeat_at INTEGER,
  runner_pid INTEGER, runner_boot_id TEXT,   -- 绑定后由 ledger 回填
  retry_budget INTEGER NOT NULL DEFAULT 2,
  stable_id TEXT, pr_url TEXT, blocked_reason TEXT, terminal_reason TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- queued 不持锁；活跃态每 repo 至多一个，由 DB 强制而非查询强制。
CREATE UNIQUE INDEX IF NOT EXISTS tasks_repo_active ON tasks(repo)
  WHERE state IN ('starting','running','awaiting_human','submitted');

CREATE TABLE IF NOT EXISTS task_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at INTEGER NOT NULL,
  from_state TEXT, to_state TEXT NOT NULL, event TEXT NOT NULL, detail TEXT);

CREATE TABLE IF NOT EXISTS approvals(
  approval_id TEXT PRIMARY KEY,     -- 同时是 spool 事件的 request_id
  task_id TEXT NOT NULL, gate TEXT NOT NULL CHECK(gate IN ('ready','ci_anomaly')),
  question TEXT NOT NULL, options TEXT NOT NULL,   -- JSON 白名单
  requested_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, actor TEXT);                -- 'ui' | 'cli'；消费即转移，不双写 answer

CREATE TABLE IF NOT EXISTS spool_seq(id INTEGER PRIMARY KEY CHECK(id=1),
  seq INTEGER NOT NULL, segment INTEGER NOT NULL);
```

无 `worktree_locks` 表：锁即上面的 partial unique index。

### 3.3 状态机（全量转移表）

状态：`queued`、`starting`、`running`、`awaiting_human`、`submitted`、`blocked`、`done`、`failed`、`abandoned`。**终态 = `done | failed | abandoned`**（不再被 tick 触碰，释放活跃锁）；`blocked` **非终态**、占活跃锁、可由人重开；`ready` 不是独立状态，即 `awaiting_human(gate='ready')`（决定 6）。**`evidence_pending` 折进 `running`**：采集是 runner 退出后同一 tick 内的一串有界 git 命令，持久化中间态只增加崩溃窗口；若采集中途死亡，任务仍是 `running` + runner 已死，重启后 reconciliation 重新采集，git 命令幂等。

| 当前态 | 事件 | 新态 | 预算 |
|---|---|---|---|
| queued | `claim`（有容量 ∧ 该 repo 无活跃任务） | starting | — |
| queued | `human_abandon` | abandoned | — |
| starting | `worktree_ok` ∧ `spawn_ok` | running | — |
| starting | `spawn_fail`（cmux/pi 不可执行） | blocked(tool_missing) | — |
| starting | `worktree_fail`（repo 不存在 / 非 git） | failed(repo_gone) | — |
| starting | `bind_timeout`（12 tick ≈60s 内 ledger 无对应会话） | running(-1) 或 blocked | −1 |
| running | `session_bound` | running（回填 `stable_id`/`pid`/`boot_id`） | — |
| running | `runner_exit` ∧ evidence 齐 | awaiting_human(gate=ready) | — |
| running | `runner_exit` ∧ evidence 缺 ∧ 预算>0 | starting（带缺失项重跑） | −1 |
| running | `runner_exit` ∧ evidence 缺 ∧ 预算=0 | blocked(evidence_missing) | — |
| running | `runner_dead`（pid 死且无退出记录）∧ 预算>0 | starting | −1 |
| running | `runner_dead` ∧ 预算=0 | blocked(runner_crash) | — |
| running | `check_absent`（无 `orchestrator.check`） | blocked(no_check) | — |
| awaiting_human | `answer=approve` | submitted | — |
| awaiting_human | `answer=reject` | **blocked(rejected)** | 不扣 |
| awaiting_human | `answer=abandon` | abandoned | — |
| awaiting_human | `gate_expire`（默认 24h） | blocked(gate_expired) | — |
| submitted | `push_pr_ok` | submitted（写 `pr_url`） | — |
| submitted | `tool_missing`（无 `gh`） | blocked(tool_missing) | — |
| submitted | `push_fail`（非快进 / 认证失败） | blocked(push_failed) | — |
| submitted | `ci_merged` | done | — |
| submitted | `ci_anomaly`（失败 / request-changes / 24h 无变化） | awaiting_human(gate=ci_anomaly) | — |
| awaiting_human(ci) | `answer=rerun` | submitted（重触发，幂等） | — |
| awaiting_human(ci) | `answer=new-task` | done（人另建任务；**不自动建单**） | — |
| blocked | `human_reopen`（CLI） | starting，预算重置为 2 | 重置 |
| blocked | `human_abandon` | abandoned | — |
| 任意活跃态 | `lease_expired` + reconciliation 判活进程已死 | 见 §3.5 | — |

**规则**：`failed` **永不发 gate**（只用于不可恢复：`repo_gone`、启动期 `tool_missing` 之外的结构性失败）；预算耗尽 → `blocked` 而非 `failed`；一切「需要人」的出口都是 `blocked` 或 `awaiting_human`，两者都非终态、都被 tick 覆盖，因此答案永远有消费方（修评审 §2-7）。

**每态 tick 行为**：`queued` 尝试 claim（§3.4），不发事件、不占并发、不占 repo 锁；`starting` 幂等建 worktree → 持久化 `attempt_id` → spawn → 等绑定；`running` 查 runner 活性（§3.5），退出则采集 evidence 判定，每 60s 发一条 `heartbeat`；`awaiting_human` 消费 mailbox（§3.9）并检查 `expires_at`；`submitted` **每 5 分钟**（非每 tick）`gh pr view`；`blocked` 只等人且**不发新 gate**（只在进入时发一次）；终态不触碰。除终态外每 tick 续租。

### 3.4 claim：单事务 + partial unique index

```sql
BEGIN IMMEDIATE;
-- 容量只计活跃 runner
SELECT count(*) FROM tasks WHERE state IN ('starting','running');    -- < concurrency 才继续
SELECT task_id, repo FROM tasks WHERE state='queued' ORDER BY created_at, task_id;
-- 对候选逐个尝试：
UPDATE tasks SET state='starting', attempt_id=?, owner_instance=?, lease_expires_at=?, updated_at=?
  WHERE task_id=? AND state='queued';
COMMIT;   -- 该 repo 已有活跃任务时，UNIQUE 约束在此失败 → 回滚该候选，跳到下一个 repo
```

唯一性由 `tasks_repo_active` 强制，不由计数查询强制——这正是评审 §2-1/§2-9 的根因修复：`queued` 不在索引谓词内，故 queued 任务互不阻塞、也不阻塞自己；并发上限只数 `starting|running`，堆积的 `awaiting_human`/`submitted`/`blocked` 不再占用 runner 槽（它们仍占该 repo 的写锁，这是刻意的）。

### 3.5 租约、崩溃恢复与 reconciliation

- **租约**：`owner_instance`（启动时 `randomUUID()`）、`lease_expires_at = now + 60s`、每 tick 续租。
- **启动顺序（强制）**：`reconcile()` 必须在**任何 spawn 之前**完成。对每个 `starting|running` 任务：
  1. 取 `runner_pid`/`runner_boot_id`。判活 = `process.kill(pid,0)` 成功 **且** `ledger.db` 中该 `stable_id` 最新 `session_incarnations` 行（`src/ingest/schema.sql:15-18`，`pid`+`proc_boot_id`）仍与记录一致 **且** journal 无 `session_ended`——后两条与 `resume.ts:16-20` 的判活子查询同构。注：`proc_boot_id` 在本仓是**每进程 UUID**（`src/extension/overload.ts:19`），不是机器 boot id；用于识别 pid 回收够用，文档不得称其为主机 boot id。
  2. 活 → 接管租约继续 `running`；死 → 按 `runner_dead` 走 §3.3。
  3. `starting` 且**无 pid**（spawn 前崩溃）→ 回 `starting` 重来：`attempt_id` 已持久化、worktree 探测幂等，不会双开——这就是「先持久化 attempt_id 再 spawn」的用途。
- **绝不盲 spawn**：reconcile 未完成前 tick 不执行 claim。

### 3.6 Worktree 生命周期

- **`creating` 折进 `starting`**：`~/.overload/worktrees/<task_id>/` 存在且是该 repo 的 worktree → 复用；分支已存在 → 复用；均无 → `git -C <repo> worktree add <dir> -b <branch> <base_ref>`。全部幂等。
- **GC 双入口**：`overload orch gc [--older-than <dur>] [--apply]` 供人按需清理（默认只列，`--apply` 才删）；orchestrator 的 tick 另以 **5 分钟节流**自扫一次，且只收 `updated_at` 早于 **1 小时**者——无人值守的删除不该跟刚走过去查看的人抢现场。两者共用同一判据：只删同时满足「任务终态」「`git -C <wt> status --porcelain` 为空」「无活进程」三条的 worktree；dirty 的**只列出、永不删**（`AGENTS.md` 原则 6）。清理成功写一条 `task_events(event='worktree_gc')`；未删成功的原因**不记**——它每轮都会复现，记下来只是重复噪声。
- **归属**：GC 与 worktree 同生共死于 orchestrator 进程，不进默认安装的 maintenance 作业——造垃圾的模块负责收垃圾，未启用 orchestrator 的装机不会凭空多出一个扫 `orchestrator.db` 的后台任务。

### 3.7 Runner adapter（仅 Pi，经 cmux）

**spawn 命令**（决定 10）：

```
cmux new-workspace --cwd <worktree> --focus false \
  --command "OVERLOAD_PARENT=orch:task:<task_id>:<attempt_id> OVERLOAD_ORCH_TASK=<task_id> pi <prompt-file>"
```

与 `src/shared/resume.ts:40` 已在用的 `cmux new-workspace --cwd … --command … --focus …` 同形态（差别只是 `--focus false`）。runner 会话因此拥有真实 `CMUX_SURFACE_ID`，extension 的 `hostContext()`（`src/extension/overload.ts:140-164`）在 `session_started` 里带上 `detail.host={app:"cmux",session_id,tty}`（`overload.ts:501-502`），reducer 的 `applyHost`（`reducer.ts:97-108`）写 `session_hosts`，`queryJumpTarget`（`queries.ts:112-122`）返回 `source='host', platform='cmux'`，`performJump`（`src/shared/jump.ts:90-100`）用 osascript 聚焦该 terminal。**既有 jump 链路全程可用，零新增平台**——这是「cwd 文本不可接受」的实修。

**会话绑定**：`OVERLOAD_PARENT` 由 extension 落入 `detail.parent`（`overload.ts:503`），ingest 落成 `sessions.origin`（`ingest.ts:258-265`）。orchestrator 只读 `ledger.db` 查 `SELECT stable_id FROM sessions WHERE origin=? ORDER BY created_at DESC LIMIT 1`，回填 `tasks.stable_id`，并从 `session_incarnations` 取 `pid`/`proc_boot_id`。**不用 pid 匹配**：`sessions` 不存 pid，而 `origin` 是自己注入的精确键。

**副作用**：`overload.ts:509` 在 `session_started` 后把 `process.env.OVERLOAD_PARENT` 覆盖为自身 `stable_id`，`overload.ts:572-573` 又给 runner 内部起的 `pi/omp/claude` 前置 `OVERLOAD_PARENT=`。因此 runner 的孙子会话血缘指向 runner 而非任务——正确，不需改。

**续跑**：gate 期间 runner 已退出（gate 由 orchestrator 在两次 runner 调用之间插入，不是 pi 内部 ask），故答复后起新 `pi --resume=<session>` 并在 prompt 里带上人类选择，与 `resume.ts:39` 同构，天然满足 D2。

`OVERLOAD_ORCH_TASK=<task_id>` 环境变量随进程树继承，是 §5.1 的 provenance 记号（不是安全控制）。

### 3.8 Evidence gate 与 submitted 路径

**工件目录** `~/.overload/artifacts/<task_id>/`，0700。每次 runner 退出后由 orchestrator 从 worktree 采集（不依赖 runner 自觉）：

| 工件 | 采集 | ready 必需 |
|---|---|---|
| `diff.patch` | `git -C <wt> diff <base_ref>...HEAD` | 是，非空 |
| `commits.txt` | `git -C <wt> log --oneline <base_ref>..HEAD` | 是，≥1 行 |
| `status.txt` | `git -C <wt> status --porcelain` | 是，为空 |
| `checks.txt` | 执行 worktree 根的 `orchestrator.check` | 是，退出码 0 |
| `runner.log` | 子进程输出尾部 | 否 |

无 `orchestrator.check` → `blocked(no_check)`（不是 `failed`：装一个脚本就能继续，属人可恢复）。**不提供跳过开关**。

**submitted 路径**（评审 §2-6 的修复）：`awaiting_human(ready)` 批准后同一 tick 内顺序执行，每步失败都有分类：

1. `git -C <wt> push -u origin <branch>`——幂等：先 `git ls-remote --heads origin <branch>`，远端已存在且 `--force-with-lease` 不需要时跳过；非快进 → `blocked(push_failed)`。
2. `gh pr list --head <branch> --json url --limit 1`——**先查已有 PR**，有则直接取 URL，不重复创建。
3. 无则 `gh pr create --base <base_ref> --head <branch> --title <title> --body-file <artifacts>/pr-body.md`。
4. 持久化 `pr_url` → 状态 `submitted`。
5. `gh` 不存在（`which gh` 失败或退出码 127）→ `blocked(tool_missing)`，**绝不静默转 done**。

**CI recon**：`submitted` 期间每 **5 分钟** `gh pr view <url> --json statusCheckRollup,reviewDecision,mergeable`。合并 → `done`。异常（check 失败 / `reviewDecision=CHANGES_REQUESTED` / 24h 无任何变化）→ 发**一条** `decision_requested`，options `["rerun","new-task","abandon"]`，人选（决定 3）。同一 PR 的同一异常只发一次（`approvals` 以 `task_id+gate` 去重）。**不自动建任何任务。**

### 3.9 审批 mailbox（唯一获准的反向通道）

**选定：独立文件 `~/.overload/orchestrator-answers.db`（0600），单表。** 三行理由：(1) web 因此**永不打开** `orchestrator.db`，一个 web 侧缺陷无法枚举任务、approval 或状态；(2) schema 由 **orchestrator 启动时创建并迁移**（单一 DDL 所有者，避免 `dropRetiredColumns` 式的双进程迁移事故），web 只做 `INSERT OR IGNORE`，文件不存在时静默失败而不是自建；(3) 独立文件让「web 只写 / orchestrator 只读+删」的权限方向在文件系统层面就成立，无需靠代码自律。

```sql
CREATE TABLE IF NOT EXISTS answers(
  approval_id TEXT PRIMARY KEY, answer TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL);
```

**写入方**：web 的 `POST /api/orchestrator/answer/<approval_id>`（`actor='ui'`）与 `overload orch answer <approval_id> <option>`（`actor='cli'`）写**同一张表**，因此 CLI 路径在 M3 就是完整可用的降级面，web 只是叠加。

**消费（orchestrator 侧，每 tick）**：`approval_id` 必须在自有 `approvals` 有行、`consumed_at IS NULL`、`now < expires_at`、`answer` 命中 `options` JSON 白名单——四条全过才产生一次状态转移并写 `task_events`（含 `actor`），随后删除 answers 行；未知 `approval_id` **跳过且不消费**，因为这些 foreign rows 属于其他 mailbox consumer（例如按包含 `#` 的 `request_uid` 识别的 extension action gate），由其自身消费者处理，并在 7 天后过期清理。其余任一校验不过仍丢弃并记 `task_events`。**不把 answer 回写 `approvals`**（决定：删双写，审计留在 `task_events`）。保留策略：每 tick 删除 `at < now-7d` 的残留行。明确：伪造一个不存在 approval 的 answer 永远不会被 orchestrator 消费，forgery defense 不变。approval_id 命名空间隐式 distinct（UUID vs 含 `#` 的 request_uid）；若新增第三个 consumer，应增加 owner 列，而不是继续增加 skip 规则。

**web 侧附加检查（廉价，非保证）**：拒绝没有 `Sec-Fetch-Site`/`Sec-Fetch-Mode` 头的答复请求。浏览器必带，`curl` 默认不带；一行 `if` 就能提高本地脚本误触/顺手滥用的门槛，但攻击者补上头即可绕过——**这是卫生措施，不是认证**。

**不复用 `/api/ack/`**（`server.ts:118-122`）：ack 的语义是「我知道了」且不解除阻塞（`README.md:63`），批准会导致执行，必须是不同路由 + 不同按钮文案（「批准并继续」vs「Ack」）。

### 3.10 禁用 orchestrator 会话的通用 Resume（**如实计入核心改动**）

问题（评审 §3）：orchestrator 起的 runner 是 `runtime="pi"` 的普通会话，进程死后 `inspectResume`（`resume.ts:23-32`）判 `resumable`，`app.js:120-122` 会显示 Resume 按钮，人一点就绕过状态机起一个平行进程同写一个 worktree——「git 会自己报错」不成立，两个进程同时改文件不产生 git 错误。

**最小核心改动**（共 ≈10 行生产代码 + ≈25 行测试）：

1. `src/shared/resume.ts`：`ResumeRow` 加 `origin`、`resumeRow` 的 SELECT 加 `s.origin`（`:16-20`）；`ResumeCapability` 的 reason 联合加 `"orchestrator_owned"`（`:5`）；`inspectResume` 在 runtime 检查后（约 `:28`）加 `if (row.origin?.startsWith("orch:")) return { resumable:false, reason:"orchestrator_owned" };`。**≈6 行**
2. `src/web/static/app.js:123`：reason 文案加 `orchestrator_owned → 「编排器托管」`。**≈1 行**
3. 前缀契约 `OVERLOAD_PARENT=orch:task:<id>:<attempt>`（§3.7）。web/core 只认字符串前缀，**不 import orchestrator、不读 orchestrator.db**——弱耦合，不破 §4.2 方向性。

**这是 v1 唯一一处为 orchestrator 而改的 Overload 核心行为。**

**Now 卡 provenance**：v1 **只用既有字段**，不加列。`decisionCard`（`app.js:57-67`）已渲染 `sessionLink(row.stable_id)`，而 `stable_id = host:runtime:session`（`ingest.ts:249`），故 host 与 runtime 已在卡上可见；伪造卡在答复端因 `approval_id` 无行而无法生效（§0-4）。**+0 行**。

---

## §4 与现有模块的契约

### 4.1 orchestrator 发出的事件与 spool writer

写入 `~/.overload/spool/<host>/orchestrator/`，0700 目录 / 0600 文件，`host` 从 `~/.overload/host` 读，必须等于目录名否则 `parseEnvelope`（`ingest.ts:240`）丢弃。基本写法照 `classifier.ts:89-105`。

**轮转（决定 11，精确）**：不能照抄一次性 writer。复用 extension 语义（`src/extension/overload.ts:14-15`，与 `src/shared/types.ts:97-98` 同值）：
- 活动文件 `active-orchestrator-<n>.ndjson`；累计写入 ≥ `SEGMENT_MAX_BYTES = 1_048_576` **或** 段龄 ≥ `SEGMENT_MAX_AGE_MS = 30_000` **或**进程退出，先到者 seal；
- seal = `rename` 为 `seg-orchestrator-<n>.ndjson`，`n` 自增（路径永不复用，cursor 以文件名为键）；
- `seq` **每 emitter 单调**（`types.ts:82`），与 `segment` 一起持久化在 `orchestrator.db` 的单行表 `spool_seq(id=1, seq, segment)`，每次发事件前 `UPDATE ... SET seq=seq+1` 并在同一事务内写出——重启后不回退、不重号。**不用 `task_events.id` 代替**（heartbeat 不该产生 task_event）。

**事件表（全部是 `types.ts:23-46` 已有的 kind，不新增 EventKind）**，`emitter_id="orchestrator"`，`session=<task_id>` ⇒ `stable_id = <host>:overload:<task_id>`（每任务一行会话，Now 天然按任务分组，`app.js:79-86`）：

| 时机 | kind | detail |
|---|---|---|
| claim 成功 | `session_started` | `{parent:"orchestrator", cwd:<worktree 或 M1 的 repo>, branch, lease:{pid, proc_boot_id}}` |
| 进入 running | `working` | `{}` |
| runner 退出 | `settled` | `{text:<≤500B 进展>}` |
| 进入 gate / blocked(ready 类) | `decision_requested` | `{request_id:<approval_id>, summary, options}` |
| 收到答复 / 超时 | `decision_resolved` | `{request_id, state:"resolved"\|"timed_out", selected}` |
| 终态 | `session_ended` | `{terminal_reason}` |
| 每 60s（非终态） | `heartbeat` | `{}` |

不新增 kind 的理由：`types.ts:1-4` 是冻结契约，新增会波及 `classifier.ts:49-62` 与 `reducer.ts:127`，把 orchestrator 语义泄漏进核心。代价是「任务」在 Overload 眼里就是一个 `runtime=overload` 的会话——这恰好正确。

### 4.2 边界

orchestrator 只写：`orchestrator.db`、`artifacts/`、`worktrees/`、自己的 spool 目录。对 `ledger.db` 仅 `{readonly:true}` 打开，只查 `sessions` / `session_incarnations` / `journal`。`src/ingest/schema.sql` 的 14 张表**一律不写**。

反向：`src/web|recon|ingest|notify|pull|shared` **不得 import `src/orchestrator/`**，一行 CI grep 守：
`grep -rn "from \"\.\./orchestrator\|from '\.\./orchestrator" src/ --include=*.ts | grep -v "^src/orchestrator/"` 必须无输出。

**两处如实登记的例外**（不再宣称「Overload 零改动」）：(1) web 写 `orchestrator-answers.db`（§3.9），唯一获准的反向 mailbox，SQL 内联 5 行不 import；(2) `src/shared/resume.ts` 的 `orch:` 前缀 guard（§3.10），≈10 行核心改动 + 测试。

### 4.3 决策卡最小载荷落点

| `AGENTS.md` 要求 | 落点 |
|---|---|
| 一句话结论 | `detail.summary` 首句 |
| 触发原因与证据 | 次句，含 `~/.overload/artifacts/<task_id>/` 与 `checks.txt` 摘要 |
| 不处理的影响 | 末句（「不批准则 24h 后进入 blocked，worktree 保留」） |
| 建议动作 / 结构化选项 | `detail.options`（同时是 §3.9 白名单） |
| 唯一责任人与时效 | 单操作者恒为本人；时效写进 summary 文案（**不改 frozen 的 `requests` 表**） |
| 回到现场 | `session_hosts` 的 cmux binding → `queryJumpTarget` → `performJump`（§3.7），真实可跳 |
| 决策后续跑状态 | 下一条 `working`；卡片随 `decision_resolved` 消失 |

---

## §5 安全边界

### 5.1 信任模型（重写，决定 1）

**明确声明：在单 UID 机器上，Overload 的任何机制都无法阻止同 UID 的 runner 写 answers 库或 curl loopback。gate 是工作流边界，不是安全边界。**

由此的四条后果，写进 README 与本计划，不做相反宣称：

1. **Origin/Host 只是 CSRF 卫生**（§2.1），不构成 caller binding。任何本地进程都能补上这两个头。
2. **记录 actor provenance**：每条答复记 `actor ∈ {ui, cli}`（§3.9），并**拒绝 `approval_id` 在 orchestrator 自有 `approvals` 无行的答复**。这挡住的是「伪造 Now 卡诱导人点击」（评审 §3 Medium），不是「runner 自批」。
3. **v1 不存在无人值守的高风险动作**：无 auto-merge、无 human-approved ready gate 之外的 push。因此 runner 自批能买到的全部是「向 bot 分支 `git push` + 建一个 PR」——**这就是被接受的爆炸半径**。合并仍需人在 GitHub 上动手。
4. **两个廉价、非保证的记号**：runner 进程带 `OVERLOAD_ORCH_TASK=<id>`（provenance，可被子进程清掉）；答复端拒绝无 `Sec-Fetch-*` 头的请求（浏览器必带，`curl` 默认不带，攻击者补上即绕过）。**二者都不是保证，文档必须这样写。**

对照当前最坏情况：SEC-1 未修时，任意网页即可触发 `resume.ts:40` 的 `cmux new-workspace --command "pi --resume=…"`，也就是以用户身份起一个能执行任意 bash 的 agent。orchestrator 不抬高这个天花板；它新增的是**时间维度**的暴露（无人值守长时间跑 pi），对应收窄措施见 §5.2。

### 5.2 收窄措施（工程约束，不冒充安全控制）

(1) runner 的 `cwd` 固定在 `~/.overload/worktrees/<task_id>/`，repo 主工作树不被直接触碰；(2) 并发硬上限 4；(3) 一 repo 一活跃写者，由 `tasks_repo_active` 强制（§3.4）；(4) `orchestrator.check` 由 **repo 作者**定义验证语义；(5) 不做 auto-merge。

**不做的加固**：不给 orchestrator 做 sandbox / 降权用户（同 UID 攻击者本就等价，换用户会让 `~/.overload` 的 0700 模型、`ingest.ts:79-80`全面失效）；不扩展 `src/extension/overload.ts:405-420` 的 denylist 去管 runner（它 fail-open，当护栏只制造虚假安全感，文档定位为 best-effort guardrail）。

---

## §6 实施次序（每个里程碑独立可发布，有工作的降级行为）

行数为生产代码估算，不含测试。

### M0 — orchestrator 前置（§2.1–2.3）
- 改：`src/web/server.ts`（Origin/Host 守卫；删 `/api/q2` 与 summary 字段）、`src/ingest/reducer.ts`（`targetStableId` host 权威）、`src/web/static/app.js`（删 q2 区、改 tile 计数）、`src/shared/queries.ts`（删 `queryQ2`、改 `queryArchive`）、`src/cli/overload.ts`（删 `q2`）、`src/shared/types.ts:50`（+`q4`）
- **≈ 70 行（含删除 ≈35）**；验收 = §2 各节验收全绿；回滚 = 逐文件 revert，无 schema 变更。（§2.4 五项各自单独提交，**不阻塞 M1**）

### M1 — 内核：store + 状态机 + 租约 + reconcile + spool（**无 spawn**）
- 新建：`src/orchestrator/schema.sql`、`store.ts`（claim 事务、租约、转移 + `task_events`）、`spool.ts`（§4.1 轮转 writer）、`orchestrator.ts`（5s tick + reconcile）、`cli.ts`（`add|ls|show|advance|abandon|reopen`）、`launchd/works.earendil.overload.orchestrator.plist`
- 降级行为：**一个手动推进的任务台账**。`starting` 的 spawn 是 no-op，人在 repo 里自己干活后 CLI `advance`。`session_started.detail.cwd` 用 **`repo` 路径**（不依赖 M2 worktree，修评审 §2-5）。可达状态：`queued/starting/running/blocked/done/failed/abandoned`；`awaiting_human`/`submitted` **尚不可达**（无消费方）。
- 验收：`overload orch add "<title>" --repo <path>` → orchestrator.db 有行 → Overload Sessions 页出现 `runtime=overload` 会话（spool 契约通）；同 repo 第二个任务因唯一索引停在 `queued`；kill -9 后重启，`running` 任务被 reconcile 判定而非重复推进
- **≈ 360 行**；回滚 = `launchctl unload` + `rm ~/.overload/orchestrator.db`（ledger 只留几条历史事件）

### M2 — worktree + runner spawn + resume 旁路禁用
- 新建：`src/orchestrator/worktree.ts`（幂等建/探测 + `gc`）、`runner.ts`（`cmux new-workspace` spawn、绑定回填、判活、收割）
- 改：`orchestrator.ts`（starting/running 接入）、**`src/shared/resume.ts` + `app.js`（§3.10，≈10 行核心改动）**
- 降级行为：任务能自动起 runner 并在退出后停在 `running`（无 evidence 判定，人用 CLI 推进）。gc 仅列出，加 `--apply` 才删。
- 验收：任务自动 claim worktree、起 pi、绑定 stable_id；Sessions 页该会话**无 Resume 按钮**（显示「编排器托管」）；Now 卡的 jump 能真正聚焦到 cmux terminal；`gc` 对 dirty worktree 只列不删
- **≈ 280 行**；回滚 = spawn 短路回 M1 no-op，worktree 保留

### M3 — evidence + ready gate + CLI 答复（`awaiting_human` 首次可达）
- 新建：`src/orchestrator/evidence.ts`（五类工件 + `orchestrator.check`）、`approval.ts`（`approvals` 读写、mailbox 建库/消费/白名单/过期/7d 清理）
- 改：`cli.ts`（`answer <approval_id> <option>`）、`orchestrator.ts`
- 降级行为：**全流程 CLI 可用**——gate 在 Now 区可读，答复用 CLI 写 mailbox；web 按钮尚不存在但不影响闭环。
- 验收：无 `orchestrator.check` → `blocked(no_check)`；脏工作区 → 扣预算重跑；四项齐 → `awaiting_human(ready)` 且 Now 出现带 options 的卡；CLI answer 后 5s 内转移；伪造 `approval_id` 被丢弃并留 `task_events`；24h 未答 → `blocked(gate_expired)`
- **≈ 230 行**；回滚 = `evaluate()` 恒返回 ok 且跳过 gate（退回 M2）

### M4 — web 答复面（Now 一键批准）
- 改：`src/web/server.ts`（`POST /api/orchestrator/answer/<approval_id>`，内联 5 行 SQL 写 answers.db，Origin/Host + `Sec-Fetch-*` 检查，`actor='ui'`，**不 import orchestrator**）、`app.js`（`decisionCard` 对 `runtime=overload` 会话渲染「批准并继续」）
- 降级行为：路由 404 或文件缺失时，M3 的 CLI 路径原样可用。
- 验收：点选 → 5s 内续跑；跨站 POST → 403；无 `Sec-Fetch-*` → 403；orchestrator 停机时点击不产生假成功（answers 行留存，重启后被消费）
- **≈ 45 行**（web 35 + 前端 10）；回滚 = 删路由 + 隐藏按钮

### M5 — submitted：push + PR + CI recon
- 新建：`src/orchestrator/submit.ts`（§3.8 的 push/PR 幂等链）、`pr.ts`（5 分钟 `gh pr view`、异常 → 一条 `decision_requested`）
- 降级行为：`gh` 缺失 → `blocked(tool_missing)`，人手工建 PR 后 CLI `advance`；不静默成功。
- 验收：批准后自动 push + 建 PR 且重复执行不产生第二个 PR；`gh` 不存在 → `blocked(tool_missing)`；CI 通过合并 → 静默 `done`（**无通知**）；CI 失败 → 一条含 rerun/new-task/abandon 的卡，**不自动建任务**
- **≈ 170 行**；回滚 = `submitted` 转 `blocked(manual_submit)` 交人处理

**总计 ≈ +1085 / −35 行生产代码。** 依赖仅两条：M0 ≺ M4（web 守卫是答复路由的前提）；M2 ≺ M3（evidence 需要 worktree）。M4/M5 之间无依赖。

---

## §7 删减项

### 7.1 删

只一项：`queryQ2`、`/api/q2`、CLI `q2`、`app.js` 的 q2 表格（`queries.ts:145-147`、`server.ts:87`、`cli/overload.ts:49-53`、`app.js:102-110`）——D1，已在 M0。

### 7.2 **不删**（v1 相应条目撤销）

| 项 | 理由 |
|---|---|
| `dropRetiredColumns()`（`ingest.ts:104-114`） | 决定 4。删它无助闭环，风险大于 8 行收益 |
| `src/pull/pull.ts`、`~/.overload/host`、`coverage_gaps`、`source_generations` | D3；且 host 拓扑正是 SEC-2' 修复的权威来源（`ingest.ts:240`） |
| `docs/plans/*` 历史文档 | 只加「历史文档」标注，保留设计推理 |

### 7.3 `queue_transitions`：不读也不删

`schema.sql:35-39` 在写（`reducer.ts:161-163`），全仓无读取方。决定 3 已删除 metrics 里程碑，因此 v1 **既不加读取方也不删表**：删表是 schema 破坏性变更，加读取方不属最小闭环。如实登记为「已知只写数据」，留待真实指标需求出现时处理。

---

## §8 风险与未决（4 条）

**R1（高）— `pi <prompt>` 的一次性非交互执行语义未验证。** `resume.ts:39` 证明 `pi --resume=<session>` 存在，但 M2 需要「执行一段 prompt 后退出并给出退出码」。**M1 结束前必须做一次 10 分钟手工验证**；若无此模式则需 PTY 包装，复杂度显著上升，应先回来重估。

**R2（中）— evidence 的「工作区必须干净」可能与 pi 默认行为冲突。** 若 pi 不自行 commit，每个任务都卡在 `status.txt` 非空 → 扣预算 → `blocked`。缓解是把「提交你的改动」写进 prompt，依赖模型服从性。**未决**：是否允许 orchestrator 代为 `git add -A && git commit`——那会让它拥有提交权，**倾向不做**；先用 `blocked(dirty_worktree)` 看真实失败率。

**R3（中）— `cmux new-workspace --focus false` 未在本仓验证。** `resume.ts:40` 只证明 `--focus true` 被使用。若 cmux 不支持 `false`，runner 启动会抢焦点，违反「仅在必要时打断」。M2 开始前确认；退路是接受一次焦点抖动。

**R4（低）— 三个 SQLite 文件。** 运维复杂度上升；取舍刻意（§3.2、§3.9）。缓解：`src/cli/doctor.ts` 在 M1/M4 各加一条存在性 + 权限检查（**≈ +15 行**，接在 `doctor.ts:162` 的 `checkPermissions` 之后）。若日后证明分离无收益，并入 orchestrator.db 是单向可逆的小改动。

---

## 附：一句话总结

先用约 70 行修掉 orchestrator 真正依赖的三件事（CSRF 卫生、跨 host 的 `detail.stable_id` 覆盖、看不见的 Inbox），其余止血项各自独立提交；再用约 1015 行在 `src/orchestrator/` 里造一个**由 DB 唯一索引强制单写者、有租约与启动 reconciliation、只有一个 ready gate、终态之外一律用 blocked 接住人类、经 cmux 起 runner 因而真能跳回现场、push/PR/CI 写成幂等链**的最小编排器；并诚实承认：gate 是工作流边界不是安全边界，Overload 核心为此改了约 10 行（`resume.ts` 的 `orch:` guard），代价是 runner 自批最多换来一个 bot 分支和一个待人合并的 PR。
