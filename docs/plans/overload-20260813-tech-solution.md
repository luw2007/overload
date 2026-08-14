# Overload 技术方案（最终版，sol 对齐 ALIGN @ R7）

管理两台机器（本机 + devbox）上 100+ agent session 的注意力路由系统。
研究基础：`docs/research/overload-20260813-*.md`。对抗评审：`codex_gpt/gpt-5.6-sol` 七轮（R1-R6 OBJECT 共 11 blocker + 18 major + 12 minor 全部消解，R7 ALIGN）。消解映射见 §9。取代 `overload-20260813-ledger-design.md`（其 §2/§5 队列与 schema 骨架被本方案 §2.3/§2.4 吸收修订）。

## 0. 目标与验收

| 指标 | 目标 | 验证 |
|---|---|---|
| 人工触点 | ≤30 决策/天 | `queue_transitions` 表统计（reducer 版本化，指标可重放） |
| 结构化等待事件推送延迟 | p95 ≤30s（本机）/ ≤2min（devbox）；计时：源机事件 `at` → outbox `sent_at` | notifications outbox |
| 漏报 | **受管类** 0 漏报，**显式降级区间除外**（events_dropped/扩展禁用区间计为 coverage gap 事件，进健康报告，不得静默）；非受管类列名单 + 启发式误漏率报告 | 注入测试 + 健康报告 |
| terminal session 可查 | 100%（每日备份 + 备份后封段/active 重放） | 恢复演练 |
| 提交归因 | 归因宇宙 = 观测到 session 的仓库 ∪ 配置清单；宇宙内提交 100% 进报告（置信度分级），无归因告警 | 归因报告抽查 |

非目标（v1）：审批拦截门（v2 开关）、web UI、cmux pi Feed 桥、多用户、trailer 强制 100%（P4 后随 git 执行边界立项）。

## 1. 架构

```
事件源（push, 每 writer 独占、代际命名文件）
  overload.ts × {pi,omp,prime} × {local,devbox}   claude hooks 脚本(devbox)
        │ 序列化异步 append；active-<writer>-<n>.ndjson → seal → seg-<writer>-<n>.ndjson
        ▼
  ~/.overload/spool/<host_id>/<writer_id>/
        │ 本机: 2s 轮询    devbox: flock 单飞 rsync 拉 seg-* 与 active-*（重叠靠事件唯一键去重）
        ▼
  ingest（launchd 常驻，单进程）
        ├─ cmux workstream.jsonl（代际化字节游标，§2.9）
        ├─ 对账快照（60s：herdr/orca CLI + ssh devbox + 进程存活）
        ▼
  ledger.db（SQLite WAL）
    输入侧: journal(append-only) + cursors
    派生侧: requests + incarnations + attachments + current
            + queue_transitions + notifications(outbox) + reducer_cursor
        ▼
  reducer（事务化推进，§2.4b）→ classifier → Q1..Q5 → sinks + CLI
watchdog（launchd 独立脚本，monotonic + 唤醒感知）
```

原则：push for latency, pull for truth；结构化信号才承诺零漏报；LLM 无否决权；**事件唯一键是全系统去重的地基**——传输、恢复、重放全部靠它幂等。

## 2. 契约详设

### 2.1 事件与身份（B-1/B-5 终解）

- **emitter 与 writer 分离**（R3-B1）：`emitter_id = <runtime>-<pid>-<proc_boot_id前8>` 标识写文件的进程（一个文件仅一个 emitter，事件唯一键用它）；`writer_id` 标识**代际租约**（liveness/orphaning 域）。pi/omp/prime：emitter ≡ writer（长命进程）。claude：hook 进程短命，`writer_id = claude-<session-uuid>`（session 级逻辑租约），各 hook 进程是独立 emitter 写各自文件；claude 代际生死只由 lifecycle 事件裁定（completed/session 退出），**不做进程存活推断**——`dead_incarnation` 规则仅适用于进程域运行时；claude pending 请求 orphan 仅两源：所属 emitter 死亡（SIGKILL 中断阻塞 hook）或 session 级终止事件。
- **文件代际命名**：emitter 写 `active-<emitter_id>-<n>.ndjson`（n 为 emitter 内段号），封段 rename 为 `seg-<emitter_id>-<n>.ndjson`（30s / 1MB / 进程退出先到）。**路径永不复用**：cursor 按唯一文件名记录，新段新文件名，无 offset 继承 bug。
- **active 文件可安全消费与传输**：解析只接受换行终止完整行；事件唯一键 `(host, emitter_id, seq)`（journal UNIQUE，seq 为 emitter 内单调），active 快照与其后封段的重叠读取被约束去重。因此 rsync **同时拉 seg-\* 与 active-\***——死 emitter 的尾部数据不搁浅，无需 devbox janitor。封段仅服务保留策略与备份单元。
- **孤儿 active 清理**（仅整洁性，非正确性）：本机 ingest 对 mtime>24h 且 emitter 进程判死（§3）的 active 就地 rename 为 `seg-…-recovered.ndjson`。
- **包络**：`{v:1, at, host, runtime, session, emitter_id, writer_id, seq, kind, dropped_total, write_error_total, ...}`——单调计数器随**每个事件**携带（R5-B2）：任何丢失在其后第一个成功事件即暴露；emitter 死亡尾部 gap 只需覆盖 [最后入账事件, 判死]，无检查点间隙。
- **原子入账**：同事务写 journal 批 + 推进 `cursors(file_name → bytes)`；崩溃重扫由 UNIQUE 去重。
- `stable_id = <host_id>:<runtime>:<session-uuid>`；`session_incarnations(stable_id, writer_id, liveness_domain, pid, proc_boot_id, started_at, last_seen_at)`，`liveness_domain ∈ {process, lifecycle}`；resume=同 stable_id 新 writer_id；fork=新 session-uuid 携 `forked_from`。
- `host_id` 来自 `~/.overload/host` 配置（`local`/`devbox`），非 hostname。

