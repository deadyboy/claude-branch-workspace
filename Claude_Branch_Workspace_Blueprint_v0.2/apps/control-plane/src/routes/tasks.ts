// Task routes (S4, docs/14 §4.3). Task persistence for E5/E4b:
//   POST /api/tasks                { projectId, title, instructions, branchId? } → Task
//   GET  /api/projects/:id/tasks   → Task[]
//   GET  /api/tasks/:id            → Task & { attempts: TaskAttempt[] }
//   PATCH /api/tasks/:id           { title?, instructions?, role?, branchId? } → Task
//   POST /api/tasks/:id/apply      { preview: true }                 → ApplyPreview
//   POST /api/tasks/:id/apply      { preview: false, confirmToken }  → ApplyResult
//
// The apply endpoints (E4b) live in ../task-apply.ts; this file only validates
// the body and maps ApplyError to the right status. A scheduler is NOT
// implemented here; the durable `queued` status lets a task express "waiting for
// a slot".

import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { TaskStatus } from "@cbw/domain";
import { ApplyError, applyTask, computeApplyPreview } from "../task-apply.js";

const TASK_STATUSES: TaskStatus[] = ["queued", "running", "completed", "failed", "cancelled"];

export function registerTasks(app: FastifyInstance, ctx: AppContext): void {
  const { svc } = ctx;

  app.post("/api/tasks", async (req, reply) => {
    const body = (req.body ?? {}) as {
      projectId?: string;
      title?: string;
      instructions?: string;
      branchId?: string | null;
      role?: string | null;
    };
    if (!body.projectId || typeof body.projectId !== "string") {
      return reply.code(400).send({ error: "projectId is required" });
    }
    if (!body.title || typeof body.title !== "string") {
      return reply.code(400).send({ error: "title is required" });
    }
    if (!body.instructions || typeof body.instructions !== "string") {
      return reply.code(400).send({ error: "instructions is required" });
    }
    if (body.branchId != null && typeof body.branchId !== "string") {
      return reply.code(400).send({ error: "branchId must be a string" });
    }
    // Cross-project branch binding is rejected inside the service (DomainError),
    // which the server maps to 400; a missing project/branch maps to 404.
    const t = svc.createTask({
      projectId: body.projectId,
      title: body.title,
      instructions: body.instructions,
      branchId: body.branchId ?? null,
      role: body.role ?? null,
    });
    return reply.code(201).send(t);
  });

  app.get("/api/projects/:id/tasks", async (req) => {
    const { id } = req.params as { id: string };
    return svc.listTasksByProject(id);
  });

  app.get("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = svc.getTask(id);
    if (!t) return reply.code(404).send({ error: "task not found" });
    return { ...t, attempts: svc.listTaskAttempts(id) };
  });

  // Edit title / instructions / role / branch (E5 "所有任务角色和名称可编辑").
  app.patch("/api/tasks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = svc.getTask(id);
    if (!t) return reply.code(404).send({ error: "task not found" });

    const body = (req.body ?? {}) as {
      title?: unknown;
      instructions?: unknown;
      role?: unknown;
      branchId?: unknown;
    };
    if (body.title === undefined && body.instructions === undefined && body.role === undefined && body.branchId === undefined) {
      return reply.code(400).send({ error: "title, instructions, role or branchId is required" });
    }
    if (body.title !== undefined && (typeof body.title !== "string" || !body.title)) {
      return reply.code(400).send({ error: "title must be a non-empty string" });
    }
    if (body.instructions !== undefined && (typeof body.instructions !== "string" || !body.instructions)) {
      return reply.code(400).send({ error: "instructions must be a non-empty string" });
    }
    if (body.role !== undefined && body.role !== null && typeof body.role !== "string") {
      return reply.code(400).send({ error: "role must be a string or null" });
    }
    if (body.branchId !== undefined && body.branchId !== null && typeof body.branchId !== "string") {
      return reply.code(400).send({ error: "branchId must be a string or null" });
    }
    return svc.updateTask(id, {
      title: body.title as string | undefined,
      instructions: body.instructions as string | undefined,
      role: body.role as string | null | undefined,
      branchId: body.branchId === undefined ? undefined : (body.branchId as string | null),
    });
  });

  // Attempts: a task may be retried many times. Each retry appends a NEW attempt
  // and retains the old ones (E5). Exposed for the UI/MCP and covered by tests;
  // the scheduler/turn-runner is NOT wired here.
  app.post("/api/tasks/:id/attempts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const t = svc.getTask(id);
    if (!t) return reply.code(404).send({ error: "task not found" });

    const body = (req.body ?? {}) as {
      branchId?: string | null;
      nodeId?: string | null;
      agentRunId?: string | null;
      status?: string;
    };
    if (body.status !== undefined && !TASK_STATUSES.includes(body.status as TaskStatus)) {
      return reply.code(400).send({ error: `status must be one of ${TASK_STATUSES.join("|")}` });
    }
    const attempt = svc.addTaskAttempt({
      taskId: id,
      branchId: body.branchId ?? null,
      nodeId: body.nodeId ?? null,
      agentRunId: body.agentRunId ?? null,
      status: body.status as TaskStatus | undefined,
    });
    return reply.code(201).send(attempt);
  });

  app.post("/api/tasks/:id/attempts/:attemptId/complete", async (req, reply) => {
    const { id, attemptId } = req.params as { id: string; attemptId: string };
    const t = svc.getTask(id);
    if (!t) return reply.code(404).send({ error: "task not found" });
    const attempt = svc.getTaskAttempt(attemptId);
    if (!attempt || attempt.taskId !== id) return reply.code(404).send({ error: "attempt not found" });

    const body = (req.body ?? {}) as { status?: string; resultRef?: string | null; error?: string | null };
    const terminal = ["completed", "failed", "cancelled"] as const;
    if (!body.status || !terminal.includes(body.status as (typeof terminal)[number])) {
      return reply.code(400).send({ error: "status must be completed|failed|cancelled" });
    }
    return svc.completeTaskAttempt(attemptId, {
      status: body.status as (typeof terminal)[number],
      resultRef: body.resultRef ?? null,
      error: body.error ?? null,
    });
  });

  // E4b (docs/14 §4.3): preview then apply. `preview:true` is a PURE READ and
  // never touches the target; `preview:false` requires the confirmToken the
  // preview returned and refuses (409) when the target or source moved since.
  app.post("/api/tasks/:id/apply", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      preview?: unknown;
      confirmToken?: unknown;
      targetPath?: unknown;
    };
    if (typeof body.preview !== "boolean") {
      return reply.code(400).send({ error: "preview must be a boolean" });
    }
    if (body.targetPath !== undefined && body.targetPath !== null && typeof body.targetPath !== "string") {
      return reply.code(400).send({ error: "targetPath must be a string" });
    }
    const targetPath = (body.targetPath as string | undefined) ?? null;

    try {
      if (body.preview) {
        return await computeApplyPreview({ svc }, id, { targetPath });
      }
      if (typeof body.confirmToken !== "string" || !body.confirmToken) {
        return reply.code(400).send({ error: "confirmToken is required to apply" });
      }
      const result = await applyTask({ svc }, id, { targetPath, confirmToken: body.confirmToken });
      return reply.send(result);
    } catch (err) {
      if (err instanceof ApplyError) {
        return reply.code(err.code).send({ error: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      }
      throw err;
    }
  });
}
