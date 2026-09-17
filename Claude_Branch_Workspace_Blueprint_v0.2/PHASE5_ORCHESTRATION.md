# Phase 5 编配 (Orchestration) — Agent Control MCP

> 本文件是**自包含**的继续工作入口:新开一个"监控会话"(orchestrator),让它先读本文件,再按 §3 的章节派工单逐章派工。
> 原 Phase 4 lead 会话上下文已满并已提交 Phase 4(`67eb6b7` + `b93f225`,分支 `claude/jovial-hertz-7d3310`);本文整理好下一步,供
> 监控会话取代原 lead 继续推进。**不依赖原会话的上下文**,一切必要信息都在这里或所引用的文件里。

---

## §0 一句话

把 **Agent Control MCP** 做成 Phase 5:让外层 Agent(监控/Main 会话)通过 MCP 工具驱动内层会话(创建/发消息/查状态/中断/归档/查执行树)。
这就是本项目"动态派工 + 通用执行原语"(宪法 §5)的正式接口面。**先决策 port-back 方式,再按章节派工;每章由独立 worker 子会话完成,监控会话只做 gate。**

## §1 现状 (Phase 4 已提交,全绿)

- 分支 `claude/jovial-hertz-7d3310` 已提交:
  - `67eb6b7` = Phase 4 主体(80 文件, +8090/−157)
  - `b93f225` = Phase 4 S8 docs(5 个 docs)
- Hermetic 全绿(2026-09-18 复验):domain **32/32**, event-protocol **14/14**, runtime **9+2 skip**, control-plane **30+1 skip**, E2E **PASS**。
- 独立 review FAIL→PASS 两轮,记录 `docs/generated/PHASE4_REVIEW.md`(第二轮 +3 个 MAJOR 修复均落实并复验)。
- 主 checkout `F:\claudetreespace\Claude_Branch_Workspace_Blueprint_v0.2` 已 port 过 Phase 4 主体,但**二次审查修复(redact/session-manager/index/busy-guard/5 docs)仍在分支上,main 未同步**。
- 技术栈:pnpm monorepo,`packages/{domain,event-protocol,runtime}` 纯 TS(tsc→dist,node:test .mjs 打 dist 跑);
  `apps/control-plane` = Fastify server(`buildApp` 工厂 + routes + `ws.ts`),`apps/web` = Vite+React。
- 现有 REST 路由(全部 loopback-only,`127.0.0.1:15723`):
  - `GET  /api/projects` / `POST /api/projects` / `GET /api/projects/:id`
  - `GET  /api/projects/:id/branches` / `POST /api/branches`(root 或 fork)
  - `GET  /api/branches/:id` / `PATCH /api/branches/:id`(rename) / `POST /api/branches/:id/archive`
  - `POST /api/branches/:id/messages`(→ `202 {nodeId}` 或 `409 Busy`) / `POST /api/branches/:id/interrupt`
  - `GET  /api/branches/:id/ancestry`
  - `GET  /api/branches/:id/conversation`(bare `EffectiveConversationItem[]`) / `GET /api/nodes` / `GET /api/nodes/:id`
  - `GET /api/events?branchId=&projectId=&after=&limit=`(→ `{events,latestSeqRel}`) / `GET /api/events/:projectId/cursor`
  - `GET /api/branches/:id/agent-runs` / `GET /api/agent-runs/:id` / `GET /api/agent-runs/:id/execution-tree`
  - `GET /api/attention` / `POST /api/attention/:id/respond`
  - `GET /api/runtime/capabilities` / `GET /api/runtime/sessions` / `GET /api/runtime/reconcile`
  - `GET /ws/projects/:id/events`(WS,Origin 校验,seqRel gap-fill)

## §2 必须先决策:工作区/同步策略(监控会话开工前,向用户确认一次)

| 方案 | 说明 | 优点 | 缺点 |
|---|---|---|---|
| **A. 只在分支上工作,phase 边界 port 回 main**(推荐) | 本分支就是主战场;每章/每 phase 完成且过 gate 后,用既定"tree-port"把成果拷进 main checkout(不动 main 的 git index) | 与 Phase 4 实际运转一致;main 始终是"共享只读真相";避免双写冲突 | 两个 checkout 并存,需维护同步清单 |
| **B. 直接在主 checkout 上工作** | 本次新会话 cd 到 main 直接改 | 无同步动作 | 与 worktree 分支冲突;监控/worker 并发改同一源文件风险高 |

> 建议 **A**。worker 进程一律在**独立 git worktree** 里工作(项目已在 `.claude/worktrees/`),监控会话负责 port/合回与提交。**任何文件删除必须先问用户**;从不 `taskkill /IM node.exe` 等按名杀进程(见 §6)。

## §3 Phase 5 章节派工单

