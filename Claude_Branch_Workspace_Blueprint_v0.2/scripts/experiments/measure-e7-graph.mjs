// E7 (M1 part): measure graph projection + layout cost on D2/D3.
//
// The plan's M1 target: D2 (20 branches / 100 turns) must go from graph data
// arriving to OPERABLE in under 1 second; D3 (100 branches / 1000 turns) in
// under 3 seconds. Model latency is NOT counted — this measures only the pure
// projection and layout, which is what a renderer would have to do.
//
// This is deliberately renderer-free: the plan requires measuring before
// locking in a dependency, so the numbers below are the baseline a library
// must beat, and they hold whether or not one is ever adopted.

import { readFile } from "node:fs/promises";
import { buildConversationGraph } from "../../apps/web/src/lib/conversationGraph.ts";

const [truthPath, apiBase] = process.argv.slice(2);
if (!truthPath || !apiBase) {
  console.error("usage: measure-e7-graph.mjs <truth.json> <apiBase>");
  process.exit(2);
}

const truth = JSON.parse(await readFile(truthPath, "utf8"));
const projectId = truth.projectId;

async function get(path) {
  const res = await fetch(`${apiBase}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// Warm-up once, then measure 5 loads (the plan asks for warm-up + 5 runs).
const branches = await get(`/api/projects/${projectId}/branches`);
const nodesByBranch = {};
for (const b of branches) {
  nodesByBranch[b.id] = await get(`/api/branches/${b.id}/nodes`);
}
const agentRunsByBranch = {};
for (const b of branches) {
  try {
    agentRunsByBranch[b.id] = await get(`/api/branches/${b.id}/agent-runs`);
  } catch {
    agentRunsByBranch[b.id] = [];
  }
}

const input = { branches, nodesByBranch, agentRunsByBranch, includeAgentRuns: true };
buildConversationGraph(input); // warm-up

const samples = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  const g = buildConversationGraph(input);
  const t1 = performance.now();
  samples.push(t1 - t0);
  if (i === 0) {
    var lastCounts = { nodes: g.nodes.length, edges: g.edges.length };
  }
}

const turnCount = Object.values(nodesByBranch).flat().length;
const budgetMs = branches.length <= 25 ? 1000 : 3000;
const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)];

console.log(`dataset      : ${truth.dataset}`);
console.log(`branches     : ${branches.length}`);
console.log(`turns        : ${turnCount}`);
console.log(`graph nodes  : ${lastCounts.nodes}, edges: ${lastCounts.edges}`);
console.log(`projection ms: [${samples.map((s) => s.toFixed(2)).join(", ")}]`);
console.log(`median ms    : ${median.toFixed(2)}`);
console.log(`budget ms    : ${budgetMs} (${branches.length <= 25 ? "D2 class" : "D3 class"})`);
console.log(`RESULT       : ${median <= budgetMs ? "PASS" : "FAIL"}`);
process.exit(median <= budgetMs ? 0 : 1);
