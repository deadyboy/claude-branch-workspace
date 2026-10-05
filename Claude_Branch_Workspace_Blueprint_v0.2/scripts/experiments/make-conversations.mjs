#!/usr/bin/env node
// D1/D2/D3 conversation fixtures (plan doc 13 §4.2). Writes real rows into a
// domain SQLite DB through @cbw/domain's DomainService (no hand-written SQL),
// and emits truth.json — the node/edge relation listing that E2 checks against.
//
// Purely additive experiment scaffolding. Does NOT touch product code.
//
// Usage:
//   node scripts/experiments/make-conversations.mjs \
//     --dataset d1|d2|d3 [--db <path>] [--seed N] [--out <dir>]
//
// Reproducibility guarantee: the STRUCTURE (which branch forks from which node,
// parent/child links, per-branch turn counts) is fully determined by (dataset,
// seed) via a fixed PRNG. Node/branch IDs come from the domain layer's UUIDs,
// so they differ per run; truth.json records the ACTUAL persisted IDs. The
// generator re-reads everything from the DB to build truth, so truth.json can
// never disagree with what was written.

import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------- args ----------
function parseArgs(argv) {
  const out = { dataset: "d1", seed: 20261006 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dataset") out.dataset = argv[++i];
    else if (a.startsWith("--dataset=")) out.dataset = a.slice("--dataset=".length);
    else if (a === "--db") out.db = argv[++i];
    else if (a.startsWith("--db=")) out.db = a.slice("--db=".length);
    else if (a === "--seed") out.seed = Number(argv[++i]);
    else if (a.startsWith("--seed=")) out.seed = Number(a.slice("--seed=".length));
    else if (a === "--out") out.out = argv[++i];
    else if (a.startsWith("--out=")) out.out = a.slice("--out=".length);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!["d1", "d2", "d3"].includes(out.dataset)) {
    throw new Error(`--dataset must be d1|d2|d3, got ${out.dataset}`);
  }
  if (!Number.isInteger(out.seed)) throw new Error(`--seed must be an integer`);
  return out;
}

// ---------- deterministic PRNG (mulberry32) ----------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (rng, n) => Math.floor(rng() * n);
const pick = (rng, arr) => arr[randInt(rng, arr.length)];

// ---------- domain import (built dist) ----------
const domainDist = resolve(import.meta.dirname, "../../packages/domain/dist/index.js");
if (!existsSync(domainDist)) {
  console.error(
    `@cbw/domain is not built (missing ${domainDist}).\n` +
    `Run: pnpm --filter @cbw/domain build`
  );
  process.exit(2);
}
const { openDb, Repository, DomainService } = await import(pathToFileURL(domainDist).href);

// ---------- helpers ----------
const toPosix = (p) => resolve(p).split(/[\\/]/).join("/");

// Branch display-name pool (deterministic; a handful are deliberately reused
// so "same name, different identity" is exercised — constitution §2.4/§2.5).
const NAME_POOL = [
  "analysis", "refactor", "docs", "perf", "bugfix", "research", "cleanup",
  "feature", "spike", "review",
];

function nameFor(i) {
  return NAME_POOL[i % NAME_POOL.length];
}

/**
 * Plan per-branch turn counts: length = branchCount, each >= 1, summing to
 * totalTurns. count[0] is the root branch. Deterministic under (seed, size).
 */
function planTurnCounts(rng, branchCount, totalTurns) {
  if (branchCount > totalTurns) {
    throw new Error(`cannot make ${branchCount} branches with only ${totalTurns} turns (each needs >=1)`);
  }
  const counts = new Array(branchCount).fill(1);
  let remaining = totalTurns - branchCount;
  // Distribute the remainder in random chunks.
  while (remaining > 0) {
    const idx = randInt(rng, branchCount);
    const add = 1 + randInt(rng, Math.min(6, remaining));
    counts[idx] += add;
    remaining -= add;
  }
  return counts;
}

function turnContent(kind, branchName, i) {
  return {
    user: `[${kind}/${branchName}] turn ${i}: synthetic prompt for offline layout/perf fixture.`,
    assistant:
      `[${kind}/${branchName}] turn ${i}: synthetic deterministic reply ` +
      `(no model call; performance/layout fixture only).`,
  };
}

// ---------- D1: small, explicit topology ----------
/**
 * Main 6 turns; from Main turn 2 fork A and B (SAME display name); from A turn 1
 * fork A1. Main keeps turns 3-6. Total 11 unique turns.
 */
