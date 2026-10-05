import { randomUUID } from "node:crypto";
import { Repository } from "./repository.js";
import type {
  AgentRun,
  Branch,
  BranchContextSnapshot,
  ConversationNode,
  DomainEvent,
  EffectiveConversationItem,
  ExecutionNode,
  ExecutionTree,
  Message,
  Project,
  RuntimeSession,
} from "./types.js";

export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

export interface NewProjectInput {
  name: string;
  rootPath?: string | null;
}

export interface NewBranchInput {
  projectId: string;
  forkFromNodeId?: string | null;
  displayName?: string | null;
  originStrategy?: Branch["originStrategy"];
  workspaceMode?: Branch["workspaceMode"];
}

export interface AppendTurnInput {
  branchId: string;
  userContent: string;
  assistantContent?: string | null;
  status?: ConversationNode["status"];
}

export type ConversationTreeNode = ConversationNode & { children: ConversationTreeNode[] };

export interface AncestryResult {
  branch: Branch;
  snapshot: BranchContextSnapshot | null;
  ancestors: { branch: Branch; forkPoint: ConversationNode | null }[];
}

export class DomainService {
  constructor(private repo: Repository) {}

  private now(): string {
    return new Date().toISOString();
  }

  // ---- projects ----
  createProject(input: NewProjectInput): Project {
    if (!input.name) throw new DomainError("project name must not be empty");
    const p: Project = {
      id: randomUUID(),
      name: input.name,
      rootPath: input.rootPath ?? null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.repo.insertProject(p);
    return p;
  }

  getProject(id: string): Project | null {
    return this.repo.getProject(id);
  }

  listProjects(): Project[] {
    return this.repo.listProjects();
  }

  /**
   * Update a project's mutable fields (name / rootPath), preserving its
   * immutable identity (id, createdAt). Only the fields the caller supplies are
   * changed; the others keep their stored values. Returns the refreshed row.
   */
  updateProject(id: string, fields: { name?: string; rootPath?: string | null }): Project {
    const existing = this.repo.getProject(id);
    if (!existing) throw new DomainError(`project ${id} not found`);
    if (fields.name !== undefined && !fields.name) throw new DomainError("project name must not be empty");
    this.repo.updateProject(id, {
      name: fields.name,
      rootPath: fields.rootPath,
      updatedAt: this.now(),
    });
    return this.repo.getProject(id) as Project;
  }

  // ---- branches ----
  private requireOpen(b: Branch): void {
    if (b.status !== "active") {
      throw new DomainError(`branch ${b.id} is ${b.status}`);
    }
  }

  createRootConversation(input: { projectId: string; rootBranchName?: string | null }): Branch {
    const project = this.repo.getProject(input.projectId);
    if (!project) throw new DomainError(`project ${input.projectId} not found`);

    const b: Branch = {
      id: randomUUID(),
      projectId: input.projectId,
      parentBranchId: null,
      forkFromNodeId: null,
      displayName: input.rootBranchName ?? null,
      originStrategy: "imported",
      workspaceMode: "shared",
      runtimeAdapter: "claude-cli",
      runtimeSessionId: null,
      runtimeProfileId: null,
      workspacePath: null,
      status: "active",
      createdAt: this.now(),
      archivedAt: null,
    };
    this.repo.insertBranch(b);
    return this.repo.getBranch(b.id) as Branch;
  }

  createBranchFromNode(input: NewBranchInput): Branch {
    const project = this.repo.getProject(input.projectId);
    if (!project) throw new DomainError(`project ${input.projectId} not found`);

    const forkNode = input.forkFromNodeId ? this.repo.getNode(input.forkFromNodeId) : null;
    if (!forkNode) throw new DomainError(`fork node ${input.forkFromNodeId} not found`);
    if (forkNode.projectId !== input.projectId)
      throw new DomainError(
        `fork node ${forkNode.id} belongs to project ${forkNode.projectId}, not ${input.projectId}`
      );
    if (forkNode.status !== "completed")
      throw new DomainError(
        `fork node ${forkNode.id} has status ${forkNode.status}; only completed turns are forkable`
      );
    const parentBranch = this.repo.getBranch(forkNode.branchId);
    if (!parentBranch)
      throw new DomainError(`parent branch ${forkNode.branchId} for node ${forkNode.id} not found`);
    this.requireOpen(parentBranch);

    const b: Branch = {
      id: randomUUID(),
      projectId: input.projectId,
      parentBranchId: forkNode.branchId,
      forkFromNodeId: forkNode.id,
      displayName: input.displayName ?? null,
      originStrategy: input.originStrategy ?? "replay_reconstruction",
      workspaceMode: input.workspaceMode ?? "shared",
      runtimeAdapter: "claude-cli",
      runtimeSessionId: null,
      runtimeProfileId: null,
      workspacePath: null,
      status: "active",
      createdAt: this.now(),
      archivedAt: null,
    };
    this.repo.insertBranch(b);
    this.captureBranchContext(b, forkNode);
    return this.repo.getBranch(b.id) as Branch;
  }

  renameBranch(branchId: string, displayName: string): Branch {
    const b = this.repo.getBranch(branchId);
    if (!b) throw new DomainError(`branch ${branchId} not found`);
    this.repo.renameBranch(branchId, displayName);
    return this.repo.getBranch(branchId) as Branch;
  }

  archiveBranch(branchId: string): Branch {
    const b = this.repo.getBranch(branchId);
    if (!b) throw new DomainError(`branch ${branchId} not found`);
    this.repo.archiveBranch(branchId, this.now());
    return this.repo.getBranch(branchId) as Branch;
  }

  getBranch(branchId: string): Branch | null {
    return this.repo.getBranch(branchId);
  }

  listBranches(projectId: string): Branch[] {
    return this.repo.listBranchesByProject(projectId);
  }

  bindBranchWorkspace(branchId: string, input: { mode: Branch["workspaceMode"]; path: string | null; originStrategy?: Branch["originStrategy"] }): Branch {
    const branch = this.getBranch(branchId);
    if (!branch) throw new DomainError("branch not found");
    if (branch.workspacePath && input.path && branch.workspacePath !== input.path) {
      throw new DomainError("workspace binding cannot change after creation");
    }
    if (!input.path && branch.status !== "archived") throw new DomainError("only archived workspaces can be detached");
    this.repo.bindBranchWorkspace(branchId, input.mode, input.path, input.originStrategy);
    return this.getBranch(branchId)!;
  }

  /** Persist/refresh the control-plane session mapping (single fact source). */
  upsertRuntimeSession(input: {
    id: string;
    branchId: string;
    adapterType: string;
    externalSessionId: string | null;
    runtimeVersion?: string | null;
    status: string;
    lastSeenAt: string;
    metadataJson?: string;
  }): void {
    this.repo.upsertRuntimeSession({
      id: input.id,
      branchId: input.branchId,
      adapterType: input.adapterType,
      externalSessionId: input.externalSessionId,
      runtimeVersion: input.runtimeVersion ?? null,
      status: input.status as RuntimeSession["status"],
      lastSeenAt: input.lastSeenAt,
      metadataJson: input.metadataJson ?? "{}",
    });
  }

  getNode(nodeId: string): ConversationNode | null {
    return this.repo.getNode(nodeId);
  }

  /** Head (most recent) pending/completed node of a branch, or null. */
  lastNode(branchId: string): ConversationNode | null {
    return this.repo.lastNode(branchId);
  }

  getRuntimeSession(id: string): RuntimeSession | null {
    return this.repo.getRuntimeSession(id);
  }

  getRuntimeSessionByExternalId(externalId: string): RuntimeSession | null {
    return this.repo.getRuntimeSessionByExternalId(externalId);
  }

  listRuntimeSessionsByBranch(branchId: string): RuntimeSession[] {
    return this.repo.listRuntimeSessionsByBranch(branchId);
  }

  // ---- conversation turns ----
  /**
   * @deprecated Thin wrapper kept so the ~30 existing call sites (tests,
   * demos, CLI) stay green (reviewer B4). New code uses the explicit
   * lifecycle openTurn → completeTurn / failTurn / cancelTurn (gate 5).
   */
  appendCompletedTurn(input: AppendTurnInput): ConversationNode {
    const node = this.openTurn({ branchId: input.branchId, userContent: input.userContent });
    const status = input.status ?? "completed";
    if (status === "pending") return node;
    return this.completeTurn(node.id, {
      assistantContent: input.assistantContent ?? null,
      status: status === "failed" ? "failed" : "completed",
    });
  }

  getConversationTree(branchId: string): ConversationTreeNode | null {
    const nodes = this.repo.listNodesByBranch(branchId);
    if (nodes.length === 0) return null;

    const byId = new Map<string, ConversationTreeNode>();
    for (const n of nodes) byId.set(n.id, { ...n, children: [] });

    let root: ConversationTreeNode | null = null;
    for (const n of nodes) {
      const t = byId.get(n.id)!;
      if (n.parentNodeId == null) {
        root = t;
      } else {
        const parent = byId.get(n.parentNodeId);
        if (parent) parent.children.push(t);
        else root = t; // orphan guard
      }
    }
    for (const t of byId.values()) t.children.sort((a, b) => a.localTurnIndex - b.localTurnIndex);
    return root;
  }

  // ---- ancestry / reconstruction context ----
  getBranchAncestry(branchId: string): AncestryResult {
    const branch = this.repo.getBranch(branchId);
    if (!branch) throw new DomainError(`branch ${branchId} not found`);

    const chain: Branch[] = [];
    const seen = new Set<string>();
    let cur: Branch | null = branch;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentBranchId ? this.repo.getBranch(cur.parentBranchId) : null;
    }

    const snapshot = this.repo.getSnapshot(branchId);
    const ancestors = chain.slice(0, -1).map((ancBranch) => ({
      branch: ancBranch,
      forkPoint: ancBranch.forkFromNodeId ? this.repo.getNode(ancBranch.forkFromNodeId) : null,
    }));

    return { branch, snapshot, ancestors };
  }

