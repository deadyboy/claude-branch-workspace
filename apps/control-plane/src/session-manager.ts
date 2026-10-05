// SessionManager: THE SOLE WRITER of runtime-session state (hard gate 13).
// It owns the in-memory per-branch invocation table AND every
// upsertRuntimeSession call. Nothing else re-derives runtime truth: the
// fork-orchestrator creates its sessions *through* this manager, and branches
// never independently derive runtime truth from the branch table.
//
// Runtime key model: sessionKey === runtime_sessions.id === runtimeSessionId.
// The external CLI id lives on the same runtime_sessions row; events carry the
// local sessionKey so FKs resolve against runtime_sessions.id.
//
// Invariants:
//   - ONE active invocation per branch (per-branch serialization — NOT a
//     global lock, gate 11): a branch with no live state can always materialize;
//     a branch already running is 409 Busy.
//   - Lazy materialization applies ONLY to root/import branches and to
//     resume-after-restart. FORK-CREATED branches are ALREADY bound eagerly at
//     creation by the fork-orchestrator (adoptSession below); resolveSession
//     first checks the persisted runtime_sessions mapping so the two mechanisms
//     can never double-seed the same branch (reviewer B2, gate 1).
//   - interrupt(branchId) signals ONLY that branch's active invocation
//     (gate 6); Main and Child turns run concurrently without interference.

import { randomUUID } from "node:crypto";
import type { DomainService, RuntimeSession as RuntimeSessionRow } from "@cbw/domain";
import type { RuntimeAdapter, RuntimeSession } from "@cbw/runtime";

export interface BranchSessionState {
  branchId: string;
  sessionKey: string;
  runtimeSessionId: string;
  nodeId: string | null;
  cancelRequested: boolean;
  startedAt: string;
}

export class SessionManager {
  // Per-branch live invocation table (in-memory; the DB is the restart fact).
  private state = new Map<string, BranchSessionState>();
  // Synchronous per-branch in-flight claims (gate 11 TOCTOU close): set by the
  // request handler BEFORE any await, kept separate from `state` so resolveSession
  // never mistakes a claim for a materialized session. Drained on resolve; cleared
  // by release().
  private pendingClaim = new Map<string, string>();
  // Cancellation requested while a claimed turn is still materializing. Keep
  // the claim in place until the runner observes it so archive cannot slip
  // through this window.
  private pendingCancellation = new Set<string>();
  // The UUID handed to startSession before its async warm-up completes. The
  // runtime can use it to stop a child even before it has registered the
  // external session handle.
  private pendingSessionKey = new Map<string, string>();
  // Synchronous reservation used while a native head fork re-registers an
  // idle parent and seeds the child. It is deliberately separate from a turn
  // claim: no conversation node is fabricated, but new turns/archive are still
  // blocked for the short fork freeze window.
  private pendingFork = new Set<string>();

  constructor(
    private readonly svc: DomainService,
    private readonly adapter: RuntimeAdapter
  ) {}

  isBusy(branchId: string): boolean {
    return this.state.has(branchId);
  }

  /**
   * True when this branch has a turn node genuinely in flight right now (gate
   * 11: per-branch serialization). Distinct from `isBusy` (a bound session that
   * hasn't started a turn is NOT "busy" for serialization — an eagerly-adopted
   * fork child opens its first turn without hitting a 409).
   */
  /**
   * True when this branch has a turn node genuinely in flight right now (gate
   * 11: per-branch serialization). A turn counts as in-flight if it has either
   * a materialized live state with a nodeId, OR a synchronous claim made by the
   * request handler before its resolveSession ran (separate `pendingClaim` map
   * so resolveSession never confuses a claim with a session). Distinct from
   * `isBusy` (a bound session that hasn't started a turn is NOT "busy" for
   * serialization — an eagerly-adopted fork child opens its first turn without
   * hitting a 409).
   */
  hasActiveTurn(branchId: string): boolean {
    return this.state.get(branchId)?.nodeId != null || this.pendingClaim.has(branchId) || this.pendingFork.has(branchId);
  }

  /** Reserve an idle parent while a native head fork is being frozen. */
  claimFork(branchId: string): boolean {
    if (this.hasActiveTurn(branchId)) return false;
    this.pendingFork.add(branchId);
    return true;
  }

  /** Release a native-fork reservation without discarding the parent session. */
  releaseFork(branchId: string): void {
    this.pendingFork.delete(branchId);
    this.pendingCancellation.delete(branchId);
    this.pendingSessionKey.delete(branchId);
  }

  /** Track a runtime key before an eager seed starts so interrupt can target it. */
  setPendingSessionKey(branchId: string, sessionKey: string): void {
    this.pendingSessionKey.set(branchId, sessionKey);
  }

  /** Clear a pending runtime key if it still belongs to this bootstrap. */
  clearPendingSessionKey(branchId: string, sessionKey?: string): void {
    if (sessionKey === undefined || this.pendingSessionKey.get(branchId) === sessionKey) {
      this.pendingSessionKey.delete(branchId);
    }
  }

