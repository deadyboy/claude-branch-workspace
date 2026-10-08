# S0 语义冻结与接口契约

日期：2026-10-06。分支 `codex/visual-workspace-m1`，基线 `a20f7b6`。
本文冻结 `docs/13_VISUAL_WORKSPACE_EXPERIMENT_PLAN.md` 第 5 节实验所依赖的语义。
**S1—S5 的实现与测试均以本文为准；任何偏离必须先修订本文并说明原因。**

## 1 基线事实（侦察确认）

| 项 | 事实 | 依据 |
|---|---|---|
| PR #2（目录提升） | 仍 open 未合并 → **沿用子目录布局** | GitHub API `pulls/2` |
| 本地结构 | `apps/{web,control-plane,mcp-server}` + `packages/{domain,event-protocol,runtime}` | 仓库 |
| 前端栈 | React 18.3 + zustand 4.5 + Vite 5.4，无图库依赖 | `apps/web/package.json` |
| 已有 UI | 三栏：ConversationTree（**平铺分支列表**）/ ChatPane / AgentMonitor + Timeline | `App.tsx:299` |
| 项目引导 | `bootstrap()` 取 `projects[0]`，无选择/切换/创建界面 | `App.tsx:69-75` |
| 项目创建 | `POST /api/projects` 已校验绝对路径+目录存在 | `routes/projects.ts:15` |
| 执行主机 | **代码中不存在该概念**（仅有 `runtimeAdapter`/`runtimeProfileId`） | grep 全仓 |
| workspace 状态 | `GET /api/branches/:id/workspace` → `{mode,path,isGit,dirty,conflicts,sharedWith}` | `workspace-manager.ts:45` |
| worktree 前置 | 必须干净 Git 仓库（脏源直接抛错）+ 有首个提交 | `workspace-manager.ts:27-31` |
| 图库 | 未安装 → S2 需评估 React Flow 与 React 18 兼容性 | — |

**基线验证**：`pnpm build` 通过；`pnpm test` 132 项，0 失败，3 跳过。

## 2 图语义冻结（E2 / E8 判定真值）

### 2.1 节点类型

| 节点 | 数据源 | 身份键 | 可执行操作 |
|---|---|---|---|
| `project` | `Project` | `project.id` | 切换、查看能力 |
| `branch` | `Branch` | `branch.id` | 继续、分叉、重命名、归档 |
| `turn` | `ConversationNode` | `node.id` | 仅 `status==="completed"` 可作为分叉源 |
| `agentRun` | `AgentRun` | `run.id` | 只读；跳到 owner 分支 |
| `artifact` | S4 新增 `Artifact` | `artifact.id` | 打开、定位来源 |

### 2.2 边类型（必须分别渲染，不得混淆）

| 边 | 含义 | 来源字段 |
|---|---|---|
| `fork` | branch → 其分叉来源 turn | `branch.forkFromNodeId` |
| `parent` | branch → 父 branch | `branch.parentBranchId` |
| `turnSeq` | turn → 同分支上一 turn | `node.parentNodeId` |
| `owns` | branch → turn | `node.branchId` |
| `spawned` | agentRun → 父 agentRun | `run.parentAgentRunId` |
| `produced` | turn/branch → artifact | S4 `artifact.originNodeId` / `originBranchId` |
| `contains` | project → 目录/文件（E8） | 文件系统扫描 |

### 2.3 不变量

1. **继承消息不复制拓扑节点**：子分支的继承轮次仍引用原始 `nodeId`，只标 `origin:"inherited"`（`EffectiveConversationItem`）。
2. **拖动只改布局**，不改 `parentBranchId`/`forkFromNodeId`/`parentNodeId`。
3. **只有 `completed` 轮次可作分叉源**；`pending`/`failed`/`cancelled` 可查看不可分叉。
4. **分支末尾"继续"= 追加到本分支**；历史节点"继续"= 从该节点新建分支。UI 必须用不同文案。
5. **对话回到历史轮次 ≠ 文件回到历史版本**：worktree 从创建时 Git HEAD 派生，创建前 UI 必须显式提示。
6. **transient AgentRun 永不成为 branch**（宪法 §1）。

## 3 执行主机规则（E1 判定真值）

**冻结定义**：本产品中，**一个控制面实例即一个执行主机（execution host）**。
`project.rootPath` 始终是**该主机本地**的绝对路径。浏览器无法为远端主机提供本机目录。

| 规则 | 说明 |
|---|---|
| 路径校验 | 服务端负责：必须是**主机上**存在的绝对目录（现有实现已如此） |
| 主机标识 | 新增 `GET /api/host` → `{hostname, platform, cwd, adapters:[...]}`，UI 在项目旁常驻显示 |
| 跨主机 | 输入本机路径连远端主机 → 必须返回明确的执行端路径错误，不得静默回退 |
| 路径选择 | 第一版为**执行端路径输入 + 服务端校验**；不假定浏览器文件选择器能向远端提供目录 |

