# PROJECT STATE

> Claude Code 必须持续更新此文件。它是跨 session/compaction 的简洁事实源。

## Current Phase

Phase 3 — COMPLETE (gate PASS live + independent review FAIL→PASS; committed after review-fix cycle)

## Current Objective

Phase 4: UI — conversation tree, current-branch chat, fork-from-turn action, branch breadcrumb/rename, agent monitor, event timeline, permission/attention state, restart/reconnect UX (backlog P4, deferred batching policy lands here).

## Verified Facts (all locally verified 2026-09-17, Claude Code v2.1.226, Win11/Git Bash)

- Child `claude -p` processes authenticate via desktop gateway `ANTHROPIC_BASE_URL=http://127.0.0.1:15722` + `ANTHROPIC_AUTH_TOKEN` from `~/.claude/settings.json` env. (settings' own 15721 is dead; the ACTIVE per-process gateway is 15722.)
- Node async `child_process.spawn` with closed stdin drives real sessions; `spawnSync` hangs. SIGTERM interrupts in ~110ms.
- Session lifecycle: self-chosen `--session-id <uuid>` (VALIDATION: must be a true UUID, 12-hex last group; malformed → `Error: Invalid session ID. Must be a valid UUID.`, exit 1); `--resume <id>` continues in a NEW process across restarts.
- `--session-id <valid-uuid>` pins the CLI's external session id to the control-plane UUID: the `system:init` session_id equals the passed UUID (live-probed). So `externalSessionId === control-plane uuid` is now REAL, not a convention.
- `--session-id` over an ALREADY-MATERIALIZED UUID is rejected: `Error: Session ID <uuid> is already in use.` (live-probed 2026-09-17). So a control-plane `startSession` must generate a FRESH UUID per new branch/runtime session; restart recovery resumes `--resume <existing-ext>` (never re-`startSession`). Live tests use `randomUUID()` per run for exactly this reason.
- IMPORTANT live semantics: a no-prompt `--resume`/`--fork-session` emits no init (CLI asks for a prompt); `--resume` does NOT change the underlying external id — the init reports the ORIGINAL resumed id, so identity is stable. `resumeSession(externalId,cwd)` is registration-only; the actual round-trip happens on first sendMessage.
- Fork-from-head: native `--resume <id> --fork-session --session-id <new-uuid>` copies full prefix; original preserved; branch-of-branch works (grandchild inherits chain, earlier branches unaffected).
- Fork-from-arbitrary-turn has **no native CLI** → strategy = reconstruction (ADR-006). Automated no-leak proof PASSES with per-branch isolated cwd + auto-memory disabled: child knows turn≤N only, root unmutated, no cross-branch future memory.
- Event surface: `--print --verbose --include-hook-events --output-format=stream-json` → `system:init`(session_id) + PreToolUse/PostToolUse + SubagentStart/Stop + task_* + assistant tool_use + user tool_result + background_tasks_changed + thinking_tokens(ephemeral, excluded). Hook wrappers carry empty payloads; real tool detail comes from tool_use/tool_result records.
- Worktree: `--worktree` creates real isolated git worktree; shared = plain cwd.
- Phase 3 live-discovery (2026-09-17): persisting canonical events against a REAL gateway exposes an FK constraint that hermetic fakes hide — `insertEvent` rejects `runtime_session_id`/`agent_run_id` values that aren't rows. Root cause: the demo was re-implementing the pipeline instead of calling the production `startBranch`/`runTurn` (which resolve `runtime_sessions.id` and materialize agent runs first). Fixed by routing the demo + live test through the production path. Lesson: live gate must exercise the exact production wiring, not a hand-rolled twin.
- Live turn latency hazard (2026-09-17): a demo turn spawns `startSession` warm-up + `sendMessage` resume run; BOTH capped by `turnTimeoutMs`, so under parallel load (main session + reviewer subagent sharing the gateway) a 300s default could time out mid-turn. Fix: raised `turnTimeoutMs` default to 600s, added a separate `startTurnTimeoutMs` (120s warm-up), threaded `timeoutMs` through `runTurn`/`spawnOnce`. Hermetic timeout test updated to inject both.

## Open Blockers

- 任意历史节点 fork：无原生 CLI 路径，用 reconstruction（ADR-006）已测试通过。非 blocker。
- Gateway port 耦合/漂移：控制平面必须运行时发现活端口（15722）而非信任 settings (15721)。设计中。
- bypassPermissions 与宪法矛盾：运行时 print-mode 默认 bypass；需在 Phase 2/3 明确默认权限 profile（倾向 auto/acceptEdits），且注意 v0 中 permission 交互仅 interactive 可用。

## Decisions

- ADR-001..005 accepted (Control Plane / two-tree / identifiers-not-names / workspace modes / local-first adapters)
- ADR-006 accepted: forkFromHead=native, forkFromNode=reconstruction (no fake ancestry; origin_strategy=replay_reconstruction)
- ADR-007 accepted: TS/Node + Fastify + SQLite(better-sqlite3) + pnpm + React/Vite; child_process.spawn print-mode primary; WSL secondary.
- Phase 1 implementation notes: `@cbw/domain` package with versioned SQLite migrations; `messages.seq` monotonic per branch for deterministic ordering; fork points require completed node status; snapshots seed reconstruction from visibleMessages only (no fabricated instructions).

## Last Completed Gate

Phase 3 Gate — PASS (live, real gateway; committed after independent review FAIL→PASS):
- Live demo: one branch turn using Glob tool + one Explore subagent, observed end-to-end through `startBranch`/`runTurn` → observer → EventBus + domain DB. Execution tree rooted at completed `main:Main` with completed `subagent:Explore`; persisted event digest all attributed `node=y run=y`; registry stays at 1 (AgentRuns transient, never branches).
- Reviewer FAIL→PASS: BLOCKERs fixed — (1) secret key inside a Bash command leaked verbatim (allowlist + whole-string-only scrub); now scrubbed anywhere in a string / summary / text; (2) FK crash when the first event was `task_started` (parent main not materialized) — persist hook now lazily creates the parent main. MAJORs fixed — main run now completes at `session.stopped`; assistant text + agent summary routed through `scrub()`. MINOR fixed — `getRuntimeSession` SELECT * → explicit `col AS camel`.
- Hermetic: 33/33 green (incl. new regression tests for redaction-in-Bash, task-first FK, main completion); 3 live tests skip without `CBW_LIVE=1`.
- Live-discovery: 300s turn timeout under parallel gateway load (this session + reviewer) could fire mid-turn; raised `turnTimeoutMs` default to 600s + separate `startTurnTimeoutMs` (120s warm-up), threaded through `runTurn`/`spawnOnce`.
- Record: `docs/generated/PHASE3_REVIEW.md`.

## Next Actions

1. Phase 4: UI — conversation tree, current-branch chat, fork-from-turn, branch breadcrumb/rename, agent monitor, event timeline, permission/attention, restart/reconnect UX (backlog P4; deferred batching/flush policy lands here).
2. Interrupt/reconnect with long-lived process management (deferred, Phase 5/6 with the MCP control surface).
