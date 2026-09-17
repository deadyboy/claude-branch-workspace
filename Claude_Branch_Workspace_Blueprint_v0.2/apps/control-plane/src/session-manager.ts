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
    return this.state.get(branchId)?.nodeId != null || this.pendingClaim.has(branchId);
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
    if (existing) return existing;

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
      this.state.set(input.branchId, st);
      return st;
    }

    // (b) Root/import lazy start — fresh control-plane session via the adapter.
    const started = await this.adapter.startSession({
      sessionId: this.newLocalSessionId(),
      cwd: input.cwd,
      workspaceMode: "shared",
      projectInstructions: input.projectInstructions ?? null,
      branchId: input.branchId,
    });
    this.persist(input.branchId, started);
    this.pendingClaim.delete(input.branchId);
    const st = this.mkState(input.branchId, started.sessionKey, claimedNodeId);
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
    if (!st) return null;
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

  /** Clear a branch's in-memory invocation state (turn ended). */
  release(branchId: string): void {
    this.state.delete(branchId);
    this.pendingClaim.delete(branchId);
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
    return `cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
