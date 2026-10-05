# Changelog

## 2026-10-05 — Repository root lift

- Lift application, workspace, README and project instructions to the Git root.
- Merge script directories and ignore rules; retain tunnel files unchanged.
- Update CI lockfile/browser paths and deployment docs; relative workspace,
  Playwright and live-script paths remain valid without code changes.
- Leave LICENSE pending an explicit maintainer decision.
- Validation: `docs/generated/REPO_ROOT_LIFT_VALIDATION.md`.

## Consolidation — 2026-09-18

- Rescued uncommitted Codex Phase 5/6 work into `codex/phase5-6-integration` as `9767e8d`,
  then fast-forwarded main `master` to it (`b93f225` → `d68055b` → `9767e8d`).
- Re-verified in main: build green (all 6 workspace projects), full default suite
  **127 tests, 0 fail, 4 opt-in live skips**, mcp-server 8/8, control-plane 57+1 skip.
- Phase 6 status recorded as **PARTIAL** (real 5-way/10-way PASS, 20-way native CLI
  crash `3221226505`; default pool stays 5; 20/40 not supported operating claims).

## Phase 5/6 integration — 2026-09-18

- Added official stdio MCP control surface and real Main-to-child dispatch acceptance.
- Added worktree binding, bounded execution, database ownership and cancellation/shutdown handling.
- Fixed streaming terminal truth, startup/fork races, crash-orphan recovery, endpoint precedence and settings pollution.
- Added historical/worktree fork UI, workspace status, filters and no-event pending recovery.
- Native Windows build and 127 default tests passed (3 separate opt-in live tests).
- Independent code review PASS; live capacity boundary and evidence: `PHASE5_6_HANDOFF.md`.

## Phase 4 — Usable UI (COMPLETE, Gate PASS 2026-09-17 — independent review FAIL→PASS, reviewer APPROVE 15/15)

