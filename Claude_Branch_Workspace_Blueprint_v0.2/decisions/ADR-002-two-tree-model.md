# ADR-002 — Separate Conversation Tree and Execution Tree

Status: Accepted

## Decision

Persistent conversation branches and transient subagent runs are different domain entities and different UI structures.

## Consequence

A subagent finishing does not create a persistent branch unless an explicit promotion/fork action occurs.
