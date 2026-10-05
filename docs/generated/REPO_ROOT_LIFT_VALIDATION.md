# Repo-root lift validation — 2026-10-05

Base: master `a20f7b65b18b374018a45cd1b45e56ad890c1cad` (merged PR #1).

## Scope and invariants

All tracked project files were lifted to the Git root; the two ignore files and
script directories were merged. Existing tunnel files, application code, tests,
package metadata, lockfile, workspace globs and Playwright configuration are
byte-identical after accounting for the rename. Their relative layout is intact.
CI now resolves the root lockfile and `apps/web` browser-install directory.
No redaction implementation was changed.

## Local checks

Environment: Linux, Node 24.19.0, pnpm 11.25.0 (repository pin remains 11.22.0).

- Frozen-lockfile install: PASS. The host's node-gyp header extraction hit an
  `fchown` error; retried with matching headers extracted using `--no-same-owner`
  and an environment-only `npm_config_nodedir`. No dependency changes.
- `pnpm build`: PASS for all workspace packages.
- `pnpm test`: PASS, 129 passed / 3 opt-in live tests skipped / 0 failed.
- `pnpm test:e2e`: attempted, BLOCKED locally at Chrome launch by sandbox denial
  of its Unix socket (`process_singleton_posix.cc`, `socket(): Operation not permitted`).
  The real control-plane webServer started successfully. Both browser tests failed
  before executing assertions. GitHub Actions E2E is the remaining validation gate.
- Old project-directory name: zero matches in tracked contents and current paths
  (`git grep` and `git ls-files`; the pre-migration history is intentionally retained).
- `git diff --cached --check`: PASS.
- Ignore checks: local tunnel configuration/logs, runtime database, Playwright
  results and Claude local metadata remain ignored.
- Independent read-only review: PASS; no lost files or code/path blocker.
  Its warning about persisted workspace paths is incorporated into README.

## Deployment and license

README describes stopping/backing up the control plane, preserving/migrating local
data, service/MCP path updates and existing persisted workspace/session bindings.
No running deployment or database was changed.

No existing license declaration was found in tracked files, seven package
manifests, or LICENSE/COPYING file history. LICENSE is explicitly deferred to the
maintainer; this migration does not select a license.
