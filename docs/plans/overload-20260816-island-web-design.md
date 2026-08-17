# Overload: Island + Web 界面设计

新增两个只读优先的界面消费方，共享同一个只读查询层，唯一写路径是 `ack`（既有 CLI 语义的复用，不新增写回能力）。取代 `overload-20260813-ledger-design.md` §9 "不做 web UI" 非目标（用户已批准架构性扩展；ledger/reducer/queue 契约不变）。

## 0. 目标与验收

| 指标 | 目标 | 验证方式 |
|---|---|---|
| 查询逻辑单一来源 | CLI 与 web 对同一份数据输出等价内容 | `web/server.test.ts` 对拍 CLI 文本行与 API JSON |
| Island 悬浮层可见性 | 跨 Space、覆盖全屏应用仍可见 | 手动验证：`collectionBehavior` 含 `.canJoinAllSpaces`/`.fullScreenAuxiliary`，截图确认 |
| 写路径安全 | ack 端点效果与 `overload ack <id>` 完全一致 | 共享同一条 SQL；行为测试 pending→cancelled |
| 无新增写回桥接 | web/Island 均不解除任何 agent 的阻塞调用 | 设计评审 + §2.4 非目标复核 |
| 本机隔离 | web server 不可被局域网访问 | 绑定 `127.0.0.1`；测试对非回环地址请求失败 |

## 1. 架构

```
ledger.db (SQLite, 既有)
      │
      ▼
src/shared/queries.ts   ← 从 src/cli/overload.ts 提取的纯函数（读 + 唯一写 ack）
      │                  │
      ▼                  ▼
src/cli/overload.ts   src/web/server.ts (Bun.serve, 127.0.0.1:<web_port>)
(格式化 + console.log)   │  GET /            → Google Material 风格 dashboard HTML
                         │  GET /api/*       → JSON（同一份 queries.ts 输出）
                         │  POST /api/ack/:id → queries.ts 里的 ack
                         ▼
                  native/island (Swift SPM 可执行文件)
                  NSPanel 悬浮胶囊，轮询 GET /api/summary + /api/q1
```

- `queries.ts` 是唯一的数据形状定义处；CLI 和 web 都是它的消费者，不允许出现第二套 SQL。
- Island 不直连 SQLite：它是 web server JSON API 的瘦客户端，避免第三处查询逻辑。
- 写路径只有一条：`POST /api/ack/:id`，与 CLI `ack` 命令共享同一条 `UPDATE requests SET state='cancelled', resolved_at=? WHERE request_uid=? AND state='pending'`。

## 2. 契约详设

### 2.1 `src/shared/queries.ts`（提取自 `cli/overload.ts`）

把现有 `listSessions/showSession/q1/q2/zombie/health` 的 SQL 部分拆成返回数据（非 `console.log`）的导出函数，签名与现有 `Database` 只读句柄一致：

```ts
export function querySessions(db: Database): SessionSummary[];
export function querySession(db: Database, stableId: string): SessionDetail | null;
export function queryQ1(db: Database): Q1Row[];
export function queryQ2(db: Database): Q2Row[];
export function queryZombie(db: Database): ZombieView;
export function queryHealth(db: Database): HealthView;
export function ackRequest(db: Database, requestUid: string): { changes: number };
```

`cli/overload.ts` 里现有的 `listSessions`/`showSession`/`q1`/`q2`/`zombie`/`health`/`ack` 分支改为调用这些函数并格式化打印；`ackRequest` 需要可写 `Database`，与现有 CLI 的临时可写连接模式一致（CLI 已有 `new Database(path)`（非 readonly）用于 ack 的先例，直接复用）。

### 2.2 `src/web/server.ts`

