# 10 — Control Plane API

> 本文档描述 **control-plane HTTP/WS API 的真实契约**（Phase 4 定稿）。
> 前端 `apps/web`（S6）是本文档的唯一规范消费方；E2E（S7）以 `CBW_FAKE_RUNTIME=1` 的假 runtime 驱动。
> 所有端点均已实现于 `apps/control-plane/src/routes/*.ts` + `ws.ts`，路由在 `server.ts buildApp()` 中注册。

## 0. 基础约定（全部端点适用）

- **Base**: `http://127.0.0.1:15723`（进程只绑 `127.0.0.1`，**gate 12 loopback**；`CBW_PORT` 可覆盖，测试用 ephemeral port）。15721 是死配置、15722 是 live gateway、15723 为本控制面。
- **编码**: JSON over HTTP；错误形如 `{ "error": <string> }`（S5 实际实现用字符串消息，非 `{code,message}` 对象结构）。
- **认证**: 本机 loopback + origin 校验（见 §8 WS origin gate），无跨机暴露、无宽松 CORS（`@fastify/cors` 仅 dev 显式白名单）。
- **身份**: 一律用 immutable UUID；`displayName` 可重复，不参与寻址（`docs/02 §2`）。
- **只透出 redacted CanonicalEvent**：HTTP/WS 永远不会下发未脱敏的原始 payload；UI 也永远不会见到 hidden chain-of-thought（§11，宪法 §1.10）。
- **忙/并发**：每 branch 串行，**不是全局锁**（**gate 11**）。Main 与 Child 可同时各自 busy。见 §9 的 409 语义。
- **`runtime_sessions` 唯一权威**（**gate 13**）：任何"运行时会话映射"都以 `runtime_sessions` 表 + `SessionManager`（唯一写者）为准，browser 不得自行推导。见 §6。

### 返回体约定

S5 的实际 route 大多**直接返回领域对象数组 / 单对象**，而不是包一层 `{branches: [...]}` / `{project: {...}}`。下表为逐端点的"实际返回 JSON 顶层"：

| 端点 | 实际返回顶层 |
|---|---|
| `GET /api/projects` | `Project[]` |
| `POST /api/projects` | `Project`（201） |
| `GET /api/projects/:id` | `Project` |
| `GET /api/projects/:id/branches` | `Branch[]` |
| `POST /api/branches` (root) | `{branch, snapshot, sessionKey, strategy}` |
| `POST /api/branches` (fork) | `ForkOrchestrator.createFork` 结果 |
| `GET /api/branches/:id` | `Branch` |
| `PATCH /api/branches/:id` | `Branch` |
| `POST /api/branches/:id/archive` | `Branch` |
| `POST /api/branches/:id/messages` | `{nodeId}`（202） |
| `POST /api/branches/:id/interrupt` | `{interrupted: sessionKey}`（202）/ `{error}`（409） |
| `GET /api/branches/:id/ancestry` | `svc.getBranchAncestry(id)` 结果 |
| `GET /api/branches/:id/conversation` | `EffectiveConversationItem[]`（数组，非 `{items}`） |
| `GET /api/branches/:id/nodes` | `ConversationNode[]` |
| `GET /api/nodes/:id` | `ConversationNode` |
| `GET /api/branches/:id/events` | `{events, latestSeqRel}` |
| `GET /api/projects/:id/events` | `{events, latestSeqRel}` |
| `GET /api/branches/:id/agent-runs` | `AgentRun[]` |
| `GET /api/agent-runs/:id` | `AgentRun` |
| `GET /api/branches/:id/execution-tree` | `getExecutionTree` 结果 |
| `GET /api/runtime/capabilities` | `{capabilities, mode:"shared"}` |
| `GET /api/runtime/sessions` | `{live}` |
| `POST /api/runtime/reconcile` | `reconcileOnBoot` 报告 |
| `GET /api/attention` | `AttentionCardWire[]` |
| `POST /api/attention/:id/respond` | `AttentionCardWire` |

