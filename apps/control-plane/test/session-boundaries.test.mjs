import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../dist/server.js";
import { AttentionRegistry } from "../dist/attention-registry.js";
import { ForkOrchestrator } from "../dist/fork-orchestrator.js";
import { SessionManager } from "../dist/session-manager.js";
import { TurnScheduler } from "../dist/turn-scheduler.js";
import { fakeAdapter, makeProject, makeRoot, setupService } from "./helpers.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition did not become true before timeout");
}

function appFor({ svc, repo, bus, sessionManager, forkOrchestrator, adapter, scheduler }) {
  return buildApp({
    ctx: {
      db: null,
      svc,
      repo,
      bus,
      sessionManager,
      forkOrchestrator,
      attention: new AttentionRegistry(),
      adapter,
      ...(scheduler ? { scheduler } : {}),
    },
    logger: false,
  });
}

test("pending start: interrupt cancels the claimed node and keeps archive blocked until release", async () => {
  const { svc, repo, bus, close } = setupService();
  const base = fakeAdapter({ seedName: "PENDING-EXT" });
  let startEntered;
  const entered = new Promise((resolve) => { startEntered = resolve; });
  let releaseStart;
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const adapter = {
    ...base,
    async startSession(input) {
      startEntered();
      await startGate;
      return base.startSession(input);
    },
  };
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const app = await appFor({ svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, adapter });
  await app.ready();

  const project = makeProject(svc, "pending-start");
  const branch = makeRoot(svc, project.id);
  const accepted = await app.inject({
    method: "POST",
    url: `/api/branches/${branch.id}/messages`,
    payload: { text: "cancel while starting" },
  });
  assert.equal(accepted.statusCode, 202);
  const nodeId = accepted.json().nodeId;
  await entered;
  const pendingView = await app.inject({ method: "GET", url: `/api/branches/${branch.id}` });
  assert.equal(pendingView.statusCode, 200);
  assert.equal(pendingView.json().busy, true);
  assert.equal(pendingView.json().queued, false);

  const beforeArchive = await app.inject({ method: "POST", url: `/api/branches/${branch.id}/archive` });
  assert.equal(beforeArchive.statusCode, 409, "pending claim keeps archive blocked");
  const interrupted = await app.inject({ method: "POST", url: `/api/branches/${branch.id}/interrupt` });
  assert.equal(interrupted.statusCode, 202, "pending start is interruptible");
  assert.equal(interrupted.json().interruptRequested, true);

  const duringCancel = await app.inject({ method: "POST", url: `/api/branches/${branch.id}/archive` });
  assert.equal(duringCancel.statusCode, 409, "cancellation does not release the claim early");

  releaseStart();
  await waitUntil(() => svc.getNode(nodeId)?.status === "cancelled");
  assert.equal(sm.hasActiveTurn(branch.id), false);
  assert.equal(base.calls.some((call) => call[0] === "sendMessage"), false, "cancelled pending start never sends the user turn");

  const archived = await app.inject({ method: "POST", url: `/api/branches/${branch.id}/archive` });
  assert.equal(archived.statusCode, 200);
  assert.equal(svc.getBranch(branch.id).status, "archived");
  await app.close();
  close();
});

test("adopted idle child is interrupt-idle, while its first turn becomes active and busy", async () => {
  const { svc, repo, bus, close } = setupService();
  const base = fakeAdapter({ seedName: "ADOPT-EXT" });
  let sendEntered;
  const entered = new Promise((resolve) => { sendEntered = resolve; });
  let releaseSend;
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  const adapter = {
    ...base,
    async *sendMessage(sessionId, input) {
      sendEntered();
      await sendGate;
      yield* base.sendMessage(sessionId, input);
    },
  };
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const app = await appFor({ svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, adapter });
  await app.ready();

  const project = makeProject(svc, "adopted-idle");
  const idle = makeRoot(svc, project.id, "Idle");
  const idleSession = await base.reconstructBranchFromHistory(
    { visibleMessages: [], projectInstructions: null },
    { newSessionId: randomUUID(), cwd: "C:\\fake\\cwd" },
  );
  sm.adoptSession(idle.id, idleSession);
  const idleInterrupt = await app.inject({ method: "POST", url: `/api/branches/${idle.id}/interrupt` });
  assert.equal(idleInterrupt.statusCode, 409, "adopted idle state has no active invocation");
  const idleArchive = await app.inject({ method: "POST", url: `/api/branches/${idle.id}/archive` });
  assert.equal(idleArchive.statusCode, 200, "adopted idle state is archivable");

  const child = makeRoot(svc, project.id, "Child");
  const childSession = await base.reconstructBranchFromHistory(
    { visibleMessages: [], projectInstructions: null },
    { newSessionId: randomUUID(), cwd: "C:\\fake\\cwd" },
  );
  sm.adoptSession(child.id, childSession);
  const first = await app.inject({
    method: "POST",
    url: `/api/branches/${child.id}/messages`,
    payload: { text: "first child turn" },
  });
  assert.equal(first.statusCode, 202);
  await entered;
  const state = sm.getState(child.id);
  assert.equal(state.nodeId, first.json().nodeId, "existing adopted state received the pending node id");
  const activeView = await app.inject({ method: "GET", url: `/api/branches/${child.id}` });
  assert.equal(activeView.json().busy, true);

  const second = await app.inject({
    method: "POST",
    url: `/api/branches/${child.id}/messages`,
    payload: { text: "second child turn" },
  });
  assert.equal(second.statusCode, 409, "first child turn is busy after runtime start");
  const archive = await app.inject({ method: "POST", url: `/api/branches/${child.id}/archive` });
  assert.equal(archive.statusCode, 409, "active child turn blocks archive");

  releaseSend();
  await waitUntil(() => svc.getNode(first.json().nodeId)?.status === "completed");
  assert.equal(sm.hasActiveTurn(child.id), false);
  await app.close();
  close();
});

