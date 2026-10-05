# Server deployment handoff — updated 2026-09-27 (values in this doc are REDACTED; local copy holds real ones)

> **Security note:** this file in the public repository intentionally shows only
> placeholders. The live values (server host/user and machine-specific filesystem
> paths) live in your **local** copy and in `scripts/cbw-tunnel/config.local.ps1`
> (gitignored). Port numbers are not secret and appear inline below. See
> `SENSITIVE_REFERENCE.md` (kept only locally) for the real inventory.

Read this first in a new session. It covers the "run CBW on the USTC server,
local UI only" setup: how it works, current state, and what to do next.

## What this is

The whole CBW stack runs on the USTC GPU server (host/user defined by the local
`config.local.ps1`), so RAM/CPU stay off the 16 GB laptop. The laptop only
renders UI. This was requested because real 20-way local concurrency OOM-crashed
the laptop; the server has ~2 TB RAM.

## Architecture (full chain)

```
local browser
  --ssh -L 127.0.0.1:15723--> server control plane (127.0.0.1:15723, systemd)
       --spawn--> server claude CLI (2.1.278)
            --ssh -R 127.0.0.1:15722--> local desktop gateway --> Anthropic
```

Both tunnels are loopback-bound; gate 12 (control plane binds 127.0.0.1 only) is
preserved — no code change was needed.

The gateway at `127.0.0.1:15722` is the **Claude Vision Bridge** (a local
`bridge.mjs`; exact path in the local reference), which also holds the pool of
upstream API keys (see Gotchas).

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
- Project: `<server-project-dir>`
- conda env: `<server-conda-env>/cbw22` (Node 22.23 + pnpm 11.27 + claude 2.1.278)
- DB: `<proj>/data/cbw.db`  |  Unit env: CBW_BASE_URL=127.0.0.1:15722, CBW_PORT=15723
- Checks: `systemctl --user status cbw-control-plane` / `journalctl --user -u cbw-control-plane`

## Current state (2026-09-27) — HEALTHY; auth fixed; Phase 6 scale passes

- Tunnels up, local->CP 200, server->gateway 200, control plane active, file-launcher OK.
- **Auth FIXED** (user-authorized this session). The server `~/.claude/settings.json`
  `env.ANTHROPIC_AUTH_TOKEN` was set to the real desktop credential (44 chars, read from a
  local credential file kept off-repo); backup `settings.json.bak-cred-<ts>` kept, mode 600.
  The `cbw-control-plane` service was **restarted** so the adapter's cached gateway env (read
  once in its constructor, `claude-cli-adapter.ts:97`) picks up the new token — without the
  restart the live service kept the stale `PROXY_MANAGED` placeholder.
- **No `/desktop` change was needed.** The server keeps a bare `:15722` base and works; the
  bridge accepts the credential on both the `/desktop`-prefixed and the plain paths.
- **Verified end-to-end:** server `claude -p` → `OK`; the CBW child path (fresh UUID, tools
  off) → `MODELCHECK_OK` (result `subtype: success`); a real turn via the control plane →
  exact reply `SERVER_OK_E2E`. The configured `qwen3.6-chat` is reported *unsupported* by the
  bridge pool but does **not** block turns (they fall through to a working model).
- **Phase 6 real scale on the server (2 TB RAM), 2026-09-27:** 20-way **20/20 PASS** (peak 20);
  40-way **40/40 PASS** (peak 40, 69s). Evidence:
  `capacity-1790444243562/result.json` (20-way), `capacity-1790448174742/result.json` (40-way).
  The 40-way pass required expanding the local Vision Bridge key pool 3 → 5; a prior 3-key run
  failed 28/40 with warm-up `startTurnTimeoutMs` (120s) timeouts because 3 keys supply only
  3×12 = 36 concurrent < 40 workers. With 5 keys the effective concurrency reaches the bridge's
  global ceiling (48 in-flight / 72 RPM) and 40-way passes. The limit was pool depth —
  not crashes and not host memory (323 GB free).

## How it looked blocked (2026-09-26 → 2026-09-27) — reference for next time

