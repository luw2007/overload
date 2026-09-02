> **历史文档**：本文件描述的部分能力（如 outbox/digest/attrib/Island 原生面板）已从代码中移除，不代表当前实现。

# P3 冻结契约（owner 独占；worker 只读）

依据：`docs/plans/overload-20260813-tech-solution.md` §2.1（active 可传输）/§2.8/§4-P3、`docs/research/overload-20260813-fleet-inventory.md` §4。P1/P2 契约继续有效。

## 模块边界与独占权（本批次）

| 路径 | 独占 owner | 内容 |
|---|---|---|
| `src/pull/**`, `scripts/deploy-devbox.sh`, `scripts/maintenance.sh`（仅 m6 修改）, `launchd/works.earendil.overload.pull.plist` | N10 | devbox 拉取器 + 部署脚本 + m6 |
| `src/hooks/**`, `scripts/install-claude-hooks.sh` | N11 | claude hooks 脚本族 + 安装器 |
| `test/**` | N12 | P3 三注入 + V-5 矩阵 |
| 其余 | Owner 冻结 | — |

跨模块：均可只读 import `src/shared/types.ts`；N10/N12 可只读复用 `src/recon/` 导出的 admin-spool 写入辅助（若未导出则各自本地实现，不改 N6 文件）。

## 协议 9：devbox 拉取器（N10）

- `src/pull/pull.ts`（Bun）：`--once`；`--remote`（默认 `devbox`）；`--remote-spool`（默认 `~/.overload/spool/devbox`，注意 devbox 侧扩展以 host_id=devbox 写入该子目录）；`--dest`（默认本地 `~/.overload/spool/devbox`——ingest 既有扫描自动覆盖，零改动）；`--ssh-cmd`/`--rsync-cmd` 可注入（测试用）；`--fail-threshold`（默认 4）。
- 传输：rsync 拉 `seg-*.ndjson` **与** `active-*.ndjson`（重叠靠 `(host,emitter_id,seq)` UNIQUE 去重——§2.1 已证）；`ssh -o BatchMode=yes -o ConnectTimeout=5`；整体 `timeout 55`；`flock ~/.overload/pull.lock` 单飞；仅新增/增长文件（rsync 默认行为足够，禁 `--delete`）。
- 断连语义：连续 `fail-threshold` 次失败 → 向本地 admin spool 追加 `source_outage{source:"devbox"}`（**journal 查询去重**：无 open outage 才发，复用 P2 N6 模式）；恢复成功且存在 open outage → `source_recovered{source:"devbox"}`。心跳文件 `~/.overload/pull.heartbeat` 每次成功 touch。
- `--once` 输出一行摘要（文件数/字节/失败计数）供 harness 断言。
- launchd plist：60s 间隔。部署脚本 `scripts/deploy-devbox.sh`：scp `src/extension/overload.ts` 到 devbox 的 `~/.pi/agent/extensions/` 与 `~/.omp/agent/extensions/`、写 `~/.overload/host`=devbox（0700/0600）、幂等可重跑、`--dry-run` 支持。**脚本只准备，不自动对 prime 部署**（prime 用 `-e` 手动加载，README 说明）。
- m6：`scripts/maintenance.sh` 中 recon 非零退出 → osascript 通知（一行修改，注明 review m6）。

## 协议 10：claude hooks（N11，实现 §2.8）

- `src/hooks/claude/overload-hook.sh`：POSIX sh，读 stdin 的 claude hook JSON（jq 允许，devbox 已有）。分发两类：
  - **lifecycle**（SessionStart/Stop/SubagentStop/Notification 类）：写 `session_started|working|settled|session_ended` 包络行；`session` = payload session_id；`writer_id = claude-<session>`；`emitter_id = claude-<pid>-<boot8>`（boot8 = 本进程随机 8hex）；seq 进程内单调（单进程通常 1 行）；counters 置 0；host 读 `~/.overload/host`。
  - **PermissionRequest（阻塞）**：进程启动即生成 `request_id=$(uuidgen)`，写 `decision_requested{request_id, tool_name, tool_input 摘要}`；等待决策输出（claude 原生流程）后写 `decision_resolved{request_id, state}`；超时写 `state:"timed_out"`；同进程闭环（§2.8）。**hook 永不阻塞/破坏 claude 本体**：spool 不可写则静默退出 0。
- 文件写入遵守 §2.1：`active-<emitter_id>-1.ndjson` 单进程单文件，退出前 rename 封段（trap EXIT）；0700/0600；换行终止。
- `scripts/install-claude-hooks.sh`：向 `~/.claude/settings.json` 非破坏合并 hooks 配置（备份原文件），`--uninstall` 支持，`--settings <path>` 可注入（测试）。
- 冒烟：以手工构造的 hook JSON 经 stdin 调用脚本，验证 spool 行合法（可用 `test/harness/validate-envelope.ts`）。

## 协议 11：attachments 跳转（devbox 维度，N10 顺带）

devbox 会话的 binding 由 ingest 侧已有逻辑照常入 attachments（若 recon 不覆盖 devbox 平台则允许为空）；CLI q1 对 `host=devbox` 的会话在 jump 位显示 `ssh devbox`+cwd 提示——由 N10 在 `src/pull/` 内提供一个纯函数？**否**：CLI 属 N5 路径，本批冻结。妥协：q1 已显示 stable_id（含 host），P3 不改 CLI；跳转增强留 P4。此为显式 scope 决策，不是 silent cut。

## 验收（N12 harness `test/harness/p3-injections.sh`）

| # | 注入 | 期望 |
|---|---|---|
| 1 | 本地伪 devbox（第二 spool 目录 + `--ssh-cmd` 换成本地 cp/rsync 到 localhost 路径）写入 ask 事件 → pull --once → ingest --once → notifier --once(file sink) | 通知行出现；端到端（写入→sent）耗时打印（真 devbox ≤2min 的本地等价证明：单轮拉取即达） |
| 2 | `--ssh-cmd` 强制失败 ×4 轮 + 继续 ×2 轮 | 恰 1 条 source_outage(devbox)；恢复后 1 条 source_recovered；期间零重复 |
| 3 | 伪 devbox 侧 writer 中途 kill（active 残留半行）→ pull → ingest ×2 | 完整行全部入账、半行不消费、重拉去重 0 新行 |
| V-5 | 矩阵：request/响应/超时/重复投递/lifecycle 各构造 hook JSON 打 N11 脚本 | 全部产出合法包络；PermissionRequest 同进程闭环（requested 与 resolved 同 request_id）；spool 不可写时 rc=0 静默 |

真 devbox 端到端（部署脚本 + 实测 ask 延迟）由 owner 在合并后执行，不属 N12。

## 完成信号

同前：`.done/<attempt_id>` 内容 = 最终 commit sha；逻辑单元提交；不跑格式化/全局套件。
