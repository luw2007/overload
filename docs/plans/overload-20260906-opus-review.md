# Overload 人类决策减负方案 — 独立对抗性设计审查

审查对象：`docs/plans/overload-20260906-human-decision-design.md`（127 行，全文已读）
审查基准：`git HEAD = 7aa4214`，`src/` 共 8497 行 TypeScript
证据规则：仅以 `src/` 实际代码与 `*.test.ts` 为实现证据；`docs/plans/*.md`（含 REVIEW*.md）不作已实现凭据。
前置：上一轮 fable 派工在版本门禁处失败，未产出结论，本文不继承既往判定。

**注**：因工具名被上游改写，本审查未能落盘 `docs/plans/overload-20260906-opus-review.md`，全文以此终稿呈交，由协调者回收。无任何源码改动。

---

## 结论

**REQUEST_CHANGES**

方案方向正确：三类事实分离（任务/执行/注意力）、三时刻分离（answered/consumed/effect confirmed）、`unknown ≠ failed`、`ack ≠ answer`、`检查通过 ≠ 充分`，均切中当前实现的真实病灶；§2 选 B 不另造 runtime、§14 拒绝「减少 50%」这类无台账指标，克制且正确。

不放行的原因不是方向错，而是**方案把四个当前已存在的正确性缺陷当成「M0 待建」，未认定它们是「已存在的错误行为 + 已被测试锁死的反需求」**。在 §13 迁移「不改行为，验证重放」前提下，这四项会被原样带过迁移线，M0 验收语句将无法证伪。另有五项 P1 是归属与可测性空洞：写了指标和约束，但未指定承载字段与数据通路。

---

## P0 阻塞项

### P0-1 跨库无 outbox，决策事件双向可丢；M0「发布前后崩溃不丢不重卡」当前不可满足

**设计章节**：§8「源状态变更同事务写 outbox，经既有 spool 发布，ingest 去重」；§11「待发布事件与源状态同库」；§13.2；§14 M0。

**代码证据**：

1. outbox 根本不存在。`grep -rn "outbox" src/` 无输出。`src/orchestrator/schema.sql` 全部 5 张表为 `tasks / task_events / approvals / spool_seq / task_recovery`。

2. 请求侧丢失。`src/orchestrator/approval.ts:15` 先写 `approvals`，`:18` 才 `spool.emit(...,"decision_requested",...)`，二者不在同一事务：

```ts
// approval.ts:15
db.run("INSERT INTO approvals(approval_id,task_id,gate,question,options,requested_at,expires_at) VALUES(?,?,?,?,?,?,?)",[...]);
// approval.ts:18
spool.emit(task.stable_id??taskId,"decision_requested",{request_id:approvalId,...});
```

两句间崩溃：`approvals` 有行、ledger 无 `requests` 行。`consumeAnswers`（`approval.ts:23`）后续 tick 只 `registerTarget` 补 mailbox target，**不补发 `decision_requested`**。该审批在 Now/Inbox 永不可见，直到 24h 后被 `expireApprovals` 静默判死。

3. 结果侧丢失。`approval.ts:25` 中 `transition` + `UPDATE approvals` 在 `db.transaction` 内，`markReceipt`（写 mailbox 库）与 `spool.emit("decision_resolved")` 在事务**之外**，且分属三个 SQLite 文件：

```ts
// approval.ts:25
if(current?.state==="awaiting_human")db.transaction(()=>{transition(...);db.run("UPDATE approvals SET consumed_at=?...");})();
markReceipt(answers,r.receiptId,"applied",now);
spool.emit(...,"decision_resolved",{...});
```

事务提交后、`emit` 前崩溃：任务已推进到 `submitted`，但 ledger `requests.state` 仍为 `'pending'`。`src/shared/queries.ts:150` 的 Q1 条件是 `WHERE r.state='pending'`，该项**永久滞留 Now**，且 `src/notify/nudge.ts:33` 持续把它计入待处理集合——正是 §4「压缩而非转发噪声」要排除的幽灵卡。

4. ingest 只有字节游标，无发布确认。`src/ingest/ingest.ts:151-170` 以 `cursors(file_name,bytes)` 推进，无回写源库通路，§8「消费完成推进发布确认」无落点。

**为什么是 P0 而非待办**：§13.2 要求迁移第 2 步「不改行为」。按字面执行，上述两条丢失路径会原样存活到 M0 验收，验收句「发布前后崩溃不丢不重卡」无实现可测。