test("native head fork reserves the parent while workspace binding is pending", async () => {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter({ seedName: "FORK-RESERVE-EXT" });
  const sm = new SessionManager(svc, adapter);
  let bindEntered;
  const entered = new Promise((resolve) => { bindEntered = resolve; });
  let releaseBind;
  const bindGate = new Promise((resolve) => { releaseBind = resolve; });
  const workspaceManager = {
    async bind() {
      bindEntered();
      await bindGate;
      return "C:\\fake\\fork-cwd";
    },
  };
  const scheduler = new TurnScheduler(1, 1);
  const fo = new ForkOrchestrator(svc, sm, adapter, workspaceManager, scheduler);
  const app = await appFor({ svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, adapter, scheduler });
  await app.ready();

  const project = makeProject(svc, "fork-reservation");
  const main = makeRoot(svc, project.id, "Main");
  await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const head = svc.appendCompletedTurn({ branchId: main.id, userContent: "head", assistantContent: "ready" });

  const forkPromise = fo.createFork({ projectId: project.id, forkFromNodeId: head.id });
  await entered;
  assert.equal(sm.hasActiveTurn(main.id), true, "fork reservation is visible as an active boundary");
  const child = repo.listBranchesByProject(project.id).find((branch) => branch.parentBranchId === main.id);
  assert.ok(child, "child is visible while its eager seed is pending");
  const childPendingView = await app.inject({ method: "GET", url: `/api/branches/${child.id}` });
  assert.equal(childPendingView.json().busy, true);
  assert.equal(childPendingView.json().queued, false);

  const parentMessage = await app.inject({
    method: "POST",
    url: `/api/branches/${main.id}/messages`,
    payload: { text: "must wait for fork freeze" },
  });
  assert.equal(parentMessage.statusCode, 409, "parent cannot progress during workspace binding");
  const archive = await app.inject({ method: "POST", url: `/api/branches/${main.id}/archive` });
  assert.equal(archive.statusCode, 409, "parent cannot archive during workspace binding");
  const childMessage = await app.inject({
    method: "POST",
    url: `/api/branches/${child.id}/messages`,
    payload: { text: "must wait for child seed" },
  });
  assert.equal(childMessage.statusCode, 409, "child cannot start an empty lazy session while seeding");
  const childArchive = await app.inject({ method: "POST", url: `/api/branches/${child.id}/archive` });
  assert.equal(childArchive.statusCode, 409, "child cannot archive while seeding");

  releaseBind();
  const created = await forkPromise;
  assert.equal(created.strategy, "native_head_fork");
  assert.equal(sm.hasActiveTurn(main.id), false, "fork reservation releases after child seed");
  const childReadyView = await app.inject({ method: "GET", url: `/api/branches/${child.id}` });
  assert.equal(childReadyView.json().busy, false);
  await app.close();
  close();
});