  /** True while an eager fork workspace/runtime seed is materializing. */
  hasPendingFork(branchId: string): boolean {
    return this.pendingFork.has(branchId);
  }

  /**
   * Claim the per-branch serialization slot for `nodeId` SYNCHRONOUSLY (gate
   * 11). Called in the request handler right after the 409 check + openTurn,
   * with no `await` in between, so a truly-concurrent second POST on a fresh
   * branch sees the node in flight immediately — not after the turn's first
   * `await` (e.g. the real-CLI `startSession` spawn), which would double-open.
   * Kept OUT of `this.state` so `resolveSession` never mistakes the claim for a
   * materialized session (which would hand `runTurnOnce` an empty sessionKey).
   * Cleared by `release` when the turn ends.
   */
  claimTurn(branchId: string, nodeId: string): void {
    this.pendingClaim.set(branchId, nodeId);
  }

  /** Record which turn node is in flight on this branch (cleared by release). */
  markNode(branchId: string, nodeId: string): void {
    const st = this.state.get(branchId);
    if (st) st.nodeId = nodeId;
  }

  getState(branchId: string): BranchSessionState | null {
    return this.state.get(branchId) ?? null;
  }

  listStates(): BranchSessionState[] {
    return [...this.state.values()];
  }

  /**
   * Resolve (materializing if needed) the live session for `branchId`; the
   * first turn on a NEW branch returns through here. The fork-orchestrator's
   * eagerly-bound child session is found in the persisted mapping and adopted —
   * never re-seeded (gate 1, reviewer B2).
   */
  async resolveSession(input: {
    branchId: string;
    cwd: string;
    projectInstructions?: string | null;
  }): Promise<BranchSessionState> {
    const existing = this.state.get(input.branchId);
    if (existing) {
      // An eagerly adopted fork child already has a live state, but its first
      // turn can claim the branch immediately afterwards. Drain that claim even
      // on the existing-state path; otherwise the state stays falsely idle and
      // a concurrent message can slip through after the claim is removed.
      const claimedNodeId = this.pendingClaim.get(input.branchId);
      if (claimedNodeId) {
        existing.nodeId = claimedNodeId;
        this.pendingClaim.delete(input.branchId);
        if (this.pendingCancellation.delete(input.branchId)) {
          existing.cancelRequested = true;
        }
      }
      return existing;
    }

    // A pending synchronous claim (gate 11 TOCTOU close) transfers its nodeId
    // into the materialized state so `hasActiveTurn` stays true continuously
    // (claim → drain → state.nodeId) with no gap for a concurrent POST.
    const claimedNodeId = this.pendingClaim.get(input.branchId) ?? null;

    // (a) Eagerly bound at creation by fork-orchestrator → adopt, never re-seed.
    const bound = this.findBoundRow(input.branchId);
    if (bound) {
      // Restart resume (gate 13): re-register the external id into the runtime
      // adapter so its FIRST sendMessage after a control-plane restart does not
      // throw `unknown session` and fail the turn. Registration-only — the
      // persisted DB key stays the authoritative sessionKey (identity survives).
      if (bound.externalSessionId) {
        try {
          await this.adapter.resumeSession(bound.externalSessionId, input.cwd);
        } catch {
          // best-effort: the adapter treats an unregistered resume as a no-op
        }
      }
      this.pendingClaim.delete(input.branchId);
      const st = this.mkState(input.branchId, bound.id, claimedNodeId);
      st.cancelRequested = this.pendingCancellation.delete(input.branchId);
      this.state.set(input.branchId, st);
      return st;
    }

    // Fork branches are promised an eagerly seeded runtime. If a process dies
    // after the branch/snapshot commit but before the seed is adopted, there
    // is no safe session to lazily invent on the next message: that would turn
    // a fork into an empty root. Preserve the snapshot for diagnosis and make
    // the orphan unusable instead.
    const branch = this.svc.getBranch(input.branchId);
    if (branch && (branch.parentBranchId !== null || branch.forkFromNodeId !== null)) {
      try { this.svc.archiveBranch(branch.id); } catch { /* preserve the boundary error */ }
      throw new Error(`fork branch ${branch.id} has no runtime session binding`);
    }

    // (b) Root/import lazy start — fresh control-plane session via the adapter.
    const sessionId = this.newLocalSessionId();
    this.setPendingSessionKey(input.branchId, sessionId);
    let started: RuntimeSession;
    try {
      started = await this.adapter.startSession({
        sessionId,
        cwd: input.cwd,
        workspaceMode: "shared",
        projectInstructions: input.projectInstructions ?? null,
        branchId: input.branchId,
      });
    } finally {
      this.clearPendingSessionKey(input.branchId, sessionId);
    }
    this.persist(input.branchId, started);
    this.pendingClaim.delete(input.branchId);
    const st = this.mkState(input.branchId, started.sessionKey, claimedNodeId);
    st.cancelRequested = this.pendingCancellation.delete(input.branchId);
    this.state.set(input.branchId, st);
    return st;
  }

