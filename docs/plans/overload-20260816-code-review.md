# Overload: 独立代码审查 — web dashboard + native Island（N25）

审查范围：`src/shared/queries.ts`、`src/web/**`、`src/cli/overload.ts`、`native/island/**`、`launchd/works.earendil.overload.{web,island}.plist`，对照 `docs/plans/overload-20260816-island-web-design.md`。已知的 N22/N23 BLOCKER（`Q1Row.detail` decode 类型不匹配，fix commit `8af80b8`）不重复报告，仅验证该修复本身及是否存在同类第二处。

## 1. 跨语言契约漂移

**PASS**（BLOCKER 修复已验证正确且完整）。

- `native/island/Sources/overload-island/Models.swift:60-73` 的 `JSONDetail` 是一个自定义 keyed decoder，对任意 JSON 对象逐键尝试 decode 为 `String`，只保留字符串值键，不假设固定 schema。用真实 `/api/q1` 响应形状（`src/web/server.test.ts:59-72` 的 fixture：`detail: { question: "ship?" }`）重放解码通过（本次审查独立构造了一段 Swift 脚本用相同 JSON payload 验证 `[Q1Row]` decode 成功，`stringValues: ["question": "ship?"]`），确认修复有效。
- Island 实际解码的两个端点仅 `/api/summary`（`Summary`）与 `/api/q1`（`[Q1Row]`），与设计文档 §2.3.1"定时器请求 `/api/summary`；展开时额外请求 `/api/q1`"一致——审查范围内没有第三个被 Island 解码的端点需要核对。
- 字段级核对：
  - `Summary`（`Models.swift:3-27`）5 个字段 `q1/q2/openIncidents/coverageGaps/telemetryGaps` 均为 `Int`，与 `src/web/server.ts:83-86` 实际序列化的 `{ q1: number, q2: number, open_incidents: number, coverage_gaps: number, telemetry_gaps: number }` 完全匹配；`decodeIfPresent(...) ?? 0` 是防御性宽松处理，不构成类型不匹配。
  - `Q1Row`（`Models.swift:29-46`）：`requestUID/stableID` 非空 `String` 对应 TS `request_uid/stable_id: string`（非空，匹配）；`host: String?` 对应 TS `host: string | null`（匹配，`queries.ts:60-63` 的 `LEFT JOIN sessions` 可为 null）；`binding: String?` 对应 TS `binding: string | null`（匹配，`queries.ts:62` 子查询无命中时为 null）；`detail: JSONDetail?` 对应 TS `detail: Record<string, unknown> | null`（BLOCKER 已修复，匹配）；`kind: String?` 对应 TS `kind: string`（Swift 侧比契约更宽松，不会因此崩溃，非缺陷）。
- **信息记录（非发现项，非 check 1 范围）**：`Q1Row` Swift 结构体没有声明 `created_at`（`number`）与 `failed`（`boolean`）两个字段——JSON decode 会静默忽略多余键，不会解码失败，Island 折叠/展开态展示逻辑（`IslandContentView.swift:93-121`）确实没有用到这两个字段。设计文档 §2.3.1 对展开态的描述本就只要求"队列计数 + 跳转按钮"，未要求呈现 delivery-failed 状态或时间戳，因此这不算设计漂移，仅记录供参考。

## 2. SQL 注入 / 参数化

**PASS**。

- `src/shared/queries.ts` 全部 9 处 `db.query(...)` 均使用 `?` 占位符 + `.get(...)/.all(...)/.run(...)` 传参绑定（如 `queries.ts:52` `WHERE stable_id=?`、`queries.ts:96` `WHERE request_uid=?`），未发现任何 SQL 字符串拼接 `stableId`/`requestUid`。
- `src/web/server.ts` 所有路由均通过 `queries.ts` 导出的函数间接执行 SQL，服务端自身不拼 SQL 字符串；对 URL path 参数仅做 `decodeURIComponent`（`server.ts:63-65`）后原样传给 `querySession`/`ackRequest`，走参数化路径。
- rg 校验：`queries.ts`/`server.ts` 内无 `${...}` 插入 SQL 模板字符串的用法。

## 3. 写路径范围

**PASS**。

- `src/shared/queries.ts` 中唯一的写语句是 `ackRequest`（`queries.ts:95-98`，一条 `UPDATE requests SET state='cancelled', resolved_at=? WHERE request_uid=? AND state='pending'`）；其余 6 个导出函数（`querySessions/querySession/queryQ1/queryQ2/queryZombie/queryHealth`）全部只读 `SELECT`。
- `src/web/server.ts` 中仅 `POST /api/ack/:request_uid`（`server.ts:91-94`）用 `new Database(ledgerPath)`（可写句柄，用后 `finally` 关闭）；其余全部 GET 路由都经 `withReadonlyDb`（`server.ts:55-57`，`new Database(path, { readonly: true })`）。没有第二个写入端点或第二条可写连接。

## 4. CLI 重构保真度

**MINOR（发现一处已知问题之外的、不同的行为差异，当前生产环境不可触达）**。