  captureBranchContext(branch: Branch, forkNode: ConversationNode): void {
    const lineage: ConversationNode[] = [];
    this.collectLineage(forkNode, lineage);
    lineage.reverse();

    const visibleMessages: { role: "user" | "assistant"; content: string }[] = [];
    for (const n of lineage) {
      const u = this.repo.getMessage(n.userMessageRef);
      if (u) visibleMessages.push({ role: "user", content: u.visibleContent });
      if (n.assistantMessageRef) {
        const a = this.repo.getMessage(n.assistantMessageRef);
        if (a) visibleMessages.push({ role: "assistant", content: a.visibleContent });
      }
    }

    const binding = this.repo.getWorkspaceBinding(branch.id);
    const snap: BranchContextSnapshot = {
      branchId: branch.id,
      forkFromNodeId: forkNode.id,
      ancestorNodeIds: lineage.map((n) => n.id),
      visibleMessages,
      // No instruction store yet (ADR-006 seeding uses visibleMessages only);
      // never fabricate a path or token as instructions.
      projectInstructions: null,
      workspaceBinding: binding,
      createdAt: this.now(),
    };
    this.repo.upsertSnapshot(snap);
  }

  getSnapshot(branchId: string): BranchContextSnapshot | null {
    return this.repo.getSnapshot(branchId);
  }