- `Bun.serve({ hostname: "127.0.0.1", port })`。`port` 来自新的 `loadWebConfig()`（同 `ingest/pull/recon` 现有 `loadConfig` 模式：`config.json.web_port` > 默认 `4870`，非法值回退默认并 warn-once）。
- 路由：
  - `GET /` → 内联 HTML 模板，**视觉方向已定稿：原型 Variant B「统计卡 + 数据表 + 批量操作」（Cloud Console 风格），参照 `src/web/prototype/PROTOTYPE-dashboard.html` 的 `#variant-b` 实现**：顶部 app bar（品牌 + health pill）；4 张统计卡（Q1 待决策 / Q2 已完成 / Zombie / Open incidents，左边框色块强调，异常态用红色）；Material tabs 切换 Q1/Q2/Zombie/Health 四个数据集；数据表格（checkbox 列 + 请求/会话/类型/时间/跳转标识/操作列，行 hover 高亮，`failed` 行左边框标红）；勾选任意行时表格上方浮出 contextual toolbar（已选计数 + 批量 Ack 按钮 + 取消），单行也有独立 Ack 按钮。字体 `"Google Sans", Roboto, Arial, sans-serif`，主色 `#1a73e8`，白底，12px 圆角卡片。+ 一份 `GET /static/app.js`（vanilla JS，`fetch` 轮询 `/api/*` 驱动统计卡/表格重渲染，无构建步骤）
  - `GET /api/summary` → `{ q1, q2, open_incidents, coverage_gaps, telemetry_gaps }`
  - `GET /api/sessions` / `GET /api/q1` / `GET /api/q2` / `GET /api/zombie` / `GET /api/health` / `GET /api/sessions/:stable_id` → `queries.ts` 对应函数的 JSON 序列化（时间戳保留 epoch ms，前端本地格式化，不在服务端拼字符串）
  - `POST /api/ack/:request_uid` → `ackRequest`，返回 `{ acked: boolean }`（`changes===1`）。批量 Ack（toolbar 的"批量 Ack"按钮）不新增端点：前端对已勾选行并发调用该端点逐条 ack，单端点、单语义，避免第二套批量写入路径。
- 每次请求打开只读 `Database`（与 CLI 现有模式一致，避免长驻连接的并发写锁复杂度；SQLite WAL 已支持多读者）；ack 请求单独打开可写连接，用后立即关闭。
- 无鉴权、无 token：绑定回环地址即视为与本机用户信任边界一致（现有 ledger.db 0600 + CLI 本身无鉴权）。**升级触发条件**（代码内注释标注）：机器变为多用户共享或 web_port 需要绑定非回环地址时，必须先加鉴权再放开绑定。
- launchd：新增 `works.earendil.overload.web.plist`，`KeepAlive`，同 ingest/notifier 模式，命令 `bun src/web/server.ts`。

### 2.3 `native/island`（Swift Package，新目录）— 悬停展开（hover-to-expand）

交互模型对齐真实参考产品 flux-desktop 的灵动岛（Electron，`~/ai/claude_space/flux-desktop/src/island/`）：**悬停展开、移开收起**，不是点击切换。本节所有借来的数值都在 §2.3.6 逐条标注 flux-desktop 的 `file:line` 出处；没有出处的值一律是我们自己的既有值，并显式说明。

#### 2.3.1 面板本体

- SPM 可执行 target `overload-island`；`Package.swift` 声明 `platforms: [.macOS(.v13)]`，无外部依赖（AppKit + Foundation 足够，不引入 WebView/第三方库）。
- 启动：`NSApp.setActivationPolicy(.accessory)`（不占 Dock/Cmd-Tab），创建 `NSPanel`：
  - `styleMask: [.nonactivatingPanel, .borderless]`
  - `level: .floating`
  - `collectionBehavior: [.canJoinAllSpaces, .stationary, .fullScreenAuxiliary]`