## 4 新增接口契约（S1—S4 必须遵守）

### 4.1 S1 项目入口

```
GET  /api/host
     → { hostname, platform, cwd, adapters: string[] }

GET  /api/projects/:id/capabilities
     → { rootPath, exists, isGit, dirty, hasCommits,
         worktreeAvailable: boolean,
         worktreeReason: string | null,   // 不可用时的人类可读原因
         sharedAvailable: true }

PATCH /api/projects/:id            { name?, rootPath? }  → Project
```

`worktreeAvailable` 为 `false` 时 `worktreeReason` 必须说明实际原因（非 Git 仓库 / 无首个提交 / 源有未提交改动 / 路径不可访问）。
**`dirty` 单独不为 `false` 的唯一理由**：脏源只在**创建 worktree 时**被拒，共享模式仍可用。

### 4.2 S3 成果审阅（E4a）

```
GET /api/branches/:id/changes
     → { baseRef: string | null,
         workspacePath: string | null,
         workspaceMode: "shared" | "worktree",
         committed: ChangeEntry[],     // 相对 baseRef 的提交
         uncommitted: ChangeEntry[],   // 工作区改动
         untracked: ChangeEntry[],
         truncated: boolean }

ChangeEntry = { path, status: "added"|"modified"|"deleted"|"renamed"|"untracked",
                oldPath?: string, binary: boolean, sizeBytes?: number,
                patch?: string | null }   // 二进制为 null，只给名字/大小/类型
```

**必须同时返回 `committed` 与 `uncommitted`**——只看 `git diff` 会漏掉运行中产生的提交（E4a 明确要求）。
基准 `baseRef` 在**工作开始前**记录（worktree 创建时的 HEAD）。

### 4.3 S4 任务与成果

```
POST /api/tasks                  { projectId, title, instructions, branchId? }  → Task
GET  /api/projects/:id/tasks     → Task[]
GET  /api/tasks/:id              → Task & { attempts: TaskAttempt[] }
POST /api/tasks/:id/apply        { preview: true }  → ApplyPreview
POST /api/tasks/:id/apply        { preview: false, confirmToken }  → ApplyResult
```

Apply 必须：先预览 → 显式确认 → 记录源基准/目标状态/操作 ID → 冲突或目标已变更时**停止并说明，禁止静默覆盖**。

### 4.4 S5 项目关系图（E8）

```
GET /api/projects/:id/graph?depth=N
     → { nodes: GraphNode[], edges: GraphEdge[], truncated: boolean }
```

只承诺：目录包含关系、任务执行关系、成果来源关系。
**代码 import/call 依赖与自动语义图不作为初版承诺**，UI 文案不得宣称"已理解任意代码结构"。

## 5 Tasks 表最小 schema（S4）

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT,
  title TEXT NOT NULL, instructions TEXT NOT NULL,
  status TEXT NOT NULL,            -- queued|running|completed|failed|cancelled
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, branch_id TEXT,
  node_id TEXT, agent_run_id TEXT,
  status TEXT NOT NULL, result_ref TEXT, error TEXT,
  started_at TEXT NOT NULL, ended_at TEXT
);
CREATE TABLE artifacts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  origin_branch_id TEXT, origin_node_id TEXT, origin_task_id TEXT,
  kind TEXT NOT NULL,              -- file|report|changeset
  path TEXT, summary TEXT, created_at TEXT NOT NULL
);
```

迁移必须验证**旧数据可读**（现有 domain 迁移为版本化幂等模式）。

## 6 实施顺序与并行边界

| 阶段 | 可并行 | 并行前提 |
|---|---|---|
| S0 | — | 本文 |
| S1 | 后端(4.1) ‖ 前端(ProjectHub) | 4.1 契约已冻结 ✅ |
| S2 | 图投影 ‖ 图交互 | 第 2 节语义已冻结 ✅ |
| S3 | 后端(changes) ‖ 前端(面板) | 4.2 契约已冻结 ✅ |
| S4 | Task 持久化 ‖ MCP 集成 ‖ UI | 4.3 + 第 5 节已冻结 ✅ |
| S5 | 图接口 ‖ Project 视图 | 4.4 契约已冻结 ✅ |

**文件互不重叠**是并行的硬条件；前端与后端只有在接口已定（本文）时才并行。

## 7 本节状态

S0 完成：基线锁定、图语义冻结、执行主机规则定义、S1—S5 接口契约冻结、Tasks schema 冻结。
以上为 S0 冻结时的历史快照。2026-10-07 已进入 S1—S5 实现和部分实验；以 PROJECT_STATE.md 最新记录及 docs/13 的执行分工为准，未完成的真实运行/规模/用户体验验收不视作通过。
