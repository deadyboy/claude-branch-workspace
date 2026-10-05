// Phase 4 hard gate 7: the permission/attention loop is CLOSED. The runtime
// exposes requests (or the no-interactive-permission mode is proven &
// documented — acceptEdits ⇒ no stall). Phase 4: the registry is real; it is
// seeded by the Playwright fake (live adapter cannot emit these today, R2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionRegistry } from "../dist/attention-registry.js";
import { setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { buildApp } from "../dist/server.js";

test("g7: registry seeds + lists + responds (GET/POST path)", () => {
  const reg = new AttentionRegistry();
  const c1 = reg.add({ branchId: "br-abc", projectId: "p1", type: "permission", requestText: "Bash: run `npm test`" });
  const c2 = reg.add({ branchId: "br-xyz", projectId: "p1", type: "question", requestText: "Continue writing to a.ts?" });
  assert.equal(reg.list().length, 2);
  assert.equal(reg.list("pending").length, 2);

  // POST /api/attention/:id/respond {answer:"allow"}
  const answered = reg.respond(c1.attentionId, "allow");
  assert.equal(answered.status, "answered");
  assert.equal(answered.answer, "allow");
  assert.ok(answered.answeredAt);
  assert.equal(reg.list("pending").length, 1);
  assert.equal(reg.list("answered").length, 1);

  // idempotent: re-respond returns the answered card unchanged
  const again = reg.respond(c1.attentionId, "deny");
  assert.equal(again.answer, "allow");

  // unknown id → null
  assert.equal(reg.respond("nope", "allow"), null);
  assert.equal(reg.get("nope"), null);
});

test("g7: seedFromEvent maps permission.requested / attention.required into cards", () => {
  const reg = new AttentionRegistry();
  const ev = {
    type: "permission.requested",
    payload: { text: "Bash command needs approval" },
    branchId: "br-z",
    projectId: "p1",
  };
  const card = reg.seedFromEvent(ev);
  assert.ok(card, "permission.requested seeds a card");
  assert.equal(card.type, "permission");
  assert.equal(card.requestText, "Bash command needs approval");
  assert.equal(card.branchId, "br-z");

  const q = reg.seedFromEvent({
    type: "attention.required",
    payload: { requestText: "Please confirm the plan" },
    branchId: "br-q",
    projectId: "p1",
  });
  assert.ok(q, "attention.required seeds a card");
  assert.equal(q.type, "question");
  assert.equal(q.requestText, "Please confirm the plan");

  // non-attention events never seed
  assert.equal(reg.seedFromEvent({ type: "tool.started", payload: {}, branchId: "br", projectId: "p" }), null);
});

test("g7: bus → registry → GET /api/attention serves the seeded card (production wiring)", async () => {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const attention = new AttentionRegistry();
  // The EXACT wiring index.ts main() uses — this is what makes it a real test
  // of the serve-after-seed path, not a hand-rolled twin.
  attention.subscribeToBus(bus);
  const app = await buildApp({ ctx: { db: null, svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, attention, adapter }, logger: false });
  await app.ready();

  const p = svc.createProject({ name: "g7-seed" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

  // A streamed canonical attention event published on the bus (as the
  // TurnObserver does after a turn's raw `attention` event).
  bus.publish({
    eventId: "evt-atn",
    projectId: p.id,
    branchId: main.id,
    nodeId: null,
    agentRunId: null,
    runtimeSessionId: null,
    type: "attention.required",
    status: "required",
    sequence: 1,
    occurredAt: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    payload: { summary: "Approve running npm test on this branch" },
  });

  // The UI reads it back over REST.
  const listed = await app.inject({ method: "GET", url: "/api/attention" });
  assert.equal(listed.statusCode, 200);
  const cards = listed.json();
  assert.equal(cards.length, 1, "the seeded card is served");
  assert.equal(cards[0].branchId, main.id);
  assert.equal(cards[0].requestText, "Approve running npm test on this branch");
  assert.equal(cards[0].status, "pending");
  assert.equal(cards[0].type, "question");

  // POST /api/attention/:id/respond resolves it (the Allow click in the UI).
  const answered = await app.inject({
    method: "POST",
    url: `/api/attention/${cards[0].attentionId}/respond`,
    payload: { answer: "allow" },
  });
  assert.equal(answered.statusCode, 200);
  assert.equal(answered.json()["status"], "answered");
  assert.equal(answered.json()["answer"], "allow");

  // And the pending list empties while the answered list shows it.
  const pending = await app.inject({ method: "GET", url: "/api/attention?status=pending" });
  assert.equal(pending.json().length, 0);
  const done = await app.inject({ method: "GET", url: "/api/attention?status=answered" });
  assert.equal(done.json().length, 1);

  await app.close();
  close();
});