- 固定顶部居中位置（屏幕宽度居中，顶部留 8pt），折叠态尺寸约 340×36，展开态约 340×220。**视觉方向已定稿：原型 Variant A「暗色玻璃胶囊」，参照 `src/web/prototype/PROTOTYPE-island.html` 的 `#variant-a` 实现**：`NSVisualEffectView`（`material: .hudWindow` 或 `.popover` 配 `appearance: NSAppearance(named: .vibrantDark)`，`state: .active`）叠加 `rgba(28,28,30,.82)` 深色底色，圆角 layer（折叠 999pt 全圆角胶囊 / 展开 20pt 圆角矩形），红点状态指示（`#ff453a` + 阴影模拟发光）。**这两个尺寸是我们自己的既有值，flux-desktop 没有对应物**：它的窗口固定宽度 740，高度在展开/收起边界处切换（初始/上限约 750，`IslandWindow.ts:30-31,40,63-67` 按 `requestedHeight` 调整，并非永久固定在 750 的整窗——N21 审查修正：owner 早期表述为"固定 740×750"过强，源码只保证宽度固定，见 `IslandApp.tsx:3-5`），可见形状靠 CSS `clip-path` 抠出来，尺寸不可直接移植；它另有一个用户可调的展开态最大高度 `ISLAND_PANEL_MAX_HEIGHT_DEFAULT_PX = 540`（范围 200–700，设置页滑杆，`Settings.ts:124-126`、`GeneralTab.tsx:214-220`），我们 v1 不做可配置项，展开高度按内容自适应并以 220 为基准。
- 数据源：`URLSession` 定时器（5s 间隔）请求 `http://127.0.0.1:<web_port>/api/summary`；展开时额外请求 `/api/q1`。`web_port` 读取同一份 `~/.overload/config.json`（与其他模块一致的配置源，避免端口写死或第二套配置文件）。
- 内容：折叠态显示队列计数 + 健康点；展开态列出 Q1 行，每行一个"跳转"按钮 → `NSPasteboard.general.setString(binding, forType: .string)`（把既有的、从不可执行的 `binding` 值复制到剪贴板——与 `digest.ts` 的 `jump()` 展示语义完全一致，不新增执行能力）。**决策边界不变：glance + copy-jump only，不提供批准/拒绝按钮**（§2.4 边界，本节不重新讨论）。
- 网络请求失败（server 未启动/端口不通）：面板显示"离线"态徽标，不重试风暴（沿用 5s 轮询节奏，失败静默降级，不弹窗告警——这是展示层，缺一次数据不算 P2 契约里的 coverage gap）。
- 构建/部署：`swift build -c release` 产出单一可执行文件；新增 `works.earendil.overload.island.plist`（`RunAtLoad`，GUI domain，路径指向编译产物）。

#### 2.3.2 悬停检测：`NSTrackingArea`

面板 `contentView` 上挂一个 `NSTrackingArea`：

```swift
let area = NSTrackingArea(
  rect: .zero,
  options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
  owner: self, userInfo: nil)
contentView.addTrackingArea(area)
```

- `.activeAlways`：面板是 `.nonactivatingPanel`，永远不是 key window，必须用 `.activeAlways` 才能在应用非激活时收到 `mouseEntered`/`mouseExited`（`.activeInKeyWindow`/`.activeInActiveApp` 在这里等于永不触发）。
- `.inVisibleRect`：展开/收起会改 `setFrame`，tracking rect 必须跟随 bounds 变化，否则展开后的新增区域收不到事件、收起后残留区域仍在报 enter。用 `.inVisibleRect` 就不需要在 `updateTrackingAreas()` 里手工重建。
- `mouseEntered` → 启动开启防抖计时；`mouseExited` → 启动关闭宽限计时（见 §2.3.3）。

#### 2.3.3 两个计时器：开启防抖 200ms / 关闭宽限 300ms

直接移植 flux-desktop 的两段延迟（`IslandApp.tsx:53-55`）：

| 计时器 | 值 | 语义 | flux 对应 |
|---|---|---|---|
| `hoverOpenTimer` | ≈200ms | `mouseEntered` 后延迟这么久才展开；期间发生 `mouseExited` 则取消，不展开 | `HOVER_OPEN_DELAY_MS = 200`（`IslandApp.tsx:54`），用法见 `IslandApp.tsx:650-653`（enter 里 `setTimeout(open, …)`）与 `IslandApp.tsx:658-661`（leave 里 `clearTimeout`） |
| `mouseLeaveCloseTimer` | ≈300ms | `mouseExited` 后延迟这么久才收起；期间鼠标重新进入则取消，保持展开 | `MOUSE_LEAVE_CLOSE_DELAY_MS = 300`（`IslandApp.tsx:55`），用法见 `IslandApp.tsx:685-689`（leave 里 `setTimeout(close, …)`）与 `IslandApp.tsx:623-626`（enter 开头先 `clearTimeout`） |

