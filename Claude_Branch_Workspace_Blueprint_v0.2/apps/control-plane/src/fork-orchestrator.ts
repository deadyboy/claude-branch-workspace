// ForkOrchestrator: implements hard gate 1 (FROZEN fork semantics) inside the
// POST /api/branches handler, BEFORE responding.
//
// Overview (reviewer B2 fix):
//   1. `svc.createBranchFromNode` persists the branch + an IMMUTABLE
//      reconstruction snapshot (captureBranchContext) captured at creation.
//   2. The child session is then bound EAGERLY, exactly once, by this
//      orchestrator, through the SessionManager (sole writer, gate 13):
//        - native_head_fork when the fork node IS the parent's current head AND
//          the parent session is materialized → adapter.forkFromHead
//          (monotonic --session-id binding: later parent progress cannot leak)
//        - otherwise → adapter.reconstructBranchFromHistory(frozen snapshot)
//          (snapshot-driven; the parent never needs to be alive)
//   3. SessionManager.adoptSession registers the child so its FIRST turn
//      resolves without re-seeding (the lazy materialization path is restricted
//      to root/import branches — resume/restart — , so the two mechanisms can
//      never double-fire on this fork).
//
// The child's conversation is later derived from the persisted snapshot/rows,
// never the live parent — parent T3-T5 can never leak into the child (gate 1).
// Reconstruction (gate 2, reviewer R1): content-only, side-effect-free; the
// seed prompt is wrapped in a transcript-acknowledgement frame (no content is
// interpreted as a command) and the adapter-level test asserts ZERO tool_use.

import { randomUUID } from "node:crypto";
import type { DomainService, BranchContextSnapshot, Branch } from "@cbw/domain";
import type { RuntimeAdapter } from "@cbw/runtime";
import type { SessionManager } from "./session-manager.js";

// Transcript-acknowledgement frame (gate 2 R1): wraps the snapshot transcript
// so the seed turn treats past content as prior context — never as commands to
// re-execute (reconstruction is side-effect-free by construction).
export const TRANSCRIPT_ACK =
  "You are reconstructing a session from its prior conversation transcript, " +
  "included below. Do NOT re-run any command, tool, or file write it describes; " +
  "treat it as read-only context. Acknowledge and await instructions.";

export interface CreateForkArgs {
  projectId: string;
  forkFromNodeId: string;
  displayName?: string | null;
  cwd?: string | null;
  workspaceMode?: "shared" | "worktree";
}

export interface CreateForkResult {
  branch: Branch;
  snapshot: BranchContextSnapshot | null;
  sessionKey: string | null; // null when a lazy root was created (no seed yet)
  strategy: "native_head_fork" | "replay_reconstruction" | "lazy_root";
}

export class ForkOrchestrator {
  constructor(
    private readonly svc: DomainService,
    private readonly sessionManager: SessionManager,
    private readonly adapter: RuntimeAdapter
  ) {}

  /**
   * Create a branch anchored to `forkFromNodeId` (gate 1), freezing its session
   * BEFORE returning. Root (no fork node) → lazy root, no freeze yet.
   */
  async createFork(args: CreateForkArgs): Promise<CreateForkResult> {
    const forkNode = args.forkFromNodeId ? this.svc.getNode(args.forkFromNodeId) : null;
    if (args.forkFromNodeId && !forkNode) {
      throw new Error(`fork node ${args.forkFromNodeId} not found`);
    }
    if (!forkNode && args.forkFromNodeId === undefined) {
      // Root creation — handled by the caller with createRootConversation; this
      // class only orchestrates node-anchored forks.
      throw new Error("fork-orchestrator requires a forkFromNodeId");
    }

    // (1) Persist the branch + immutable snapshot at creation (reviewer B2).
    const branch = this.svc.createBranchFromNode({
      projectId: args.projectId,
      forkFromNodeId: args.forkFromNodeId,
      displayName: args.displayName ?? null,
      originStrategy: "replay_reconstruction", // set by strategy dispatch below if upgraded
      workspaceMode: args.workspaceMode ?? "shared",
    });
    const snapshot = this.svc.getBranchAncestry(branch.id).snapshot;

    // (2) Strategy dispatch + EAGER freeze (post-create so svc.commitBranch is done)
    const parentBranch = branch.parentBranchId ? this.svc.getBranch(branch.parentBranchId) : null;
    const parentHead = parentBranch ? this.svc.lastNode(parentBranch.id) : null;
    const parentState = parentBranch ? this.sessionManager.getState(parentBranch.id) : null;
    const isHeadFork =
      parentBranch &&
      parentHead &&
      forkNode &&
      parentHead.id === forkNode.id &&
      parentState !== null;

    let sessionKey: string | null = null;
    let strategy: CreateForkResult["strategy"] = "replay_reconstruction";

    if (isHeadFork) {
      // Native head fork — freeze NOW (monotonic --session-id: parent progress
      // after this instant cannot leak into the child).
      strategy = "native_head_fork";
      const childSession = await this.adapter.forkFromHead(parentState.sessionKey, {
        newSessionId: this.newChildId(),
        cwd: args.cwd ?? undefined,
      });
      const adopted = this.sessionManager.adoptSession(branch.id, childSession);
      sessionKey = adopted.sessionKey;
    } else {
      // Historical/unknown-head fork → immutable reconstruction snapshot
      // (gate 1: anchored at creation; parent never needs to be alive).
      if (!snapshot) throw new Error("fork requires a reconstruction snapshot");
      const seed = snapshot.visibleMessages
        .map((m) => m.content)
        .join("\n\n");
      const seedPrompt = seed
        ? `${TRANSCRIPT_ACK}\n\n--- prior transcript ---\n${seed}`
        : TRANSCRIPT_ACK;
      // Gate 2 (reviewer BLOCKER fox): the ack-wrapped seed is the ONLY thing
      // the adapter may feed as the fresh session's opening prompt — old
      // transcript content is read-only prior context, never a command to
      // re-run.
      const childSession = await this.adapter.reconstructBranchFromHistory(
        {
          visibleMessages: snapshot.visibleMessages,
          projectInstructions: null,
        },
        { newSessionId: this.newChildId(), cwd: args.cwd ?? undefined, seedText: seedPrompt }
      );
      const adopted = this.sessionManager.adoptSession(branch.id, childSession);
      sessionKey = adopted.sessionKey;
    }

    return { branch, snapshot, sessionKey, strategy };
  }

  private newChildId(): string {
    return `fork-${randomUUID()}`;
  }
}
