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
import type { WorkspaceManager } from "./workspace-manager.js";
import type { TurnScheduler } from "./turn-scheduler.js";

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
    private readonly adapter: RuntimeAdapter,
    private readonly workspaceManager?: WorkspaceManager,
    private readonly scheduler?: TurnScheduler
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

    // A completed turn releases the in-memory state, but its persisted mapping
    // is still a safe identity for the same parent session. Re-register that
    // mapping before selecting native head fork; otherwise every post-turn
    // head fork silently falls back to reconstruction (and a restart would
    // make the same mistake even though resume is available). The reservation
    // is acquired synchronously before the first await, so a parent message
    // cannot advance while the old session is being resumed or forked.
    const parentBranch = forkNode ? this.svc.getBranch(forkNode.branchId) : null;
    const parentHead = parentBranch ? this.svc.lastNode(parentBranch.id) : null;
    let parentState = parentBranch ? this.sessionManager.getState(parentBranch.id) : null;
    const forkIsHead = Boolean(parentBranch && parentHead && parentHead.id === forkNode?.id);
    const boundParent = !parentState && parentBranch
      ? this.latestRuntimeSession(parentBranch.id)
      : null;
    const resumableBoundParent = boundParent &&
      boundParent.externalSessionId &&
      boundParent.status !== "failed" &&
      boundParent.status !== "interrupted"
      ? boundParent
      : null;
    const nativeCandidate = Boolean(
      forkIsHead &&
      parentBranch &&
      (!parentState || parentState.nodeId == null) &&
      (parentState || resumableBoundParent?.externalSessionId)
    );
    const forkReserved = nativeCandidate && !this.sessionManager.hasActiveTurn(parentBranch!.id)
      ? this.sessionManager.claimFork(parentBranch!.id)
      : false;

    try {
      if (forkReserved && !parentState && resumableBoundParent?.externalSessionId) {
        try {
          parentState = await this.sessionManager.resolveSession({
            branchId: parentBranch!.id,
            cwd: this.defaultCwd(parentBranch!.id) ?? ".",
          });
        } catch {
          // If the old runtime cannot be resumed, the immutable reconstruction
          // path remains semantically correct and is selected below.
          parentState = null;
        }
      }

      const isHeadFork = Boolean(forkReserved && forkIsHead && parentState && parentState.nodeId == null);
      const strategy: CreateForkResult["strategy"] = isHeadFork
        ? "native_head_fork"
        : "replay_reconstruction";

      // (1) Persist the branch + immutable snapshot at creation (reviewer B2).
      const branch = this.svc.createBranchFromNode({
        projectId: args.projectId,
        forkFromNodeId: args.forkFromNodeId,
        displayName: args.displayName ?? null,
        // Select before insert so the durable branch never reports reconstruction
        // after taking the native path.
        originStrategy: strategy,
        workspaceMode: args.workspaceMode ?? "shared",
      });
      const snapshot = this.svc.getBranchAncestry(branch.id).snapshot;

      // The branch is visible immediately after createBranchFromNode, but its
      // eager runtime session is not ready until the awaits below complete.
      // Reserve the child synchronously so another request cannot start an
      // empty lazy session (or archive it) through that visibility window.
      const childReserved = this.sessionManager.claimFork(branch.id);
      if (!childReserved) {
        try { this.svc.archiveBranch(branch.id); } catch { /* preserve original error */ }
        throw new Error(`fork child ${branch.id} could not be reserved`);
      }

      // Reserve the UUID before scheduler admission. A queued or active
      // bootstrap can then be interrupted by child branch id even before the
      // adapter has registered the external session handle.
      const childSessionId = this.newChildId();
      this.sessionManager.setPendingSessionKey(branch.id, childSessionId);
      let sessionKey: string | null = null;
      try {
        const bootstrap = async (): Promise<void> => {
          if (this.sessionManager.isCancellationRequested(branch.id)) {
            throw new Error("fork bootstrap cancelled");
          }
          // Bind the child workspace before the runtime is seeded. The optional
          // manager is absent in hermetic tests, where the requested cwd remains
          // the adapter input exactly as before.
          const runtimeCwd = this.workspaceManager
            ? await this.workspaceManager.bind(branch, args.cwd ?? null)
            : args.cwd ?? branch.workspacePath ?? this.defaultCwd(branch.id);
          if (this.sessionManager.isCancellationRequested(branch.id)) {
            throw new Error("fork bootstrap cancelled");
          }

          if (isHeadFork) {
            // Native head fork — freeze NOW (monotonic --session-id: parent progress
            // after this instant cannot leak into the child).
            const childSession = await this.adapter.forkFromHead(parentState!.sessionKey, {
              newSessionId: childSessionId,
              cwd: runtimeCwd,
            });
            if (this.sessionManager.isCancellationRequested(branch.id)) {
              throw new Error("fork bootstrap cancelled");
            }
            const adopted = this.sessionManager.adoptSession(branch.id, childSession);
            sessionKey = adopted.sessionKey;
          } else {
            // Historical/unknown-head fork → immutable reconstruction snapshot
            // (gate 1: anchored at creation; parent never needs to be alive).
            if (!snapshot) throw new Error("fork requires a reconstruction snapshot");
            const seed = snapshot.visibleMessages
              .map((m) => `${m.role}: ${m.content}`)
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
              { newSessionId: childSessionId, cwd: runtimeCwd, seedText: seedPrompt }
            );
            if (this.sessionManager.isCancellationRequested(branch.id)) {
              throw new Error("fork bootstrap cancelled");
            }
            const adopted = this.sessionManager.adoptSession(branch.id, childSession);
            sessionKey = adopted.sessionKey;
          }
        };

        if (this.scheduler) {
          // Fork creation is synchronous from the API client's perspective: a
          // saturated pool must reject immediately rather than wait behind a
          // parent turn that may itself be waiting on the child.
          await this.scheduler.submitImmediate({
            branchId: branch.id,
            projectId: branch.projectId,
            workspace: branch.id,
            run: bootstrap,
          });
        } else {
          await bootstrap();
        }
      } catch (err) {
        // createBranchFromNode commits before runtime seeding. If seeding fails,
        // archive the already-created child so a later message cannot lazily
        // materialize an unrelated empty-context session from it.
        try { this.svc.archiveBranch(branch.id); } catch { /* preserve original error */ }
        throw err;
      } finally {
        this.sessionManager.clearPendingSessionKey(branch.id, childSessionId);
        this.sessionManager.releaseFork(branch.id);
      }

      return {
        branch: this.svc.getBranch(branch.id) ?? branch,
        snapshot,
        sessionKey,
        strategy,
      };
    } finally {
      if (forkReserved) this.sessionManager.releaseFork(parentBranch!.id);
    }
  }

  private newChildId(): string {
    return randomUUID();
  }

  private latestRuntimeSession(branchId: string) {
    return [...this.svc.listRuntimeSessionsByBranch(branchId)].sort((a, b) =>
      a.lastSeenAt < b.lastSeenAt ? 1 : -1
    )[0] ?? null;
  }

  private defaultCwd(branchId: string): string | undefined {
    const branch = this.svc.getBranch(branchId);
    if (branch?.workspacePath) return branch.workspacePath;
    return branch ? this.svc.getProject(branch.projectId)?.rootPath ?? undefined : undefined;
  }
}
