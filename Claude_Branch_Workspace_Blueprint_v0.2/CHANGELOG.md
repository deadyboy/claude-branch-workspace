# Changelog

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
