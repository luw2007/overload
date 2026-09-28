# Overload 上下文管理交互设计说明

原型：`overload-context-interaction-prototype-20260923.html`（同目录，浏览器直接打开）
版本：v5 · 2026-09-23 状态闭环收口

---

## 1. 页面关系与状态流转

```
顶部导航：Now / Inbox / Done / Works / Tasks

Now
 ├─ 等待执行器回执（已提交/执行中，不打断，仅跟踪）
 ├─ 需立即处理（不可逆损失 / 时效将过期 / 高风险异常）

Inbox
 └─ 普通待答 / 普通验收 / 已延期项 / 需要补充信息
    批量已阅（保留原位）/ 批量延期（写 deferUntil）

Done
 └─ 已决策留档 / 已恢复完成 / 系统自动处理（只读回执）

Works（问题空间）
 └─ 根问题树 → 点分支节点开详情 drawer（目标/成功标准/范围/相关决策卡）

Tasks（会话）
 ├─ 活会话 → 回到现场（jump，不重启）
 ├─ 终止 + 三条件满足 → 从检查点恢复（resume）
 └─ 状态未知 → 先对账（四源，不给恢复/重启按钮）
```

单卡状态机：

```
open (Now 或 Inbox)
 ├─ 选选项 → submitted → 等待回执
 │    ├─ 回执成功 → done
 │    └─ 回执失败 → open（回原分区，带错误原因）
 ├─ apply_auth → awaiting_auth → 批准后重检 / 拒绝后换源
 ├─ resume 选项 → 先 validateResume → 通过才 executing
 ├─ narrow → 改向表单 → 保存范围，旧效果标记已取代
 ├─ defer → inbox (deferUntil)
 ├─ 批量已阅 → 保留原位 + read=true
 └─ concurrent → 禁用提交，只能"查看最新状态"或"发起新变更"
```

---

## 2. 各视图：入口 → 动作 → 响应 → 失败路径 → 下一步

### 2.1 Now
- 入口：导航第一个标签。
- 动作：打开 drawer / 主按钮（回到现场 / 从检查点恢复 / 先对账）。
- 响应：分三区渲染；已提交项不混在"需立即处理"里。
- 失败路径：回执失败 → 卡回到原分区（按风险决定 Now/Inbox），带错误原因。
- 下一步：成功归 Done。

### 2.2 Inbox
- 动作：单卡处理 / 批量已阅 / 批量延期。
- 响应：批量已阅标 read=true 不删除；批量延期写 deferUntil；高风险卡不显示勾选框。
- 失败路径：部分失败（项已并发变更/过期）保留原状态并计数提示；已成功项不重复操作。
- 下一步：到期按新风险评估是否唤回 Now。

### 2.3 Done
- 只读回执：决定 / 依据版本 / 后续影响 / 是否留档。

### 2.4 Works
- 新问题：独立根节点，保留目标/成功标准/范围。
- 分支详情：状态、进度（0% 不被当 falsy）、目标、范围、相关决策卡入口。

### 2.5 Tasks
- jump：成功跳回原会话；失败把 runtime 改 unknown 并提示走对账。
- resume：先过 `validateResume`（三条件 + 预算 + 效果对账），不通过不进入 executing。
- unknown：只给"先对账"。

### 2.6 Drawer
- 证据三级展开：short → long → full（loading → ok / error→重试）。
- 选项选中才允许提交；驳回必填意见；narrow/apply_auth/view_site 各走各分支。
- concurrent 卡：提交按钮禁用，只留"查看最新状态"/"发起新变更"。

---

## 3. 能力边界（诚实版）

底层后端已有能力 ≠ 前端可直接接线。下表区分"底层已有"和"前端落地还缺什么"。

