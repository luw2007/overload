# Overload 飞书 Channel 运行进度反馈开发计划

日期：2026-09-30

状态：待开发

目标仓库：`/data00/home/luwei.will/ai/overload`（devbox）

执行方式：由 devbox 上的 Herdr agent 实施；本计划不要求本地直接修改代码。

## 1. 目标

把当前 “任务结束后才回复一条” 改为：



1. 消息接收后立即用现有 reaction 表示已接收；

2. 任务运行超过 10 秒后，在原飞书话题中创建一张低打扰进度卡；

3. 卡片原地更新，只展示可靠的运行事实：排队、当前工具、已完成工具数、最近活动、等待决策、疑似卡住、终态；

4. 决策卡和最终结果继续使用独立消息，负责真正通知用户；

5. 重启、限流、消息发送结果未知等异常不能产生重复卡片，也不能遗留永久 “处理中”。

成功后的用户体验：



```
用户发任务
  └─ 立即出现已有 GoGoGo reaction
       ├─ 10 秒内结束：直接收到结果，不创建进度卡
       └─ 超过 10 秒：话题内出现一张无 @ 的进度卡
            ├─ 原地更新排队/工具活动/等待决策/疑似卡住
            ├─ 需要决策：另发决策卡
            └─ 完成或失败：另发结果消息，进度卡收尾，reaction 更新
```

## 2. 本期边界

### 2.1 必须完成



* 飞书根消息与话题标识归一；

* 新建消息幂等或 “发送结果未知时禁止重建” 的安全语义；

* PATCH 错误分类、限流退避和降级；

* 独立的进度状态持久化；

* 基于数据库真实状态的进度投影与重启对账；

* Pi 工具开始 / 结束事件；

* 延迟 10 秒创建进度卡；

* 5 秒合并、内容去重、单 turn 和全局更新预算；

* completed /failed/cancelled /unknown 的收尾；

* 静默 turn 和排队 turn 的正确处理；

* 定向测试、全量测试、真实飞书闭环验收。

### 2.2 明确不做



* 不引入快模型；

* 不用主模型 `text_delta` 生成阶段摘要；

* 不展示工具参数、命令、路径、结果正文；

* 不实现 `collapsible_panel` 或卡片 JSON 2.0；

* 不实现可编辑计划；

* 不改变决策卡的所有权、鉴权和回执链；

* 不把进度事件写成大量 `channel_deliveries`；

* 不修改用户无关文件；

* 不在本阶段清理或重构 adapter 以外的历史代码。

## 3. 已确认的现状与风险

### 3.1 现有消息 outbox 不能承载进度快照

`src/adapters/store.ts`：



* `channel_deliveries.business_key` 是唯一键；

* `enqueueDelivery` 使用 `INSERT OR IGNORE`；

* `flush()` 按 rowid 串行发送历史记录；

* `unknown` 不会自动重新取出；

* 决策卡还会被旧 `unknown/retryable` 记录阻塞。

因此：



* 用固定 `progress:<turnId>` 会导致第二次开始的所有更新被丢弃；

* 每次生成新 business key 会把历史快照排队重放；

* 进度消息可能阻塞决策和终态。

结论：进度必须使用独立持久状态，采用 “期望视图 vs 已发送视图” 对账，不复用普通消息 outbox。

### 3.2 飞书话题标识存在混用

`src/adapters/feishu.ts` 当前优先选择：



```
message.threadId ?? message.rootId ?? message.messageId
```

然后把该值同时用于：



* conversation binding；

* `replyTo`。

飞书 `thread_id`（常见 `omt_`）和消息 ID（常见 `om_`）不是同一类对象。回复 API 需要消息 ID。首条消息与话题内追问如果使用不同 binding 值，也会形成两个 conversation。

结论：



* `rootMessageId = message.rootId ?? message.messageId` 是稳定会话键和回复锚点；

* `threadId` 只保存为元数据，不作为 reply target；

* 首条消息与话题内追问必须归到同一 conversation。

### 3.3 当前 SDK 抽象未证明 uuid 真正生效

