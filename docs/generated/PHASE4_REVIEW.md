# Phase 4 Independent Review — Record

Reviewer: independent subagent (fresh context, not the implementer), 2026-09-17. Method: read `PHASE4_HANDOFF.md`, the approved plan (`glowing-jumping-stardust.md`), the project constitution, `PHASE4_REVIEW_MAP.md`, and the S4–S8 source (`apps/control-plane/src/*`, `packages/runtime/src/*`, `apps/web/src/*`) + tests; re-ran the hermetic suites. Two-pass review: an initial adversarial audit (FAIL) → implementer fixes → re-verification (APPROVE).

## Initial verdict

STATUS: FAIL (before fixes). All 15 hard gates passed on evidence, but the reviewer found one BLOCKER-class evidence gap (gate 2 reconstruction: the transcript-ack was dead code) and two MAJOR correctness risks (native-fork identity monotonicity untested hermetically; `POST /messages` had no per-branch busy guard). All legitimate; all addressed.

## Findings (all addressed 2026-09-17)

### Resolved — BLOCKER

1. **Gate 2 reconstruction: `TRANSCRIPT_ACK` seed was dead code** — `fork-orchestrator.ts` built `seedPrompt` (the `TRANSCRIPT_ACK`-wrapped transcript) but never passed it to `adapter.reconstructBranchFromHistory`; the real adapter joined raw `visibleMessages[].content` with no framing. The gate-2 "zero side-effect / read-only prior context" claim rested on a constant's string content, not on the actual seed the CLI receives. **Fix:** `ForkInput` gained `seedText?: string` (`packages/runtime/src/adapter.ts`); the orchestrator now passes the ack-wrapped seed as `seedText` (`fork-orchestrator.ts:128`); the adapter feeds `input.seedText ?? visibleMessages[].content.join("\n\n")` as the fresh session's opening prompt (`claude-cli-adapter.ts`). The g2 test now asserts the adapter **received** a seedText containing the full prior transcript **and** the ack frame (`reconstruction-side-effects.test.mjs` reads the recorded `input.seedText`), so the frame is proven to reach the CLI, not just to exist as a constant.

### Resolved — MAJOR

2. **Native fork identity monotonicity untested hermetically (gate 1)** — `forkFromHead` uses `--fork-session --session-id <fresh-uuid>`, but no hermetic test proved the child got a DISTINCT external session (only the CBW_LIVE-gated integration test did), leaving a silent-collapse-onto-parent risk theoretically unguarded. **Fix:** added a fork-aware fake `claude` (emits a distinct external id when `--fork-session` is present) + a hermetic test asserting distinct child external id and that both sessions run independently, plus a structural test pinning the `--fork-session` + fresh `--session-id` args (`packages/runtime/test/cli-adapter-unit.test.mjs`). The real-CLI proof remains the opt-in CBW_LIVE test; the structural gap is now closed in the default hermetic suite.

3. **`POST /messages` had no per-branch busy guard (gate 11)** — only the archive route 409'd on busy; `POST /messages` could open a second turn while the first was still live, violating per-branch serialization. **Fix:** the route now checks `sessionManager.hasActiveTurn(id)` (a turn node genuinely in flight, via `state.nodeId`) → `409 before openTurn` (`routes/branches.ts`); the handler claims the serialization slot synchronously via `claimTurn` (gate 11 TOCTOU closure — second-pass MAJOR fix below) and `release` clears it (`session-manager.ts`). Critical subtlety surfaced by the E2E: an eagerly-adopted fork child (bound session, no turn yet) must NOT be falsely 409'd — the guard keys on a turn NODE in flight, not a mere bound session. `busy-guard.test.mjs` proves: busy branch 409s with no second node; an unrelated branch still 202s (no global lock); an adopted-idle child's first message 202s.

## Explicitly verified fine (not defects)

- Frozen fork eager freeze (gate 1): snapshot anchored at creation; parent T3-T5 never leak into the child.
- Reconstruction snapshot purity + parent-need-not-be-alive (gate 2).
- Effective-conversation read model with fork-point cutoff (gate 3) + TurnResult = verbatim chat truth, whole-string secret replacement (gate 4).
- Explicit turn lifecycle open→complete/fail/cancel, idempotent (gate 5).
- Interrupt = cancelled + isolation (gate 6).
- Attention loop: registry real, seeded from bus `permission.requested`/`attention.required` via the production wiring, honest acceptEdits/no-interactive claim; bus→registry→REST serve-after-seed path test added (gate 7).
- Durable seq_rel cursor + WS gap-fill + REST catch-up (gate 8).
- Attribution honesty: tools attributed branch/turn, AgentRuns transient (gate 9).
- Per-branch serialization (not a global lock) (gate 11).
- Loopback-only bind + WS origin gate + CORS explicit dev allowlist (gate 12).
- SessionManager = sole runtime_sessions writer; forks adopt, never double-seed (gate 13).
- Shared-only UI, no worktree selector (gate 14).
- Restart reconcile incl. orphan agent_runs, run on boot (gate 15).
- Playwright E2E golden path PASS (hermetic chrome, fake runtime): boot/multi-turn/fork/no-leak/attention (gate 10).

