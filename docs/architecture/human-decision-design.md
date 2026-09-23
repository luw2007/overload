# Overload 人类决策减负方案

状态：claude_sub2api/claude-opus-5 经三轮审查，R3 APPROVE（仅设计放行）；定稿以正文加 §16 修订为准。尚未授权实现、生产操作或发布。

## 1. 目标与边界

定位保持：单操作员决策收件箱 + 受限编排器。减少不必发生的人类决策，压缩必须发生的判断，保证决定后可靠执行并回流。信息、授权、验收、方向抖动四类瓶颈分别通过聚合排序、事先授权、任务契约和证据、变更与停止条件治理解决。

闭环：明确目标与边界 → 执行自主推进 → 自动验证和有限恢复 → 承重判断交给人 → 记录并执行决定 → 核实效果 → 更新原项 → 无需注意力则归档 → 从重复决定提出授权建议。

非目标：不接管用户自启进程；不建多租户/组织权限平台；不让 bot 扩权；不等同进程结束、检查通过、PR 合并与业务成功；不增加日报墙；不承诺不可观测成本或外部进程硬预算；不重启活会话代替回答；不以批准掩盖效果未知。沿用 Bun、SQLite、spool、loopback Web、现有 bot 与 orchestrator，不造通用 runtime。

## 2. 架构选择

A 继续给队列补字段按钮：最便宜，但任务、会话、批准与结果割裂。B 复用执行系统，增加持久注意力项和任务契约：可统一闭环，代价是明确状态归属。C 统一 Agent runtime：控制强但越界。推荐 B，不另造编排器。

区分任务事实（要什么、验收、停止）、执行事实（谁在跑、效果）、注意力事实（是否需要人、决定是否落地）。不能混成一个 status。

## 3. 用户流程

自然语言派工，由 Agent 提取最小契约。明确答案直接提取，可逆细节自主决定；安全可执行但未知的内容注明假设；影响方向、权限、验收的缺失合并一次澄清。普通观察会话不强制契约；托管执行和自动授权才检查必需字段。

正常进度记录不提醒。仅承重歧义、授权/预算/停止条件触线、恢复耗尽、人工验收与后果承担节点占用注意力。

一张决策卡给结论、原因、建议、证据、各选项代价、不处理后果、有效期、原现场。影响仅来自事实，未知不得模型补造。决定后同卡显示已批准→执行中→PR 已建→等待合并→工程完成；部分失败明确展示已发生与未发生的效果，保留恢复状态，不新建孤立卡片。

## 4. 任务契约

最小字段：objective、beneficiary（可显式未知）、acceptance、non_goals、scope、budget、stop_conditions、decision_owner（默认当前操作员）、revision、created_by、change_reason。内容用版本化 JSON，常用关联字段单列。

acceptance 三类：check（已配置检查及退出状态）、artifact（交付物版本来源）、human（显式人工验收）。检查通过不证明充分；修改验收脚本属于验收变更，不能给自己降门槛。绑定契约及交付版本。品味不伪装成可自动测。

承重目标/范围/验收/预算变化：创建新版本，不覆盖；显示影响；旧范围/证据的未消费批准失效；已消费批准不撤销已发生效果；自启任务下个受控边界核验，外部会话只提示跳转。措辞微调不强制重审。

## 5. 身份与状态

work_id 关联 contract_revision、可选 task_id、stable_id/attempt_id、item_id、request_uid/approval_id、receipt_id 与证据。重试保留 work_id、更换 attempt_id。同一决策原地更新，同任务独立问题可多项但按任务分组；不同风险/效果不得强合并；旧数据不猜关联。

attention state：open（待处理）、applying（已消费落实中）、resolved（无剩余人动作）、superseded（被新版取代）。expired/denied/failed 等作原因与结果，不把业务语义塞一枚举。

effect_state：not_started→applying→succeeded/failed/unknown。unknown 不等同失败，不是自动重试授权。