Overload 的 `FeishuSdkChannel.send()` 类型接受 `uuid`，但当前 SDK wrapper 的真实发送路径可能没有转发该字段；现有测试只验证 fake 接收到 uuid。

结论：在实现进度卡创建前必须验证真实 SDK 调用层：



* 优先使用开放平台原始消息 create/reply API，并显式传 uuid；

* 如果现有 wrapper 无法做到，采用 fail-closed：新建结果为 unknown 时不得自动再建；最终结果仍按现有可靠路径交付；

* 不允许通过 “超时后再发一张” 解决。

### 3.4 PATCH 错误分类不足

当前 `errorCode()` 只读取字符串 `error.code`。真实 SDK 错误还可能把信息放在：



* HTTP status；

* `response.status`；

* `response.data.code`；

* `response.headers.retry-after`；

* `x-ogw-ratelimit-reset`。

结论：必须新增统一错误归类，区分：



* `rate_limited`：有限退避；

* `not_connected` / 网络瞬时错误：有限退避；

* `target_revoked` / `message_not_found`：停止更新该卡；

* `permission_denied` / `format_error`：永久失败；

* `unknown`：进度停止，不能新建替代卡。

## 4. 总体设计

### 4.1 单一事实源



* `conversation_turns.state` 是任务状态权威；

* `channel_runtime_events` 是活动事实；

* `channel_progress` 只保存 “如何向用户展示”，不拥有任务生命周期；

* Projector 每次 tick 从权威表计算期望视图，不只依赖实时事件；

* 事件丢失或进程重启后，下一次 tick 仍能收尾。

### 4.2 组件

#### A. Feishu 语义修正

负责：



* 规范化 `rootMessageId` 与 `threadId`；

* 使用根消息 ID 做 conversation binding 和 reply target；

* 提供可靠的新建卡片与 PATCH 接口；

* 错误归类；

* 进度卡不带 @；

* 决策和终态保持独立通知。

#### B. Runtime 活动事件

负责：



* 从 Pi RPC 事件产生工具开始 / 结束事件；

* 只携带安全工具名，不携带输入参数、命令、文件路径、结果正文；

* 提供 `last_activity_at`、`last_activity_label` 和完成计数所需事实。

#### C. Progress Store

负责：



* 每个 turn 一行；

* 保存期望版本和已发送版本；

* 保存卡片创建状态；

* 保存退避、限流、降级、PATCH 次数；

* 支持重启恢复。

#### D. Progress Projector

负责：



* 从 turn/runtime/decision 状态计算进度视图；

* 延迟 10 秒创建卡片；

* 合并活动，只保留最新快照；

* 执行 per-turn 与全局预算；

* 状态迁移优先于普通活动；

* 终态收尾；

* PATCH 失败时 fail closed。

## 5. 类型调整

### 5.1 ChannelAddress

修改 `src/adapters/types.ts`：



```
export type ChannelAddress = {
  instanceId: string;
  tenantId: string;
  chatId: string;
  rootMessageId?: string; // 稳定会话键和 reply target
  threadId?: string;      // 飞书话题元数据，不用于 replyTo
};
```

兼容迁移：



* 读取旧 address 时，如果只有 `threadId` 且它是消息 ID 形态，可暂时映射到 `rootMessageId`；

* 新写入必须分开；

* 不修改已有 conversation id，不做不可靠历史回填。

### 5.2 RuntimeEvent

扩展 `RuntimeEvent`：



```
type RuntimeEvent =
  | ExistingRuntimeEvent
  | {
      eventId: string;
      sessionId: string;
      turnId: string;
      kind: "tool_started" | "tool_finished";
      toolName: string;
    };
```

安全规则：



* `toolName` 使用允许字符和最大长度限制；

* 只保存通用名称，例如 `read`、`bash`、`edit`、`test`；

* 不保存参数、cwd、文件名、shell 命令、stdout、错误正文；

* 未识别工具统一为 `tool`，不能透传原始对象。

### 5.3 ProgressView

新增 `src/adapters/progress.ts`：