---

## 1. Projects

### `POST /api/projects` — 创建项目

```json
// request
{ "name": "demo" }

// response 201
{ "id": "3f1c…uuid…", "name": "demo", "createdAt": "2026-09-17T12:00:00.000Z", "updatedAt": "…" }
```

- 实现：`routes/projects.ts` → `svc.createProject({name})`。`name` 必填非空（空 → 400 `{error:"name is required"}`）。

### `GET /api/projects` — 列表

```json
// 200
[ { "id": "…", "name": "demo", "createdAt": "…", "updatedAt": "…" } ]
```

- 实现：`routes/projects.ts` → `svc.listProjects()`。

### `GET /api/projects/:id` — 详情

```json
// 200（直接返回 Project 对象）
{ "id": "…", "name": "demo", "createdAt": "…", "updatedAt": "…" }
```
- 不存在 → `{error:"project not found"}`。

---

## 2. Branches

### `GET /api/projects/:id/branches` — 列表

```json
// 200: Branch[]
[ { "id": "…", "projectId": "…", "parentBranchId": null, "forkFromNodeId": null,
  "displayName": "Main", "originStrategy": "root", "workspaceMode": "shared",
  "runtimeAdapter": "claude-cli", "runtimeSessionId": null, "runtimeProfileId": null,
  "workspacePath": null, "status": "active", "createdAt": "…", "archivedAt": null } ]
```
- `originStrategy` 实际取值（`apps/web/src/types.ts`）：`"root" | "fork_head" | "fork_node" | "reconstruct"`。（计划里 mapping 到 `native_head_fork`/`replay_reconstruction` 的口径，实现端归一为上述 4 值。）
- 实现：`routes/branches.ts` → `repo.listBranchesByProject(id)`（camelCase select）。

### `POST /api/branches` — 建 Root（project 的 root conversation）或 从节点 Fork

同一端点，按 `forkFromNodeId` 是否提供分派。

```json
// request — Root（无 forkFromNodeId）
{ "projectId": "…", "displayName": "Main" }

// response 201
{ "branch": { /* Branch, originStrategy:"root", workspaceMode:"shared", status:"active" */ },
  "snapshot": null, "sessionKey": null, "strategy": "lazy_root" }
```

- **懒 materialize（reviewer B2）**：root 分支不立即播种原生 session；首次 `POST /messages` 时才 `adapter.startSession`（lazy root）。

```json
// request — Fork（有 forkFromNodeId）
{
  "projectId": "…",
  "forkFromNodeId": "3f1c…uuid…",     // 必填
  "displayName": "Alternative",        // 可选、可重名
  "workspaceMode": "shared",           // 可选，默认 shared（gate 14）
  "cwd": "C:\\work\\demo"              // 可选，运行时 workdir
}

// response 201 — 创建时已急切冻结（gate 1）
{ "branch":   { /* Branch, workspaceMode:"shared" */ },
  "snapshot": { /* BranchContextSnapshot — 含 ancestorNodeIds + visibleMessages */ },
  "sessionKey": "cp-…",                // 已 eager 绑定；非 null（root 见上）
  "strategy":  "native_head_fork" | "replay_reconstruction" }
```

- 实现：`routes/branches.ts` 无 fork → `svc.createRootConversation`；有 fork → `forkOrchestrator.createFork(...)`（`fork-orchestrator.ts`），后者在响应前完成 eager 冻结。
- **策略分发（gate 1）**：
  - `native_head_fork` — fork 点 == 父分支当前 head 且父已 materialize → `adapter.forkFromHead(parentKey, {newSessionId})`。`--session-id` 单调绑定 ⇒ 冻结瞬间之后的父进展不会泄漏进子分支。
  - `replay_reconstruction` — 其它情况 → `adapter.reconstructBranchFromHistory(不可变 snapshot, {newSessionId})`。父不需要存活，子只从 `≤ fork 点` 的内容播种。