**最小修正**：`schema.sql` 增 `outbox(event_id TEXT PRIMARY KEY, session TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, published_at INTEGER)`；`approval.ts:15`/`:25` 两处 `spool.emit` 改为在**同一 `db.transaction`** 内 `INSERT INTO outbox`；`Orchestrator.tick` 末尾读 `published_at IS NULL` → `spool.emit` → `UPDATE outbox SET published_at=?`。`event_id` 用确定性键（`approvalId + ':' + kind`），重发由 `ingest` 的 `insertEnvelope` 幂等键吸收。§13 顺序改为「outbox 先于任何 M0 行为验收」。

**验收场景**：写入合法 `approve` → 在 `transition` 提交后、发布前 `SIGKILL` → 重启 → 断言 (a) `requests.state` 在 ≤2 tick 内非 `pending`；(b) `queryQ1` 不再返回该 `request_uid`；(c) `journal` 中该 `request_id` 的 `decision_resolved` 恰好 1 行。对称地在 `INSERT INTO approvals` 后、发布前 kill，断言重启后 `decision_requested` 恰好 1 行且该项出现在 Now。

---

### P0-2 `checkPr` 观测失败返回 `clean`，且现有测试把该反需求锁死

**设计章节**：§8「观测失败不返回 clean」；§14 M0「gh 失败不 clean」。

**代码证据**：`src/orchestrator/pr.ts:14,17` 两条失败路径都返回 `clean`：

```ts
// pr.ts:14
if (!result.ok) return { status: "clean", detail: "gh pr view failed" };
// pr.ts:17
try { data = JSON.parse(result.stdout); } catch { return { status: "clean", detail: "parse error" }; }
```

`PrStatus`（`pr.ts:3`）只有 `"merged" | "anomaly" | "clean"`，**无 `unknown`**，观测失败在类型层面无处可去。调用方 `orchestrator.ts:189` 对 `clean` 的处理是注释空动作：`// "clean" -> no action, wait for next poll.`。故 `gh` 未登录/限流/网络不可达时任务在 `submitted` 静默滞留，§8「耗尽原项显示无法确认；最后已知状态标过时」无承载。

更关键的是测试把错误行为固化为契约：

```ts
// src/orchestrator/pr.test.ts:63-67
it("gh failure returns clean (no action)", async () => {
  const failExecutor: CommandExecutor = async () => ({ ok: false, stdout: "", stderr: "error" });
  const result = await checkPr("https://github.com/org/repo/pull/1", failExecutor);
  expect(result.status).toBe("clean");
});
```

方案 §14 把「gh 失败不 clean」列为 M0 验收，却未指出它与 `pr.test.ts:63` 直接冲突。执行者按 §13「不改行为」推进会保留该测试，最终大概率是验收让步。

**最小修正**：`PrStatus` 增 `"unknown"`；`pr.ts:14/17` 改返回 `{status:"unknown",detail:"gh_pr_view_failed"|"parse_error"}`；`orchestrator.ts:181` 后增分支，`unknown` 时复用 `task_recovery.unknown_ticks` 预算（`bumpUnknown`/`resetUnknown`，`store.ts:93-94`）有限重试，耗尽后 `blocked_reason='pr_unobservable'`；**删除** `pr.test.ts:63-67` 并替换为断言 `unknown` 的用例。§14 M0 需显式写明「本项需删除既有反向断言」。

**验收场景**：executor 桩返回 `{ok:false,stderr:"gh: command not found"}` → 断言 `status==="unknown"`；连续 tick 至预算耗尽 → 断言 `tasks.blocked_reason='pr_unobservable'`，决策卡文案为「无法确认」而非「进行中」，最后已知 CI 状态被标注过时时间戳。

---

### P0-3 `push` 成功但 PR 创建失败被压成 `push_failed`，已发生效果被谎报为未发生

**设计章节**：§3「部分失败明确展示已发生与未发生的效果」；§5 `effect_state`；§14 M0「push 成功 PR 失败如实卡片」。

**代码证据**：`src/orchestrator/submit.ts:33-36` 先完成 push（真实副作用，远端分支已建）：

```ts
if (!alreadyPushed) {
  const push = await executor("git", ["-C", worktreeDir, "push", "-u", "origin", branch]);
  if (!push.ok) return { ok: false, reason: "push_failed" };
}
```

