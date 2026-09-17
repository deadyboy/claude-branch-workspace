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