test("active eager fork can be interrupted before the child runtime is adopted", async () => {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter({ seedName: "FORK-INT-EXT" });
  const sm = new SessionManager(svc, adapter);
  let bindEntered;
  const entered = new Promise((resolve) => { bindEntered = resolve; });
  let releaseBind;
  const bindGate = new Promise((resolve) => { releaseBind = resolve; });
  const workspaceManager = {
    async bind() {
      bindEntered();
      await bindGate;
      return "C:\\fake\\fork-cwd";
    },
  };
  const scheduler = new TurnScheduler(1, 1);
  const fo = new ForkOrchestrator(svc, sm, adapter, workspaceManager, scheduler);
  const app = await appFor({ svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, adapter, scheduler });
  await app.ready();

  const project = makeProject(svc, "fork-interrupt");
  const main = makeRoot(svc, project.id, "Main");
  const parent = await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const head = svc.appendCompletedTurn({ branchId: main.id, userContent: "head", assistantContent: "ready" });

  const forkPromise = fo.createFork({ projectId: project.id, forkFromNodeId: head.id });
  await entered;
  const child = repo.listBranchesByProject(project.id).find((branch) => branch.parentBranchId === main.id);
  assert.ok(child);
  const interrupted = await app.inject({ method: "POST", url: `/api/branches/${child.id}/interrupt` });
  assert.equal(interrupted.statusCode, 202);
  assert.equal(interrupted.json().interruptRequested, true, "pending child bootstrap is interruptible");
  releaseBind();

  await assert.rejects(forkPromise, /fork bootstrap cancelled/);
  assert.equal(svc.getBranch(child.id).status, "archived");
  assert.equal(repo.listRuntimeSessionsByBranch(child.id).length, 0);
  assert.equal(sm.hasActiveTurn(main.id), false);
  await app.close();
  close();
});

test("fork bootstrap admission fails fast when the scheduler has no capacity", async () => {
  const { svc, repo, bus, close } = setupService();
  const base = fakeAdapter({ seedName: "FORK-CAPACITY-EXT" });
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const adapter = {
    ...base,
    async *sendMessage(sessionId, input) {
      firstEntered();
      await firstGate;
      yield* base.sendMessage(sessionId, input);
    },
  };
  const sm = new SessionManager(svc, adapter);
  const scheduler = new TurnScheduler(1, 1);
  const fo = new ForkOrchestrator(svc, sm, adapter, undefined, scheduler);
  const app = await appFor({ svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, adapter, scheduler });
  await app.ready();

  const project = makeProject(svc, "fork-capacity");
  const blocker = makeRoot(svc, project.id, "Blocker");
  const main = makeRoot(svc, project.id, "Main");
  await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const head = svc.appendCompletedTurn({ branchId: main.id, userContent: "head", assistantContent: "ready" });
  const firstResponse = await app.inject({
    method: "POST",
    url: `/api/branches/${blocker.id}/messages`,
    payload: { text: "occupy scheduler" },
  });
  assert.equal(firstResponse.statusCode, 202);
  await entered;

  const forkResponse = await app.inject({
    method: "POST",
    url: "/api/branches",
    payload: { projectId: project.id, forkFromNodeId: head.id, displayName: "Rejected" },
  });
  assert.equal(forkResponse.statusCode, 409, "synchronous fork rejects saturated scheduler admission");
  const child = repo.listBranchesByProject(project.id).find((branch) => branch.parentBranchId === main.id);
  assert.ok(child);
  assert.equal(child.status, "archived");
  assert.equal(repo.listRuntimeSessionsByBranch(child.id).length, 0);

  releaseFirst();
  await waitUntil(() => svc.getNode(firstResponse.json().nodeId)?.status === "completed");
  await app.close();
  close();
});