> 对每章:监控会话新开一个**独立 `claude` 会话**(全新上下文),把 §4 的"worker 简报模板" + 该章提示词喂进去。
> **串行**优先(章节间有代码依赖);文档侧(C4)可与 C2 并行。每章验收 = 该章测试全绿 + 独立 reviewer。
> 使用 3 个内置 skill(在 `.claude/skills/`):`bootstrap-project`(启动/接续)/ `review-phase`(章末独立审查)/ `runtime-probe`(真实 runtime 冒烟)。

### C1 — 工具面设计文档(可独立,优先做,为 C2 提供接口契约)
- 产出:`docs/11_MCP_CONTROL_PLANE.md`。为 8 个 MCP 工具写:工具名 / 输入参数 schema / 调用的 REST 端点 / 返回值 / 错误(404/409/400)/ 权限与安全说明。
- 8 个工具 ← 端点映射:
  | MCP 工具 | 调用现有端点 |
  |---|---|
  | `create_branch_from_node` | `POST /api/branches`(body forkFromNodeId)|
  | `send_message` | `POST /api/branches/:id/messages`(→nodeId;注意 409 Busy 语义)|
  | `list_branches` | `GET /api/projects/:id/branches` |
  | `get_branch_status` | `GET /api/branches/:id` + `GET /api/branches/:id/agent-runs`(状态合成)|
  | `interrupt_branch` | `POST /api/branches/:id/interrupt` |
  | `archive_branch` | `POST /api/branches/:id/archive` |
  | `query_execution_status` | `GET /api/agent-runs/:id/execution-tree` |
  | `send_message`轮询辅助(选配)| `GET /api/events?branchId=&after=`(等结果)|
- 明确 "external session vs branch id" 的区分(用户只面向 branch id;external session 永远不暴露)。

### C2 — MCP server 实现(+ 每工具 hermetic 测试)(串行,依赖 C1)
- 新包 `apps/mcp-server`(或并入 control-plane,二选一,见 C2 决策点)。用官方 `@modelcontextprotocol/sdk`(当前无 MCP 依赖,**pnpm add**)。
- 实现:Fastify 之上再加一个 **MCP over stdio**(本地最稳,`claude mcp add` 用 stdio)或 HTTP(streamable HTTP/SSE,给远端用)。
  首版强烈建议 **stdio**:零端口冲突、天然 loopback、最贴合 "子会话驱动" 场景。
- 8 个工具 = 包 8 个 REST 端点。复用 `fetch` 到 `http://127.0.0.1:15723`(loopback),或直接 import control-plane 的 svc(推荐:少一层 HTTP,但要注意**进程内复用 sessionManager**,见 §5 约束)。
  - 关键钩子:PKG_ROOT / CBW_CONTROL_PLANE_URL(默认 `http://127.0.0.1:15723`)。
- 每个工具一个 hermet 测试:fake adapter + fake/真实 control-plane 进程,断言输入→输出。
- 测试放 `apps/mcp-server/test/*.test.mjs`(node:test,打 dist 跑),复用 `apps/control-plane/test/helpers.mjs` 的 fakeAdapter 模式。

### C3 — Main-agent 集成测试(依赖 C2)
- 真跑控制面(真实 CLI 可选,`CBW_LIVE=1`;hermetic 用 fake),外层会话通过 MCP 工具调 create/send/interrupt/archive,验证能驱动内层会话并拿到结果。
- 断言:send_message 202 后轮询 events 拿到 completed;interrupt 触达 cancel;archive 对 busy 分支 409。
- 若流程过长,拆两个:hermetic E2E(默认)+ live CBW_LIVE(opt-in)。

### C4 — 文档 + 状态 + 独立 review + 提交(依赖 C2/C3;文档部分可与 C2 并行)
- `docs/11` 定稿;C3 的集成测试进默认 suite 或 opt-in。
- 更新 `PROJECT_STATE.md` / `IMPLEMENTATION_BACKLOG.md`(P5 全部打勾)/ `CHANGELOG.md` / `PHASE5_REVIEW_MAP.md`(每工具一行证据)。
- 至少一次独立 reviewer(`review-phase` skill);FAIL→fix→APPROVE → Phase 5 Gate PASS。
- 提交(用户确认后):"Phase 5: Agent Control MCP (gate PASS, independent review FAIL→PASS)"。

## §4 worker 会话简报模板(每章一份)

```
你在帮助实现 Claude Branch Workspace 的 Phase 5(Agent Control MCP)。
请先读: 项目 CLAUDE.md、IMPLEMENTATION_BACKLOG.md 的 P5 章节、
        PHASE5_ORCHESTRATION.md §3 你的章节(C#) + §5/§6 硬约束。
工作契约:
  - 在 git worktree <path> 里工作,不 cd 到主 checkout。
  - 只做 assigned chapter;不顺手改别的章节文件。
  - 每个结局: 跑对应测试 + chain build,输出一段 <200 词的总结(做了什么/测试数/未决)。
  - 不 commit,除非监控会话明确要求;不改共享状态文件(由监控会话统一更新)。
硬约束见 §6,尤其是:禁裸 stash、删文件先问、只绑 127.0.0.1、scrub 整串替换。
```

