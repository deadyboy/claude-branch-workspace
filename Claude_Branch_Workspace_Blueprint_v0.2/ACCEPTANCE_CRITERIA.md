# Global Acceptance Criteria

整个产品达到 v0.1 可用版，至少满足：

## Conversation Tree

- Main 完成至少 5 轮对话后，可以从第 2 轮创建分支。
- Main 可以继续第 6 轮，不受分支影响。
- 新分支只具有 fork point 之前的语义上下文，不应意外获得 Main 后续第 3–6 轮内容。
- 新分支可以继续创建子分支。
- 同一个父 branch 下允许出现两个显示名称完全相同的 branch。
- 不同层级允许名称重复。
- 所有 lineage 在应用重启后仍正确。

## Runtime

- 可以启动、恢复和继续真实 Claude session。
- 可以从一个 session 创建独立分支。
- fork 后原 session 不被追加新分支消息。
- Runtime crash 后可以显示失败状态，并在允许时恢复。
- UI 不直接依赖 runtime 私有数据结构。

## Execution Tree

- 可以看到 subagent start/stop。
- 可以将 subagent/tool events 归属到正确的 branch/turn。
- 临时 AgentRun 不会出现在 Conversation Tree 中作为持久 branch。
- UI 不展示隐藏 chain-of-thought。

## Human Interaction

- 用户可以随时打开任意持久 branch。
- 用户可以在该 branch 继续发送消息。
- 用户可以停止/中断正在工作的 branch。
- 需要权限或用户输入时，UI 明确提示。

## Workspace

- Shared 模式：多个只读/低冲突 branch 可共享目录。
- Isolated 模式：代码修改型 branch 可运行在独立 worktree。
- 系统必须明确告诉用户 branch 当前 workspace mode。

## Scale

- 目标架构支持 40 个执行槽，但 v0.1 不要求未经环境验证就强行保证 40 个真实 Claude session 同时运行。
- 必须有 10+ 并发的自动化/半自动化压力测试，并记录瓶颈。
- 后续逐步扩展到 20/40，不能靠硬编码角色。

## Safety

- event log 默认不保存已识别的 secret/token。
- 权限请求可观察。
- 不默认启用危险 bypass。
