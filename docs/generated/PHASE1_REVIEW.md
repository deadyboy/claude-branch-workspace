# Phase 1 Independent Review — Record

Reviewer: independent subagent (fresh context, not the implementer), 2026-09-17.
Method: read `tasks/PHASE_1_DOMAIN_AND_PERSISTENCE.md`, `docs/09_DATA_MODEL.md`, CLAUDE.md constitution, ADR-006/007; read all `packages/domain/src` + `test` files; re-ran `pnpm build && pnpm test` (10/10 green at review time); empirically confirmed top findings with disposable probes against compiled `dist`.

## Initial verdict

STATUS: FAIL (before fixes). One BLOCKER (non-atomic append), two MAJOR (pending/failed fork allowed; fabricated snapshot projectInstructions), three MINOR, five NIT. All legitimate; all addressed.

## Findings (all addressed 2026-09-17)

### Resolved — BLOCKER

1. **`appendCompletedTurn` not atomic** — messages inserted, then node, then message-node backpatch, with no transaction. A failing node insert (UNIQUE collision, or a second writer sharing the DB file) left a committed orphan message with real content. **Fix:** whole sequence wrapped in `repo.transaction()`; `seq` column added to `messages` (UNIQUE per branch) so backpatch order is deterministic within a committed turn. Regression test added: `appendCompletedTurn is atomic: a failing node insert rolls back orphan messages`.

### Resolved — MAJOR

2. **Fork from pending/failed node allowed** — only existence/project/branch-open were checked; `forkNode.status` never validated, so a not-yet-final pending turn could become a fork point (violates constitution P0 "已持久化 history node" and ADR-006's "exclude content generated after fork point"). **Fix:** `createBranchFromNode` now requires `forkNode.status === "completed"`; `completedAt` set only for completed nodes (failed/pending leave it null). Regression tests: `cannot fork from pending or failed node`, `failed nodes have no completedAt`.
3. **Snapshot `projectInstructions` fabricated from `project.rootPath`** — a filesystem path was fed as "instructions" to reconstruction seeding (ADR-006). **Fix:** no instruction store exists yet; `projectInstructions` is now `null` (seeding uses `visibleMessages` only). Never fabricate a path or token as instructions.

### Resolved — MINOR

4. **Restart digest was weaker than claimed** — `projectDigest` covered projects/branches/nodes/messages only, so a lost/corrupt snapshot would pass reopen. **Fix:** digest now includes full snapshot content (forkFromNodeId, ancestorNodeIds, visibleMessages) + linkage; restart test re-ran green, confirming snapshots survive reopen.
5. **`listMessagesByBranch` ordered by `created_at` only** — all rows of a turn share one timestamp, so cross-turn order was nondeterministic. **Fix:** ordered by new monotonic `seq`.

### NITs (accepted / noted)

6. `idx_nodes_branch` redundant with `UNIQUE(branch_id, local_turn_index)` — left in place as an index for node-lookup-by-branch; harmless.
7. `getConversationTree` orphan guard overwrites `root` on last orphan — acceptable for debug CLI; noted.
8. `branch_context_snapshots.fork_from_node_id`/ancestor ids lack FK — valid only on read; intentional to allow forward references before node rows exist.
9. `getBranch(forkNode.branchId)` cast — hardened with an explicit not-found check in `createBranchFromNode`.
10. `message.node_id` ↔ node refs bidirectional with no consistency check — accepted by design; domain services own both sides in one transaction.

### Security note (tracked)

11. Secret-leak surface is clean today (`payload_json_redacted` default `'{}'`, `metadata_json` empty in Phase 1). Noted as a resolvable policy when events/runtime_sessions land in Phase 2/3 — must never populate `metadata_json` with credentials.

## Explicitly verified fine (not defects)

- FK cycle (`branches→conversation_nodes` / `conversation_nodes→branches`) is legal in SQLite with `foreign_keys=ON`; no `ON DELETE CASCADE`, so no cycle hazard.
- Forked branch restarts `local_turn_index` at 0 — correct per "unique within branch"; enforced by UNIQUE constraint.
- Multiple roots per project — constitutional ("one or more"); not enforced by constraint (correct).
- `branch_context_snapshots` table — justified as ADR-006's reconstruction contract, not scope creep.
- Column aliasing in repository — every `SELECT` uses explicit `col AS camel`; no regressions.

## Final verdict

STATUS: PASS — Phase 1 gate met after fixes. 13/13 tests green (nested branch, duplicate labels, ancestry, restart, cross-project parent, fork-point validity, fork-head non-mutation, archived-branch fork, pending/failed fork rejection, completedAt semantics, atomicity). No blockers remain.
