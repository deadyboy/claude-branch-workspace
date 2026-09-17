# Phase 4 Review Map — hard gates #1–#15

> 每 gate 一行：**实现位置** + **测试/证据位置**（Phase 4 S8 定稿）。
> 独立 review 时按此核对；gate PASS/FAIL 记录见 `docs/generated/PHASE4_REVIEW.md`（Phase 4 完成 2026-09-17，gate PASS）。

| # | Gate | 实现（where） | 测试/证据（where + 状态） |
|---|---|---|---|
| 1 | **Frozen fork**（分支在创建时冻结，父后续 turn 永不泄漏） | `apps/control-plane/src/fork-orchestrator.ts`（`createFork` eager freeze）、`packages/domain/src/domain-services.ts createBranchFromNode` + `captureBranchContext` | `apps/control-plane/test/frozen-fork.test.mjs`、`branch-runner.test.mjs`（g1 断言 child 事件集不含父 ≥fork 点）、E2E `apps/web/e2e/ph4-flow.spec.ts`（g1 no-leak：`never tell child this secret` 不出现在 child） |
| 2 | **Reconstruction side-effect-free**（重建零副作用 + transcript-ack） | `apps/control-plane/src/fork-orchestrator.ts`（`TRANSCRIPT_ACK` 帧 + 只喂不可变 snapshot）、`packages/runtime` `reconstructBranchFromHistory` | `apps/control-plane/test/reconstruction-side-effects.test.mjs`、`packages/runtime/test/fork-fidelity-integration.test.mjs`（seed turn 零 tool_use） |
| 3 | **Effective conversation**（inherited/local + fork 点截止） | `packages/domain/src/domain-services.ts getEffectiveConversation`、route `apps/control-plane/src/routes/conversation.ts` | `packages/domain/test/effective-conversation.test.mjs`、E2E g1 徽标断言 |
| 4 | **TurnResult = chat truth**（`visible_content` 只整体替换、scrub 整串） | `apps/control-plane/src/turn-result.ts`、`packages/event-protocol/src/redact.ts` | `apps/control-plane/test/turn-result-truth.test.mjs`、`packages/event-protocol/test/redaction.test.mjs` |
| 5 | **Explicit turn lifecycle**（openTurn→complete/fail/cancel，idempotent） | `packages/domain/src/domain-services.ts` openTurn/completeTurn/failTurn/cancelTurn、route `routes/branches.ts POST /messages`（202 `{nodeId}`） | `packages/domain/test/turn-lifecycle.test.mjs` |
| 6 | **Interrupt = cancelled + isolated**（只停目标 branch） | `packages/runtime` `interrupt()`、`apps/control-plane/src/session-manager.ts interrupt`、route `POST /interrupt` → `cancelTurn` | `packages/runtime/test/interrupt.test.mjs`、`apps/control-plane/test/interrupt.test.mjs` |
| 7 | **Attention loop**（registry + allow/deny；acceptEdits no-stall 诚实边界） | `apps/control-plane/src/attention-registry.ts`（`subscribeToBus` 生产接线）+ index.ts `bus.subscribe` + route `routes/attention.ts`；observer `attention.required` | `apps/control-plane/test/attention.test.mjs`（含 bus→registry→GET /api/attention 播种路径）、`packages/event-protocol/test/observer.test.mjs`（g7）、E2E g7 卡片断言 |
| 8 | **Durable seq_rel cursor + fetch gap-fill**（WS + REST 共用） | `packages/domain` `events.seq_rel`、`svc.listEventsSince`、`apps/control-plane/src/ws.ts`（gap-fill + origin）、routes/events.ts | `packages/domain/test/event-cursor.test.mjs`、`apps/control-plane/test/ws-gate.test.mjs`、E2E g8 timeline 单调 seq |
| 9 | **Attribution honesty**（工具只归属 branch/turn，不塞 agent card） | 执行树 `getExecutionTree`、route `agent-runs.ts` + `docs/04 §8` | `apps/control-plane/test/attribution-honesty.test.mjs`（+ `attribution-live.test.mjs` CBW_LIVE=1） |
| 10 | **Playwright E2E golden path**（hermetic chrome） | `apps/web/playwright.config.ts`（`channel:"chrome"`、`CBW_FAKE_RUNTIME=1`）、`apps/control-plane/src/fake-runtime.ts` | `apps/web/e2e/ph4-flow.spec.ts`（boot/multi-turn/fork/no-leak/attention）PASS |
| 11 | **Per-branch serialization（非全局锁）** | `apps/control-plane/src/session-manager.ts`（`Map<branchId,state>`；`hasActiveTurn`/`markNode`）、`routes/branches.ts POST /messages` 409 | `apps/control-plane/test/concurrency.test.mjs`、`busy-guard.test.mjs`（在飞 node 409 / 无二节点；无关 branch 202；adopted-idle child 不误 409） |
| 12 | **Loopback + origin 校验** | `apps/control-plane/src/index.ts`（只 `listen({host:"127.0.0.1"})`）、`ws.ts` origin gate、`server.ts` cors 白名单 | `apps/control-plane/test/security.test.mjs`、`ws-gate.test.mjs` |
| 13 | **runtime_sessions 唯一写者（session-manager）** | `apps/control-plane/src/session-manager.ts` + `packages/domain` `runtime_sessions` 表 | `apps/control-plane/test/restart.test.mjs`、`packages/runtime/test/persistence-restart.test.mjs`、E2E（fork eager 绑定、无二次播种） |
| 14 | **Shared-only UI（无 worktree 选择器）** | `apps/web/src/components/ConversationTree.tsx`（`Shared only · Worktree = Phase 6`、mode-tag `S`） | E2E g14（`mode-tag` = "S"、header 徽标）、`apps/web/src` 无 worktree 控件 |
| 15 | **Restart reconcile（+ B3 孤儿 AgentRun）** | `apps/control-plane/src/reconcile.ts reconcileOnBoot` + index.ts boot 调用 + route `POST /api/runtime/reconcile` | `apps/control-plane/test/restart.test.mjs`、`packages/domain/test/restart.test.mjs` |

## Reviewer 核对区（S8 文档配套）

- `docs/10_CONTROL_PLANE_API.md` — HTTP/WS 真实契约（含 attention wire、conversation `items`、WS 扁平帧、events `latestSeqRel`）。
- `docs/03 §8` — gate 2 invariant + R1 `TRANSCRIPT_ACK`；§9 per-session interrupt（gate 6）。
- `docs/04 §8` — gate 9 attribution honesty（S1 修正）。
- `docs/05` — Phase 4 data-model + UI gates（g9/g14/g11/g6/g7/g8）。
- `docs/02 §4` — `createBranchFromNode` 现签名（S2 修正）已无 drift。
- 独立 review 记录（已写）：`docs/generated/PHASE4_REVIEW.md` — reviewer FAIL→APPROVE（BLOCKER-1 seedText/TRANSCRIPT_ACK；MAJOR-1 fork-native hermetic；MAJOR-2 busy 409/hasActiveTurn），15/15 gates PASS，Phase 4 Gate PASS（2026-09-17）。
