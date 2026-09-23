# Overload Documentation

## 当前文档

### architecture/ — 当前架构与核心设计

- [tech-solution.md](architecture/tech-solution.md) — 技术方案终版（sol 对齐）：ingest/reducer/ledger/CLI/dashboard 全貌
- [ledger-design.md](architecture/ledger-design.md) — 初版 ledger 设计（已被 tech-solution 取代，保留演进记录）
- [human-decision-design.md](architecture/human-decision-design.md) — 人类决策减负方案，R3 放行定稿
- [implementation-contract.md](architecture/implementation-contract.md) — human-decision-design 的 M0–M4 实施契约
- [orchestrator.md](architecture/orchestrator.md) — Orchestrator v1 实施计划（v2 修订）
- [reconcile.md](architecture/reconcile.md) — Orchestrator lease/活性/恢复语义定稿
- [artifact-management-tech-design.md](architecture/artifact-management-tech-design.md) — 外部 session 纳管、产物管理与跨 agent 交接技术方案 v4
- [context-management-plan.md](architecture/context-management-plan.md) — 上下文管理专项开发方案
- [context-interaction-design.md](architecture/context-interaction-design.md) — 上下文管理交互设计说明

### guides/ — 安装、配置、运维、集成

- [configuration.md](guides/configuration.md) — 配置项
- [operations.md](guides/operations.md) — 生命周期运维
- [integrations.md](guides/integrations.md) — adapter 集成

### decisions/ — 仍生效决策

- [git-boundary.md](decisions/git-boundary.md) — git 边界提案
- [managed-decision-bot.md](decisions/managed-decision-bot.md) — 受限 managed decision bot 实施契约

## 历史档案

[history/](history/) 包含已完成的计划、评审、报告与冻结契约，仅供追溯，不代表当前设计。

## 文档放置规则

- 新架构设计 → `architecture/`
- 安装、配置、运维、集成 → `guides/`
- 仍生效的决策 → `decisions/`
- 已完成的计划、评审、报告、契约、演示、测试日志 → `history/`
- 外部调研 → `research/`