### 2.2 请求生命周期（B-2 终解）

`requests(request_uid TEXT PRIMARY KEY, stable_id, writer_id, origin_emitter_id, request_id, kind, state, created_at, resolved_at, detail)`：
- `request_uid = <stable_id>#<writer_id>#<request_id>`——**全局唯一，notifications/CLI/digest 一律用 request_uid**。
- 双所有权（R3-B1 终解）：`writer_id` = 所属代际，代际按 liveness_domain 判死 → 其 pending 转 `orphaned`；`origin_emitter_id` = 发起进程，**emitter 死亡是独立的请求终结条件**——只 orphan 该 emitter 的 pending 请求，不动 writer 租约（claude 阻塞 hook 被 SIGKILL 即此路径，session 级 writer 不受影响）。resume 后旧代 pending 不被新代继承。
- `request_id` 来源：pi 系 = SDK `toolCallId`；cmux = 原生 `requestId`；claude 见 §2.8。
- 状态机 `pending → resolved | cancelled | timed_out | orphaned`，幂等迁移；乱序先见终态则建即终态行；重复 status 行无害（同 uid 同态跳过）。
- **终态优先级与排空宽限**（R5-B1/R6-B1）：`orphaned` 是**推断**终态，`resolved/cancelled/timed_out` 是**源**终态；任一源终态可覆盖推断终态（允许迁移 `orphaned → {resolved, cancelled, timed_out}`，须由源事件背书，幂等）；源终态之间不可互迁。emitter 判死不立即 orphan：reducer 延迟至 {判死 + 排空宽限 5min ∧ 该 emitter 全部已知 spool 文件消费至 EOF} 后执行——已写出但未入账的 resolution 先于 orphan 到达；即便乱序，覆盖规则兜底。

### 2.3 受管/非受管（B-3，含 R2 限定）

受管 = 使用结构化等待原语（pi 系 ask 工具 / claude needs_input+PermissionRequest / cmux Feed 三类卡），承诺零漏报；**降级区间除外且必须显式**（R3-B5 终解，可见性双保险）：(1) **心跳携带单调累计计数器** `dropped_total`/`write_error_total`——任何丢失或写失败区间在下一条成功心跳中必然暴露（计数器跳变），emitter 存活期内无静默窗口；(2) **emitter 死亡自动生成尾部 coverage-gap 记录**：`dead_incarnation`/emitter 终结时，reducer 对 [该 emitter 最后入账 seq, 判死时刻] 区间登记保守 gap（未 flush 的计数器丢失即被此规则覆盖——尾部完整性本就不可证，故一律记 gap）。两者合并使"损失永远可见"成为构造性保证而非尽力而为。非受管 = 装扩展但不用结构化原语：`overload unmanaged` 报告 + `maybe_waiting` 提示位（不入零漏报承诺）。治理：orchestration-policy 增补"需人决策必须走 ask 原语"。

### 2.4a reducer 状态语义

