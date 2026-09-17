# PROJECT STATE

> Claude Code 必须持续更新此文件。它是跨 session/compaction 的简洁事实源。

## Current Phase

Phase 0 — COMPLETE (gate passed after independent review + fixes)

## Current Objective

完成 Claude Runtime 能力验证与架构定稿。下一步：Phase 1 (Domain + Persistence)。

## Verified Facts (all locally verified 2026-09-17, Claude Code v2.1.226, Win11/Git Bash)

- Child `claude -p` processes authenticate via desktop gateway `ANTHROPIC_BASE_URL=http://127.0.0.1:15722` + `ANTHROPIC_AUTH_TOKEN` from `~/.claude/settings.json` env. (settings' own 15721 is dead; the ACTIVE per-process gateway is 15722.)
- Node async `child_process.spawn` with closed stdin drives real sessions; `spawnSync` hangs. SIGTERM interrupts in ~110ms.
- Session lifecycle: self-chosen `--session-id`; `--resume <id>` continues in a NEW process across restarts.
- Fork-from-head: native `--resume <id> --fork-session --session-id <new>` copies full prefix; original preserved; branch-of-branch works (grandchild inherits chain, earlier branches unaffected).
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

## Last Completed Gate

Phase 0 Gate — PASS (all checklist items met; reviewer blockers resolved)

## Next Actions

1. Begin Phase 1 (domain models + SQLite + tree invariants), with Phase-0-recommended tests.
2. Implement gateway port discovery + context snapshot builder for reconstruction fork.
3. Run all `scripts/*-probe.mjs` before marking Phase 1 done.
