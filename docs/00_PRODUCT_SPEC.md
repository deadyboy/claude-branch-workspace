# 00 — Product Specification

## 1. Problem

Claude Code 已经具备强大的 Agent、工具调用、subagent 和 session 能力，但用户需要一个更强的工作空间：

- 一个长期 Main 会话；
- 从历史任意位置探索不同未来；
- 多个持久分支可并行推进；
- 分支可以继续分叉；
- Main 可以动态产生大量临时 subagent；
- 用户能看见谁在做什么；
- 用户可以随时介入某个持久分支；
- 大量并发时仍然保持结构清晰。

## 2. Product Definition

**Branchable AI Workspace / Claude Code Visual Control Plane**

不是：
- 固定工作流引擎；
- 多 Agent 聊天室；
- 新的大模型 Runtime；
- 单纯终端皮肤。

是：
- conversation version tree；
- session control plane；
- runtime observability layer；
- human-in-the-loop workspace；
- dynamic agent resource surface。

## 3. Primary User Mental Model

像 Git，但分支的对象是“AI 对话与任务世界线”。

Main：
1 → 2 → 3 → 4 → 5 → 6

从 3 分叉：
3 → A1 → A2

从 A1 再分叉：
A1 → A1.1 → A1.2

原 Main 继续存在：
4 → 5 → 6

## 4. Persistent vs Transient

### Persistent Branch

用户可以再次打开、继续聊天、继续调用工具、继续分叉。

### Transient Agent Run

某个持久 branch 在执行某一轮任务时临时产生的 worker。

二者必须在 domain model 和 UI 中分离。

## 5. Main Use Cases

### UC1 — Research branch

Main 对话到第 10 轮，用户从第 4 轮建立一个“另一种理论路线”分支。

### UC2 — Main 自动建立长期分支

Main 发现一个问题值得独立长期推进，通过 agent-control MCP 创建 persistent branch。

### UC3 — Mass parallel work

Main 为当前任务调用 20 个 transient subagents；UI 显示状态，但它们不污染 Conversation Tree。

### UC4 — Human interruption

用户点击某个 persistent branch，继续与其对话；其他 branch 可以保持运行。

### UC5 — Branch of branch

用户从 Branch A 第 6 轮建立 Branch A-child。

### UC6 — Duplicate names

两个不同位置的分支都叫 “时间冲突调查”，不产生身份冲突。

## 6. Non-goals for v0.1

- 不做跨机器云同步；
- 不做多人协作；
- 不做复杂权限组织系统；
- 不保证动画“小人”在第一版完成；
- 不重写 Claude Code tools/subagent runtime；
- 不做自动账号注册、认证绕过或订阅规避；
- 不以 40 并发为第一阶段成功标准。

## 7. Success

第一版最重要的是：

> 能稳定地从历史节点形成真正可继续工作的独立 Claude 会话树，并可靠观测临时 Agent 运行。
