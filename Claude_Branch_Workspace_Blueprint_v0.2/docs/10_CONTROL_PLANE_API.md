# 10 — Control Plane API Draft

最终 API 可以调整，语义需要保持。

## Projects

- POST `/api/projects`
- GET `/api/projects/:id`

## Branches

- GET `/api/projects/:id/branches`
- POST `/api/branches`
- POST `/api/branches/:id/messages`
- POST `/api/branches/:id/interrupt`
- POST `/api/branches/:id/archive`
- PATCH `/api/branches/:id`

Create branch request:

```json
{
  "fromNodeId": "uuid",
  "displayName": "optional and non-unique",
  "initialInstruction": "optional",
  "workspaceMode": "shared"
}
```

## Nodes

- GET `/api/branches/:id/nodes`
- GET `/api/nodes/:id`

## Events

- GET `/api/branches/:id/events`
- WS `/ws/projects/:id/events`

## Agent runs

- GET `/api/branches/:id/agent-runs`
- GET `/api/agent-runs/:id`

## Runtime

- GET `/api/runtime/capabilities`
- GET `/api/runtime/sessions`
- POST `/api/runtime/reconcile`

## Attention

- GET `/api/attention`
- POST `/api/attention/:id/respond`

## Invariant

HTTP API 不暴露隐藏 chain-of-thought。
