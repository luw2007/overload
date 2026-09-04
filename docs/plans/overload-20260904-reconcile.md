# Orchestrator reconcile / lease 语义定稿（N5 + N7）

日期：2026-09-04｜分支：`luw2007/orchestrator-lease`（基于 `1ba45da`）｜设计依据：`docs/plans/overload-20260902-orchestrator.md` §3.3 / §3.4 / §3.5 / §3.7

本文只定语义，不含代码。N5（lease 无 owner 谓词、reconcile 是空壳）与 N7（null-pid 停滞）同住 `reconcile()` 与 lease 列，分开实现必然产生两份互相覆盖的重写，故先一次定死。

**范围**：`src/orchestrator/orchestrator.ts`、`src/orchestrator/store.ts`、`src/orchestrator/runner.ts`、`src/orchestrator/schema.sql`（只增表，见 §6）。不改 `src/shared/types.ts`、`src/ingest/schema.sql`。

**基线**：`1ba45da` 上 `bun test` 为 354 pass / 0 fail / 1 skip。

---

## §0 先纠正三条对现状的误述

实现者必须先接受这三条，否则会去修不存在的 bug。

1. **`starting` + 无 pid 并非「永不被再驱动」。** `tick` 对每个 `starting` 任务无条件调 `startRunner`（`src/orchestrator/orchestrator.ts:41`），与 `reconcile` 的 `continue`（`orchestrator.ts:28`）无关——那行 `continue` 跳过的是一个空循环体（`orchestrator.ts:26-32`），是死代码。N7 的真实停滞点在下面第 2、3 条。

2. **真实的双开风险在 `startRunner`，不在 `reconcile`。** `startRunner` 无条件执行 `spawnRunner`（`orchestrator.ts:65`），`ensureWorktree` 顺序幂等（`src/orchestrator/worktree.ts:21-31`）而 spawn 不幂等（`src/orchestrator/runner.ts:35-42`）。orchestrator 崩溃但 runner 存活时，重启后的下一 tick 会在同一 worktree 里再开一个 `pi`。

   持久化 `attempt_id`（`schema.sql:6`）本身**不**阻止这件事。更关键的是：**ledger 里查不到 origin，不能推出「这次没 spawn 过」**。`spawnRunner` 只在 `cmux new-workspace` 返回成功时返回 ok，它不向任何数据库写入（`runner.ts:35-42`）；ledger 由独立的 spool-ingest 事务填充（`src/ingest/ingest.ts:285-302`），与 orchestrator 自己的库（`store.ts:23-25`）是两个 SQLite 文件、两个进程。摄取延迟窗口内，「cmux 已经拉起 pi」与「ledger 还没看见」完全同形。§3.2 因此不能建立在「查不到 = 没开过」之上，必须有一条 orchestrator 自己写、且写在 spawn **之前**的记录。见 §3.2。

3. **真实的永久停滞在 `runner_dead` 回到 `starting` 之后。** `transition` 只按 detail 里出现的键覆盖列（`store.ts:47-53`），`runner_dead` 的 detail 不含 `stable_id`/`runner_pid`，故 `running --runner_dead--> starting`（`store.ts:15`）**保留**旧的 `stable_id`、`runner_pid`、`runner_boot_id` 和**同一个** `attempt_id`。

   后果的准确形状是（此处修正了本文早期版本的一处错误因果链）：
   - 下一 tick，该 `starting` 任务照样进 `startRunner`（`orchestrator.ts:41`），`ensureWorktree` + `spawnRunner` 无条件执行（`orchestrator.ts:63-67`），**新 runner 已经在同一 worktree 里跑起来了**。
   - 回到 `running` 后，因为陈旧的 `runner_pid` 非空，`pollRunning` 的 null-pid 分支（`orchestrator.ts:71`）**不会**进入 `pollBinding`；它去 `defaultPidAlive(陈旧 pid)`（`orchestrator.ts:72`），旧进程已死则为 false，于是**立刻开始采 evidence**（`orchestrator.ts:73`）。
   - 此刻 `collectEvidence` 跑的 `git diff/log/status`（`src/orchestrator/evidence.ts:9-13`）作用在一个**新 runner 正在并发改写**的 worktree 上。采到的既不是上一次 attempt 的稳定状态，也不是这一次 attempt 的完成状态，而是一个撕裂的中间快照——`status --porcelain` 大概率非空，`evidenceReady` 返回 `dirty_worktree`（`evidence.ts:28`），于是扣预算重跑，再撕裂一次。
   - 重跑还沿用同一个 `attempt_id`，即同一个 `taskOrigin`（`runner.ts:23`），新旧两次 attempt 在 ledger 里指向同一 origin，`bindRunnerSession` 的 `ORDER BY created_at DESC LIMIT 1`（`runner.ts:57`）无法区分死的和新的。

   处方不变（轮换 `attempt_id`、清空 pid 三列，§3.1-3），但理由是「并发写坏证据 + origin 复用」，不是「采到了上一次 attempt 的状态」。

---

## §1 决策 1：lease 归属与围栏

### 1.1 `renewLeases` 的谓词

现状 `store.ts:66` 无任何 owner 谓词，`WHERE state NOT IN ('done','failed','abandoned')` 一把抓；第二个实例每 tick 把全部非终态任务的 `owner_instance` 改写成自己。这不是租约，是无条件夺取。

定稿 SQL（参数顺序：`owner, now+60000, now, now, now`）：

```sql
UPDATE tasks SET owner_instance=?1, lease_expires_at=?2, heartbeat_at=?3, updated_at=?4
 WHERE state NOT IN ('done','failed','abandoned')
   AND (owner_instance IS NULL OR owner_instance=?1
        OR lease_expires_at IS NULL OR lease_expires_at<=?5)
```

三条放行支路各有理由：
- `owner_instance IS NULL`：`addTask` 只写 `task_id/title/repo/base_ref/state/created_at/updated_at`（`store.ts:27`），`queued` 任务的 owner 恒为 NULL，不放行则 `queued` 永远无人续租。
- `owner_instance=?1`：自己续自己，正常路径。
- `lease_expires_at IS NULL OR <=?5`：租约确已过期。`claim` 写入 `now+60_000`（`store.ts:62`），tick 间隔 5s（`orchestrator.ts:110`），过期意味着至少 12 个 tick 没有续租。

