import type { Db } from "./db.js";
import type {
  AgentRun,
  Branch,
  BranchContextSnapshot,
  ConversationNode,
  Message,
  Project,
  RuntimeSession,
} from "./types.js";

// NOTE: better-sqlite3 returns rows keyed by column name (snake_case). Every
// SELECT uses explicit aliases (col AS camel) so rows map straight onto the
// camelCase domain types.

const PROJECT_COLS = `id, name, root_path AS rootPath, created_at AS createdAt, updated_at AS updatedAt`;
const BRANCH_COLS = `id, project_id AS projectId, parent_branch_id AS parentBranchId,
  fork_from_node_id AS forkFromNodeId, display_name AS displayName,
  runtime_adapter AS runtimeAdapter, runtime_session_id AS runtimeSessionId,
  runtime_profile_id AS runtimeProfileId, origin_strategy AS originStrategy,
  workspace_mode AS workspaceMode, workspace_path AS workspacePath,
  status, created_at AS createdAt, archived_at AS archivedAt`;
const NODE_COLS = `id, project_id AS projectId, branch_id AS branchId, parent_node_id AS parentNodeId,
  local_turn_index AS localTurnIndex, user_message_ref AS userMessageRef,
  assistant_message_ref AS assistantMessageRef,
  runtime_user_message_id AS runtimeUserMessageId,
  runtime_assistant_message_id AS runtimeAssistantMessageId,
  status, created_at AS createdAt, completed_at AS completedAt`;
const MESSAGE_COLS = `id, node_id AS nodeId, branch_id AS branchId, role,
  visible_content AS visibleContent, runtime_message_id AS runtimeMessageId, seq, created_at AS createdAt`;

// Thin prepared-statement access over the raw tables. No domain rules here;
// invariants live in DomainService.
export class Repository {
  constructor(private db: Db) {}

