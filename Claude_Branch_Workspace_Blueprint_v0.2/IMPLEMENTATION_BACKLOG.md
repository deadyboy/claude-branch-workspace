# IMPLEMENTATION BACKLOG

状态枚举：TODO / IN_PROGRESS / BLOCKED / DONE / DEFERRED

## P0 — Phase 0 (DONE unless noted)

- [x] Runtime environment probe
- [x] Claude Code version/capability probe
- [x] Verify native branch/resume behavior
- [x] Verify arbitrary historical-turn fork path
- [x] Verify hooks event fidelity
- [x] Verify subagent lifecycle observability
- [x] Verify shared filesystem behavior
- [x] Verify worktree strategy
- [x] Finalize stack ADR

Phase 0 outputs: `docs/generated/ENVIRONMENT_REPORT.md`, `docs/generated/RUNTIME_CAPABILITY_MATRIX.md`,
`decisions/ADR-006`, `decisions/ADR-007`, persisted probes under `scripts/`.

## P1 — Domain + Persistence

- [x] Project model
- [x] Branch model
- [x] Conversation node model
- [x] Runtime session mapping (table + types; wired in later phases)
- [x] SQLite schema/migrations (versioned, idempotent — verified reopen)
- [x] Tree invariants (fork from archived branch rejected; cross-project fork rejected; fork-head non-mutation)
- [x] Duplicate branch-name tests
- [x] Branch-of-branch tests
- [x] Restart recovery tests (close+reopen, full digest identical)
- [x] Debug CLI (`packages/domain/src/cli.ts`: projects/branches/nodes/tree/ancestry/snapshot)

### Phase-0-recommended P1 tests (from independent review)
- [ ] Scenario A: automated fork-fidelity regression (child must not know fork-point+1..M) — seed: `scripts/fork-fidelity-probe.mjs`
- [ ] Auto-memory isolation test (forked/reconstructed child never inherits unrelated project memory)
- [ ] Fork-head non-mutation assertion (source JSONL unchanged after `--fork-session`)
- [ ] Gateway drift/reconnect test (control plane detects port/token rotation; dead gateway → session.failed, not hang)
- [ ] Redaction regression (no ANTHROPIC_AUTH_TOKEN/values in persisted events or error dumps)
- [ ] thinking_tokens exclusion test (no hidden chain-of-thought reaches UI/persistence)

## P2 — Runtime

- [x] RuntimeAdapter interface (interface + types in `packages/runtime/src/{types,adapter}.ts`)
- [x] ClaudeCliAdapter (`packages/runtime/src/claude-cli-adapter.ts`)
- [x] session start/resume/send (startSession pins `--session-id` to control-plane UUID; resume is registration-only + lazy `--resume` on first sendMessage; send actually round-trips)
- [x] fork-from-head (native `--resume --fork-session --session-id <new-uuid>`, live-verified)
- [x] fork-from-node (reconstruction strategy, ADR-006; no-leak live gate PASS)
- [x] interrupt/terminate (interface satisfied; process-level interrupt is Phase 3)
- [x] reconnect/recovery (persisted external-id mapping in domain `runtime_sessions` via duck-typed RuntimePersistence hook; DB-backed restart test recovers the SAME control-plane UUID on a fresh adapter; live gate PASS)
- [x] capability reporting (honest CAPABILITIES + unit-tested)

Phase-2 reviewer fixes (independent review FAIL→PASS): persisted mapping (was in-memory-only) into domain `runtime_sessions`; fixed `parseEvent` to read `tool_use`/`tool_result` from nested `message.content[]` and stop mislabeling unrelated events as `task`; added spawn timeout (dead/hung gateway surfaces error, no infinite hang); added unit coverage for nested tools/task/timeout + DB-backed restart.

Gate demos verified live (2026-09-17, real gateway):
- Restart fidelity full 9-step demo PASS (219s). HISTORICAL fork no-leak PASS (283s).
- Verified `--session-id <valid-uuid>` pins `system:init` session_id = control-plane UUID. No-prompt resume/fork emits no init (must carry a prompt). `resumeSession` registration-only.

### Phase-0-recommended P2 tests
- [ ] Interrupt/reconnect automated test (SIGTERM mid-turn → process ends, session id resumable, event stream reconciled) — seed: `scripts/interrupt-probe.mjs` (deferred to P5/P6 with long-lived process mgmt)
- [x] Execution-tree attribution: production-pipeline live test (`attribution-live.test.mjs`: `CBW_LIVE=1`) — every event attributed to owner branch/turn; subagent materialized as transient AgentRun; AgentRuns never become branches (Phase 3)

## P3 — Events + Agents

- [x] Hook receiver (adapter runs `--include-hook-events`; `parseEvent` maps `system:task_*` with real fields — task_id/tool_use_id/subagent_type/description/status/summary, live-probed 2026-09-17)
- [x] event normalization (`@cbw/event-protocol` `TurnObserver`: runtime events → canonical `CanonicalEvent` envelope, attributed to branch/node/agent-run)
- [x] event persistence (domain `events` table + `recordEvent`; redacted payload only)
- [x] transient AgentRun model (domain `agent_runs` + `openAgentRun`/`completeAgentRun`; execution tree `getExecutionTree`; NEVER promoted to branches)
- [x] execution tree (domain ExecutionTree; control-plane `branch-runner` materializes runs with parent linkage; demo prints it)
- [x] event redaction (`@cbw/event-protocol/redact.ts`: allowlist + deep scrub; unit-tested)
- [x] realtime stream (`@cbw/event-protocol/EventBus`: publish/subscribe + per-branch + replay; unit-tested)
- [x] out-of-order event tests (late tool_result still maps by toolUseId; task_updated ignored)