  /**
   * Adopt a session the fork-orchestrator created at branch-creation (eager
   * freeze, gate 1): persist the mapping and register the live state so the
   * child's first turn resolves without a second seed.
   */
  adoptSession(childBranchId: string, s: RuntimeSession): BranchSessionState {
    this.persist(childBranchId, s);
    const st = this.mkState(childBranchId, s.sessionKey, null);
    this.state.set(childBranchId, st);
    return st;
  }

  /**
   * Resume an existing recorded session after control-plane restart (gate 13:
   * the DB runtime_sessions mapping is the single fact). Registration-only;
   * the --resume round-trip happens lazily on the first sendMessage.
   */
  async resumeSession(input: {
    branchId: string;
    externalSessionId: string;
    cwd: string;
  }): Promise<BranchSessionState> {
    const existing = this.state.get(input.branchId);
    if (existing) return existing;
    const bound = this.findBoundRow(input.branchId);
    if (bound) {
      if (bound.externalSessionId) {
        try {
          await this.adapter.resumeSession(bound.externalSessionId, input.cwd);
        } catch {
          // Best-effort registration; the persisted local key remains stable.
        }
      }
      const st = this.mkState(input.branchId, bound.id, null);
      this.state.set(input.branchId, st);
      return st;
    }
    const resumed = await this.adapter.resumeSession(input.externalSessionId, input.cwd);
    this.persist(input.branchId, resumed);
    const st = this.mkState(input.branchId, resumed.sessionKey, null);
    this.state.set(input.branchId, st);
    return st;
  }

  /**
   * Interrupt ONLY `branchId`'s active invocation (gate 6). Signals the
   * adapter (kills exactly that session's child); the domain transition to
   * "cancelled" is the route handler's job via svc.cancelTurn. Returns the
   * sessionKey targeted, or null if the branch is idle.
   */
  async interrupt(branchId: string): Promise<string | null> {
    const st = this.state.get(branchId);
    // A claimed turn may still be waiting for startSession/resumeSession. Keep
    // the claim and remember cancellation so the runner cancels the node as
    // soon as materialization completes; there is no runtime child to signal
    // yet. An adopted idle session has neither signal and is truly idle.
    if (!st || st.nodeId == null) {
      if (this.pendingClaim.has(branchId) || this.pendingFork.has(branchId)) {
        this.pendingCancellation.add(branchId);
        const startingKey = this.pendingSessionKey.get(branchId);
        if (startingKey) {
          try {
            await this.adapter.interrupt(startingKey);
          } catch {
            // The adapter may not have spawned/registerd the child yet; the
            // pending cancellation is still honored by the runner.
          }
          return startingKey;
        }
      }
      return null;
    }
    st.cancelRequested = true;
    try {
      await this.adapter.interrupt(st.sessionKey);
    } catch {
      // best-effort: no in-flight child → adapter treats it as a no-op
    }
    return st.sessionKey;
  }

  /** True while a synchronous claim is pending for this branch (test-visible drain state). */
  hasPendingClaim(branchId: string): boolean {
    return this.pendingClaim.has(branchId);
  }

  /** True when a turn was explicitly interrupted before it could run. */
  isCancellationRequested(branchId: string): boolean {
    return this.state.get(branchId)?.cancelRequested === true || this.pendingCancellation.has(branchId);
  }

  /** Clear a branch's in-memory invocation state (turn ended). */
  release(branchId: string): void {
    this.state.delete(branchId);
    this.pendingClaim.delete(branchId);
    this.pendingCancellation.delete(branchId);
    this.pendingSessionKey.delete(branchId);
    this.pendingFork.delete(branchId);
  }

  private mkState(branchId: string, sessionKey: string, nodeId: string | null): BranchSessionState {
    return {
      branchId,
      sessionKey,
      runtimeSessionId: sessionKey, // sessionKey === runtime_sessions.id
      nodeId,
      cancelRequested: false,
      startedAt: new Date().toISOString(),
    };
  }

  private findBoundRow(branchId: string): RuntimeSessionRow | null {
    // Most-recent mapping is the live one (single fact source).
    const rows = [...this.svc.listRuntimeSessionsByBranch(branchId)].sort((a, b) =>
      a.lastSeenAt < b.lastSeenAt ? 1 : -1
    );
    return rows[0] ?? null;
  }

  private persist(branchId: string, s: RuntimeSession): void {
    this.svc.upsertRuntimeSession({
      id: s.sessionKey,
      branchId,
      adapterType: "claude-cli",
      externalSessionId: s.externalSessionId,
      runtimeVersion: s.runtimeVersion ?? null,
      status: "running",
      lastSeenAt: new Date().toISOString(),
    });
  }

  private newLocalSessionId(): string {
    return randomUUID();
  }
}
