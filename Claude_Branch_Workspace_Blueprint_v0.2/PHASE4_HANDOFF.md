# Phase 4 交接文档（HANDOFF）—— 2026-09-17

> 本文件是**自包含**的继续工作入口。新建一个 Claude Code 会话,让它先读本文件,再读它引用的
> `C:\Users\lenovo\.claude\plans\glowing-jumping-stardust.md`(已批准、已通过独立架构评审的 Phase 4 计划)。
> 原会话上下文已满而发起交接;此前的所有已完成/进行中状态都记录在本文件与状态文件里。

## 0. 一句话

用户在实现 **Claude Branch Workspace**(根目录 `F:\claudetreespace\Claude_Branch_Workspace_Blueprint_v0.2`),
Phase 4 = 三栏 Web UI(React)+ 控制面 HTTP/WS 服务(Fastify)。有 **15 个硬性 gate**(全部必须实现,不是只规划)。
原发起指令:执行(execute)而非只规划,自主连续推进,每个重要 Phase 结束前必须有一次独立 reviewer(宪法§6)。
Phase 4 计划已批准、已由独立架构评审(B1–B4/R1–R6/S1–S2 全部解决)。你现在的任务:**把 Phase 4 做完并过 15 个 gate,先评审后收尾**。

## 1. 技术栈与约定(全部已确认)

- pnpm monorepo:`packages/{domain,event-protocol,runtime}` 纯 TS(`tsc -p tsconfig.json` → `dist/`,NodeNext/strict);
  测试是 `node:test` 的 `.mjs`,**打 dist 后跑**(`pnpm --filter <pkg> build` 先)。
- `apps/control-plane` = 控制面(Phase 4 变成 Fastify server),`apps/web` = 前端(尚不存在,S6 建)。
- 端口:**127.0.0.1:15723**(15721 死配置,15722 live gateway;15723 空闲)。进程只绑 127.0.0.1(gate 12)。
- 实时 gate 选项式:`CBW_LIVE=1`;E2E 用 `CBW_FAKE_RUNTIME=1`。
- 双树分离:Conversation Tree(持久,SQLite)vs Execution Tree(瞬态 AgentRuns)。严禁混淆;AgentRuns 永不晋升为 branch。
- **门禁约定(容易翻车,务必记住)**:
  - 所有 repository SELECT 一律 `col AS camelCase`(宪法强制)。
  - 冲洗(scrub)约定是**整串替换**:值里包含 secret 形状 → 整个值变 `"[REDACTED]"`,不是子串替换。
  - `messages.visible_content` 是**用户自写的聊天真相**(gate 4 政策决定,§11 豁免):普通文本含密钥的命令如
    `export KEY=sk-…` **原样持久化**;只有"整条回复就是一个 secret 形状串"才替换(防御纵深)。
  - CanonicalEvent 仅可观测性,永不携带 secret;Bash output 已 allowlist+scrub。
  - 本机安全规则:删文件前必须问用户;禁止 `taskkill /IM` 按名杀 node/powershell;中文路径链接用
    `http://127.0.0.1:17321/?f=<encodeURIComponent(F:/…)>`;不用 base conda 环境。

## 2. 已完成(全部验证绿)

- **S1 领域层(packages/domain,32/32 通过)**:
  - v3 迁移:`events.seq_rel` 项目级单调游标(insert 时 `COALESCE(MAX(seq_rel),0)+1`)+回填 + `idx_events_project_seq`。
  - 显式 turn 生命周期:`openTurn`(persist pending node+user msg)→ `completeTurn/failTurn/cancelTurn`;
    `appendCompletedTurn` 保留为薄壳(走 openTurn+completeTurn,旧调用点不坏——reviewer B4)。
  - `getEffectiveConversation(branchId)`(gate 3,inherited/local + fork 点截断)。
  - `listEventsSince/lastEventSeqRel`(gate 8);`reconcileTurnRuns`(gate 15:未决 node→cancelled,孤儿 session→interrupted)。
  - 新加了两处 service 透传:**`svc.lastNode(branchId)`**、**`svc.listAgentRunsByStatus(statuses)`**(供本阶段新代码用;尚未 rebuild)。
- **S2 事件协议(12/12)**:`redact.TOOL_ALLOW.Bash=["command","output"]`;`observer.userMessage()`/`cancel()`(emit session.stopped+cancelled)。
- **S3 运行时适配器(7/7 通过,另2个 CBW_LIVE 跳过)**:真实 SIGTERM 中断,**按 sessionKey 精确隔离**(gate 6,`inflight` map + `interruptedKeys` + `wasInterrupted`)。

