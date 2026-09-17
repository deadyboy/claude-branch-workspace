// Phase 4 hard gates 13 + 15 (incl. reviewer B3).
// g13: runtime_sessions is the single authoritative mapping — a mapping written
//      before a "crash" survives reopen; branches never re-derive it.
// g15: on boot, a node left `pending` by a crash is reconciled to `cancelled`
//      (not failed), its orphan session `interrupted`, and (B3) orphaned
//      running/queued/needs_attention agent_runs are cancelled so the Agent
//      Monitor never shows permanently-busy cards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, Repository, DomainService } from "@cbw/domain";
import { reconcileOnBoot } from "../dist/reconcile.js";

function tmpDb() {
  const dir = mkdtempSync(join(tmpdir(), "cbw-restart-"));
  return { path: join(dir, "test.db"), dir };
}

test("g13/g15: runtime_sessions survives reopen; pending node + orphan session + orphan agent runs reconciled on boot", async () => {
  const { path, dir } = tmpDb();
  try {
    // ---- "crash" state ----
    const db1 = openDb(path);
    const svc1 = new DomainService(new Repository(db1));
    const p = svc1.createProject({ name: "p" });
    const main = svc1.createRootConversation({ projectId: p.id, rootBranchName: "Main" });

    // A turn left mid-flight: pending node + running session + running main run
    // (+ a running subagent run whose node is TERMINAL — B3 orphan case).
    const node = svc1.openTurn({ branchId: main.id, userContent: "half" });
    svc1.upsertRuntimeSession({
      id: "sess-1", branchId: main.id, adapterType: "claude-cli",
      externalSessionId: "ext-1", status: "running", lastSeenAt: new Date().toISOString(),
    });
    const mainRun = svc1.openAgentRun({ ownerBranchId: main.id, ownerNodeId: node.id, type: "main", name: "Main" });
    assert.equal(mainRun.status, "running");

    // A main run of a COMPLETED node, still erroneously "running" (orphan).
    const completedNode = svc1.completeTurn(svc1.openTurn({ branchId: main.id, userContent: "done" }).id, {
      assistantContent: "ok", status: "completed",
    });
    const orphanRun = svc1.openAgentRun({ ownerBranchId: main.id, ownerNodeId: completedNode.id, type: "main", name: "Main" });
    assert.equal(completedNode.status, "completed");
    assert.equal(orphanRun.status, "running");

    // Simulate crash (no completeTurn/cancelTurn ever called).
    db1.close();

    // ---- reboot ----
    const db2 = openDb(path);
    const svc2 = new DomainService(new Repository(db2));

    // g13: the runtime-session mapping survived (single fact source).
    const sess = svc2.getRuntimeSession("sess-1");
    assert.equal(sess.status, "running", "mapping persisted through reopen");

    // g15: reconcileOnBoot.
    const report = await reconcileOnBoot(svc2);
    assert.equal(report.cancelledNodes, 1, "the pending node cancelled");
    assert.equal(report.interruptedSessions, 1, "the orphan running session interrupted");
    assert.ok(report.cancelledOrphanRuns >= 1, "orphan agent run cancelled (B3)");

    // Node cancelled, not failed.
    assert.equal(svc2.getNode(node.id).status, "cancelled");
    // Session interrupted.
    assert.equal(svc2.getRuntimeSession("sess-1").status, "interrupted");
    // Both stale runs cancelled.
    assert.equal(svc2.getAgentRun(mainRun.id).status, "cancelled");
    assert.equal(svc2.getAgentRun(orphanRun.id).status, "cancelled");
    // A genuinely completed node is untouched.
    assert.equal(svc2.getNode(completedNode.id).status, "completed");

    db2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
