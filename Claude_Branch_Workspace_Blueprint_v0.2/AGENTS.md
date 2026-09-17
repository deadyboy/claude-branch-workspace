# AGENTS.md — Development Agent Operating Model

此文件描述“负责开发本项目的 Claude Code 主 Agent”如何使用 subagent。

注意：这不是最终产品的固定 Agent 工作流。

## 主 Agent

主 Agent 持有：

- 总体产品目标
- 当前 Phase 状态
- 最终代码写入与集成责任
- ADR 决策责任
- Gate 判定责任

## Subagent 原则

Subagent 是按需创建的临时执行者。

主 Agent可以动态产生例如：

- architecture critic
- Claude runtime capability investigator
- database reviewer
- concurrency reviewer
- UI reviewer
- test designer
- security reviewer
- implementation explorer

这些名称不是固定编制。

## 何时并行

并行任务应满足至少一项：

- 可独立读取不同代码区域；
- 可独立验证同一关键结论；
- 可并行进行测试设计/架构审查；
- 无需同时写同一文件；
- 结果可通过结构化 handoff 合并。

## 避免写冲突

默认：
- 一个文件在同一时间只允许一个 writer；
- 多个 subagent 对同一文件只读审查；
- 如果必须多实现方案，使用独立 worktree/临时目录。

## 推荐 handoff

每个重要 subagent 返回：

STATUS: SUCCESS | PARTIAL | BLOCKED

TASK:
一句话说明任务。

FINDINGS:
关键发现。

EVIDENCE:
文件、命令、测试、文档依据。

RISKS:
未解决风险。

RECOMMENDATION:
建议下一步。

FILES_CHANGED:
如果有修改，列文件。

## Review Gate

每个 Phase 结束至少安排一次不参与主要实现的 reviewer：

- 检查是否满足 Phase acceptance criteria；
- 检查是否破坏 Core Invariants；
- 检查有没有“为了 demo 写死”的技术债；
- 检查测试是否真正覆盖关键失败模式。

Reviewer 不拥有最终决策权。主 Agent负责合并与修复。
