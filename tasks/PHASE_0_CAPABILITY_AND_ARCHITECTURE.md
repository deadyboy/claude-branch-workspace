# Phase 0 — Capability Spike and Architecture Gate

## Objective

不要大规模实现产品。先证明底层关键假设。

## Tasks

### A. Environment inventory

记录：
- OS
- 是否 WSL
- Node
- package manager
- git
- Claude Code version
- Claude executable path
- current project path
- terminal/PTY constraints

输出：
`docs/generated/ENVIRONMENT_REPORT.md`

### B. Claude capability probe

在独立 disposable sandbox 中验证：

1. 创建 session；
2. 多轮对话；
3. session id 能否可靠获得；
4. resume；
5. fork from current head；
6. branch 后原 session 是否保持不变；
7. branch-of-branch；
8. `/rewind` 的实际交互和可自动化程度；
9. 能否稳定实现“任意历史节点 fork”；
10. hooks；
11. subagent start/stop；
12. worktree；
13. interrupt；
14. permission flow。

严禁用真实重要项目做破坏性测试。

输出：
`docs/generated/RUNTIME_CAPABILITY_MATRIX.md`

### C. Historical fork spike

至少比较：

#### Option 1
native direct historical fork

#### Option 2
native fork + rewind of fork

#### Option 3
reconstruct new branch from conversation prefix/snapshot

记录：
- 正确性
- 是否保留原 session
- 自动化难度
- platform compatibility
- transcript/API coupling
- context fidelity
- maintenance risk

输出 ADR：
`decisions/ADR-006-historical-fork-strategy.md`

### D. Process control spike

证明 control plane 可以：
- start Claude session
- send one user prompt
- stream visible output/events
- interrupt
- preserve session id
- resume

如果 native interactive CLI 很难稳定控制，记录 SDK/CLI hybrid 方案。

### E. Architecture review

至少启动一个独立 reviewer subagent，审查：
- domain model
- runtime boundary
- event model
- concurrency
- arbitrary fork
- file isolation
- security

修正蓝图冲突。

### F. Stack ADR

确认：
- TypeScript/Node
- control plane framework
- SQLite library
- UI stack
- process/PTY library
- packaging path

输出：
`decisions/ADR-007-implementation-stack.md`

## Gate

必须全部满足：

- [ ] 能创建并恢复至少一个真实 Claude session
- [ ] 能创建独立 fork
- [ ] arbitrary historical fork 有明确、测试过的实现策略
- [ ] 能获得足够的可观察事件构建 v0 Execution View
- [ ] shared/worktree 语义明确
- [ ] 失败点和降级方案记录
- [ ] reviewer 无 blocker
- [ ] PROJECT_STATE 已更新

Gate 不通过：不要假装通过。修订架构。