Now/Inbox/Done 为投影：Now 有紧迫风险、即将失效或损失扩大证据；Inbox 普通决策、最终验收、可批处理项；Done 已解决或被取代且无剩余动作。正在等人不自动紧急；默认 Inbox。applying 不重复提醒，可近期结果查看；失败/未知重开原项。旧 ack 不是真回答，会话结束不掩盖未完成托管决定。

稍后处理 defer_until 不停止计时、不延长批准有效期；到期回待处理，重大新风险可唤回；显示延期是否继续阻塞。

## 6. 决策包和提醒

复用 question/options/effect/scope/evidence；补 conclusion、trigger、impact、recommendation、owner、expires_at、source_link、contract_revision、evidence_version、effect_state。模型只整理建议，不改权限。证据大则给引用而非全文。

确定性可解释排序：扩大风险→临近失效→阻塞关键任务→普通等待；同级稳定。禁止黑盒紧急分。

新增 Now 聚合提醒；无承重变化不重复；有效期阈值有限提醒；普通进度和自动恢复不提醒；非紧急完成更新原项并入摘要；静默时段的风险突破需明确配置。记录通知触发依据和版本，失败不得记已送达。当前支持 macOS，不暗加 Linux 适配，缺通知能力显式显示。

## 7. 授权与预算

三层：低成本可逆在已授权范围直接做；有边界自主在额度范围做；必须人工含指定高风险、超预算、方向变更。按影响/范围/可逆性，而非命令名字；现有精确命令/路径匹配继续复用。

策略优先级：有效性→明确禁止→必须人工→有效人工答案→明确自动授权→等待人。过期/证据不符人工也不能消费；禁止需改策略；bot 停用不阻塞合法人答；策略变化不能撤销副作用。

预算：重试次数持久化；托管时间到期禁止新受控动作，按已授权方式停自启任务；bot 时间/输出量复用当前限制；调用成本仅有可信计量和执行入口时硬限制；不透明外部会话仅软阈值/未知。暂停/kill 本身可有副作用，只管自启且身份核验的进程；不可中断效果不能原子撤回；不通过新 attempt/task 绕预算；人工扩预算记录原因新版本。

授权晋升：历史样本→精确候选→回放解释→人确认→先观察→人启用。不能由经常批准自动变永久权限。

## 8. 执行闭环与恢复

answered、consumed、effect confirmed 三时刻分离，第三步才算落实。消费前可在目标有效时再取答案；消费后无结果先 unknown 核查；部分效果从已确认步骤续，不从头重放；无法查询是否发生则人处理；幂等可核验才在预算内恢复；旧策略/证据失效重新决策。不承诺外部 exactly-once，保证消费去重、步骤留痕、未知不盲重放。

跨库：ledger.db 遥测投影；orchestrator.db 执行事实；orchestrator-answers.db 答案凭据。不依赖跨库事务。源状态变更同事务写 outbox，经既有 spool 发布，ingest 去重。event_id、work_id、可选 item_id、task_id/attempt_id、entity_version、kind、occurred_at、payload。失败可重发，乱序不倒退，旧 attempt 不覆盖新，消费完成推进发布确认，重启可重建。ingest 仍单向，不混命令回写。

checkPr 必须区分成功无异常、merged、业务异常、观测失败。观测失败不返回 clean；瞬时有限重试，权限/工具问题直接动作；耗尽原项显示无法确认；最后已知状态标过时。

runner 输出按 attempt 记录，含检查命令、退出状态、版本、采集时间；权限/大小/保留期限制；敏感内容展示/模型前处理；不可信事件不能指定任意读取路径；重试不覆盖旧证据；进程结束不证明日志完整。

## 9. 方向变化与停止

候选池仅一句话/来源/价值；默认不抢占不提醒，启动才补契约，不造排期平台。在途改向显示暂停/失效任务、已有交付、需要重做检查批准、已知成本耗时，未知写未知；记录原因。

硬停止条件（权限/额度/禁止）在受控边界停新动作；价值假设不足等判断条件提出继续/缩小/停止。证据到期不自动判死亡。