```
type ProgressViewState =
  | "queued"
  | "running"
  | "waiting_decision"
  | "stale"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

type ProgressView = {
  state: ProgressViewState;
  title: string;
  summary: string;
  activeTool: string | null;
  completedTools: number;
  lastActivityAt: number | null;
  terminal: boolean;
};
```

视图必须是纯函数结果，可单测，不直接调用飞书。

## 6. 数据模型

在 `ensureAdapterSchema()` 中新增 additive schema：



```
CREATE TABLE IF NOT EXISTS channel_progress (
  turn_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  channel_instance_id TEXT NOT NULL,

  message_id TEXT,
  create_state TEXT NOT NULL DEFAULT 'none'
    CHECK (create_state IN ('none','sending','sent','unknown','failed')),
  create_uuid TEXT NOT NULL,

  view_state TEXT NOT NULL DEFAULT 'queued',
  desired_version INTEGER NOT NULL DEFAULT 0 CHECK (desired_version >= 0),
  sent_version INTEGER NOT NULL DEFAULT 0 CHECK (sent_version >= 0),
  desired_hash TEXT,
  desired_view_json TEXT,

  last_activity_at INTEGER,
  last_activity_label TEXT,
  completed_tool_count INTEGER NOT NULL DEFAULT 0,

  last_patch_at INTEGER,
  patch_count INTEGER NOT NULL DEFAULT 0 CHECK (patch_count >= 0),
  next_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0,1)),
  reason TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  FOREIGN KEY (turn_id) REFERENCES conversation_turns(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id),
  CHECK (desired_view_json IS NULL OR json_valid(desired_view_json)),
  CHECK (sent_version <= desired_version)
);

CREATE INDEX IF NOT EXISTS channel_progress_due
  ON channel_progress(next_at, turn_id)
  WHERE degraded=0 AND desired_version > sent_version;
```

不变量：



1. 每个 turn 最多一张进度卡；

2. `create_uuid` 创建 turn 时生成并永不改变；

3. `desired_version` 只增不减；

4. `sent_version` 只在创建 / PATCH 确认成功后推进；

5. `desired_hash` 相同不增加版本；

6. `degraded=1` 后不再创建或 PATCH 进度消息；

7. 终态 view 写入后，旧活动事件不能改回运行态；

8. `sending` 在进程启动时改为 `unknown`，但不得自动重新创建卡片。

可把卡片创建与更新拆为两个子状态，但不要再引入通用 delivery 状态机。

## 7. 视图状态机

### 7.1 初始与排队



* turn 创建时不立刻创建 `channel_progress` 也可以；推荐同步创建 row，`create_state=none`；

* `conversation_turns.state=queued` 时视图为 queued；

* 只有 `now - turn.created_at >= 10s` 且不是 silent turn 才允许创建卡片；

* 有可靠队列序号才显示 “前面还有 N 个”，没有就只写 “正在等待前序任务”。

### 7.2 运行

当 turn 进入 submitting/running：



* 显示 “正在处理”；

* 有工具活动时显示安全工具名称；

* 显示已完成工具数；

* 显示最近活动的相对时间档位；

* 不展示模型 text\_delta。

### 7.3 等待决策

当 turn state 为 blocked，且存在 open runtime decision：



* 进度卡显示 “等待你在下方决策卡中处理”；

* 决策卡仍由现有 `projectCards()` 单独发送；

* 进度卡不能复用 decision card message\_id；

* 不在进度卡上增加决策按钮。

### 7.4 疑似卡住

当 turn 仍非终态且 `now - last_activity_at >= 120s`：



* 视图为 stale；

* 文案：“超过 2 分钟没有新活动，任务可能卡住；可取消或稍后查看。”；

* 如果当前工具已知，可写 “工具 X 尚未结束”；

* 不声称仍在正常执行；

* 每 30 秒时间档位最多更新一次。

### 7.5 终态

权威映射：



