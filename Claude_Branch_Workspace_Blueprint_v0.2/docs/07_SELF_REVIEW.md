# 07 — Self Review Before Implementation

这是蓝图生成前的自审结果，Claude Code Phase 0 必须再次独立审查。

## Finding 1 — 上一版过度像固定流水线

问题：
固定 Extractor/Reviewer/Adjudicator 会限制 Claude 自主规划。

修正：
本版把并发视为动态资源池，角色由 Main 动态生成。

## Finding 2 — Conversation branch 与 subagent 混淆

问题：
长期研究分支和一次性 worker 是不同生命周期。

修正：
定义 Conversation Tree 与 Execution Tree 两套模型。

## Finding 3 — fork1/fork2 命名会冲突

问题：
嵌套分支后名称无法做唯一标识。

修正：
UUID 是身份；display name 允许重复；用 ancestry/breadcrumb 消歧。

## Finding 4 — “任意历史节点 fork”存在真实技术风险

问题：
Claude 当前官方明确支持 branch 当前 conversation-so-far，也支持 rewind，但程序化 arbitrary historical-node fork 的最佳稳定路径需要本机验证。

修正：
Phase 0 设置专门 Spike；RuntimeAdapter 支持 native/fallback strategy；不能未经验证直接宣称完成。

## Finding 5 — session tree 不能依赖 Claude 原生 UI

问题：
Claude 原生 session picker 的分组方式不是我们的产品数据库。

修正：
本项目独立维护 parent branch、fork point、node lineage、runtime session mapping。

## Finding 6 — conversation fork 不会自动隔离 filesystem

问题：
两个 session 在同目录工作会看到同一文件状态。

修正：
明确 Shared / Worktree workspace mode。

## Finding 7 — UI 容易变成“好看的终端壳”

问题：
如果先做小人动画，核心分支语义可能没有闭环。

修正：
开发顺序先 lineage/runtime/events，后 UI，最后动画。

## Finding 8 — 大量 event 会污染 Main context

问题：
40 worker 的 chatter 全进 Main 会降低质量。

修正：
Event Store 与 Main context 分离；Main 只收到结构化 handoff 和必要异常。

## Finding 9 — 直接解析 Claude 私有 transcript 可能脆弱

问题：
内部 JSONL 可能演进。

修正：
hooks/正式 SDK/CLI 行为作为首选；transcript 解析封装为 adapter 内的兼容层并版本检测。

## Finding 10 — Agent SDK 与日常 Claude Code 运行方式不能假定完全等价

问题：
调用接口、权限、session picker、计费/额度等都可能有差异。

修正：
CLI 与 SDK 分适配器；Phase 0 实测后选择 primary path。

## Finding 11 — 并发 40 并不等于第一版就要启动 40

问题：
资源、平台限制、进程、I/O 和 UI event volume 都可能先成为瓶颈。

修正：
10 -> 20 -> 40 分级压力测试；系统设计支持 40，但按实测能力扩展。

## Finding 12 — 人可以随时进入 branch 会带来竞争

问题：
用户和自动 Main 同时向同一 persistent session 发送消息可能导致交错。

修正：
每个 branch 需要 message queue / execution lock / interruption semantics。禁止未经协调的同 session 双 writer。

## Finding 13 — Crash recovery 不能后补

问题：
大量进程长期运行，崩溃是常态而非例外。

修正：
session registry、process status、last event、reconnect/reconcile 进入核心设计。

## Finding 14 — 需要可验证的事实源

问题：
长会话 compaction 后容易忘记阶段决策。

修正：
CLAUDE.md + PROJECT_STATE + ADR + Gate 文件构成外部持久状态。

## Conclusion

蓝图具备可实施性，但 **Phase 0 是真正的架构定稿阶段**。尤其 arbitrary-turn fork 与 CLI process control 必须实测。