  getWorkspaceBinding(branchId: string): { mode: "shared" | "worktree"; path: string | null } | null {
    return this.repo.getWorkspaceBinding(branchId);
  }

  // ---- execution tree (transient AgentRuns, never persistent branches) ----

  /**
   * Open an AgentRun that is executing inside a branch turn. AgentRuns are
   * transient — they are observability objects owned by a branch turn, never
   * promoted to persistent Conversation Branches (constitution §1).
   */
  openAgentRun(input: {
    id?: string;
    ownerBranchId: string;
    ownerNodeId?: string | null;
    parentAgentRunId?: string | null;
    runtimeAgentId?: string | null;
    type: string;
    displayLabel?: string | null;
    name?: string | null;
    taskSummary?: string | null;
    status?: AgentRun["status"];
    startedAt?: string | null;
  }): AgentRun {
    const b = this.repo.getBranch(input.ownerBranchId);
    if (!b) throw new DomainError(`branch ${input.ownerBranchId} not found`);
    const at = input.startedAt ?? this.now();
    const run: AgentRun = {
      id: input.id ?? randomUUID(),
      ownerBranchId: input.ownerBranchId,
      ownerNodeId: input.ownerNodeId ?? null,
      parentAgentRunId: input.parentAgentRunId ?? null,
      runtimeAgentId: input.runtimeAgentId ?? null,
      type: input.type,
      displayLabel: input.displayLabel ?? null,
      name: input.name ?? null,
      taskSummary: input.taskSummary ?? null,
      status: input.status ?? "running",
      startedAt: at,
      endedAt: null,
    };
    this.repo.insertAgentRun(run);
    return run;
  }