**过期 = 允许接管租约，不等于允许杀掉 runner。** 接管后该任务照走 §2 的活性判定：runner 活着就继续 `running`（只是换了个看管者），死了才 `runner_dead`。租约的所有权与 runner 的活性是两件独立的事，混同就会出现「orchestrator 重启导致人在跑的活被判死」。

### 1.2 tick 的任务循环也要收窄

只改 `renewLeases` 不够。`tick` 目前对 `listTasks(this.db)` 的全部结果调 `startRunner`/`pollRunning`/`pollSubmitted`（`orchestrator.ts:39-43`），实例 B 即使不改 owner 列，照样会为实例 A 的任务 spawn runner。

定稿：`reconcile` 与 `tick` 的任务循环共用同一个「我可动」谓词——

```
ownedByMe(task, now) := task.owner_instance IS NULL
                     OR task.owner_instance = this.owner
                     OR task.lease_expires_at IS NULL
                     OR task.lease_expires_at <= now
```

不满足者本 tick 完全跳过：不判活、不 spawn、不 transition、不发 gate。执行顺序保持现状（`reconcile` 在 `claim` 之前，`orchestrator.ts:37`），符合 §3.5「绝不盲 spawn」。

### 1.3 围栏：所有 await 之后的写入都必须 CAS

**`ownedByMe` 只决定「本 tick 可以开始处理哪些行」，它不保护已经开始的异步工作。** 这是本设计里最容易漏掉的一格，单独定死。

问题形状：`startRunner` 在 `ensureWorktree` 与 `spawnRunner` 两个 await 之后才 transition（`orchestrator.ts:63-67`）；`pollRunning` 在 `collectEvidence` 的多个外部命令之后才 transition（`orchestrator.ts:73-77`、`evidence.ts:9-17`）。而 `transition` 读完行之后，只按 `WHERE task_id=?` 更新（`store.ts:54`），既无 owner 谓词也无代次。于是：owner A 卡在一个慢 await 上超过 60 秒 → 租约过期 → B 合法接管并推进该行 → A 的 await 返回，A 把 `spawn_ok` / `runner_exit` 写在 B 的行上。轻则非法转移被 `tick` 的 catch 吞成 `tick_error`（`orchestrator.ts:44-47`），重则覆盖 B 的新状态或触发第二次 spawn。

**定稿：选「每个 post-await 写入带 owner CAS」，不选「in-flight 期间租约不过期」。** 后者需要一个「谁来判定 in-flight 已经真的死了」的元问题，等于把租约递归了一层。

围栏令牌直接用 `owner_instance`，**不新增代次列**。理由：`owner` 是每进程 `randomUUID()`（`orchestrator.ts:18`），进程重启必得新值，因此不存在 A→B→A 的 ABA 复现，owner 身份本身即单调。

具体规定：

1. `transition` 增加一个可选参数 `expectOwner?:string`。给出时，`store.ts:54` 的 UPDATE 追加 `AND owner_instance=?`；`db.run` 的 `changes===0` 即 CAS 失败。CAS 失败时**不抛异常**（抛出会被 `orchestrator.ts:44-47` 记成 `tick_error`，与真正的 bug 混为一谈）。

2. **必须传 `expectOwner` 的调用点**（全部是 orchestrator 在 await 之后发出的）：
   - `startRunner`：`worktree_fail`（`orchestrator.ts:64`）、`spawn_fail`（`:66`）、`spawn_ok`（`:67`）
   - `pollRunning`：`runner_exit`（`:74`、`:76`、`:77`）、`check_absent`（`:75`）
   - `pollBinding`：`session_bound`（`:83`）、`bind_timeout`（`:85`）
   - `pollSubmitted`：`push_pr_ok`、`push_fail`/`tool_missing`、`ci_merged`、`ci_anomaly`
   - `reconcile` 新增的 `runner_dead` 与 `blocked` 路径（§3.3）

3. **不传 `expectOwner` 的调用点**：CLI 的 `advance`/`answer`/`reopen`/`abandon`（`src/orchestrator/cli.ts:12`）与 `consumeAnswers`。人类动作在语义上高于任何实例的租约，必须能覆盖。这是有意的不对称，不是遗漏。

4. **CAS 失败时输者的行为**（「不得静默丢活」）：
   - 写一条 `task_events` 行，`event='fence_lost'`，`detail` 含它**本来要发的事件与 detail**、自己的 owner、以及行上当时的 owner。`from_state`/`to_state` 都取当前实际状态，不改 `tasks` 表任何一列。
   - 清掉自己关于该任务的全部内存态（`bindAttempts`、`lastCiCheck`、`started`），当作没见过这个任务，本进程后续 tick 不再碰它（除非它又通过 `ownedByMe`）。
   - **不重试、不改写、不转移到别的状态。**
   - 活没有丢：输者在 await 之前已经把不可逆的事实写进了 `task_recovery`（§3.2），赢者的 `reconcile` 会从那条记录 + ledger 重新推导真相。`fence_lost` 事件是给人看的审计线索，不是待办。

5. `task_recovery`（§3.2）的写入**不加围栏**，因为它以 `attempt_id` 为语义键：旧 owner 若为一个已被轮换掉的 attempt 写结局，写的是一条再无人读的记录。轮换 attempt 时整行 REPLACE，天然收敛。

### 1.4 两个实例是否受支持

**受支持，但不是产品特性；不检测、不拒绝。**

拒绝需要一个新的独占物（pidfile 或单例行），而这个独占物自己也会在崩溃后残留，于是需要它自己的过期与恢复逻辑——把同一个问题递归了一层。而修好 §1.1–§1.3 之后，两实例是**安全**的：

- 同一 repo 的活跃任务由 `tasks_repo_active` partial unique index 在 DB 层强制唯一（`schema.sql:15-16`）；
- `claim` 在 `BEGIN IMMEDIATE` 内以 `WHERE task_id=? AND state='queued'` 做 CAS（`store.ts:62`），只有一个实例能把某任务推出 `queued`；
- §1.2 挡住非本实例持有且未过期的行；
- §1.3 挡住租约在 await 期间过期后旧 owner 的迟到写入。

已否决：启动时 `SELECT count(*) FROM tasks WHERE lease_expires_at>now` 若非零就退出——会把「上一次自己崩溃后残留的未过期租约」误判成「另一个实例在跑」，让恢复无法启动。

### 1.5 租约时钟：一条具名的接受风险

`claim`（`store.ts:62`）与 `renewLeases`（`store.ts:66`）都用调用方传入的 epoch 毫秒，§1.1 的谓词比较 `lease_expires_at<=now`。NTP 校正或人工改表会让这个比较失真：

