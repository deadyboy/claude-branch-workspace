# Runtime Capability Matrix — Phase 0 Spike Results

Status: VERIFIED on 2026-09-17, Claude Code v2.1.226, Windows 11 / Git Bash, desktop-app auth via local gateway (127.0.0.1:15722).

Legend: ✅ = verified via disposable probe; ⚠️ = verified with caveat; ❌ = unavailable/not viable; — = not applicable to this runtime.

| Capability | Claude CLI v2.1.226 | Agent SDK | Evidence (probe) | Decision |
|---|---|---|---|---|
| Start real session | ✅ | n/a | `claude -p --session-id <uuid>` → real output, exit 0 | Primary path: print-mode child processes |
| Custom session id | ✅ | n/a | session id chosen via `--session-id`, persisted | Control plane assigns its own UUIDs |
| Multi-turn in one session | ✅ | n/a | `--resume <id>` across separate processes retains memory (secret 42 → "42") | resume across process re-entry works |
| Session id discoverable | ✅ | n/a | `system:init` event carries `session_id` | Use init event for registry |
| Resume | ✅ | n/a | resolved by id in new process | supported |
| Fork from head | ✅ | n/a | `--resume <id> --fork-session --session-id <new>` → child carries full prefix; original unaffected (root "NO" to child's delta) | forkFromHead = native |
| Original preserved after fork | ✅ | n/a | original session unchanged after fork | confirmed |
| Branch of branch | ✅ | n/a | root→child→grandchild; grandchild knows root+child rules; root never learns grandchild's rule | nested native fork works |
| Arbitrary historical-node fork | ⚠️ | n/a | No native CLI fork-from-turn-N. Fork copies ALL history. Reconstruct-from-snapshot (Option 3): fresh session seeded with visible prefix → child knows turn1..N, not N+1 onward | Use reconstruction as primary for node forks; mark origin_strategy=replay_reconstruction |
| Fork fidelity / no leak | ✅ | n/a | **Automated probe `scripts/fork-fidelity-probe.mjs` (7 assertions PASS, isolated per-branch cwd + auto-memory disabled):** child seeded at turn 2 knows `theme_a,palette_b`, NOT turn-3 `accent_c`; root retains its own `accent_c` (unmutated); no cross-branch future memory. Earlier "42" proof was contaminated by a shared-cwd auto-memory leak — corrected. | Scenario A regression seed |
| Rewind | ⚠️ | n/a | no clean non-interactive rewind for subprocess; avoid depending on it | not used for v0 fork |
| Hooks as event source | ✅ | n/a | `--include-hook-events --output-format=stream-json` emits PreToolUse/PostToolUse, SubagentStart/Stop, Stop, UserPromptSubmit, hook lifecycle, task_*. **Caveat (from review): hook wrapper events carry EMPTY payloads; real tool detail comes from `assistant` tool_use blocks + `user` tool_result records + task_* events.** | Prefer stream-json over raw JSONL parse; map tool_use/tool_result |
| Subagent start/stop observable | ✅ | n/a | `SubagentStart:Explore` / `SubagentStop` wrappers + `system:task_started/task_updated/task_notification` present (verified in `scripts/event-shape-probe.mjs`) | Execution Tree source |
| Task events | ✅ | n/a | `task_started/task_progress/task_updated/task_notification` + `background_tasks_changed` present | Execution Tree detail |
| Tool start/complete/fail | ✅ | n/a | `assistant` tool_use blocks (3) + `user` tool_result records (3) verified in `scripts/event-shape-probe.mjs` | normalized to tool.started/completed/failed |
| Permission flow | ⚠️ | n/a | interactive-only; print mode uses permissionMode=bypassPermissions by default | v0 uses auto/bypass; attention signaled via PermissionRequest hook when interactive |
| Worktree isolation | ✅ | n/a | `--worktree` created real git worktree `worktree-floating-tickling-valley` | workspace_mode=worktree native |
| Shared filesystem | ✅ | n/a | default same-cwd sessions share files (no worktree) | workspace_mode=shared native |
| Interrupt | ✅ | n/a | **Automated probe `scripts/interrupt-probe.mjs`:** SIGTERM to child pid closed it in 112ms | interrupt = process signal |
| Process reconnect/recovery | ✅ | n/a | interrupt-probe resumed SAME session id (`99999999-...-5ab`) in new process after kill → `OK-RECONNECTED`; earlier manual resume across process exits worked | reconcile engine needed |
| Session stop | ✅ | n/a | SIGTERM / process end | ok |
| stream-json | ✅ | n/a | `--print --verbose --include-hook-events --output-format=stream-json` works | primary capture path |
| PTY interactive | ⚠️ | n/a | winpty present; interactive permission flow not automated | avoid for bulk; manual mode for attention |
| auto-memory cross-session | ✅ (isolation verified) | n/a | With per-branch isolated cwd + auto-memory disabled (`autoMemoryMemoryDir` per-branch, `autoMemoryMemory:false` in `--settings`), child does NOT inherit root's future memory (fork-fidelity probe assertion 7 PASS). Original leak was due to shared project `memory/` under a common cwd — corrected. | Must always isolate memory per branch (per-branch cwd/settings); never share project memory across branches |

## Key architecture decisions from this matrix

1. **Control plane spawns child `claude -p` processes** (async node child_process, closed stdin) — no PTY needed for the general path.
2. **Session registry keys on our UUID** (`--session-id`), never on CLI-internal ids.
3. **forkFromHead = native `--fork-session`** (copies prefix; original preserved).
4. **forkFromNode = reconstruction** (Option 3 in ADR-006): fresh session + seeded visible prefix; store `origin_strategy=replay_reconstruction`; do NOT claim native ancestry.
5. **Event capture = stream-json `--include-hook-events`** from each child session → normalized to canonical events.
6. **Worktree = native `--worktree`**; shared = plain cwd.
7. **Interrupt = SIGTERM** on the child PID.
8. **Auto-memory must be disabled or isolated for forked sessions** to guarantee "child doesn't inherit unrelated future memory."

## Capabilities NOT supported (so far)

- Native fork-from-arbitrary-node (no CLI flag) — reconstruction is the documented fallback.
- Non-interactive permission responses — interactions need a live TTY/hook handling (Phase 3 attention).
