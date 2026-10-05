# 01 — System Architecture

## High-level

```text
                          USER
                           |
                  +--------v---------+
                  |      Web UI      |
                  | tree/chat/agents |
                  +--------+---------+
                           |
                     WebSocket/HTTP
                           |
                  +--------v---------+
                  |  Control Plane   |
                  |------------------|
                  | Session Registry |
                  | Conversation DB  |
                  | Event Bus        |
                  | Permission State |
                  | Workspace Mgr    |
                  | Artifact Index   |
                  +---+----------+---+
                      |          |
              +-------v--+   +---v----------------+
              | Runtime  |   | agent-control MCP  |
              | Adapter  |   | exposed to Claude  |
              +----+-----+   +--------------------+
                   |
          +--------+-------------------+
          |                            |
 +--------v---------+        +---------v----------+
 | Claude Code CLI  |        | Agent SDK Adapter  |
 | primary target   |        | optional/secondary |
 +------------------+        +--------------------+
```

## Recommended initial stack

目标是统一 TypeScript，减少跨语言边界。

### Control Plane
- Node.js + TypeScript
- HTTP: Fastify（或 Phase 0 后记录替代 ADR）
- Realtime: WebSocket
- Persistence: SQLite
- migrations: 明确版本化
- runtime process management: child_process / PTY adapter（以 Phase 0 结果为准）

### UI
- React + TypeScript + Vite
- tree/graph rendering: 可评估 React Flow / 自定义虚拟化 tree
- 事件流：WebSocket
- 第一版优先功能，不优先动画

### Packaging
第一阶段：本地服务 + browser UI。
稳定后可选择 Electron/Tauri 包装。

这样减少第一阶段 desktop packaging 对 runtime 调试的干扰。

## Module boundaries

建议 monorepo：

```text
apps/
  control-plane/
  web/

packages/
  domain/
  event-protocol/
  runtime-core/
  runtime-claude-cli/
  runtime-claude-sdk/     # optional later
  workspace-manager/
  agent-control-mcp/
```

## Core rule

UI 不得直接启动 Claude 进程。
UI 不得直接读取 Claude 私有 transcript 格式。

所有 runtime 行为经过：

```text
UI -> Control Plane -> RuntimeAdapter -> Claude
```

## Why Runtime Adapter

Claude Code 能力会演进。

我们必须能够：
- capability detect；
- 替换 CLI/SDK 实现；
- 为不同版本降级；
- 把 native session id 与 internal branch id 分离。

## Local-first

v0.1 所有核心状态本地保存：
- SQLite
- project config
- Claude 原生 session 仍由 Claude 保存

本项目数据库保存 lineage 与映射，不把 Claude 原生 session transcript 当作唯一数据库。
