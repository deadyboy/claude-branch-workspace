# Claude Branch Workspace — Blueprint v0.2

这是一个可直接交给 Claude Code 开始实现的项目蓝图。

## 产品一句话定义

**Branchable AI Workspace**：把 Claude Code 当作 Agent Runtime，在其上构建一个本地优先的可视化 Control Plane，让用户可以：

- 保留一个长期 Main 会话；
- 从**任意历史对话节点**创建独立、持久、可交互的新分支；
- 分支还能继续分叉，形成清晰的 Conversation Tree；
- 每个持久分支都拥有自己的 Claude 会话上下文，并可调用工具；
- Main 或任意持久分支可以临时调用 subagent 并行工作；
- UI 同时展示 Conversation Tree 与临时 Agent Execution Tree；
- 用户可随时切入任意持久分支继续聊天；
- UI 可以看到 Agent 的任务、状态、工具调用、消息和结果，但不展示模型隐藏思维链；
- 后续支持几十个并发执行槽，而不把工作流写死成固定的 Extractor/Reviewer 流水线。

## 解压后怎么开始

1. 进入本目录。
2. 启动 Claude Code：
   ```bash
   claude
   ```
3. `CLAUDE.md` 会作为项目级长期指令自动加载。
4. 将 `prompts/FIRST_PROMPT.txt` 的内容粘贴给 Claude Code。
5. Claude 必须先执行 Phase 0：能力验证与架构审查，通过 Gate 之后才开始正式编码。
6. 后续无需逐 Phase 等待人工确认；只要当前 Gate 通过，Claude 可以继续执行下一 Phase。只有遇到真正需要用户选择、凭证、危险操作或外部账户授权时才暂停。

## 先读哪些文件

Claude 的强制阅读顺序写在 `START_HERE.md`。

人类快速了解项目，建议按以下顺序：

1. `docs/00_PRODUCT_SPEC.md`
2. `docs/01_SYSTEM_ARCHITECTURE.md`
3. `docs/02_CONVERSATION_TREE.md`
4. `docs/03_RUNTIME_ADAPTER.md`
5. `docs/04_EVENT_AND_AGENT_MODEL.md`
6. `docs/05_UI_UX_SPEC.md`
7. `docs/06_SECURITY_AND_PERMISSIONS.md`
8. `docs/07_SELF_REVIEW.md`
9. `tasks/`

## 重要设计原则

1. **不重写 Claude Code。** Claude Code / Agent SDK 是 Runtime；本项目负责 Control Plane、树结构、事件、UI 和调度接口。
2. **Conversation Tree 与 Execution Tree 分离。**
3. **名字不是身份。** 所有 Branch/Node/AgentRun 使用不可变 ID；显示名称允许重复。
4. **任何历史节点都应该能成为新的未来。** 这是产品核心，不是附加功能。
5. **不要把 40 个并发写成 40 个固定角色。** 并发是资源池；角色由主 Agent 按任务动态决定。
6. **Shared Workspace 与 Isolated Worktree 两种模式都要支持。**
7. **UI 展示可观察事件，不展示隐藏 chain-of-thought。**
8. **Main 上下文不吸收全部 Worker chatter，只接收必要 handoff/结果。**
9. **底层 Runtime 必须可替换。** 首先服务 Claude Code CLI；Agent SDK 作为可选适配器。
10. **先证明关键能力，再做漂亮 UI。**

## 当前状态

这是设计与执行蓝图，不包含已经完成的产品实现。

Claude Code 开始执行后必须持续更新：

- `PROJECT_STATE.md`
- `IMPLEMENTATION_BACKLOG.md`
- `decisions/`
- `CHANGELOG.md`
