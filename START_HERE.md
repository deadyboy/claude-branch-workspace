# START HERE — Claude Code 执行入口

如果你是负责实现本项目的 Claude Code 主 Agent，按以下顺序执行。

## 0. 首先承认项目性质

你不是在实现一个固定 workflow engine，也不是重新实现一个大模型 Agent runtime。

本项目是一个：

> **Claude Code Visual Control Plane / Branchable AI Workspace**

Claude Code 继续负责推理、工具调用、原生 subagent 和真实工作执行。本项目负责会话树、可视化、事件、人工介入、运行时适配和持久状态。

## 1. 必读文件

依次读取：

1. `CLAUDE.md`
2. `AGENTS.md`
3. `docs/00_PRODUCT_SPEC.md`
4. `docs/01_SYSTEM_ARCHITECTURE.md`
5. `docs/02_CONVERSATION_TREE.md`
6. `docs/03_RUNTIME_ADAPTER.md`
7. `docs/04_EVENT_AND_AGENT_MODEL.md`
8. `docs/05_UI_UX_SPEC.md`
9. `docs/06_SECURITY_AND_PERMISSIONS.md`
10. `docs/07_SELF_REVIEW.md`
11. `docs/08_VERIFIED_CLAUDE_CAPABILITIES.md`
12. `ACCEPTANCE_CRITERIA.md`
13. `tasks/PHASE_0_CAPABILITY_AND_ARCHITECTURE.md`

## 2. 不要立刻大规模编码

必须先执行 Phase 0：

- 检测当前机器环境；
- 检测当前 Claude Code 版本；
- 验证 session / branch / resume / rewind / hooks / subagent 的实际行为；
- 特别验证“任意历史节点 fork”的可实现路径；
- 验证 Windows/WSL 实际运行环境；
- 形成 Runtime Capability Matrix；
- 对本蓝图做一次工程可行性审查；
- 将需要修改的架构写成 ADR。

只有 Phase 0 Gate 通过，才进入正式编码。

## 3. 实施顺序

- Phase 0：能力验证 + 架构定稿
- Phase 1：Conversation Tree + 本地状态层
- Phase 2：Claude Runtime Adapter + 真正的可交互 session/fork
- Phase 3：事件采集 + Execution Tree + 可观察性
- Phase 4：可用 UI
- Phase 5：Main Agent 可调用的 `agent-control` MCP
- Phase 6：Worktree、并发、崩溃恢复、压力测试、打磨

不要为了“看起来完整”提前跳过前面的 Gate。

## 4. 自主执行规则

当前 Phase 的验收条件全部满足后，可以直接进入下一 Phase，不必等待用户逐阶段确认。

只有以下情况才需要用户介入：

- 需要登录/授权外部账户；
- 需要不可逆远程操作；
- 需要付费/购买；
- 需求出现本质矛盾，且不同选择会改变产品方向；
- 本地环境缺少无法自行安装或替代的系统依赖；
- 需要用户选择是否允许高风险权限。

一般技术细节由你自行决策，并写入 ADR。

## 5. 每个 Phase 的固定收尾动作

1. 跑测试和验收脚本；
2. 使用独立 reviewer subagent 审查本 Phase；
3. 修复 blocker/critical 问题；
4. 更新 `PROJECT_STATE.md`；
5. 更新 `IMPLEMENTATION_BACKLOG.md`；
6. 必要时新增 ADR；
7. 更新 `CHANGELOG.md`；
8. 提交一个清晰的 git commit（如果仓库已初始化且用户允许本地 git 操作）。

## 6. 不允许的偏航

不要：

- 把系统做成固定 10 Extractor + 10 Reviewer 等角色；
- 用 branch 名称作为主键；
- 把临时 subagent 和持久 conversation branch 混成同一种对象；
- 让 UI 依赖模型隐藏推理过程；
- 让多个 session 在共享目录中无控制地并行修改同一文件；
- 假定某个 Claude CLI 内部 JSONL 格式永远稳定；
- 为了快速 demo 牺牲核心树模型，导致后续无法支持 branch-of-branch；
- 在未验证“任意历史节点 fork”之前宣称该能力已完成。
