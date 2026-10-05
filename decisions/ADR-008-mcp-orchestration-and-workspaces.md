# ADR-008: One control plane, stdio MCP, bounded execution and workspace ownership

Status: accepted for Phase 5/6 implementation, 2026-09-18.

## Context and choice

Independent MCP processes cannot share an in-memory SessionManager by importing
its class. Compared with embedding another database/runtime owner, a stdio MCP
client of the existing loopback HTTP server preserves one authoritative owner.
Choose `apps/mcp-server` with official MCP SDK and HTTP to the control plane.
MCP returns IDs, bounded summaries and explicit terminal results, not event dumps.
Native subagents remain transient; application branches remain persistent.

## Execution policy

Default pool is five concurrent turns, configurable globally and per project.
Branches may overlap in shared mode, with a visible conflict warning; serialize
only per branch. A filesystem-wide shared lock would deadlock a Main turn waiting
on its own child through MCP. Worktrees are the recommended write isolation.
Busy branches retain their claim while
queued. Queue cancellation does not start a runtime. Shutdown stops admission,
cancels the queue, interrupts active work and drains before closing SQLite.
Eager fork bootstrap consumes the same pool. Because its RPC is synchronous,
full capacity returns HTTP 409 immediately instead of queueing behind a parent
that may be waiting for that fork. Main agents must leave room for children and
yield after dispatching queued work; saturating the pool with waiting parents
cannot provide progress. No automatic role reservation is implied.

Fork children are reserved before asynchronous workspace/bootstrap work and
cannot accept turns or archive while seeding. An unbound child left by a crash
must never fall back to a blank root session. Shutdown interruption runs in
Fastify preClose, before waiting for synchronous fork requests to finish.

Worktree forks use a clean source repository's current HEAD, independently of
conversation history. They do NOT promise historical filesystem snapshots.
Dirty source workspaces are rejected rather than silently omitting edits.
Archiving preserves files. Explicit cleanup is restricted to archived owned
worktrees with no changes and no commits unreachable from named branches.
Automatic merge is deferred; ordinary Git review and merge preserve user control.

## Model routing during development

GPT-5.6-Luna max handles bounded implementation/tests. GPT-6 Astra handles
architecture, runtime/concurrency faults and independent phase review. Workers
receive narrow context and exclusive file ownership; high reasoning does not
replace actual tests. Development model routing is not a product restriction.

## Acceptance

Native Windows builds/tests and real production-path runtime smoke are required.
Synthetic 5/10/20/40 workloads measure the scheduler separately from real gateway
capacity. Reports must distinguish these; synthetic passes never prove real
40-worker capacity. Live main/child result, cancellation and restart are required
for the runtime gate. Every completed phase gets independent review.