## 3. S4 已写的控制面模块(apps/control-plane/src,刚写完,**尚未 build/通过**)

- `turn-result.ts`:`TurnResult {status, stopReason, assistantContent, exitCode, eventCount}`(gate 4 聊天真相)。
- `turn-runner.ts`:`runTurnOnce({svc,bus,adapter,sessionKey,branchId,nodeId,runtimeSessionId,text}) → {result:TurnResult, events:CanonicalEvent[]}`;
  在 observer 哈希之前累积**原文** assistant text;`result` 事件决定 completed/failed;`wasInterrupted` → cancelled。
- `session-manager.ts`:**运行时会话映射的唯一写者**(gate 13)。`resolveSession`(lazy:root/import 首 turn 才 materialize;
  **fork 建的 branch 先 `findBound` 检查已绑定 sessionKey,绝不再播种**——reviewer B2/gate 1)、`adoptSession`(fork-orchestrator 用)、
  `interrupt(branchId)`(只动该 branch 的活动调用)、`release`、`isBusy`。每 branch 串行,非全局锁(gate 11)。
- `fork-orchestrator.ts`:`createFork` 在响应前**急切冻结**(gate 1):`svc.createBranchFromNode` 先落分支+不可变 snapshot;
  fork 点是父当前 head 且父已 materialize → `adapter.forkFromHead`;否则 `adapter.reconstructBranchFromHistory(frozen snapshot)`;
  两者都经 `sessionManager.adoptSession`。`TRANSCRIPT_ACK` 转录确认框(gate 2 R1)。实际上 `originStrategy` 记录保持
  replay_reconstruction(当前 head 冻结的 native 路径在结果里以 strategy 字段返回,不写数据库字段)。
- `reconcile.ts`:`reconcileOnBoot(svc)` = `svc.reconcileTurnRuns()` + **B3**:把 owner 节点已非 pending 的
  running/queued/needs_attention/waiting agent_runs 全标 cancelled(避免 Agent Monitor 永久 busy 卡)。
- 为支撑上面,给 `DomainService` 加了 `lastNode` 与 `listAgentRunsByStatus` 透传,**必须 `pnpm --filter @cbw/domain build` 后控制面才能编译**。

## 4. S4 剩余（下一步，写完这些才 build/test）

1. `apps/control-plane/src/branch-runner.ts`:保留 `startBranch/runTurn`(旧调用点不坏),但加
   **raw-capture 钩子**使 `runTurn` 可返回 `{events, capture}`;node 状态写入只走 open/complete/fail/cancel,绝不进事件 ingest。
   (其实 Phase 4 主路径可直接用 `runTurnOnce`;`branch-runner` 可退化为兼容壳。)
2. `apps/control-plane/src/index.ts`:改成 `main()`:`openDb(process.env.CBW_DB ?? './data/cbw.db')`(真实文件,重启可恢复)
   → 构造 adapter(有 `CBW_FAKE_RUNTIME=1` 时用假 runtime 加载器)→ `reconcileOnBoot(svc)` → listen 127.0.0.1:15723。
   注意 S5 要 buildApp(见 §6),main() 与 buildApp 解耦。
3. 把 `apps/control-plane/test/branch-runner.test.mjs` 的 3 个用例迁移成显式生命周期:`openTurn → runTurn[Once] → completeTurn`。
4. 新增 S4 测试(放到 `apps/control-plane/test/`):frozen-fork(g1)、reconstruction 零副作用(g2,含 snapshot 纯内容断言)、
   turn-result-truth(g4:父含 secret 命令**原样**持久化 + 子分支事件集无泄漏 + assistantContent 与原文逐字一致 + 事件被 scrub +
   整串 secret 防御)、interrupt 隔离(g6)、attention(g7,fake 注入 permission.requested→registry→GET/POST respond)、
   concurrency(g11,Main+Child 交错定时器都完成,非全局锁;用可控制时序的假 adapter)、restart(g15 + B3 孤儿 run 也被 cancel)、
   attribution-honesty(g9)。

## 5. S4 测试假 adapter 关键点

- 假 adapter 是**普通对象结构化实现** `RuntimeAdapter`:`startSession` 返回
  `{externalSessionId, cwd, running, sessionKey, runtimeVersion?}`;`sendMessage` 是 async-generator 按序 yield;
  `forkFromHead/reconstructBranchFromHistory` 返回带新 sessionKey 的 session;**默认无计时/顺序控制原语**——
  并发(g11)和 attention(g7)测试要自带(如可控 button/signal 队列)。
- 现有 `apps/control-plane/test/branch-runner.test.mjs` 里的 `fakeAdapter()` 是范本。