function buildD1(svc, projectId, rng) {
  const main = svc.createRootConversation({ projectId, rootBranchName: "Main" });
  const mainNodes = [];
  for (let i = 1; i <= 6; i++) {
    const c = turnContent("main", "Main", i);
    mainNodes.push(svc.appendCompletedTurn({ branchId: main.id, userContent: c.user, assistantContent: c.assistant }));
  }
  const forkAtMainTurn2 = mainNodes[1]; // "第 2 轮" == localTurnIndex 1

  const a = svc.createBranchFromNode({
    projectId, forkFromNodeId: forkAtMainTurn2.id, displayName: "research",
  });
  const aNodes = [];
  for (let i = 1; i <= 2; i++) {
    const c = turnContent("A", "A", i);
    aNodes.push(svc.appendCompletedTurn({ branchId: a.id, userContent: c.user, assistantContent: c.assistant }));
  }

  const b = svc.createBranchFromNode({
    projectId, forkFromNodeId: forkAtMainTurn2.id, displayName: "research", // SAME name as A
  });
  const bNodes = [];
  for (let i = 1; i <= 2; i++) {
    const c = turnContent("B", "B", i);
    bNodes.push(svc.appendCompletedTurn({ branchId: b.id, userContent: c.user, assistantContent: c.assistant }));
  }

  const a1 = svc.createBranchFromNode({
    projectId, forkFromNodeId: aNodes[0].id, displayName: "deep-dive", // "A 第 1 轮" -> A1
  });
  const a1Nodes = [];
  {
    const c = turnContent("A1", "A1", 1);
    a1Nodes.push(svc.appendCompletedTurn({ branchId: a1.id, userContent: c.user, assistantContent: c.assistant }));
  }

  return {
    rootBranchId: main.id,
    expected: {
      description: "Main 6 turns; Main turn2 forks A and B (same display name 'research'); A turn1 forks A1.",
      main: { branchId: main.id, localTurnIndexes: mainNodes.map((n) => n.localTurnIndex) },
      forkAtMainTurn2: forkAtMainTurn2.id,
      branches: {
        A: { branchId: a.id, displayName: "research", parentBranchId: main.id, forkFromNodeId: forkAtMainTurn2.id, turnCount: aNodes.length },
        B: { branchId: b.id, displayName: "research", parentBranchId: main.id, forkFromNodeId: forkAtMainTurn2.id, turnCount: bNodes.length },
        A1: { branchId: a1.id, displayName: "deep-dive", parentBranchId: a.id, forkFromNodeId: aNodes[0].id, turnCount: a1Nodes.length },
      },
      duplicateName: ["A", "B"],
      invariants: [
        "A and B share forkFromNodeId == Main turn 2 node.",
        "A1 forkFromNodeId == A turn 1 node.",
        "Effective conversation of A inherits exactly Main turns 1-2 (not 3-6).",
      ],
    },
  };
}

// ---------- D2/D3: deterministic random tree ----------
/**
 * Build a forest of `branchCount` branches (root + child branches) totalling
 * `totalTurns` unique turns. Each non-root branch forks from a random completed
 * node of an already-existing branch, then appends its own turns. Depth is
 * emergent (branches may fork from branches), so the graph is not a flat star.
 */
function buildTree(svc, projectId, rng, branchCount, totalTurns, duplicateNames) {
  const counts = planTurnCounts(rng, branchCount, totalTurns);

  const root = svc.createRootConversation({ projectId, rootBranchName: "Main" });
  const branchInfo = []; // { id, name, parentBranchId, forkFromNodeId, nodeIds: [] }
  branchInfo.push({ id: root.id, name: "Main", parentBranchId: null, forkFromNodeId: null, nodeIds: [] });

  for (let i = 1; i <= counts[0]; i++) {
    const c = turnContent("main", "Main", i);
    branchInfo[0].nodeIds.push(
      svc.appendCompletedTurn({ branchId: root.id, userContent: c.user, assistantContent: c.assistant }).id
    );
  }

  // Force a few duplicate display names (positions 1..dup in the child range).
  const dup = Math.min(duplicateNames, branchCount - 1);

  for (let bi = 1; bi < branchCount; bi++) {
    const parentIdx = randInt(rng, bi); // some earlier branch
    const parent = branchInfo[parentIdx];
    const forkNodeId = pick(rng, parent.nodeIds);
    const name = bi <= dup ? nameFor(bi % 2) : nameFor(bi);

    const child = svc.createBranchFromNode({
      projectId, forkFromNodeId: forkNodeId, displayName: name,
    });
    const info = {
      id: child.id, name, parentBranchId: parent.id,
      forkFromNodeId: forkNodeId, nodeIds: [],
    };
    branchInfo.push(info);

    for (let i = 1; i <= counts[bi]; i++) {
      const c = turnContent("b", name, i);
      info.nodeIds.push(
        svc.appendCompletedTurn({ branchId: child.id, userContent: c.user, assistantContent: c.assistant }).id
      );
    }
  }

  return { rootBranchId: root.id, branchInfo };
}

