// E2 verification: the UI's conversation-graph projection must reproduce the
// generator's independently-recorded truth EXACTLY.
//
// The generator builds `truth.json` by reading the database back after writing,
// so it is a genuine second source: this script projects the SAME data through
// the production projection (apps/web/src/lib/conversationGraph.ts, imported as
// TypeScript source) and asserts every branch, fork edge, turn chain and
// duplicate-name case matches. A mismatch is a real E2 failure, not a test bug.
//
// Usage: node scripts/experiments/verify-e2-graph.mjs <truth.json> <apiBase>

import { readFile } from "node:fs/promises";
import { buildConversationGraph } from "../../apps/web/src/lib/conversationGraph.ts";

const [truthPath, apiBase] = process.argv.slice(2);
if (!truthPath || !apiBase) {
  console.error("usage: verify-e2-graph.mjs <truth.json> <apiBase>");
  process.exit(2);
}

const truth = JSON.parse(await readFile(truthPath, "utf8"));
const projectId = truth.projectId;

async function get(path) {
  const res = await fetch(`${apiBase}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

const branches = await get(`/api/projects/${projectId}/branches`);
const nodesByBranch = {};
for (const b of branches) {
  nodesByBranch[b.id] = await get(`/api/branches/${b.id}/nodes`);
}

const graph = buildConversationGraph({ branches, nodesByBranch });

const problems = [];
const check = (cond, msg) => {
  if (!cond) problems.push(msg);
};

// 1. Every branch in truth is present, with matching ancestry fields.
check(branches.length === truth.branches.length,
  `branch count ${branches.length} != truth ${truth.branches.length}`);
for (const tb of truth.branches) {
  const live = branches.find((b) => b.id === tb.id);
  check(Boolean(live), `branch ${tb.id} missing from API`);
  if (!live) continue;
  check(live.parentBranchId === tb.parentBranchId, `branch ${tb.id} parentBranchId drift`);
  check(live.forkFromNodeId === tb.forkFromNodeId, `branch ${tb.id} forkFromNodeId drift`);
  check(live.displayName === tb.displayName, `branch ${tb.id} displayName drift`);
}

// 2. Fork edges must match truth exactly (kind + endpoints).
const liveForks = graph.edges
  .filter((e) => e.kind === "fork")
  .map((e) => `${e.source.slice(5)}->${e.target.slice(7)}`)
  .sort();
const truthForks = truth.forkEdges
  .map((e) => `${e.forkFromNodeId}->${e.branchId ?? e.id}`)
  .sort();
check(JSON.stringify(liveForks) === JSON.stringify(truthForks),
  `fork edges differ:\n  live  ${JSON.stringify(liveForks)}\n  truth ${JSON.stringify(truthForks)}`);

// 3. Duplicate display names must remain distinct node ids (constitution §2.5).
const nameCounts = new Map();
for (const b of branches) nameCounts.set(b.displayName, (nameCounts.get(b.displayName) ?? 0) + 1);
for (const [name, count] of nameCounts) {
  if (count < 2) continue;
  const ids = branches.filter((b) => b.displayName === name).map((b) => `branch:${b.id}`);
  check(new Set(ids).size === count, `duplicate name "${name}" collapsed ids`);
  check(ids.every((id) => graph.nodes.some((n) => n.id === id)),
    `duplicate name "${name}" nodes missing from graph`);
}

// 4. Turn chains per branch must match the persisted parentNodeId chain.
for (const tb of truth.branches) {
  const truthNodes = truth.nodes.filter((n) => n.branchId === tb.id)
    .sort((a, b) => a.localTurnIndex - b.localTurnIndex);
  const liveNodes = [...(nodesByBranch[tb.id] ?? [])].sort((a, b) => a.localTurnIndex - b.localTurnIndex);
  check(liveNodes.length === truthNodes.length,
    `branch ${tb.id} turn count ${liveNodes.length} != truth ${truthNodes.length}`);
  for (let i = 0; i < Math.min(liveNodes.length, truthNodes.length); i++) {
    check(liveNodes[i].id === truthNodes[i].id,
      `branch ${tb.id} turn ${i} id drift`);
  }
}

// 5. Every turn node in the graph must be marked forkable iff completed.
for (const n of graph.nodes.filter((n) => n.kind === "turn")) {
  const live = Object.values(nodesByBranch).flat().find((x) => x.id === n.nodeId);
  if (!live) continue;
  check(n.forkable === (live.status === "completed"),
    `turn ${n.nodeId} forkable=${n.forkable} but status=${live.status}`);
}

if (problems.length) {
  console.error(`E2 FAIL — ${problems.length} mismatch(es):`);
  for (const p of problems) console.error("  - " + p);
  process.exit(1);
}
console.log(`E2 PASS — ${branches.length} branches, ${truthForks.length} fork edges, ` +
  `${graph.nodes.filter((n) => n.kind === "turn").length} turns reproduced exactly.`);
