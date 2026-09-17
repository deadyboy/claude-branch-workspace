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

## Phase 0 — Capability Spike & Architecture Gate (2026-09-17)

- Verified Claude CLI v2.1.226 on Win11/Git Bash; documented auth model (desktop gateway 127.0.0.1:15722 + settings env token).
- Verified: session start/resume across processes; custom session UUID; native fork-from-head; branch-of-branch; original-preserved-after-fork; event surface (init, hooks, tool_use/tool_result, task_*, SubagentStart/Stop); worktree; interrupt/reconnect.
- Verified arbitrary historical-node fork: **no native path** → reconstruction strategy; automated no-leak probe added (`scripts/fork-fidelity-probe.mjs`) and passing.
- Added `scripts/interrupt-probe.mjs`, `scripts/event-shape-probe.mjs` — persisted automated regression seeds.
- Finalized ADR-006 (historical fork strategy) and ADR-007 (implementation stack).
- Wrote `docs/generated/ENVIRONMENT_REPORT.md`, updated `docs/generated/RUNTIME_CAPABILITY_MATRIX.md`.
- Independent architecture review (FAIL→fixed): corrected contaminated no-leak proof (auto-memory disk leak), documented hook-wrapper empty-payload limitation, surfaced bypassPermissions tension + gateway port coupling as open items.
- Phase 0 Gate PASS; started Phase 1 backlog.
