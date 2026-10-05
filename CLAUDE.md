# CLAUDE.md — Project Constitution

你正在实现 **Claude Branch Workspace**。

此文件是项目级长期指令。除非用户显式修改项目目标，否则以下原则在整个开发过程中持续有效。

## 1. 产品核心

构建一个本地优先、可视化、可分叉的 AI 工作空间。

必须同时支持两类对象：

### Persistent Conversation Branch
长期、可交互、有独立 session context、可以继续调用工具，也可以继续产生分支。

### Transient Agent Run
Claude Code 在某个 turn 中临时创建的 subagent/worker。它属于执行过程，不等同于持久 conversation branch。

**严禁混淆这两类对象。**

## 2. 核心不变量

1. 一个项目存在一个或多个 root conversation。
2. 一个 branch 可以从任意已持久化的 conversation node 分叉。
3. 一个 branch 可以继续分叉。
4. Branch display name 可以重复。
5. 唯一身份必须由 immutable ID 决定，不能依赖名字或路径字符串。
6. 必须保存父分支、fork point、运行时 session 映射。
7. Conversation lineage 必须由本项目自己的数据库保存，不依赖 Claude 原生 session picker 是否完整展示 genealogy。
8. Conversation Tree 与 Execution Tree 分开存储、分开展示。
9. Shared filesystem 与 isolated worktree 是不同 workspace mode。
10. UI 只展示可观察的输出、任务、工具调用、状态和结果；不要尝试展示隐藏 chain-of-thought。

## 3. Claude Code 是 Runtime，不是需要重造的东西

优先复用当前 Claude Code 已存在能力：

- session persistence
- resume
- branch/fork
- rewind/checkpoint
- subagents
- hooks
- tools
- worktrees
- MCP

但所有外部能力都必须通过 Runtime Adapter 隔离，避免 UI 和 domain model 直接依赖 CLI 私有实现。

## 4. 任意历史节点 Fork 是 P0 核心需求

不要假设当前 Claude Code 提供稳定的 `fork(session, oldMessageId)` API。

Phase 0 必须做真实 capability spike。

Runtime Adapter 至少区分：

- `forkFromHead`
- `forkFromNode`
- `reconstructBranchFromHistory`

如果 native runtime 无法直接从任意旧 turn fork，允许兼容实现，但必须：

- 对用户保持语义正确；
- 保留 internal lineage；
- 不伪造 native ancestry；
- 标记 branch origin strategy；
- 有自动化测试。

## 5. 动态 Agent，不固定工作流

本产品服务的是“Main Agent 动态规划和派工”，而不是固定流水线。

不要硬编码：

- 10 个 extractor
- 10 个 reviewer
- 固定 DAG
- 固定角色集合

应该提供通用执行原语和资源池。

角色、并发规模、分波策略由主 Agent 根据任务动态决定。

## 6. 开发时如何使用 subagent

你自己开发本项目时，也应该合理使用 Claude Code subagent：

适合：
- 独立架构审查
- 并行代码探索
- 测试设计
- 安全审查
- UI review
- 独立验证关键假设

不适合：
- 单文件小修改
- 强依赖连续上下文的小任务
- 只是为了“多 Agent”而调用

重要 Phase 完成前必须安排至少一次独立 reviewer。

## 7. 技术实现偏好

默认优先：
- TypeScript end-to-end
- 本地 Node control plane
- SQLite 持久化
- React + TypeScript 前端
- WebSocket/SSE 实时事件
- Runtime Adapter 层
- WSL/Linux 作为第一条稳定执行路径；原生 Windows 作为兼容目标

不要因为这些偏好拒绝更好的技术方案。如果 Phase 0 发现明显更合适的实现，写 ADR 后可以调整。

## 8. 状态持久化

持续维护：

- `PROJECT_STATE.md`
- `IMPLEMENTATION_BACKLOG.md`
- `CHANGELOG.md`
- `decisions/`

当上下文可能接近 compact 时，先确保重要状态已写入上述文件。

## 9. 决策方法

对影响架构的决定：

1. 列出约束；
2. 至少比较两个可行方案；
3. 选择方案；
4. 写 ADR；
5. 不要在多个文档中留下冲突口径。

## 10. 测试优先级

核心行为优先于视觉：

P0/P1 必须优先测试：

- branch-of-branch
- duplicate labels
- exact ancestry
- restart recovery
- resume/fork mapping
- arbitrary historical node fork strategy
- concurrent event attribution
- shared/worktree isolation
- interrupt/stop/reconnect
- runtime crash recovery

## 11. 安全

不要：
- 自动读取 secrets；
- 把 token、API key、cookie 写入 event log；
- 默认开启危险 bypass；
- 自动做远程不可逆操作；
- 自动管理或绕过第三方账号/订阅限制。

运行时 profile 只保存配置引用和非敏感标识；认证由用户通过官方方式完成。

## 12. UI 原则

第一版“Agent Town 小人”可以先用状态卡片替代，等功能闭环后再增强动画。

UI 信息架构优先级：

1. Conversation Tree
2. Current Chat
3. Agent/Execution Monitor
4. Event Timeline
5. Task/Artifact Views

## 13. 工作方式

不要只写计划然后停止。

Phase 0 Gate 通过后，继续实现，直到遇到真实 blocker 或达到当前会话能完成的最大范围。

如果方案与现实 API 不匹配，修改方案并留下可追溯记录，而不是硬凑。
