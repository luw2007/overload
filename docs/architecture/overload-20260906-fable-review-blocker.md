# Fable 方案审查阻塞记录

方案：docs/plans/overload-20260906-human-decision-design.md
指定模型：claude_sub2api/claude-fable-5-1（未替换）
Run：run_542a0a743f6d
Task：task_ff1a660674fd
Dispatch：ctx_6357fd0def7f
Worker terminal：term_400d97d2-ce2f-4be3-add4-12713701456a

请求在模型开始审查前被上游拒绝：

```
Claude Code 2.1.220 does not support this model; version 2.1.251 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.
error_code: claude_code_version_too_old
request_id: req_011CemxHKoWiZhdXfSp9V9GH
```

本地 provider baseUrl 指向 http://127.0.0.1:20128；该端口进程 cwd 为 /data00/home/luwei.will/workspace/botmux-claude/OmniRoute-main。
该代理 src/shared/constants/claudeCodeClient.ts:7 固定 CLAUDE_CODE_CLIENT_VERSION = "2.1.220"；open-sse/executors/claudeIdentity.ts:20 引用它，open-sse/executors/base.ts:1244 用作 Claude User-Agent。
因此仅升级 pi 或本地 claude CLI 不能确认解决当前代理发出的版本标识。尚未修改共享代理、伪造新版本或重启服务。

状态：审查未执行，不存在 APPROVE。视觉方案按用户指定依赖尚未启动。需修复/升级该代理的 Claude 兼容实现并验证，再以同一模型重新派发。