| Turn 状态 / 原因                                              | 进度卡终态                            |
| --------------------------------------------------------- | -------------------------------- |
| completed                                                 | completed                        |
| failed                                                    | failed                           |
| cancelling 后运行时终态 /reason=cancelled\_effects\_unconfirmed | cancelled 或 unknown，文案必须保留副作用未确认 |
| unknown                                                   | unknown                          |
| owner\_lost\_before\_receipt                              | unknown                          |

终态动作：



1. Projector 写入终态 desired view；

2. 允许最后一次 PATCH 收尾卡片；

3. 最终结果仍通过现有 `enqueueDelivery` 独立发送，business key 使用 `result:<turnId>:<state>`；

4. reaction 继续 GoGoGo → DONE；失败 /unknown 增加明确失败 reaction（选用飞书支持且已有能力验证的 emoji，不能猜枚举）；

5. 进度终态 PATCH 失败不得阻塞结果消息和 reaction；

6. FINAL 后忽略晚到的 tool/output 事件。

## 8. 节流、去重和优先级

### 8.1 创建阈值



* 运行不足 10 秒：不创建卡；

* 10 秒时根据当时真实状态创建；

* 10 秒时已经终态：不创建卡；

* silent turn：永不创建卡。

### 8.2 PATCH 规则



| 触发               | 行为                               |
| ---------------- | -------------------------------- |
| 状态迁移             | 可立即进入 desired view；实际发送间隔 ≥1 秒   |
| 工具开始 / 结束、完成计数变化 | 合并，实际 PATCH 间隔 ≥5 秒              |
| 内容 hash 不变       | 不增加 desired\_version，不 PATCH     |
| 最近活动时间           | 按 30 秒档位变化才更新                    |
| 120 秒无活动         | 转 stale，优先发送                     |
| 单 turn PATCH     | 最多 60 次；达到上限后只允许终态收尾             |
| 全局进度预算           | 每秒最多 2 次，使用 token bucket 或简单时间窗口 |

### 8.3 优先级

每次 `tick()` 顺序固定：



1. pump runtime 与记录事件；

2. consume answers；

3. project decision cards；

4. flush 终态 / 决策 outbox；

5. sync reactions；

6. project progress desired views；

7. flush progress，最多消费全局预算。

进度永远不能延迟决策和终态。

## 9. 飞书发送语义

### 9.1 新建进度卡

要求：



* reply target 使用 `rootMessageId`；

* `reply_in_thread=true`；

* 不带 @；

* 使用稳定 `create_uuid`；

* 创建成功后保存 `message_id`；

* 创建返回 unknown 时：`create_state=unknown`、`degraded=1`，不自动再次新建；

* 明确收到可重试且服务端确认未创建的错误，才允许有限重试。

### 9.2 更新进度卡



* 使用全量 PATCH；

* 成功后推进 `sent_version`；

* 如果发送期间 desired\_version 又前进，只确认本次快照版本，下一 tick 继续追最新；

* 429 按 retry-after/reset 设置 `next_at`；

* 网络瞬时失败做指数退避，最多 4 次；

* `message_not_found` / 撤回 / 权限永久失败：`degraded=1`；

* unknown：`degraded=1`，不创建替代卡；

* 终态结果消息不受 degraded 影响。

### 9.3 卡片格式

P0 使用当前兼容卡片格式，不升级 JSON 2.0。建议：



```
标题：正在处理 / 等待决策 / 可能卡住 / 已完成 / 执行失败
正文：
- 当前：运行工具 Read（或“正在处理”）
- 已完成：6 个工具步骤
- 最近活动：30 秒内
- 下一步：等待工具返回 / 请查看下方决策卡 / 请查看结果消息
```

不要包含：



* 用户原始完整输入；

* 模型思维过程；

* shell 命令；

* 文件路径；

* 工具参数；

* 工具输出；

* token、密钥、内部 ID。

## 10. 文件与代码落点

### 阶段 A：飞书基础修复

修改：



* `src/adapters/types.ts`


  * 区分 `rootMessageId` / `threadId`；

  * 扩展 progress card 类型或新增专用 `ProgressMessage`，不要污染 decision 类型。

