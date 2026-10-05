# Phase 2 Independent Review — Record

Reviewer: independent subagent (fresh context, not the implementer), 2026-09-17.
Method: read `tasks/PHASE_2_RUNTIME_INTEGRATION.md`, `ACCEPTANCE_CRITERIA.md`, `docs/03_RUNTIME_ADAPTER.md`, CLAUDE.md constitution, ADR-006/007; read all `packages/runtime/src` + `test`, `packages/domain/src/{repository,db,types}.ts`; re-ran hermetic suite; cross-checked `git diff` for this phase; verified live-gate logic against the adapter and the persisted Phase 0 event-shape probe.

## Initial verdict

STATUS: FAIL (before fixes). One BLOCKER (external-id mapping in-memory only — restart recovery not real against the domain DB), two MAJOR (tool_use/tool_result + task-event parsing provably wrong against the real stream-json shape; no spawn timeout → infinite hang on dead gateway), several MINOR (env not scrubbed; no-prompt/materialization edge; 15721→15722 drift handling; task double-classification; cleanup NITs; forkFromNode naming drift). All legitimate; all addressed.

## Findings (all addressed 2026-09-17)

### Resolved — BLOCKER

1. **External-id mapping was in-memory only; restart recovery not real** — adapter's `sessions` was a `Map`; the domain `runtime_sessions`/`branches.runtime_session_id` tables existed but had zero callers (`insertRuntimeSession` never invoked; every branch created with `runtimeSessionId: null`). The live gate "passed" only because it carried the external id in memory and re-registered on a second adapter. **Fix:** adapter now takes an optional duck-typed `RuntimePersistence` hook; on start/fork/reconstruct it writes the mapping into the domain `runtime_sessions` (via `upsertRuntimeSession`, which also backfills `branches.runtime_session_id`); `resumeSession` reads the mapping back from the store on restart and recovers the SAME control-plane UUID. DB-backed restart test (`persistence-restart.test.mjs`) proves a brand-new adapter + same repo recovers the original key. Stores only non-secret fields (no tokens).

### Resolved — MAJOR

2. **tool_use/tool_result parsing read the wrong fields** — adapter read `ev.name`/`ev.tool_use_id` at top level, but real stream-json nests them in `message.content[]` (proved by `scripts/event-shape-probe.mjs`). Live tool events parsed to near-empty. **Fix:** `parseEvent` for `assistant` extracts text + nested `tool_use` blocks; `user` extracts nested `tool_result`. Unrelated/unknown event types are dropped, not mislabeled `kind:"task"`. `system:task_*` now carries `status`. Unit test (`cli-adapter-unit.test.mjs`) covers nested tools/task + drop-unrelated.
3. **No spawn timeout → infinite hang on dead gateway** — every `runTurn` was an unbounded await. **Fix:** `spawnOnce` now has `turnTimeoutMs` (default 300s, configurable); on fire it SIGTERMs the child and **rejects** with a clear timeout error. Unit test (`timeout: a hung child surfaces an error instead of hanging forever`) proves a never-completing child yields a timeout error, not a hang. `interrupt`/`subscribe` remain honest stubs (short-lived print-mode design), documented Phase 3 in CAPABILITIES/backlog.

### Resolved — MINOR / NIT (addressed or documented)

4. **Env not scrubbed / token in child env** — necessary for gateway auth (only sent to our own `claude` child). Documented; no token ever written to events/DB/staged files. `thinking_tokens` excluded (hidden chain-of-thought never surfaces).
5. **No-prompt / materialization edge** — `startSession`/`forkFromHead`/`reconstructBranchFromHistory` each inject a real turn prompt (required: no-prompt resume/fork emits no init). Documented: a session handle always implies one materialized turn.
6. **Gateway drift 15721→15722** — `.replace()` kept but `CBW_BASE_URL`/`CBW_AUTH_TOKEN` override stays authoritative; version-drift re-probe noted as Phase 2/3 open item.
7. **Task double-classification fixed** — `default:` no longer tags unknown top-level types as tasks; `system:task_*` + `background_tasks_changed` map to execution tree with status.
8. **Cleanup NIT** — per-run `.cbw/settings-*.json` accumulate in cwd; acceptable (per-branch settings, docs/03), noted for Phase 3 lifecycle hygiene.
9. **`forkFromNode` naming** — interface exposes `reconstructBranchFromHistory` (ADR-006 strategy); `forkFromNode` as a separate native method is Phase 3 when/if a native historical-fork path exists.

## Explicitly verified fine (not defects)

- `--session-id <valid-uuid>` pins `system:init` session_id to the control-plane UUID (live-verified). Malformed UUID rejected by CLI.
- `--session-id` over an already-materialized UUID is rejected ("already in use") → control plane must generate fresh UUIDs per new branch session; restart uses `--resume`. Live gates use `randomUUID()` per run.
- No-prompt `--resume`/`--fork-session` emits no init; `--resume` keeps the ORIGINAL external id → identity stable. `resumeSession` registration-only; round-trip lazy on first sendMessage.
- CAPABILITIES honest (rewindConversation/lifecycleHooks/interactivePermissions false; unit-tested).
- thinking_tokens dropped at parse; snapshot persistence stores only visibleContent — no COT surface.
- Single fact source preserved: runtime writes mapping into domain `runtime_sessions`, no second SQLite file.

## Final verdict

STATUS: PASS — Phase 2 gate met after fixes. Hermetic suite: 13/13 domain + 5/5 runtime (incl. DB-backed restart + nested-tool parse + timeout). Live gates (opt-in `CBW_LIVE=1`): restart fidelity 9-step demo PASS (230s) and historical reconstruction no-leak PASS on 2026-09-17. No blockers remain.