- **向前跳**：健康租约瞬间变成「已过期」，触发提前接管。**接受。** §1.3 的围栏把这件事的后果从「正确性错误」降级为「一次多余的接管 + 一条 `fence_lost` 审计事件」：旧 owner 的迟到写入必然 CAS 失败，新 owner 从 `task_recovery` + ledger 重新推导，不会双开也不会丢状态。
- **向后跳**：过期被推迟，真正死掉的 owner 的任务在时钟追平之前无人接管。**接受，并具名。** 后果是任务停滞、人等不到 gate；没有静默的错误结果。缓解只有一条：§2.2 的不可判定计数用 **tick 计数**而非墙钟，因此活性判定的那条界本身不受时钟跳变影响。

不引入单调时钟。跨进程的单调基准需要新列 + 启动时校准，而收益只覆盖一个已被围栏降级的场景。**这是一条明示接受的风险，不是未发现的缺陷。**

---

## §2 决策 2：活性证明

### 2.1 四值判定与它的查询

判定结果是**四值**：`alive` / `dead` / `exited` / `unknown`。

`bindRunnerSession`（`runner.ts:52-62`）给不出这四个值：它返回 session-或-null，且不看 `session_ended`。照搬 `src/shared/resume.ts:16-20` 的形状也不行——那个子查询把 ended incarnation **排除在结果之外**（`resume.ts:18`），排除之后「已结束」与「不存在」同形，恰好是本设计需要区分的那一对。

**定稿：在 `src/orchestrator/runner.ts` 新增一个兄弟函数 `probeRunnerLiveness(ledgerPath, taskId, attemptId)`，不改 `bindRunnerSession`。** 后者继续服务 `pollBinding` 的「拿到 stable_id 了吗」问题（`orchestrator.ts:82`），行为不变，既有测试不受影响。

`probeRunnerLiveness` 只读打开 ledger（同 `runner.ts:54` 的 `{readonly:true}`），执行**一条** SQL：

```sql
SELECT s.stable_id, i.pid, i.proc_boot_id,
       (i.stable_id IS NOT NULL) AS has_incarnation,
       EXISTS(SELECT 1 FROM journal j
              WHERE j.stable_id=i.stable_id AND j.writer_id=i.writer_id
                AND j.kind='session_ended') AS ended
  FROM sessions s
  LEFT JOIN session_incarnations i
    ON i.stable_id=s.stable_id AND i.liveness_domain='process'
 WHERE s.origin=?
 ORDER BY s.created_at DESC, i.last_seen_at DESC
 LIMIT 1
```

关键点：`ended` 是**返回的一列**，不是过滤条件——这正是 `exited` 得以与「不存在」区分开的机制。`LEFT JOIN` 让「有 session 但 incarnation 尚未落地」不塌缩成「无 session」。表结构见 `src/ingest/schema.sql:5-10`（journal）与 `:16-19`（session_incarnations）。

返回值（判别式联合）：`{kind:"absent"}` | `{kind:"found", stable_id, pid, boot_id, has_incarnation, ended}` | `{kind:"unreadable"}`。打不开库、加锁超时、查询抛出，一律 `unreadable`——**绝不折成 `absent`**，这是 `runner.ts:54` 现有 `catch { return null }` 的缺陷，新函数不得继承。

调用方（`reconcile` / `startRunner`）据此与 `tasks` 的列合成四值：

| 条件 | 结果 |
|---|---|
| `process.kill(pid,0)` 抛异常（`worktree.ts:57-59`） | **dead** |
| pid 活 ∧ `found` ∧ `ended=1` | **exited**（会话已结束、进程壳未退；走 evidence 采集，非 `runner_dead`） |
| pid 活 ∧ `found` ∧ `has_incarnation` ∧ `pid`/`proc_boot_id` 与 `tasks.runner_pid`/`runner_boot_id` 全等 ∧ `ended=0` | **alive** |
| pid 活 ∧ `found` ∧ `has_incarnation` ∧ 二者任一不等（pid 被回收，现属无关进程） | **dead** |
| pid 活 ∧ `found` ∧ `has_incarnation=0`（session 已落地、incarnation 未落地） | **unknown** |
| pid 活 ∧ `unreadable` | **unknown** |
| pid 活 ∧ `absent` | **unknown**（摄取窗口内不可区分，见 §0-2） |

判定顺序即上表顺序：`ended` 先于 pid/boot_id 比对，因为「会话已结束」是关于这次 attempt 的终局事实，此时 incarnation 是否匹配已不影响结论。

**pid 已死时不查 ledger。** 进程不存在是终局的，ledger 说什么都不改变结论；少一次 IO，也少一个「ledger 不可读导致死进程判不出来」的分支。

**`proc_boot_id` 是每进程 UUID**（`src/extension/overload.ts:21` 的 `const procBootId = randomUUID()`），**不是机器 boot id**。它能识别 pid 回收（新进程必有新 UUID），不能识别跨机器重启；文档与注释一律不得称其为主机 boot id。runner 只在本机（计划 §1.2「远程 runner：不做」），够用。

**快照一致性。** 上面是**单条**语句，因此 session、incarnation、`session_ended` 三者取自同一个已提交快照，不存在跨语句读偏斜（现状 `runner.ts:57` 与 `:59-60` 是两条语句，有）。但 `process.kill` 与 ledger 读永远不可能原子——所以任何「pid 活但 ledger 说法自相矛盾」的组合，一律映射到 `unknown`，交给 §2.2 的计数收敛，绝不映射到 `dead`。ingest 按批次事务提交（`ingest.ts:285-302`），单批可见性是原子的；`busy_timeout=5000`（`src/ingest/schema.sql:3`）只减少锁等待，不提供任何跨库保证。

### 2.2 ledger 不可读时：既不判死，也不无限等，且跨重启有界

**决策：`unknown` 当帧不动作，但累计计数；累计达 `BIND_TIMEOUT_TICKS`（12，≈60s，`orchestrator.ts:15`）后 → `blocked(liveness_unknown)`，不扣 `retry_budget`。计数持久化在 `task_recovery.unknown_ticks`（§3.2 的同一张表），不是内存。**