  completeAgentRun(id: string, status: AgentRun["status"], endedAt?: string | null): AgentRun | null {
    const at = endedAt ?? this.now();
    const run = this.repo.getAgentRun(id);
    if (!run) return null;
    this.repo.updateAgentRunStatus(id, status, at);
    return this.repo.getAgentRun(id);
  }

  getAgentRun(id: string): AgentRun | null {
    return this.repo.getAgentRun(id);
  }

  listAgentRunsByBranch(branchId: string): AgentRun[] {
    return this.repo.listAgentRunsByBranch(branchId);
  }

  listAgentRunsByStatus(statuses: AgentRun["status"][]): AgentRun[] {
    return this.repo.listAgentRunsByStatus(statuses);
  }

  /**
   * Build the execution tree for a turn: the transient agent-run hierarchy
   * rooted at the main run of that node. Every run is owned by a branch turn;
   * none are branches themselves.
   */
  getExecutionTree(branchId: string, nodeId: string | null): ExecutionTree | null {
    const runs = this.repo.listAgentRunsByNode(nodeId ?? "");
    if (!runs.length && !nodeId) return null;

    // root = the earliest main run of the node, else first run.
    const main = runs.find((r) => r.type === "main") ?? runs[0];

    const childrenBy = new Map<string, AgentRun[]>();
    for (const r of runs) {
      if (r.id === main?.id) continue;
      const list = childrenBy.get(r.parentAgentRunId ?? "") ?? [];
      list.push(r);
      childrenBy.set(r.parentAgentRunId ?? "", list);
    }

    const build = (r: AgentRun): ExecutionNode => ({
      agentRun: r,
      children: (childrenBy.get(r.id) ?? []).sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map(build),
    });

    if (!main) return null;
    return { sessionKey: "", branchId, nodeId, root: build(main) };
  }

  // ---- canonical events (redacted payload) ----

  recordEvent(input: {
    projectId: string;
    branchId: string;
    nodeId?: string | null;
    agentRunId?: string | null;
    runtimeSessionId?: string | null;
    type: string;
    status?: DomainEvent["status"];
    occurredAt: string;
    receivedAt?: string | null;
    payloadJsonRedacted: string;
    sequence?: number | null;
  }): DomainEvent {
    const ev: DomainEvent = {
      id: randomUUID(),
      projectId: input.projectId,
      branchId: input.branchId,
      nodeId: input.nodeId ?? null,
      agentRunId: input.agentRunId ?? null,
      runtimeSessionId: input.runtimeSessionId ?? null,
      type: input.type,
      status: input.status ?? null,
      sequence: input.sequence ?? null,
      seqRel: 0, // filled by the repository writer below
      occurredAt: input.occurredAt,
      receivedAt: input.receivedAt ?? this.now(),
      payloadJsonRedacted: input.payloadJsonRedacted,
    };
    ev.seqRel = this.repo.insertEvent(ev);
    return ev;
  }

  listEventsByBranch(branchId: string): DomainEvent[] {
    return this.repo.listEventsByBranch(branchId);
  }

  listEventsByNode(nodeId: string): DomainEvent[] {
    return this.repo.listEventsByNode(nodeId);
  }

  /**
   * Durable cursor reads (gate 8). Events with seq_rel > afterSeqRel, oldest
   * first, capped. Assumes the single-writer control plane (gate 13).
   */
  listEventsSince(projectId: string, afterSeqRel: number, limit: number): DomainEvent[] {
    return this.repo.listEventsSince(projectId, afterSeqRel, limit);
  }

  lastEventSeqRel(projectId: string): number {
    return this.repo.maxEventSeqRel(projectId);
  }

  // ---- explicit turn lifecycle (Phase 4, gate 5) ----

  /**
   * Begin a turn: persist the user message + a `pending` node atomically and
   * return the node. The server 202s {nodeId} from this; the runtime runs
   * asynchronously and later calls completeTurn/failTurn/cancelTurn.
   */
  openTurn(input: { branchId: string; userContent: string }): ConversationNode {
    const b = this.repo.getBranch(input.branchId);
    if (!b) throw new DomainError(`branch ${input.branchId} not found`);
    this.requireOpen(b);

    return this.repo.transaction(() => {
      const parent = this.repo.lastNode(b.id);
      const localTurnIndex = (parent?.localTurnIndex ?? -1) + 1;
      const at = this.now();

      const userMsg: Message = {
        id: randomUUID(),
        nodeId: null,
        branchId: b.id,
        role: "user",
        visibleContent: input.userContent,
        runtimeMessageId: null,
        createdAt: at,
        seq: this.repo.nextMessageSeq(b.id),
      };
      this.repo.insertMessage(userMsg);

      const node: ConversationNode = {
        id: randomUUID(),
        projectId: b.projectId,
        branchId: b.id,
        parentNodeId: parent?.id ?? null,
        localTurnIndex,
        userMessageRef: userMsg.id,
        assistantMessageRef: null,
        runtimeUserMessageId: null,
        runtimeAssistantMessageId: null,
        status: "pending",
        createdAt: at,
        completedAt: null,
      };
      this.repo.insertNode(node);
      this.repo.updateMessageNode(userMsg.id, node.id);
      this.repo.touchProject(b.projectId, at);
      return this.repo.getNode(node.id) as ConversationNode;
    });
  }