- **不变量**：child 之后的对话只来自持久化 snapshot/rows，**不读 live 父**，父后续 turn 永不泄漏（gate 1 + gate 4 no-leak）。E2E g1 断言 `never tell child this secret` 不出现在 child。

### `GET /api/branches/:id` — 详情

```json
// 200（直接返回 Branch）
{ "id": "…", "displayName": "…", … }
```
- 不存在 → `{error:"branch not found"}`。

### `PATCH /api/branches/:id` — 改名（display name）

```json
// request
{ "displayName": "重命名后的名字" }
// 200
{ "id": "…", "displayName": "重命名后的名字", … }
```

### `POST /api/branches/:id/archive`

```json
// request: {}
// 200: Branch，archivedAt 已填
```
- 归档分支拒绝 append/fork（`invariants.test.mjs`）。若该 branch 忙 → 409 `{error:"branch is busy; interrupt before archiving"}`。

### `POST /api/branches/:id/messages` — 发送一条用户消息（**gate 5 明确 turn 生命周期**）

```json
// request
{ "text": "继续做数据抽取", "cwd": "可选覆盖" }

// response 202（立即返回，不等 turn 完成；UI 依赖 WS 推送结果）
{ "nodeId": "2faa…uuid…" }

// 若该 branch 已有活动调用（409）
{ "error": "branch is busy; interrupt before archiving" }  // 语义见 §9
```

- handler 调 `svc.openTurn({branchId, userContent})`：一个事务里落 user message + `status:"pending"` 的 conversation node，**原子地**；返回 202 `{nodeId}`。
- 之后 `runTurnAsync` 后台异步跑：`SessionManager.resolveSession`（懒播种）→ `runTurnOnce`（流式 WS 事件）→ 终态 `svc.completeTurn`（`assistantContent` 即脱敏后的 chat truth）/ `svc.cancelTurn`（interrupt）。失败时 `svc.completeTurn(status:"failed")` 兜底。
- **409 Busy 语义见 §9**：只挡"这个 branch"；Main busy 不挡 Child（gate 11 非全局锁）。

### `POST /api/branches/:id/interrupt` — 中断当前 turn（**gate 6**）

```json
// request: {}
// 202（已对该 branch 唯一活动调用发出中断信号）
{ "interrupted": "cp-…" }          // sessionKey

// 该 branch 空闲：
// 409
{ "error": "branch is idle" }
```

- `SessionManager.interrupt(branchId)`：只把 `state` 里该分支置中止并调 `adapter.interrupt(该 branch 的 sessionKey)`；**不碰其它 session 的 child**（gate 6）。路由查 `getState(id)`：无状态 → 409 idle。
- 终态由 turn 自身的中止路径驱动：adapter interrupt → `runTurnOnce` 返回 `status:"cancelled"` → `svc.cancelTurn`，node `cancelled`。**interrupt = cancelled，不是 failed**（gate 6）。$（域名侧 `cancelTurn` 也置 runtime session `interrupted`）

### `GET /api/branches/:id/ancestry` — 面包屑（breadcrumb）

```json
// 200 — `svc.getBranchAncestry(id)` 的返回体（Branch + snapshot + ancestors 链）
```
- UI 面包屑 `Main / 数据抽取 / 时间冲突 [a91c]` 用它拼。

### `GET /api/branches/:id/conversation` — **Effective conversation（gate 3）**

```json
// 200: EffectiveConversationItem[]（数组）
[
  { "role": "user",      "content": "（继承自祖先的旧消息）", "nodeId": "…", "origin": "inherited", "seq": 3 },
  { "role": "assistant", "content": "…",                     "nodeId": "…", "origin": "inherited", "seq": 4 },
  { "role": "user",      "content": "（本分支自己新发的）",   "nodeId": "…", "origin": "local",     "seq": 1 }
]
```

