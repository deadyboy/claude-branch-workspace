# Phase 3 Independent Review — Record

Reviewer: independent subagent (fresh context, not the implementer), 2026-09-17.
Method: read `tasks/PHASE_3_EVENTS_AND_EXECUTION_TREE.md`, CLAUDE.md constitution, `docs/04_EVENT_AND_AGENT_MODEL.md`; read `packages/event-protocol/src/*` + `test/*`, `packages/domain/src/{db,types,repository,domain-services}.ts`, `packages/runtime/src/{types,claude-cli-adapter}.ts`, `apps/control-plane/src/branch-runner.ts` + scripts/demo + tests; re-ran the hermetic suite; empirically reproduced each finding by running code (not just reading).

## Initial verdict

STATUS: FAIL (before fixes). The redaction pillar had a verified secret leak (BLOCKER), attribution had an FK crash path (BLOCKER), and there were two MAJORs (main run never completes; assistant-text/agent-summary unredacted) plus a MINOR (SELECT * aliasing violation). All legitimate; all addressed.

## Findings (all addressed 2026-09-17)

### Resolved — BLOCKER

1. **Secret key inside a Bash command leaked verbatim** — `redact.ts` `TOOL_ALLOW` carried `Bash: ["command"]`, and `scrub()` only redacted a value when it was *entirely* secret-shaped: `looksSecretValue` anchored `/^sk-…$/` to the whole string and the `\b(api[_-]?key)\b` lookbehind failed on `_`-delimited names. Empirically `export ANTHROPIC_API_KEY=sk-live-…` and `echo sk-live-…` persisted **verbatim** in `payload_json_redacted`. Violates constitution §11 + gate pillar 2. **Fix:** `looksSecretValue` now detects secret-shaped values *anywhere* in a string (`=`, whitespace, or quote preceded `sk-…` with a terminator/trail; `export/set NAME=…` with a secret-shaped value), and every allowlisted value, `text`, and agent `task`/`summary` passes through `scrub()` before persistence. Regression tests added.

2. **FK crash when a task is the first event** — `branch-runner.ts` materialized the parent main run only via its own `agent.started`; if `task_started` arrived first (no prior main event), the subagent was inserted with `parentAgentRunId` → nonexistent main → `FOREIGN KEY constraint failed`, thrown out of the persist hook and aborting the whole turn (attribution pillar 1 breaks). **Fix:** the persist hook now lazily creates the parent main run (type `main`, name `Main`) before the event's own run whenever the payload names a parent not yet materialized. Hermetic regression test proves a task-first turn persists and roots the tree correctly.

### Resolved — MAJOR

3. **Main run never completes** — the observer popped only subagents on completion, and `completeAgentRun` fired only for `agent.completed`/`agent.failed`; the anonymous main run lingered as `running` / `endedAt=NULL` while `session.stopped` said completed. **Fix:** on `session.stopped`, the persist hook closes the branch's running main run with the turn outcome. Execution tree now shows `main Main [completed]` with a real `endedAt`.

4. **Assistant text / agent summary unredacted** — `observer.ts` persisted assistant `text` verbatim (bypassed `buildRedactedPayload`), and the `agent.*` branch assigned `p["task"] = input.summary` raw. A token inside assistant text or an agent description persisted. **Fix:** route `text`, `summary`, and every allowlisted tool value through `scrub()` (see #1).

### Resolved — MINOR

5. **`getRuntimeSession` `SELECT *` violated the aliasing convention** — returned snake_case keys cast to camelCase `RuntimeSession`. **Fix:** explicit `RUNTIME_SESSION_COLS` with `col AS camel` aliasing used by both `getRuntimeSession` and `getRuntimeSessionByExternalId`.

## Explicitly verified fine (not defects)

- Two-tree separation airtight: `branch-runner.ts` only ever calls `openAgentRun`/`recordEvent`/`completeAgentRun`; nothing can mint a branch from a task event. Demo asserts registry stays 1.
- `startBranch` upserts `runtime_sessions` before any turn → `runtime_session_id` FK resolves; `materialized` set prevents double-open of runs.
- Subagent attribution (`agent.started`/`agent.completed` on its own run id) correct.
- Out-of-order `tool_result` still maps by `toolUseId`; duplicate `task_started` ignored; `task_updated` (tool patches) ignored; exitCode→status mapping correct; `workspaceMode` passes through.
- `runtimeSessionId` is the control-plane local UUID, not a secret (acceptable).

## Final verdict

STATUS: PASS — Phase 3 gate met after fixes. Hermetic suite: 33/33 green (3 live-gateway tests skip without `CBW_LIVE=1`), including new regression tests for redaction-in-Bash, task-first FK, and main completion. Live demo (opt-in `CBW_LIVE=1`, real gateway) PASS: persisted event digest with attribute `node=y/run=y`, execution tree rooted at completed `main Main` with completed `subagent:Explore`, registry stays 1. No blockers remain.
