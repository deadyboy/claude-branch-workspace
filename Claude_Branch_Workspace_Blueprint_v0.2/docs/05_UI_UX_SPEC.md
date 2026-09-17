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

## Phase 4 data-model + UI constraints（S6 定稿）

### 领域/数据模型新增（Phase 4）

- **`events.seq_rel` = 项目级单调游标**（SCHEMA_VERSION 3）：任何 SELECT 一律 `seq_rel AS seqRel`（宪法 camelCase）；WS 帧、REST `?after=`、E2E timeline 共用。UI `latestSeqRel` 即最近消费游标。
- **明确 turn 生命周期**：`openTurn` → `completeTurn` / `failTurn` / `cancelTurn`（idempotent）；`conversation_node.status ∈ pending | completed | failed | cancelled`。interrupt = `cancelled`（**不是 failed**，gate 6）。
- **`EffectiveConversationItem {role, content, nodeId, origin:"inherited"|"local", seq}`**：fork 分支的聊天真相 = inherited 前缀（`≤ fork 点`，含）+ local（gate 3）。UI 据此渲染 `[inherited]`/`[local]` 徽标。
- **`messages.visible_content` 是用户自写的聊天真相（gate 4）**：只在"整个回复都 secret-shaped"时整体替换；scrub 是整串替换。UI 聊天只读 `visible_content`，绝不让事件流里的 assistant 文本掩盖它。

### UI 硬约束（Phase 4）

- **gate 14 — Shared only**：Phase 4 UI 无 worktree 选择器；Conversation Tree 顶部固定徽标 `Shared only · Worktree = Phase 6`；每个 branch 的 workspace 模式徽标仅显示 `S`（shared）。`worktreeIsolation` 能力按真实 adapter 返回（fake `false`）。
- **gate 9 / attribution 诚实**：工具事件只在 branch/turn 层渲染（Timeline 的 `tool.started`/`tool.completed` 行），Agent Monitor / 执行树只展示 AgentRun 的 name/task/status 组织——不宣称"某 tool 属于某 run"（`docs/04 §8`）。
- **gate 11 / per-branch busy**：chat composer 的 busy 状态按 branch 判定（`nodesByBranch` 中该 branch 存在 `pending` node），不是全局锁。
- **gate 6 / interrupt UX**：Interrupt 按钮只对当前 active branch 且 busy 时可用；结果 = node `cancelled`（Agent Monitor 不会永久 busy）。
- **gate 7 / attention UX**：Timeline 顶部 `attn-pinned` 渲染 attention/permission 卡片（pending 在前，answered 用 `.attn-answered` 显示结果）；Allow/Deny → `POST /api/attention/:id/respond`。Phase 4 只由假 runtime 播种。
- **gate 8 / reconnect**：`socketStatus` 顶栏红点（connected/connecting/offline）；reconnect = REST `?after=` 追赶 + WS gap-fill；去重集有界。