Symptom: real turns failed; a bare `claude -p` printed
`Not logged in · Please run /login`. It was NOT a server or tunnel problem, and NOT a broken
login. Root cause: the `/desktop` entry of the Vision Bridge is a private route requiring
`Authorization: Bearer <VISION_BRIDGE_DESKTOP_LOCAL_CREDENTIAL>` (bridge.mjs ~L1459-1474). The
desktop app (managed Claude Bridge profile) injects that credential; a bare shell only had the
`PROXY_MANAGED` placeholder, so the bridge correctly returned
`401 {"type":"authentication_error","message":"Invalid desktop local access credential"}`,
which Claude Code surfaces as `Not logged in`. Fix (above) = put the real credential in a
**real env var** for the claude process. Note: `settings.env.ANTHROPIC_API_KEY` does NOT satisfy
Claude Code's login gate; only an actual `ANTHROPIC_AUTH_TOKEN` env var (which the adapter sets
for children) does.

## Diagnostic order (important — learned the hard way)

When a turn hangs: **test LOCAL/child `claude -p` FIRST.** If it says "Not logged in", the
problem is auth (see above), not the server/tunnels — check the token, then restart the
control plane so the adapter re-reads it. Also: stale orphan `ssh.exe` can hold a loopback port
and starve a keeper (symptom: `cannot listen to port` in the log) — kill the exact PID only;
the keeper self-recovers once the port frees. Never batch-kill by image name.

## Monitoring / verification commands

Links:
```bash
curl -s -o /dev/null -w "local->CP %{http_code}\n" http://127.0.0.1:15723/
```
```bash
ssh -i "$CBW_SSH_KEY" "$CBW_SSH_TARGET" 'curl -s -o /dev/null -w "server->gw %{http_code}\n" http://127.0.0.1:15722/'
```

Real-turn smoke test (project/root-branch ids in this DB):
```bash
curl -s -X POST http://127.0.0.1:15723/api/branches/<root-branch-id>/messages \
  -H "Content-Type: application/json" -d '{"text":"Reply with exactly: OK"}'
```
Then GET `.../api/branches/<id>/conversation`. Replace `<root-branch-id>` with
the root-branch id of a project in this DB.

Phase 6 scale (run on the server, inside the cbw22 env):
```bash
CBW_CAPACITY_STAGES=40 node scripts/phase6-capacity-live.mjs   # 5,10,20 also valid
```

## Hard-won gotchas

- **Vision Bridge upstream keys** live in **CC Switch's SQLite DB** (path in the local reference),
  table `providers`, rows where `app_type='claude-desktop'`, token at
  `settings_config.env.ANTHROPIC_AUTH_TOKEN` (`credential-pool.mjs:loadDesktopCredentials`).
  Duplicates are de-duped. The bridge reads keys **only at startup**, so adding a key requires a
  bridge restart — use `reload-bridge.ps1` (waits for idle, validates PID/CommandLine, restarts
  the Scheduled Task). Per-key limit 18 RPM / 12 in-flight (bridge default, margin below the
  school's 20/20 per key); global 72 RPM / 48 in-flight (env-overridable via `VISION_BRIDGE_*`).
  The server has no separate key store — it uses the local bridge via the reverse tunnel.
- `git config --global http.proxy = 127.0.0.1:7897` on the server: plain `git clone`
  fails when the reverse `vpn` tunnel is down — that is the git proxy config, not a
  lack of connectivity. The server DOES have direct internet (github 200).
- PowerShell 5.1 mis-decodes non-ASCII path literals as GBK: never hard-code a
  path with Chinese chars in a .ps1 or a Scheduled-Task Argument — resolve from
  `$PSScriptRoot`. This is why the scripts live under `F:\claudetreespace\` (ASCII).
- node `os.tmpdir()` != Git-Bash `/tmp` on Windows; build transfer files with
  `os.tmpdir()`.
- home disk on the server is ~100% full — work only under the user's 777 work
  directory (e.g. a `/data3/<user>` style root); that root itself may be root-owned.

## Constraints (constitution / user rules — keep honoring)

- Never auto-manage credentials or bypass account limits (§11). Auth is user-only.
  (The 2026-09-27 token wiring was done only under explicit user authorization.)
- Control plane binds 127.0.0.1 only (gate 12). No internal-IP binding.
- Never delete files on the server; kill only by verified exact PID.
- Read the `remote-gpu-jobs` skill before server operations.