- 状态 `working | idle | awaiting_human | done | failed | vanished`，按 writer_id 维护，session current = 最新代际投影。
- 生命周期映射（V-2' 行为矩阵冻结前为先验）：`agent_start/turn_start→working`；`agent_end/agent_settled→idle`（settled ≠ done）；`session_shutdown→done`（其 pending 请求→orphaned）。
- 单调性：扩展事件 > 对账快照（活状态）；终态 sticky，迟到事件只入 journal 不复活；`vanished` 仅由完整对账快照裁定；恢复只能以新 writer_id 出现。
- origin：`OVERLOAD_PARENT` env（分发注入）> orca `parentWorktreeId`（cwd↔worktree join，对账绑定）> unknown；**unknown 按 agent 处理**（进 Q2，永不 Q4）。
- 心跳：working 态 writer ≤60s 一条（含模型长调用期，由 turn 计时器兜底）；各状态最大静默期入映射表。

### 2.4b 派生状态推进契约（N-3 终解）

- **派生数据不入 journal**。journal 只收源事件（spool/cmux/对账），是 reducer 的唯一输入。
- reducer 推进协议：单事务内完成 {读 journal (reducer_cursor, batch]，更新 current/requests/queue_transitions，写 `reducer_cursor = last_seq`}。崩溃即整批回滚，重启从 cursor 续推——原子、幂等、无半状态。
- `queue_transitions(subject, queue, direction, at, source_seq, classifier_version)`：由 reducer 事务内写入，幂等键见下。

- **重放与版本确定性**（R3-B4 终解）：派生表**重放时不清空**。`queue_transitions` 追加式、幂等键 `(subject, queue, direction, source_seq, classifier_version)`。**classifier 激活本身是源事件**：ingest 在版本切换时向本机 admin spool（`spool/local/overload-admin/`，emitter=ingest 自身，与普通事件同管道同备份同保留）追加 `classifier_activated{version, at}` 行——激活水位因此存在于可重放的源历史中，"最近备份 + 其后 seg 重放" 必然恢复备份后的激活点，重放对任意事件的版本选择唯一确定（该事件 seq 之前最近的激活行）。classifier 实现按 version 保留于代码仓（激活行的 version 可映射到 git 历史）。历史行幂等键命中即跳过，指标不改写。
### 2.4c 队列

- Q1 = requests.pending（唯一来源）。
- Q2 = done ∧ origin∈{agent,unknown}；**Q4 v1 关闭**（auto_verified 为 P4 特性）。
- Q3 = working/idle 有心跳。
- Q5 互斥 reason：`stalled`（心跳超时∧存活确认）、`dead_incarnation`（仅 process 域：pid 死∧无 shutdown）、`telemetry_gap`（对账见活 agent 进程∧spool 无对应 writer 或长静默——**这是降级检测的权威路径**，见 §3）、`orphaned_request`。
- source_outage ≠ Q5：host/平台不可达 → 单条聚合 incident，受影响 session 冻结标记，恢复自动消解。

### 2.5 通知 outbox（N-1 终解）

`notifications(notification_uid INTEGER PRIMARY KEY, request_uid, sink, kind, reminder_seq, state, attempt_at, sent_at, retry_count)`，`kind ∈ {initial, reminder}`，UNIQUE`(request_uid, sink, kind, reminder_seq)`（initial 恒 reminder_seq=0，reminder 递增——多次提醒身份确定，重复插入被约束拒绝）（R4-B1），状态机 `pending → attempting → sent | pending(退避重试) | failed_permanent`：
- **入队原子性**（R3-B2）：outbox 行由 reducer 在创建 pending 请求的**同一事务**内插入（outbox 是派生表，§2.4b 事务边界覆盖之）——不存在"cursor 已推进、通知未入队"窗口。
- 投递协议：事务标 `attempting` → 执行 sink → 事务标 `sent`；崩溃间隙 → 超宽限期（30s）的 attempting 重试。**sink 失败非终态**：退避重试（1/5/15min），超 5 次转 `failed_permanent` 并生成持久告警记录（health 报告 + `overload q1` 置顶），永不静默。
- 语义显式 at-least-once：重复良性、漏失不可接受。**提醒 = 独立 outbox 行且防风暴**（R5-B3）：插入条件 = pending 请求 ∧ 该 request 无 pending/attempting 通知行 ∧ now ≥ requests.next_reminder_at；插入与 `next_reminder_at += 15min` 同事务更新——每窗口至多一行，无放大。
- 默认 sink 仅 macOS 通知（herdr notification 为可选副 sink，实测无重复后才开）。跳转来自 `attachments(stable_id, platform, binding, observed_at, valid)`，对账刷新，resume/hibernation 后失效标记。
- digest：tmp+rename；`digests/` 入 .gitignore。

### 2.6 提交归因（B-4 终解，含宇宙定义）

