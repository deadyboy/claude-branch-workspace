# PACKAGE SELF-AUDIT

Audit date: 2026-09-17

## User-request coverage

| Requirement | Covered | Where |
|---|---|---|
| Claude Code remains execution platform | YES | CLAUDE.md, ADR-001 |
| Main conversation with many turns | YES | Product spec, Conversation Tree |
| Fork from a chosen historical turn | YES, with Phase 0 technical spike | CLAUDE.md, Phase 0, ADR-006 |
| Branch can branch again | YES | Acceptance criteria, tests |
| Duplicate fork names do not collide | YES | UUID identity model, ADR-003 |
| Persistent fork is a tool-capable session | YES | Runtime integration phase |
| Main can keep working while branches exist | YES | Runtime/UI acceptance scenarios |
| Main can dynamically create subagents | YES | AGENTS.md, Event/Agent model |
| Roles are not hard-coded | YES | CLAUDE.md, Product spec |
| Main can later create persistent branches itself | YES | Phase 5 agent-control MCP |
| See “little agents” working | YES, cards first, town visualization later | UI spec |
| See observable agent communication | YES when runtime exposes it | Event model/UI spec |
| User can enter any persistent branch and chat | YES | UI acceptance criteria |
| Conversation Tree and transient workers separated | YES | ADR-002, domain model |
| Shared filesystem vs isolated worktree | YES | ADR-004, security, Phase 6 |
| Many concurrent workers | YES as scalable resource pool | Phase 6 |
| Crash/restart recovery | YES | Self review, test strategy, Phase 6 |
| No hidden chain-of-thought display | YES | Event/UI spec |
| Direct Claude Code startup instructions | YES | START_HERE.md, CLAUDE.md, FIRST_PROMPT.txt |
| AGENTS.md included | YES | AGENTS.md |
| Self-review before implementation | YES | docs/07_SELF_REVIEW.md + this audit |

## Critical design audit

### PASS — No fixed 40-agent workflow
Concurrency is modeled as capacity, not static roles.

### PASS — Naming collisions are structurally impossible
Display names are non-unique labels. UUID + ancestry are authoritative.

### PASS — Persistent and transient lifecycles are separated
Conversation Branch != AgentRun.

### PASS — Native Claude capabilities are not over-assumed
Arbitrary historical-node forking is explicitly a Phase 0 capability test with fallback strategies.

### PASS — Filesystem semantics are explicit
Conversation fork does not imply file isolation; shared/worktree are orthogonal modes.

### PASS — Long-running project state survives compaction
CLAUDE.md + PROJECT_STATE.md + ADR + backlog form external persistent state.

### PASS — Runtime implementation is replaceable
UI/domain depend on RuntimeAdapter, not Claude CLI internals.

## Remaining intentional uncertainties

These are not blueprint omissions; they must be resolved on the user's machine during Phase 0:

1. Best reliable method for programmatic arbitrary-turn fork.
2. Best CLI process/PTY control library on the user's Windows/WSL setup.
3. Exact hook/event fidelity of the installed Claude Code version.
4. Maximum practical concurrent live Claude processes under the user's environment.
5. Whether CLI-first, SDK-first, or hybrid is the best runtime implementation.

## Verdict

READY TO HAND TO CLAUDE CODE FOR PHASE 0.

Do not treat this as “the implementation is already complete.” It is a complete execution blueprint whose first job is to validate the actual runtime and then implement the product.
