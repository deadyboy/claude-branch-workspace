# 02 — Conversation Tree

## 1. Core model

用户看到的是树，而不是 session 平铺列表。

```text
Main
|
+-- Turn 1
|
+-- Turn 2
|
+-- Turn 3
|    \
|     \-- Branch: Alternative
|           |
|           +-- Turn 1
|           +-- Turn 2
|                \
|                 \-- Branch: Deep Check
|
+-- Turn 4
+-- Turn 5
```

## 2. Identity

任何名称都不是唯一身份。

### Branch
- `branch_id`: immutable UUID
- `display_name`: optional, non-unique
- `parent_branch_id`: nullable
- `fork_from_node_id`: exact internal node
- `runtime_session_id`: nullable until bound
- `origin_strategy`: native_head_fork | native_historical_fork | replay_reconstruction | imported
- `workspace_mode`: shared | worktree
- `created_at`
- `archived_at`

### ConversationNode
建议一个 node 对应一个稳定的“用户输入 + Agent 完成一轮”检查点。

- `node_id`: immutable UUID
- `branch_id`
- `parent_node_id`
- `local_turn_index`
- `runtime_user_message_id`: nullable
- `runtime_assistant_message_id`: nullable
- `user_text_ref`
- `assistant_text_ref`
- `created_at`
- `status`

`parent_node_id` 可以跨 branch 指向 fork point，从而形成真正 genealogy。

## 3. Duplicate naming

允许：

```text
Main
|- review
|   \- review
\- review
```

UI 使用：
- breadcrumb
- branch_id short suffix
- ancestry
进行消歧。

例如：

`Main / 数据抽取 / 时间冲突 [a91c]`

## 4. Fork from any node

这是 P0 能力。

用户点击历史 Turn：

`Fork from here`

系统调用 domain command（**当前真实签名**——`packages/domain/src/domain-services.ts` `NewBranchInput`，reviewer S2 修正）：

```ts
createBranchFromNode(input: {
  projectId: string;
  forkFromNodeId?: string | null;   // 必填（本方法只做节点分叉；root 用 createRootConversation）
  displayName?: string | null;      // 可选、可重名
  originStrategy?: Branch["originStrategy"];  // "root" | "fork_head" | "fork_node" | "reconstruct"
  workspaceMode?: Branch["workspaceMode"];    // "shared" | "worktree"
}): Branch
```

- **`createRootConversation`** 负责建 root；`createBranchFromNode` 只做"从指定节点分叉"。
- **无 `initialInstruction` 参数**：ADR-006 用 `visibleMessages` 播种重建，**不伪造指令**；snapshot 的 `projectInstructions` 恒为 `null`。旧文档的 `createBranchFromNode(nodeId, initialInstruction?, workspaceMode?)` 属于过时签名。
- **不可变 snapshot**：`createBranchFromNode` 在创建时同步 `captureBranchContext(b, forkNode)`，持久化 `branch_context_snapshots`（`ancestorNodeIds` + `visibleMessages`）+ 冻结 fork 点；**gate 1 frozen fork** —— 子分支此后只从 snapshot/rows 派生，不读 live 父。
- `originStrategy` 显式传入时按传入值落库；否则由 fork-orchestrator 在响应前分发/升级（head fork → `fork_head`，否则 `reconstruct`）。**写入 DB 的是策略字段**（见 `docs/10 §2`）。

Runtime 层决定实际策略。

### Strategy A — native historical fork
如果 Claude Runtime 支持精确历史点原生 fork，直接使用。

### Strategy B — native fork + controlled rewind
仅在 Phase 0 验证可稳定自动化且不会修改原 branch 时使用。

### Strategy C — replay/reconstruction
如果 native runtime 不提供可靠 arbitrary-turn fork：
- 创建新 session；
- 重建 fork point 之前的可见 conversation/context；
- 必要时注入结构化 branch context snapshot；
- internal lineage 保持精确；
- `origin_strategy` 标记 replay；
- UI 不声称它是 Claude 原生 ancestry。

任何 fallback 都必须测试“新 branch 不获得 fork point 之后的内容”。

## 5. Branch snapshot

为降低历史重建成本，可生成：

`BranchContextSnapshot`

包括：
- ancestor node ids
- visible messages
- project instructions
- compacted summary refs
- relevant artifact refs

不能把完整事件噪音全部塞回上下文。

## 6. Conversation history vs filesystem

conversation branch 不等于 filesystem branch。

每个 persistent branch 独立记录：
- conversation lineage
- runtime session
- workspace binding

workspace binding 可共享，也可 worktree isolation。
