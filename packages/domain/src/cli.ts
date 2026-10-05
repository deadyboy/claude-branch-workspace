#!/usr/bin/env node
// Debug inspection CLI: read-only queries over a domain DB file.
//
//   node src/cli.ts <dbPath> projects
//   node src/cli.ts <dbPath> branches [--project <id>]
//   node src/cli.ts <dbPath> nodes <branchId>
//   node src/cli.ts <dbPath> tree <branchId>
//   node src/cli.ts <dbPath> ancestry <branchId>
//   node src/cli.ts <dbPath> snapshot <branchId>

import { openDb } from "./db.js";
import { Repository } from "./repository.js";
import { DomainService } from "./domain-services.js";

function usage(): never {
  console.error(`usage:
  cli <dbPath> projects
  cli <dbPath> branches [--project <id>]
  cli <dbPath> nodes <branchId>
  cli <dbPath> tree <branchId>
  cli <dbPath> ancestry <branchId>
  cli <dbPath> snapshot <branchId>`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length < 2) usage();
const [dbPath, cmd, ...rest] = args;

const db = openDb(dbPath);
const svc = new DomainService(new Repository(db));

switch (cmd) {
  case "projects": {
    for (const p of svc.listProjects()) {
      console.log(`PROJECT ${p.id}  ${p.name}  root=${p.rootPath ?? "-"}`);
    }
    break;
  }
  case "branches": {
    const wantProject = rest[0] === "--project" ? rest[1] : null;
    for (const b of svc.listProjects()) {
      if (wantProject && b.id !== wantProject) continue;
      for (const br of new Repository(db).listBranchesByProject(b.id)) {
        console.log(
          `BRANCH ${br.id}  ${br.displayName ?? "(unnamed)"}  parent=${br.parentBranchId ?? "-"}  ` +
            `forkFrom=${br.forkFromNodeId ?? "-"}  ${br.originStrategy}  ${br.status}`
        );
      }
    }
    break;
  }
  case "nodes": {
    const branchId = rest[0];
    if (!branchId) usage();
    for (const n of new Repository(db).listNodesByBranch(branchId)) {
      console.log(
        `NODE ${n.id}  branch=${n.branchId}  parent=${n.parentNodeId ?? "-"}  idx=${n.localTurnIndex}  ${n.status}`
      );
    }
    break;
  }
  case "tree": {
    const branchId = rest[0];
    if (!branchId) usage();
    const repo = new Repository(db);
    const svc2 = new DomainService(repo);
    const tree = svc2.getConversationTree(branchId);
    if (!tree) {
      console.log(`(empty branch ${branchId})`);
      break;
    }
    const label = (id: string) => {
      const n = repo.getNode(id)!;
      const msg = n.userMessageRef ? repo.getMessage(n.userMessageRef) : null;
      const text = (msg?.visibleContent ?? "").replace(/\s+/g, " ").slice(0, 60);
      return text ? `"${text}"` : id;
    };
    const walk = (n: typeof tree, indent: string): void => {
      console.log(
        `${indent}${label(n.id)} [#${n.localTurnIndex}]${n.children.length ? "" : "  /* leaf */"}`
      );
      for (const c of n.children) walk(c, indent + "  ");
    };
    walk(tree, "");
    break;
  }
  case "ancestry": {
    const branchId = rest[0];
    if (!branchId) usage();
    const a = svc.getBranchAncestry(branchId);
    console.log(`TARGET ${a.branch.id} "${a.branch.displayName ?? ""}"`);
    for (const anc of a.ancestors) {
      const fp = anc.forkPoint;
      console.log(
        `  ANC ${anc.branch.id} "${anc.branch.displayName ?? ""}"  forkAt=${fp ? `${fp.id} idx${fp.localTurnIndex}` : "-"}`
      );
    }
    console.log(`snapshot bounding on node ${a.snapshot?.forkFromNodeId ?? "(none)"}`);
    break;
  }
  case "snapshot": {
    const branchId = rest[0];
    if (!branchId) usage();
    const s = svc.getSnapshot(branchId);
    if (!s) {
      console.log(`(no snapshot for ${branchId})`);
      break;
    }
    console.log(`SNAPSHOT branch=${s.branchId} forkFrom=${s.forkFromNodeId} at=${s.createdAt}`);
    console.log(`  ancestors: ${s.ancestorNodeIds.length} nodes`);
    console.log(`  visible messages: ${s.visibleMessages.length}`);
    for (const m of s.visibleMessages.slice(-5)) {
      console.log(`    [${m.role}] ${m.content.replace(/\s+/g, " ").slice(0, 70)}`);
    }
    break;
  }
  default:
    usage();
}

db.close();
