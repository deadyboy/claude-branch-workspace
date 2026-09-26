# Server deployment handoff — 2026-09-26

Read this first in a new session. It covers the "run CBW on the USTC server,
local UI only" setup: how it works, current state, and what to do next.

## What this is

The whole CBW stack runs on the USTC GPU server (`jianf@210.45.73.166`), so RAM/CPU
stay off the 16 GB laptop. The laptop only renders UI. This was requested because
real 20-way local concurrency OOM-crashed the laptop; the server has ~2 TB RAM.

## Architecture (full chain)

```
local browser
  --ssh -L 127.0.0.1:15723--> server control plane (127.0.0.1:15723, systemd)
       --spawn--> server claude CLI (2.1.278)
            --ssh -R 127.0.0.1:15722--> local desktop gateway --> Anthropic
```

Both tunnels are loopback-bound; gate 12 (control plane binds 127.0.0.1 only) is
preserved — no code change was needed.

## Components and where they live

### Local (Windows) — tunnel keepers, auto-start at logon
- Scripts: `F:\claudetreespace\scripts\cbw-tunnel\`
  - `reverse-tunnel.ps1` — `ssh -R 15722` (server claude -> local gateway)
  - `forward-tunnel.ps1` — `ssh -L 15723` (local browser -> server CP)
  - `register-task.ps1` — registers both Scheduled Tasks
  - `logs\*.log` — keeper logs (check here first when a link is down)
- Scheduled Tasks: `CBWTunnelReverse`, `CBWTunnelForward` (logon trigger, hidden,
  each keeper self-heals in a retry loop).

### Server — control plane as a systemd user service
- Unit: `~/.config/systemd/user/cbw-control-plane.service` (enabled, Restart=always;
  user has `Linger=yes`, so it starts at boot WITHOUT login).
- Project: `/data3/jianf/claude-branch-workspace-test/Claude_Branch_Workspace_Blueprint_v0.2`
- conda env: `/data3/jianf/conda-envs/cbw22` (Node 22.23 + pnpm 11.27 + claude 2.1.278)
- DB: `<proj>/data/cbw.db`  |  Unit env: CBW_BASE_URL=127.0.0.1:15722, CBW_PORT=15723
- Checks: `systemctl --user status cbw-control-plane` / `journalctl --user -u cbw-control-plane`

## Current state (2026-09-26) — BLOCKED on user auth

- Tunnels: RESTORED this session (both links return 200; 2 ssh processes).
- Server control plane: active since 2026-09-22 (systemd, stable).
- **Real turns FAIL.** Root cause is NOT the server or tunnels: local `claude -p`
  prints **"Not logged in · Please run /login"**, and local settings
  `ANTHROPIC_BASE_URL` changed to `.../desktop` (was bare `:15722`) — the desktop
  app was updated, changing its gateway path and auth. The server relays to this
  same local gateway, so its claude children hang (one was seen stuck >1 min;
  node left `pending`).

## What to do next (ordered)

1. **USER-ONLY:** re-authenticate the desktop app / Claude Code locally
   (`/login`). Do NOT auto-login or copy tokens (constitution §11).
2. After local `claude -p "…"` works, re-check the server: the server's
   `~/.claude/settings.json` may need `/desktop` appended to ANTHROPIC_BASE_URL
   (currently `http://127.0.0.1:15722`). Mirror whatever the local settings now use.
3. Re-run a real turn via the API (see below) to confirm end-to-end.
4. Then resume product work: **Phase 6 scale** (backlog P6: real 20-way is FAIL,
   40 remains synthetic; keep default pool 5) — the server's 2 TB RAM is exactly
   what makes a real 20/40-way retest possible now.

## Diagnostic order (important — learned the hard way)

When a turn hangs: **test LOCAL `claude -p` FIRST.** If it says "Not logged in",
the problem is auth, not the server/tunnels. Only then check tunnels/logs.
Also: stale orphan `ssh.exe` can hold a loopback port and starve a keeper
(symptom: `cannot listen to port` in the log) — kill the exact PID only; the
keeper self-recovers once the port frees. Never batch-kill by image name.

## Monitoring / verification commands

Links:
```bash
curl -s -o /dev/null -w "local->CP %{http_code}\n" http://127.0.0.1:15723/
```
```bash
ssh -i ~/.ssh/id_rsa jianf@210.45.73.166 'curl -s -o /dev/null -w "server->gw %{http_code}\n" http://127.0.0.1:15722/'
```

Real-turn smoke test (project/root-branch ids in this DB):
```bash
curl -s -X POST http://127.0.0.1:15723/api/branches/ca20f6a9-7f4c-4d79-8307-1a1867924b03/messages \
  -H "Content-Type: application/json" -d '{"text":"Reply with exactly: OK"}'
```
Then GET `.../api/branches/<id>/conversation`.

## Hard-won gotchas

- `git config --global http.proxy = 127.0.0.1:7897` on the server: plain `git clone`
  fails when the reverse `vpn` tunnel is down — that is the git proxy config, not a
  lack of connectivity. The server DOES have direct internet (github 200).
- PowerShell 5.1 mis-decodes non-ASCII path literals as GBK: never hard-code a
  path with Chinese chars in a .ps1 or a Scheduled-Task Argument — resolve from
  `$PSScriptRoot`. This is why the scripts live under `F:\claudetreespace\` (ASCII).
- node `os.tmpdir()` != Git-Bash `/tmp` on Windows; build transfer files with
  `os.tmpdir()`.
- home disk on the server is ~100% full — work only under `/data3/jianf` (777);
  `/data3` itself is root-owned.

## Constraints (constitution / user rules — keep honoring)

- Never auto-manage credentials or bypass account limits (§11). Auth is user-only.
- Control plane binds 127.0.0.1 only (gate 12). No internal-IP binding.
- Never delete files on the server; kill only by verified exact PID.
- Read the `remote-gpu-jobs` skill before server operations.