停止：取消未消费批准；禁止新 attempt；已授权流程停自启进程；保留产物/原因/未决外部效果；无剩余风险归档。删除工作区继续 clean/terminal/进程核验约束，不立即删证据。

## 10. 人类决策账本

指标：人类等待（需人到有效答案消费，不含执行）、落实延迟（消费到核验）、阻塞占比（区间并集）、指令变更返工（明确契约变更归因）、优先级抖动（改向暂停替换及已知损失）、可下沉比例（明确候选，不等于自动批准率）、停止延迟（条件触发到停止决定）、无效打断率（用户明确反馈，未反馈单列）、恢复成功率（可观测恢复样本）。

主动延期单记不抹时间；无计量不估事实；旧数据不能归因标 unknown；自动批准必须同看误放行/接管。扩展 audit 输出少量建议：重复操作可授权、验收频繁变更、停止条件已触发未决定。主动查看或 Inbox 摘要，不添通知。

## 11. 数据和模块

ledger 存原始遥测/会话/投影；orchestrator 存托管任务、attempt、恢复预算；mailbox 存批准/答案/提案/凭据；契约、注意力控制、延期、变更复用现有控制库，由独立模块管，不依赖可选编排器。待发布事件与源状态同库。保持数据库路径，不做无收益改名；只有一状态所有者，无双写兼容层。

最小实体：works、contract_revisions、attention_items、attention_events、outbox；任务补契约版本和预算。证据沿用文件，加索引版本，不造对象存储。

落点：orchestrator/pr 分类；orchestrator 主循环状态回流预算恢复；evidence/runner 证据；decision-bot 策略凭据；extension 效果回报能力关联；ingest 幂等投影；queries 分区；web 决策包延期结果契约；notify 提醒预算；cli/audit 账本；少量共享控制模块。Web/CLI/bot 共用状态逻辑。

接口复用现有批准消费；新写操作 expected_version 和幂等键；答案当前白名单；客户端不得自报成功/伪证据；读接口返回完整载荷和能力，不让 UI 猜；不支持给原因现场。路由按现有命名实现时统一，不另起批准 API。

## 12. 安全部署

同 UID 工作流边界不是沙箱；保持 loopback 和 CSRF；不暴露无认证控制面；自动授权默认关，新规则显式启用；human_only 不给 bot；源输入不可信；模型不能改策略/凭据/直接副作用。外部能力如实声明。维持 macOS 支持边界，如目标改 Linux，运行/通知需单独验收。

## 13. 迁移

1 版本化 schema、备份、统一入口，不在 Web 请求散建表。2 先补身份、事件、outbox，不改行为，验证重放。3 确定关联才回填。4 legacy 不强补契约，新增授权预算验收才要求字段。5 旧批准不扩大权限，不匹配自动提案失效。6 比较后 UI/通知同时切新投影避免双提醒。7 删除旧派生双写，保留历史；ack 非 answer、closeout 非验收。8 数据级回退；新强制策略启用后旧程序不理解则拒启，不能降级绕过；回退先停执行受控迁移。

## 14. 里程碑与验收

M0：PR 观测失败、终态回流、三时刻、runner 证据、Ask/ack 区别。验收 gh 失败不 clean；push 成功 PR 失败如实卡片；发布前后崩溃不丢不重卡；unknown 不重放；原项结束回流。

M1：契约、证据版本、变更、停止、legacy。验收合并承重澄清；变更失效旧批准；改检查不能沿旧依据；check 通过 human 条件未满足不完成；legacy 可观测跳转。

M2：分区、决策包、延期、提醒。验收普通阻塞不紧急；无事实不重复；延期不延有效期；风险唤回；浏览器回答冲突延期归档失败回流。

M3：策略优先级、预算、能力、候选规则。验收 human_only bot 不消费；重启额度不重置；旧证据契约过期不消费；人 bot 并发一次消费；未知成本不硬承诺；不 kill 外部。

M4：候选池、变更影响、停止、audit。验收不抢占；可定位变更返工；等待不重计；unknown 不归责；规则不自启；停止保留外部效果证据。

