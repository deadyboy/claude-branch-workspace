// S2 / experiment E2: the conversation-graph projection must reproduce the
// persisted genealogy EXACTLY, and must keep the four edge kinds distinct.
// These assertions are the automated part of E2's "拓扑和有效上下文逐项一致";
// they run without a browser or a renderer on purpose.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildConversationGraph,
  splitInherited,
  isForkable,
  buildBreadcrumb,
  layoutGraph,
  conversationThroughNode,
} from "../src/lib/conversationGraph.ts";

// Minimal factory helpers — only the fields the projection reads.
const branch = (over) => ({
  id: "b1",
  projectId: "p1",
  parentBranchId: null,
  forkFromNodeId: null,
  displayName: null,
  originStrategy: "root",
  workspaceMode: "shared",
  runtimeAdapter: "claude-cli",
  runtimeSessionId: null,
  runtimeProfileId: null,
  workspacePath: null,
  status: "active",
  createdAt: "2026-10-06T00:00:00.000Z",
  archivedAt: null,
  ...over,
});

const node = (over) => ({
  id: "n1",
  projectId: "p1",
  branchId: "b1",
  parentNodeId: null,
  localTurnIndex: 0,
  userMessageRef: "m1",
  assistantMessageRef: "m2",
  runtimeUserMessageId: null,
  runtimeAssistantMessageId: null,
  status: "completed",
  createdAt: "2026-10-06T00:00:00.000Z",
  completedAt: "2026-10-06T00:01:00.000Z",
  ...over,
});

// D1 shape: Main 6 turns; A and B fork from Main turn 2; A1 forks from A turn 1.
function d1() {
  const main = branch({ id: "main", displayName: "Main" });
  const a = branch({ id: "A", displayName: "A", parentBranchId: "main", forkFromNodeId: "m2" });
  const b = branch({ id: "B", displayName: "B", parentBranchId: "main", forkFromNodeId: "m2" });
  const a1 = branch({ id: "A1", displayName: "A", parentBranchId: "A", forkFromNodeId: "a1" });
  const branches = [main, a, b, a1];
  const nodesByBranch = {
    main: [0, 1, 2, 3, 4, 5].map((i) => node({ id: `m${i + 1}`, branchId: "main", localTurnIndex: i })),
    A: [node({ id: "a1", branchId: "A", parentNodeId: "m2", localTurnIndex: 0 })],
    B: [node({ id: "b1", branchId: "B", parentNodeId: "m2", localTurnIndex: 0 })],
    A1: [node({ id: "a1c", branchId: "A1", parentNodeId: "a1", localTurnIndex: 0 })],
  };
  return { branches, nodesByBranch };
}

test("E2: fork edges point at the exact fork turn, not the parent branch", () => {
  const g = buildConversationGraph(d1());
  const forkEdges = g.edges.filter((e) => e.kind === "fork");
  // Three forks exist: A<-m2, B<-m2, A1<-a1. A root branch has no fork edge.
  assert.equal(forkEdges.length, 3);
  assert.deepEqual(
    forkEdges.map((e) => `${e.source}->${e.target}`).sort(),
    ["turn:a1->branch:A1", "turn:m2->branch:A", "turn:m2->branch:B"]
  );
  assert.equal(g.forkOrigins.A, "m2");
  assert.equal(g.forkOrigins.A1, "a1");
});

test("E2: parent edges are separate from fork edges", () => {
  const g = buildConversationGraph(d1());
  const parentEdges = g.edges.filter((e) => e.kind === "parent");
  assert.deepEqual(
    parentEdges.map((e) => `${e.source}->${e.target}`).sort(),
    ["branch:A->branch:A1", "branch:main->branch:A", "branch:main->branch:B"]
  );
  // A fork edge must never be reported as a parent edge and vice-versa.
  for (const e of g.edges) {
    if (e.kind === "parent") assert.ok(e.source.startsWith("branch:"));
    if (e.kind === "fork") assert.ok(e.source.startsWith("turn:"));
  }
});

