# 12 — Agent Control MCP

Phase 5 adds an independent MCP server for a Main Agent that needs to manage
persistent conversation branches. The server uses the official
`@modelcontextprotocol/sdk` over **stdio** and calls the already-running
control plane over its loopback HTTP API. It does not open a database, create a
runtime session, or instantiate a `SessionManager`; those remain owned by
`apps/control-plane`.

## Process and configuration

The package is `apps/mcp-server`. Build and run it with:

```text
pnpm --filter @cbw/mcp-server build
pnpm --filter @cbw/mcp-server start
```

The MCP protocol uses stdout, so the process writes diagnostics to stderr.
`CBW_CONTROL_PLANE_URL` selects the control-plane origin and defaults to
`http://127.0.0.1:15723`. The URL validator permits HTTP loopback origins
(`127.0.0.0/8`, `localhost`, or `::1`) only, with no credentials, path, query,
or fragment. The control-plane port can therefore be changed for a local
test, but a remote URL cannot be configured accidentally.

The package manifest adds these direct dependencies. The workspace owner must
install them and update the workspace lockfile as a separate integration step;
this chapter does not edit `pnpm-lock.yaml`:

| Package | Purpose |
|---|---|
| `@modelcontextprotocol/sdk ^1.30.0` | Official `McpServer` and `StdioServerTransport` |
| `zod ^4.6.5` | MCP tool input schemas |

## Tool contract

Each tool returns one bounded JSON text block. HTTP errors are returned as MCP
`isError: true` text such as `Control plane HTTP 409: ...`, so the Main Agent
can distinguish invalid input, a missing object, and a busy branch. IDs are
encoded as URL path segments and are rejected when they contain path or URL
delimiters. Control-plane error bodies are bounded before they cross the MCP
boundary.

| Tool | Input | Control-plane request | Successful result |
|---|---|---|---|
| `create_branch_from_node` | `projectId`, `nodeId`; optional `displayName`, `cwd`, `workspaceMode` (`shared`/`worktree`) | `POST /api/branches` with `forkFromNodeId` | `{branch, strategy, snapshot}`; branch and snapshot are summaries, without transcript contents or runtime session keys. The request allows up to 650 seconds for the control plane's eager runtime seed |
| `send_message` | `branchId`, `text`; optional `cwd` | `POST /api/branches/:id/messages` | `{branchId, nodeId, status:"accepted"}`; a branch already running a turn is HTTP 409 |
| `list_branches` | `projectId` | `GET /api/projects/:id/branches` | Up to 200 branch summaries, with `truncated` |
| `get_branch_status` | `branchId` | `GET /api/branches/:id` and `GET /api/branches/:id/agent-runs` | Branch summary, up to 200 AgentRun summaries, synthesized `busy`, `status`, and counts |
| `interrupt_branch` | `branchId` | `POST /api/branches/:id/interrupt` | `{branchId, interrupted:boolean, status:"interrupt_requested"}`; idle is HTTP 409 |
| `archive_branch` | `branchId` | `POST /api/branches/:id/archive` | Archived branch summary; a busy branch is HTTP 409 |
| `query_execution_status` | `branchId` or `agentRunId`; optional `nodeId` | Branch form: `GET /api/branches/:id/execution-tree?nodeId=...`; AgentRun form first reads `GET /api/agent-runs/:id`, then uses its owner branch/node | Bounded execution-tree summary (maximum 200 nodes and depth 16), never the event stream |
| `get_turn_result` | `nodeId` | `GET /api/nodes/:id`, then `GET /api/branches/:branchId/conversation` | Node status, terminal flag, bounded assistant content (maximum 12,000 characters), and status errors |

`query_execution_status` uses the actual Phase 4 route. A historical plan
mentioned `/api/agent-runs/:id/execution-tree`, but the HTTP contract exposes
the execution tree at `/api/branches/:id/execution-tree` and accepts a
`nodeId` query. An `agentRunId` is resolved through the existing AgentRun
endpoint to preserve that contract.

`get_turn_result` deliberately reads the node and effective conversation only.
The assistant item whose `nodeId` matches is selected as the final output. A
completed node has `errors: []`; failed and cancelled nodes report the bounded
generic terminal error (`turn failed` or `turn cancelled`). A pending node is
returned with `terminal:false` and no assistant content. Full events are never
included in this result, and no hidden reasoning is exposed.

## Error mapping

The HTTP client preserves 400, 404, and 409 status codes in MCP error text.
For older route responses that returned `{error: ...}` with HTTP 200, the
client infers 404 for `not found`/`no execution tree`, 409 for `busy`/`idle`,
and 400 for other error messages. Network, timeout, malformed JSON, and
non-loopback configuration failures are reported as bounded MCP errors.

The server also relies on the SDK's Zod validation before a handler runs:
required IDs and message text must be non-empty, text is capped at 100,000
characters, display names at 200, and working directories at 4,096.

## Security and ownership boundaries

- stdio is the only MCP transport in this package; there is no additional
  listening socket.
- The HTTP target is loopback-only and has no user-controlled path prefix.
- Runtime `sessionKey`/external session identifiers are not returned as tool
  results. The Main Agent addresses persistent branches and conversation nodes
  by immutable IDs.
- Branch snapshots are summarized by counts and metadata; prior transcript
  contents are not copied into MCP output.
- Execution output contains AgentRun metadata only and is bounded. Event
  streams, raw runtime payloads, and hidden chain-of-thought are not MCP data.
- The control plane remains the single writer for SQLite state and runtime
  session mappings. Restart/reconcile semantics therefore remain unchanged.

## Validation

Production behavior: `get_branch_status` includes queued/startup/fork claims even
before an AgentRun exists. A synchronous fork at full capacity returns 409 and
must be retried after other work finishes. Do not keep every parent slot occupied
while waiting for queued children. Default global/per-project capacity is 5.
Root branches are shared; choose `worktree` when forking a completed node.

Real-agent acceptance is available through `scripts/phase5-agent-live.mjs` after
`scripts/phase5-live.mjs` succeeds. It launches an outer Claude with only this MCP
tool surface and verifies the child's result through the production REST API.
Current observed results are recorded in `PHASE5_6_HANDOFF.md`.

Hermetic tests cover URL validation, all eight HTTP method/path/body mappings,
400/404/409 propagation, bounded branch/execution/assistant results, and a
stdio integration using the official SDK `Client` plus
`StdioClientTransport` against a local mock control-plane HTTP server.