- **归因宇宙**：任一 session 事件的 cwd 所属 git repo ∪ 配置补充清单——完备性可测试。
- v1 观测归因：bash `tool_result` 后 HEAD 变化检测 → `commit_observed{sha,repo}`；对账层扫宇宙内近 24h 提交二次关联。分级 `trailer > head_observed > window_correlated > unattributed(告警)`。
- trailer 注入为增强：`tool_call` 命中保守形态（`^git commit\b` 无 shell 元字符）追加 `--trailer "Overload-Session: <stable_id>#<writer_id>"`；不命中放行。

### 2.7 安全与恢复

目录 0700 / 文件 0600 / O_NOFOLLOW / 路径成分白名单校验。detail：UTF-8 码点安全截断（序列化前）+ 秘钥模式脱敏（配置化）。封段保留 30 天；ledger 每日 `VACUUM INTO` 备份保留 90 天；**恢复 = 最近备份 + 其后 seg/active 重放 + 派生层按 §2.4b 全量重推**；cmux 代际游标随备份恢复后按 §2.9 去重。

### 2.8 claude hooks（devbox）关联协议（B-2.3 终解）

- PermissionRequest 类 hook 是**单进程阻塞模型**（收请求→等决策→输出决策退出），请求与响应天然同进程：脚本启动即生成 `request_id=uuid`，写 `decision_requested` 行；拿到决策/超时写 `decision_resolved|timed_out`（同 id）后退出；被 SIGKILL → 该 **emitter** 判死 → 仅其 pending 请求按 §2.2 emitter 终结条件转 orphaned，claude session 级 writer 租约不受影响。无跨进程映射存储。
- lifecycle hook（needs_input/completed）携原生 session id，直接映射 stable_id。
- V-5 验证矩阵：请求、响应、取消/会话退出、重复投递、resume。

### 2.9 cmux 源代际契约（N-2 终解）

- `workstream.jsonl` 是外部 append-only 文件但可被 `cmux feed clear` 清空：ingest 维护 `source_generations(path, dev_inode, head_fp, fp_len, first_seen, generation_uuid)`。**head_fp 锚定不可变前缀**（R3-B3 修正）：仅当文件出现第一个完整行时建立，`head_fp = hash(首行)`、`fp_len = 首行字节长`——append-only 下首行永不再变，正常增长零误判；建立前 cursor 恒为 0，无可丢数据。**新代际判定：inode 变更 ∨ size 回退 ∨ 已建立的 (fp_len 前缀) 哈希不匹配**——truncate-and-regrow ABA 由首行内容变化捕获（新内容首行必含新时间戳/id）。代际、cursor、head_fp/fp_len 持久于 ledger 并随备份恢复。
- **实施状态（2026-08-15 P3 审查后决策）**：本节代际/双指纹契约在 P1-P3 未实现（v1 本机 cmux 审批可见性由 cmux 自身 Feed 承担，见非目标"过渡路径 C"）；workstream.jsonl 入账排入 P4 实施。契约本身经 sol R5/R6 对齐，实施时照此执行。
- **双指纹闭合 ABA**（R5-B4）：不依赖"clear 后首行必不同"的未证不变量。cursor 推进时同步持久 `cursor_tail_fp = hash(cursor 前最后一条已消费行)`；每轮扫描先回读该行比对——truncate-and-regrow 要静默跳过数据需同时满足：同 inode ∧ size ≥ 旧 cursor ∧ 首行逐字节相同 ∧ cursor 前一行逐字节相同。workstream 行携带唯一 id 与时间戳，双指纹同时碰撞不具备构造可能；任一不匹配 → 新代际、cursor 归零。P2 验收补一项：`cmux feed clear` 后回归验证新代际检出（同时实证首行时间戳不变量，作为纵深而非依赖）。
- **journal 身份**：cmux 源事件 = `(source=cmux, generation_uuid, byte_start)`（UNIQUE）——与 spool 同等重放稳定；备份恢复后重读同代际同偏移，去重成立。
- 请求关联用行内原生 `workstreamId`+`requestId` 映射 `request_uid`；同 requestId 的多条 status 行是多个 journal 事件、幂等迁移同一 request 行（§2.2）。
- v1 不消费 `cmux events` 流（单源）；`<agent>-hook-sessions.json` 仅供对账刷 attachments。

## 3. 扩展工程约束

