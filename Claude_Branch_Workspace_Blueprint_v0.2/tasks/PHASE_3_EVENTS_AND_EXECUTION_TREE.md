# Phase 3 — Events and Execution Tree

## Objective

准确观察每个 persistent branch 内部正在发生的工作。

## Deliverables

- hook/event receiver
- normalization
- redaction
- persistence
- AgentRun lifecycle
- execution tree
- attention state
- realtime stream

## Required demo

一个 branch 发起包含多个 subagents/tool calls 的任务。

UI 暂时可以使用 debug page/CLI，但必须看到：
- agent start
- agent stop
- tool started/completed/failed
- permission/attention
- owner branch
- owner turn
- runtime 实际暴露时的 agent-to-agent communication

不能把 subagent 自动变成 persistent Conversation Branch。

## Gate

事件归属正确；敏感字段经过 redaction；独立 reviewer 通过。
