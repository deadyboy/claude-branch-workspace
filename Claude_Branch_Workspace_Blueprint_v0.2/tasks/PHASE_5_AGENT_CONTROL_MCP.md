# Phase 5 — Agent-Control MCP

## Objective

不仅用户能 fork，Main Agent 自己也能创建和管理 persistent branch。

## MCP tools

建议：

- `create_branch_from_node`
- `create_branch_from_current`
- `send_message_to_branch`
- `list_branches`
- `get_branch_status`
- `interrupt_branch`
- `archive_branch`
- `get_execution_summary`

## Important

Persistent branch creation 是高层 Control Plane 动作。

Native subagent creation 仍由 Claude Code 原生能力负责。

不要把每个 subagent 都提升成 branch。

## Main context protection

MCP 返回简洁状态/handoff，不把全量 event stream 塞进 Main。

## Gate

Main 能：
1. 判断一个问题值得长期分支；
2. 创建 branch；
3. branch 独立工作；
4. Main 继续自己的工作；
5. Main 获取 branch 的结构化结果；
6. 用户可以中途进入这个 branch。