随后 `gh pr create` 失败时（`submit.ts:73-76`）返回**同一个** `reason`：

```ts
if (!create.ok) {
  if (isToolMissing(create)) return { ok: false, reason: "tool_missing" };
  return { ok: false, reason: "push_failed" };
}
```

`SubmitResult`（`submit.ts:6-8`）只有 `push_failed | tool_missing`，无法表达「push 已成功」。`orchestrator.ts:174` 据此写 `blocked_reason`，`store.ts:47` 映射为 `'push_failed'`。用户看到「推送失败」而远端分支实际已存在——直接违反 §1「不以批准掩盖效果未知」、§3 部分失败展示，以及 AGENTS.md「保留现场连续性」。

**最小修正**：`SubmitResult` 失败分支增 `pushed:boolean`；`submit.ts:74-76` 返回 `{ok:false,reason:"pr_create_failed",pushed:true}`；`orchestrator.ts:174` 透传 `pushed` 进 `TransitionDetail`；`store.ts:47` 的 `reasons` 增 `pr_create_failed:"pr_create_failed"`；决策卡渲染「已发生：分支已推送到 origin/<branch>；未发生：PR 未创建」。

**验收场景**：桩令 `git push` 成功、`gh pr create` 非零 → 断言 `blocked_reason='pr_create_failed'`；断言 `task_events` 最新行 `detail` 含 `"pushed":true`；断言卡片同列已发生/未发生两项，且重试不重复 push（`submit.ts:31` 的 `ls-remote` 幂等分支命中）。

---

### P0-4 `answer=new-task` 与 `answer=rerun` 是零效果终态/空操作，构成「批准掩盖效果未知」

**设计章节**：§1 非目标「不以批准掩盖效果未知」；§5 `effect_state`；§8 三时刻；AGENTS.md「完成必须主动回流」。

**代码证据**：CI 异常门选项为 `["rerun","new-task","abandon"]`（`orchestrator.ts:186`）。状态机见 `store.ts:17`：

```ts
awaiting_human:{"answer=approve":"submitted","answer=reject":"blocked","answer=abandon":"abandoned",
  gate_expire:"blocked","answer=rerun":"submitted","answer=new-task":"done",human_abandon:"abandoned"},
```

1. `answer=new-task` → `done`，`store.ts:49` 令 `terminal_reason='new-task'`。但全仓 `addTask` 调用方只有 CLI：

```
$ grep -rn "new-task\|addTask" src/ | grep -v "\.test\."
src/orchestrator/store.ts:17   awaiting_human:{..."answer=new-task":"done",...}
src/orchestrator/store.ts:27   export function addTask(...)
src/orchestrator/cli.ts:3      import { addTask, ... }
src/orchestrator/cli.ts:10     if(command==="add"){...}
src/orchestrator/orchestrator.ts:186  requestApproval(...,["rerun","new-task","abandon"]);
```

用户选「新建任务」后**无任何新任务被创建**，原任务却标为 `done`——`effect_state` 恒为 `not_started` 却记为完成。§10「无效打断率」「停止延迟」将系统性低估。

2. `answer=rerun` → `submitted`。回到 `pollSubmitted`（`orchestrator.ts:168-190`）时 `task.pr_url` 已被 `push_pr_ok` 置位（`:173`），故 `:170` 的 `if(!task.pr_url)` 不进入，直接落到 CI 轮询。同时 `:187` 在进入 `ci_anomaly` 时 `this.lastCiCheck.delete(task.task_id)`，下一 tick 立即重查。CI 结论未变则再次 `anomaly`——而该门 `approvals` 行已被 `consumeAnswers` 置 `consumed_at`（`approval.ts:25`），`:185` 的 `consumed_at IS NULL` 去重不再命中，于是**新建一个 `ci_anomaly` 审批**。点 `rerun` 得到的不是重跑，而是同一张卡再问一遍，违反 §4「聚合、去重并原地更新」与 §6「无承重变化不重复」。