- **S1 domain (gate 3/5/8/15)**: SCHEMA_VERSION 3 — `events.seq_rel` project-scoped monotonic cursor (backfill + `idx_events_project_seq`); explicit turn lifecycle `openTurn`→`completeTurn`/`failTurn`/`cancelTurn` (idempotent; `appendCompletedTurn` retained as a thin deprecated wrapper — reviewer B4); `getEffectiveConversation` (inherited/local + fork-point cutoff); `listEventsSince`/`lastEventSeqRel`; `reconcileTurnRuns`. Also added `svc.lastNode` + `svc.listAgentRunsByStatus` passthroughs for the control plane. 32/32 tests.
- **S2 event-protocol (gate 4/6/7)**: `TOOL_ALLOW.Bash=["command","output"]` (output surface-bearing, scrubbed); `TurnObserver.userMessage()`/`cancel()` (emit `session.stopped` status cancelled); **gate 7** — new `attention.required` canonical type (raw `{kind:"attention", summary?}` → redacted `attention.required` with allowlisted `summary`). 13/13 tests.
- **S3 runtime adapter (gate 6)**: real per-session interrupt — per-sessionKey in-flight child registry in `spawnOnce`, `interrupt()` SIGTERM→SIGKILL + `wasInterrupted` observation, only the targeted session's child killed. 7/7 + 2 CBW_LIVE skips.
- **S4 control-plane core + tests (gates 1/2/4/6/7/9/11/13/15)**: `TurnResult` (chat truth, gate 4); `turn-runner.runTurnOnce` (verbatim pre-scrub assistant capture, terminal decision, interrupt→cancelled); `SessionManager` (SOLE runtime-session writer, gate 13; per-branch serialization not global lock, gate 11; fork branches adopt eagerly-bound session instead of double-seeding, B2/gate 1; interrupt targets only that branch); `ForkOrchestrator.createFork` (eager freeze, gate 1: native head fork when head+materialized, else immutable-snapshot reconstruction wrapped in `TRANSCRIPT_ACK`, gate 2 R1); `reconcileOnBoot` (+ B3: orphan running/queued/needs_attention agent_runs cancelled so Agent Monitor never shows permanently-busy cards, gate 15). Tests added: `frozen-fork` / `reconstruction-side-effects` / `turn-result-truth` / `interrupt` / `attention` / `concurrency` / `restart` / `attribution-honesty` (+ migrated 3 branch-runner tests to the explicit lifecycle).
- **S5 Fastify server + routes + WS (gates 5/6/7/8/11/12/13/14/15)**: `buildApp` (Fastify factory, injectable, no listen side-effect); routes `projects` (list/create/get), `branches` (list / root+fork POST 201 with eager freeze / get / PATCH rename / archive / `POST messages` → 202 `{nodeId}` / `POST interrupt` / `GET ancestry`), `conversation` (`GET` → `EffectiveConversationItem[]` bare array, gate 3), `nodes` (list/get), `events` (branch + project cursor `?after=` → `{events, latestSeqRel}`, gate 8), `agent-runs` (list / get / execution-tree), `runtime` (capabilities with honest mode / sessions live view / reconcile), `attention` (list / respond, gate 7); `ws.ts` — `/ws/projects/:id/events` with **flat** redacted frames (`{eventId,seqRel,type,status,projectId,branchId,nodeId,agentRunId,runtimeSessionId,occurredAt,payload}`) + hello/gap-fill on durable seqRel + origin gate (same-origin or dev allowlist, else 403-close) (gate 8/12); `server.ts` serves the built SPA via `@fastify/static` with SPA fallback that never shadows `/api/*`/`/ws/*`; `index.ts main()` binds `127.0.0.1` ONLY (gate 12), boot-runs reconcile (gate 15), seeds attention from a bus subscription (gate 7); `FakeRuntime` (`CBW_FAKE_RUNTIME=1`) with optional `CBW_FAKE_SCRIPT` for hermetic E2E (gate 10).
- **S6 web UI (Vite+React+zustand, gates 3/7/8/9/11/14)**: three-pane `App` (ConversationTree / ChatPane / AgentMonitor) + Timeline; bootstrap auto-creates project + root Main; per-branch busy (composer disabled while the branch has a pending node, gate 11); attention cards normalized `AttentionCardWire`→`AttentionCard` and rendered pinned in Timeline with allow/deny → `POST /api/attention/:id/respond` (gate 7, fake-seeded); WS `WsStream` with `seqRel` reconciliation + reconnect REST catch-up (gate 8); timeline filters (all/errors/permission/tools); **settle-on-`session.stopped` refresh** (`App.tsx` — the runtime ends a turn with a `session.stopped` frame but `completeTurn` persists the assistant text AFTER that frame, so a ~300 ms settle + guarded refetch converges the UI on the final conversation/nodes/attention); Shared-only header (`Worktree = Phase 6`) + mode-tag `S` (gate 14); `tsc` strict + vite build clean.
- **S7 Playwright E2E (gate 10, PASS)**: `apps/web/playwright.config.ts` — `channel:"chrome"` (system Chrome), headless, baseURL `http://127.0.0.1:15723`, `webServer` boots control-plane with `CBW_FAKE_RUNTIME=1` + `CBW_FAKE_SCRIPT`, temp `CBW_DB`. `e2e/ph4-flow.spec.ts` golden path PASS: boot auto-project → Main, multi-turn chat echo, g8 live timeline + monotonic seq, Agent Monitor completed runs, g1 fork Main→Child (inherited/local badges, parent leak ABSENT via `never tell child this secret`), g14 mode-tag S + Shared-only, g7 attention card seeded from scripted `attention` event + Allow → "Answered: allow". (Temporary `diag.spec.ts` debug artifact removed.)
- **S8 docs + review map (cross-checked against real code)**: `docs/10_CONTROL_PLANE_API.md` REWRITTEN to the actual S5 wire contract (flat top-level returns, WS flat frames, conversation bare array, events `latestSeqRel`, attention `AttentionCardWire`, per-endpoint status tags, §12 UX-settle note); `docs/03` appended §8 gate-2 invariant + R1 `TRANSCRIPT_ACK` frame + §9 per-session interrupt; `docs/04` appended §8 gate-9 attribution-honesty (tool events render branch/turn only); `docs/05` appended Phase-4 data-model + UI-gates (g9/g14/g11/g6/g7/g8); `docs/02 §4` fixed the `createBranchFromNode` signature drift (now the real `NewBranchInput`); created `PHASE4_REVIEW_MAP.md` (one-line per hard gate + evidence). This session uncovered that prior changelog/state claimed "S8 done" but the docs were never actually written in this worktree — now genuinely written and code-verified.
- **Independent review FAIL→PASS → gate (2026-09-17, record `docs/generated/PHASE4_REVIEW.md`)**: reviewer (fresh-context subagent) FAILed on three findings, all fixed & re-verified → APPROVE 15/15, Phase 4 Gate PASS.
  - **BLOCKER (gate 2)**: `TRANSCRIPT_ACK` reconstruction seed was **dead code** — `seedPrompt` built in `fork-orchestrator.ts` was discarded; the real adapter re-joined raw `visibleMessages[].content` with no ack framing, so the gate-2 read-only guarantee rested on a constant, not the actual CLI seed. Fix: `ForkInput.seedText` (`packages/runtime/src/adapter.ts`) → orchestrator passes the ack-wrapped seed at `fork-orchestrator.ts:128` → `claude-cli-adapter.ts reconstructBranchFromHistory` seeds from `input.seedText` (fallback: raw join); `reconstruction-side-effects.test.mjs` now asserts the adapter RECEIVED a seedText with full prior transcript + ack frame.
  - **MAJOR (gate 1)**: native-fork identity monotonicity was untested hermetically (distinct child external id only proven by CBW_LIVE). Fix: fork-aware fake `claude` (distinct external id on `--fork-session`) + hermetic test asserting distinct child id and independent runtime + structural `--fork-session`/fresh `--session-id` test (`packages/runtime/test/cli-adapter-unit.test.mjs`).
  - **MAJOR (gate 11)**: `POST /messages` had no per-branch busy guard (only archive 409'd), so a concurrent message could open a second turn. Fix: `SessionManager.hasActiveTurn` (turn NODE in flight, `state.nodeId` set — NOT a mere bound session, so an eagerly-adopted idle fork child isn't falsely 409'd) → `routes/branches.ts` 409 pre-`openTurn`; `runTurnAsync` `markNode` on start + `release` on end. `busy-guard.test.mjs` proves busy-409/no-2nd-node, unrelated-branch-202 (non-global-lock), adopted-idle-child-202.
  - Re-verified: control-plane 29 pass + 1 live-skip, domain 32/32, event-protocol 13/13, runtime 9 pass + 2 live-skip, Playwright E2E golden path PASS. Non-blocking → recorded: guard→openTurn→markNode TOCTOU under true concurrency (single-user acceptable), real-CLI native-fork/reconstruction automation remains CBW_LIVE opt-in (structural+fake hermetic coverage in default suite).
- **Second-pass review → 3 MAJORs fixed & re-approved (2026-09-18, same record `docs/generated/PHASE4_REVIEW.md`)**: four fresh reviewers re-audited; the former TOCTOU "non-blocking" observation was promoted to MAJOR and closed.
  - **MAJOR (verify — gate 13)**: restart-resume was **dead code** — the adapter's in-memory `sessions` Map is wiped on control-plane restart, `SessionManager.resumeSession` never registered a session into the live adapter (`findBound` no-op), so a post-restart turn could hit `unknown session`. Fix: SessionManager threads the domain DB into the real adapter via the duck-typed `RuntimePersistence` hook (`new ClaudeCliAdapter(undefined, undefined, svc)` in `index.ts`); `resolveSession` branch (a) re-registers the bound external session via `adapter.resumeSession(bound.externalSessionId, cwd)` with the persisted `runtime_sessions.id` staying the authoritative sessionKey; the runtime/domain `RuntimeSession` type collision was aliased (`RuntimeSessionRow`). Build red → green.
  - **MAJOR (concurrency — gate 11)**: TOCTOU in the busy guard closed with a **synchronous in-process claim** — `SessionManager.claimTurn(branchId, nodeId)` runs in the request handler with no `await` between 409-check/`openTurn`/claim; `hasActiveTurn` also sees a pending claim; `pendingClaim` (kept OUT of `state` so resolveSession never mistakes it for a materialized session) is drained into `st.nodeId` by `resolveSession` and cleared by `release`. New claimTurn-TOCTOU regression test.
  - **MAJOR (security — gate 4 redaction)**: secret-shaped **prefix/substring leak** — the old `looksSecretValue` needed `(?:=|\s|["'`(])` right before `sk-…`, so fragments bounded by `?`, `/`, or an alphanumeric prefix could persist/stream. Fix: whole-string boundary-class match `/(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/` — any secret-shaped run anywhere in a string redacts the ENTIRE string; benign `notification`/`mask-…`/`task-id-…`/`export NOT_A_KEY=k` unchanged. Regression test added.
  - Re-verified: chain build green; control-plane 30 pass + 1 live-skip, domain 32/32, event-protocol 14/14, runtime 9 pass + 2 live-skip, Playwright E2E golden path PASS. Remaining observation (accepted): real-CLI native-fork/reconstruction automation stays CBW_LIVE opt-in by design.

## Phase 3 — Events & Execution Tree (2026-09-17)

- Built `packages/event-protocol` (@cbw/event-protocol): canonical event envelope + types (`CanonicalEvent`, `CanonicalType`, event status, AgentRunFrame, ExecutionRoot), `buildRedactedPayload` (per-type allowlist + deep `scrub()`), in-process `EventBus` (global + per-branch subscribe with 2000-event replay), `TurnObserver` mapping runtime events → canonical events attributed to branch/turn/agent-run.
- Adapter (runtime) runs `--include-hook-events`; `parseEvent` maps the full `system:task_*` surface (task_id/tool_use_id/subagent_type/description/status/summary — live-probed). thinking_tokens excluded upstream (hidden chain-of-thought never reaches UI/persistence).
- Domain: `events` table + `recordEvent` (redacted payload only, FK to branch/node/session/agent-run); `agent_runs` table (SCHEMA_VERSION 2: `type`/`display_label`/`name`/`status`/`ended_at` + indexes) + `openAgentRun`/`completeAgentRun`/`getAgentRun`/`listAgentRunsByBranch`/`listAgentRunsByNode`; `getExecutionTree` builds the transient per-turn execution tree rooted at the anonymous main run, children via `parentAgentRunId`.
- Control plane `startBranch`/`runTurn`: production wiring — persists `runtime_sessions` mapping before any turn (FK-resolvable session key), materializes owning agent runs lazily (parents on demand), records redacted events, completes runs at terminal events, closes main at `session.stopped`.
- Redaction defense-in-depth: per-tool input allowlist + deep scrub; secrets scrubbed anywhere in Bash commands / assistant text / agent summaries; env assignment of a secret-shaped value redacted; benign `export NOT_A_KEY=…` and ordinary commands preserved.
- Demo `apps/control-plane/scripts/runtime-demo.mjs` runs a real branch turn (Glob + Explore subagent) through the production pipeline and prints the persisted-event digest + execution tree.
- Hermetic suite 33/33 green (incl. redaction-in-Bash, task-first FK, main-completion regressions); live gates (opt-in `CBW_LIVE=1`): demo PASS — 9 canonical events all attributed `node=y run=y`, execution tree `main:Main [completed] → subagent:Explore [completed]`, registry stays 1.
- Live-discovery: 300s default turn timeout could fire mid-turn under parallel gateway load; raised to 600s + separate 120s start-turn timeout, threaded through `runTurn`/`spawnOnce`.
- Independent review FAIL→PASS (records in `docs/generated/PHASE3_REVIEW.md`): secret-in-Bash leak (BLOCKER), task-first FK crash (BLOCKER), main-never-completes (MAJOR), unredacted text/summary (MAJOR), `SELECT *` aliasing (MINOR) — all fixed with regression tests.
- Phase 3 Gate PASS.

## Blueprint v0.2 — 2026-09-17

- Added executable project entrypoint.
- Added CLAUDE.md project constitution.
- Added AGENTS.md development-agent protocol.
- Added FIRST_PROMPT.
- Added phase task/gate files.
- Added self-review.
- Added runtime capability verification phase.
- Added data model/API/test strategy.
- Added ADRs.
- Added Claude skills.
- Explicitly separated Conversation Tree and Execution Tree.
- Explicitly treated arbitrary historical-node fork as a Phase 0 capability spike.

## Phase 2 — Runtime Integration (2026-09-17)

- Built `packages/runtime` (@cbw/runtime): `RuntimeAdapter` interface + `ClaudeCliAdapter` (async `child_process.spawn`, shell:false, closed stdin, print-mode `--verbose --output-format stream-json`).
- Identity pinning: `--session-id <uuid>` makes the CLI external id equal the control-plane UUID (live-verified: `system:init` session_id === passed UUID). Malformed UUID rejected by CLI (`Invalid session ID`).
- Live semantics nailed down: no-prompt resume/fork emits no init (must carry a prompt); `--resume` reports the ORIGINAL external id (identity stable); `resumeSession` is registration-only, `--resume` round-trips lazily on first sendMessage.
- Native fork-from-head via `--resume --fork-session --session-id <new>`; historical fork via reconstruction (ADR-006) seeded ONLY from pre-fork visible messages (no fabricated instructions).
- Per-branch `.cbw/` settings: auto-memory isolated/disabled, defaultMode acceptEdits. Gateway env: 15721→15722 drift correction + `CBW_BASE_URL`/`CBW_AUTH_TOKEN` override.
- Honest CAPABILITIES: persistentSessions/resume/forkFromHead/nativeSubagents/eventStream true; rewindConversation/lifecycleHooks/interactivePermissions false (unit-tested).
- Tests: hermetic fake-claude units (2) + TWO live gates (opt-in `CBW_LIVE=1`): restart fidelity 9-step demo (219s PASS) and historical-fork no-leak (283s PASS). thinking_tokens excluded from all surface/persistence.
- Full hermetic suite: 13/13 domain + 5/5 runtime green (unit + persistence + timeout); live tests skip without `CBW_LIVE=1`.
- Independent review FAIL→fixes: persisted the external-id mapping into domain `runtime_sessions` via a duck-typed RuntimePersistence hook (no second SQLite file — domain is the single fact source); `resumeSession` reads back the original control-plane UUID on restart (DB-backed restart test PASS); rewrote `parseEvent` so `tool_use`/`tool_result` come from nested `message.content[]` (real stream-json shape), `system:task_*` carries status, and unrelated events are dropped instead of mislabeled as tasks; added a spawn timeout so a dead/hung gateway surfaces an error instead of an infinite hang.
- Phase 2 Gate PASS (live: restart fidelity 9-step + historical reconstruction no-leak). Record in `docs/generated/PHASE2_REVIEW.md`.

## Phase 1 — Domain & Persistence (2026-09-17)

- Built `packages/domain` (@cbw/domain): versioned SQLite migrations (v1), Repository (aliased camelCase reads), DomainService, debug CLI (`src/cli.ts`).
- Implemented required commands: createRootConversation, appendCompletedTurn, createBranchFromNode, renameBranch, archiveBranch, getBranchAncestry, getConversationTree.
- Persisted reconstruction contract per ADR-006: `branch_context_snapshots` (ancestorNodeIds + visibleMessages), seeded on fork.
- Enforced invariants: fork points require completed nodes; cross-project parent rejected; archived branches reject append/fork; fork-head non-mutation; duplicate display names allowed; `messages.seq` monotonic per branch.
- 13/13 tests green (nested branch, duplicate labels, ancestry, restart recovery, cross-project parent, fork-point validity, atomicity, completedAt semantics).
- Independent review FAIL→PASS: fixed non-atomic append (BLOCKER), pending/failed fork + fabricated projectInstructions (MAJOR), restart-digest coverage + message ordering (MINOR); record in `docs/generated/PHASE1_REVIEW.md`.
- Phase 1 Gate PASS.

## Phase 0 — Capability Spike & Architecture Gate (2026-09-17)

- Verified Claude CLI v2.1.226 on Win11/Git Bash; documented auth model (desktop gateway 127.0.0.1:15722 + settings env token).
- Verified: session start/resume across processes; custom session UUID; native fork-from-head; branch-of-branch; original-preserved-after-fork; event surface (init, hooks, tool_use/tool_result, task_*, SubagentStart/Stop); worktree; interrupt/reconnect.
- Verified arbitrary historical-node fork: **no native path** → reconstruction strategy; automated no-leak probe added (`scripts/fork-fidelity-probe.mjs`) and passing.
- Added `scripts/interrupt-probe.mjs`, `scripts/event-shape-probe.mjs` — persisted automated regression seeds.
- Finalized ADR-006 (historical fork strategy) and ADR-007 (implementation stack).
- Wrote `docs/generated/ENVIRONMENT_REPORT.md`, updated `docs/generated/RUNTIME_CAPABILITY_MATRIX.md`.
- Independent architecture review (FAIL→fixed): corrected contaminated no-leak proof (auto-memory disk leak), documented hook-wrapper empty-payload limitation, surfaced bypassPermissions tension + gateway port coupling as open items.
- Phase 0 Gate PASS; started Phase 1 backlog.
