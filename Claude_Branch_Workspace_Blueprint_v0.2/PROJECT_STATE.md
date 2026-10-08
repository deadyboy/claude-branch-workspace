# PROJECT STATE

## Visual Workspace — 2026-10-08 委派复验与可操作预览（PARTIAL）

E6最小真实复验PASS：同一qwen3.8-chat/bridge，独立15827实例与干净数据，主Agent经产品MCP创建历史子分支、创建/运行Task、get_turn_result读取完成输出并返回VERIFIED；子Task只包含分叉前PAST标记，不包含之后FUTURE标记。主控轮次175333ms，仍在原180秒上限内。它是针对E6的HTTP产品入口复验，不是重新跑完整浏览器链路；单次接近阈值，不代表稳定性/性能已验收。

前轮110.484秒分叉中，本地前后处理约2.798秒，子CLI请求/生成时间窗107.686秒；历史确认生成了1651字符总结。已将实际orchestrator seed改为仅回复TRANSCRIPT_ACK，保留完整历史、角色与只读禁止执行规则。回归先红后绿，相关6/6通过，Astra独立review通过。本轮分叉工具11.318秒且实际只回复TRANSCRIPT_ACK；新fixture/上游波动使其不是严格同输入A/B，不宣称固定提速比例。结果工具返回后主控仍用了约78秒才完成回答，后续性能重点在模型各轮响应，而非创建Task接口。

UI新增窄屏header换行与5视图可达；Timeline默认折叠、待处理数量入口及展开自动滚动。web构建通过，Astra最终review通过；实际约650px与1280px浏览器验证了Graph历史上下文、Team执行详情、Project真实文件预览与日志展开到底部。尚无完整视觉重设计、团队关系图或代码语义项目图；当前仍是可操作原型。

已保留真实验收数据的独立预览：http://127.0.0.1:15826 。打开Live acceptance 349eff8d可查看历史分叉、完成文件任务与成果；其中cancelled的MCP worker是上轮超时实验重启后的真实恢复状态，不伪造成成功。首次预览前保存cbw-before-preview.db；全局配置、bridge15722与生产15723未改。预览使用最新构建。

证据：E6数据/会话/result.json在 `F:\CodexTemp\cbw-e6-ack-eqykZl`；日志与Graph/Team/Project截图在 `F:\CodexTemp\cbw-preview-20261008`。此前全量测试批次异常仍保留，不因针对性测试成功改写。下一批优先统一UI信息层级与中文文案、团队关系视图；同时继续记录模型等待与E6稳定性，剩余E3/E4/E7/E9按实验方案推进。

## Visual Workspace — 2026-10-08 bridge 接入修复（PARTIAL）

已定位此前 warm-up 超时：本项目独立 Claude CLI 读取旧全局配置，连接桌面 bridge 时返回 401；仅替换进程环境仍会被旧 CLI settings 覆盖。隔离配置后发现旧 qwen3.6-chat 不在现有凭据的模型目录中；使用当前桌面配置列出的 qwen3.8-chat 后真实会话成功。学校网关凭据仍由既有 bridge 链路管理，无需用户重填，也未修改全局 settings、bridge 配置或生产服务。

新增 `pnpm start:bridge -- --model qwen3.8-chat --data-dir <专用目录> --port <独立端口>`：读取桌面已应用 profile，校验本机端点及模型，将内部凭据仅传入子进程环境；数据库与非敏感 CLI 配置成对保存。原 `pnpm start` 保留。新入口在原生 Windows 实际创建会话并得到预期回答（24.2秒）；入口测试7/7通过。

真实浏览器复验已证明历史 worktree 分叉隔离及任务实际写文件。另修复两个实测阻断：Team 派工前读取服务器已完成轮次并拒绝过期项目/分支响应；正式 turn 精确允许本项目12个MCP工具，解决 register_artifact 被CLI拒绝。初始化仍禁用工具，未使用全局权限绕过。Astra独立审阅通过，Sol runtime针对性10/10通过。