// ---------- main ----------
function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 15)}-${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0")}`;
  const out = resolve(args.out ?? join("F:\\CodexTemp\\cbw-ui-x", `conv-${args.dataset}-${runId}`));
  if (existsSync(out) && readdirSync(out).length > 0) {
    throw new Error(`output dir already exists and is not empty: ${out}`);
  }
  mkdirSync(out, { recursive: true });

  const dbPath = resolve(args.db ?? join(out, `${args.dataset}.db`));
  if (existsSync(dbPath)) rmSync(dbPath, { force: true });

  const db = openDb(dbPath);
  const repo = new Repository(db);
  const svc = new DomainService(repo);

  const project = svc.createProject({
    name: `CBW ${args.dataset.toUpperCase()} conversation fixture`,
    rootPath: null,
  });

  const rng = mulberry32(args.seed);
  const t0 = Date.now();

  let rootBranchId;
  let d1extra = null;
  let duplicateNamesForced = 0;

  if (args.dataset === "d1") {
    const r = buildD1(svc, project.id, rng);
    rootBranchId = r.rootBranchId;
    d1extra = r.expected;
    duplicateNamesForced = 2;
  } else if (args.dataset === "d2") {
    const r = buildTree(svc, project.id, rng, 20, 100, 4);
    rootBranchId = r.rootBranchId;
    duplicateNamesForced = 4;
  } else {
    const r = buildTree(svc, project.id, rng, 100, 1000, 10);
    rootBranchId = r.rootBranchId;
    duplicateNamesForced = 10;
  }

  const elapsedMs = Date.now() - t0;

  // ---- read everything back from the DB to form truth ----
  const branches = svc.listBranches(project.id);
  const branchRows = [];
  const nodeRows = [];
  const forkEdges = [];
  let uniqueTurnCount = 0;

  for (const br of branches) {
    const nodes = repo.listNodesByBranch(br.id);
    uniqueTurnCount += nodes.length;
    branchRows.push({
      id: br.id,
      displayName: br.displayName,
      parentBranchId: br.parentBranchId,
      forkFromNodeId: br.forkFromNodeId,
      workspaceMode: br.workspaceMode,
      originStrategy: br.originStrategy,
      status: br.status,
      nodeCount: nodes.length,
    });
    if (br.forkFromNodeId) {
      forkEdges.push({ branchId: br.id, parentBranchId: br.parentBranchId, forkFromNodeId: br.forkFromNodeId });
    }
    for (const n of nodes) {
      nodeRows.push({
        id: n.id,
        branchId: n.branchId,
        parentNodeId: n.parentNodeId,
        localTurnIndex: n.localTurnIndex,
        status: n.status,
      });
    }
  }

  const truth = {
    schema: "cbw.experiments.conversations/v1",
    dataset: args.dataset,
    seed: args.seed,
    createdAt: new Date().toISOString(),
    generatedBy: "scripts/experiments/make-conversations.mjs",
    db: toPosix(dbPath),
    projectId: project.id,
    rootBranchId,
    stats: {
      branchCount: branches.length,
      uniqueTurnCount,
      duplicateNamesForced,
      distinctDisplayNames: new Set(branchRows.map((b) => b.displayName)).size,
      elapsedMs,
    },
    // ---- relation truth (E2 compares the UI/topology against these) ----
    branches: branchRows,
    nodes: nodeRows,
    forkEdges,
  };
  if (d1extra) truth.d1 = d1extra;

  writeFileSync(join(out, "truth.json"), JSON.stringify(truth, null, 2) + "\n");

  db.close();

  // ---- summary ----
  console.log(`=== CBW conversations (${args.dataset}) ===`);
  console.log(`db           : ${toPosix(dbPath)}`);
  console.log(`truth        : ${toPosix(join(out, "truth.json"))}`);
  console.log(`projectId    : ${project.id}`);
  console.log(`seed         : ${args.seed}`);
  console.log(`branches     : ${truth.stats.branchCount}`);
  console.log(`unique turns : ${truth.stats.uniqueTurnCount}`);
  console.log(`distinct names: ${truth.stats.distinctDisplayNames} (duplicates forced: ${duplicateNamesForced})`);
  console.log(`elapsed      : ${elapsedMs} ms`);
}

try {
  main();
} catch (e) {
  console.error("CONVERSATION ERROR:", e.message);
  process.exitCode = 1;
}
