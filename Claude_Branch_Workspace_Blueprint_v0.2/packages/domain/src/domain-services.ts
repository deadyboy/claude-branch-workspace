import { randomUUID } from "node:crypto";
import { Repository } from "./repository.js";
import type {
  AgentRun,
  ApplyOperation,
  ApplyOperationStatus,
  Artifact,
  ArtifactKind,
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
  Task,
  TaskAttempt,
  TaskStatus,
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
      baseRef: null, // recorded on first bind (E4a) — never at creation
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
      baseRef: null, // recorded on first bind (E4a) — never at creation
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

  /**
   * Record the E4a baseline commit for a branch, once. The repository write is
   * guarded (base_ref IS NULL), so repeated calls after the first are no-ops and
   * the "before work began" value is preserved across restarts. Returns the
   * refreshed branch.
   */
  recordBaseRef(branchId: string, baseRef: string): Branch {
    const branch = this.getBranch(branchId);
    if (!branch) throw new DomainError(`branch ${branchId} not found`);
    this.repo.setBaseRef(branchId, baseRef);
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
    // Seed the reconstruction snapshot from the FULL ancestor chain, using the
    // SAME traversal the UI reads (inheritedNodes). The previous implementation
    // walked only same-branch `parentNodeId` links, so a fork-of-fork (A1 from A)
    // dropped the whole prefix A inherited from Main: the UI showed 6 inherited
    // items while the model seed carried 2. Sharing one traversal is what keeps
    // them from diverging again (E2 "拓扑和有效上下文逐项一致").
    const lineage = this.inheritedNodes(branch);

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

    // Same traversal as the reconstruction seed (inheritedNodes): the UI and the
    // model read the same ordered list, so they cannot disagree about what a
    // branch inherits. Origin is decided per node by which branch owns it.
    const items: EffectiveConversationItem[] = [];
    for (const n of this.inheritedNodes(branch)) {
      const origin = n.branchId === branch.id ? "local" : "inherited";
      items.push(...this.nodeItems(n.branchId, n, origin));
    }
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

  // ---- tasks / attempts / artifacts (S4, docs/14 §5) ----
  //
  // Semantics freeze (E5):
  //   • A Task is durable; Task.status is an AGGREGATE view of its attempts.
  //   • Each attempt is its own row; a retry APPENDS a new attempt and never
  //     rewrites an old one — old attempts are always retained ("重试不丢旧记录").
  //   • branchId is validated against the task's project when supplied; a task
  //     may legitimately have branchId === null (UI/MCP binds it later). We do
  //     NOT auto-create a branch here.

  /** Validate that a branch (if given) exists and belongs to `projectId`. */
  private requireBranchInProject(branchId: string, projectId: string): void {
    const b = this.repo.getBranch(branchId);
    if (!b) throw new DomainError(`branch ${branchId} not found`);
    if (b.projectId !== projectId) {
      throw new DomainError(`branch ${branchId} belongs to project ${b.projectId}, not ${projectId}`);
    }
  }

  createTask(input: {
    projectId: string;
    title: string;
    instructions: string;
    branchId?: string | null;
    role?: string | null;
    status?: TaskStatus;
  }): Task {
    const project = this.repo.getProject(input.projectId);
    if (!project) throw new DomainError(`project ${input.projectId} not found`);
    if (!input.title) throw new DomainError("task title must not be empty");
    if (!input.instructions) throw new DomainError("task instructions must not be empty");
    if (input.branchId) this.requireBranchInProject(input.branchId, input.projectId);

    const at = this.now();
    const t: Task = {
      id: randomUUID(),
      projectId: input.projectId,
      branchId: input.branchId ?? null,
      title: input.title,
      instructions: input.instructions,
      role: input.role ?? null,
      // Default "queued": an unscheduled task is waiting for a slot, not running.
      status: input.status ?? "queued",
      createdAt: at,
      updatedAt: at,
    };
    this.repo.insertTask(t);
    return this.repo.getTask(t.id) as Task;
  }

  getTask(id: string): Task | null {
    return this.repo.getTask(id);
  }

  listTasksByProject(projectId: string): Task[] {
    return this.repo.listTasksByProject(projectId);
  }

  /** Edit task fields (E5 "角色和名称可编辑"). Identity is preserved. */
  updateTask(id: string, fields: { title?: string; instructions?: string; role?: string | null; branchId?: string | null }): Task {
    const t = this.repo.getTask(id);
    if (!t) throw new DomainError(`task ${id} not found`);
    if (fields.title !== undefined && !fields.title) throw new DomainError("task title must not be empty");
    if (fields.instructions !== undefined && !fields.instructions) throw new DomainError("task instructions must not be empty");
    if (fields.branchId) this.requireBranchInProject(fields.branchId, t.projectId);
    this.repo.updateTask(id, {
      title: fields.title,
      instructions: fields.instructions,
      role: fields.role,
      branchId: fields.branchId,
      updatedAt: this.now(),
    });
    return this.repo.getTask(id) as Task;
  }

  /** Explicit aggregate-status set (e.g. cancel the whole task). */
  updateTaskStatus(id: string, status: TaskStatus): Task {
    const t = this.repo.getTask(id);
    if (!t) throw new DomainError(`task ${id} not found`);
    this.repo.updateTask(id, { status, updatedAt: this.now() });
    return this.repo.getTask(id) as Task;
  }

  /**
   * Append a NEW attempt to a task and refresh the task's aggregate status.
   * Retries call this again — they never reuse or overwrite an earlier attempt.
   */
  addTaskAttempt(input: {
    taskId: string;
    branchId?: string | null;
    nodeId?: string | null;
    agentRunId?: string | null;
    status?: TaskStatus;
    resultRef?: string | null;
    error?: string | null;
    startedAt?: string | null;
  }): TaskAttempt {
    const task = this.repo.getTask(input.taskId);
    if (!task) throw new DomainError(`task ${input.taskId} not found`);
    // An attempt may run on the task's branch or an explicit one; validate when given.
    const branchId = input.branchId ?? task.branchId;
    if (branchId) this.requireBranchInProject(branchId, task.projectId);
    if (input.nodeId) {
      const node = this.repo.getNode(input.nodeId);
      if (!node || node.projectId !== task.projectId || node.branchId !== branchId) throw new DomainError("attempt node binding must match task project and branch");
    }
    if (input.agentRunId) {
      const run = this.repo.getAgentRun(input.agentRunId);
      if (!run || run.ownerBranchId !== branchId || run.ownerNodeId !== (input.nodeId ?? null)) throw new DomainError("attempt run binding must match its execution node and branch");
    }

    const a: TaskAttempt = {
      id: randomUUID(),
      taskId: input.taskId,
      branchId: branchId ?? null,
      nodeId: input.nodeId ?? null,
      agentRunId: input.agentRunId ?? null,
      status: input.status ?? "running",
      resultRef: input.resultRef ?? null,
      error: input.error ?? null,
      startedAt: input.startedAt ?? this.now(),
      endedAt: null,
    };
    this.repo.transaction(() => {
      this.repo.insertTaskAttempt(a);
      if (a.status === "running" || a.status === "queued") {
        this.repo.updateTask(task.id, { status: a.status, updatedAt: this.now() });
      }
    });
    return this.repo.getTaskAttempt(a.id) as TaskAttempt;
  }

  startTaskAttempt(id: string): TaskAttempt {
    const a = this.repo.getTaskAttempt(id);
    if (!a) throw new DomainError(`task attempt ${id} not found`);
    this.repo.transaction(() => { this.repo.startTaskAttempt(id); this.recomputeTaskStatus(a.taskId); });
    return this.repo.getTaskAttempt(id)!;
  }
  attachTaskAttemptRun(id: string, runId: string): void {
    const a = this.repo.getTaskAttempt(id);
    const run = this.repo.getAgentRun(runId);
    if (!a || !run || run.ownerNodeId !== a.nodeId || run.ownerBranchId !== a.branchId) {
      throw new DomainError("attempt run binding must match its execution node and branch");
    }
    this.repo.attachTaskAttemptRun(id, runId);
  }
  /**
   * Terminal transition for ONE attempt, then re-aggregate the task. The attempt
   * row is preserved (it is only marked terminal, never deleted/reused).
   */
  completeTaskAttempt(
    attemptId: string,
    input: { status: Extract<TaskStatus, "completed" | "failed" | "cancelled">; resultRef?: string | null; error?: string | null }
  ): TaskAttempt {
    const attempt = this.repo.getTaskAttempt(attemptId);
    if (!attempt) throw new DomainError(`task attempt ${attemptId} not found`);
    const at = this.now();
    this.repo.transaction(() => {
      this.repo.completeTaskAttempt(attemptId, input.status, input.resultRef ?? null, input.error ?? null, at);
      this.recomputeTaskStatus(attempt.taskId);
    });
    return this.repo.getTaskAttempt(attemptId) as TaskAttempt;
  }

  listTaskAttempts(taskId: string): TaskAttempt[] {
    return this.repo.listTaskAttempts(taskId);
  }

  getTaskAttempt(id: string): TaskAttempt | null {
    return this.repo.getTaskAttempt(id);
  }

  /**
   * Aggregate task status from its attempts. A live (running/queued) attempt
   * dominates; otherwise the MOST RECENT attempt's terminal status wins — so a
   * task that failed once and then succeeded via a retry reads "completed",
   * while the failed attempt row remains readable in the history.
   */
  private recomputeTaskStatus(taskId: string): void {
    const attempts = this.repo.listTaskAttempts(taskId);
    if (attempts.length === 0) return;
    let aggregate: TaskStatus;
    if (attempts.some((a) => a.status === "running")) aggregate = "running";
    else if (attempts.some((a) => a.status === "queued")) aggregate = "queued";
    else aggregate = attempts[attempts.length - 1].status;
    this.repo.updateTask(taskId, { status: aggregate, updatedAt: this.now() });
  }

  createArtifact(input: {
    projectId: string;
    originBranchId?: string | null;
    originNodeId?: string | null;
    originTaskId?: string | null;
    kind: ArtifactKind;
    path?: string | null;
    summary?: string | null;
    id?: string;
  }): Artifact {
    const project = this.repo.getProject(input.projectId);
    if (!project) throw new DomainError(`project ${input.projectId} not found`);
    if (input.originTaskId) {
      const t = this.repo.getTask(input.originTaskId);
      if (!t) throw new DomainError(`task ${input.originTaskId} not found`);
      if (t.projectId !== input.projectId) {
        throw new DomainError(`task ${input.originTaskId} belongs to project ${t.projectId}, not ${input.projectId}`);
      }
    }
    if (input.originBranchId) this.requireBranchInProject(input.originBranchId, input.projectId);
    if (input.originNodeId) {
      const node = this.repo.getNode(input.originNodeId);
      if (!node || node.projectId !== input.projectId || (input.originBranchId && node.branchId !== input.originBranchId)) throw new DomainError("artifact node binding must match its project and origin branch");
    }
    const a: Artifact = {
      id: input.id ?? randomUUID(),
      projectId: input.projectId,
      originBranchId: input.originBranchId ?? null,
      originNodeId: input.originNodeId ?? null,
      originTaskId: input.originTaskId ?? null,
      kind: input.kind,
      path: input.path ?? null,
      summary: input.summary ?? null,
      createdAt: this.now(),
    };
    this.repo.insertArtifact(a);
    return this.repo.getArtifact(a.id) as Artifact;
  }

  getArtifact(id: string): Artifact | null {
    return this.repo.getArtifact(id);
  }

  listArtifacts(projectId: string): Artifact[] {
    return this.repo.listArtifactsByProject(projectId);
  }

  listArtifactsByTask(taskId: string): Artifact[] {
    return this.repo.listArtifactsByTask(taskId);
  }

  // ---- apply operations (E4b, docs/14 §4.3) ----
  //
  // An apply is recorded as a DURABLE LEDGER ROW before any file is touched, so
  // a mid-apply crash leaves evidence (which paths landed, which did not, where
  // the backup lives) instead of an unexplained target. The row id is a
  // DETERMINISTIC hash computed by the caller (source+target descriptor), which
  // is what makes a repeated click detectable: the second call finds the same id.

  /** Create the ledger row (status "applying"). Returns it for the caller to run. */
  startApplyOperation(input: {
    id: string;
    taskId: string;
    projectId: string;
    branchId: string | null;
    targetPath: string;
    baseRef: string | null;
    confirmToken: string;
  }): ApplyOperation {
    const task = this.repo.getTask(input.taskId);
    if (!task) throw new DomainError(`task ${input.taskId} not found`);
    const existing = this.repo.getApplyOperation(input.id);
    if (existing) throw new DomainError(`apply operation ${input.id} already exists`);
    const at = this.now();
    const o: ApplyOperation = {
      id: input.id,
      taskId: input.taskId,
      projectId: input.projectId,
      branchId: input.branchId,
      targetPath: input.targetPath,
      baseRef: input.baseRef,
      confirmToken: input.confirmToken,
      status: "applying",
      appliedJson: "[]",
      pendingJson: "[]",
      targetRestored: false,
      backupDir: null,
      error: null,
      createdAt: at,
      updatedAt: at,
    };
    this.repo.insertApplyOperation(o);
    return this.repo.getApplyOperation(o.id) as ApplyOperation;
  }

  getApplyOperation(id: string): ApplyOperation | null {
    return this.repo.getApplyOperation(id);
  }

  listApplyOperationsByTask(taskId: string): ApplyOperation[] {
    return this.repo.listApplyOperationsByTask(taskId);
  }

  /** Update the ledger row after a (possibly partial/failed) apply attempt. */
  updateApplyOperation(
    id: string,
    fields: {
      status?: ApplyOperationStatus;
      applied?: string[];
      pending?: string[];
      targetRestored?: boolean;
      backupDir?: string | null;
      error?: string | null;
    }
  ): ApplyOperation {
    const existing = this.repo.getApplyOperation(id);
    if (!existing) throw new DomainError(`apply operation ${id} not found`);
    this.repo.updateApplyOperation(id, {
      status: fields.status,
      appliedJson: fields.applied === undefined ? undefined : JSON.stringify(fields.applied),
      pendingJson: fields.pending === undefined ? undefined : JSON.stringify(fields.pending),
      targetRestored: fields.targetRestored,
      backupDir: fields.backupDir,
      error: fields.error,
      updatedAt: this.now(),
    });
    return this.repo.getApplyOperation(id) as ApplyOperation;
  }

  /**
   * The ancestor nodes a branch inherits, oldest first: for each ancestor branch
   * (root → parent) the nodes up to AND INCLUDING the child branch's fork point,
   * then the branch's own nodes. This is the single source of truth for BOTH the
   * UI read model (getEffectiveConversation) and the reconstruction seed
   * (captureBranchContext) — sharing it is what guarantees the model and the UI
   * can never disagree about a branch's inherited context.
   *
   * Cycle-guarded: a re-parented / corrupted chain with a branch cycle stops at
   * the first repeat instead of recursing forever.
   */
  private inheritedNodes(branch: Branch): ConversationNode[] {
    const out: ConversationNode[] = [];
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
      const stopAt = chain[i + 1].forkFromNodeId;
      for (const n of this.repo.listNodesByBranch(anc.id)) {
        out.push(n);
        if (stopAt && n.id === stopAt) break;
      }
    }
    for (const n of this.repo.listNodesByBranch(branch.id)) out.push(n);
    return out;
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