最终版本全项目构建通过。全量单元测试228通过、3跳过、1失败（shutdown-fork文件）；该关闭测试原样单独复跑1/1通过，批次失败原因尚未确定，不能称本轮整组全绿。干净数据库真实UI复验已通过：UI建项目、历史worktree隔离、Team隔离派工写文件及MCP登记、Project文件预览/回源、Results当前内容/回源。E6未通过：主控轮次在浏览器180秒等待上限仍pending；事件证明create_branch_from_node/create_task/run_task已调用并返回，实验停止后的数据库显示子Task仍running，尚无完成与结果回收证据。整场耗时8.7分钟，结论PARTIAL；未盲目延长超时。下一步从这组会话/工具记录区分分叉初始化、上游生成和结果等待耗时，再复验E6。不能将局部通过等同全部E1—E9验收。证据：`F:\CodexTemp\cbw-runtime-20261008-2TROKD` 的 `build-final.log`、`unit-final.log`、`live-final.log`；最终浏览器实验数据与截图在 `F:\CodexTemp\cbw-live-final-iUVOfM`。所有实验使用独立端口/数据，未commit/push或重启生产。

## Visual Workspace — 2026-10-07 本地实现与验收（PARTIAL）

当前分支 `codex/visual-workspace-m1`，基于 `11a3463` 的未提交增量；保留 Claude 原有改动。旧 Phase/远程部署记录不能作为本轮 UI 验收结果。

Astra指挥并独立审阅，Sol负责后端，Luna负责界面，主Agent集成验收。本轮接通：Graph历史上下文/明确跳转/历史分叉后进入子分支；Team通过统一scheduler/runtime实际派工和重试；正式会话配置当前实例MCP创建/启动/查询Task、等待结果与登记文件；Project目录展开、文件预览与Task/Artifact来源；Results读取当前文件及返回来源分支。文件登记证明执行声明与存在性，不证明独占写入；无来源记录不猜测关系，worktree文件按实际分支目录读取。

修复实际验收缺陷：独立视图落入窄列导致节点被挡；删除diff丢失；跨分支旧内容残留；首次REST读取和WS接入空档漏刷新。分支读取按项目、分支、打开轮次拒绝过期响应。

原生Windows验证：全项目 `pnpm build` 成功；`pnpm test` 227通过、3默认live跳过、0失败。11个模拟浏览器场景均有通过记录：整组10通过/1失败，剩余isolated dispatch修复后原用例单独通过（3.4秒）；不是最终版本整组11/11重跑。

**真实模型验收失败，后续场景未执行**：独立15824端口与live.db，从UI创建合成Git项目并发首条消息；CLI会话warm-up在120000ms超时，节点failed。尚未进入正式send/MCP调用；历史隔离、真实文件生成、回源和E6主控委派均不得标PASS。未延长超时、换模型、改认证或重启生产。

只读定位：CLI进程已启动，合成会话记录存在用户输入但没有assistant/API错误；15722网关监听与心跳正常，现有指标未观察到本次请求进入上游。runtime有意不保存stderr，无法据现有证据区分CLI请求前等待、鉴权前拒绝或网关问题；不能将猜测写成根因。选定模型未改，未继续发送模型请求。

证据：`F:\CodexTemp\cbw-ui-x\codex-20261007-141726-4e5b93` 下 `build.log`、`unit.log`、`e2e-final.log`、`isolated-recheck.log`、`live.log`及output截图/trace；首轮失败证据保留。

工作估计：接手约40–50%，本轮后约55–65%，按产品操作闭环判断，非代码统计；M1/M2/M3仍PARTIAL。剩余：定位初始化阻塞并验证真实模型闭环，E3/E4完整UI应用/冲突矩阵，E7规模/性能，多项目异常恢复，E9用户无指导试用。Project初版只表达文件包含/任务执行/成果来源，不声称理解任意项目的代码语义。

未commit/push、未合并远端、未迁移生产数据库、未重启15723实例。分配与执行顺序见 `docs/13_VISUAL_WORKSPACE_EXPERIMENT_PLAN.md` §11。

## Remote deployment — RESOLVED 2026-09-27 (see SERVER_DEPLOYMENT_HANDOFF.md)

Auth blocker FIXED (server settings token set to the real desktop credential + control-plane
restart; user-authorized). Real turns work end-to-end. **Phase 6 scale now PASSES on the
server: 20-way 20/20 and 40-way 40/40** (both peak at full concurrency; 40-way 69s). The
40-way pass required expanding the local Vision Bridge credential pool from 3 to 5 upstream
keys (effective concurrency 36→48). Previously 20-way was 14/20 FAIL on the 16 GB laptop.
Evidence under `.runtime-experiments/capacity-1790448174742` (40-way) and `...4243562` (20-way).

