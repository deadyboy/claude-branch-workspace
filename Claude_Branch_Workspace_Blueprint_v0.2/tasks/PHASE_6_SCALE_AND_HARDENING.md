# Phase 6 — Scale and Hardening

## Objectives

- 并发
- worktree
- crash recovery
- performance
- UX hardening

## Concurrency

逐级：
- 5
- 10
- 20
- 40（如果真实 runtime/机器允许）

记录真实瓶颈，不伪造“支持 40”。

## Scheduling

并发槽是资源池，不是固定角色。

可增加：
- global max
- per-runtime-profile max
- per-project max
- priority
- queue
- user-pinned branch

## Worktree

实现：
- branch create with worktree
- lifecycle
- cleanup
- conflict display
- optional merge workflow

## Crash recovery

- control plane restart
- Claude process crash
- stale PID/session
- unfinished turn reconciliation
- event replay/dedup

## UI scale

- large tree virtualization
- agent grouping
- event collapsing
- active-only filters