依赖 M0→M1→M2/M3→M4；接口固定后 M2/M3 可并行。本轮不实施。

## 15. 总体验证

真实场景：正常执行不巡视；Ask 支持则答否则跳转；人 bot 竞争一次消费；契约变化旧授权无效；消费后崩溃 unknown；PR 服务不可用有限恢复升级；延期保留期限代价；完成原项清退；预算不绕过；重启重放状态不丢。

关键边界留回归；真实 CLI/SQLite/spool 完整链路；临时仓库验证提交部分失败，不碰生产；实际浏览器流程；外部故障可控注入；集成后全套测试；无台账不声称效果。先建基线：人工次数、等待/落实延迟、恢复成功率、无效打断、阅读跳转、自动清退。不捏造减少 50% 目标，先证明不漏承重事项、不误放行、不增加噪声。

推荐先 M0，后契约授权，最后指标。执行前说清楚，执行中只交承重判断，决定后系统落实核验回流。

## 16. Opus 审查处置（R2/R3 修订，R3 已设计放行）

审查原文：`overload-20260906-opus-review.md`，模型 `claude_sub2api/claude-opus-5`，结论 REQUEST_CHANGES，4 P0 / 5 P1。本节为对前述概述的精确补充；冲突处以本节为准。只改方案，不改实现。不能将既有缺陷本身算成方案方向错误；但应明确修复与迁移先后及验收来源。

### 16.1 P0-1：事务发布、稳定身份与重放

接受丢事件风险；不接受“反复调用现有 spool.emit 即由既有去重吸收”的修法：emit 每次分配新 seq，journal 现有 UNIQUE(host,emitter_id,seq) 不按业务 event_id 去重。

源状态事务必须同时写持久 outbox；事件键采用 producer_id + entity_id + entity_version + event_kind，重发不得改变该身份或 payload。ledger 新增 applied_control_events(event_id PRIMARY KEY,payload_hash)，在同一 ingest 事务内插入去重标记及更新投影；同键异 payload 属完整性错误，不能覆盖。原始遥测的既有 seq 去重保留。

明确两阶段：published_at 只表示已耐久写出，不表示已消费；源发布器只读 ledger 的 applied_control_events 判断 delivered_at，ingest 不回写源库，因此不新增反向控制通道。未确认记录不可因普通 spool 保留期被永久删除；丢 segment 可由 outbox 原身份重发。ledger 不可读/远端无确认能力时保留 outbox，空间阈值触发明确阻塞，不伪造确认。各源有持久 producer_id，多个发布实例竞争需租约/事务领取；重复发布仍由事件键吸收。

跨库批准消费另有缝隙：mailbox receipt 是消费事实，orchestrator 应在推进任务的同一事务记录 applied_receipts(receipt_id UNIQUE) 与结果 outbox。崩溃后凭 receipt 对账，不能依赖再次 consume 返回答案；mailbox applied_at 是可重建的回执投影，不能先写为成功再推进任务。请求侧 approvals/注册意图/decision_requested 事件在源库同事务记录，注册 mailbox target 幂等重试。

验收：逐一注入源事务后/发布后/ledger 提交后/确认前崩溃；重复、乱序、同键异内容、spool 被清除均有明确结果；一项业务事件最多一次改变投影；只有真实未决项留在收件箱。

### 16.2 P0-2：观测失败不是健康

M0a 修复 pr.ts 两条失败返回 clean 的路径，删除 pr.test.ts 中锁定“gh failure returns clean”的反向断言，保留正确行为的回归。观测失败分类用 unknown，但不与副作用 effect_state=unknown 混淆。

持久保存 pr_observation_failures、last_observed_at、last_known_pr_state；预算独立于 runner 判活的 unknown_ticks，避免互相扣减/清零。不可恢复权限/工具错误直接升级；瞬时故障有限重试，耗尽显示 pr_unobservable。时钟注入，不用真实等待构造 24h 测试。

### 16.3 P0-3：部分效果必须逐步核实

