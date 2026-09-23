# Overload 交互重设计：量化操作员

日期：2026-09-07。设计稿，不代表已实现。沿用现有 Bun/SQLite/loopback Web 与 `src/control` 数据模型；新增界面只读已有事件，不增写库。

## 0. 立场

界面主角不是 Agent，是操作员本人。每一屏回答一个问题：**此刻你欠系统什么决定，你过去欠了多久。**

视觉借 Vercel：黑白灰、单色状态点、细边框、等宽数字、无插画、无渐变、无图标堆叠。所有强调靠字重与留白，不靠颜色。

## 1. 视觉基调

| 项 | 值 |
|---|---|
| 背景 | `#fff` / 暗色 `#000` |
| 前景 | `#171717` / `#ededed` |
| 次级 | `#666` |
| 边框 | `1px #eaeaea` / `#333` |
| 圆角 | 6px 卡、4px 徽标、9999 状态点 |
| 字体 | 系统 sans（Geist 风）；数字与 ID 一律等宽 tabular |
| 颜色 | 仅状态点：`#0070f3` 进行、`#f5a623` 待你、`#e00` 不可逆/已过期、`#50e3c2` 已核实 |
| 动效 | 无；仅 150ms 透明度过渡 |
| 语气 | 陈述句、数字先行、无感叹号 |

禁止：进度环、红色大块、emoji、“健康仪表盘”隐喻。

## 2. 信息架构

```
┌ 顶栏 ─────────────────────────────────────────────────────┐
│ Overload   Decide  Ledger  Works  Candidates  Agents   ⌘K  │
└───────────────────────────────────────────────────────────┘
```

- **Decide**：默认页。审判席。
- **Ledger**：操作员账本。量化自己。
- **Works**：契约列表与版本历史。
- **Candidates**：想法候选池，不占注意力。
- **Agents**：运营页，Token/会话/健康。降级到最后一个 Tab。

Q1–Q5、hung、zombie 不再出现在导航；合并入 Agents 与卡片证据。

## 3. Decide 页

### 3.1 顶部一行（不是四张卡）

```
3 decisions owed · 1 expires in 2h · oldest waiting 19h · agents self-resolved 41 today
```

单行等宽文本。四个数字全是关于操作员的：欠几件、最急何时、最久多久、机器自决多少。最后一个数字可点，抽查 Done。

### 3.2 列表即卡

Vercel Deployments 式行列表，非大卡。每行：

```
● Is "Payment retry" still worth 1 more attempt?          operator · r3   19h   ↵
  stop condition · 2/2 retries spent · value evidence absent
  [ stop ]  [ continue ]  [ narrow ]                       ↗ open session
```

- 首行是问句。由 `conclusion` 模板化为“是否……？”
- 状态点颜色 = 层级：黄 = 有边界触线，红 = 不可逆/过期。
- 右侧三段等宽：owner·契约版本、等待时长、回车提示。
- 展开（回车/点击）才显示证据、影响面、选项后果。默认收起，减少阅读量。

### 3.3 展开态

```
─────────────────────────────────────────────────────────────
Why now      stop condition s1 triggered at 13:02 (judgment)
Impact       repo /repo/pay held · 1 worker occupying · deadline 09-08 18:00
Evidence     retries 2/2 · last check exit 1 · diff +412 −38  ↗ artifacts
Options
  stop       releases repo, keeps worktree 1h, work → stopped
  continue   spends nothing new; deadline unchanged; you accept 0 retries left
  narrow     requires new contract; supersedes 2 open cards      [ edit contract ]
Waiting      19h 12m  (your median this week: 6h 40m)
─────────────────────────────────────────────────────────────
```

“Waiting” 行把个人中位数并排。这是量化的最小侵入形式：不评价，只并置。

### 3.4 动作后

按下不可逆选项，行不消失，原地折叠为一行收据：

```
✓ stop · you · 14:02 · effect verified 14:02 · repo released
```

3 秒后沉入 Done。effect 未核实则显示 `effect pending` 并保持黄点，不下沉。

### 3.5 批量

`⌘K` → “Resolve all bounded” 仅作用于黄点行且效果可逆。红点行永远逐条。

