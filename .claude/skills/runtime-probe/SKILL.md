---
name: runtime-probe
description: Safely probe local Claude Code runtime capabilities in a disposable environment.
---

Use only disposable directories and non-sensitive content.

Record:
- exact commands,
- runtime versions,
- observable behavior,
- session IDs only if they are non-secret identifiers,
- pass/fail,
- limitations.

Do not modify important user projects during capability probing.

Update `docs/generated/RUNTIME_CAPABILITY_MATRIX.md`.