理由，按 AGENTS.md 排序：
- 判死会杀掉正在跑的活，用户得从头重建现场——违反原则 6（保留现场连续性），代价不可逆。
- 判活会让任务永远停在 `running`，人永远等不到那次验收——违反原则 8（完成必须主动回流）。
- `blocked` 是非终态、占 repo 活跃锁、进入时发一次 gate、可由人 `human_reopen` 重开并把预算重置为 2（`store.ts:18`、`store.ts:43`）。它把「我判不了这个 runner 死活」压成一条带原因的人类决策——这正是 Overload 的产品目标。
- 不扣预算：ledger 读不了是 orchestrator 侧的环境故障，不是这次 attempt 的失败。用 attempt 预算为环境故障买单，会让一次 ledger 权限问题烧光重跑机会。这条超时用 tick 计数独立限界，不与 §4 的预算混账。

**为什么必须落库（这是相对本文早期版本的实质修正）。** 计数若只在内存（与 `bindAttempts`，`orchestrator.ts:18`，同形），则每次 orchestrator 重启都把窗口清零：一个每 <60s 崩溃重启一次的 orchestrator 会让任务在 `unknown` 里停留任意久而永不 `blocked`。那不是「界随重启放大」，那是**无界**，称其有界是错的。落库之后，界是绝对的 12 个 tick 的**累计**观测，与进程生命周期无关。

计数用 tick 数而非墙钟毫秒，因此不受 §1.5 的时钟跳变影响。

任何一次 `alive`/`dead`/`exited` 判定都把 `unknown_ticks` 归零；轮换 `attempt_id` 时整行 REPLACE，亦归零。

已否决：复用 `heartbeat_at` 列做陈旧时钟。`renewLeases` 每 tick 给所有可续租任务写 `heartbeat_at=now`（`store.ts:66`），该列恒新，做不了时钟。

---

## §3 决策 3：spawn 提交记录、状态机补丁与全枚举

### 3.1 转移表补丁（`store.ts`）

1. **`starting` 增加 `runner_dead`**（`store.ts:14`）。今天 `starting` 无此事件，一旦对 `starting` 任务调用就抛 `Illegal transition`（`store.ts:41`），被 tick 的 catch 吞成一条 `tick_error`（`orchestrator.ts:44-47`），下一 tick 原样重来——静默无限循环。补规则后走 §4 的预算路径。

2. **`targetFor` 的 `running` 分支扩展到 `starting`**（`store.ts:33`）：`(task.state==="starting"||task.state==="running") && event==="runner_dead"` 一并适用 `store.ts:35` 的 `retry_budget>0?"starting":"blocked"`。

3. **重跑必须换 attempt。** `transition` 在目标态为 `starting` 且事件属 `runner_dead` / `runner_exit(evidence_complete:false)` 时，额外把 `attempt_id` 置为新的 `randomUUID()`，把 `runner_pid`、`runner_boot_id`、`stable_id` 三列置 NULL，并在同一事务内 REPLACE 掉该任务的 `task_recovery` 行（新 attempt、`spawn_state='intent'` 之前的空白态：见 §3.2 的「无行」语义，此处直接**删除**该行）。这是 §0-3 那个停滞的根因修复，且只此一处，不必在每个调用点各加一次清理。

   为什么必须换 `attempt_id` 而不是只清 pid：`taskOrigin` 由 `(task_id, attempt_id)` 构成（`runner.ts:23`），沿用旧 attempt 会让新旧两次 attempt 在 ledger 里共享 origin，`probeRunnerLiveness` 的存在性探测（§2.1）将得不到确定答案。换 attempt 后，一个 origin 恰对应一次 spawn，探测退化成一个精确的存在性问题。写入的 prompt 文件名 `prompt-${attemptId}.txt`（`runner.ts:38`）也随之天然不覆盖上次的输入，便于事后取证。

### 3.2 `task_recovery`：orchestrator 自己写的 spawn 提交记录

这是 §0-2 的正解，也是本设计唯一的 schema 变更。

```sql
CREATE TABLE IF NOT EXISTS task_recovery(
  task_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  spawn_state TEXT NOT NULL CHECK(spawn_state IN ('intent','spawned','failed')),
  spawn_at INTEGER NOT NULL,
  unknown_ticks INTEGER NOT NULL DEFAULT 0);
```

一任务一行，随 attempt 轮换整行 REPLACE。它与 `tasks` 同库同连接（`store.ts:23-25`），所以它的写入与 `transition` 的写入**可以放在同一个 SQLite 事务里**——这正是 ledger 给不了的东西。

**写入时点：**

1. `startRunner` 决定要真的 spawn 时，**在调用 `spawnRunner`（`orchestrator.ts:65`）之前**，先 `INSERT OR REPLACE` 一行 `(task_id, attempt_id, 'intent', now, 0)` 并**提交**。这一步必须先于 `ensureWorktree` 之后、`spawnRunner` 之前，且必须是独立提交——否则它和 spawn 的先后就没有意义。
2. `spawnRunner` 返回后：ok → `UPDATE ... SET spawn_state='spawned'`；失败 → `spawn_state='failed'`。两者都与随后的 `spawn_ok`/`spawn_fail` transition 放进同一事务。
3. §3.1-3 轮换 attempt 时删除该行。
4. `unknown_ticks` 由 §2.2 独立 `UPDATE`。

**恢复路径按 `spawn_state` 取值分支（`startRunner` 与 `reconcile` 共用）：**

| `task_recovery` 状态 | 含义 | 恢复动作 |
|---|---|---|
| **无行** | 本 attempt 从未走到「打算 spawn」那一步 | 确未 spawn。正常 `ensureWorktree` → 写 `intent` → `spawnRunner`。**不扣预算** |
| `spawn_state='failed'` | cmux 明确拒绝 | 确无进程。走 `spawn_fail`（`store.ts:14` → `blocked(tool_missing)`） |
| `spawn_state='spawned'` | cmux 已接受 | **绝不再 spawn。** 按 §2.1 判定：`alive`→`session_bound` 接回；`exited`→走 evidence；`dead`→`runner_dead`；`unknown`→本 tick 不动作，`unknown_ticks++` |
| `spawn_state='intent'` | **可能已 spawn，必须核实** | **绝不 spawn。** 同上按 §2.1 判定；`unknown` 累计到 12 → `blocked(spawn_unverified)` |

`intent` 这一格是全部设计的重心：崩溃落在「写 intent」与「写 outcome」之间时，我们**知道自己不知道**。把它当作「没 spawn」会双开；把它当作「已 spawn」会在 cmux 其实没启动时永远等下去。所以它既不 spawn 也不判死，只探测；探测在 12 个累计 tick 内不能定论，就交给人（`blocked(spawn_unverified)`，不扣预算，可 `human_reopen` 重置预算为 2）。