提交结果按 push 与 pr_create 两步记录各自 not_started/applying/succeeded/failed/unknown、证据、目标 commit、remote、branch、PR URL。gh 返回错误不能断言 PR 未创建，网络失联可能是远端成功本地未收结果；先查询核验，无法查询则 unknown。远端存在同名分支也不能证明目标 commit 已推送，应比对 SHA；不同版本需要重新授权/处理，不得按“分支存在”跳过。

卡片字段 confirmed_effects / pending_or_unknown_effects 给出已知事实及证据；不以 pushed:boolean 替代不可知。M0a 覆盖 push 成功后 PR 明确拒绝与 PR 创建后丢响应两种不同结果。

### 16.4 P0-4：CI 选项效果不夸大，不增加隐式任务

接受现有 rerun/new-task 文案与效果不符。拒绝清空 pr_url 的修法：submitTask 会发现现有 PR，并不会调用 CI 重跑。也拒绝仅为了按钮兑现而自动 addTask：既有方向明确不自动建后继任务，且未经重新定义的任务会复制错误目标与预算。

最小干净切换：ci_anomaly 选项迁移为 recheck / manual-followup / abandon，各选项带明确 effect。recheck 只承诺重新查询状态，不承诺重跑 CI；同一异常指纹未改变时不创建新决策项或再次提醒，仍显示原异常。manual-followup 将任务保持 blocked、给 PR/现场入口，由人修复或通过显式派工创建后继，不标 done。abandon 只停止托管跟进，不声称关闭 PR。真实 CI 重跑能力不在此次最小范围，未来须绑定 run_id、重跑预算和副作用凭据另行设计。

旧未消费 CI 目标关闭并注册新版目标；旧答案不得转换成新语义。后继任务如由人显式创建，链接 predecessor_work_id，独立验收；旧任务只有未决效果已处置才可归档。

### 16.5 P1-1：工具结束与效果核实不能提前

拒绝在 extension 放行前 markReceipt(applied) 的建议，这会重犯 answered=effect 的错误。extension 将 receipt_id 关联 toolCallId/attempt，消费时只记录 applying；在真实 tool_result hook 记录工具完成证据，按效果类别判断可确认的结果。成功退出也不自动证明任意外部业务效果；不能核查则 unknown。工具报错但已知无效果才 failed，可能部分发生则 unknown。

通过既有 spool 发 effect_observed，receipt 控制方消费经来源、目标版本、工具关联校验的事件后更新回执及注意力项；不加任意客户端自报成功接口。丢 tool_result、宿主死亡或期限耗尽由持久 outstanding receipt 对账转 unknown；重启不得自动重放。人工 deny 表示策略拦截成功，但工具效果仍为 not_started。

### 16.6 P1-2：指标来源固定在 ledger

audit 继续只读 ledger，不联查多个写库。源 outbox 投影事件：attention_required（等待起点及责任人）、decision_consumed（等待终点/落实起点）、effect_observed（结果时间与证据）、recovery_outcome（恢复终态）、contract_revised（版本与原因）、work_redirected（受影响工作）、stop_condition_triggered、work_stopped、attention_feedback、notification_delivered、policy_candidate_evaluated。

等待/阻塞取 required→consumed 区间并集，延迟取 consumed→可核实 effect；恢复率取 recovery_outcome 中可观测样本；返工需 contract_revised 的明确归因链接；抖动取 work_redirected；停止延迟取 trigger→决定与实际停止分别统计；无效提醒取 feedback 对 delivered 的链接；可下沉率取 candidate_evaluated 的显式样本。缺任一端点不造值，显示 coverage/unknown，禁止用 received_at 替代发生时间掩盖传输延迟。

### 16.7 P1-3：改版不得提前释放执行占用

拒绝旧任务直接 blocked 就释放 repo 活跃索引的修法：活 runner 仍可能写工作区，旧 submitted PR 仍可能产生外部效果。契约 revision 默认在原 work_id 递增，不自动创建新任务。先记录 supersede_requested 并禁止新动作、使未消费目标失效；保持现有执行占用，直到可核实自启 runner 已停止且旧 attempt 已被围栏隔离。无法核实则保持占用并升级，不能以 owner lease 过期等同进程死亡。

