# P1 冻结契约（owner 独占；worker 只读）

依据：`docs/plans/overload-20260813-tech-solution.md`（sol ALIGN 终版）§2、§3、§4-P1。
执行契约：`src/shared/types.ts`（可执行事实源，与本文件冲突时以 types.ts 为准）。

## 模块边界与独占权

| 路径 | 独占 owner | 内容 |
|---|---|---|
| `src/shared/types.ts` | **Owner（冻结）** | 事件包络、常量、身份类型 |
| `src/extension/**` | N1 | overload.ts 扩展（单文件优先）+ 扩展侧工具 |
| `src/ingest/**`, `src/cli/**`, `src/ingest/schema.sql` | N2 | ingest 守护、ledger、reducer 骨架、`overload show` |
| `test/**` | N3 | V-2' 行为矩阵 + P1 注入验收 |
| `docs/**`, `.dispatch/**` | Owner | 不得改动 |

## Ledger DDL（N2 实现，字段名冻结）

```sql
CREATE TABLE journal(
  ingest_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL, emitter_id TEXT NOT NULL, seq INTEGER NOT NULL,
  at INTEGER NOT NULL, stable_id TEXT NOT NULL, writer_id TEXT NOT NULL,
  kind TEXT NOT NULL, detail TEXT, spool_ref TEXT,
  UNIQUE(host, emitter_id, seq)
);
CREATE TABLE cursors(file_name TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
CREATE TABLE sessions(stable_id TEXT PRIMARY KEY, host TEXT, runtime TEXT,
  session TEXT, origin TEXT DEFAULT 'unknown', cwd TEXT, branch TEXT,
  created_at INTEGER, first_seen_at INTEGER);
CREATE TABLE session_incarnations(stable_id TEXT, writer_id TEXT,
  liveness_domain TEXT CHECK(liveness_domain IN ('process','lifecycle')),
  pid INTEGER, proc_boot_id TEXT, started_at INTEGER, last_seen_at INTEGER,
  PRIMARY KEY(stable_id, writer_id));
CREATE TABLE requests(request_uid TEXT PRIMARY KEY, stable_id TEXT, writer_id TEXT,
  origin_emitter_id TEXT, request_id TEXT, kind TEXT, state TEXT,
  created_at INTEGER, resolved_at INTEGER, next_reminder_at INTEGER, detail TEXT);
CREATE TABLE reducer_cursor(id INTEGER PRIMARY KEY CHECK(id=1), journal_seq INTEGER NOT NULL);
```

要求：WAL；ingest 批 + cursor 同事务；reducer 批 + reducer_cursor 同事务；
requests 状态机含源终态覆盖推断终态（orphaned→{resolved,cancelled,timed_out} 唯一允许的终态迁移）。

## P1 行为要点（实现者必须逐条对照终版方案）

- N1：§2.1 代际文件 + §3 工程约束（串行异步队列、零同步 IO、零 throw、warn-once、计数器随每事件、心跳 ≤60s、ask=decision_requested/resolved、HEAD 观测归因、trailer 保守注入观测模式记录不阻塞）。
- N2：§2.1 原子入账 + §2.2 requests + §2.4b reducer 推进协议 + `overload show <stable_id>`（全事件史 + 当前状态 + pending 请求）。
- N3：§4-P1 验收 = 三运行时行为矩阵（事件名集/tool_call 改参保真/shutdown/resume-fork/写失败降级）+ kill -9 ingest 与 emitter 注入（无重复、无丢失、死 emitter 尾部可达）。

## 完成信号（DISPATCH_DONE）

worker 在自己 worktree 写 `.done/<attempt_id>`（内容 = 最终 commit sha）并确保全部工作已按逻辑单元提交。
Owner 只认与当前 attempt_id 关联的标记文件。
