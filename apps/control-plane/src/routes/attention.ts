// Attention/permission loop (gate 7). The registry is seeded in index.ts from
// any `permission.requested` / `attention.required` canonical event published
// on the bus — the observer maps an `attention` raw runtime event (only the
// Playwright fake emits them today — reviewer R2; the live adapter runs
// acceptEdits + interactivePermissions:false so the loop never stalls). The UI
// reads + responds here.

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";

export function registerAttention(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/attention", async (req) => {
    const q = req.query as { status?: string };
    return ctx.attention.list(q.status as "pending" | "answered" | undefined);
  });

  app.post("/api/attention/:id/respond", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { answer?: string };
    if (body.answer !== "allow" && body.answer !== "deny") {
      return reply.code(400).send({ error: "answer must be allow|deny" });
    }
    const card = ctx.attention.respond(id, body.answer);
    if (!card) return reply.code(404).send({ error: "attention card not found" });
    return card;
  });
}