* `src/adapters/feishu.ts`


  * 规范化根消息；

  * 修正 reply target；

  * 提供 `createProgress` / `updateProgress`，或在 ChannelAdapter 中增加明确的 card snapshot 接口；

  * 统一错误归类；

  * 验证 uuid 真实转发。

* `src/adapters/feishu.test.ts`


  * 使用真实形状的 `om_*`、`omt_*` 值；

  * 测根消息连续性、reply target、uuid、429、撤回、unknown。

* `src/adapters/store.ts` 及相关测试


  * conversation binding 使用 rootMessageId。

阶段 A 完成门：所有飞书定向测试通过；没有任何进度功能也不会破坏现有消息、决策、reaction。

### 阶段 B：Runtime 活动事件

修改：



* `src/adapters/types.ts`


  * 新增 `tool_started` / `tool_finished`。

* `src/adapters/pi-broker.ts`


  * 识别 Pi RPC 中的工具开始 / 结束事件；

  * 输出安全 toolName；

  * 不保存 payload/result。

* `src/adapters/pi-broker.test.ts`


  * 工具开始 / 结束各一例；

  * 非工具事件不误报；

  * 参数 / 路径 / 结果不出现在 RuntimeEvent 序列化结果中。

阶段 B 完成门：工具活动事实可持久、可 replay，但尚不发送飞书卡片。

### 阶段 C：Progress Store 与纯投影

新增：



* `src/adapters/progress.ts`


  * 类型；

  * `ensureProgressRow`；

  * `recordProgressActivity`；

  * `computeProgressView`；

  * `projectProgress`；

  * `listDueProgress`；

  * 成功 / 失败 / CAS 更新函数；

  * canonical JSON/hash。

* `src/adapters/progress.test.ts`


  * 纯状态机和数据库不变量测试。

修改：



* `src/adapters/store.ts`


  * additive schema；

  * 如项目后续已有 schema version 机制，接入统一 migration；当前 adapter schema 为 idempotent ensure，不应另建第二套迁移框架。

* `src/adapters/service.ts`


  * 接收 runtime tool activity 时更新 progress activity；

  * 在 tick 中计算 desired view；

  * 不在本阶段发送。

阶段 C 完成门：任意重启后，数据库可重算出所有 turn 的正确 desired view。

### 阶段 D：Progress Delivery

修改：



* `src/adapters/service.ts`


  * 增加 progress flush；

  * 严格置于普通 outbox/reaction 之后；

  * 全局预算、per-turn 间隔、PATCH 上限；

  * 创建和更新的 CAS；

  * degraded 语义。

* `src/adapters/types.ts`


  * ChannelAdapter 增加明确能力：例如 `progress?: { create, update }`，或扩展 capability；

  * 不要用 decision 字段伪装进度卡。

* fake channel 与 service tests


  * 测创建、PATCH、限流、终态、重启、优先级。

阶段 D 完成门：fake channel 下完整生命周期通过，并证明中间活动只产生一张卡、更新只保留最新快照。

### 阶段 E：真实飞书验收与灰度



* 在 devbox 使用真实飞书测试应用；

* 单用户、单群、单会话灰度；

* 验证 thread、message\_id、PATCH、限流 header、reaction emoji；

* 再逐步扩大。

## 11. 必须新增的测试

### 11.1 话题连续性



1. 首条群消息：`messageId=om_root`、无 rootId/threadId；

2. 机器人在话题内回复；

3. 用户话题追问：`messageId=om_reply`、`rootId=om_root`、`threadId=omt_topic`；

4. 两条消息必须映射到同一 conversation；

5. 所有回复必须以 `om_root` 为 replyTo，不能传 `omt_topic`。

### 11.2 创建幂等



* 同一 turn 重复 tick 只调用一次 create；

* create 成功后重启不再创建；

* create 结果 unknown 后重启不再创建；

* 稳定 uuid 在重试 / 重启中不变；

* 真实 SDK adapter 单测必须断言 uuid 到达原始 API 参数，而不是只到 fake wrapper。

