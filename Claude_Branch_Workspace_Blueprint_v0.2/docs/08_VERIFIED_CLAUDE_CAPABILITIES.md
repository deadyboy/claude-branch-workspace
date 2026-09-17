# 08 — Claude Runtime Facts to Re-verify Locally

以下信息在蓝图制作时依据 Claude Code 官方文档核对过，但实现时必须针对当前安装版本重新验证。

核对日期：2026-09-17

## Officially documented

### CLAUDE.md

Claude Code 会加载项目级 `CLAUDE.md`，用于持久项目说明，并在 compaction 后重新读取。

Docs:
https://code.claude.com/docs/en/how-claude-code-works
https://code.claude.com/docs/en/glossary

### Session resume and branch

官方文档说明：
- session 会持续保存；
- `claude --resume`
- `/resume`
- `/branch`
- `--fork-session`
可用于继续或分支会话。

Docs:
https://code.claude.com/docs/en/sessions

### Agent SDK session fork

Agent SDK 文档说明：
fork 会复制原 session 的历史到新的 session id，原 session 保持不变。

Docs:
https://code.claude.com/docs/en/agent-sdk/sessions

### Conversation and filesystem are distinct

Session fork 复制 conversation history，不会自动复制 filesystem。

Docs:
https://code.claude.com/docs/en/agent-sdk/sessions

### Hooks

Claude Code 当前文档列出了包括：
- SessionStart
- UserPromptSubmit
- PreToolUse/PostToolUse
- SubagentStart/SubagentStop
- TaskCreated/TaskCompleted
- PermissionRequest
- WorktreeCreate/Remove
等 hooks。

Docs:
https://code.claude.com/docs/en/hooks-guide

### Rewind

Claude Code 文档说明 `/rewind` 可以回到历史消息并恢复 conversation/code 的不同组合。

Docs:
https://code.claude.com/docs/en/best-practices
https://code.claude.com/docs/en/sessions

## NOT assumed

以下内容在本蓝图中不能视作已验证：

- 有一个公开、稳定、非交互 API 可以直接 `fork(sessionId, arbitraryOldMessageId)`；
- CLI 可以在所有平台被 PTY 长期控制而无兼容问题；
- hooks 能提供 UI 所需的全部 message delta；
- 所有 native subagent 事件都能完美关联父任务；
- Agent SDK 使用体验/额度与交互式 Claude Code 完全一致；
- 40 个并发真实 session 在用户机器/计划上都可稳定运行。

这些属于 Phase 0 验证内容。
