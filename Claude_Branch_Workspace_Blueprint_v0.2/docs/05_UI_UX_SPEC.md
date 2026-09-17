# 05 — UI / UX Specification

## Main layout

```text
+----------------------+----------------------------+----------------------+
| Conversation Tree    | Current Branch Chat        | Agent / Work View    |
|                      |                            |                      |
| Main                 | User ...                   | Main      working    |
| |- A                 | Claude ...                 | Agent 01  reading    |
| |  \- A.1            |                            | Agent 02  testing    |
| \- B                 | tool cards                 | Agent 03  done       |
|                      |                            |                      |
+----------------------+----------------------------+----------------------+
| Timeline / Attention / Permission / Activity                            |
+-------------------------------------------------------------------------+
```

## Conversation Tree

每个 branch 展示：
- display name
- status
- short id
- workspace mode icon
- running/attention badge

展开 branch 后可以查看 turns。

每个 turn 支持：
- Fork from here
- Bookmark
- Copy reference
- Inspect execution
- Compare descendants

## Branch naming

名称不要求唯一。

UI 使用 breadcrumb：

`Main / 数据抽取 / 时间冲突 [a91c]`

避免强制 `fork1/fork2/fork3`。

## Chat panel

必须是真正的 persistent session chat，不是静态日志。

用户可以：
- 发送消息
- stop/interupt
- 查看 tool calls
- 处理 permission/elicitation
- 继续 fork

## Agent View

第一版：
卡片/列表。

以后：
可切换 “Town” 视图，用人物/小房间可视化。

如果 runtime 暴露 agent-to-agent / teammate 消息，Agent View 可以提供 Communication 子视图，按发送者、接收者、所属 branch/turn 展示这些**可观察消息**；如果 runtime 不暴露，则不得推测或伪造。

状态映射示例：
- walking/working = running
- reading icon = read/search
- terminal icon = bash
- sleeping/seat = idle
- red alert = attention/failure

动画只是视图，不是状态源。

## Timeline

按 branch/turn/agent 聚合大量 event。

需要：
- filter
- pause autoscroll
- collapse repeated tool events
- error focus
- permission focus

## Tree scalability

随着 branch 增多：
- collapse
- search
- filter active only
- mini map
- virtualized rendering

不要一次画出 1000 个节点导致 UI 卡死。

## Human control

任何 persistent branch 都可以：
- open
- message
- interrupt
- archive
- rename
- fork
- inspect workspace