- 已知且 owner 已接受的差异（不重复报告）：`detail()` 对畸形 JSON 字符串从"打印原始垃圾字符串"变为静默输出空字符串。
- **新发现（MINOR）**：`src/shared/queries.ts:27-34` 的 `parseDetail` 不仅对畸形 JSON 返回 `null`，也对**合法但非对象**的 JSON 值（数组、数字、布尔、字符串字面量）返回 `null`：
  ```ts
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  ```
  重构前的 `detail()`（`git show 22e11a4^:src/cli/overload.ts`）是 `JSON.parse(value)` 成功即 `JSON.stringify` 打印，不区分对象/数组/原始值——例如 `detail` 列若曾是合法 JSON 数组 `[1,2]`，旧版会打印 ` [1,2]`，新版会静默变成空字符串，且不写任何警告日志。这是与已知的"畸形 JSON"问题**同一症状（静默丢数据）但不同触发条件（合法值 vs 非法值）**的第二处差异，属于 `queries.ts` 共享函数本身而非仅 CLI 格式化层。
  - **当前不可触达**：`src/ingest/ingest.ts:200-201` 在写入 `journal`/`requests` 前强制 `envelope.detail && typeof === "object" && !Array.isArray(envelope.detail) ? envelope.detail : {}`，所以生产环境中不会有一行 `detail` 是数组/原始值的合法 JSON——今天不会触发。但 `parseDetail` 作为通用函数被 `querySession`/`queryQ1`/`queryHealth` 共享，如果未来任何写路径放松这个不变量（或 `incidents.detail` 之类由不同代码路径写入的列出现非对象合法 JSON），这个函数会静默吞掉数据而不报错，属于潜在的隐蔽退化点。

其余 CLI 输出逐条比对（`git show 22e11a4 -- src/cli/overload.ts` diff）：`listSessions/showSession/q1/q2/printQ4/zombie/health/ack` 的打印格式字符串、字段顺序、`\t`/`\n` 分隔符均未改变，仅数据获取从内联 SQL 换成 `queries.ts` 调用；`printQ4` 未被提取（design doc 未要求，保持内联 SQL，`overload.ts:44-48`），与其余函数处理方式不一致但不影响可观察输出。`bun test src/cli/overload.test.ts` 4 项全过。

## 5. 错误处理

**PASS**。

- `src/web/server.ts:74-107` 的整个 `fetch` handler body 被单个 `try/catch` 包裹；`catch` 分支（`server.ts:104-106`）只把异常消息记录到 `console.error`（服务端日志），HTTP 响应体固定为 `{ error: "internal server error" }` + 500，不回传 `error.message`、不回传 stack trace。
- 实测验证（构造指向不存在文件的 `ledgerPath` 复现"DB file missing"）：`GET /api/summary`、`GET /api/q1`、`GET /api/sessions/%` 均返回 `500 {"error":"internal server error"}`，服务器未崩溃，未泄漏 `unable to open database file` 之类的底层消息给客户端（该消息只出现在服务端 stderr）。
- 路由未匹配（`GET /nope`）与会话不存在（`GET /api/sessions/missing`）分别返回文档化的 `404`（`server.ts:107`、`server.ts:88`），与 `server.test.ts:84-90` 断言一致。

## 6. Swift 内存 / 并发

**PASS**。

- `IslandPanelController` 所有闭包（`hoverOpenTimer`/`mouseLeaveCloseTimer` 的 `Timer.scheduledTimer` 回调、`animate` 的 `completionHandler`、`client.fetchSummary`/`client.fetchQ1` 的 completion）均使用 `[weak self]`（`IslandPanelController.swift:47,60,80,88,109,120`），用法一致，未发现遗漏导致的保留环。`pollingTimer` 回调同样 `[weak self]`（`IslandPanelController.swift:39-41`）。
- `SummaryClient` 标注 `@MainActor`（`SummaryClient.swift:3`），但真正跨线程边界的是 `URLSession.dataTask` 的 completion（在后台队列触发）：其内部先在后台线程构造 `Result`，随后**显式** `DispatchQueue.main.async { completion(result) }`（`SummaryClient.swift:38`）才调用调用方传入的 `completion`。`IslandPanelController` 里所有触碰 UI 的代码（`contentView.showRows/showSummary/showOffline`）都在这个 `completion` 闭包内执行，因此在到达 UI 之前必定先经过 `DispatchQueue.main.async`，没有发现遗漏或提前触达 UI 的路径。
- 未发现其他跨线程边界（`Timer`/`NSAnimationContext` 本身运行在主 run loop）。

## 7. launchd plist

**PASS**（`web.plist` 命令与既有约定一致，`island.plist` 一处信息记录）。

- `plutil -lint launchd/works.earendil.overload.web.plist launchd/works.earendil.overload.island.plist` → 两者均 `OK`。
- `works.earendil.overload.web.plist` 命令 `/bin/sh -lc 'exec "$HOME/.bun/bin/bun" "$HOME/ai/overload/src/web/server.ts"'` 与 `works.earendil.overload.ingest.plist`、`works.earendil.overload.notifier.plist` 使用完全相同的结构（同一个 `$HOME/.bun/bin/bun` 解释器路径 + 同一个 `$HOME/ai/overload` 仓库根），`RunAtLoad`/`KeepAlive`/`ProcessType`/日志路径命名模式（`/tmp/overload-web.{log,err}`）也与其余 4 个 plist 一致，未发现路径漂移。
- **信息记录（非 check 7 范围要求，供参考）**：`works.earendil.overload.island.plist` 用字面量绝对路径 `/Users/operator/ai/overload/native/island/.build/release/overload-island`（硬编码用户名），不像其余 5 个 plist 那样用 `$HOME` 展开。因为 Island 是编译产物而非 `bun` 脚本，没有直接可比的既有约定可违反，此项不判定为 finding，仅记录为可移植性观察点。

## 结论

7 项检查：5 项 PASS，2 项 MINOR（均非阻塞、无 BLOCKER/MAJOR）。BLOCKER `Q1Row.detail` 修复验证有效，且审查范围内未发现同类"API 对象字段被 Swift 声明为错误类型"的第二个实例。

```
ALIGN
```