### 11.3 延迟创建



* 9.999 秒：无卡；

* 10 秒：创建；

* 10 秒内完成：无卡；

* silent turn：无卡；

* queued 10 秒：queued 卡，不显示 running。

### 11.4 合并与限流



* 5 秒内 20 个工具事件只形成一个最新 desired view；

* 相同 hash 不 PATCH；

* 每 turn 最短 5 秒；

* 状态迁移最短 1 秒；

* 全局 20 个 turn 同时更新时，每秒最多两次进度调用；

* 终态和决策不受该预算阻塞。

### 11.5 错误与降级



* 429：按 header 退避；

* 网络瞬时错误：最多 4 次；

* message\_not\_found：degraded；

* unknown：degraded，不新发纯文本；

* 已 degraded turn 的终态结果仍正常发送；

* PATCH 上限 60 后只允许终态一次。

### 11.6 重启恢复



* `create_state=sending` 重启后转 unknown/degraded，不重复创建；

* 运行中 turn 重启且 owner 丢失后变 unknown，进度卡收尾；

* 已 completed 但最后 PATCH 未发，重启后补终态 PATCH；

* 晚到 tool event 不能把 final 改回 running。

### 11.7 Runtime 事件安全



* 事件只含 toolName；

* 输入中包含密钥、路径、命令时，序列化 RuntimeEvent 中均不存在；

* 未识别工具名归一为 `tool`；

* tool\_finished 增加计数；重复事件由 event\_id 去重。

### 11.8 Reaction



* 入站 reaction 只创建一次；

* completed 替换为 DONE；

* failed/unknown/cancelled 使用经真实飞书验证的失败状态；

* reaction 失败只重试 reaction，不影响结果消息和进度卡。

## 12. 真实飞书验收脚本

在测试群逐项执行并保存消息截图、message\_id/root\_id/thread\_id 日志和服务端状态：



1. **5 秒任务**：只有 reaction + 最终结果，无进度卡；

2. **30 秒工具任务**：10 秒后出现一张进度卡，期间原地更新，完成后有独立结果；

3. **话题追问**：追问复用同一 session 和原话题；

4. **决策阻塞**：进度卡显示等待决策，独立决策卡可点击，回答后续跑；

5. **工具静默 130 秒**：120 秒后显示可能卡住；

6. **进程重启**：旧进度卡最终变 unknown，不遗留处理中；

7. **撤回进度卡**：服务降级，不持续重建；最终结果仍到达；

8. **模拟 429**：按 reset 时间恢复，无刷屏；

9. **并发 10 个长任务**：进度更新受全局预算控制，终态和决策优先；

10. **取消任务**：进度卡显示已取消或副作用未知，结果文案保持现有安全语义。

## 13. 验收指标

### 功能指标



* 首个可见信号 reaction：p95 ≤ 2 秒；

* 10 秒内结束的 turn：新增进度消息数 = 0；

* 长 turn：进度卡创建数 = 1；

* 同 turn 重复进度卡数 = 0；

* 终态后 5 秒内进度卡收尾率 = 100%；

* 重启后遗留 “处理中” 卡数 = 0；

* 话题追问 session 复用率 = 100%；

* 决策 / 终态投递延迟不高于基线 p95；

* 工具事件敏感参数泄漏数 = 0。

### 体验指标

灰度前记录基线，灰度后比较：



* 长任务中用户追问 “还在吗” 的比例；

* 长任务中用户主动 `/cancel` 的比例；

* 同一任务平均新增消息数；

* 同任务通知压缩率；

* 用户看到 “处理中” 但任务已终态的时长。

### 运行指标



* progress create 成功 /unknown/failed；

* progress PATCH 成功率；

* 429 比例与退避时长；

* degraded turn 数；

* 每 turn PATCH 分布及达到 60 上限的数量；

* 全局预算丢弃 / 合并更新数；

* desired\_version - sent\_version 积压分布。

## 14. 配置与开关

新增统一配置，默认关闭：