## Remote deployment — 2026-09-26 (see SERVER_DEPLOYMENT_HANDOFF.md)

CBW runs on the USTC server (control plane = systemd user service `cbw-control-plane`,
boot-autostart via Linger) with local-only UI over two loopback SSH tunnels
(auto-start keepers as Scheduled Tasks `CBWTunnelReverse`/`CBWTunnelForward`).
Gate 12 preserved. (The auth blocker recorded here was fixed 2026-09-27 — see above.)
Full detail + diagnostics: `SERVER_DEPLOYMENT_HANDOFF.md`.

## Previous integration — 2026-09-18 (superseded — see "Remote deployment — RESOLVED 2026-09-27" above)

Merged into main `master` via fast-forward (2026-09-18): `b93f225` → `d68055b`
→ `9767e8d`. Phase 5 MCP is complete, functional/code-review gate PASS. Phase 6
isolation, scheduler and UI implementation are present; scale gate is PARTIAL
(real 10-way passes, real 20-way has native CLI crashes; default pool stays 5;
20/40 not supported as operating claims). Phase 4 below is retained history.
Current results and remaining limits: `PHASE5_6_HANDOFF.md`.

Verified: real outer Claude agent → stdio MCP → production HTTP → real child
Claude session → persisted answer; historical reconstruction, Git worktree,
two independent turns, restart continuity, interruption and archive preservation.
Full build, 127 default tests (3 opt-in live tests skipped), and both Playwright E2E tests passed.
Independent review's startup/fork/shutdown defects were fixed and re-reviewed PASS.
The final clean-repository runtime smoke passed. Keep default concurrency 5;
do not enable 20/40 on the strength of synthetic tests.
The real outer-agent MCP test passed again against the final runtime fixture.

Runtime settings now use inline JSON and do not dirty the user's repository.
The per-session endpoint overrides a stale global settings.env value without
changing global configuration, authentication or the selected model.

The current worktree is the implementation source. No port-back, commit, merge
or push has been performed; the original checkout and its changes are preserved.

## Historical Phase 4 record

> Claude Code 必须持续更新此文件。它是跨 session/compaction 的简洁事实源。
> 注意：以下 "Phase/Objective/Next" 标题均为**历史快照**（Phase 4 时点）。
> 当前状态以上方 "Remote deployment — RESOLVED 2026-09-27" 与 PHASE5_6_HANDOFF.md 为准。

### Phase 4 at that time

Phase 4 — COMPLETE, Gate PASS (independent review FAIL→PASS, reviewer APPROVE — `docs/generated/PHASE4_REVIEW.md`). S1–S8 all DONE/GREEN: domain 32/32, event-protocol 13/13, runtime 9+2 live-skip, control-plane 29+1 live-skip, Playwright E2E golden path PASS. Implementation record: `PHASE4_HANDOFF.md`. Next: Phase 5 (MCP control surface).

### Objective at that time

Phase 4: UI — conversation tree, current-branch chat, fork-from-turn action, branch breadcrumb/rename, agent monitor, event timeline, permission/attention state, restart/reconnect UX (backlog P4, deferred batching policy lands here).

## Verified Facts (all locally verified 2026-09-17, Claude Code v2.1.226, Win11/Git Bash)

