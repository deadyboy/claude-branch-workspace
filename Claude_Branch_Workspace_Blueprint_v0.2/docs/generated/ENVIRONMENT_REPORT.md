# Environment Report — Phase 0 Task A

Status: VERIFIED 2026-09-17

## Machine

| Item | Value | Notes |
|---|---|---|
| OS | Windows 11 Home China (10.0.26200) | Windows 11 |
| Shell (this session) | Git Bash (MINGW64_NT-10.0-26200), bash | not PowerShell/cmd |
| WSL | WSL2, default distro Ubuntu (v2) | Available; not the primary runtime path for v0 |
| Node | v24.15.0 | at `C:\Users\lenovo\.local\nodejs\node-v24.15.0-win-x64\node` |
| npm | 11.12.1 | |
| pnpm | 11.22.0 | preferred package manager |
| yarn | not found | |
| git | 2.55.0.windows.2 | Windows git |
| python | 3.12.7 | not needed for primary stack |
| terminal | TERM=xterm-256color, CI=none | interactive TTY available in git-bash; winpty present at /usr/bin/winpty |
| disk | F: drive primary | project at F:\claudetreespace |

## Claude Code CLI

| Item | Value |
|---|---|
| executable | `C:\Users\lenovo\.local\bin\claude` |
| version | 2.1.226 |
| auth | desktop-app-managed (see below) |

## Authentication model (critical)

- This desktop app authenticates via its own gateway:
  - `ANTHROPIC_BASE_URL` = `http://127.0.0.1:15721` in settings, or `http://127.0.0.1:15722` (active per-process session proxy), both local USTC gateway (`upstream: https://api.llm.ustc.edu.cn`).
  - `ANTHROPIC_AUTH_TOKEN` is stored in `~/.claude/settings.json` under `env.ANTHROPIC_AUTH_TOKEN` (13 chars, gateway token).
- A standalone child `claude` CLI **cannot** authenticate with the desktop's auth unless it inherits `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`.
- **Verified working child invocation:** with `ANTHROPIC_BASE_URL=http://127.0.0.1:15722` and `ANTHROPIC_AUTH_TOKEN` from settings, `node child_process.spawn("claude", ["-p", ...], {env})` runs and returns real output.
- Port 15721 + token hangs (that port is a different gateway leg); 15722 + token works.
- `claude -p --output-format=stream-json` requires `--verbose`.

## PTY / process constraints

- `spawnSync("claude", ...)` in node hangs (blocks on stdin/pty). Use async `spawn` with `stdio:["ignore","pipe","pipe"]` and closed stdin.
- SIGTERM to a child `claude` process reliably terminates it (verified).
- Worktrees created by `--worktree` are LOCKED by the owning PID; stale locks must be unlocked before `git worktree remove`.

## Package manager decision

pnpm (present, fastest for monorepo). Node >= 20 is adequate for all planned stack.