  /** Run fn in a single SQLite transaction; rolls back on throw. */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ---- projects ----
  insertProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, root_path, created_at, updated_at)
         VALUES (@id, @name, @rootPath, @createdAt, @updatedAt)`
      )
      .run(p);
  }
  getProject(id: string): Project | null {
    return (
      (this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects WHERE id = ?`).get(id) as
        | Project
        | undefined) ?? null
    );
  }
  listProjects(): Project[] {
    return this.db.prepare(`SELECT ${PROJECT_COLS} FROM projects ORDER BY created_at`).all() as Project[];
  }
  touchProject(id: string, at: string): void {
    this.db.prepare(`UPDATE projects SET updated_at = ? WHERE id = ?`).run(at, id);
  }

  // ---- branches ----
  insertBranch(b: Branch): void {
    this.db
      .prepare(
        `INSERT INTO branches (
           id, project_id, parent_branch_id, fork_from_node_id, display_name,
           runtime_adapter, runtime_session_id, runtime_profile_id, origin_strategy,
           workspace_mode, workspace_path, status, created_at, archived_at
         ) VALUES (
           @id, @projectId, @parentBranchId, @forkFromNodeId, @displayName,
           @runtimeAdapter, @runtimeSessionId, @runtimeProfileId, @originStrategy,
           @workspaceMode, @workspacePath, @status, @createdAt, @archivedAt
         )`
      )
      .run(b);
  }
  getBranch(id: string): Branch | null {
    return (
      (this.db.prepare(`SELECT ${BRANCH_COLS} FROM branches WHERE id = ?`).get(id) as
        | Branch
        | undefined) ?? null
    );
  }
  listBranchesByProject(projectId: string): Branch[] {
    return this.db
      .prepare(`SELECT ${BRANCH_COLS} FROM branches WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as Branch[];
  }
  renameBranch(id: string, displayName: string): void {
    this.db.prepare(`UPDATE branches SET display_name = ? WHERE id = ?`).run(displayName, id);
  }
  archiveBranch(id: string, archivedAt: string): void {
    this.db
      .prepare(`UPDATE branches SET status = 'archived', archived_at = ? WHERE id = ?`)
      .run(archivedAt, id);
  }

  // ---- nodes ----
  insertNode(n: ConversationNode): void {
    this.db
      .prepare(
        `INSERT INTO conversation_nodes (
           id, project_id, branch_id, parent_node_id, local_turn_index,
           user_message_ref, assistant_message_ref,
           runtime_user_message_id, runtime_assistant_message_id,
           status, created_at, completed_at
         ) VALUES (
           @id, @projectId, @branchId, @parentNodeId, @localTurnIndex,
           @userMessageRef, @assistantMessageRef,
           @runtimeUserMessageId, @runtimeAssistantMessageId,
           @status, @createdAt, @completedAt
         )`
      )
      .run(n);
  }
  getNode(id: string): ConversationNode | null {
    return (
      (this.db.prepare(`SELECT ${NODE_COLS} FROM conversation_nodes WHERE id = ?`).get(id) as
        | ConversationNode
        | undefined) ?? null
    );
  }
  listNodesByBranch(branchId: string): ConversationNode[] {
    return this.db
      .prepare(`SELECT ${NODE_COLS} FROM conversation_nodes WHERE branch_id = ? ORDER BY local_turn_index`)
      .all(branchId) as ConversationNode[];
  }
  lastNode(branchId: string): ConversationNode | null {
    return (
      (this.db
        .prepare(`SELECT ${NODE_COLS} FROM conversation_nodes WHERE branch_id = ? ORDER BY local_turn_index DESC LIMIT 1`)
        .get(branchId) as ConversationNode | undefined) ?? null
    );
  }

  // ---- messages ----
  insertMessage(m: Message): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, node_id, branch_id, role, visible_content, runtime_message_id, seq, created_at)
         VALUES (@id, @nodeId, @branchId, @role, @visibleContent, @runtimeMessageId, @seq, @createdAt)`
      )
      .run(m);
  }
  nextMessageSeq(branchId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM messages WHERE branch_id = ?`)
      .get(branchId) as { n: number };
    return row.n;
  }
  updateMessageNode(messageId: string, nodeId: string): void {
    this.db.prepare(`UPDATE messages SET node_id = ? WHERE id = ?`).run(nodeId, messageId);
  }
  getMessage(id: string): Message | null {
    return (
      (this.db.prepare(`SELECT ${MESSAGE_COLS} FROM messages WHERE id = ?`).get(id) as
        | Message
        | undefined) ?? null
    );
  }
  listMessagesByBranch(branchId: string): Message[] {
    return this.db
      .prepare(`SELECT ${MESSAGE_COLS} FROM messages WHERE branch_id = ? ORDER BY seq`)
      .all(branchId) as Message[];
  }

  // ---- workspace bindings ----
  getWorkspaceBinding(branchId: string): { mode: "shared" | "worktree"; path: string | null } | null {
    const row = this.db
      .prepare(`SELECT mode, path FROM workspace_bindings WHERE branch_id = ?`)
      .get(branchId) as { mode: "shared" | "worktree"; path: string | null } | undefined;
    return row ?? null;
  }

  // ---- snapshots ----
  upsertSnapshot(s: BranchContextSnapshot): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO branch_context_snapshots (
           branch_id, fork_from_node_id, ancestor_node_ids_json,
           visible_messages_json, project_instructions, workspace_binding_json, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        s.branchId,
        s.forkFromNodeId,
        JSON.stringify(s.ancestorNodeIds),
        JSON.stringify(s.visibleMessages),
        s.projectInstructions,
        s.workspaceBinding ? JSON.stringify(s.workspaceBinding) : null,
        s.createdAt
      );
  }
  getSnapshot(branchId: string): BranchContextSnapshot | null {
    const row = this.db
      .prepare(`SELECT * FROM branch_context_snapshots WHERE branch_id = ?`)
      .get(branchId) as
      | {
          branch_id: string;
          fork_from_node_id: string;
          ancestor_node_ids_json: string;
          visible_messages_json: string;
          project_instructions: string | null;
          workspace_binding_json: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      branchId: row.branch_id,
      forkFromNodeId: row.fork_from_node_id,
      ancestorNodeIds: JSON.parse(row.ancestor_node_ids_json),
      visibleMessages: JSON.parse(row.visible_messages_json),
      projectInstructions: row.project_instructions,
      workspaceBinding: row.workspace_binding_json ? JSON.parse(row.workspace_binding_json) : null,
      createdAt: row.created_at,
    };
  }

  // ---- agent runs / runtime sessions (reserved for later phases) ----
  insertAgentRun(a: AgentRun): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs (
           id, owner_branch_id, owner_node_id, parent_agent_run_id, runtime_agent_id,
           type, task_summary, status, started_at, ended_at
         ) VALUES (@id, @ownerBranchId, @ownerNodeId, @parentAgentRunId, @runtimeAgentId,
           @type, @taskSummary, @status, @startedAt, @endedAt)`
      )
      .run(a);
  }
  insertRuntimeSession(s: RuntimeSession): void {
    this.db
      .prepare(
        `INSERT INTO runtime_sessions (
           id, branch_id, adapter_type, external_session_id, runtime_version, status, last_seen_at, metadata_json
         ) VALUES (
           @id, @branchId, @adapterType, @externalSessionId, @runtimeVersion, @status, @lastSeenAt, @metadataJson
         )`
      )
      .run(s);
  }

  /** Upsert the mapping for one runtime session and its owning branch. */
  upsertRuntimeSession(s: RuntimeSession): void {
    const upsert = this.db.prepare(
      `INSERT INTO runtime_sessions (
         id, branch_id, adapter_type, external_session_id, runtime_version, status, last_seen_at, metadata_json
       ) VALUES (
         @id, @branchId, @adapterType, @externalSessionId, @runtimeVersion, @status, @lastSeenAt, @metadataJson
       )
       ON CONFLICT(id) DO UPDATE SET
         branch_id = excluded.branch_id,
         adapter_type = excluded.adapter_type,
         external_session_id = excluded.external_session_id,
         runtime_version = excluded.runtime_version,
         status = excluded.status,
         last_seen_at = excluded.last_seen_at,
         metadata_json = excluded.metadata_json`
    );
    const upd = this.db.prepare(
      `UPDATE branches SET runtime_session_id = ? WHERE id = ?`
    );
    this.transaction(() => {
      upsert.run(s);
      if (s.branchId) upd.run(s.id, s.branchId);
    });
  }

  getRuntimeSession(id: string): RuntimeSession | null {
    return (
      (this.db
        .prepare(`SELECT * FROM runtime_sessions WHERE id = ?`)
        .get(id) as unknown as RuntimeSession | undefined) ?? null
    );
  }

  getRuntimeSessionByExternalId(externalSessionId: string): RuntimeSession | null {
    const row = this.db
      .prepare(`SELECT * FROM runtime_sessions WHERE external_session_id = ? LIMIT 1`)
      .get(externalSessionId) as
      | {
          id: string;
          branch_id: string;
          adapter_type: string;
          external_session_id: string | null;
          runtime_version: string | null;
          status: string;
          last_seen_at: string;
          metadata_json: string;
        }
      | undefined;
    if (!row) return null;
    return {
      id: row.id,
      branchId: row.branch_id,
      adapterType: row.adapter_type,
      externalSessionId: row.external_session_id,
      runtimeVersion: row.runtime_version,
      status: row.status as RuntimeSession["status"],
      lastSeenAt: row.last_seen_at,
      metadataJson: row.metadata_json,
    };
  }
}
