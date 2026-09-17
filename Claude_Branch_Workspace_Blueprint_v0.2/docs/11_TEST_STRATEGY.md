# 11 — Test Strategy

## Unit

### Tree invariants
- duplicate names
- branch-of-branch
- exact fork point
- parent node relationship
- archive does not delete descendants
- local turn index

### Runtime mapping
- external session IDs do not become internal IDs
- runtime reconnect
- stale process detection

### Event normalization
- known hook event mapping
- unknown event passthrough
- secret redaction
- ordering and deduplication

## Integration

### Scenario A — Main + historical fork

1. Main 5 turns.
2. Fork from turn 2.
3. Send a question to child.
4. Verify child does not know Main turns 3–5 unless independently discoverable from filesystem/project state.
5. Continue Main turn 6.
6. Restart control plane.
7. Resume both.

### Scenario B — nested fork

Main turn 3 -> A -> A turn 2 -> A.1.

Check ancestry after restart.

### Scenario C — duplicate display names

Create:
Main/review
Main/review/review
Main/review (second sibling)

All remain independently addressable.

### Scenario D — transient subagents

One persistent branch spawns multiple subagents.
Verify they appear under Execution Tree only.

### Scenario E — shared filesystem

Two branches share path.
One modifies a file.
System makes shared-state semantics visible.

### Scenario F — worktree

Two branches modify same logical file independently.
Changes remain isolated.

### Scenario G — attention

Runtime requests permission.
UI shows correct branch and pauses correctly.

## Stress

- synthetic 1000 branches tree render
- synthetic 100k events ingest
- 10 concurrent live sessions
- 20 concurrent where supported
- 40 target where supported

Measure:
- UI frame responsiveness
- event lag
- memory
- process count
- SQLite write latency
- branch interaction latency

## Failure injection

- kill Claude process
- kill control-plane process
- corrupt/missing runtime session
- network loss if SDK adapter
- invalid hook payload
- event duplication
- out-of-order events