## Re-verification run

- control-plane: 30 tests, 29 pass, 0 fail, 1 live-skip (all g-named gate tests green, incl. new `g11: POST /messages 409s…` and `g7: bus → registry → GET /api/attention serves the seeded card`).
- domain: 32/32 pass. event-protocol: 13/13 pass.
- runtime: 9 pass + 2 live-skip (fork-aware hermetic tests green).
- Playwright E2E golden path PASS (4.7s, system Chrome + CBW_FAKE_RUNTIME).

## Second-pass review (4 fresh reviewers, 2026-09-17 → fixes landed 2026-09-18)

Four independent fresh-context reviewers audited Phase 4 again and found **3 MAJORs** (verify, concurrency, security reviewers). All reproduced / confirmed, then fixed and re-verified. The former TOCTOU "non-blocking" observation was promoted to a real MAJOR and closed. The "real-CLI automation" observation remains opt-in by design (see below).

## Findings — second pass (all resolved)

### Resolved — MAJOR (verify)

4. **Restart-resume was dead code (gate 13)** — the adapter's in-memory `sessions` Map is wiped on control-plane restart; `SessionManager.resumeSession` called `findBound` (no-op) so resume never registered a session into the live adapter and never sent a message. **Fix:** SessionManager threads the domain DB into the real adapter via the duck-typed `RuntimePersistence` hook (`new ClaudeCliAdapter(undefined, undefined, svc)` in `index.ts`) — `upsertRuntimeSession` + `getRuntimeSessionByExternalId` recover the external-id → sessionKey mapping after restart; `resolveSession` branch (a) re-registers the bound external session via `adapter.resumeSession(bound.externalSessionId, cwd)` so its first `sendMessage` post-restart does not throw `unknown session`, keeping the persisted `runtime_sessions.id` as the authoritative sessionKey (identity survives). `restart.test.mjs` stays green; the `RuntimeSession` domain-row/type collision was aliased (`RuntimeSessionRow`).

### Resolved — MAJOR (concurrency)

5. **TOCTOU in the busy guard (gate 11)** — the `hasActiveTurn` guard → `openTurn` → `markNode` window is not atomic; two truly-concurrent POSTs on a fresh branch could both clear the guard before either `markNode` ran (especially under the real-CLI's async `startSession` spawn), double-opening. **Fix:** `SessionManager.claimTurn(branchId, nodeId)` claims the serialization slot **synchronously** in the request handler — no `await` between the 409 check, `openTurn`, and the claim (`routes/branches.ts`); `hasActiveTurn` now also sees a pending claim; a separate `pendingClaim` map (kept out of `state`) gets drained into `st.nodeId` by `resolveSession` and cleared by `release`, so a claim is never mistaken for a materialized session. New `busy-guard.test.mjs` test proves claim → drain → state.nodeId continuity with no busy gap.

### Resolved — MAJOR (security)

6. **Secret-shaped payloads leak as prefix/substring (gate 4 redaction)** — `looksSecretValue` required `(?:=|\s|["'`(])` immediately before `sk-…`, so a run bounded by `?`, `/`, or an alphanumeric prefix could slip the *remaining* secret-shaped fragment into the persisted/streamed text. **Fix:** whole-string boundary-class match `/(?:^|[^A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}(?:$|[^A-Za-z0-9_-])/` — a secret-shaped run anywhere in a string (URL/query/env assignment/embedded text) redacts the ENTIRE string; benign words (`notification`, `mask-…`, `task-id-…`, `export NOT_A_KEY=k`) are unchanged. Regression test added (`redaction.test.mjs`).

## Second-pass re-verification run

- control-plane: 31 tests, 30 pass, 0 fail, 1 live-skip (incl. claimTurn TOCTOU regression, restart-resume, full g-named gates).
- domain: 32/32 pass. event-protocol: 14/14 pass (incl. whole-string leak regression). runtime: 9 pass + 2 live-skip.
- Chain build green (`@cbw/event-protocol` → `@cbw/runtime` → `control-plane`).
- Playwright E2E golden path PASS (4.0s, system Chrome + CBW_FAKE_RUNTIME).

## Remaining observation (accepted)

- **Real-CLI automation opt-in**: native-fork and reconstruction still lack a real-CLI automated run in the default suite (CBW_LIVE only). Structural + fake-driven hermetic tests cover the argument/identity contract; live integration remains an opt-in integration test by design (per constitution, real-CLI runs are not hermetic).

## Final verdict

APPROVE — all 15 hard gates PASS with real, passing tests; no remaining blockers.
Phase 4 Gate PASS. First-pass recorded 2026-09-17; second-pass review + 3 MAJOR fixes re-verified and re-approved 2026-09-18.
