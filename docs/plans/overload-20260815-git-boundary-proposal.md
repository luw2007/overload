# 立项书：git 执行边界（提交归因 100% 强制）

状态：立项（P4 交付物，未排期）。前置：tech-solution §2.6、REVIEW-P1 B4 裁定（100% 归因需强制边界，观测归因为 v1）。

## 问题

当前归因三级（trailer > head_observed > window_correlated）对"绕过 bash 工具的提交"（IDE、脚本、子进程、MCP git 工具）只能给中低置信度。100% 强制要求所有提交经过一个可注入 trailer 的执行边界。

## 方案候选（择一，实施前需 sol 对抗评审）

1. **repo 级 core.hooksPath 治理**：归因宇宙内仓库统一指向 `~/.overload/git-hooks/`（prepare-commit-msg 注入 trailer，从环境/lease 文件读 session）。优点：覆盖一切提交路径；缺点：需要逐仓开启（可由 recon 检测未治理仓库并告警）、与既有 hooksPath 冲突需合并策略。
2. **git wrapper（PATH 前置）**：agent 运行时 PATH 注入 wrapper。优点：零仓库改动；缺点：只覆盖走 PATH 的调用，绝对路径 `/usr/bin/git` 绕过——不满足 100%，仅作纵深。
3. **GIT_CONFIG_* 环境注入**（`GIT_CONFIG_COUNT` + `core.hooksPath`）：扩展在 session_start 设置环境，随 agent 子进程继承。优点：会话作用域、无全局污染；缺点：非 agent 子进程的提交不覆盖（人工提交本就不该带 agent trailer——**这可能恰是正确语义**）。

## 建议

候选 3 为主（会话作用域 = 语义精确：只有 agent 会话内的提交被标记）+ recon 扫描未带 trailer 的 agent 时段提交作审计兜底（已有 window_correlated 机制）。候选 1 仅对高价值仓库选择性启用。

## 验收（实施时）

- agent 会话内任意方式产生的提交（bash/脚本/绝对路径 git）100% 带 `Overload-Session:` trailer；
- 会话外人工提交 0 污染；
- 归因报告 trailer 级占比在启用仓库 ≥99%（残余为审计告警）。
