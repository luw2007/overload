> **历史文档**：本文件描述的部分能力（如 outbox/digest/attrib/Island 原生面板）已从代码中移除，不代表当前实现。

# P4 冻结契约（owner 独占；worker 只读）

依据：tech-solution §2.9（已 sol 对齐的 cmux 契约）/§2.6/§2.4c(Q4)/§2.1(审批门 v2 预留)/§4-P4；REVIEW-P3.md m2。P1-P3 契约有效。

## 模块边界（本批次）

| 路径 | owner | 内容 |
|---|---|---|
| `src/ingest/cmux.ts`（新）+ `src/ingest/ingest.ts`（仅接线）+ `scripts/install-claude-hooks.sh`（仅 m2） | N14 | cmux workstream 入账 + 安装器 .bak 语义 |
| `src/ingest/classifier.ts` + `src/ingest/reducer.ts`（仅 Q4 投影）+ `src/cli/**` + `src/digest/**`（新） | N15 | Q4/auto_verified、digest 生成、CLI 扩展 |
| `src/attrib/**`（新） | N16 | 归因报告模块 |
| `src/extension/overload.ts` | N17 | 审批门 v0 |
| `test/**` | N18 | P4 验收 |
| `src/ingest/schema.sql`、`src/shared/types.ts`、`docs/**`、`.dispatch/**` | Owner 已冻结 | source_generations DDL 已入 master |

跨模块接口（冻结）：
- N15→N16：`src/attrib/report.ts` 导出 `generateAttribReport(db: Database, opts: {sinceMs?: number, repos?: string[]}): AttribReport`；`AttribReport = {rows: Array<{sha, repo, at, grade: "trailer"|"head_observed"|"window_correlated"|"unattributed", stable_id?: string}>, universe: string[]}`。N15 的 CLI `attrib` 子命令只做薄封装打印。
- N14→reducer：cmux 行翻译为**标准 journal 事件**，reducer 零改动消费。

## 协议 12：cmux workstream 入账（N14，严格按 tech-solution §2.9 含实施状态注记的原契约）

- 源：`~/.cmuxterm/workstream.jsonl`（路径配置化 `cmux_workstream_path`，缺失=该源不存在，静默跳过，非 outage）。
- 代际：`source_generations` 表（owner 已建 DDL）。head_fp = 首个完整行 hash（建立前 cursor 恒 0）；新代际判定 = inode 变 ∨ size 回退 ∨ 首行前缀哈希不匹配 ∨ cursor_tail_fp 回读不匹配（双指纹）；旧代际标 retired=1。
- **journal 身份映射（冻结）**：`host='local'`、`runtime='cmux'`、`emitter_id = 'cmux-' + generation_uuid`、`seq = byte_start`（行首字节偏移，同代际内严格单调唯一）——复用 UNIQUE(host,emitter_id,seq) 与既有重放/去重机制，零新约束。
- 事件翻译（仅可执行三类 + 终止，其余行跳过不入账）：
  - `kind=permissionRequest|question|exitPlan` ∧ `status.pending` → `decision_requested`，`session = workstreamId`，`writer_id = 'cmux-' + workstreamId`，detail 携 `request_id = payload.*.requestId`（缺失则 `wsid#byte_start`）、tool_name、摘要（≤500B 截断+脱敏，禁 toolInputJSON 全量）。
  - 同 kind ∧ status 终态（approved/denied/answered/…实测枚举，probe 后映射 resolved/cancelled）→ `decision_resolved` 同 request_id。
  - `kind=sessionStart` → `session_started`；`sessionEnd|stop`（stop=turn 结束非会话终止——**probe 实测后定映射**，宁可不发 session_ended 也不误终止）→ 对应生命周期事件。
- 与 ingest 接线：`scanOnce` 末尾追加 `scanCmux(db, path)`（同一事务模式：行批 + 代际 cursor 同事务推进）。
- m2：install-claude-hooks.sh 首次备份保留（`.bak` 仅在不存在时写，语义与用法文案对齐）。

## 协议 13：Q4/auto_verified + digest（N15）

