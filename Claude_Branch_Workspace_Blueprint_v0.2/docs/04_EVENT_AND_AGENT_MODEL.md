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