- Child `claude -p` processes authenticate via desktop gateway `ANTHROPIC_BASE_URL=http://127.0.0.1:15722` + `ANTHROPIC_AUTH_TOKEN` from `~/.claude/settings.json` env. (settings' own 15721 is dead; the ACTIVE per-process gateway is 15722.)
- Node async `child_process.spawn` with closed stdin drives real sessions; `spawnSync` hangs. SIGTERM interrupts in ~110ms.
- Session lifecycle: self-chosen `--session-id <uuid>` (VALIDATION: must be a true UUID, 12-hex last group; malformed → `Error: Invalid session ID. Must be a valid UUID.`, exit 1); `--resume <id>` continues in a NEW process across restarts.
- `--session-id <valid-uuid>` pins the CLI's external session id to the control-plane UUID: the `system:init` session_id equals the passed UUID (live-probed). So `externalSessionId === control-plane uuid` is now REAL, not a convention.
- `--session-id` over an ALREADY-MATERIALIZED UUID is rejected: `Error: Session ID <uuid> is already in use.` (live-probed 2026-09-17). So a control-plane `startSession` must generate a FRESH UUID per new branch/runtime session; restart recovery resumes `--resume <existing-ext>` (never re-`startSession`). Live tests use `randomUUID()` per run for exactly this reason.
- IMPORTANT live semantics: a no-prompt `--resume`/`--fork-session` emits no init (CLI asks for a prompt); `--resume` does NOT change the underlying external id — the init reports the ORIGINAL resumed id, so identity is stable. `resumeSession(externalId,cwd)` is registration-only; the actual round-trip happens on first sendMessage.
- Fork-from-head: native `--resume <id> --fork-session --session-id <new-uuid>` copies full prefix; original preserved; branch-of-branch works (grandchild inherits chain, earlier branches unaffected).
- Fork-from-arbitrary-turn has **no native CLI** → strategy = reconstruction (ADR-006). Automated no-leak proof PASSES with per-branch isolated cwd + auto-memory disabled: child knows turn≤N only, root unmutated, no cross-branch future memory.
- Event surface: `--print --verbose --include-hook-events --output-format=stream-json` → `system:init`(session_id) + PreToolUse/PostToolUse + SubagentStart/Stop + task_* + assistant tool_use + user tool_result + background_tasks_changed + thinking_tokens(ephemeral, excluded). Hook wrappers carry empty payloads; real tool detail comes from tool_use/tool_result records.
- Worktree: `--worktree` creates real isolated git worktree; shared = plain cwd.
- Phase 3 live-discovery (2026-09-17): persisting canonical events against a REAL gateway exposes an FK constraint that hermetic fakes hide — `insertEvent` rejects `runtime_session_id`/`agent_run_id` values that aren't rows. Root cause: the demo was re-implementing the pipeline instead of calling the production `startBranch`/`runTurn` (which resolve `runtime_sessions.id` and materialize agent runs first). Fixed by routing the demo + live test through the production path. Lesson: live gate must exercise the exact production wiring, not a hand-rolled twin.
- Live turn latency hazard (2026-09-17): a demo turn spawns `startSession` warm-up + `sendMessage` resume run; BOTH capped by `turnTimeoutMs`, so under parallel load (main session + reviewer subagent sharing the gateway) a 300s default could time out mid-turn. Fix: raised `turnTimeoutMs` default to 600s, added a separate `startTurnTimeoutMs` (120s warm-up), threaded `timeoutMs` through `runTurn`/`spawnOnce`. Hermetic timeout test updated to inject both.

## Open Blockers

- 任意历史节点 fork：无原生 CLI 路径，用 reconstruction（ADR-006）已测试通过。非 blocker。
- Gateway port 耦合/漂移：控制平面必须运行时发现活端口（15722）而非信任 settings (15721)。设计中。
- bypassPermissions 与宪法矛盾：运行时 print-mode 默认 bypass；需在 Phase 2/3 明确默认权限 profile（倾向 auto/acceptEdits），且注意 v0 中 permission 交互仅 interactive 可用。

## Decisions

- ADR-001..005 accepted (Control Plane / two-tree / identifiers-not-names / workspace modes / local-first adapters)
- ADR-006 accepted: forkFromHead=native, forkFromNode=reconstruction (no fake ancestry; origin_strategy=replay_reconstruction)
- ADR-007 accepted: TS/Node + Fastify + SQLite(better-sqlite3) + pnpm + React/Vite; child_process.spawn print-mode primary; WSL secondary.
- Phase 1 implementation notes: `@cbw/domain` package with versioned SQLite migrations; `messages.seq` monotonic per branch for deterministic ordering; fork points require completed node status; snapshots seed reconstruction from visibleMessages only (no fabricated instructions).

## Last Completed Gate

Phase 4 Gate — PASS (independent review FAIL→PASS, reviewer APPROVE, 15/15 hard gates, 2026-09-17):
- Reviewer findings → fixed: BLOCKER — gate 2 `TRANSCRIPT_ACK` reconstruction seed was dead code (`seedPrompt` built but discarded); now genuinely threads through `ForkInput.seedText` → `claude-cli-adapter.ts reconstructBranchFromHistory` (seeded over raw join), asserted in `reconstruction-side-effects.test.mjs` that the adapter RECEIVED the ack-framed seed. MAJOR 1 — gate 1 native-fork identity monotonicity untested hermetically; fixed with a fork-aware fake `claude` + distinct-child-external-id + "both run independently" tests + structural `--fork-session`/fresh `--session-id` arg test. MAJOR 2 — gate 11 `POST /messages` had no busy guard; fixed via `SessionManager.hasActiveTurn` (turn node in flight, NOT a mere bound session) → 409 pre-`openTurn`, `markNode`/`release` in `runTurnAsync`; proven by `busy-guard.test.mjs` (busy 409/no 2nd node; unrelated branch 202; adopted-idle child first message 202).
- Non-blocking observations recorded (not blockers): guard→openTurn→markNode TOCTOU window under true concurrency; native-fork/reconstruction real-CLI automated run remains CBW_LIVE opt-in. **Second-pass review (2026-09-18) promoted the TOCTOU observation to a MAJOR and closed it** — synchronous in-process `SessionManager.claimTurn` (request-handler claim with no `await`, separate `pendingClaim` map drained by `resolveSession`, cleared by `release`; `hasActiveTurn` sees pending claims). Two further second-pass MAJORs fixed + re-verified: restart-resume dead code (gate 13 — adapter now gets the domain DB as a duck-typed `RuntimePersistence` hook via `new ClaudeCliAdapter(undefined, undefined, svc)`, and `resolveSession` branch (a) re-registers the bound external session so its first post-restart `sendMessage` never throws `unknown session`; the persisted `runtime_sessions.id` stays the authoritative sessionKey); secret-shaped prefix/substring leak (gate 4 — whole-string boundary-class redaction `/(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/` redacts the ENTIRE string; benign words unchanged).
- Hermetic (re-verified 2026-09-18): control-plane 30 pass + 1 live-skip, domain 32/32, event-protocol 14/14, runtime 9 pass + 2 live-skip; chain build green; Playwright E2E golden path PASS (system Chrome + CBW_FAKE_RUNTIME).
- Record: `docs/generated/PHASE4_REVIEW.md` (both passes).

Phase 3 Gate — PASS (live, real gateway; committed after independent review FAIL→PASS):
- Live demo: one branch turn using Glob tool + one Explore subagent, observed end-to-end through `startBranch`/`runTurn` → observer → EventBus + domain DB. Execution tree rooted at completed `main:Main` with completed `subagent:Explore`; persisted event digest all attributed `node=y run=y`; registry stays at 1 (AgentRuns transient, never branches).
- Reviewer FAIL→PASS: BLOCKERs fixed — (1) secret key inside a Bash command leaked verbatim (allowlist + whole-string-only scrub); now scrubbed anywhere in a string / summary / text; (2) FK crash when the first event was `task_started` (parent main not materialized) — persist hook now lazily creates the parent main. MAJORs fixed — main run now completes at `session.stopped`; assistant text + agent summary routed through `scrub()`. MINOR fixed — `getRuntimeSession` SELECT * → explicit `col AS camel`.
- Hermetic: 33/33 green (incl. new regression tests for redaction-in-Bash, task-first FK, main completion); 3 live tests skip without `CBW_LIVE=1`.
- Live-discovery: 300s turn timeout under parallel gateway load (this session + reviewer) could fire mid-turn; raised `turnTimeoutMs` default to 600s + separate `startTurnTimeoutMs` (120s warm-up), threaded through `runTurn`/`spawnOnce`.
- Record: `docs/generated/PHASE3_REVIEW.md`.

# This is a historical snapshot.
## Next actions recorded at that time (2026-09-18 snapshot; historical)

1. **Phase 4 COMPLETE — Gate PASS** (independent review FAIL→PASS first pass 2026-09-17; **second-pass review 2026-09-18 → 3 MAJORs fixed & re-approved**; record `docs/generated/PHASE4_REVIEW.md`). All S1–S8 done & green (re-verified 2026-09-18): domain 32/32, event-protocol 14/14, runtime 9+2 skip, control-plane 30+1 skip, Playwright E2E golden path PASS.
2. **Phase 5 (NEXT per backlog P5): Agent Control MCP surface** — create_branch_from_node / send_message / list_branches / get_branch_status / interrupt_branch / archive_branch / query_execution_status / Main-agent integration test.
3. Interrupt/reconnect with long-lived process management (deferred, Phase 5/6 with the MCP control surface).
