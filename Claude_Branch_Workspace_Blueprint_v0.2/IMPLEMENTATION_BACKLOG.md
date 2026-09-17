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

- [x] RuntimeAdapter interface (drafted in docs/03; implement)
- [ ] ClaudeCliAdapter
- [ ] session start/resume/send
- [ ] fork-from-head
- [ ] fork-from-node (reconstruction strategy, ADR-006)
- [ ] interrupt/terminate
- [ ] reconnect/recovery
- [ ] capability reporting

### Phase-0-recommended P2 tests
- [ ] Interrupt/reconnect automated test (SIGTERM mid-turn → process ends, session id resumable, event stream reconciled) — seed: `scripts/interrupt-probe.mjs`
- [ ] Execution-tree attribution test (map wrapper hook events + tool-use ids + task_* to owner branch/turn; transient AgentRuns never become branches)

## P3 — Events + Agents

- [ ] Hook receiver (stream-json `--include-hook-events` from child)
- [ ] event normalization
- [ ] event persistence
- [ ] transient AgentRun model
- [ ] execution tree
- [ ] event redaction
- [ ] backpressure/batching
- [ ] out-of-order event tests

## P4 — UI

- [ ] Conversation Tree
- [ ] current branch chat
- [ ] fork-from-turn action
- [ ] branch breadcrumb
- [ ] branch rename
- [ ] duplicate-name UI
- [ ] Agent monitor
- [ ] event timeline
- [ ] permission/attention state
- [ ] restart/reconnect UX

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
