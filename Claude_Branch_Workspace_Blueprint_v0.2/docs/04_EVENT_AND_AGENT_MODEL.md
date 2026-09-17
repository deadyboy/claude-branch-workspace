# 04 — Event and Agent Model

## 1. Two trees

### Conversation Tree
持久、可继续交互。

### Execution Tree
某个 conversation turn 内部的临时工作。

```text
Branch A / Turn 6
|
+-- AgentRun extractor-x
+-- AgentRun reviewer-y
+-- AgentRun tester-z
```

## 2. AgentRun

建议字段：

- `agent_run_id`
- `owner_branch_id`
- `owner_node_id`
- `parent_agent_run_id`: nullable
- `runtime_agent_id`: nullable
- `agent_type`
- `display_label`
- `task_summary`
- `status`
- `started_at`
- `ended_at`

status：
- queued
- running
- waiting
- needs_attention
- completed
- failed
- cancelled

## 3. Event envelope

所有 runtime-specific 事件先归一化：

```json
{
  "event_id": "uuid",
  "project_id": "uuid",
  "branch_id": "uuid",
  "node_id": "uuid-or-null",
  "agent_run_id": "uuid-or-null",
  "runtime_session_id": "string-or-null",
  "type": "tool.started",
  "timestamp": "...",
  "sequence": 123,
  "payload": {}
}
```

## 4. Canonical event types

最小集合：

- session.started
- session.resumed
- session.stopped
- session.failed
- message.user
- message.assistant.delta
- message.assistant.completed
- branch.created
- branch.archived
- agent.started
- agent.completed
- agent.failed
- agent.message
- task.created
- task.completed
- tool.started
- tool.completed
- tool.failed
- permission.requested
- attention.required
- workspace.changed

## 5. Hooks

Claude Code 当前存在丰富 hooks，可作为 event source。

但：
- hook schema 属于 runtime surface；
- normalize 后再进入数据库；
- UI 不直接消费原始 hook JSON；
- 大量事件需 batching/backpressure。

## 6. No hidden chain-of-thought

UI 可以展示：
- Claude 对用户可见文字；
- runtime 明确暴露的 agent-to-agent / teammate 消息；
- task descriptions；
- tool name；
- tool status；
- safe tool input summary；
- files touched；
- handoff；
- result；
- error。

UI 不展示：
- 模型隐藏 chain-of-thought；
- 内部不可见 reasoning token。

## 7. Redaction

event ingestion 前执行 redaction：
- auth headers
- API keys
- tokens
- cookies
- known secret file values

raw event 保留策略需要单独配置，默认偏保守。

## 8. Attribution honesty（gate 9，reviewer S1）

Gate 9 要求**工具事件归属诚实**：UI 只能把工具调用渲染在它们**真正**发生的 branch/turn 层，绝不捏造"哪个 agent run 调了哪个工具"的精度。

Phase 3 live 验证发现：`agent_run_id` 上存在 **fork 后的 task_id 复用** —— Claude 的 `system:task_*` 事件里 `task_id` 在父/子 run 间可能重用（`agentRunId:currentAgent()?.agentRunId` 不可靠）。据此：

1. **工具事件只归属 branch/turn**（`events.branch_id` + `events.node_id`），**不塞进任何 agent card**。
2. AgentRun（执行树）只用于把该 turn 内**嵌套子 run 的组织关系**展示在 node 的 turn 下（`/execution-tree`），展示 AgentRun 的 name/task/status——但不宣称"某工具属于某 run"。
3. 即使 `agent_run_id` 有值，UI 也不用它驱动工具卡的归属树。
4. AgentRuns 是 transient，**永不晋升为 branch**（宪法 §2/§8；`docs/10 §5`）。

这条规则保证：两台并行 run 的工具活动一前一后到达时，归属到正确的 branch/turn，不与 agent-card 层级误导（Phase 0 backlog 的 "concurrent event attribution" 场景即以此为验收）。