Swift 侧实现（**N21 审查修正**：owner 早期描述遗漏了 flux 的状态守卫，导致对已展开面板重复触发展开、对已收起面板重复触发收起——下面补全）：两个 `Timer?` 成员（或 `DispatchWorkItem`）+ 一个 `isExpanded: Bool` 状态位。`mouseEntered` 里先取消 `mouseLeaveCloseTimer`，**仅当 `!isExpanded` 且 `hoverOpenTimer == nil` 时**才起 `hoverOpenTimer`（对应 flux 只在 `closed` 态才 `setTimeout(open,…)`，`IslandApp.tsx:648-653`）；`mouseExited` 里先取消 `hoverOpenTimer`，**仅当 `isExpanded` 时**才起 `mouseLeaveCloseTimer`（对应 flux 在非 `opened` 态直接 `return`，不排新的关闭计时，`IslandApp.tsx:669`）。两个计时器都必须在对方启动前被取消，且各自触发后必须清空自身引用（`openTimer = nil` / `closeTimer = nil`，见原型 `PROTOTYPE-island.html:190-192,199-201` 已实现的等价逻辑）——这正是 flux 里 enter/leave 两个 handler 开头各自 `clearTimeout` 对方的原因，也是快速来回划过边界不抖动的全部机制；状态守卫补全后不会再对稳定态（已展开/已收起）产生冗余的计时器创建与由此带来的 frame/exited 噪声。

**这两个数值是从 flux-desktop 移植的起点值，不是神圣常量。** flux 自己也把"悬停是否开启"做成了用户开关（`hoverToOpen: boolean`，默认 `true`，`Settings.ts:144` 与 `Settings.ts:435`；另有 `autoCollapseOnMouseLeave: true`，`Settings.ts:154`/`Settings.ts:440`）。我们 v1 不做设置项，但在实现里把两个值提为具名常量（`hoverOpenDelay = 0.2`、`mouseLeaveCloseDelay = 0.3`），实机手感不对时直接改常量即可，不需要改结构。

我们自己加的两条护栏（**flux 没有，属于 AppKit 侧的差异补偿**，因为它的窗口尺寸不随状态变化而我们的会变）：

1. `mouseLeaveCloseTimer` 触发时，再用 `NSEvent.mouseLocation` 与面板当前 `frame` 复核一次"鼠标确实在外面"，为真才收起。防止收起动画/frame 变化过程中产生的假 `mouseExited` 把仍悬停着的面板关掉。
2. 收起动画进行中忽略新的 `mouseExited`（frame 收缩本身会让光标"落到窗外"，AppKit 会补发一次 exited）。

#### 2.3.4 展开/收起动画曲线

用 `NSAnimationContext.runAnimationGroup` 对 `panel.animator().setFrame(...)` 做动画：

```swift
// 展开：带过冲的弹性感
NSAnimationContext.runAnimationGroup { ctx in
  ctx.duration = 0.5
  ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.34, 1.56, 0.64, 1)
  panel.animator().setFrame(expandedFrame, display: true)
}

// 收起：平滑收敛，无过冲
NSAnimationContext.runAnimationGroup { ctx in
  ctx.duration = 0.3
  ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
  panel.animator().setFrame(collapsedFrame, display: true)
}
```

曲线出处：flux-desktop `useIslandAnimation.ts:9-10` —— `is-opening → spring(0.42, 0.8) via cubic-bezier(0.34, 1.56, 0.64, 1) 0.5s`、`is-closing → smooth ease-out 0.3s`；同一组值也写在 `island.css:6-9` 的动画参考头注释里（`Open: spring(response=0.42, dampingFraction=0.8)` / `Close: smooth(0.3s)`）。`cubic-bezier(x1,y1,x2,y2)` 与 `CAMediaTimingFunction(controlPoints:)` 的四元组顺序一致，`(0.34, 1.56, 0.64, 1)` 中 **`y1 = 1.56`**（**N21 审查修正**：owner 早期误标为 `y2 = 1.56`，实际 `y2 = 1`）；`y1 > 1` 就是过冲来源。flux 注释把这条曲线类比为 SwiftUI `spring(response: 0.42, dampingFraction: 0.8)` 的观感，但三次贝塞尔是单段有限缓动，数学上不等价于物理弹簧的振荡响应——这只是"手感类比"，不是等价证明（**N21 审查修正**：owner 早期表述"对应…的手感"容易被误读成数学等价）。