**这条记录把「ledger 里查不到」从一个结论降格为一个观测。** 结论只从 orchestrator 自己的库里取。

**残余窗口，如实说明：**

1. `INSERT intent` 提交完成 → 进程被 `SIGKILL` → 从未调用 cmux。此时行是 `intent` 而实际没有任何进程。恢复不会双开（正确），但会花 12 个 tick 探测后 `blocked(spawn_unverified)`，需要人点一次 reopen。**这是把不可逆的双开风险换成了可逆的一次人工确认，是有意的取舍。**
2. cmux 接受了、pi 起来了、但 pi 在发出 `session_started` 之前就崩了 → ledger 永远不会有这个 origin。同样落到 `blocked(spawn_unverified)`。孤儿进程不存在（pi 已崩），但 orchestrator 无法证明这一点，故仍交给人。
3. 单条 `INSERT` 的提交本身依赖 SQLite 的持久性；`schema.sql:1` 已是 `synchronous=FULL`，掉电窗口收敛到 fsync 语义，不再讨论。
4. **无法消除的那一条**：orchestrator 不控制 cmux。cmux 在收到请求与返回结果之间可能已经拉起了 pi；我们只能记录「我发出了请求」，不能记录「进程 X 已存在」。因此 `intent` 的不确定性是**结构性的**，只能被降级（不双开、有界、交给人），不能被消除。**任何声称此处零残余风险的设计都是在撒谎。**

### 3.3 全枚举

`ownedByMe` 为假的行一律跳过，不在下表内。`recovery` 列指 §3.2 的 `task_recovery` 状态。

| # | state | runner_pid | attempt_id | recovery | 可达来源 | 定稿动作 |
|---|---|---|---|---|---|---|
| 1 | `starting` | NULL | 有 | 无行 | `claim` 后、写 intent 前崩溃（`store.ts:62` 写 attempt 与 state 同事务） | `ensureWorktree` → 写 `intent` → `spawnRunner`。**不扣预算** |
| 2 | `starting` | NULL | 有 | `intent` | 写 intent 后、spawn 结果落库前崩溃 | §2.1 探测。`alive`→`session_bound`；`exited`→evidence；`dead`→`runner_dead`；`unknown`→计数，12 后 `blocked(spawn_unverified)`。**绝不 spawn** |
| 3 | `starting` | NULL | 有 | `spawned` | spawn 成功、`spawn_ok` transition 前崩溃 | 同 #2，但 `unknown` 更可能只是摄取延迟；行为一致 |
| 4 | `starting` | NULL | 有 | `failed` | cmux 明确拒绝、transition 前崩溃 | `spawn_fail` → `blocked(tool_missing)` |
| 5 | `starting` | NULL | NULL | 任意 | 只能由 `overload orch advance`（`cli.ts:12`）人工造出 | `blocked(no_attempt)`。今天 `startRunner:60` 在此静默 `return`，任务永远原地不动——这是第二个真实停滞 |
| 6 | `starting` | 有 | 有 | 任意 | 修好 §3.1-3 后**不可达**（`runner_dead→starting` 会清 pid）。**旧库遗留行仍可能有，且必无 `task_recovery` 行** | 视同 `intent`（最保守），按 §2.1 判定；**不因「无行」而 spawn**。见 §6 的旧库兼容规定 |
| 7 | `running` | NULL | 有 | `spawned` | `spawn_ok→running`（`store.ts:14`）后尚未绑定 | 现状即正解：`pollBinding`（`orchestrator.ts:80-86`），12 tick 后 `bind_timeout`，`retry_budget<=0` 时 `blocked`（`orchestrator.ts:85`、`store.ts:37`）。**不改** |
| 8 | `running` | NULL | NULL | 任意 | 人工 `advance` | `blocked(no_attempt)`。今天 `pollBinding:81` 直接 `return`，永久停滞 |
| 9 | `running` | 有 | 有 | `spawned` | 正常绑定后，进程在跑 | 判定 **alive** → 只续租，无动作 |
| 10 | `running` | 有（进程已消失） | 有 | `spawned` | runner 正常退出 | 判定 **dead**，但先按现状采 evidence → `runner_exit`（`orchestrator.ts:73-77`）。**reconcile 不抢这一格**，交给 `pollRunning`：进程消失的常态是「跑完了」，不是「崩了」，硬判 `runner_dead` 会把成品丢掉 |
| 11 | `running` | 有（pid 活，属无关进程） | 有 | `spawned` | pid 回收 | 判定 **dead** → `runner_dead`。今天 `pollRunning:72` 的 `defaultPidAlive(pid)` 为 true 便 `return`，任务永久停在 `running`——**reconcile 存在的全部意义就是这一格** |
| 12 | `running` | 有（pid 活，有 `session_ended`） | 有 | `spawned` | pi 已结束、cmux 壳未退 | 判定 **exited** → 走 evidence 采集，同 #10 |
| 13 | `running` | 有 | 有 | 任意 | ledger 不可读 / 探测 `unreadable` | **unknown** → §2.2 持久计数，累计 12 tick 后 `blocked(liveness_unknown)` |

**reconcile 的最终职责收敛为三件事**：判定 #6/#11/#12/#13 这些 `pollRunning`/`startRunner` 结构上看不见的格子；驱动 #2/#3/#4 的 spawn 恢复分支；按 §1.1 续租。其余交给已有的 tick 路径，不重写。

---

## §4 决策 4：有界恢复

不新增预算机制，只规定既有 `retry_budget`（`schema.sql:10`，默认 2）的消耗口径。

**扣预算（`store.ts:42` 现有逻辑，不改）：** `runner_dead`、`runner_exit` 且 `evidence_complete:false`、`bind_timeout`。三者的共同点是「一次 attempt 真的失败了」。

**不扣预算：**
- #1 的崩溃前重跑：没有 attempt 失败过，只是编排器自己没跑完一步。扣它等于让 orchestrator 的两次崩溃烧光用户任务的重跑机会。
- #13 的 `liveness_unknown` 与 #2 的 `spawn_unverified`：环境/结构性不确定，非 attempt 失败，见 §2.2、§3.2。
- `spawn_fail` / `worktree_fail`：直接 `blocked` / `failed`（`store.ts:14`），本就不经预算。
- `check_absent`：`1ba45da` 起直接 `blocked(no_check)`（`orchestrator.ts:75`、`store.ts:15`、`store.ts:44`），不经预算。装脚本是人的动作，不是可重试的瞬时故障。