  /**
   * Complete or fail a turn: insert the assistant message (verbatim chat truth,
   * gate 4 — never key-based redacted) and flip the node terminal. Idempotent:
   * a node already terminal is a no-op.
   */
  completeTurn(
    nodeId: string,
    input: { assistantContent?: string | null; status: Extract<ConversationNode["status"], "completed" | "failed">; }
  ): ConversationNode {
    const node = this.repo.getNode(nodeId);
    if (!node) throw new DomainError(`node ${nodeId} not found`);
    if (node.status !== "pending") return node; // idempotent

    const b = this.repo.getBranch(node.branchId);
    if (!b) throw new DomainError(`branch ${node.branchId} not found`);

    const at = this.now();
    return this.repo.transaction(() => {
      let assistantMsg: Message | null = null;
      if (input.assistantContent != null) {
        assistantMsg = {
          id: randomUUID(),
          nodeId: null,
          branchId: b.id,
          role: "assistant",
          visibleContent: this.chatTruthSafe(input.assistantContent),
          runtimeMessageId: null,
          createdAt: at,
          seq: this.repo.nextMessageSeq(b.id),
        };
        this.repo.insertMessage(assistantMsg);
        this.repo.updateMessageNode(assistantMsg.id, nodeId);
        this.repo.setNodeAssistantMessage(nodeId, assistantMsg.id);
      }
      // Preserve the v1 invariant: a failed turn is terminal but never has a
      // completedAt (only "completed" timestamps completion). "cancelled" is
      // set exclusively through cancelTurn.
      const completedAt = input.status === "completed" ? at : null;
      this.repo.setNodeStatus(nodeId, input.status, completedAt);
      this.repo.touchProject(b.projectId, at);
      return this.repo.getNode(nodeId) as ConversationNode;
    });
  }

  /**
   * Cancel a pending turn (gate 6): interrupt ⇒ cancelled, never failed. Node
   * flips to `cancelled` + completedAt; the owning runtime session (if any) is
   * marked `interrupted`; any still-running main agent run of the node is
   * closed `cancelled` so the Agent Monitor never shows a permanently-busy
   * card (verifier observation). Idempotent.
   */
  cancelTurn(nodeId: string, opts: { runtimeSessionId?: string | null } = {}): ConversationNode {
    const node = this.repo.getNode(nodeId);
    if (!node) throw new DomainError(`node ${nodeId} not found`);
    if (node.status !== "pending") return node;

    const at = this.now();
    return this.repo.transaction(() => {
      this.repo.setNodeStatus(nodeId, "cancelled", at);
      if (opts.runtimeSessionId) {
        this.repo.updateRuntimeSessionStatus(opts.runtimeSessionId, "interrupted", at);
      }
      for (const run of this.repo.listAgentRunsByNode(nodeId)) {
        if (run.status === "running" || run.status === "queued" || run.status === "needs_attention" || run.status === "waiting") {
          this.repo.updateAgentRunStatus(run.id, "cancelled", at);
        }
      }
      this.repo.touchProject(node.projectId, at);
      return this.repo.getNode(nodeId) as ConversationNode;
    });
  }

  /**
   * Effective-conversation read model (gate 3): walk the parent-branch chain;
   * for each ancestor branch include all nodes up to and including its fork
   * point (`origin: "inherited"`); then the branch's own local nodes
   * (`origin: "local"`), ordered by branch seq.
   */
  getEffectiveConversation(branchId: string): EffectiveConversationItem[] {
    const branch = this.repo.getBranch(branchId);
    if (!branch) throw new DomainError(`branch ${branchId} not found`);

    const items: EffectiveConversationItem[] = [];

    // Walk ancestors (deepest first), reverse at the end so root->target.
    const chain: Branch[] = [];
    const seen = new Set<string>();
    let cur: Branch | null = branch;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentBranchId ? this.repo.getBranch(cur.parentBranchId) : null;
    }

