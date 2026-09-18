# Claude Branch Workspace — Blueprint v0.2

本地 Claude 会话分支工作空间，包含控制面、Web UI 与 stdio MCP。
实现与验收进度见 `PROJECT_STATE.md`；原始蓝图保留在 `docs/` 与 `tasks/`。

## 启动（原生 Windows PowerShell）

需要 Node.js（本次使用 24.15.0）、pnpm 11.22.0、Git、已配置认证的 Claude Code。
在本目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

打开 `http://127.0.0.1:15723`。默认数据库为当前目录的 `data/cbw.db`。
`CBW_DB`、`CBW_PORT` 可指定独立数据库/端口；`CBW_BASE_URL` 指定网关。
会话设置会明确覆盖 CLI 全局设置中的旧网关地址，但不会修改全局配置或落盘凭据。
不设置模型覆盖时保留 Claude Code 已选模型。

`CBW_MAX_CONCURRENT`、`CBW_PER_PROJECT` 默认都是 5；共享目录允许并发，
存在同文件写入冲突风险。需要独立写入时选择 worktree；创建源必须有提交且工作区干净。
Worktree 来自当前 Git HEAD，不是历史对话时刻的文件快照。归档保留文件。

## 主控接入

先启动控制面，再将 `node <本目录绝对路径>/apps/mcp-server/dist/index.js` 注册为
主控客户端的 stdio MCP。设置 `CBW_CONTROL_PLANE_URL` 可连接自定义控制面端口。
完整工具契约与配置例子见 `docs/12_MCP_CONTROL_PLANE.md`。

主控读取分支/节点 ID，创建持久分支，发送任务后获得 `nodeId`，用
`get_turn_result` 获取终态和有界回答。用户在 Web UI 中看到并接管同一分支。
此接口管理本项目的 Claude 会话，不会自动控制 Codex 桌面所有任务。

## 验证

```powershell
pnpm test
pnpm test:e2e
pnpm test:live
node scripts/phase5-agent-live.mjs
node scripts/phase6-capacity-live.mjs
```

默认测试使用模拟运行时。`test:live` 会启动真实 Claude 调用并保留独立测试数据库，
需要网关可用。模拟并发容量与真实模型吞吐分别记录，不把模拟 40 会话宣称为真实 40 会话。
`phase5-agent-live` 复用最近一次成功的 live fixture；容量探针默认依次实测 5/10/20，
首个失败等级后停止。最终验证结果见 `PHASE5_6_HANDOFF.md`。

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

## 原始蓝图启动说明（历史保留，现有实现使用上方启动命令）

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

已经包含产品实现；当前开发分支为 `codex/phase5-6-integration`。
准确通过情况与未决项以 `PROJECT_STATE.md` 及 `docs/generated/` 的验收记录为准。

Claude Code 开始执行后必须持续更新：

- `PROJECT_STATE.md`
- `IMPLEMENTATION_BACKLOG.md`
- `decisions/`
- `CHANGELOG.md`