**预算耗尽的落点：`blocked`，不是 `failed`。** `targetFor:35` 已实现 `retry_budget>0?"starting":"blocked"`；`blocked_reason` 由 `store.ts:45` 给出 `runner_crash`（`runner_dead`）或 `evidence_missing`（evidence 缺）。`blocked` 是非终态、占该 repo 活跃锁、进入时发一次 gate、由人 `human_reopen` 重置预算为 2（`store.ts:43`）。

`failed` 只保留给不可恢复的结构性失败（`worktree_fail → failed(repo_gone)`，`store.ts:14`）。

**四重限界，无一处无界**：attempt 失败由 `retry_budget` 限；绑定等待由 `BIND_TIMEOUT_TICKS` 限；活性不可判由 §2.2 的**持久** tick 计数限；spawn 不可核实由同一持久计数限。每条都以一个带原因的 `blocked` 收尾，交给人。

**措辞规定**：不得声称「所有路径到达终态」。`blocked` 与 `awaiting_human` 都是非终态且需要人（`store.ts:18`）。正确的说法是「所有路径到达**决策态或终态**」。

---

## §5 决策 5：opt-in 闸门

`scripts/install-launchd.sh` 目前把 orchestrator 排除在默认 `labels` 之外（`scripts/install-launchd.sh:48-50`），需 `--with-orchestrator` 才装。

**本轮之前挂在闸门上的 N6 已经解决。** `1ba45da` 让 `pollRunning` 在 `evidenceReady` 返回 `no_check` 时直接 `check_absent`（`orchestrator.ts:75`），进入 `blocked(no_check)`（`store.ts:15`、`store.ts:44`），不再扣预算白烧两次 runner；`collectEvidence` 也不再把「存在但不可执行的 check」误当作「没有 check」（`evidence.ts:14-17`）。本文早期版本以 N6 为撤闸门的唯一剩余项，该结论已过期。

**可以默认安装的可检查条件**（全部为真才改 `labels='ingest maintenance pull web orchestrator'`）：

1. §7 的测试全部存在并通过，`bun test` 0 fail。
2. `reconcile` 不再包含空循环体，且 §3.3 表中 13 行各有一条可被测试触发的定稿动作。
3. `renewLeases` 带 §1.1 的 owner 谓词，且有测试证明外实例的 tick 不改本实例任务的任何列。
4. §1.3 的围栏落地：有测试证明租约在 await 期间过期后，旧 owner 的 transition 不改 `tasks` 任何一列，且留下 `fence_lost` 事件。
5. §3.2 的 `task_recovery` 落地：有测试证明 `intent` 状态下不 spawn。
6. 静态可查：从 `starting`/`running` 出发不存在任何不落到 `awaiting_human` / `blocked` / 终态的路径——即 §4 的四重限界都有测试覆盖。

**未达标、必须如实说明的剩余项**（N5+N7 落地后仍在）：

- **worktree GC 仍是 CLI，无后台作业**（计划 §3.6，`src/orchestrator/cli.ts:16` 的 `gc` 子命令）。默认安装 orchestrator 会让 `~/.overload/worktrees/` 在无人跑 `orch gc` 时单调增长。这不影响正确性，但属于典型的「默认开启后用户会遇到而今天遇不到」的新问题，且没有任何自动收敛机制。
- **`intent` 的结构性残余**（§3.2 残余窗口 4）。它有界、不双开、以人类决策收尾，但会在罕见的崩溃时序下要求一次人工 reopen。默认安装意味着这条路径会被更多人碰到。
- 本脚本仅 macOS（`install-launchd.sh:42` 要求 `launchctl`），闸门结论不覆盖其他平台。

**结论：N5+N7 按本文落地后，条件 1–6 可达，且正确性方面的阻塞项全部关闭（双开、无围栏租约、活性不可判、无界停滞、N6 浪费）。撤掉 `--with-orchestrator` 的最小剩余工作量 = worktree GC 后台作业一项**，它与本文正交、体量小。本文**不**主张在本轮就撤闸门：撤闸门应与 GC 作业同一轮落地，因为默认开启后无界增长的磁盘占用是一个用户可见的回归，而它今天被闸门挡着。不夸大，也不再把 N6 记为欠账。

---

## §6 决策 6：迁移

**`src/orchestrator/schema.sql` 增加一张表 `task_recovery`（§3.2），不改任何既有表、不加任何列。**

迁移故事，对既有 `~/.overload/orchestrator.db`：

- `openStore` 每次打开都无条件 `db.exec(schema)`（`store.ts:23-25`），而新表用 `CREATE TABLE IF NOT EXISTS`，因此**既有库在下次启动时自动获得该表，无需 `ALTER TABLE`、无需 `PRAGMA table_info` 探测、无需回填**。orchestrator 侧今天一条迁移代码都没有，本文不引入第一条——这正是选「加表」而不是「加列」的原因（对比 `src/ingest/ingest.ts:121-128` 的 `migrateProgressColumn` 那套探测式列迁移的复杂度）。
- 新表在旧库里初始为空。**空行的语义必须定死**：一个处于 `starting`/`running` 的旧任务没有 `task_recovery` 行时，**不得**按 §3.2 的「无行 → 确未 spawn → 直接 spawn」处理，否则升级的那一刻就是一次全库双开。规定：**若任务已带非空 `runner_pid` 或非空 `stable_id`，「无行」按 `intent` 处理**（§3.3 #6）；只有 `runner_pid` 与 `stable_id` 双 NULL 的 `starting` 任务，「无行」才等于「确未 spawn」（§3.3 #1）。这条判据只用 `tasks` 已有的列，不需要任何回填。
- 回滚：旧代码不认识新表，多一张空表不影响其行为，`db.exec(schema)` 的旧版本也不会去删它。降级安全。

其余决策只使用已有列：`owner_instance`、`lease_expires_at`、`heartbeat_at`、`runner_pid`、`runner_boot_id`、`attempt_id`、`stable_id`、`retry_budget`、`blocked_reason`（`schema.sql:4-11`）。

已否决：把 `unknown_ticks` 做成 `tasks` 的新列。同样需要 `ALTER TABLE` 探测迁移；放进本来就要新建的 `task_recovery` 里，代价为零。

---

## §7 测试计划

每条按它守护的可观察契约命名。`src/orchestrator/store.test.ts` 与 `src/orchestrator/orchestrator.test.ts` 已有的 fixture 形态（`mkdtempSync` + 真 git scratch repo + 注入 `worktreeExec`/`runnerExec`）够用，不需要新 helper。

