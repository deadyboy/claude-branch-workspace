# Phase 5/6 integration handoff — 2026-09-18

## Delivery location

Implementation: `F:\claudetreespace-integration`.
Branch: `codex/phase5-6-integration`, based on `d68055b` from the prior Phase 4 branch.
Rescue-committed as `9767e8d` (2026-09-18) after the work was found uncommitted,
then fast-forwarded into main `master` as part of consolidation (no merge, push or
programmatic copy-back separate from the fast-forward).

## Implemented

- Official stdio MCP server with eight bounded tools; HTTP forwards to one
  authoritative control plane. Main dispatches persistent conversation branches,
  sends messages, queries terminal answers, interrupts and archives.
- Shared/worktree binding, explicit Git cleanliness and current-HEAD semantics,
  owned archived-worktree cleanup, visible shared-file conflict warning.
- Bounded global/per-project pool, queued cancellation, same-branch exclusion,
  fork admission, singleton database ownership and shutdown draining.
- Incremental CLI events, correct multi-message assistant persistence, explicit
  failure/terminal semantics, UUID identities, restart resume, startup cancellation.
- UI workspace selection/status, historical-turn fork, branch filtering/paging,
  batched refresh and no-event pending recovery.
- Host/Origin checks, durable event replay beyond 1,000 records, bounded WS backpressure.

## Verification

Phase 5 functional gate: PASS. Independent code-review gate: PASS.
Phase 6 isolation/recovery/UI code is implemented; scale acceptance was PARTIAL
because real 20-way CLI startup was not reliable on this (16 GB) machine; no
40-way real test was attempted after the failed 20-way stage. **Updated
2026-09-27: real 20-way AND 40-way now PASS on the USTC GPU server (2 TB RAM) —
see "Server capacity" below. The FAIL/not-supported conclusions on this machine
are a *host* limit (16 GB laptop), not a code limit.**

Native Windows build and default test suite passed: **127 passed, 0 failed,
3 opt-in live tests skipped**. Separate live scripts exercise the real production
process; these skips are not represented as successful live tests.
Final Playwright run: **2/2 PASS** (golden path and no-event pending recovery,
including virtual time beyond the former 36-second polling cutoff).

First real end-to-end PASS:
`.runtime-experiments/phase5-1789666656308/result.json`.
Real outer-agent MCP PASS is `agent-result.json` in the same directory.
It observed list/create/send/get-turn-result/status tool calls and verified the
child answer in the UI's REST data. Both outer and inner runtimes were real Claude
CLI, with the configured `qwen3.6-chat` model. It does not prove that this Codex
desktop task has installed the project's MCP server.

The initial real run failed because Claude global settings.env overrode the
inherited endpoint, selecting a dead port. A minimal same-model probe confirmed
the cause; the fix pins only the non-secret endpoint in session settings.
The original failed fixture remains `.runtime-experiments/phase5-1789666357871/`.

Final clean-repository runtime recheck: PASS,
`.runtime-experiments/phase5-1789667418635/result.json`.
Unlike the first fixture, this repository does not ignore `.cbw`; inline settings
leave it clean and worktree creation succeeds after real conversation turns.
The real outer-agent MCP flow was repeated against this final fixture and passed;
its `agent-result.json` records the observed tool calls and persisted child answer.

### Real capacity results

Native Windows 11, 16 GB RAM, Claude CLI 2.1.226, existing qwen3.6-chat gateway.
Each worker starts a fresh real session and then answers one short no-tools
prompt. This measures cold-start/simple-turn concurrency, not coding throughput.
The workstation and gateway were shared with other active tasks.

| Actual concurrent slots | Completed | Failed | Batch wall time | Verdict |
|---|---:|---:|---:|---|
| 5 | 5 | 0 | 65.4 s | PASS |
| 10 | 10 | 0 | 98.6 s | PASS |
| 20, diagnostic repeat | 14 | 6 | 134.0 s | FAIL |

Evidence: `.runtime-experiments/capacity-1789667222487/result.json` (5/10 pass,
first 20-way attempt lost HTTP connection) and
`.runtime-experiments/capacity-1789667557794/result.json` (repeat with server logs).
All six failures in the repeat were native runtime exits with code `3221226505`.
The control plane remained responsive and persisted failed outcomes. Free RAM
was observed near 1.25 GB during the run, but this does not establish the native
crash's root cause. No Windows Application Error entry was retrieved in the
scoped check. Do not claim an OOM or gateway failure without further evidence.

Keep the default pool at 5. Ten passed this short workload; twenty is not a
supported operating claim. Forty remains only a synthetic scheduler test.

### Server capacity (2026-09-27) — supersedes the local conclusions above

Rerun on the USTC GPU server (`<server-project-dir>`, 2 TB RAM, Node 22.23 + claude 2.1.278)
via the phase6 harness, with the local Vision Bridge key pool expanded 3 → 5 upstream keys
so the bridge's effective concurrency reached its global ceiling (48 in-flight / 72 RPM):

| Actual concurrent slots | Completed | Failed | Peak concurrent | Batch wall time | Verdict |
|---|---:|---:|---:|---:|---|
| 20 | 20 | 0 | 20 | — | PASS |
| 40 | 40 | 0 | 40 | 69 s | PASS |

Evidence: `.runtime-experiments/capacity-1790444243562/result.json` (20-way) and
`.runtime-experiments/capacity-1790448174742/result.json` (40-way; first 40-way attempt on 3
keys failed 28/40 with warm-up `startTurnTimeoutMs` 120 s timeouts — pool depth, not host
resources). So the earlier "20/40 not supported" / "40 only synthetic" statements are **host-held
limits of the 16 GB laptop**, not limits of the code or the gateway pool. The laptop's default
concurrency stays at 5; the server can operate at 20–40 given pool depth ≥ 5 keys.

## Review closure

Independent GPT-6 Astra review identified fork child admission, interrupted fork
restart, fork capacity/shutdown, workspace settings pollution and UI pending
refresh failures. All were fixed; the reviewer returned PASS with no remaining
blocking code findings. The actual HTTP shutdown regression and restart-orphan
regression passed. Details: `docs/generated/PHASE5_6_REVIEW.md`.

## Operational boundaries

- Default concurrency remains 5 until the operator chooses otherwise. Real
  gateway capacity is distinct from synthetic scheduler 5/10/20/40 stress tests.
- Fork bootstrap returns 409 at full capacity. A main turn must leave capacity
  for children and yield instead of holding every slot while polling children.
- Shared workspaces allow concurrent writes; worktrees isolate files. No automatic
  merge is performed. Conversation history does not imply historical file state.
- Runtime remains Claude CLI. Luna/Astra selection was the development team's
  model routing; it does not silently change the user's Claude runtime model.
- Bootstrap disables tools/MCP/slash commands/hooks and automatic memory. Managed
  Claude policy hooks may override local hook settings; acceptance used this machine.
- Gateway is explicit via `CBW_BASE_URL` with the existing local default. Automatic
  endpoint/token rotation and arbitrary-port discovery remain outside this delivery.