**已核实的一处不一致（以真实代码为准并在此记录）**：flux 仓库里*实际生效*的 CSS 是 `island.css:87-93` —— `.island.is-opening { transition: clip-path 0.26s cubic-bezier(0.32, 0.02, 0.2, 1); }`、`.island.is-closing { transition: clip-path 0.24s ease-out; }`，与上述头注释里的 `0.5s`/`0.34,1.56,0.64,1` 并不相同；注释描述的是设计意图（对齐它们自己的 Swift 版 `OverlayUICoordinator`），实现里换成了更快、无过冲的曲线。我们按任务要求采用注释里的"设计意图"版本（0.5s 弹性展开 / 0.3s ease-out 收起），因为它才是被显式对齐到 Swift spring 语义的那一版；若实机觉得展开偏慢偏弹，`island.css:87-93` 的 0.26s/`(0.32,0.02,0.2,1)` 是有真实出处的备选值。

#### 2.3.5 不移植的两个 flux 机制（含理由）

**(a) click-through / forward-mouse-event 那套 IPC —— 我们不需要，结论明确。**

flux 的做法：窗口默认 `setIgnoreMouseEvents(true, { forward: true })`（`IslandWindow.ts:141`，创建顺序第 5 步，见 `IslandWindow.ts:5-8` 的头注释），renderer 靠被 forward 的 mousemove 检测悬停，进入时发 `ISLAND_ENTER` 让主进程 `setIgnoreMouseEvents(false)` 恢复可交互，离开时发 `ISLAND_LEAVE` 恢复穿透（`IPC` 定义 `shared/ipc.ts:38-39`；主进程 handler `IslandWindow.ts:41-61`；renderer 调用 `IslandApp.tsx:642` 与 `IslandApp.tsx:667`）。

这是 **Electron 特有的补偿**：它的窗口宽度固定 740、高度在展开/收起边界处切换（初始/上限约 750，`IslandWindow.ts:30-31,40,63-67`；见 §2.3.1 已修正的表述），可见的胶囊/面板只是 CSS `clip-path` 从这块黑底里抠出来的形状（`IslandApp.tsx:8-13`）。窗口里绝大部分面积是"看不见但仍属于窗口"的区域，不做穿透就会吞掉用户对底下应用的点击。这个结论不受高度是否永久固定影响——**N21 审查确认**：宽度固定即足以支撑"存在不可见但覆盖的区域"这个前提。

我们的 `NSPanel` 不是全屏覆盖层，它的 frame 就等于可见边界（折叠 ~340×36 / 展开 ~340×220，§2.3.1），窗口之外的点击本来就不经过它。因此 **不实现 `ignoresMouseEvents` 切换，也不需要任何等价的 enter/leave 桥接**——悬停检测直接由 `NSTrackingArea` 完成（§2.3.2），这是 AppKit 原生能力，不需要先让窗口"可接收鼠标"再反查。

唯一残留的小差异：圆角矩形四角那几个像素三角区在 frame 内但视觉上在圆角外，`NSPanel` 会照常接收其事件。若实机发现这几个像素误触发展开，正确修法是在 content view 里 override `hitTest(_:)` 按圆角路径裁剪，**不是**把 flux 那套全窗口穿透 + IPC 往返搬过来。

**(b) 状态图标独立 hover 区（graduated hover zone）—— 跳过。**

flux 的胶囊左侧状态图标有独立于整条胶囊的 `onIconMouseEnter`（`IslandPill.tsx:110` 声明、`IslandPill.tsx:120` 挂在 `.pill-left` 上），其 handler 只做一件事：取消 `hoverOpenTimer`（`IslandApp.tsx:712-716`）。原因是同一个元素还带 `data-drag-handle` 和 `onMouseDown`（`IslandPill.tsx:120`），是"向下拖拽 50px 切成桌宠模式"手势的抓取点（`PILL_DRAG_THRESHOLD_Y = 50`，`IslandApp.tsx:56`）——悬停在拖拽手柄上时要抑制自动展开，否则用户刚要拖就被面板展开打断。

我们的 Island 没有拖拽手势、没有桌宠模式，胶囊整体只有一个语义（悬停 → 展开）。这个分区 hover 是为解决 flux 特有的手势冲突而存在的复杂度，**不移植**：整个 content view 一个 tracking area 即可。

#### 2.3.6 借用常量/机制的出处对照表（可审计）

所有路径相对 `~/ai/claude_space/flux-desktop/src/island/`。