1. **崩溃前 spawn 的任务会被重新驱动，且不烧预算。**
   `starting` + `runner_pid IS NULL` + 有 `attempt_id` + **无 `task_recovery` 行** + ledger 无对应 origin。跑一次 tick。断言：`runnerExec` 恰被调用一次、`task_recovery` 留下 `spawn_state='spawned'`、任务进 `running`、`retry_budget` 仍为 2。

2. **`intent` 状态下，摄取尚未跟上时绝不 spawn。**（守 BLOCKER 1）
   `starting` + `task_recovery.spawn_state='intent'` + ledger **完全没有**该 origin（模拟摄取窗口）。跑一次 tick。断言：`runnerExec` 调用次数为 **0**、状态仍为 `starting`、`unknown_ticks` 为 1。连跑至累计 12 次，断言 `state='blocked'`、`blocked_reason='spawn_unverified'`、`retry_budget` 仍为 2。

3. **runner 存活时恢复不双开。**
   `starting` + `spawn_state='spawned'`，ledger 里预置 `sessions.origin=taskOrigin(...)` 与匹配的活 `session_incarnations`（pid 用 `process.pid`），无 `session_ended`。跑 tick。断言：`runnerExec` 调用次数为 **0**、任务为 `running`、`stable_id` 已回填。

4. **`exited` 与「查不到」可区分。**（守 BLOCKER 3）
   两个子用例共用 `running` + pid 活的任务。(a) ledger 有 session + incarnation + 一条 `journal.kind='session_ended'`：断言判定为 `exited`，走 evidence 采集（产生 `runner_exit` 或 `check_absent`，**不是** `runner_dead`，也**不是** `unknown` 计数）。(b) ledger 无该 origin：断言 `unknown_ticks` 递增且状态不变。两个子用例必须落到不同分支——这正是 `NOT EXISTS` 写法做不到的区分。

5. **租约在 await 期间过期后，旧 owner 写不进去。**（守 BLOCKER 2）
   实例 A 持有一个 `starting` 任务，注入一个在 `spawnRunner` 处挂起的 `runnerExec`。挂起期间把 `lease_expires_at` 改为 `now-1`，用实例 B 跑一次 tick 接管。放行 A 的 await。断言：`tasks` 的 `state`/`owner_instance`/`runner_pid` 均为 B 写入的值，A 的 `spawn_ok` **未生效**；`task_events` 中存在一条 `event='fence_lost'` 且 detail 含 `spawn_ok`；无 `tick_error`。

6. **外实例的 tick 不动本实例的任务。**
   一个 `running` 任务，`owner_instance='other'`、`lease_expires_at=now+60_000`。用另一个 `Orchestrator` 实例跑 tick。断言：该行的 `owner_instance`、`lease_expires_at`、`state`、`updated_at` 四列**逐一未变**，且 `runnerExec` 未被调用。再把 `lease_expires_at` 设为 `now-1` 重跑，断言 `owner_instance` 变为本实例——过期可接管。

7. **pid 被回收的 runner 判死，不是停滞。**
   `running` + `runner_pid=process.pid`（进程活）+ `runner_boot_id` 与 ledger 最新 incarnation 的 `proc_boot_id` **不等**。跑 tick。断言：产生一条 `event='runner_dead'` 的 `task_events` 行、任务回 `starting`、`retry_budget` 由 2 变 1、`runner_pid`/`stable_id` 已被清空、`attempt_id` 与跑之前**不同**、`task_recovery` 行已被删除（守 §3.1-3）。

8. **`liveness_unknown` 的界跨重启仍然成立。**（守 MAJOR 2）
   `running` + pid 活 + `ledgerPath` 指向不存在的文件。跑 6 次 tick，**丢弃该 `Orchestrator` 实例并新建一个**（模拟重启），再跑 6 次。断言：第 12 次后 `state='blocked'`、`blocked_reason='liveness_unknown'`、`retry_budget` **仍为 2**。若计数是内存态，此用例必红。

9. **预算耗尽落到 blocked，不是 failed，也不是循环。**
   `running` 任务 `retry_budget=0`，触发 §3.3 #11 的判定。断言：`state='blocked'`、`blocked_reason='runner_crash'`、`terminal_reason IS NULL`。再跑一次 tick，断言状态不变且未新增 `runner_dead` 事件。

10. **无 attempt_id 的活跃任务被 block，不是静默空转。**
    `starting` + `attempt_id IS NULL`（人工 `advance` 可达）。跑 tick。断言：`state='blocked'`、`blocked_reason='no_attempt'`。守 §3.3 #5/#8——今天这里是 `startRunner:60` 与 `pollBinding:81` 的两个静默 `return`。

11. **旧库升级不双开。**（守 §6）
    构造一个不含 `task_recovery` 行、但 `runner_pid` 非空的 `starting` 任务（升级前的遗留形态，§3.3 #6）。跑 tick。断言：`runnerExec` 调用次数为 **0**。

**回归约束**：`store.test.ts` 的 `illegal event rejected and budgets only documented retries` 串起 `bind_timeout → session_bound → runner_dead → spawn_fail → human_reopen`，其中 `runner_dead` 是从 **`running`** 态发出的（`bind_timeout` 已把任务推到 `running`，`store.ts:14`），因此 §3.1-1 给 `starting` 新加的 `runner_dead` 规则不改变该用例。但 §3.1-3 会让这条 `runner_dead` 顺带轮换 `attempt_id` 并清空 pid 三列——该用例只断言 `retry_budget`，预期仍然通过。§1.3 给 `transition` 加的 `expectOwner` 是**可选参数**，既有直接调用 `transition` 的测试与 CLI 不传，行为不变。实现者必须**跑一遍确认**，不得假定；若确实变红，改期望值而非绕开断言。

---

## §8 未解决与具名接受的风险

一处汇总，便于评审时一眼看完，不散落在正文里。

| 项 | 性质 | 处置 |
|---|---|---|
| `intent` 的结构性不确定（§3.2 残余 4） | 无法消除 | 降级为：不双开、12 tick 有界、`blocked(spawn_unverified)` 交给人 |
| 墙钟跳变影响租约过期（§1.5） | 具名接受 | 向前跳由 §1.3 围栏降级为审计噪声；向后跳导致停滞，无缓解 |
| `ensureWorktree` 非并发安全（`worktree.ts:21-31`） | 已被围栏覆盖 | 两个 owner 竞争 `worktree add` 时输者的 `worktree_fail` transition 必然 CAS 失败（§1.3），不会把任务误推进 `failed(repo_gone)`。不为此加锁 |
| `process.kill` 与 ledger 读不可原子（§2.1） | 无法消除 | 任何矛盾快照一律映射 `unknown`，绝不映射 `dead` |
| worktree GC 无后台作业 | 未解，正交 | 阻塞默认安装，见 §5 |