**最小修正**：
- `new-task`：`store.ts:17` 改为 `"answer=new-task":"abandoned"`，并在 `approval.ts:25` 消费事务内 `addTask(db,task.title,task.repo,task.base_ref)` 创建后继任务，新 `task_id` 写入 `task_events.detail` 与 `decision_resolved` 载荷作为跳转锚点。
- `rerun`：`transition` 在 `event==="answer=rerun"` 时把 `pr_url` 置 `null`（同 `rotateAttempt` 清列写法，`store.ts:56-59`），使 `pollSubmitted` 真正重走 `submitTask`；`submit.ts:31` 的 `ls-remote` 幂等分支保证不重复 push。

**验收场景**：写入 `new-task` → 断言原任务 `state='abandoned'`、`terminal_reason='new-task'`；断言 `tasks` 新增 1 行 `state='queued'` 且 `repo` 相同；断言 `decision_resolved` 载荷含新 `task_id`。写入 `rerun` → 断言下一 tick `submitTask` 被调用（executor 收到 `gh pr list`）；断言连续 3 tick 内 `gate='ci_anomaly'` 行数不增长。

---

## P1 阻塞项

### P1-1 extension 路径从不确认效果，§8 第三时刻无实现

**章节**：§8 三时刻；§10「落实延迟」。

**证据**：`markReceipt` 仅 orchestrator 一个调用点：

```
$ grep -rn "markReceipt" src/
src/decision-bot/mailbox.ts:52   export function markReceipt(...)
src/orchestrator/approval.ts:8   import { ..., markReceipt, ... }
src/orchestrator/approval.ts:25  markReceipt(answers,r.receiptId,"applied",now);
```

extension（`src/extension/overload.ts:519-523`）拿到 receipt 后直接放行/拦截并 `emit("decision_resolved")`，**从不回写** `decision_receipts.applied_at` / `outcome`：

```ts
const payload = await response.json() as { answer?: unknown; actor?: unknown; receiptId?: unknown }
emit("decision_resolved", { request_id: detail.request_id, gated: true, state: "resolved", selected: answer, actor, receipt_id: payload.receiptId })
return answer === "approve" ? undefined : { block: true, reason: `overload approval gate: denied by ${actor}` }
```

`mailbox.ts:29` 的 `decision_receipts` 有 `applied_at`/`outcome` 两列，对 extension 决策永远 `NULL`。§8「消费后无结果先 unknown 核查」无触发条件，§10 落实延迟不可算。

**最小修正**：`overload.ts:521` 与 `:523` 间增一次 `POST /api/decision/receipt/<receiptId>`（新路由内部调 `markReceipt(mailbox,id,"applied"|"blocked",now)`）；放行后工具调用抛错改记 `outcome='effect_unknown'`。§11「extension 效果回报能力关联」需写出该接口，当前仅「关联」二字。

**验收**：extension 门批准放行一次受控工具 → 断言 `applied_at IS NOT NULL` 且 `outcome='applied'`；令工具调用失败 → 断言 `outcome='effect_unknown'`，且该项在 Now 中被重开。

---

### P1-2 §10 全部账本指标缺跨库数据通路，`audit` 只读 ledger

**章节**：§10 九项指标；§11「cli/audit 账本」。

**证据**：`src/cli/audit.ts:87-120` 数据源全在 ledger 的 `journal / requests / current / sessions`，无一处打开 `orchestrator.db` 或 `orchestrator-answers.db`：

```ts
const windowRows = db.query("SELECT ingest_seq, stable_id, at, kind, detail FROM journal WHERE at>=? AND at<=? ...")
const requestRows = db.query("SELECT request_uid, stable_id, state, created_at, detail FROM requests").all()
const q5Rows = db.query("SELECT stable_id, q5_reason FROM current WHERE queue='q5'").all()
```

而「落实延迟」两端点 `decision_receipts.consumed_at` / `applied_at` 在 `orchestrator-answers.db`（`mailbox.ts:7,29`）；「恢复成功率」样本在 `orchestrator.db` 的 `task_recovery.unknown_ticks`（`schema.sql:32-37`）与 `task_events`。§11 说「不依赖跨库事务」，却未指定这些事实如何投影进 ledger。结果是「落实延迟」「恢复成功率」「停止延迟」当前**无数据可算**，方案未指出。

**最小修正**：在 P0-1 的 outbox 事件族中增 `kind='effect_confirmed'`（载荷 `receipt_id / work_id / effect_state / consumed_at / applied_at`）与 `kind='recovery_outcome'`（载荷 `attempt_id / unknown_ticks / 结局`），经 spool→ingest 落入 `journal`；`audit.ts` 从 `journal` 读这两个 kind。§10 补「每项指标必须指明来源 kind 与承载库」，§11 把两事件写进最小实体。