| 我们的取值/做法 | 出处 |
|---|---|
| 开启防抖 200ms | `renderer/src/island/IslandApp.tsx:54`（`HOVER_OPEN_DELAY_MS = 200`），启停见 `IslandApp.tsx:650-653` / `IslandApp.tsx:658-661` |
| 关闭宽限 300ms | `renderer/src/island/IslandApp.tsx:55`（`MOUSE_LEAVE_CLOSE_DELAY_MS = 300`），启停见 `IslandApp.tsx:685-689` / `IslandApp.tsx:623-626` |
| enter 取消 close 计时、leave 取消 open 计时（互斥取消 = 防抖动核心） | `renderer/src/island/IslandApp.tsx:623-626`、`IslandApp.tsx:658-661` |
| 展开曲线 `cubic-bezier(0.34, 1.56, 0.64, 1)` / 0.5s（y1=1.56 是过冲来源；类比但不等价于 SwiftUI `spring(response 0.42, damping 0.8)` 的观感） | `renderer/src/island/animations/useIslandAnimation.ts:9`；同值另见 `animations/island.css:7` |
| 收起曲线 ease-out / 0.3s | `renderer/src/island/animations/useIslandAnimation.ts:10`；同值另见 `animations/island.css:8` |
| 实际生效曲线与上述注释不一致（记录用，非采用值） | `renderer/src/island/animations/island.css:87-93`（0.26s `cubic-bezier(0.32,0.02,0.2,1)` / 0.24s ease-out） |
| 悬停展开是产品默认行为（默认开启） | `shared/types/Settings.ts:144` + `shared/types/Settings.ts:435`（`hoverToOpen: true`）；移开自动收起 `Settings.ts:154` + `Settings.ts:440` |
| 展开态最大高度 540（范围 200–700，可配置）——**我们不采用**，仅作为量级参照 | `shared/types/Settings.ts:124-126`；设置页滑杆 `renderer/src/settings/tabs/GeneralTab.tsx:214-220` |
| click-through + `ISLAND_ENTER`/`ISLAND_LEAVE`——**我们不采用**（§2.3.5a） | `main/windows/IslandWindow.ts:141`、`IslandWindow.ts:41-61`、`shared/ipc.ts:38-39`；成因是全覆盖窗口 `IslandWindow.ts:30-31` + clip-path `IslandApp.tsx:8-13` |
| 图标独立 hover 区——**我们不采用**（§2.3.5b） | `renderer/src/island/IslandPill.tsx:110`、`IslandPill.tsx:120`、handler `IslandApp.tsx:712-716`，成因是拖拽手势 `IslandApp.tsx:56` |
| 折叠 340×36 / 展开 ~340×220、5s 轮询、顶部留 8pt | **无 flux 出处，是本文档既有值，保持不变**（flux 窗口宽度固定 740、高度随开合边界切换，不可直接移植） |

### 2.4 写路径与非目标边界（复核，**本节因新增 jump 执行而修订**）


- `POST /api/ack/:id`（web only；Island 不写）。效果 = 现有 `overload ack`：`requests.state` pending→cancelled，停止提醒，**不向任何 agent 进程发送任何信号**。
- **`POST /api/jump/:id`（web only；Island 仍是 §2.3.1 定义的 glance + copy-jump only，不新增此能力）**：真正把对应终端/窗口带到前台，不是复制文本。见 §2.4a。
- 两者都**不解除任何 agent 的阻塞调用**——jump 只是"把人带到正确的窗口前面"，不代答、不发送任何按键给 agent，因此仍然**不违反** `overload-20260813-ledger-design.md §9` 的"不做 approve/deny 写回桥接"：那一条禁的是代替人做决策，不是禁止把人带到决策现场。

#### 2.4a Jump 执行（真打开，非复制）——按平台分支，逐条有真机依据

参考 flux-desktop `TerminalJumpService.ts`（2061 行，覆盖 15+ 终端/IDE 的生产代码）的分发+兜底哲学：**精确路径失败绝不报错崩溃，永远退化到"至少把 app 拉到前台"**。

