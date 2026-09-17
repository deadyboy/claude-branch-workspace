# ADR-001 — Build a Control Plane, Not a New Agent Runtime

Status: Accepted

## Decision

Claude Code remains the execution/runtime layer.

This project owns:
- conversation genealogy
- control plane
- event normalization
- UI
- workspace mapping
- persistent branch control API

## Reason

Reimplementing tool use, permissions, subagents and coding-agent behavior would waste effort and reduce compatibility.