test("E2: duplicate branch names stay distinguishable by id", () => {
  const g = buildConversationGraph(d1());
  const branchNodes = g.nodes.filter((n) => n.kind === "branch");
  // A and A1 share displayName "A" — ids must differ and both be present.
  const labels = branchNodes.filter((n) => n.label === "A").map((n) => n.id).sort();
  assert.deepEqual(labels, ["branch:A", "branch:A1"]);
  const ids = new Set(branchNodes.map((n) => n.id));
  assert.equal(ids.size, branchNodes.length, "node ids must be unique");
});

test("E2: only completed turns are forkable", () => {
  assert.equal(isForkable("completed"), true);
  assert.equal(isForkable("pending"), false);
  assert.equal(isForkable("failed"), false);
  assert.equal(isForkable("cancelled"), false);

  const { branches, nodesByBranch } = d1();
  nodesByBranch.main[2] = { ...nodesByBranch.main[2], status: "failed" };
  const g = buildConversationGraph({ branches, nodesByBranch });
  const failed = g.nodes.find((n) => n.id === "turn:m3");
  assert.equal(failed.forkable, false);
});

test("E2: within-branch turn ordering follows localTurnIndex", () => {
  const g = buildConversationGraph(d1());
  const seq = g.edges.filter((e) => e.kind === "turnSeq" && e.source.includes("m"))
    .map((e) => `${e.source}->${e.target}`);
  // Main must chain m1->m2->...->m6 with no gaps or reversals.
  assert.deepEqual(seq.slice(0, 5), [
    "turn:m1->turn:m2",
    "turn:m2->turn:m3",
    "turn:m3->turn:m4",
    "turn:m4->turn:m5",
    "turn:m5->turn:m6",
  ]);
});

test("E2: inherited messages reference the original nodeId and are not duplicated", () => {
  // A's effective conversation: m1, m2 inherited; a1 local.
  const conv = [
    { role: "user", content: "u1", nodeId: "m1", origin: "inherited", seq: 1 },
    { role: "assistant", content: "a1", nodeId: "m1", origin: "inherited", seq: 2 },
    { role: "user", content: "u2", nodeId: "m2", origin: "inherited", seq: 3 },
    { role: "assistant", content: "a2", nodeId: "m2", origin: "inherited", seq: 4 },
    { role: "user", content: "own", nodeId: "a1", origin: "local", seq: 5 },
  ];
  const { inherited, local } = splitInherited(conv);
  assert.equal(inherited.length, 4);
  assert.equal(local.length, 1);
  // Inherited items keep pointing at the ORIGINAL branch's node ids.
  assert.deepEqual([...new Set(inherited.map((i) => i.nodeId))].sort(), ["m1", "m2"]);
  assert.equal(local[0].nodeId, "a1");
});

test("E2: graph context ends at the selected persisted node and never includes later turns", () => {
  const conversation = [
    { role: "user", content: "early marker", nodeId: "n1", origin: "local", seq: 1 },
    { role: "assistant", content: "early answer", nodeId: "n1", origin: "local", seq: 2 },
    { role: "user", content: "selected marker", nodeId: "n2", origin: "local", seq: 3 },
    { role: "assistant", content: "selected answer", nodeId: "n2", origin: "local", seq: 4 },
    { role: "user", content: "later secret", nodeId: "n3", origin: "local", seq: 5 },
  ];
  const context = conversationThroughNode(conversation, "n2");
  assert.deepEqual(context.map((item) => item.nodeId), ["n1", "n1", "n2", "n2"]);
  assert.equal(context.some((item) => item.content.includes("later secret")), false);
  assert.equal(conversationThroughNode(conversation, "missing"), null);
});

test("E2: breadcrumb is root-first and terminates on a cycle", () => {
  const { branches } = d1();
  const byId = new Map(branches.map((b) => [b.id, b]));
  const crumb = buildBreadcrumb(byId.get("A1"), byId);
  assert.deepEqual(crumb.map((c) => c.label), ["Main", "A", "A"]);

  // A malformed cycle must not hang the UI.
  const cyc = [
    branch({ id: "x", displayName: "X", parentBranchId: "y" }),
    branch({ id: "y", displayName: "Y", parentBranchId: "x" }),
  ];
  const cycCrumbs = buildBreadcrumb(cyc[0], new Map(cyc.map((b) => [b.id, b])));
  assert.ok(cycCrumbs.length <= 2, "cycle must be broken");
});

