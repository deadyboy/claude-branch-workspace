# ADR-004 — Shared and Worktree Workspace Modes

Status: Accepted

## Decision

Conversation branching and filesystem isolation are orthogonal.

Each branch explicitly chooses:
- shared
- worktree

## Default

Read/research tasks may use shared.
Parallel code modification should prefer worktree.
