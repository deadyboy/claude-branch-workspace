# ADR-007 — Implementation Stack

Status: Accepted — Phase 0 verified 2026-09-17

## Decision

- **Language:** TypeScript end-to-end.
- **Control plane:** Node.js 20+ (local Node v24 available). Fastify HTTP.
- **Realtime:** WebSocket (ws / socket.io) for UI event stream.
- **Persistence:** SQLite via better-sqlite3 (sync, fast, local-first). Versioned migrations.
- **Runtime process management:** Node `child_process.spawn` with `stdio:["ignore","pipe","pipe"]`, closed stdin. No PTY required for the primary path (print-mode verified).
- **Runtime capture:** `claude -p --verbose --include-hook-events --output-format=stream-json`, parsed per-line into canonical events.
- **UI stack:** React + TypeScript + Vite. First version: tree + chat + agent monitor (no animation as gate).
- **Packaging:** local web server first; Electron/Tauri optional later.
- **Package manager:** pnpm.
- **WSL/Linux:** supported goal, not the primary dev path on this machine (native Windows/Git Bash works and is verified).

## Phase 0 validation

- Node 24 / pnpm 11 / git 2.55 all present.
- `child_process.spawn` async with closed stdin drives real `claude -p` sessions (verified multiple times).
- stream-json with `--include-hook-events` yields the event surface needed.
- SQLite better-sqlite3: standard, well-tested on Windows.
- React+Vite: standard.