- classifier v2（CLASSIFIER_VERSION=2，激活按既有水位机制）：**Q4 v1 谓词（冻结，最保守）**：`done ∧ origin∈{agent} ∧ 会话全程零变更证据`——journal 中该 stable_id 无 `commit_observed` 且无 bash/write/edit 类 tool_call/tool_activity 记录（只读会话，如 scout/调研类）。其余 done 仍进 Q2。unknown origin 永不 Q4（既有规则）。
- digest 生成器 `src/digest/digest.ts`：`--once`；读 Q2/Q4 + failed_permanent + health 计数；输出 `~/ai/overload/digests/<YYYYMMDD-HH>.md`（tmp+rename；目录 gitignore 已有）；单批 ≤50，按 q5>q2>q4 排序；每项含 stable_id、摘要（settled 最后文本）、attachments 跳转或 `ssh <host>` 提示、commit 回链（journal 的 commit_observed）。
- **LLM 模式**：`--llm pi`（可选，默认 none）：对每项摘要经 `pi -p --no-session --model <config.digest_model 默认 glm_anthropic/glm-5.2>` 压缩为一行；LLM 只读 ledger 导出的文本，**无写权限、失败回退 raw 预览**（fail-open to raw）。测试只测 none 模式；llm 模式 owner 冒烟。
- CLI：`overload digest [--llm pi]`（调 digest 模块）、`overload q4`、`overload attrib [--since 24h]`（薄封装 N16 接口）。q1 的 devbox 会话 jump 位补 `ssh devbox` 提示（P3 协议 11 的挂账）。

## 协议 14：归因报告（N16）

- 宇宙 = journal 中出现过的 session cwd 所属 git repo 顶层集合 ∪ `config.attrib_repos`；报告窗口默认 24h。
- 分级（§2.6 冻结序）：commit 带 `Overload-Session:` trailer → `trailer`；journal 有同 sha `commit_observed` → `head_observed`；提交时间落在某 agent 会话活动窗（首末事件 ±5min）∧ 同 repo cwd → `window_correlated`（多候选取重叠最长，置信随附）；否则 `unattributed`。
- 纯只读：不写 journal 不写状态；输出结构见接口冻结。git 操作只用 `git -C <repo> log --since ... --format` 与 `%(trailers)`。

## 协议 15：审批门 v0（N17）

- 扩展 config（`~/.overload/config.json` 读一次 + warn-once）：`approval_gate: {enabled: false, block_bash_patterns: string[], block_write_paths: string[]}`。默认 enabled=false（**部署安全：默认零行为变化**）。
- enabled 时 `tool_call` 检查：bash 命令匹配任一 pattern（RegExp）或 write/edit 目标路径前缀匹配 → 返回 `{block: true, reason}` 并 emit `decision_requested` + 立即 `decision_resolved{state:"cancelled", gated: true}`（本地确定性拒绝，无远程等待——v0 无 UDS 通道，诚实记账）。不匹配零开销放行。
- 门自身故障（正则非法等）→ warn-once + 门整体禁用（无干扰优先）。

## 验收（N18）

1. cmux：合成 workstream.jsonl（真实 schema 行，见 probe-findings §3）→ ingest：pending 卡→Q1、status 终态→resolved；`cmux feed clear` 模拟（truncate+新内容）→ 新代际检出、零丢失零重复；重跑幂等。
2. Q4：只读 agent 会话→q4；带 commit_observed 同型会话→q2；classifier v2 激活水位事件存在；重放不改写 v1 历史 transitions。
3. digest：none 模式产出文件、tmp+rename 原子（生成中途 kill 不留半文件）、≤50 截断、排序正确。
4. attrib：四个分级各构造一例（fixture repo 用 mktemp git init + 真实提交）；trailer 优先级覆盖 head_observed。
5. 门：enabled+命中 → block 且 journal 见 requested+cancelled(gated) 对；未命中/disabled → 放行零事件；坏正则 → 门禁用 warn-once、agent 不受影响（真实 pi -p 冒烟）。

## 完成信号

同前：`.done/<attempt_id>` = 最终 sha。