**验收**：跑通一次完整闭环 → 断言 `overload audit` 的「落实延迟」为具体毫秒且等于 `effect_confirmed.applied_at - decision_resolved.at`；对仅有旧数据的会话断言显示 `unknown` 而非 0。

---

### P1-3 `tasks_repo_active` 唯一索引与 §4 契约改版、§9 在途改向冲突

**章节**：§4 契约新版本不覆盖；§9 在途改向；§14 M1「变更失效旧批准」。

**证据**：`schema.sql:14-16` 由 DB 强制每 repo 至多一个活跃任务：

```sql
CREATE UNIQUE INDEX IF NOT EXISTS tasks_repo_active ON tasks(repo)
  WHERE state IN ('starting','running','awaiting_human','submitted');
```

`claim`（`store.ts:85`）在触发 `UNIQUE constraint failed` 时静默 `ROLLBACK TO candidate` 跳过候选。故新 revision 任务无法在旧任务处 `awaiting_human`/`submitted` 时进入 `starting`；且候选排序为 `ORDER BY created_at,task_id`（`store.ts:84`），修订任务永远排队尾。§9 要求「显示暂停/失效任务」，但未说明旧任务是推入 `blocked`（不在索引谓词内，释放锁）还是保持活跃——两种选择对 M1 验收结果完全不同，方案未定。

**最小修正**：§4/§9 补显式规则「契约新 revision 需重跑时，旧 work 必须先经 `human_supersede` 迁入 `blocked` 释放 repo 活跃锁，其未消费批准同事务失效」；`store.ts:13` 为 `starting/running/awaiting_human/submitted` 四态各增 `human_supersede:"blocked"`，`store.ts:47` 的 `reasons` 增 `human_supersede:"superseded"`。

**验收**：repo R 上任务 A 处 `awaiting_human` 且有未消费审批 → 提交新 revision → 断言 A 为 `blocked`/`blocked_reason='superseded'`；断言 A 的审批 `consumed_at IS NOT NULL` 且 `actor='superseded'`；断言新任务 B 下一 tick 被 `claim` 进入 `starting`。

---

### P1-4 `human_only` 在实现与实体清单中均不存在，M3 验收无落点

**章节**：§7、§12「human_only 不给 bot」；§14 M3。

**证据**：`src/decision-bot/policy.ts:5` 的 `BotRule` 无任何「仅人工」标记：

```ts
export type BotRule={id:string;consumer_owner:"extension"|"orchestrator";gate:string;effect:string;answers:string[];repo?:string;cwd?:string;command?:string;path?:string};
```

`matchingRule`（`policy.ts:10`）是纯白名单匹配，语义为「未匹配则 bot 不出手」。这与「显式标记某类决策永不可自动化」不等价：白名单默认拒绝可被后续新增的宽规则意外覆盖，而 `human_only` 应是不可被规则覆盖的硬否决。§11 最小实体清单（`works / contract_revisions / attention_items / attention_events / outbox`）也未留字段。

**最小修正**：§11 为 `attention_items` 增 `human_only INTEGER NOT NULL DEFAULT 0`；`mailbox.ts` 的 `approval_targets` 增同名列并由 `registerTarget` 透传；`policy.ts:10` 的 `matchingRule` 首行增 `if(target.humanOnly)return null;`，先于任何规则匹配否决。

**验收**：注册 `human_only=1` 的 target，同时配置在 `gate/effect/answers/repo` 上完全匹配的启用规则 → `DecisionBotService.tick()` → 断言 `bot_attempts`、`bot_proposals` 均无新行；随后写入人工答案 → 断言 `consumeDecision` 正常产出 receipt。

---

### P1-5 提醒无有效期阈值与紧迫度分级，§6 的「Now vs Inbox」在 notify 层不存在

**章节**：§5 Now/Inbox 判据；§6 四级确定性排序、有效期阈值提醒。

**证据**：`src/notify/nudge.ts:33-44` 把**所有** pending 请求与 hung 会话不加区分合成一个集合，出现任一新 id 就通知：