- 写入：进程内串行异步队列（有界 1000）；溢出与写失败进 **emitter 常驻单调计数器**（非队列项，不可丢弃），随每条心跳携带（§2.3 双保险之一）；handler 零同步 IO 零 throw；目录创建失败 → warn-once + 整体停用。**spool 完全不可写时扩展无法自报**：该路径权威检测在对账层——见活 agent 进程而 spool 无 writer/长静默 → `telemetry_gap`（§2.4c）；短暂中断恢复后由心跳计数器跳变暴露。无干扰 > 无损失，损失可见性由计数器 + 尾部 gap + pull 侧三重兜底。
- 进程身份：`proc_boot_id` 扩展自生成。存活判定：`kill -0` 失败 = 死；存活则比对 comm/二进制名——不匹配 = pid 复用 = 死；无法比对 = inconclusive，只冻结不判死。prime-agent 直接采信其 lease `processStartId`。

## 4. 分期

- **P1 事件主干**：扩展（观测）+ 代际 spool + 原子 ingest + requests + reducer 骨架（§2.4b 协议）+ `overload show`。验收：V-2' 行为矩阵（三运行时 × 事件名集/tool_call 改参保真/shutdown/resume-fork id/写失败降级）；kill -9 ingest 与 writer 各注入一次，重启无重复无丢失、死 writer 尾部可达。
- **P2 队列与通知**：classifier + Q1/Q3/Q5 + outbox + 对账（本机）+ watchdog。验收：六注入（ask 未答/杀 writer/断 spool[验证 telemetry_gap 检出]/平台 CLI 不可达/outbox 两步间崩溃/sink 连续失败[验证退避与 failed_permanent 告警]）行为正确，无告警风暴。
- **P3 devbox**：rsync（seg+active）+ claude hooks（V-5 矩阵）+ attachments 跳转。验收：devbox ask ≤2min；断网 4 轮单 incident；杀死 devbox writer 后其尾部事件仍到达。
- **P4 增强**：LLM digest（只读）+ Q4/auto_verified + 审批门开关 + git 执行边界立项。

## 5. 残余风险

1. SDK 事件 API 三运行时漂移 → 能力探测 + 最小事件集降级。
2. 多 session 同 repo 并发时窗口关联置信度降级 → 报告如实分级。
3. herdr/orca CLI 输出变更 → 对账按 source_outage 冻结，不伤 push 主干。
4. active 文件 rsync 快照可能截断到行中 → 行级解析丢弃残行，下轮拉取补齐（唯一键去重），仅增加延迟不丢数据。

## 9. 评审消解映射

R1：B-1→§2.1；B-2→§2.2；B-3→§2.3；B-4→§0/§2.6；B-5→§2.1/§2.8(rsync)；M-1..M-18/m-1..m-12 → v2 已并入（详见 git 历史 v2 §9）。
R2：B-1 残余（active 代际/死 writer 尾部/命名歧义）→§2.1 代际文件名+active 可传输+writer_id 统一；B-2 残余（代际归属/通知键/claude 关联）→§2.2 request_uid+writer_id 列+§2.8 单进程协议；B-5 残余→§2.1（active 入传输集）；N-1→§2.5 outbox at-least-once；N-2→§2.9 代际契约；N-3→§2.4b 派生不入 journal+事务化 reducer_cursor；B-3 限定→§0/§2.3 coverage-gap；B-4 限定→§2.6 归因宇宙。
R3：R3-B1（claude hook 进程≠代际）→§2.1 emitter/writer 分离+liveness_domain；R3-B2（outbox 入队原子性/failed 终态）→§2.5 reducer 同事务入队+退避重试+failed_permanent 告警；R3-B3（cmux ABA）→§2.9 head_fp 指纹；R3-B4（重放跨版本不确定）→§2.4b 派生表不清空+幂等键+activation 水位；R3-B5（降级自报依赖坏通道）→§3 常驻计数器+对账层 telemetry_gap 权威路径。
R4：R3-B1 残余（请求缺 emitter 归属/SIGKILL 语义矛盾）→§2.2 origin_emitter_id 双所有权+§2.8 措辞修正；R4-B1（reminder 身份）→§2.5 notification_uid+UNIQUE(request_uid,sink,kind,reminder_seq)；R3-B3 残余（<256B 增长误判）→§2.9 首行锚定指纹；R3-B4 残余（激活水位不随备份+spool 恢复）→§2.4b classifier_activated 作为 admin spool 源事件；R3-B5 残余（drop 证据易失/短暂中断不可见）→§2.3 心跳单调计数器+emitter 死亡尾部 gap 构造性保证。
R5：R5-B1（emitter 死亡与迟到 resolution 竞态）→§2.2 源终态覆盖推断终态+排空宽限；R5-B2（gap 检查点间隙）→§2.1 计数器随每事件携带；R5-B3（提醒风暴）→§2.5 next_reminder_at 同事务推进+无未决通知行前置条件；R5-B4（cmux 首行不变量未证）→§2.9 双指纹（首行+cursor 尾行）+P2 实证。