test("root worktree mode is rejected instead of silently becoming shared", async () => {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter({ seedName: "ROOT-MODE-EXT" });
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const app = await appFor({ svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, adapter });
  await app.ready();
  const project = makeProject(svc, "root-mode");
  const response = await app.inject({
    method: "POST",
    url: "/api/branches",
    payload: { projectId: project.id, workspaceMode: "worktree" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(repo.listBranchesByProject(project.id).length, 0);
  const missing = await app.inject({ method: "GET", url: `/api/branches/${randomUUID()}` });
  assert.equal(missing.statusCode, 404);
  await app.close();
  close();
});

test("queued turn cancellation releases its pending claim without starting the runtime", async () => {
  const { svc, repo, bus, close } = setupService();
  const base = fakeAdapter({ seedName: "QUEUE-EXT" });
  let firstEntered;
  const entered = new Promise((resolve) => { firstEntered = resolve; });
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const adapter = {
    ...base,
    async *sendMessage(sessionId, input) {
      firstEntered();
      await firstGate;
      yield* base.sendMessage(sessionId, input);
    },
  };
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const scheduler = new TurnScheduler(1, 1);
  const app = await appFor({ svc, repo, bus, sessionManager: sm, forkOrchestrator: fo, adapter, scheduler });
  await app.ready();

  const project = makeProject(svc, "queued-cancel");
  const first = makeRoot(svc, project.id, "First");
  const second = makeRoot(svc, project.id, "Second");
  const firstResponse = await app.inject({
    method: "POST",
    url: `/api/branches/${first.id}/messages`,
    payload: { text: "hold first" },
  });
  assert.equal(firstResponse.statusCode, 202);
  await firstEntered;

  const secondResponse = await app.inject({
    method: "POST",
    url: `/api/branches/${second.id}/messages`,
    payload: { text: "cancel queued" },
  });
  assert.equal(secondResponse.statusCode, 202);
  const secondNodeId = secondResponse.json().nodeId;
  const interrupted = await app.inject({ method: "POST", url: `/api/branches/${second.id}/interrupt` });
  assert.equal(interrupted.statusCode, 202);
  assert.equal(interrupted.json().queued, true);
  await waitUntil(() => svc.getNode(secondNodeId)?.status === "cancelled");
  assert.equal(base.calls.some((call) => call[0] === "sendMessage" && call[1] !== undefined), false, "queued turn never entered sendMessage");
  assert.equal(sm.hasActiveTurn(second.id), false);

  releaseFirst();
  await waitUntil(() => svc.getNode(firstResponse.json().nodeId)?.status === "completed");
  await app.close();
  close();
});

test("an unseeded fork orphan is archived after restart instead of lazy-starting empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cbw-fork-orphan-"));
  const dbPath = join(dir, "test.db");
  let first;
  let second;
  try {
    first = setupService(dbPath);
    const project = makeProject(first.svc, "fork-orphan");
    const main = makeRoot(first.svc, project.id, "Main");
    const head = first.svc.appendCompletedTurn({ branchId: main.id, userContent: "head", assistantContent: "ready" });
    const child = first.svc.createBranchFromNode({ projectId: project.id, forkFromNodeId: head.id });
    assert.ok(first.svc.getBranchAncestry(child.id).snapshot, "the immutable snapshot survives the interrupted seed");
    first.close();
    first = null;

    second = setupService(dbPath);
    const adapter = fakeAdapter({ seedName: "ORPHAN-EXT" });
    const sm = new SessionManager(second.svc, adapter);
    await assert.rejects(
      sm.resolveSession({ branchId: child.id, cwd: "C:\\fake\\cwd" }),
      /no runtime session binding/,
    );
    assert.equal(second.svc.getBranch(child.id).status, "archived");
    assert.ok(second.svc.getBranchAncestry(child.id).snapshot);
    assert.equal(adapter.calls.some((call) => call[0] === "startSession"), false, "fork orphan never becomes an empty root");
  } finally {
    second?.close();
    first?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control-plane session and native child ids are bare UUIDs", async () => {
  const { svc, repo, bus, close } = setupService();
  const adapter = fakeAdapter({ seedName: "UUID-EXT" });
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const project = makeProject(svc, "uuid-boundary");
  const main = makeRoot(svc, project.id);
  const parent = await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  assert.match(parent.sessionKey, UUID);
  const node = svc.appendCompletedTurn({ branchId: main.id, userContent: "head", assistantContent: "ready" });

  const created = await fo.createFork({ projectId: project.id, forkFromNodeId: node.id });
  assert.equal(created.strategy, "native_head_fork");
  assert.match(created.sessionKey, UUID);
  const forkCall = adapter.calls.find((call) => call[0] === "forkFromHead");
  assert.ok(forkCall);
  assert.match(forkCall[2], UUID);
  assert.equal(repo.listRuntimeSessionsByBranch(created.branch.id).length, 1);
  close();
});

test("failed eager fork archives the child and cannot fall back to an empty lazy session", async () => {
  const { svc, repo, close } = setupService();
  const adapter = fakeAdapter({ seedName: "FAIL-EXT" });
  adapter.forkFromHead = async () => { throw new Error("native fork failed"); };
  const sm = new SessionManager(svc, adapter);
  const fo = new ForkOrchestrator(svc, sm, adapter);
  const project = makeProject(svc, "fork-failure");
  const main = makeRoot(svc, project.id);
  await sm.resolveSession({ branchId: main.id, cwd: "C:\\fake\\cwd" });
  const node = svc.appendCompletedTurn({ branchId: main.id, userContent: "head", assistantContent: "ready" });

  await assert.rejects(
    fo.createFork({ projectId: project.id, forkFromNodeId: node.id }),
    /native fork failed/,
  );
  const child = repo.listBranchesByProject(project.id).find((branch) => branch.parentBranchId === main.id);
  assert.ok(child, "failed fork remains visible for diagnosis");
  assert.equal(child.status, "archived", "failed fork is unusable instead of lazily becoming an empty session");
  assert.equal(repo.listRuntimeSessionsByBranch(child.id).length, 0);
  close();
});
