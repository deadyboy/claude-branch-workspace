import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, Repository, DomainService } from "@cbw/domain";
import { EventBus } from "@cbw/event-protocol";
import { ClaudeCliAdapter } from "@cbw/runtime";
import { startBranch, runTurn } from "../dist/index.js";

// Phase 3 live gate through the PRODUCTION pipeline (startBranch/runTurn):
// every canonical event is attributed to the owner branch/turn, a subagent is
// materialized as a transient AgentRun in the execution tree, and AgentRuns are
// NEVER promoted to branches. Requires a live gateway -> CBW_LIVE=1 (opt-in).
const live = process.env.CBW_LIVE === "1";
const cwd = mkdtempSync(join(tmpdir(), "cbw-attr-"));
const db = openDb(null);
const repo = new Repository(db);
const svc = new DomainService(repo);
const bus = new EventBus();
const adapter = new ClaudeCliAdapter();

test.after(() => {
  db.close();
  try { rmSync(cwd, { recursive: true, force: true }); } catch {}
});

test("live: events attributed to owner branch/turn + subagent tracked as AgentRun, not branch", { skip: !live }, async () => {
  const project = svc.createProject({ name: "attr", rootPath: cwd });
  const branch = svc.createRootConversation({ projectId: project.id, rootBranchName: "Main" });

  // collect events published to the bus during the turn
  const seen = [];
  const unsubscribe = bus.subscribe((ev) => seen.push(ev));

  const { sessionKey, session } = await startBranch(svc, bus, adapter, branch.id, cwd, {
    projectInstructions: "Terse; answer the single requested token only.",
  });
  assert.ok(session.externalSessionId, "external CLI session started");

  const node = svc.appendCompletedTurn({ branchId: branch.id, userContent: "execute", assistantContent: null });
  const prompt = [
    "Use the Glob tool once, then spawn ONE Explore subagent whose task is 'return immediately with OK'.",
    "After it returns, reply with ATTR_DONE and nothing else.",
  ].join(" ");
  await runTurn(svc, bus, adapter, sessionKey, branch.id, node.id, sessionKey, prompt);
  unsubscribe();

  // 1) every observed event belongs to THIS branch + THIS node
  assert.ok(seen.length > 0, "events observed");
  for (const ev of seen) {
    assert.equal(ev.branchId, branch.id, "owner branch");
    assert.equal(ev.nodeId, node.id, "owner node/turn");
  }

  // 2) a subagent completed under this turn (execution tree materialized)
  const tree = svc.getExecutionTree(branch.id, node.id);
  const subagents = [];
  const walk = (n) => { if (n.agentRun.type === "subagent") subagents.push(n.agentRun); for (const c of n.children) walk(c); };
  walk(tree.root);
  assert.ok(subagents.length >= 1, "at least one subagent under the turn");
  assert.equal(subagents[0].status, "completed", "subagent completed");

  // 3) transient AgentRuns are NOT branches
  assert.equal(repo.listBranchesByProject(project.id).length, 1, "no extra branches from subagents");
  assert.ok(svc.listAgentRunsByBranch(branch.id).length >= 2, "main + subagent runs recorded");

  await adapter.terminate(sessionKey);
});
