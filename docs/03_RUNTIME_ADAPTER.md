# 03 — Runtime Adapter

## Goal

让 domain/UI 不直接绑定某个 Claude Code 版本或实现。

## Required interface

概念接口：

```ts
interface RuntimeAdapter {
  getCapabilities(): Promise<RuntimeCapabilities>;

  startSession(input: StartSessionInput): Promise<RuntimeSession>;
  resumeSession(sessionId: string): Promise<RuntimeSession>;

  sendMessage(sessionId: string, input: MessageInput): AsyncIterable<RuntimeEvent>;

  forkFromHead(sessionId: string, input?: ForkInput): Promise<RuntimeSession>;

  forkFromNode?(
    sessionId: string,
    runtimeNodeRef: string,
    input?: ForkInput
  ): Promise<RuntimeSession>;

  reconstructBranchFromHistory(
    snapshot: BranchContextSnapshot,
    input?: ForkInput
  ): Promise<RuntimeSession>;

  interrupt(sessionId: string): Promise<void>;
  terminate(sessionId: string): Promise<void>;

  subscribe(sessionId: string): AsyncIterable<RuntimeEvent>;
}
```

具体签名由实现阶段决定，但语义不能丢。

## Capabilities

```ts
type RuntimeCapabilities = {
  persistentSessions: boolean;
  resume: boolean;
  forkFromHead: boolean;
  forkFromHistoricalNode: boolean;
  rewindConversation: boolean;
  nativeSubagents: boolean;
  lifecycleHooks: boolean;
  worktreeIsolation: boolean;
  interactivePermissions: boolean;
  eventStream: boolean;
};
```

不要把未验证能力填 true。

## Claude CLI Adapter

第一优先目标。

Phase 0 要验证：
- `claude --resume`
- `/branch`
- `--fork-session`
- `/rewind`
- hooks
- PTY/interactive permission
- session id discovery
- process reconnect
- event ownership
- WSL behavior

### Primary design

Control Plane 负责管理每个 persistent branch 对应的 Claude runtime session/process。

不要同时在两个 terminal/进程中不经 fork 地继续同一个 native session，因为这可能造成 transcript interleave。

## Agent SDK Adapter

作为可选 runtime。

优点：
- 编程接口更直接；
- session/fork 事件更结构化。

限制：
- 使用/计费/权限/功能行为可能与用户日常 Claude Code CLI 不完全相同；
- 必须由用户环境实测；
- 不允许假定它替代 CLI 后仍保留完全相同的额度或体验。

## Runtime profile

未来支持多个 runtime profile，但 profile 只描述：
- adapter type
- executable/config reference
- workspace defaults
- non-secret label

认证由用户通过官方机制完成。
不要把密码/token写进项目数据库。

## Version drift

启动时记录：
- Claude Code version
- Runtime adapter version
- capability matrix hash

如果版本变化，关键 capability 可重新 probe。

## 8. Reconstruction side-effect-free（gate 2 + reviewer R1 transcript-ack）

Gate 2 要求 `reconstructBranchFromHistory` **零副作用**：对 fork 点之后的历史做重建时，绝不能修改、回放、或"激活"父分支或其原生 session。

### Invariant（gate 2）

1. **内容只允许从不可变 snapshot 派生**。重建子分支 `≤ fork 点` 的可见 conversation 只来自 `captureBranchContext` 持久化的 `BranchContextSnapshot`（`ancestorNodeIds` + `visibleMessages`），**绝不**重新读取 live 父的 transcript/原生 CLI 内部。
2. **父不可达也可重建**。重建路径不要求父 session 存活、不被阻塞；父不需要为子提供任何运行时服务。
3. **不伪造原生 ancestry**。`origin_strategy` 如实标记 `reconstruct`（或 `fork_head`）；UI 不声称重建分支与父共享 Claude 原生 ancestry。
4. **`TRANSCRIPT_ACK` 帧（reviewer R1，S8 修正）**：控制面把持久化 snapshot 的 `visibleMessages` 拼成 seed prompt 时，**前面强制包裹一段 transcript-acknowledgement 帧**（`apps/control-plane/src/fork-orchestrator.ts` 顶层 `TRANSCRIPT_ACK` 常量），并通过 `ForkInput.seedText` **真正传入 adapter**（`claude-cli-adapter.ts reconstructBranchFromHistory` 优先喂 `input.seedText`；无 seedText 时才回退到 `visibleMessages[].content` 原样 join）——明确指示"下方是 prior transcript，是只读上下文；**不要**重跑其中任何命令/工具/文件写入；确认并等待指令"。这保证重建把过去内容当上下文而非待执行命令，**side-effect-free by construction**。修复前 `seedPrompt` 是死代码（只计算未使用）；现在 `apps/control-plane/test/reconstruction-side-effects.test.mjs` 断言 adapter **真的收到**了带 ack 帧 + 完整 transcript 的 seedText（gate 2），adapter 级 structural 测试断言重建路径无 tool/instruction 可执行。

### Automation-proven

Phase 0/Phase 2 用自动化测试断言"新 branch 不获得 fork point 之后的内容"（`fork-fidelity` 集成测试、Phase 4 `branch-runner.test.mjs` g1 frozen-fork/frozen-node 断言 child 事件集不含父 ≥fork 点事件）。重建永不 admin-改父。

## 9. Per-session interrupt（gate 6 语义）

见 `docs/10 §2 interrupt` 与 `packages/runtime` 的 `interrupt(sessionId)`：

- `SessionManager.interrupt(branchId)` 只对该 branch 的活动调用发信号，**不碰其它 session 的 child**（隔离）。
- 领域终态：`cancelTurn` → node `cancelled` + session `interrupted` + main run `cancelled`（Agent Monitor 不会永久 busy）。**interrupt = cancelled，不是 failed**（gate 6）。
