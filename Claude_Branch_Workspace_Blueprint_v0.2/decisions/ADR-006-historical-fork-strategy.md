# ADR-006 — Historical Fork Strategy

Status: Accepted — Phase 0 verified 2026-09-17

## 2026-10-09 update: native historical transcript fork

New completed turns record Claude's top-level transcript `uuid`, separately
from the API `message.id` used for visible-text deduplication. When that anchor
and a bound native session are available, the control plane uses the pinned
Agent SDK 0.3.295 `forkSession({ upToMessageId })` operation, including for a
current-head node. This is a local transcript copy, with no initialization
model request. The branch records `native_historical_fork`.

The SDK chooses the external child session ID; CBW's session key remains a
separate identity. The child runtime mapping stores scoped old-to-new message
UUID provenance. Original conversation-node UUIDs are never rewritten. A new
turn on a child records that child's native UUID, so subsequent forks use the
child's session and its own boundary. Selecting an inherited UI node continues
to fork from the original node's owning branch.

Native history operations locate transcripts by session UUID across project
directories. The CLI executes in the workspace bound by WorkspaceManager;
that execution directory need not be the transcript's storage directory.
An active parent may append later turns while the SDK copies an already
completed prefix. An invalid/missing boundary fails; it must not silently
become a full-history copy or a reconstruction.

Old nodes without native UUIDs retain the strategies documented below. No
backfill guesses UUIDs from text. Ordinary new-session warm-up is unchanged in
this increment; removing it requires durable first-invocation lifecycle work.

The native copy preserves conversation/tool records, but the SDK does **not**
copy file-history/undo snapshots. Worktree creation still starts from the Git
state managed by WorkspaceManager; conversation forking does not rewind files.

The Phase 0 decision below describes the legacy path and its original evidence.

## Requirement

Create a persistent, independent, interactive branch from any saved historical conversation node.

## Phase 0 evidence (Claude Code v2.1.226, print-mode child processes)

- `forkFromHead` is native: `claude -p --resume <id> --fork-session --session-id <new>` yields a new session whose transcript contains the full source history; the original session is unchanged.
- `forkFromNode` (turn N < head M) has **no native CLI**: native fork always copies the entire source history up to head, which would leak turns N+1..M.
- If we forkFromHead then truncate to turn N, we still cannot prevent the child from having received turns N+1..M during creation via a clean non-interactive path.
- Reconstruction is verified: a fresh session whose first prompt seeds the visible conversation prefix (up to node N) knows N but not N+1..M.

## Decision

Use a **hybrid**: implement exactly two production strategies (as the adapter interface already distinguishes):

1. `forkFromHead(sessionId)` — **native** `--fork-session`. Used when the fork point is the current head node. High fidelity, native ancestry copied.
2. `forkFromNode(nodeId)` — **reconstruction**:
   - Build a `BranchContextSnapshot` from the persisted Conversation Tree (ancestor node ids, visible messages up to the fork point, project instructions, workspace binding).
   - Create a fresh session (`--session-id <our UUID>`).
   - Seed the session with the snapshot prefix (first user turn), then continue normally.
   - Set `origin_strategy = replay_reconstruction`.
   - **Never claim native ancestry**; the UI shows branch origin strategy.

`rewind` (Option 2) is rejected for production: no reliable non-interactive automation found, and it risks mutating the original branch.

## Fidelity controls

- When building the snapshot, **exclude content generated after the fork point**.
- **Disable/isolate auto-memory** in the reconstructed session child (CLI env / settings) to prevent unrelated cross-session memory from leaking into the child (observed: global auto-memory `secret_number=42` leaked into an unrelated seeded child).
- Automated regression: "child must not know fork-point+1..M" (Scenario A in 11_TEST_STRATEGY).

## Consequence

`forkFromNode` is semantically correct (user sees the child rooted at the chosen turn) but marked as reconstruction, not native ancestry. If a future CLI/SDK exposes native node-fork, we add `forkFromNodeNative` and keep the strategy enum unchanged.