- **返回体是裸数组**（非 `{items:[…]}`）。实现：`routes/conversation.ts` → `svc.getEffectiveConversation(id)`；走 `parentBranchId` 链，祖先分支 `≤ fork 点（含）` 的结点标 `origin:"inherited"`，本分支结点标 `origin:"local"`，按 `seq` 排序。
- 字段：`EffectiveConversationItem {role, content, nodeId, origin:"inherited"|"local", seq}`（`apps/web/src/types.ts`）。
- **`listMessagesByBranch` 一支不够**：fork 分支的"聊天真相"必须是 inherited 前缀 + local（gate 3 就是为此）。

---

## 3. Nodes

### `GET /api/branches/:id/nodes` — 分支的结点列表

```json
// 200: ConversationNode[]（按 localTurnIndex / seq 排序）
[ { "id": "…", "projectId": "…", "branchId": "…", "parentNodeId": null,
  "localTurnIndex": 0, "userMessageRef": "…", "assistantMessageRef": null,
  "runtimeUserMessageId": null, "runtimeAssistantMessageId": null,
  "status": "pending" | "completed" | "failed" | "cancelled", "createdAt": "…", "completedAt": null } ]
```

- 实现：`routes/nodes.ts` → `repo.listNodesByBranch(id)`。

### `GET /api/nodes/:id` — 单个结点

```json
// 200: ConversationNode
```
- 不存在 → `{error:"node not found"}`。

---

## 4. Events（**gate 8 持久游标**）

> `events.seq_rel` = 项目级单调游标（insert 时 `COALESCE(MAX(seq_rel),0)+1`，单一写者，SQLite 串行 → 单调）。任何 SELECT 都是一律 `seq_rel AS seqRel`（宪法 camelCase）。WS 与 REST `?after=` 共用这颗游标。

### `GET /api/branches/:id/events?after=<seqRel>&limit=<n>` — 分支事件（stream catch-up）

```json
// 200
{ "events":
   [ { "eventId": "…", "projectId": "…", "branchId": "…", "nodeId": "…", "agentRunId": "…" | null,
       "runtimeSessionId": "cp-…" | null, "type": "tool.started",
       "status": "completed" | null, "occurredAt": "…",
       "payload": { "tool": "Bash", "command": "[REDACTED 或 脱敏命令]", "toolUseId": "tu_1" } } ],
  "latestSeqRel": 42 }
```

- `after` = **排他**：`seqRel > after`，oldest first；`limit` 封顶（默认 200，最大 1000）。
- **注意**：S5 实际事件的字段名是 `occurredAt`，**没有 `receivedAt` / `sequence` 顶层字段**（payload 也不含 `sequence`）。`payload` 已脱敏（redact.ts 每类型 allowlist + 深度 scrub，见 `docs/04 §7`）。
- 实现：`routes/events.ts` → branch 级 `svc.listEventsByBranch`（内存 `findIndex(e=>e.seqRel>after)` 切片）+ `latestSeqRel` 取切片末项。

### `GET /api/projects/:id/events?after=<seqRel>&limit=<n>` — **项目级事件游标（durable reconnect cursor, gate 8）**

```json
// 200
{ "events": [ /* 同 branch 级，但跨全部 branch */ ], "latestSeqRel": 42 }
```

- 与分支端点同构，但 `svc.listEventsSince(projectId, after, limit)` **不过滤分支** —— 全项目单调。这是"重启后/重连后我落在哪"的**唯一权威**。
- 实现：`routes/events.ts` → `svc.listEventsSince(id, after, limit)`。

---

## 5. Agent runs（执行树，transient，永不晋升为 branch）

### `GET /api/branches/:id/agent-runs` — 该分支全部 AgentRun

```json
// 200: AgentRun[]
[ { "id": "…", "ownerBranchId": "…", "ownerNodeId": "…",
   "parentAgentRunId": null, "runtimeAgentId": null, "type": "main",
   "displayLabel": null, "name": "Main", "taskSummary": null,
   "status": "completed" | "running" | "queued" | "waiting" | "needs_attention" | "failed" | "cancelled",
   "startedAt": "…", "endedAt": null } ]
```
- 实现：`routes/agent-runs.ts` → `svc.listAgentRunsByBranch(branchId)`。

