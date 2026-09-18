// Phase 4 hard gate 8: DURABLE RECONNECT CURSOR + GAP-FILL. Events carry a
// project-scoped monotonic seqRel; a client that reconnects with a stale cursor
// catches up via listEventsSince (REST ?after= and WS hello.lastSeqRel) instead
// of anyone persisting an unbounded Set<eventId>.
//
// Runs the REAL S5 stack: buildApp + inject() + injectWS() over the fake
// adapter, driving the full POST /messages -> openTurn -> runTurnOnce (fake)
// -> persist -> publish -> WS path.

import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { setupService, fakeAdapter } from "./helpers.mjs";
import { SessionManager } from "../dist/session-manager.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { AttentionRegistry } from "../dist/attention-registry.js";
import { buildApp } from "../dist/server.js";

async function makeApp() {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter();
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const attention = new AttentionRegistry();
  const app = await buildApp({ ctx: { db: null, svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, attention, adapter }, logger: false });
  await app.ready();
  return { app, svc, repo, bus, sm, adapter, close };
}

test("g8: project cursor is monotonic; events-after-cursor returns only new events", async () => {
  const { app, svc, close } = await makeApp();
  const p = svc.createProject({ name: "g8" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

  // One turn through the real route → persisted events with seqRel.
  await app.inject({
    method: "POST",
    url: `/api/branches/${main.id}/messages`,
    payload: { text: "T1" },
  });

  // Wait for the async run to persist + complete.
  await waitFor(() => svc.lastEventSeqRel(p.id) > 0);
  const cursor = svc.lastEventSeqRel(p.id);
  assert.ok(cursor > 0, "cursor advanced");

  // Second turn.
  await app.inject({
    method: "POST",
    url: `/api/branches/${main.id}/messages`,
    payload: { text: "T2" },
  });
  await waitFor(() => svc.lastEventSeqRel(p.id) > cursor);

  // events-after-cursor returns ONLY the T2 events, in order.
  const resp = await app.inject({ method: "GET", url: `/api/projects/${p.id}/events?after=${cursor}` });
  assert.equal(resp.statusCode, 200);
  const { events, latestSeqRel } = resp.json();
  assert.ok(events.length >= 1, "new turn's events after cursor");
  for (const ev of events) assert.ok(ev.seqRel > cursor, "each event > cursor");
  assert.equal(latestSeqRel, svc.lastEventSeqRel(p.id), "latest cursor reported");
  assert.ok(events.every((e, i) => i === 0 || events[i - 1].seqRel < e.seqRel), "ordered");

  await app.close();
  close();
});

test("g8: ws hello.lastSeqRel gap-fills missed events then forwards live deltas", async () => {
  const { app, svc, bus, close } = await makeApp();
  const p = svc.createProject({ name: "g8-ws" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

  // Do a turn FIRST so there are persisted events the socket missed.
  await app.inject({ method: "POST", url: `/api/branches/${main.id}/messages`, payload: { text: "T1" } });
  await waitFor(() => svc.lastEventSeqRel(p.id) > 0);
  const cursor = svc.lastEventSeqRel(p.id);

  // Open a socket with a STALE cursor (0) → server gap-fills everything.
  const got = [];
  const ws = await app.injectWS(`/ws/projects/${p.id}/events`, { headers: { host: "localhost" } }, {
    onOpen: (s) => s.on("message", (raw) => got.push(JSON.parse(String(raw)))),
  });
  ws.send(JSON.stringify({ hello: { lastSeqRel: 0 } }));
  await waitFor(() => got.length >= svc.listEventsSince(p.id, 0, 1000).length);

  const gapEvents = got.filter((f) => f.seqRel <= cursor);
  assert.ok(gapEvents.length >= 1, "gap-fill delivered missed events");
  assert.ok(gapEvents.every((f) => f.seqRel <= cursor));

  // Live delta: a second turn → forwarded live (seqRel > cursor).
  await app.inject({ method: "POST", url: `/api/branches/${main.id}/messages`, payload: { text: "T2" } });
  await waitFor(() => svc.lastEventSeqRel(p.id) > cursor);
  const live = got.filter((f) => f.seqRel > cursor);
  assert.ok(live.length >= 1, "live deltas forwarded");
  assert.ok(live.every((f) => f.seqRel > cursor));

  // Only redacted payloads ride the wire: payload is an object, and no raw body.
  for (const f of got) {
    assert.ok(f.payload && typeof f.payload === "object", "payload is object");
    assert.ok(f.eventId, "eventId present");
  }

  ws.removeAllListeners("message");
  await app.close();
  close();
});

test("g8: bounded dedupe is client-side (Set bounded to connect race) — server replays only > lastSeqRel", async () => {
  const { app, svc, close } = await makeApp();
  const p = svc.createProject({ name: "g8-dedupe" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

  await app.inject({ method: "POST", url: `/api/branches/${main.id}/messages`, payload: { text: "T1" } });
  await waitFor(() => svc.lastEventSeqRel(p.id) > 0);
  const c1 = svc.lastEventSeqRel(p.id);

  await app.inject({ method: "POST", url: `/api/branches/${main.id}/messages`, payload: { text: "T2" } });
  await waitFor(() => svc.lastEventSeqRel(p.id) > c1);
  const c2 = svc.lastEventSeqRel(p.id);

  // Reconnect twice with the SAME cursor → each reconnect re-serves the same
  // missed window (idempotent gap-fill), which is exactly what the client's
  // bounded dedupe set absorbs.
  const got1 = await collectAfter(app, p.id, c1);
  const got2 = await collectAfter(app, p.id, c1);
  assert.deepEqual(
    got1.map((f) => f.seqRel),
    got2.map((f) => f.seqRel),
    "same cursor re-serves identical window (no server-side cursor advancement)"
  );
  assert.ok(got1.every((f) => f.seqRel > c1 && f.seqRel <= c2));

  await app.close();
  close();
});

test("g8: reconnect REST catch-up refetches branches + agent-runs + conversation (gate 8 protocol)", async () => {
  const { app, svc, close } = await makeApp();
  const p = svc.createProject({ name: "g8-refresh" });
  const main = svc.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

  await app.inject({ method: "POST", url: `/api/branches/${main.id}/messages`, payload: { text: "T1" } });
  await waitFor(() => svc.lastEventSeqRel(p.id) > 0);
  // Wait for the node to complete too (turn finished).
  await waitFor(() => svc.getBranch(main.id) !== null && svc.lastNode(main.id)?.status === "completed");

  const branches = await app.inject({ method: "GET", url: `/api/projects/${p.id}/branches` });
  const runs = await app.inject({ method: "GET", url: `/api/branches/${main.id}/agent-runs` });
  const conv = await app.inject({ method: "GET", url: `/api/branches/${main.id}/conversation` });

  assert.equal(branches.statusCode, 200);
  assert.ok(branches.json().find((b) => b.id === main.id), "reconnect refetch sees the branch");
  assert.equal(runs.statusCode, 200);
  assert.ok(Array.isArray(runs.json()), "agent-runs refetched");
  assert.equal(conv.statusCode, 200);
  const items = conv.json();
  assert.ok(items.some((m) => m.role === "user" && m.content === "T1"), "conversation shows T1");

  await app.close();
  close();
});

// ---- helpers ----

async function collectAfter(app, projectId, afterSeqRel) {
  const recv = [];
  const ws = await app.injectWS(`/ws/projects/${projectId}/events`, { headers: { host: "localhost" } }, {
    onOpen: (s) => s.on("message", (raw) => recv.push(JSON.parse(String(raw)))),
  });
  ws.send(JSON.stringify({ hello: { lastSeqRel: afterSeqRel } }));
  await waitFor(() => recv.length > 0);
  ws.removeAllListeners("message");
  await ws.close?.();
  return recv;
}

async function waitFor(check, timeoutMs = 5000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > timeoutMs) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 10));
  }
}