```ts
const q1Ids = queryQ1(db).map(r => `q1:${r.request_uid}`);
const hungIds = queryHung(db).map(r => `hung:${r.stable_id}`);
currentIds = new Set([...q1Ids, ...hungIds]);
for (const id of currentIds) { if (!previous.has(id)) { hasNew = true; break; } }
if (hasNew) await deps.notify(`${currentIds.size} 项待处理 — 打开 http://127.0.0.1:4870/now`);
```

`queryQ1`（`queries.ts:139-155`）排序为 `ORDER BY r.created_at DESC`，既无 §6 四级排序，也不读 `expires_at`——`requests` 投影无该字段，而 `approvals.expires_at`（`schema.sql:26`）在 orchestrator.db，nudge 不打开该库。故「临近失效」这一 Now 核心判据在提醒与排序两处都无数据。§6 写「新增 Now 聚合提醒」，但聚合提醒已存在，真正缺的是**分级与失效感知**，措辞掩盖了差异。

**最小修正**：§6 改述为「改造既有 `nudgeOnce` 而非新增」；要求 `decision_requested` 载荷中的 `expires_at`（`approval.ts:18` 已在发，`queries.ts` 未投影）落入 `requests` 新增列 `expires_at`；`queryQ1` 增 `urgency` 计算列（失效剩余 < 阈值 或 detail 含扩大风险证据 → `now`，否则 `inbox`）并按 §6 四级排序；`nudge.ts:44` 仅对 `urgency='now'` 的新增项通知。

**验收**：创建 `expires_at` 为 24h 后的普通审批 → 断言 `nudgeOnce` 返回 `notified:false` 且该项在 Inbox；时钟推进到剩余 < 阈值 → 断言恰好 1 次通知且升入 Now；再推进 1 周期无新事实 → 断言 `notified:false`。

---

## 非阻塞项

1. **§7「bot 停用不阻塞合法人答」当前已成立**，应标注「已具备，仅需回归保护」而非待建。证据：`mailbox.ts:47` 的 `COALESCE(c.disabled,0)=0` 只作用于 `bot_proposals` 子查询，`:46` 的人工答案查询不受影响。

2. **§5「旧 ack 不是真回答」当前被 `ackRequest` 违反**。`queries.ts:248` 将 `requests.state` 直接置 `'acked'`，与真实答案共用同一 `state` 列，Q1 因此不再返回该项——「已读」等价于「已决策」。建议在 §13.7「ack 非 answer」处补明需拆列（`ack_at` 独立于 `state`），否则迁移第 7 步无可执行判据。

3. **`spool.emit` 每次调用都 `BEGIN IMMEDIATE` 并 `statSync`**（`spool.ts:19,25`），outbox 引入后发布循环会放大开销。建议发布循环批量提交而非逐条事务。

4. **`checkPr` 的 24h stale 判据使用 `Date.now()`**（`pr.ts:41`）而非注入时钟，与 `orchestrator.ts` 全程传 `now` 不一致，会使 P0-2 验收用例难以确定性构造。建议改为参数。

5. **`macNotify` 在非 macOS 上静默失败**（`nudge.ts:51` 的 `osascript`），与 §6「缺通知能力显式显示」不符。建议增 `which osascript` 探测并暴露到 `/api/health`。

6. **§14 里程碑依赖 `M0→M1→M2/M3→M4` 合理**，但 M0 五项验收中三项（P0-1/2/3）实为修既有缺陷、一项（P0-4）为补缺失效果，仅「三时刻」「runner 证据」属新建。建议拆为 `M0a 缺陷修复（含删除反向测试）` 与 `M0b 新建能力`，使 §13.2「不改行为」只约束 M0b。

---

## 复核清单（下一轮需在方案文本中看到，而非代码）

- §8/§13 明确 outbox 先于任何 M0 行为验收落地，并写出 `event_id` 幂等键构造
- §14 M0 显式声明需删除 `src/orchestrator/pr.test.ts:63-67` 这一反向断言
- §3/§14 M0 把「push 成功 PR 失败」的双字段（已发生/未发生）写进决策卡最小载荷
- §5/§8 为 `answer=new-task` 与 `answer=rerun` 各写明 `effect_state` 迁移与后继任务归属
- §11 把 `effect_confirmed` / `recovery_outcome` 写进最小实体，§10 每项指标标注来源 kind
- §4/§9 写明契约改版时旧 work 的 `human_supersede → blocked` 释放规则
- §11 实体清单为 `human_only` 留列
- §6 改述为「改造 nudge」并要求 `expires_at` 投影进 `requests`