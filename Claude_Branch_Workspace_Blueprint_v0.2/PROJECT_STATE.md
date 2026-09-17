# PROJECT STATE

> Claude Code 必须持续更新此文件。它是跨 session/compaction 的简洁事实源。

## Current Phase

Phase 2 — GATES PASS (RuntimeAdapter + Claude CLI adapter; head-fork/restart fidelity PASS live; historical-fork reconstruction no-leak PASS live). Pending: independent review + docs + commit.

## Current Objective

Phase 2: real Claude Runtime Adapter, verified live against the desktop gateway (`packages/runtime`). Both required demos pass live. Next: dispatch independent reviewer, update CHANGELOG/backlog, commit Phase 2, then Phase 3 (events + execution tree).

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

Phase 2 Gate — PASS (live, real gateway):
- Restart fidelity: Main real session → 4 turns → fork-from-head → child → Main turn 5 → child independent → grandchild → fresh adapter (simulated restart) resumes all 3 on same external id → Main/Child continue with context (SURVIVED_MAIN / SURVIVED_CHILD) → duplicate-name non-interference. 219s.
- Historical fork (Scenario A): seed child via reconstruction (ADR-006) from turns 1–2 only → child remembers turn 2 (TWO), has NO turn-3 secret (THREE) → no post-fork context leak. 283s.
- Hermetic: 13/13 domain + 2/2 runtime unit green; live tests skip without `CBW_LIVE=1`.

## Next Actions

1. Independent Phase 2 review (per constitution §6) — dispatch reviewer, resolve findings.
2. Update CHANGELOG.md + IMPLEMENTATION_BACKLOG.md (mark ClaudeCliAdapter/session/fork/faithful historical-fork DONE) + commit Phase 2.
3. Phase 3: events + execution tree (hook receiver, event normalization/persistence, transient AgentRun, execution-tree attribution).
