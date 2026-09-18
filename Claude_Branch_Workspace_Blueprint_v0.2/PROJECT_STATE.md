# PROJECT STATE

## Current integration — 2026-09-18

Branch: `codex/phase5-6-integration`, workspace `F:\claudetreespace-integration`.
Phase 5 MCP is complete, functional/code-review gate PASS. Phase 6 isolation,
scheduler and UI implementation are present; scale gate is PARTIAL (real 10-way
passes, real 20-way has native CLI crashes). Phase 4 below is retained history.
Current results and remaining limits: `PHASE5_6_HANDOFF.md`.

Verified: real outer Claude agent → stdio MCP → production HTTP → real child
Claude session → persisted answer; historical reconstruction, Git worktree,
two independent turns, restart continuity, interruption and archive preservation.
Full build, 127 default tests (3 opt-in live tests skipped), and both Playwright E2E tests passed.
Independent review's startup/fork/shutdown defects were fixed and re-reviewed PASS.
The final clean-repository runtime smoke passed. Keep default concurrency 5;
do not enable 20/40 on the strength of synthetic tests.
The real outer-agent MCP test passed again against the final runtime fixture.

Runtime settings now use inline JSON and do not dirty the user's repository.
The per-session endpoint overrides a stale global settings.env value without
changing global configuration, authentication or the selected model.

The current worktree is the implementation source. No port-back, commit, merge
or push has been performed; the original checkout and its changes are preserved.

## Historical Phase 4 record

> Claude Code 必须持续更新此文件。它是跨 session/compaction 的简洁事实源。

## Current Phase

Phase 4 — COMPLETE, Gate PASS (independent review FAIL→PASS, reviewer APPROVE — `docs/generated/PHASE4_REVIEW.md`). S1–S8 all DONE/GREEN: domain 32/32, event-protocol 13/13, runtime 9+2 live-skip, control-plane 29+1 live-skip, Playwright E2E golden path PASS. Implementation record: `PHASE4_HANDOFF.md`. Next: Phase 5 (MCP control surface).

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

Phase 4 Gate — PASS (independent review FAIL→PASS, reviewer APPROVE, 15/15 hard gates, 2026-09-17):
- Reviewer findings → fixed: BLOCKER — gate 2 `TRANSCRIPT_ACK` reconstruction seed was dead code (`seedPrompt` built but discarded); now genuinely threads through `ForkInput.seedText` → `claude-cli-adapter.ts reconstructBranchFromHistory` (seeded over raw join), asserted in `reconstruction-side-effects.test.mjs` that the adapter RECEIVED the ack-framed seed. MAJOR 1 — gate 1 native-fork identity monotonicity untested hermetically; fixed with a fork-aware fake `claude` + distinct-child-external-id + "both run independently" tests + structural `--fork-session`/fresh `--session-id` arg test. MAJOR 2 — gate 11 `POST /messages` had no busy guard; fixed via `SessionManager.hasActiveTurn` (turn node in flight, NOT a mere bound session) → 409 pre-`openTurn`, `markNode`/`release` in `runTurnAsync`; proven by `busy-guard.test.mjs` (busy 409/no 2nd node; unrelated branch 202; adopted-idle child first message 202).
- Non-blocking observations recorded (not blockers): guard→openTurn→markNode TOCTOU window under true concurrency; native-fork/reconstruction real-CLI automated run remains CBW_LIVE opt-in. **Second-pass review (2026-09-18) promoted the TOCTOU observation to a MAJOR and closed it** — synchronous in-process `SessionManager.claimTurn` (request-handler claim with no `await`, separate `pendingClaim` map drained by `resolveSession`, cleared by `release`; `hasActiveTurn` sees pending claims). Two further second-pass MAJORs fixed + re-verified: restart-resume dead code (gate 13 — adapter now gets the domain DB as a duck-typed `RuntimePersistence` hook via `new ClaudeCliAdapter(undefined, undefined, svc)`, and `resolveSession` branch (a) re-registers the bound external session so its first post-restart `sendMessage` never throws `unknown session`; the persisted `runtime_sessions.id` stays the authoritative sessionKey); secret-shaped prefix/substring leak (gate 4 — whole-string boundary-class redaction `/(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/` redacts the ENTIRE string; benign words unchanged).
- Hermetic (re-verified 2026-09-18): control-plane 30 pass + 1 live-skip, domain 32/32, event-protocol 14/14, runtime 9 pass + 2 live-skip; chain build green; Playwright E2E golden path PASS (system Chrome + CBW_FAKE_RUNTIME).
- Record: `docs/generated/PHASE4_REVIEW.md` (both passes).

Phase 3 Gate — PASS (live, real gateway; committed after independent review FAIL→PASS):
- Live demo: one branch turn using Glob tool + one Explore subagent, observed end-to-end through `startBranch`/`runTurn` → observer → EventBus + domain DB. Execution tree rooted at completed `main:Main` with completed `subagent:Explore`; persisted event digest all attributed `node=y run=y`; registry stays at 1 (AgentRuns transient, never branches).
- Reviewer FAIL→PASS: BLOCKERs fixed — (1) secret key inside a Bash command leaked verbatim (allowlist + whole-string-only scrub); now scrubbed anywhere in a string / summary / text; (2) FK crash when the first event was `task_started` (parent main not materialized) — persist hook now lazily creates the parent main. MAJORs fixed — main run now completes at `session.stopped`; assistant text + agent summary routed through `scrub()`. MINOR fixed — `getRuntimeSession` SELECT * → explicit `col AS camel`.
- Hermetic: 33/33 green (incl. new regression tests for redaction-in-Bash, task-first FK, main completion); 3 live tests skip without `CBW_LIVE=1`.
- Live-discovery: 300s turn timeout under parallel gateway load (this session + reviewer) could fire mid-turn; raised `turnTimeoutMs` default to 600s + separate `startTurnTimeoutMs` (120s warm-up), threaded through `runTurn`/`spawnOnce`.
- Record: `docs/generated/PHASE3_REVIEW.md`.

## Next Actions

1. **Phase 4 COMPLETE — Gate PASS** (independent review FAIL→PASS first pass 2026-09-17; **second-pass review 2026-09-18 → 3 MAJORs fixed & re-approved**; record `docs/generated/PHASE4_REVIEW.md`). All S1–S8 done & green (re-verified 2026-09-18): domain 32/32, event-protocol 14/14, runtime 9+2 skip, control-plane 30+1 skip, Playwright E2E golden path PASS.
2. **Phase 5 (NEXT per backlog P5): Agent Control MCP surface** — create_branch_from_node / send_message / list_branches / get_branch_status / interrupt_branch / archive_branch / query_execution_status / Main-agent integration test.
3. Interrupt/reconnect with long-lived process management (deferred, Phase 5/6 with the MCP control surface).