    for (let i = 0; i < chain.length - 1; i++) {
      const anc = chain[i];
      const nodes = this.repo.listNodesByBranch(anc.id);
      // Include up to and including the fork point (target child branch's forkFromNodeId).
      const childBranch = chain[i + 1];
      const stopAt = childBranch.forkFromNodeId;
      for (const n of nodes) {
        items.push(...this.nodeItems(anc.id, n, "inherited"));
        if (stopAt && n.id === stopAt) break;
      }
    }

    const local = this.repo.listNodesByBranch(branch.id);
    for (const n of local) items.push(...this.nodeItems(branch.id, n, "local"));

    return items;
  }

  private nodeItems(branchId: string, n: ConversationNode, origin: "inherited" | "local"): EffectiveConversationItem[] {
    const out: EffectiveConversationItem[] = [];
    const u = this.repo.getMessage(n.userMessageRef);
    if (u) out.push({ role: "user", content: u.visibleContent, nodeId: n.id, origin, seq: u.seq });
    if (n.assistantMessageRef) {
      const a = this.repo.getMessage(n.assistantMessageRef);
      if (a) out.push({ role: "assistant", content: a.visibleContent, nodeId: n.id, origin, seq: a.seq });
    }
    return out;
  }

  /**
   * Boot-time reconcile (gate 15): any node left `pending` by a crash is
   * cancelled (never failed) and its still-live agent runs closed; orphaned
   * `running` runtime sessions are marked `interrupted`. Returns counts.
   */
  reconcileTurnRuns(): { cancelledNodes: number; interruptedSessions: number } {
    const at = this.now();
    let cancelledNodes = 0;
    let interruptedSessions = 0;

    this.repo.transaction(() => {
      for (const node of this.repo.listPendingNodes()) {
        const mainRun = this.repo.listAgentRunsByNode(node.id).find((r) => r.type === "main" && r.status === "running");
        this.repo.setNodeStatus(node.id, "cancelled", at);
        for (const run of this.repo.listAgentRunsByNode(node.id)) {
          if (["running", "queued", "needs_attention", "waiting"].includes(run.status)) {
            this.repo.updateAgentRunStatus(run.id, "cancelled", at);
          }
        }
        cancelledNodes++;
      }
      for (const s of this.repo.listRuntimeSessionsByStatus(["running", "starting"])) {
        this.repo.updateRuntimeSessionStatus(s.id, "interrupted", at);
        interruptedSessions++;
      }
    });

    return { cancelledNodes, interruptedSessions };
  }

  private collectLineage(node: ConversationNode, acc: ConversationNode[]): void {
    acc.push(node);
    if (node.parentNodeId) {
      const p = this.repo.getNode(node.parentNodeId);
      if (p && p.branchId === node.branchId) this.collectLineage(p, acc);
    }
  }

  /**
   * Gate-4 defense-in-depth (chat truth vs observability): chat truth persists
   * VERBATIM — no key-based redaction of ordinary text (the parent's authored
   * surface, §11-exempt). The one exception is a bare secret pasted as the
   * ENTIRE assistant reply (e.g. a raw `sk-…`), which is replaced. A command
   * that merely *contains* a secret (e.g. `export KEY=sk-…`) persists verbatim.
   */
  private chatTruthSafe(content: string): string {
    return isWholeStringSecret(content) ? "[REDACTED]" : content;
  }
}

// Whole-string secret-shaped check: no whitespace, a known API-secret prefix,
// and a substantial random-looking tail. Narrow on purpose — see chatTruthSafe.
function isWholeStringSecret(value: string): boolean {
  const s = value.trim();
  if (s.length === 0 || /\s/.test(s)) return false;
  return /^(?:sk|sk-ant|ak|rk|pk|ghp|gho|ghu|ghs|glpat|hf|xoxb|xoxp|xoxa)[-_][A-Za-z0-9._-]{8,}$/i.test(s) ||
    /^(?:AKIA|ASIA|AIza)[A-Za-z0-9._-]{16,}$/.test(s) ||
    /^ya29\.[A-Za-z0-9._-]{16,}$/.test(s) ||
    /^eyJ[A-Za-z0-9._-]{16,}$/.test(s);
}