| 平台 | 机制 | 依据（本机真实验证） |
|---|---|---|
| herdr | `herdr agent focus <binding>`（`binding` = `terminal_id`，一步直达，无 GUI app，无需 deeplink） | `herdr agent focus --help`：`Usage: herdr agent focus <target>` |
| orca | 三跳查找链：`orca worktree ps --json` 找 `worktreeInstanceId`(=`binding`) 对应的 `path` → `orca terminal list --worktree path:<path> --json` 找 terminal handle → `orca terminal switch --terminal <handle>`。Orca.app **没有注册自定义 URL scheme**（`plutil -p Info.plist` 未见 `CFBundleURLTypes`），且 `--worktree` selector 语法是 `id:<repo-id>::<path>`/`name:`/`branch:`/`issue:`/`path:`/`active`/`current`，**不接受裸 `worktreeInstanceId`**，因此必须经查找链，无法一步到位 | `orca worktree show/terminal list --help` 选项语法；`orca worktree ps` 的 `parseOrca`（`recon.ts:387-388`）证实 `worktreeInstanceId` 与 `path` 是同一行的兄弟字段 |
| cmux | **`open "cmux://workspace/<binding>"`**（`binding` = `workspaceId`）。不用 `cmux` CLI（其 socket 默认 cmuxOnly 鉴权，web server 作为 launchd 后台进程是"外部进程"，大概率被拒——flux 注释原话），也不用 AppleScript（deeplink 更简单且不依赖 sdef）| **本机双重真机验证**：①`plutil -p Info.plist` 确认 cmux 注册了 `cmux://` scheme；②实测 `open "cmux://workspace/<真实UUID>"` 把当前窗口选中的 tab 从 "claudish-to-english" 切到 "grill"（目标 workspace），`exit 0`；③`cmux://workspace/<id>/surface/<id>`（带 surface）与仅 `cmux://workspace/<id>`（不带 surface）两种形式都实测有效；④额外确认 `cmux workspace list --json` 的 `id` 字段与 AppleScript sdef 的 `tab.id` 是同一 UUID（交叉验证过，仅作为 cmux 内部一致性证据，v1 实现不用 AppleScript） |
| local（无 binding）/ devbox（`jump=ssh devbox`，无精确 binding）/ 上述平台调用失败 | 兜底：**不报错、不崩溃**，返回 `{opened:false}`，前端保留"复制跳转标识"作为退路（v1 不做"仅打开一个空终端窗口"这种低价值兜底，因为不像 flux 那样有一个稳定的宿主 app bundle id 可 `open -a` ） | flux `jumpFallback`/`jumpCmux` 的"精确路径全失败才退化"哲学，但我们没有 flux 那种"至少 open -a 前台化宿主 app"的通用兜底目标（我们的宿主是任意终端/IDE，没有单一 app bundle id），所以诚实地把失败暴露给前端，而不是假装做了什么 |

**平台识别**：需要 `queries.ts`/`server.ts` 新增暴露 `platform` 字段（来自 `attachments.platform`，当前 `Q1Row` 只有 `binding` 没有 `platform`）——沿 `stable_id`/`origin_emitter_id` 关联到最新一条 `attachment_observed` 的 `platform` 列。

**执行安全边界**：`Bun.spawn(["open", url])` / `Bun.spawn(["herdr","agent","focus",id])` / `Bun.spawn(["orca",...])` 全部走参数数组，不经过 shell、不做字符串拼接，杜绝注入；每个分支加超时（5s，对齐 flux `execFileAsync` 的默认超时量级）；orca 三跳链任一步失败即中止转兜底，不重试风暴。

## 3. 工程约束

- `web/server.ts` 与其余守护进程一样遵循"崩溃即警告一次、不影响 ledger"的既有原则；未捕获异常不应使整个 launchd job 反复重启风暴（KeepAlive 已有 launchd 侧退避）。
- 前端 JS 无框架、无构建步骤，与仓库现状（CLI/digest 均为直接 Bun 脚本）保持一致；避免引入 node_modules/打包链路。
- Swift 侧不做单元测试框架接入（仓库无 macOS UI 测试基础设施）；`swift build` 作为编译期契约验证，运行时行为走手动截图冒烟验证。

## 4. 测试计划