submitted 无 runner 也需明确旧 PR 的继续跟进/停止托管决定及未决效果；不能因契约改版伪称 PR 已撤销。只有满足停止/交接条件才能释放占用，让新 attempt claim。批准失效用 closed/invalidation_reason，不伪写 consumed_at 或 actor='superseded'，否则账本把失效当人已回答。

R3 有界升级出口：supersede_requested 的停止核实有持久 deadline；达到期限或确认观测不可恢复时，创建唯一 human_only 的占用处理决定，选项为 confirm-stopped（人已在原现场核实指定 pid/boot_id/attempt 停止，提交证据后释放）、keep-held（继续保留占用并给下次处理时间）。不能用“愿意冒险”覆盖已知仍活的进程；若现有可用探测证实活着，拒绝 confirm-stopped。观测不可用时可接受具名人工停止证明，明确其事实来源为人而非机器核实。两者都没有则保持占用，UI/CLI 明示占用 work_id、责任人、期限及处理入口；不无限自动重试、不生成重复审批。

该升级不依赖 M0b 新 attention 投影：保留既有 approvals/mailbox 消费机制，增加明确占用门类型和 human_only 消费约束；CLI orch show/answer 从权威控制库可读可答，Web 事件未送达也不能成为唯一出口。M0a 必须同期具备该 CLI 出口；M0a→M0b 是依赖顺序不是可漏告警上线的阶段，两者完整通过 M0 验收后才启用新控制行为。supersession 正式能力在 M1 才启用。验收恒 unreadable：期限内一个人工项、CLI 显示占用；确认前 claim 被挡；明确停止证据确认后允许 claim；保留旧外部效果记录。

### 16.8 P1-4：human_only 的权威与复验

approval_targets 持久保存 decision_mode=human_only|scoped_auto，attention_items 只作展示投影；契约及策略版本纳入 targetVersion。普通源输入不能降低策略要求。bot 提议前拒绝 human_only，consumeDecision 消费时再次检查当前权威模式、策略和版本；只检查 matchingRule 不足以拦截已存在或失效竞争中的提案。默认无授权等同必须人答。

验收必须包括“先有合法 bot 提案，再改 human_only，最后 consume”不放行，以及有效人工答案仍可消费。bot disable 不阻塞人工路径当前已具备，仅回归保护。

### 16.9 P1-5：通知到期与新投影

这是改造现有 nudge，不是已实现能力。当前按新增 ID 提醒，与注释的仅空→非空不同。通知改读 attention 投影，持久 urgency、expires_at、defer_until、risk_revision、last_notified_revision/threshold；无需再在 requests 复制权威状态。跨越有效期阈值是一个可去重的变化，时间推进可触发一次通知，不必换 item_id。失败不更新已送达，能力缺失 health 明示。

ack 另存 acknowledged_at，只代表已阅，不改变答案状态；legacy ack 保留历史语义标记，不猜用户曾答复。人工延期仍计等待，归档需无未决责任。

### 16.10 修订里程碑与状态

M0a 先处理已确认缺陷及反向测试：PR 分类、部分效果、CI 选项、审批事务与稳定事件键。M0b 接上 outbox 发布/投影/确认、源对账、效果及日志。无损回流验收必须在 M0b 这些前提齐备后运行；§13“先补事件不改行为”只指准备阶段不切换界面，不要求保留错误语义。后续 M1→M2/M3→M4 不变。

当前状态：Opus 首轮 REQUEST_CHANGES（4 P0 / 5 P1）；owner 修订后 R2 仅余 B-1；补齐有界人工升级出口后 R3 APPROVE，无剩余设计阻塞。原文见 overload-20260906-opus-review.md、overload-20260906-opus-review-r2.md、overload-20260906-opus-review-r3.md。不代表实现或运行验收。视觉仍受原指定 Fable 的版本兼容阻塞，用户此次只授权 Opus review。