## 4. Ledger 页：操作员账本

Vercel Analytics 式：稀疏折线 + 一行数字 + 表格，无饼图。

### 4.1 首行

```
This week you were the bottleneck for 31h 20m across 9 works.
```

一句话，来自 `attention_required → decision_consumed` 区间并集。数据不全则写 `coverage 61%`，不补值。

### 4.2 五指标，一行五格

```
Waiting        Rework you caused   Redirects      Sunk to rules   Death delay
31h 20m        4 / 11              3 (2 unplanned) 6 ↑2            2d 4h
median 6h40m   36%                 lost 5h 10m    12% of decisions oldest: "Q3 sync"
```

| 指标 | 来源 | 定义 |
|---|---|---|
| Waiting | attention open→resolved/consumed | 你占用的等待，按 Work 去重 |
| Rework you caused | `control_contract_revisions.reason` 归因 | 契约改版后被作废/重跑的任务数 ÷ 总返工 |
| Redirects | `control_redirects` | 次数、非候选池直入次数、被挤掉工作的已耗时 |
| Sunk to rules | policy candidate enabled + 规则命中数 | 本应到你、被规则自决的判断占比 |
| Death delay | stop trigger `created_at` → `decided_at` | 中位数与最久一件 |

每格下方 7 天稀疏折线，单色，无坐标轴。

### 4.3 表格：你最慢的十个决定

```
Work                 Asked        Decided      Waited    Chose      Effect
Payment retry        09-05 13:02  09-06 08:14  19h 12m   stop       verified
Q3 sync              09-03 10:40  —            2d 4h     —          —
```

未决行不飘红，只留 `—`。表格可导出 CSV。

### 4.4 一条不做的事

不做排名、不做趋势评语、不做“做得好”。数字说完即止。

## 5. Works 页

行列表：标题、状态点、`r3`、owner、open cards、deadline。点击进详情：

```
Contract r3   [ view diff r2→r3 ]   revised by you · reason: "scope too wide"
Objective     ...
Acceptance    check ci · artifact release-notes · human final review
Stop          s1 judgment · s2 hard
Budget        retries 2 · deadline 09-08 · cost unknown
History       r1 created 09-01 · r2 redirect 09-03 (lost 3h) · r3 narrow 09-06
```

History 行把“你的改动造成的损失”直接写出。

## 6. Candidates 页

想法入口只有这里。新建时只需一行标题；**升格为 Work 必须填 objective 与至少一条 acceptance**，否则按钮禁用。页面顶部：

```
7 candidates · 2 promoted this week · 3 older than 14 days
```

旧候选不提醒，不催促，只计数。

## 7. narrow 编辑器

Drawer 从右侧滑出，左旧契约、右新契约，字段级 diff。底部：

```
This revision will supersede 2 open cards and reset 0 retries.
Reason (required) [                                   ]
[ cancel ]                                   [ apply r4 ]
```

## 8. 通知

系统通知只发 Now 新增与即将过期；正文一行，问句 + 剩余时效。无正文摘要、无进度。Inbox 变化仅改 Dock 数字。

## 9. 空态

Decide 空时：

```
Nothing owed. Agents self-resolved 41 decisions today.  [ inspect ]
```

不庆祝。

## 10. 实施映射

| 界面 | 数据 | 现状 |
|---|---|---|
| Decide 行 | `listAttention` + 问句模板 + 选项后果 | 卡片已有字段；缺问句、缺后果文案 |
| Waiting 中位数 | attention events | 缺计算 |
| Ledger 五指标 | ledger `applied_control_events` + 投影 | 事件已落，`audit.ts` 缺 4 项 |
| Candidates | `Work.state='candidate'` | API 有，页面缺 |
| narrow 编辑器 | `reviseContract` + `resolveAttentionDecision` | 后端完整，UI 禁用 |
| Agents 降级 | 现有 sessions/health/q 队列 | 需移位 |

顺序：Ledger 计算 → Decide 行改写 → narrow 编辑器 → Candidates → 导航重排。视觉重做放最后，避免先换皮后换骨。
