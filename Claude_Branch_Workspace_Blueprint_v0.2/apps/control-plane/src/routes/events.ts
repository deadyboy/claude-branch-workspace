// Event routes (gate 8 durable cursor): per-branch events and the project-level
// monotonic seq_rel cursor (the WS gap-fill source). Only redacted payloads are
// ever served — events are canonical observability, never chat truth.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerEvents(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/branches/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { after?: string; limit?: string };
    const after = q.after === undefined ? undefined : Number(q.after) || undefined;
    const limit = q.limit === undefined ? undefined : Math.min(Number(q.limit) || 200, 1000);
    const all = ctx.svc.listEventsByBranch(id);
    const from = after === undefined ? 0 : all.findIndex((e) => e.seqRel > after);
    const slice = from < 0 ? [] : all.slice(from);
    const events = limit === undefined ? slice : slice.slice(0, limit);
    const latest = slice.length ? slice[slice.length - 1].seqRel : (after ?? 0);
    return { events, latestSeqRel: latest };
  });

  // Project-level cursor read (gate 8). after = last seen seq_rel.
  app.get("/api/projects/:id/events", async (req) => {
    const { id } = req.params as { id: string };
    const q = req.query as { after?: string; limit?: string };
    const after = q.after === undefined ? 0 : Number(q.after) || 0;
    const limit = q.limit === undefined ? 200 : Math.min(Number(q.limit) || 200, 1000);
    const events = ctx.svc.listEventsSince(id, after, limit);
    const latest = events.length ? events[events.length - 1].seqRel : after;
    return { events, latestSeqRel: latest };
  });
}
