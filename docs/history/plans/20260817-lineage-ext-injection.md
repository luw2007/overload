# pi/omp 插件侧谱系注入设计（EXT-19 提案）

状态：已实现（EXT-19，test/ext-lineage.test.ts 5/5；已部署 ~/.pi 与 ~/.omp extension 目录，重启 runtime 生效）。

## 问题

`OVERLOAD_PARENT` 通道只有读端（extension/overload.ts:454），没有写端。跨进程 spawn 的
agent（`pi -p` 一次性评审、bash 里直接起 `omp`/`claude`）在 ledger 中 origin=unknown，
父边丢失。

## 结论先行

在 pi-core extension 的 `tool_call(bash)` seam 复用 EXT-11 的命令改写机制，自动为
spawn agent CLI 的命令注入 `OVERLOAD_PARENT=<本会话 stable_id> ` 前缀。一份实现同时
覆盖 pi 与 omp（同一 extension API，装机路径 ~/.pi 与 ~/.omp 各一份同文件）。

## 机制（与 EXT-11 同构，已被验证的 seam）

- 位置：src/extension/overload.ts tool_call handler（overload.ts:509-513 旁）。
- 触发：`/^(pi|omp|prime-agent|claude)\b/.test(command)` 且无 shell 元字符
  （沿用 `/[|;&`$()\n\r]/` 守卫）且命令中不含 `OVERLOAD_PARENT`。
- 改写：`event.input.command = "OVERLOAD_PARENT=<stableId> " + command`。
- 子端消费：pi/omp extension 已读该 env（EXT-03）；claude hook 在 N28 后也读。

## 明确不做

1. **同进程 task 子代理**：无独立 lifecycle/emitter，产出归父（commit trailer 即父
   stable_id）。为其发明 fork 事件要动 frozen EventKind 契约，且不占独立人类注意力
   上下文——负价值。
2. **带引号/元字符的复合命令**（`fish -c 'pi …'`、`cmux respawn-pane --command "…"`）：
   守卫直接跳过。此路径由调度方模板负责——cmux-pi-orchestration 的 CREATE_WORKER
   命令应写成 `--command "OVERLOAD_PARENT=<owner-stable-id> <fish> -lc 'pi …'"`
   （env 前缀在 /bin/sh launch 链中合法）。
3. **签名/防伪**：lineage 仍是弱声明。classifier 的 normalizeOrigin 保守化
   （非 human 即 agent）已经是正确的防御姿态，不加密码学。

## 风险

- 误触发（如 `pi --help`）：无害——env 被设置，子会话如实记录父边，语义仍真。
- 命令改写破坏引用：被元字符守卫排除（EXT-11 两个阶段实战无事故）。

## 验收口径

- extension harness 行为测试：spawn 命令被注入前缀；带元字符命令不动；已含
  OVERLOAD_PARENT 不重复注入；git commit trailer 注入（EXT-11）不受影响。
- 真机冒烟：agent 会话内 `pi -p 'echo hi'`，子会话在 ledger 中 origin=父 stable_id。
