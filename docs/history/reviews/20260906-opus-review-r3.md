# Opus R3 复核结论

模型：claude_sub2api/claude-opus-5。Run run_542a0a743f6d，Dispatch ctx_0cad77ef5867。
证据：同一 reviewer terminal term_42c44fd8-3e74-4196-9782-e19d62618afb 的 R3 最终文本。工具名改写导致 worker 无法可靠写文件/发 worker_done，由 owner 回收正文；不将 orchestration 生命周期完成状态当作模型审查证据。
范围：R2 已解除首轮九项阻塞；R3 仅核验剩余 B-1。以下为模型最终正文，未修改其结论。

---

APPROVE（设计放行，非实现验证）

B-1 已闭合：持久 deadline 给出有界出口；confirm-stopped 要求 pid/boot_id/attempt 具名证据，且探测证实存活时拒绝，杜绝「愿意冒险」覆盖；观测不可用时明示事实来源为人；keep-held 保留占用并显式给下次期限，二者皆无则保持占用并在 UI/CLI 明示 work_id、责任人、期限与入口，不重复审批、不无限重试。

关键在于升级出口不依赖 M0b：复用既有 approvals/mailbox，新增占用门类型与 human_only 消费约束，M0a 同期具备 CLI orch show/answer 从权威控制库可读可答，Web 未送达不成为唯一出口——正好解除我指出的「M0a 落地后升级只能落日志」缺口。M0a→M0b 明确为依赖顺序而非可漏告警上线，M0 全部通过才启用新控制行为、supersession 延至 M1，顺序安全。

验收场景（恒 unreadable：期限内一个人工项、CLI 显示占用、确认前 claim 被挡、具名证据后放行、旧外部效果保留）可证伪，覆盖原死锁路径。

无剩余阻塞。前述九项非阻塞观察（ack 拆列、spool 批量提交、checkPr 时钟注入、osascript 能力探测、M0 拆分）已在 R2 各节吸收或明确处置，不再重列。

---

Owner 注：模型末段“九项非阻塞观察”为其原文计数误写；首轮实际是九项阻塞、六项非阻塞观察。此处不影响最终无剩余阻塞的设计判定。