```
{
  "channelProgress": {
    "enabled": false,
    "createAfterMs": 10000,
    "patchMinIntervalMs": 5000,
    "stateMinIntervalMs": 1000,
    "staleAfterMs": 120000,
    "activityBucketMs": 30000,
    "maxPatchesPerTurn": 60,
    "globalPatchesPerSecond": 2,
    "maxAttempts": 4
  }
}
```

约束：



* 非法值启动失败，不静默回默认；

* 关闭开关后不创建新进度卡；

* 关闭时已有卡片需要收尾：运行中的卡片更新为 “进度展示已停用，请查看最终结果”；若无法 PATCH，停止处理，不能新发消息；

* 先只对测试 tenant/chat 开启，再扩大。

## 15. 灰度与回滚

### 灰度阶段



1. 测试 DB + fake channel；

2. 真实飞书测试应用、单用户；

3. 单测试群；

4. 仅一个 Overload owner；

5. 观察 24 小时指标；

6. 扩大至全部授权会话。

### 回滚



* 关闭 `channelProgress.enabled`；

* 不删除 `channel_progress`；

* 不回滚 conversation、result、decision 数据；

* 保留终态消息和 reaction；

* 不批量发送历史补偿消息；

* 重新开启时从权威 turn 状态对账，只恢复仍有合法 message\_id 且未 degraded 的卡。

## 16. 开发执行顺序

严格按以下顺序，每一步单独提交，前一阶段测试通过后再继续：



1. **A1：Root message identity**

* 类型、规范化、conversation binding、reply target、真实形状测试。

1. **A2：Feishu delivery correctness**

* uuid 真实生效、错误分类、PATCH 退避与 fail-closed。

1. **B：Runtime tool activity**

* 安全事件、replay、单测。

1. **C1：Progress schema/store**

* 表、hash、CAS、不变量、迁移测试。

1. **C2：Progress pure projection**

* 状态机、10 秒门槛、silent/queued/stale/final、纯单测。

1. **D1：Progress create/update delivery**

* 单卡创建、PATCH、degraded、重启恢复。

1. **D2：Budget and priority**

* 5 秒合并、全局 2 QPS、60 次上限、终态 / 决策优先。

1. **D3：Reaction terminal states**

* 保留成功流程，补失败 /unknown/cancelled，经真实 emoji 验证。

1. **E：真实飞书验收与灰度**

* 执行 §12 场景，记录证据。

不允许把 A1–A2 与 Progress 功能混成一个大提交。基础语义必须能独立回滚和验证。

## 17. 每阶段统一验证命令



```
bun test src/adapters/feishu.test.ts
bun test src/adapters/pi-broker.test.ts
bun test src/adapters/progress.test.ts
bun test src/adapters/service.test.ts src/adapters/service-guard.test.ts
bunx tsc --noEmit
bun test
git diff --check
```

如果某测试文件不存在，新增后执行；如果全量测试存在已知基线失败，必须在改动前先跑基线并记录，不能把新增失败归为基线。

## 18. 开发交付要求

开发完成需提供：



1. 每阶段 commit 列表；

2. schema 变更与回滚说明；

3. 所有测试命令和精确通过 / 失败数量；

4. 真实飞书 10 个场景的证据；

5. 灰度配置；

6. 指标截图或查询结果；

7. 未验证项；

8. 明确说明是否触碰了用户无关文件；

9. devbox 与实际部署机器的代码版本 /commit 对齐结果。

## 19. 完成定义

只有同时满足以下条件才算完成：



* 所有定向测试和全量测试通过，或只有改动前已记录的基线失败；

* `git diff --check` 通过；

* 真实飞书话题连续性验证通过；

* 真实新建消息幂等语义验证通过；

* 429 与撤回降级验证通过；

* 10 秒短任务无进度卡；

* 长任务只创建一张卡；

* 重启后无永久处理中卡；

* 决策和终态不被进度更新延迟；

* 工具事件无敏感参数；

* 开关默认关闭且可安全回滚；

* 代码已在 devbox 提交，部署版本明确，未静默同步或覆盖本地用户改动。