Deferred to P4 (UI/backpressure): batching/flush policy for high-volume event streams (agent event volume is modest per turn; bus retains 2000-event replay window).

Phase-3 review fixes (independent review FAIL→PASS, record `docs/generated/PHASE3_REVIEW.md`):
- [x] Redaction: secret-shaped values now scrubbed anywhere in string (Bash command / assistant text / agent summary); env assignment of a secret-shaped value redacted
- [x] FK: persist hook lazily materializes the parent main run when a task arrives first
- [x] Main run completes at `session.stopped` (was perpetually `running`)
- [x] `getRuntimeSession` explicit `col AS camel` select (no SELECT *)

## P4 — UI (Phase 4 COMPLETE, Gate PASS — first pass 2026-09-17; second-pass review 2026-09-18 → 3 MAJORs fixed & re-approved)

Phase-4 gates (S1–S3 done; S4 control-plane core + tests done; S5 server done; S6 web done; S7 E2E PASS; S8 docs done; independent review FAIL→PASS → gate; second-pass review re-approved):
- [x] Turn lifecycle explicit (openTurn→complete/fail/cancel; `appendCompletedTurn` thin wrapper) — S1
- [x] Effective-conversation read model (`getEffectiveConversation`) — S1
- [x] Durable project event cursor (`events.seq_rel` + `listEventsSince`) — S1
- [x] Restart reconcile (pending nodes + orphan sessions + orphan agent_runs, B3) — S1/S4
- [x] Bash output surface + observer userMessage/cancel — S2
- [x] SATISFIED: gate 7 attention.required canonical event (summary) — S2
- [x] Real per-session interrupt (gate 6) — S3
- [x] SessionManager (sole runtime-session writer, gate 13; 409 Busy; no double-seed B2) — S4
- [x] runTurnOnce → TurnResult (chat truth, gate 4) — S4
- [x] ForkOrchestrator eager freeze (gate 1/2) — S4
- [x] S4 tests: frozen-fork / recon no-side-effect / turn-result-truth / interrupt isolation / attention / concurrency / restart+B3 / attribution-honesty (+ migrated 3 branch-runner tests) — S4
- [x] Fastify server: routes + WS gap-fill + loopback/origin security + SPA static — S5
  - routes: projects / branches (root+fork, messages 202, interrupt, archive, rename, ancestry) / conversation / nodes / events (branch+project cursor) / agent-runs / runtime (capabilities/sessions/reconcile) / attention (list/respond) / WS
  - gates: 12 (loopback + origin), 11 (per-branch busy), 13 (session-manager sole writer), 15 (reconcile route)
- [x] apps/web three-pane UI (Vite+React+zustand): ConversationTree / ChatPane / AgentMonitor / Timeline / attention cards / socket reconnect — S6
- [x] Playwright E2E golden path PASS (`apps/web/e2e/ph4-flow.spec.ts`, channel:"chrome", CBW_FAKE_RUNTIME=1): boot→multi-turn→fork→no-leak→attention — S7 (g1/g7/g8/g10/g14 asserted)
- [x] Docs: `docs/10` rewritten to real S5 wire contract; `docs/03 §8` gate-2 + TRANSCRIPT_ACK; `docs/04 §8` gate-9 attribution; `docs/05` P4 data-model + UI constraints; `docs/02 §4` signature drift fixed; `PHASE4_REVIEW_MAP.md` created — S8
- [x] **Independent Phase-4 review FAIL→PASS → gate** — reviewer APPROVE 15/15, gate PASS (record `docs/generated/PHASE4_REVIEW.md`; fixes: seedText de-DeadCode for TRANSCRIPT_ACK, hermetic fork-native identity tests, POST /messages busy 409 via `hasActiveTurn`)
- [x] Conversation Tree
- [x] current branch chat
- [x] fork-from-turn action
- [x] branch breadcrumb (ancestry)
- [x] branch rename
- [x] duplicate-name UI (id-suffix disambiguation)
- [x] Agent monitor
- [x] event timeline
- [x] permission/attention state (g7, fake-seeded)
- [x] restart/reconnect UX (socket status dot + REST catch-up + WS gap-fill)

## P5 — Agent Control MCP

- [ ] create_branch_from_node
- [ ] send_message
- [ ] list_branches
- [ ] get_branch_status
- [ ] interrupt_branch
- [ ] archive_branch
- [ ] query_execution_status
- [ ] Main-agent integration test

## P6 — Scale/Isolation

- [ ] Shared workspace mode
- [ ] Isolated worktree mode
- [ ] workspace conflict rules
- [ ] 10 concurrent sessions
- [ ] 20 concurrent sessions
- [ ] target 40 concurrent workers/sessions where environment permits
- [ ] process crash recovery
- [ ] graceful shutdown
- [ ] observability/performance report

## Deferred / open items from Phase 0 review
- [ ] Resolve bypassPermissions tension: constitution forbids default dangerous bypass; runtime is print-mode with default bypassPermissions. Decide & document default permission profile (auto/acceptEdits) and note permission/attention is interactive-only in v0 (MEDIUM, Phase 3 attention).
- [ ] Auto-memory: formalize per-branch isolation mechanism in Phase 2 runtime adapter (isolated cwd + `--settings` autoMemoryMemoryDir verified in Phase 0; wire into session start).
- [ ] Gateway port discovery: control plane must discover live gateway (15722) rather than trust settings (15721). (Blocked only on desktop app internals; implement discovery + drift detection.)
