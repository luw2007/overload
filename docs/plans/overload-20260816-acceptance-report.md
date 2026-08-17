# N24 — Web dashboard + native Island 端到端验收报告

日期：2026-08-16 · 执行节点：N24（attempt `n24-a1-2272ED07`）· 分支 `node/n24` · 独立验收，未改动任何 `src/**`、`native/**`、`launchd/**` 文件（本报告为唯一产出）。

## 检查结果

1. **FULL SUITE — PASS**：`bun test`（repo 根）152 pass / 0 fail，679 expect()，19 文件，18.36s。
2. **CLI/web 输出对拍 — PASS**：自建 tmp ledger（3 条 pending request 覆盖三种形态 + q2/q5/orphaned/incident/coverage_gap/telemetry_gap）。`OVERLOAD_LEDGER_PATH=… bun src/cli/overload.ts q1` 与 `curl /api/q1`（同 fixture 上 `startWebServer()` 实例）逐行/逐字段对拍：同一批 3 条请求、同序（failed DESC → created_at → request_uid）；`jump=workspace-42` ⇔ `binding:"workspace-42"`；`[DELIVERY FAILED]` 前缀 ⇔ `failed:true`；`binding:null`+`host:"devbox"` ⇔ `jump=ssh devbox`；`binding:null`+`host:"local"` ⇔ `jump=-`；`detail` 对象含中文逐字节一致；`created_at` ⇔ ISO 时间戳一致。`/api/summary` 计数（q1=3,q2=1,open_incidents=1,coverage_gaps=1,telemetry_gaps=1）与 CLI q2/health 输出一致。
3. **`POST /api/ack/:id` 端到端 — PASS**：POST → `{"acked":true}`；直接用 sqlite3 打开同一 db 文件确认 `requests.state='cancelled'`、`resolved_at=1786942875141`（非空）；第二次 POST → `{"acked":false}`；`/api/summary` q1 计数 3→2。
4. **Swift 构建 — PASS**：`native/island` 下 `swift build`（32.58s）与 `swift build -c release`（30.65s）均成功，**零 warning**（stderr 为空）。
5. **折叠转场重检 — FAIL（本次干净复现：真实渲染 bug，非截图时序假象）**：见 BUG-1。方法学：先 `CGWindowListCopyWindowInfo` 查得 overload-island 窗口（layer=3，on-screen，bounds 694,33 340×36），仅合成鼠标移动（无点击/按键，全部交互累计 <20s 且分多轮、每轮 <6s），用 `CGWindowListCreateImage` 按窗口 ID 截图；辅以仅覆盖面板自身 340×40 矩形的区域截图取证"屏幕上实际合成内容"；设冷启动对照。证据：① 冷启动折叠胶囊截图正常（74 色、100% 不透明）；② 悬停展开正常（340×220、108–175 色、99.5% 不透明，含从 fixture `/api/q1` 拉取的真实行内容）；③ 每次收起后（两实例、+1.3s/+4.6s 复测）窗口截图 = 单一全透明色（1 色、0% 不透明），窗口服务器仍报 on-screen 且 bounds 正确回到 340×36；④ 区域截图像素对拍：收起后区域与"无 island 的纯桌面"平均 RGB 差 0.5，与"可见 island"差 136.3 → **收起后胶囊在屏幕上实际不可见**；⑤ 再次悬停可完整恢复内容（175 色），再次收起再次变空——确定性复现 ×2。owner 此前"无法区分真 bug 还是并发活动假象"的未决项就此定性：**真 bug**（窗口级截图法不受其他窗口/前台切换干扰）。
6. **安全姿态抽查 — PASS**：通读 `src/web/server.ts`：`Bun.serve({ hostname: "127.0.0.1", … })` 为字面量硬编码；`options.port` 与 `~/.overload/config.json` 的 `web_port` 仅影响端口，无任何 env/flag 可覆盖 hostname（`server.test.ts` 亦断言 `server.hostname === "127.0.0.1"`）；实测两个 fixture server `lsof` 均只绑定 `127.0.0.1`。

## Bug 清单（已修复 BLOCKER 8af80b8 之外的新发现）

- **BUG-1（BLOCKER 级——Island 特性核心承诺被击穿）：expand→collapse 转场后胶囊渲染整体丢失**。复现（确定性，两轮 100%）：
  1. `HOME=<tmp> .build/debug/overload-island`（config 指向运行中的 fixture web server）；
  2. 鼠标移入面板 >200ms 触发展开 → 正常（340×220 有内容）；
  3. 移出等待 >300ms 关闭宽限 + 300ms 收起动画（实测 +1.3s 与 +4.6s 均同）；
  4. 观察：窗口仍在窗口列表（on-screen、bounds 340×36 正确），但 `CGWindowListCreateImage` 全透明，屏幕区域截图显示桌面透出——胶囊**从屏幕上消失**；
  5. 再次悬停展开 → 内容完整恢复；再次收起 → 再次消失。
  影响面：首次使用后，常显折叠胶囊（该特性的存在意义）即从屏幕消失，仅悬停命中其原矩形区域才可唤回；轮询与数据链路本身不受影响。
  可疑位置（未修，按任务书留给 owner）：`IslandPanelController.collapse()` —— `panel.animator().setFrame` 缩窗完成后 completion 里的 `contentView.setExpanded(false)`（stack unhide）未产生任何可见重绘；borderless + 非不透明面板在缩窗动画中疑似被窗口服务器丢弃表面，其后无任何事件强制重绘（5s 轮询对相同 `stringValue` 不触发 relayout）。首要尝试：collapse completion 中对 content view 显式 `needsDisplay = true` / `displayIfNeeded()`，或对 panel `setContentSize` 后强制 display。冷启动正常、展开恢复正常的对照与该假设一致。

## 顺带观察（非 bug）

- 共享机器上已有一个 owner 的 `bun src/web/prototype/serve-prototype.ts`（PID 33585）绑定 `127.0.0.1:4871`；与生产默认端口 4870 不冲突，无需动作，验收时我改用 4899 避开。
- CLI 在未设 `OVERLOAD_LEDGER_PATH` 时静默回退读真实 HOME ledger（首次误跑即如此）——与文档一致的设计默认，仅提醒测试者。

## 结论

**5/6 PASS、1 FAIL（BUG-1）**：web 后端/前端/共享查询层/ack 写路径/构建/安全姿态全部达标；Island 在"收起后常显"上存在确定性渲染丢失（BLOCKER-1），修复前不建议上线 island launchd job。
