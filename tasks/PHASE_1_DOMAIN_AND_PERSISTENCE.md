# Phase 1 — Domain and Persistence

## Objective

在没有漂亮 UI 的情况下，建立可靠的内部 Conversation Tree。

## Deliverables

- project
- branch
- conversation node
- message
- runtime session mapping
- workspace binding
- migrations
- domain services
- CLI/debug commands for inspection

## Required domain commands

- createRootConversation
- appendCompletedTurn
- createBranchFromNode
- renameBranch
- archiveBranch
- getBranchAncestry
- getConversationTree

## Tests

必须覆盖：
- nested branch
- duplicate labels
- ancestry
- restart
- invalid cross-project parent
- fork point validity

## Gate

可以用纯本地 fake runtime 完成：

Main
- T1
- T2
  - Branch A
    - T1
    - T2
      - Branch A1
- T3

重启后树完全一致。
