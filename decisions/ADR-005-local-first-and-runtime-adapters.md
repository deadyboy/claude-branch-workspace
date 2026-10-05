# ADR-005 — Local-first with Runtime Adapters

Status: Accepted

## Decision

v0 is local-first.

Claude CLI is the primary runtime target, but all runtime operations go through an adapter interface.

Agent SDK can be added without rewriting domain/UI.
