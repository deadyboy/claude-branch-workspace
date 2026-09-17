import { randomUUID } from "node:crypto";
import { Repository } from "./repository.js";
import type {
  Branch,
  BranchContextSnapshot,
  ConversationNode,
  Message,
  Project,
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

  getNode(nodeId: string): ConversationNode | null {
    return this.repo.getNode(nodeId);
  }

  // ---- conversation turns ----
  appendCompletedTurn(input: AppendTurnInput): ConversationNode {
    const b = this.repo.getBranch(input.branchId);
    if (!b) throw new DomainError(`branch ${input.branchId} not found`);
    this.requireOpen(b);

    return this.repo.transaction(() => {
      const parent = this.repo.lastNode(b.id);
      const localTurnIndex = (parent?.localTurnIndex ?? -1) + 1;
      const at = this.now();

      // Sequence both messages up front so ordering is deterministic and the
      // whole turn is committed atomically (BLOCKER fix from review).
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

      let assistantMsg: Message | null = null;
      if (input.assistantContent != null) {
        assistantMsg = {
          id: randomUUID(),
          nodeId: null,
          branchId: b.id,
          role: "assistant",
          visibleContent: input.assistantContent,
          runtimeMessageId: null,
          createdAt: at,
          seq: this.repo.nextMessageSeq(b.id),
        };
        this.repo.insertMessage(assistantMsg);
      }

      const isCompleted = (input.status ?? "completed") === "completed";
      const node: ConversationNode = {
        id: randomUUID(),
        projectId: b.projectId,
        branchId: b.id,
        parentNodeId: parent?.id ?? null,
        localTurnIndex,
        userMessageRef: userMsg.id,
        assistantMessageRef: assistantMsg?.id ?? null,
        runtimeUserMessageId: null,
        runtimeAssistantMessageId: null,
        status: input.status ?? "completed",
        createdAt: at,
        completedAt: isCompleted ? at : null,
      };
      this.repo.insertNode(node);
      this.repo.updateMessageNode(userMsg.id, node.id);
      if (assistantMsg) this.repo.updateMessageNode(assistantMsg.id, node.id);

      this.repo.touchProject(b.projectId, at);
      return this.repo.getNode(node.id) as ConversationNode;
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

  private collectLineage(node: ConversationNode, acc: ConversationNode[]): void {
    acc.push(node);
    if (node.parentNodeId) {
      const p = this.repo.getNode(node.parentNodeId);
      if (p && p.branchId === node.branchId) this.collectLineage(p, acc);
    }
  }
}