## §5 关键架构约束(worker 与监控会话都必须遵守)

1. **双树分离**:Conversation Tree(持久,SQLite)vs Execution Tree(瞬态 AgentRuns)。AgentRuns 永不晋升为 branch。
2. **`messages.visible_content` 是用户自写聊天真相**:未整个是 secret 形状就不替换;scrub 一律**整串替换**。
3. **唯一身份 = immutable ID**(branch id / node id / runtime session id);绝不依赖名字或路径字符串。
4. **SessionManager 是运行时会话映射的唯一写者**(gate 13)。MCP server 若进程内复用 control-plane 的 svc,
   必须经过同一个 `SessionManager`,不能自建 session 表;若走 HTTP,天然复用同一进程。
5. **每 branch 串行,非全局锁**(gate 11):send_message 重发到 busy 分支 = 409。MCP 工具要把 409 转成清晰的错误。
6. **loopback-only**:MCP 端(stdio 无端口;若 HTTP 版则只 `127.0.0.1`)。任何 WS/REST 都同 gate 12 纪律。
7. **restart-resume**(gate 13):外层不会重启;若 MCP server 独立进程,重启后靠 `runtime_sessions` 表 + adapter 的
   `RuntimePersistence` 钩子恢复,不要重新 startSession。
8. **honest capabilities/MCP 清单**:暴露什么工具就声明什么;不声明不存在的 fork/rewind。

## §6 硬性本地规则(若有违反,立即纠正)

- 删文件前**必须先问用户**;服务器(210.45.73.166)上文件永不删除。
- 禁止 `taskkill /IM node.exe` / `powershell.exe` / `electron.exe`;禁止按名批量 Stop-Process;
  清理进程前读 PID/ExecutablePath/CommandLine,确认含项目目录,只结束验证过的精确 PID。
- 中文路径链接用 `http://127.0.0.1:17321/?f=<encodeURIComponent(F:/…)>`;ASCII 用普通 md 链接。
- 不用 base conda 环境。
- 共享 stash:绝不用裸 `git stash` / `git stash pop`(共享 stash stack)。要用必须
  `git stash push -u -m "<unique-tag>"` → 记 SHA → `git stash apply <sha>`(不 pop)。
- 所有 repository SELECT 一律 `col AS camelCase`。

## §7 验收与完成定义(每章/整个 Phase 5)

- 每工具:hermetic 测试绿;真实 runtime 冒烟(`runtime-probe` skill)可选 by CBW_LIVE。
- 文档与代码一致(docs/11 反映真实端点与 schema)。
- 独立 reviewer 一票;FAIL→fix→APPROVE 后才算过。
- PROJECT_STATE/BACKLOG/CHANGELOG/REVIEW_MAP 同步;gate 后经用户确认再提交。

## §8 决策点(正式开工前,至少确定这几个;能定就写进 docs/11 或 ADR)

1. **worktree vs main 工作位置**(§2,监控会话先问用户,选 A 推荐)。
2. **MCP server 落点**:独立 `apps/mcp-server` vs 并入 `apps/control-plane`。建议独立包,保持 control-plane 纯净;stdio 首版。
3. **直接 import svc vs HTTP 到 control-plane**:进程内复用危险面小、省事;但 MCP 服务作为独立进程更能容错重启。
   推荐首版 **HTTP 到 127.0.0.1:15723**(弱耦合,可独立部署;future 换 transport 不改工具面)。
4. **是否新增 dependency**:`@modelcontextprotocol/sdk` 是既定事实选型(官方 SDK),记录为 ADR 后可加。
5. **P5 完成后 Phase 6(Scale/Isolation)是否立刻接**:默认接,但先收 Phase 6 的独立 worker 派工。

## §9 监控会话 checklist 参考节奏

1. 读 PHASE5_ORCHESTRATION.md + PROJECT_STATE.md + IMPLEMENTATION_BACKLOG.md + docs/10。
2. 与用户确认:§2 工作位置 A/B;§8 决策 2/3/4;是否提交。
3. 每章:发 worker(背景或前台)→ 等报告 → 独立审报告(可开 reviewer subagent)→ 跑/复核该章测试 → 更新状态 →(用户确认)提交。
4. 保持自身精瘦:只做 规划/派工/审报告/gate/提交;不亲自下场写实现章代码。
5. Phase 底 chapter 全过 + reviewer APPROVE → 更新状态文件 + 记录 gate。