| 能力 | 后端底层状态 | 前端落地还需做 |
|---|---|---|
| Now/Inbox/Done 读取 | `GET /api/attention/(now/inbox/done)` 已有 | 直接接 HTTP，无缺口 |
| 决策视图包三级证据 | `GET /api/context/decision-package` 已有 | short/long/full 折叠映射；full 按需取源的 loading/error 状态前端补 |
| jump 活会话 | 后端 jump 入口已有 | 前端需把 jump 结果映射回卡状态（成功/失败/会话过期） |
| resume 检查点恢复 | 恢复输入包装配已有 | 前端需把 `validateResume` 三条件映射到真实 runner/preflight 端点；回执推送通道未定义 |
| 对账四源 | 后端对账已有 | 前端展示层；真实对账进度轮询/WebSocket 未定义 |
| CAS 并发冲突 | 后端 CAS 已有 | 前端需把 revision 不匹配的错误映射成"查看最新状态/新变更"流程 |
| stale/revoked/unavailable | visibility-policy 已有 | 前端文案与禁用态映射 |
| 问题树 CRUD | context-pool 已有 | 新建问题根节点 API 需对齐；分支详情字段映射 |
| 改向 narrow | contract update 已有 | 前端表单 → 后端 contract PATCH；旧效果标记 superseded 的 API 未明确 |
| 产物验收 | 产物列表已有 | 验收提交（approve/reject with reason）端点需对齐 |
| **回执成功/失败推送** | 三入口复验已有，但**推送到前端的通道未定义** | 需新增 WebSocket / SSE / 轮询；原型用模拟弹窗代替 |
| **resume 执行进度回执** | 后端能跑，但**前端如何知道跑完/失败**未定义 | 同上，需新增推送 |
| 批量 ack/defer | API 已有 | 直接接；部分失败的语义需后端返回逐项结果 |
| 高风险卡排除批量 | 纯前端规则 | 按 risk 字段过滤 |

**结论**：底层能力齐全，但**回执推送通道**是本轮前端落地的最大缺口——原型用模拟弹窗演示，真实环境必须补 WebSocket/SSE 或轮询。

---

## 4. 恢复自动化的边界

恢复不能默认可用，必须同时满足：

1. 用户预授权
2. 预算内（`budgetUsed < budgetMax`）
3. 三条件：进程已终止 + 检查点有效 + 运行时支持
4. 效果对账通过（已产生的步骤确认安全）

任一不满足 → `validateResume` 返回失败原因，不进入 executing。
申请授权 ≠ 授权成功；恢复请求 ≠ 恢复成功。

---

## 5. 六类异常在原型中的位置

| 异常 | 卡片 | 用户看到 |
|---|---|---|
| 并发冲突 | n-concurrent | 黄色横幅；旧选项置灰；只能查看最新状态/发起新变更 |
| 证据过期 stale | n-stale | 旧依据行标"已过期"；选项无"强制按旧结论走"，改为"基于新依据发起范围变更" |
| 权限撤销 revoked | n-revoked | 敏感内容"需授权"；申请授权 → awaiting_auth → 批准/拒绝后重检 |
| 源不可用 unavailable | n-revoked | 灰色斜体，不造值 |
| 恢复失败 recovery_failed | n-recovery-failed | 先对账（unknown→confirmed），对账前恢复按钮禁用 |
| 多源矛盾 conflict | n-conflict（在 Inbox） | 两个证据行标来源 A/B |

---

## 6. CLI / 消息渠道边界

CLI / Feishu / Web 投递渠道只是**同一工作项的入口与回流**，不另建状态：
- 同一 item_id + 版本号在哪个渠道打开都指向同一张卡。
- 在 CLI 上延期，Web 端 Inbox 同步看到 deferUntil。
- 不在消息渠道里复制 Now/Inbox/Done 视图，只做深链跳回主界面。

---

## 7. 未决问题

1. 回执推送通道（WebSocket / SSE / 轮询）——前端最大缺口。
2. 新变更流程：已落地为 drawer 内表单（新目标/范围/理由+影响预览），提交后开新版本收据，旧决定保留为历史。
3. 批量延期时间选择：原型固定明天 10:00，是否让用户选？
4. 部分失败批量操作的后端返回格式。

---

## v5 修订要点（2026-09-23）

- **授权批准不再死循环**：批准后模拟复验（成功 live → 回现场；成功 terminated+ck → 可恢复；失败 → 约束已变更）。拒绝后停止请求，卡片保留在列表不自动归档，等待换源/人工处理。
- **恢复失败三步门禁**：效果对账（必须明确选"全部确认安全"或"仍有未知"，不默认安全）→ 重建恢复上下文（成功则新 checkpoint，旧损坏留审计；失败则留卡给换方式/人工出口）→ 三条件+预算校验后才能 resume。
- **新变更真实落库**：startNewChange 开表单（新目标/范围/理由+影响预览），submitNewChange 提交新版本，旧决定保留为历史不覆盖。reloadLatest 用固定 v5 快照不再每次自增。submitNarrow 同步更新关联分支 summary + 变更历史。
- **Now 分区收口**：删除"即将从 Inbox 唤起"预览区，明天到期延期项只在 Inbox。Tasks 页 jump/resume/对账按钮调用同一 handler，与列表卡状态同步。
- **安全**：esc() 补双引号/单引号转义，表单输入含 `"` `'` `<script>` 不注入 DOM。
- **自检**：内置 runPrototypeChecks() 33 项全过，shot.py consoleErrors=None。