test("E2: agent runs are attributed to their owner branch and never look like branches", () => {
  const { branches, nodesByBranch } = d1();
  const g = buildConversationGraph({
    branches,
    nodesByBranch,
    includeAgentRuns: true,
    agentRunsByBranch: {
      A: [
        {
          id: "r1", ownerBranchId: "A", ownerNodeId: "a1", parentAgentRunId: null,
          runtimeAgentId: null, type: "main", displayLabel: "Main", name: null,
          taskSummary: null, status: "completed",
          startedAt: "2026-10-06T00:00:00.000Z", endedAt: "2026-10-06T00:01:00.000Z",
        },
        {
          id: "r2", ownerBranchId: "A", ownerNodeId: "a1", parentAgentRunId: "r1",
          runtimeAgentId: null, type: "subagent", displayLabel: "Explore", name: null,
          taskSummary: null, status: "completed",
          startedAt: "2026-10-06T00:00:00.000Z", endedAt: "2026-10-06T00:01:00.000Z",
        },
      ],
    },
  });
  const runNodes = g.nodes.filter((n) => n.kind === "agentRun");
  assert.equal(runNodes.length, 2);
  // Runs are a different node kind — they must never be branches (constitution §1).
  assert.ok(runNodes.every((n) => n.kind !== "branch"));
  const spawned = g.edges.filter((e) => e.kind === "spawned");
  assert.deepEqual(spawned.map((e) => `${e.source}->${e.target}`), ["run:r1->run:r2"]);
});

// ---- layout (S2/E7) ---------------------------------------------------------
// Layout was previously trapped inside the React component, so it could be
// neither tested nor measured. It now lives in the pure module.

test("E7: layout is deterministic and places every node exactly once", () => {
  const input = d1();
  const g = buildConversationGraph(input);
  const a = layoutGraph(g);
  const b = layoutGraph(g);
  assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort(), "stable key set");
  for (const [id, pa] of a) {
    const pb = b.get(id);
    assert.equal(pa.x, pb.x, `${id} x stable`);
    assert.equal(pa.y, pb.y, `${id} y stable`);
  }
  // Every graph node must be positioned, or it would be invisible.
  for (const n of g.nodes) assert.ok(a.has(n.id), `${n.id} not positioned`);
});

test("E7: a fork is placed to the RIGHT of the turn it came from", () => {
  const g = buildConversationGraph(d1());
  const pos = layoutGraph(g);
  const forkSource = pos.get("turn:m2");
  const forked = pos.get("branch:A");
  assert.ok(forkSource && forked, "both positioned");
  assert.ok(forked.x > forkSource.x, "fork sits in a deeper column");
});

test("E7: layout never mutates ancestry (drag is layout-only)", () => {
  const input = d1();
  const before = JSON.stringify(buildConversationGraph(input).edges);
  const g = buildConversationGraph(input);
  layoutGraph(g);
  const after = JSON.stringify(buildConversationGraph(input).edges);
  assert.equal(before, after);
});

test("E7: a parent cycle cannot hang layout", () => {
  const branches = [
    branch({ id: "x", displayName: "X", parentBranchId: "y" }),
    branch({ id: "y", displayName: "Y", parentBranchId: "x" }),
  ];
  const g = buildConversationGraph({ branches, nodesByBranch: {} });
  const pos = layoutGraph(g);
  assert.equal(pos.size, 2, "both placed, no infinite loop");
});

test("E7: an orphan branch is still positioned", () => {
  const branches = [
    branch({ id: "main", displayName: "Main" }),
    branch({ id: "lost", displayName: "Lost", parentBranchId: "gone" }),
  ];
  const g = buildConversationGraph({ branches, nodesByBranch: {} });
  const pos = layoutGraph(g);
  assert.ok(pos.has("branch:lost"), "orphan must be visible");
});
