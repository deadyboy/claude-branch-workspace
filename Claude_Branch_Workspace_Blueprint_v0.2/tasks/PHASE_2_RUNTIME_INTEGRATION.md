# Phase 2 — Claude Runtime Integration

## Objective

让 persistent branch 对应真实可继续交互的 Claude session。

## Deliverables

- RuntimeAdapter
- Claude CLI adapter
- capability detection
- runtime session registry
- send/resume/fork/interrupt
- historical fork strategy implementation
- reconnection/reconciliation

## Required demo

1. Main 启动真实 Claude。
2. Main 完成至少 4 turns。
3. 从历史 turn 2 创建 child。
4. Main 继续 turn 5。
5. child 独立继续。
6. child 再创建 grandchild。
7. Control Plane 重启。
8. 三个 branch 都能恢复。
9. 名称重复不影响恢复。

## Gate

`ACCEPTANCE_CRITERIA.md` 中 Conversation Tree + Runtime 项全部通过。