### `GET /api/agent-runs/:id` — 单个 run

- 实现：`routes/agent-runs.ts` → `svc.getAgentRun(id)`；不存在 → `{error:"agent run not found"}`。

### `GET /api/branches/:id/execution-tree?nodeId=<nodeId>` — 一次 turn 的执行树

- 实现：`routes/agent-runs.ts` → `svc.getExecutionTree(id, nodeId ?? null)`（**未传 `nodeId` 也合法**，返回该 branch 的树）。
- **attribution 诚实（gate 9 预览，详见 `docs/04 §8`）**：树只用来把 **node 所有的嵌套 AgentRun** 挂在它 node 的 turn 下；**工具事件永远只在 branch/turn 层渲染**，不塞进任何 agent card。

---

## 6. Runtime

### `GET /api/runtime/capabilities` — **诚实**能力（不伪造）

```json
// 200
{ "capabilities": { "persistentSessions": true, "resume": true, "forkFromHead": true,
  "forkFromHistoricalNode": true, "rewindConversation": false, "nativeSubagents": true,
  "lifecycleHooks": false, "worktreeIsolation": false, "interactivePermissions": false,
  "eventStream": true },
  "mode": "shared" }
```

- 实现：`routes/runtime.ts` → `adapter.getCapabilities()` + `mode:"shared"`。实际 CAPABILITIES 在 `packages/runtime/src/claude-cli-adapter.ts`。
- **gate 7 诚实口径**：`interactivePermissions: false`（print-mode 非交互）+ 每分支 `--settings` `defaultMode: "acceptEdits"`（非交互权限 ⇒ **不会卡住等待**）。Phase 4 的 attention 循环是"关闭的、不 stall"的；真实 CLI 的 `permission.requested`/`attention.required` 在**本适配器上不产生**（parseEvent 丢弃）——attention registry 只由 Playwright 假 runtime 播种（reviewer R2，`docs/04`）。
- **worktreeIsolation 注意**：计划文档曾写 `true`；S5 实际按 `claude-cli-adapter.ts` 的 CAPABILITIES 返回，fake runtime 报告 `false`（Phase 4 只支持 Shared，**gate 14**），以诚实为优先。

### `GET /api/runtime/sessions` — 运行时会话视图

```json
// 200
{ "live": [ { "branchId": "…", "sessionKey": "cp-…", "busy": false } ] }
```

- **gate 13**：运行时映射的**唯一写者**是 `SessionManager`（`apps/control-plane/src/session-manager.ts`），DB 侧 `runtime_sessions` 表是 restart 后的唯一事实。`/api/runtime/sessions` 反映 in-process 会话。
- 实现：`routes/runtime.ts` → `sessionManager.listStates()` 映射 `{branchId, sessionKey, busy}`。

### `POST /api/runtime/reconcile` — 手动触发 boot-time reconcile（**gate 15 + B3**）

```json
// request: {}
// 200
{ "cancelledNodes": 2, "interruptedSessions": 1, "cancelledOrphanRuns": 3 }
```

- 实现：`routes/runtime.ts` → `reconcileOnBoot(svc)`；启动时 `index.ts main()` 在 `listen` 前自动跑一次。语义见 `apps/control-plane/src/reconcile.ts`。

---

## 7. Attention（**gate 7**）

> Phase 4 设计：**acceptEdits ⇒ 无交互权限 ⇒ 请求不会有 stall**（见 §6 capabilities）。当未来某 profile 打开 `interactivePermissions`，同一 registry 直接服务于真实 `permission.requested` / `attention.required`。现在只有假 runtime 播种。

### `GET /api/attention` — 当前待处理/已应答请求列表

```json
// 200: AttentionCardWire[]（数组）
[ { "attentionId": "atn-uuid", "branchId": "…" | null, "projectId": "…" | null,
    "type": "permission" | "question" | "task",
    "requestText": "可展示的请求描述（已脱敏）",
    "status": "pending" | "answered", "answer": "allow" | "deny" | null,
    "createdAt": "…", "answeredAt": "…" | null } ]
```