- `src/web/server.test.ts`：临时端口起 server，seed 与现有 `test/harness` 一致的 tmp ledger fixture；断言：
  - `GET /api/q1` 的行集合与 CLI `q1` 打印内容语义等价（同一 fixture、逐字段比对，防止 `queries.ts` 提取引入行为漂移）
  - `POST /api/ack/:id`：pending→cancelled 幂等；重复 POST 返回 `acked:false`
  - `POST /api/jump/:id`：herdr/cmux/orca 三分支按 §2.4a 逻辑各构造一条 fixture（mock `Bun.spawn` 或注入可替换的执行器，不依赖真实平台 CLI/app 跑在 CI 里）断言选中的分支与拼出的确切命令/URL；无 `platform`/未知 `platform`/`binding` 为空 → `{opened:false}` 不抛异常。
  - 非回环 `Host` 头 / 直接绑定验证：仅证明 `hostname:"127.0.0.1"` 配置生效（不做外部网络测试）
- `src/cli/overload.test.ts`：提取 `queries.ts` 后重跑既有用例，确认输出字符串不变（重构不改变可观察行为）。
- Island：`swift build -c release` 编译通过；手动启动后 `screencapture` 截图验证折叠态/展开态渲染，并用一条构造的 pending request 验证计数与展开列表更新。

## 5. 分期

- **P1**：`queries.ts` 提取 + `web/server.ts`（含 dashboard HTML + `/api/*` + ack 端点）+ launchd plist + `server.test.ts`。验收：§0 前四项指标。
- **P2**：`native/island` Swift 面板 + launchd plist + 手动截图验证。验收：§0 第二项（跨 Space/全屏可见性）。

## 6. 非目标

- 不实现任何 approve/deny 写回桥接；ack 不解除 agent 阻塞。
- 不做鉴权/多用户隔离（v1 单用户本机信任模型）。
- 不做 `binding` 的自动执行跳转——**web 例外**（§2.4a：herdr/orca/cmux 三平台真打开，前台化目标终端/窗口，不代答不执行 agent 侧任何操作）；**Island 继续保持展示语义**（copy-jump only，§2.3.1 决策边界不变）；跳转失败时不假装做了什么，明确返回失败让前端退回复制。
- 不引入前端构建工具链、不引入 WebView 到 Island。

## 7. 残余风险

1. Bun `Bun.serve` 与既有 `bun:sqlite` 只读连接在高频轮询下的文件描述符/性能特征未压测——量级仅为单用户本机轮询（web dashboard 数秒级 + Island 5s），预期远低于 ingest/reducer 现有负载，不预先优化。
2. Swift 悬浮面板的 `NSPanel` 在 macOS 版本升级后的 `collectionBehavior` 行为可能变化（历史上 Apple 多次调整全屏空间语义）；出问题时的诊断路径是重新核对目标 macOS 版本的 `NSWindow.CollectionBehavior` 文档，非本设计可控范围。
3. web server 无鉴权意味着本机任意本地进程都可读取/ack 队列内容；与现状（任意本地进程都能直接读 `ledger.db`）风险等价，不是新增暴露面。
4. **【已知未解决缺陷，v1 上线前必须权衡】expand→collapse 转场后折叠胶囊在屏幕上渲染消失**：N24 验收用窗口级截图（`CGWindowListCreateImage`，不受其他窗口/前台切换干扰）确定性复现 2/2——窗口服务器仍报告窗口正常 on-screen（level/bounds 均正确），但实际合成内容为全透明；再次悬停可完整恢复，再次收起再次消失。owner 后续用最小复现（纯 `wantsLayer` NSView，无 NSVisualEffectView/NSStackView）定位到决定性因素是 `isOpaque = false`（`isOpaque = true` 的同款重现步骤每次都正常渲染），但由于圆角透明视觉需要 `isOpaque=false`，且尝试的多种修法（`needsDisplay`/`viewsNeedDisplay`/`displayIfNeeded`/`orderFront`/`contentView` 重建/`layerContentsRedrawPolicy`）均未能确定性解决——部分后续重测还受这台机器被真实并发使用干扰，结果本身也不完全可信。`IslandContentView.setExpanded` 保留了一个低成本、非确认有效的尝试（`needsDisplay` + `displayIfNeeded`）。**影响**：折叠胶囊"常显"这一特性的核心存在意义被削弱——首次展开后收起，胶囊从屏幕消失，只有再次悬停命中原矩形区域才能唤回。**上线建议**：`works.earendil.overload.island.plist` 暂不建议默认安装/启用；需要在一台空闲（无并发活动）的 Mac 上用 Xcode View Debugger 或类似工具做交互式复验后再决定是否随 launchd 常驻。