---

## 修订记录

本节记录相对首版（2026-09-04 初稿）的实质变更及其原因，供评审对照。

1. **基线更新至 `1ba45da`。** 首版基于 `8a59ac7`。`1ba45da` 改了 `pollRunning` 的 `no_check` 路由（新增 `orchestrator.ts:75` 的 `check_absent` 分支）与 `collectEvidence` 的「缺失 vs 损坏」判据（`evidence.ts:14-17`），本文全部行号与结论已按新基线重核。

2. **§0-2 重写：ledger 缺席不再被当作「未 spawn」的证据。** 首版把「ledger 查不到 origin」当作可以安全 spawn 的依据。该推理在摄取窗口内不成立——orchestrator 库与 ledger 是两个进程写的两个 SQLite 文件（`store.ts:23-25` vs `ingest.ts:285-302`），缺席只证明「还没看见」。

3. **新增 §3.2 `task_recovery` 表（BLOCKER 1 的正解）。** orchestrator 在自己的库里、在 spawn **之前**提交 `intent`，之后写 `spawned`/`failed`。恢复据此四分支，`intent` 一律「不 spawn、只探测、有界后交人」。残余窗口（含无法消除的那一条）在 §3.2 末尾明写，不声称零风险。这是本文唯一的 schema 变更，迁移故事见 §6（新建表，`CREATE TABLE IF NOT EXISTS` 自动生效，无 `ALTER`，并为旧库空行定死了保守语义）。

4. **新增 §1.3 围栏（BLOCKER 2 的正解）。** 首版的 owner 谓词只管「本 tick 能碰哪些行」，管不住 await 之后的迟到写入——`transition` 只按 `task_id` 更新（`store.ts:54`）。定稿选「每个 post-await 写入带 owner CAS」，逐条列出必须带围栏的调用点、必须不带的人类通道，以及 CAS 失败时输者的行为（记 `fence_lost`、清内存态、不重试、不改写）。围栏令牌复用 `owner_instance`，因其为每进程 UUID，天然无 ABA，故不新增代次列。

5. **§2.1 改为四值判定 + 一条专用查询（BLOCKER 3 的正解）。** 首版说「给既有绑定查询补一个 `NOT EXISTS` 即可」，那是错的：`resume.ts:18` 的写法把 ended incarnation 排除出结果，排除后「已结束」与「不存在」同形，恰好毁掉要区分的那一对。定稿改为在 `runner.ts` 新增兄弟函数 `probeRunnerLiveness`，用一条 `LEFT JOIN` 语句把 `ended` 作为**返回列**而非过滤条件，并给出完整的结果→四值映射表。`bindRunnerSession` 原样保留，`pollBinding` 不受影响。

6. **§0-3 的因果链更正（MAJOR 1）。** 首版称后果是「采到上一次 attempt 的 worktree 状态」，并把 `pollBinding` 首行的 early-return 当作停滞点。实际路径是：`starting` 任务下一 tick 被无条件重新 spawn（`orchestrator.ts:41`、`:63-67`），随后陈旧的非空 `runner_pid` 让 `pollRunning` 绕开 `pollBinding`（`orchestrator.ts:71-72`），对一个**新 runner 正在并发改写**的 worktree 采证。处方（轮换 `attempt_id`、清 pid 三列）不变，理由换成真实的那个。

7. **§2.2 的 `unknown` 计数改为落库（MAJOR 2）。** 首版把计数留在内存并称「有界，界随重启放大」。那是错的：每 <60s 崩溃一次即可让任务永不 `blocked`，是无界。计数移入 `task_recovery.unknown_ticks`，界变成与进程生命周期无关的累计 12 tick；用 tick 数而非墙钟，顺带免疫 §1.5 的时钟跳变。§7 新增用例 8 专门跨实例重启验证这一点。

8. **新增 §1.5 时钟风险，具名接受（MAJOR 3）。** 首版未提。定稿明写向前跳与向后跳各自的后果，说明向前跳已被 §1.3 围栏降级为审计噪声、向后跳是无缓解的停滞风险，并说明不引入单调时钟的理由。

9. **MINOR 1（`ensureWorktree` 并发）处置：不加锁，归入 §8。** 它只在两个 owner 交接的窗口内可能发生，而输者的 `worktree_fail` transition 必然被 §1.3 的 CAS 挡下，不会把任务误推进 `failed(repo_gone)`。围栏已覆盖，另加锁是净增复杂度。

10. **MINOR 2（读偏斜）处置：由 §2.1 的单语句查询消解。** 首版沿用 `runner.ts:57` 与 `:59-60` 的两条独立 SELECT，可能读到不同的已提交版本。新查询是一条语句，三处数据同快照。`process.kill` 与 ledger 读的非原子性无法消除，故明写「任何矛盾快照一律映射 `unknown`」，并归入 §8。

11. **§5 结论更新：欠账从 N6 换成 worktree GC。** 首版以 N6 未解为撤闸门的唯一剩余项；`1ba45da` 已解决 N6，该结论过期。定稿重列门槛条件（新增围栏与 `task_recovery` 两条），并指出正确性阻塞项已全部关闭，剩余的唯一阻塞是 worktree GC 无后台作业带来的磁盘单调增长。**闸门本轮仍不撤**，应与 GC 作业同轮落地。

12. **§4 措辞更正。** 不再写「所有路径到达终态」；`blocked` 与 `awaiting_human` 都是非终态且需要人（`store.ts:18`），正确说法是「到达决策态或终态」。同时把 `check_absent` 的不扣预算口径按 `1ba45da` 的新行为补入。

13. **§3.3 枚举由 10 行扩到 13 行**，因为 `starting` + null-pid 一格按 `task_recovery` 的四个取值分裂成 #1–#4，另补 #6 的旧库遗留形态。§7 测试由 7 条增至 11 条，新增的四条分别守 BLOCKER 1（用例 2）、BLOCKER 2（用例 5）、BLOCKER 3（用例 4）、MAJOR 2（用例 8）与旧库升级（用例 11）。