- 内存 registry（`apps/control-plane/src/attention-registry.ts` `AttentionRegistry`）由 index.ts 的 `bus.subscribe` 从 stream 进 `permission.requested` / `attention.required` canonical events 播种（`seedFromEvent`）。
- UI 归一化：前端 `apps/web` store 把 `AttentionCardWire` → `AttentionCard {id, branchId, kind, title, status, answer, createdAt}`（kind: `permission` 或 `question`→`attention`）。

### `POST /api/attention/:id/respond` — 应答

```json
// request
{ "answer": "allow" }   // "allow" | "deny"

// 200: AttentionCardWire（status:"answered", answer 已填, answeredAt 已填）

// 400（非法 answer）
{ "error": "answer must be allow|deny" }

// 404（未知 id）
{ "error": "attention card not found" }
```

- 幂等：已 answered 的 card 再 respond 返回原 card（不重复处置）。
- UI 的 `AttentionCard`（S6）渲染 pending → allow/deny；后端 `AttentionRegistry.respond`（内存）会真正应用响应。假 runtime 会真正应用响应（E2E g7 断言 "Answered: allow"）。
- **gate 7 的满足方式 = OR 分支（acceptEdits / interactivePermissions:false 已证明）**，UI attention 路径真实但 Phase 4 **由假驱动**（reviewer R2，已在 `docs/04` 记录诚实边界）。

---

## 8. WebSocket（**gate 8 持久游标 + gate 12 origin**）

### `GET /ws/projects/:id/events`

握手与序：
1. **Origin 校验（gate 12）**：`Origin` 必须 `=== Host`，或属于 dev 白名单 `http://localhost:5173` / `http://127.0.0.1:5173`（`DEV_ALLOWLIST`）；否则 **403-close**（绝不建立连接）。生产 same-origin（static 由同一个 control-plane 伺服）⇒ 天然成立。
2. 建立后 client 立即发一条消息给 server：
   ```json
   { "hello": { "lastSeqRel": 41 } }
   ```
   `lastSeqRel` = client 已经消费到的项目游标（未存过就 `0`）。
3. **gap-fill**：server 用 `svc.listEventsSince(projectId, lastSeqRel, 1000)` 把断线期间丢的事件按序回放（**持久游标，不靠内存 replay、不靠无限 `Set<eventId>`**），然后进入转发 live 模式。
4. **live 转发**：`bus` 上每个 redacted CanonicalEvent（`evFrame(ev)`）只推 `seqRel > lastSeqRel` 的 delta；断连清理订阅。

**WS 帧（server → client）是扁平对象**（非 `{event:{…}}` 嵌套）：

```json
{ "eventId": "…", "seqRel": 42, "type": "attention.required", "status": null,
  "projectId": "…", "branchId": "…", "nodeId": "…", "agentRunId": null,
  "runtimeSessionId": null, "occurredAt": "…", "payload": { "summary": "…" } }
```

- 字段 = `EventFrame`（`apps/web/src/types.ts`）：`eventId, seqRel, type, status, projectId, branchId, nodeId, agentRunId, runtimeSessionId, occurredAt, payload`。
- `session.stopped` 帧带 `branchId`，client 用作"turn 结束 → settle refresh"（见下文 §10 UX 收敛）。
- gap-fill 帧（`rowFrame`）与 live 帧同构。

Client 端行为（gate 8 细节）：
- 保存 `latestSeqRel` + **有界的 `Set<eventId>`**（只覆盖 connect-race 窗口，**不是整段历史**）。
- 重连 = REST `?after=` 追赶（同时 refetch branches / attention / conversation / nodes / agent-runs 刷新全量状态）→ 重开 WS `{hello:{lastSeqRel}}` → server gap-fill 补窗口。REST 与 WS 双通道由 seqRel 对齐，去重集吸收竞争窗口内的重复。
- 只推 redacted CanonicalEvent；**永不携带 secret**（README/`docs/04 §7`）。

