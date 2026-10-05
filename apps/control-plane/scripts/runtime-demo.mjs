#!/usr/bin/env node
// Phase 3 demo: one branch, one task that uses a tool call and spawns a
// subagent — observed through the production control-plane pipeline
// (startBranch + runTurn -> observer -> EventBus + domain DB) and printed as
// a persisted-events digest + execution tree. Requires a live gateway: run
// with CBW_LIVE=1.
import { openDb, Repository, DomainService } from "@cbw/domain";
import { EventBus } from "@cbw/event-protocol";
import { ClaudeCliAdapter } from "@cbw/runtime";
import { startBranch, runTurn } from "../dist/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const live = process.env.CBW_LIVE === "1";
if (!live) {
  console.log("SKIP: live gateway required (run with CBW_LIVE=1)");
  process.exit(0);
}

const cwd = mkdtempSync(join(tmpdir(), "cbw-demo-"));
const db = openDb(null); // in-memory control-plane store
const repo = new Repository(db);
const svc = new DomainService(repo);
const bus = new EventBus();
const busLog = [];
bus.subscribe((ev) => busLog.push(ev));

const adapter = new ClaudeCliAdapter();

const project = svc.createProject({ name: "demo", rootPath: cwd });
const branch = svc.createRootConversation({ projectId: project.id, rootBranchName: "Main" });
console.log("project:", project.id.slice(0, 8), "branch:", branch.id.slice(0, 8));

// Production session start (wires runtime_sessions mapping + returns sessionKey).
const { sessionKey, session } = await startBranch(svc, bus, adapter, branch.id, cwd, {
  projectInstructions: "You are in a Phase 3 demo. Be terse.",
});
console.log("session:", session.externalSessionId);

// Record the first turn (node) in the domain to own the events.
const node = svc.appendCompletedTurn({
  branchId: branch.id,
  userContent: "Run a demo task: use a tool, then spawn one Explore subagent, then answer DONE.",
  assistantContent: null,
});

// Run one turn through the production pipeline (startBranch's sessionKey is the
// FK-resolvable runtime_sessions.id).
const text = [
  "Phase 3 task. Use the Glob tool once, then spawn ONE Explore subagent whose task is 'return immediately with answer OK'.",
  "After the subagent returns, reply with DONE and nothing else.",
].join(" ");
const canonical = await runTurn(svc, bus, adapter, sessionKey, branch.id, node.id, sessionKey, text);
console.log(`  observed canonical events: ${canonical.length}`);

// Digest from the persisted events (the DB is the source for the execution tree).
const evs = svc.listEventsByBranch(branch.id);
console.log(`\n== persisted events: ${evs.length} ==`);
for (const e of evs) {
  const p = JSON.parse(e.payloadJsonRedacted);
  const attrs = [`node=${e.nodeId ? "y" : "-"}`, `run=${e.agentRunId ? "y" : "-"}`];
  console.log(`  [${e.type}]${e.status ? " (" + e.status + ")" : ""} ${attrs.join(" ")} ${Object.keys(p).length ? JSON.stringify(p) : ""}`);
}

const tree = svc.getExecutionTree(branch.id, node.id);
console.log(`\n== execution tree (owner node ${node.id.slice(0, 8)}...) ==`);
const walk = (n, d) => {
  console.log("  ".repeat(d) + `* ${n.agentRun.type}${n.agentRun.name ? ":" + n.agentRun.name : ""} [${n.agentRun.status}] ${n.agentRun.taskSummary ?? ""}`);
  for (const c of n.children) walk(c, d + 1);
};
walk(tree.root, 0);

const branches = repo.listBranchesByProject(project.id).length;
console.log(`\nbranches in registry: ${branches} (must stay 1; AgentRuns are transient)`);
console.log("demo OK");

await Promise.all([adapter.terminate(sessionKey)]);
db.close();
try { rmSync(cwd, { recursive: true, force: true }); } catch {}