## 6. S5 / S6 / S7 / S8 摘要(完整细节见已批准计划)

- **S5 server**(控制面,续 S4 之后):`context.ts`、`server.ts`=`buildApp({svc,bus,sessionManager,forkOrchestrator,adapter,fakeAdapter?,corsAllowlist?})`
  工厂(cors 仅 dev + `http://localhost:5173` 与 `http://127.0.0.1:5173` 显式白名单 → websocket → **routes 先** → **static SPA fallback 最后**,
  保证 SPA 通配符永不遮蔽 `/api/*`)。路由:projects/branches(有 `/messages`→202 {nodeId} 或 409 Busy,`/interrupt`)、
  conversation(gate 3)、nodes、events(`?after=&limit=`,gate 8)、agent-runs、runtime(capabilities 诚实/sessions/reconcile)、
  attention(gate 7,GET /api/attention、POST /api/attention/:id/respond,内存 registry,fake 播种)。
  ws.ts:`GET /ws/projects/:id/events`,Origin 校验(=Host 或 dev 白名单否则 403-close),client `{hello:{lastSeqRel}}` → gap-fill `listEventsSince`
  → 转发 `seqRel>lastSeqRel` 的 delta,断连清理。`listen({host:"127.0.0.1",port:15723})`。
  依赖:fastify/@fastify/websocket/@fastify/cors/@fastify/static。
- **S6 web**(`apps/web`,Vite+React+zustand):lib/ws.ts(游标 lastSeqRel + 有界 Set<eventId> 去重 + 重连 = REST ?after= 追赶 + 重开 WS gap-fill);
  store slices(branches/conversation/toolCards/agentMonitor/timeline/attention/socket);三栏:ConversationTree(仅 Shared 模式,gate 14,无 Worktree 控件)、
  ChatPane(inherited/local 徽标 + 中断键)、AgentMonitor(**attribution 诚实** gate 9:工具事件只在 branch/turn 层渲染,不进 agent card)、
  Timeline(过滤/暂停自动滚动/折叠重复工具/错误与权限聚焦)、AttentionCard。
  vite.config `server.proxy {"/api":"http://127.0.0.1:15723", "/ws":{target:"ws://127.0.0.1:15723",ws:true}}`。
  `pnpm --filter @cbw/web build`(tsc + vite)为 gate。
- **S7 E2E(硬 gate)**：Playwright,`channel:"chrome"` **默认**(本机 ms-playwright 无 chromium;系统 Chrome 在
  `C:\Program Files\Google\Chrome\Application\chrome.exe`);`npx playwright install chromium` 仅 best-effort。
  `apps/web/e2e/ph4-flow.spec.ts`,配 `CBW_FAKE_RUNTIME=1`:Main 多轮 → 历史 fork → child chat(inherited 徽标)→ child 再 fork →
  回 Main 继续;断言 Agent Monitor 卡片 / Timeline 过滤与中断 / conversation 无泄漏(gate 1/10/14)。
- **S8 docs**:`docs/10_CONTROL_PLANE_API.md`(真实端点,含 conversation/cursor/attention/409/reconcile)、`docs/03`(gate-2 不变量 +
  R1 transcript-ack)、`docs/04`(gate-9 attribution 规则)、`docs/05`;**修 `docs/02` 的 `createBranchFromNode` 签名漂移**
  (reviewer S2 遗留,现在本仓库的 svc.createBranchFromNode 带 originStrategy replays…)。更新 PROJECT_STATE/BACKLOG/CHANGELOG/ADR;
  然后 **Phase 4 独立 reviewer + gate**(宪法要求)。

## 7. 本会话已并行启动的 background agents（2026-09-17，尽量别重复做同一块）

- **(A) 控制面 S4 收尾 + S5**:完成 §4 剩余 + 写 S4 测试,然后 S5 Fastify server(§6),跑绿 `apps/control-plane`(build + node --test)。
- **(B) web 脚手架 S6**:按 §6 建 `apps/web` 并 `pnpm build` 绿。
- **(C) docs S8**:§6 S8。(A/B 的产出可能晚到;若新会话先跑,先读它们写好的文件再决定重做与否——审阅 diff 后只补缺。)

> 若这些后台任务在本会话存档后被终止,新会话直接按本文件从 §4 开始,不依赖它们的结果。

## 8. 验证基线（改任何东西前先跑）

```
pnpm -r --filter './packages/*' build
pnpm -r --filter './packages/*' test   # domain 32, event-protocol 12, runtime 7(2 skip) — 全绿
```
新代码要不破坏这基线。git 仓库已存在(无 remote),**不要擅自 commit**,除非用户明确要求。
