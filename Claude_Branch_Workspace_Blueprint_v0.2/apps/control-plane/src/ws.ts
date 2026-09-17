// WS bridge for project event deltas (hard gate 8: durable cursor + gap-fill;
// hard gate 12: origin restriction).
//
// Protocol: GET /ws/projects/:id/events, then client sends {hello:{lastSeqRel}}.
// The server gap-fills listEventsSince(project, lastSeqRel) and forwards live
// EventBus deltas (already stamped with their authoritative seqRel — the
// observer persists BEFORE publishing). Only redacted CanonicalEvents are ever
// sent. Unsubscribe on close.
//
// Origin gate (g12): a browser WS cannot set Origin independently, so we check
// the handshake header — must be same-origin (Origin absent or equal to Host),
// or in the explicit dev allowlist. Anything else is 403-closed before any data
// flows.

import type { FastifyInstance } from "fastify";
import type { CanonicalEvent } from "@cbw/event-protocol";
import type { AppContext } from "./context.js";

const DEV_ALLOWLIST = ["http://localhost:5173", "http://127.0.0.1:5173"];

export function registerWs(app: FastifyInstance, ctx: AppContext): void {
  app.get("/ws/projects/:id/events", { websocket: true }, (socket, req) => {
    // (gate 12) origin check before any message is processed.
    const origin = req.headers.origin ?? null;
    const host = req.headers.host ?? null;
    const sameOrigin =
      origin === null ||
      host === null ||
      origin === `http://${host}` ||
      origin === `https://${host}`;
    const allowed = sameOrigin || (origin !== null && DEV_ALLOWLIST.includes(origin));
    if (!allowed) {
      socket.close(1008, "forbidden origin");
      return;
    }
    const { id } = req.params as { id: string };

    // One subscription per socket; forward only this project's deltas.
    const unsub = ctx.bus.subscribe((ev) => {
      if (ev.projectId !== id) return;
      sendFrame(socket, evFrame(ev));
    });

    socket.on("message", (raw: unknown) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch { return; }
      const m = msg as { hello?: { lastSeqRel?: number } };
      if (m?.hello && typeof m.hello.lastSeqRel === "number") {
        sendGapFill(ctx, socket, id, m.hello.lastSeqRel);
      }
    });

    socket.on("close", () => unsub());
    socket.on("error", () => unsub());
  });
}

/** Fill the durable-cursor gap on (re)connect (gate 8). */
function sendGapFill(
  ctx: AppContext,
  socket: { send(p: string): void; OPEN?: number; readyState?: unknown },
  projectId: string,
  afterSeqRel: number
): void {
  let rows: { seqRel: number; projectId: string; branchId: string; nodeId: string | null; agentRunId: string | null; type: string; status: string | null; occurredAt: string; payloadJsonRedacted: string; id: string; runtimeSessionId: string | null }[];
  try {
    rows = ctx.svc.listEventsSince(projectId, afterSeqRel, 1000);
  } catch { return; }
  for (const row of rows) {
    sendFrame(socket, rowFrame(row));
  }
}

function sendFrame(socket: { send(p: string): void }, data: unknown): void {
  if (typeof (socket as { OPEN?: number }).OPEN === "number") {
    // ws.WebSocket has readyState; guard against closed sockets.
    const ready = (socket as unknown as { readyState?: number }).readyState;
    if (ready !== undefined && ready !== (socket as { OPEN?: number }).OPEN) return;
  }
  try { socket.send(JSON.stringify(data)); } catch { /* closed mid-send */ }
}

function evFrame(ev: CanonicalEvent): unknown {
  return {
    eventId: ev.eventId,
    seqRel: ev.seqRel ?? 0,
    type: ev.type,
    status: ev.status ?? null,
    projectId: ev.projectId,
    branchId: ev.branchId,
    nodeId: ev.nodeId,
    agentRunId: ev.agentRunId,
    runtimeSessionId: ev.runtimeSessionId,
    occurredAt: ev.occurredAt,
    payload: ev.payload,
  };
}

function rowFrame(row: {
  id: string;
  projectId: string;
  seqRel: number;
  type: string;
  status: string | null;
  branchId: string;
  nodeId: string | null;
  agentRunId: string | null;
  runtimeSessionId: string | null;
  occurredAt: string;
  payloadJsonRedacted: string;
}): unknown {
  let payload: unknown = {};
  try { payload = JSON.parse(row.payloadJsonRedacted); } catch { /* empty */ }
  return {
    eventId: row.id,
    seqRel: row.seqRel,
    type: row.type,
    status: row.status,
    projectId: row.projectId,
    branchId: row.branchId,
    nodeId: row.nodeId,
    agentRunId: row.agentRunId,
    runtimeSessionId: row.runtimeSessionId,
    occurredAt: row.occurredAt,
    payload,
  };
}

export { DEV_ALLOWLIST };