---

## 9. 409 Busy 语义（并发，gate 11）

- `SessionManager` 每 branch **一个活动调用**表（`Map<branchId, state>`）。
- 只有**目标 branch** 处于活动调用时，`POST /api/branches/:id/messages` 才被 `svc.openTurn`、session-manager 侧其它路径拒绝（实际 route 现为直接 openTurn + 202，busy 由 session-manager `resolveSession`/`isBusy` 校验兜底）。
- 这是**按分支**的串行，**不是全局锁**：当 Main 忙时，Child 的分支仍可发消息/运行（gate 11 集成测试断言交错定时器下两者都完成、session 互异且互不干扰）。
- `POST /api/branches/:id/interrupt` 对**空闲**分支返回 `409 {error:"branch is idle"}`（与 busy 同族）。

---

## 10. 错误约定

| 场景 | HTTP | 返回体（实际） |
|---|---|---|
| branch/node/project/agent-run 不存在 | 404 | `{error:"branch not found"}` 等 |
| 参数缺失/非法 | 400 | `{error:"name is required"}` / `{error:"text is required"}` / `{error:"displayName is required"}` / `{error:"answer must be allow|deny"}` |
| 目标 branch 忙（archive / busy 校验） | 409 | `{error:"branch is busy; interrupt before archiving"}` |
| interrupt 空闲 branch | 409 | `{error:"branch is idle"}` |
| 非 GET 打到 SPA 兜底 | 405 | `{error:"method not allowed"}` |
| `/api/*` / `/ws/*` 未知路径 | 404 | `{error:"not found"}` |

> S5 用字符串 `{error}`，不是宽松的对象 `{error:{code,message}}`。（如需正式 error taxonomy 可后续加 middleware 归一。）

---

## 11. 不变量（所有端点）

1. **HTTP/WS 不暴露 hidden chain-of-thought**。`thinking_tokens` 在 adapter 上游被排除（`claude-cli-adapter.ts` parseEvent），UI 永远看不到内部 reasoning token（宪法 §1.10）。
2. **只透出 redacted CanonicalEvent**；`messages.visible_content` 是用户自写的聊天真相（**gate 4**），不出现在事件 API 中供自动收集，但 `conversation` 端点返回它（inherited/local 标记）。
3. **Conversation Tree 与 Execution Tree 分离**（宪法 §2/§8）：AgentRuns 只出现在 `/api/branches/:id/agent-runs` 与 `/api/branches/:id/execution-tree`，**永不晋升为 branch**。
4. **支持 gate**：gate 2（reconstruction 零副作用 + transcript-ack，见 `docs/03`）、gate 4（聊天真相 + 整串防御）、gate 6（interrupt=cancelled + 隔离）、gate 7（attention + acceptEdits no-stall）、gate 9（attribution 诚实）、gate 12（loopback + origin）、gate 13（runtime_sessions 唯一权威 + 单写者）、gate 14（Shared only；Worktree = Phase 6）、gate 15（restart reconcile 含孤儿 agent_runs B3）。

## 12. UX 收敛（S6/S7 相关实现）

- **Turn 结束刷新**：turn 以一个 `session.stopped` 帧收尾，但 `completeTurn` 在**该帧转发之后**才把 assistant 文本 + 终态 node 落库，所以帧触发的刷新会竞争。client（`apps/web/src/App.tsx`）收到 `session.stopped` 帧后延迟 ~300ms 做一次 settle refresh（`refreshBranchData` + `listAttention`），并用自增 token 保证最后一次刷新胜出。这样 UI 在 turn 结束后收敛到最终 conversation/nodes。
- **Attention 卡片**：`refreshBranchData` 只取 conversation/nodes/agent-runs；attention 由 `refreshAll` 与 settle refresh 的 `listAttention` 拉取。Timeline 把 `pending` + `answered` 卡片都渲染（pending 在前），answered 用 `.attn-answered` 呈现结果。
