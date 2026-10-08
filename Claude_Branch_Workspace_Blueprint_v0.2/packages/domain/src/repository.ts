import type { Db } from "./db.js";
import type {
  AgentRun,
  ApplyOperation,
  ApplyOperationStatus,
  Artifact,
  Branch,
  BranchContextSnapshot,
  ConversationNode,
  DomainEvent,
  Message,
  Project,
  RuntimeSession,
  Task,
  TaskAttempt,
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
  base_ref AS baseRef, status, created_at AS createdAt, archived_at AS archivedAt`;
const NODE_COLS = `id, project_id AS projectId, branch_id AS branchId, parent_node_id AS parentNodeId,
  local_turn_index AS localTurnIndex, user_message_ref AS userMessageRef,
  assistant_message_ref AS assistantMessageRef,
  runtime_user_message_id AS runtimeUserMessageId,
  runtime_assistant_message_id AS runtimeAssistantMessageId,
  status, created_at AS createdAt, completed_at AS completedAt`;
const MESSAGE_COLS = `id, node_id AS nodeId, branch_id AS branchId, role,
  visible_content AS visibleContent, runtime_message_id AS runtimeMessageId, seq, created_at AS createdAt`;
const AGENT_RUN_COLS = `id, owner_branch_id AS ownerBranchId, owner_node_id AS ownerNodeId,
  parent_agent_run_id AS parentAgentRunId, runtime_agent_id AS runtimeAgentId,
  type, display_label AS displayLabel, name, task_summary AS taskSummary,
  status, started_at AS startedAt, ended_at AS endedAt`;
const TASK_COLS = `id, project_id AS projectId, branch_id AS branchId, title, instructions,
  role, status, created_at AS createdAt, updated_at AS updatedAt`;
const TASK_ATTEMPT_COLS = `id, task_id AS taskId, branch_id AS branchId, node_id AS nodeId,
  agent_run_id AS agentRunId, status, result_ref AS resultRef, error,
  started_at AS startedAt, ended_at AS endedAt`;
const ARTIFACT_COLS = `id, project_id AS projectId, origin_branch_id AS originBranchId,
  origin_node_id AS originNodeId, origin_task_id AS originTaskId, kind, path, summary,
  created_at AS createdAt`;
const APPLY_OP_COLS = `id, task_id AS taskId, project_id AS projectId, branch_id AS branchId,
  target_path AS targetPath, base_ref AS baseRef, confirm_token AS confirmToken,
  status, applied_json AS appliedJson, pending_json AS pendingJson,
  target_restored AS targetRestored, backup_dir AS backupDir, error,
  created_at AS createdAt, updated_at AS updatedAt`;

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
  /** Update only the fields supplied; the immutable ID and createdAt are untouched. */
  updateProject(id: string, fields: { name?: string; rootPath?: string | null; updatedAt: string }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.name !== undefined) { sets.push("name = ?"); args.push(fields.name); }
    if (fields.rootPath !== undefined) { sets.push("root_path = ?"); args.push(fields.rootPath); }
    sets.push("updated_at = ?"); args.push(fields.updatedAt);
    args.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  // ---- branches ----
  insertBranch(b: Branch): void {
    this.db
      .prepare(
        `INSERT INTO branches (
           id, project_id, parent_branch_id, fork_from_node_id, display_name,
           runtime_adapter, runtime_session_id, runtime_profile_id, origin_strategy,
           workspace_mode, workspace_path, base_ref, status, created_at, archived_at
         ) VALUES (
           @id, @projectId, @parentBranchId, @forkFromNodeId, @displayName,
           @runtimeAdapter, @runtimeSessionId, @runtimeProfileId, @originStrategy,
           @workspaceMode, @workspacePath, @baseRef, @status, @createdAt, @archivedAt
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

  bindBranchWorkspace(id: string, mode: Branch["workspaceMode"], path: string | null, strategy?: Branch["originStrategy"]): void {
    this.db.prepare(`UPDATE branches SET workspace_mode = ?, workspace_path = ?,
      origin_strategy = COALESCE(?, origin_strategy) WHERE id = ?`).run(mode, path, strategy ?? null, id);
  }

  /**
   * Record the E4a baseline commit, but ONLY on first binding: the WHERE clause
   * refuses to overwrite a non-null base_ref, so a restart or re-bind can never
   * move the comparison point (docs/14 §4.2 "工作开始前记录"). Returns the
   * effect (true = written, false = already set), which callers log/assert on.
   */
  setBaseRef(id: string, baseRef: string): boolean {
    const res = this.db
      .prepare(`UPDATE branches SET base_ref = ? WHERE id = ? AND base_ref IS NULL`)
      .run(baseRef, id);
    return res.changes > 0;
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
  /** Idempotent node terminal transition (Phase 4, gate 5). */
  setNodeStatus(id: string, status: ConversationNode["status"], completedAt: string | null): void {
    this.db.prepare(`UPDATE conversation_nodes SET status = ?, completed_at = ? WHERE id = ?`).run(status, completedAt, id);
  }
  /** Set (or clear) the node's assistant message reference. */
  setNodeAssistantMessage(id: string, assistantMessageRef: string | null): void {
    this.db.prepare(`UPDATE conversation_nodes SET assistant_message_ref = ? WHERE id = ?`).run(assistantMessageRef, id);
  }
  /** Nodes still pending after a crash → reconciled at boot (Phase 4, gate 15). */
  listPendingNodes(): ConversationNode[] {
    return this.db
      .prepare(`SELECT ${NODE_COLS} FROM conversation_nodes WHERE status = 'pending'`)
      .all() as ConversationNode[];
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

  // ---- events (canonical, redacted) ----
  /**
   * Insert a canonical event. `seqRel` is assigned by the single writer here
   * (project-scoped MAX+1) and returned so the caller's in-memory object stays
   * truthful. The global cursor premise requires one control-plane process.
   */
  insertEvent(e: DomainEvent): number {
    const seqRel = this.nextEventSeqRel(e.projectId);
    this.db
      .prepare(
        `INSERT INTO events (
           id, project_id, branch_id, node_id, agent_run_id, runtime_session_id,
           type, status, sequence, seq_rel, occurred_at, received_at, payload_json_redacted
         ) VALUES (
           @id, @projectId, @branchId, @nodeId, @agentRunId, @runtimeSessionId,
           @type, @status, @sequence, @seqRel, @occurredAt, @receivedAt, @payloadJsonRedacted
         )`
      )
      .run({ ...e, seqRel });
    return seqRel;
  }
  nextEventSeqRel(projectId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq_rel), 0) + 1 AS n FROM events WHERE project_id = ?`)
      .get(projectId) as { n: number };
    return row.n;
  }
  listEventsByBranch(branchId: string): DomainEvent[] {
    return this.db
      .prepare(`SELECT ${EVENT_COLS} FROM events WHERE branch_id = ? ORDER BY received_at, sequence`)
      .all(branchId) as DomainEvent[];
  }
  listEventsByNode(nodeId: string): DomainEvent[] {
    return this.db
      .prepare(`SELECT ${EVENT_COLS} FROM events WHERE node_id = ? ORDER BY received_at, sequence`)
      .all(nodeId) as DomainEvent[];
  }
  /** Durable cursor catch-up/gap-fill (Phase 4, gate 8): events after seq_rel > afterSeqRel. */
  listEventsSince(projectId: string, afterSeqRel: number, limit: number): DomainEvent[] {
    return this.db
      .prepare(
        `SELECT ${EVENT_COLS} FROM events WHERE project_id = ? AND seq_rel > ?
         ORDER BY seq_rel ASC LIMIT ?`
      )
      .all(projectId, afterSeqRel, limit) as DomainEvent[];
  }
  maxEventSeqRel(projectId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(seq_rel), 0) AS n FROM events WHERE project_id = ?`)
      .get(projectId) as { n: number };
    return row.n;
  }

  // ---- agent runs (execution tree) ----
  insertAgentRun(a: AgentRun): void {
    this.db
      .prepare(
        `INSERT INTO agent_runs (
           id, owner_branch_id, owner_node_id, parent_agent_run_id, runtime_agent_id,
           type, display_label, name, task_summary, status, started_at, ended_at
         ) VALUES (
           @id, @ownerBranchId, @ownerNodeId, @parentAgentRunId, @runtimeAgentId,
           @type, @displayLabel, @name, @taskSummary, @status, @startedAt, @endedAt
         )`
      )
      .run(a);
  }
  updateAgentRunStatus(id: string, status: AgentRun["status"], endedAt: string | null): void {
    this.db
      .prepare(`UPDATE agent_runs SET status = ?, ended_at = ? WHERE id = ?`)
      .run(status, endedAt, id);
  }
  listAgentRunsByStatus(statuses: AgentRun["status"][]): AgentRun[] {
    const placeholders = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT ${AGENT_RUN_COLS} FROM agent_runs WHERE status IN (${placeholders})`)
      .all(...statuses) as AgentRun[];
  }
  updateAgentRun(a: AgentRun): void {
    this.db
      .prepare(
        `UPDATE agent_runs SET
           owner_branch_id=@ownerBranchId, owner_node_id=@ownerNodeId,
           parent_agent_run_id=@parentAgentRunId, runtime_agent_id=@runtimeAgentId,
           type=@type, display_label=@displayLabel, name=@name,
           task_summary=@taskSummary, status=@status, started_at=@startedAt, ended_at=@endedAt
         WHERE id=@id`
      )
      .run(a);
  }
  getAgentRun(id: string): AgentRun | null {
    return (
      (this.db
        .prepare(
          `SELECT ${AGENT_RUN_COLS} FROM agent_runs WHERE id = ?`
        )
        .get(id) as AgentRun | undefined) ?? null
    );
  }
  listAgentRunsByBranch(branchId: string): AgentRun[] {
    return this.db
      .prepare(
        `SELECT ${AGENT_RUN_COLS} FROM agent_runs WHERE owner_branch_id = ? ORDER BY started_at`
      )
      .all(branchId) as AgentRun[];
  }
  listAgentRunsByNode(nodeId: string): AgentRun[] {
    return this.db
      .prepare(
        `SELECT ${AGENT_RUN_COLS} FROM agent_runs WHERE owner_node_id = ? ORDER BY started_at`
      )
      .all(nodeId) as AgentRun[];
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
        .prepare(`SELECT ${RUNTIME_SESSION_COLS} FROM runtime_sessions WHERE id = ?`)
        .get(id) as RuntimeSession | undefined) ?? null
    );
  }

  getRuntimeSessionByExternalId(externalSessionId: string): RuntimeSession | null {
    return (
      (this.db
        .prepare(`SELECT ${RUNTIME_SESSION_COLS} FROM runtime_sessions WHERE external_session_id = ? LIMIT 1`)
        .get(externalSessionId) as RuntimeSession | undefined) ?? null
    );
  }
  listRuntimeSessionsByBranch(branchId: string): RuntimeSession[] {
    return this.db
      .prepare(`SELECT ${RUNTIME_SESSION_COLS} FROM runtime_sessions WHERE branch_id = ? ORDER BY last_seen_at DESC`)
      .all(branchId) as RuntimeSession[];
  }
  listRuntimeSessionsByStatus(statuses: RuntimeSession["status"][]): RuntimeSession[] {
    const placeholders = statuses.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT ${RUNTIME_SESSION_COLS} FROM runtime_sessions WHERE status IN (${placeholders})`)
      .all(...statuses) as RuntimeSession[];
  }
  updateRuntimeSessionStatus(id: string, status: RuntimeSession["status"], at: string): void {
    this.db
      .prepare(`UPDATE runtime_sessions SET status = ?, last_seen_at = ? WHERE id = ?`)
      .run(status, at, id);
  }

  // ---- tasks / attempts / artifacts (S4, docs/14 §5) ----

  insertTask(t: Task): void {
    this.db
      .prepare(
        `INSERT INTO tasks (
           id, project_id, branch_id, title, instructions, role, status, created_at, updated_at
         ) VALUES (
           @id, @projectId, @branchId, @title, @instructions, @role, @status, @createdAt, @updatedAt
         )`
      )
      .run(t);
  }
  getTask(id: string): Task | null {
    return (
      (this.db.prepare(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).get(id) as Task | undefined) ?? null
    );
  }
  listTasksByProject(projectId: string): Task[] {
    return this.db
      .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE project_id = ? ORDER BY created_at, id`)
      .all(projectId) as Task[];
  }
  /** Update only the fields supplied; id/createdAt are immutable. */
  updateTask(id: string, fields: { title?: string; instructions?: string; role?: string | null; branchId?: string | null; status?: string; updatedAt: string }): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.title !== undefined) { sets.push("title = ?"); args.push(fields.title); }
    if (fields.instructions !== undefined) { sets.push("instructions = ?"); args.push(fields.instructions); }
    if (fields.role !== undefined) { sets.push("role = ?"); args.push(fields.role); }
    if (fields.branchId !== undefined) { sets.push("branch_id = ?"); args.push(fields.branchId); }
    if (fields.status !== undefined) { sets.push("status = ?"); args.push(fields.status); }
    sets.push("updated_at = ?"); args.push(fields.updatedAt);
    args.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  /** Append ONE attempt. Never an upsert: retries create new rows, old rows stay. */
  insertTaskAttempt(a: TaskAttempt): void {
    this.db
      .prepare(
        `INSERT INTO task_attempts (
           id, task_id, branch_id, node_id, agent_run_id, status, result_ref, error, started_at, ended_at
         ) VALUES (
           @id, @taskId, @branchId, @nodeId, @agentRunId, @status, @resultRef, @error, @startedAt, @endedAt
         )`
      )
      .run(a);
  }
  getTaskAttempt(id: string): TaskAttempt | null {
    return (
      (this.db.prepare(`SELECT ${TASK_ATTEMPT_COLS} FROM task_attempts WHERE id = ?`).get(id) as
        | TaskAttempt
        | undefined) ?? null
    );
  }
  listTaskAttempts(taskId: string): TaskAttempt[] {
    return this.db
      .prepare(`SELECT ${TASK_ATTEMPT_COLS} FROM task_attempts WHERE task_id = ? ORDER BY started_at, rowid`)
      .all(taskId) as TaskAttempt[];
  }
  startTaskAttempt(id: string): void {
    this.db.prepare("UPDATE task_attempts SET status = 'running' WHERE id = ? AND status = 'queued'").run(id);
  }
  attachTaskAttemptRun(id: string, runId: string): void {
    this.db.prepare("UPDATE task_attempts SET agent_run_id = ? WHERE id = ? AND agent_run_id IS NULL").run(runId, id);
  }
  /** Terminal transition for one attempt; the row itself is preserved. */
  completeTaskAttempt(id: string, status: string, resultRef: string | null, error: string | null, endedAt: string): void {
    this.db
      .prepare(`UPDATE task_attempts SET status = ?, result_ref = ?, error = ?, ended_at = ? WHERE id = ?`)
      .run(status, resultRef, error, endedAt, id);
  }

  insertArtifact(a: Artifact): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (
           id, project_id, origin_branch_id, origin_node_id, origin_task_id, kind, path, summary, created_at
         ) VALUES (
           @id, @projectId, @originBranchId, @originNodeId, @originTaskId, @kind, @path, @summary, @createdAt
         )`
      )
      .run(a);
  }
  getArtifact(id: string): Artifact | null {
    return (
      (this.db.prepare(`SELECT ${ARTIFACT_COLS} FROM artifacts WHERE id = ?`).get(id) as
        | Artifact
        | undefined) ?? null
    );
  }
  listArtifactsByProject(projectId: string): Artifact[] {
    return this.db
      .prepare(`SELECT ${ARTIFACT_COLS} FROM artifacts WHERE project_id = ? ORDER BY created_at, id`)
      .all(projectId) as Artifact[];
  }
  listArtifactsByTask(taskId: string): Artifact[] {
    return this.db
      .prepare(`SELECT ${ARTIFACT_COLS} FROM artifacts WHERE origin_task_id = ? ORDER BY created_at, id`)
      .all(taskId) as Artifact[];
  }

  // ---- apply operations (E4b, docs/14 §4.3) ----

  insertApplyOperation(o: ApplyOperation): void {
    this.db
      .prepare(
        `INSERT INTO apply_operations (
           id, task_id, project_id, branch_id, target_path, base_ref, confirm_token,
           status, applied_json, pending_json, target_restored, backup_dir, error,
           created_at, updated_at
         ) VALUES (
           @id, @taskId, @projectId, @branchId, @targetPath, @baseRef, @confirmToken,
           @status, @appliedJson, @pendingJson, @targetRestored, @backupDir, @error,
           @createdAt, @updatedAt
         )`
      )
      .run({ ...o, targetRestored: o.targetRestored ? 1 : 0 });
  }

  getApplyOperation(id: string): ApplyOperation | null {
    const row = this.db.prepare(`SELECT ${APPLY_OP_COLS} FROM apply_operations WHERE id = ?`).get(id) as
      | (Omit<ApplyOperation, "targetRestored"> & { targetRestored: number })
      | undefined;
    return row ? { ...row, targetRestored: row.targetRestored === 1 } : null;
  }

  updateApplyOperation(
    id: string,
    fields: {
      status?: ApplyOperationStatus;
      appliedJson?: string;
      pendingJson?: string;
      targetRestored?: boolean;
      backupDir?: string | null;
      error?: string | null;
      updatedAt: string;
    }
  ): void {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (fields.status !== undefined) { sets.push("status = ?"); args.push(fields.status); }
    if (fields.appliedJson !== undefined) { sets.push("applied_json = ?"); args.push(fields.appliedJson); }
    if (fields.pendingJson !== undefined) { sets.push("pending_json = ?"); args.push(fields.pendingJson); }
    if (fields.targetRestored !== undefined) { sets.push("target_restored = ?"); args.push(fields.targetRestored ? 1 : 0); }
    if (fields.backupDir !== undefined) { sets.push("backup_dir = ?"); args.push(fields.backupDir); }
    if (fields.error !== undefined) { sets.push("error = ?"); args.push(fields.error); }
    sets.push("updated_at = ?"); args.push(fields.updatedAt);
    args.push(id);
    this.db.prepare(`UPDATE apply_operations SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  }

  listApplyOperationsByTask(taskId: string): ApplyOperation[] {
    const rows = this.db
      .prepare(`SELECT ${APPLY_OP_COLS} FROM apply_operations WHERE task_id = ? ORDER BY created_at DESC, id`)
      .all(taskId) as (Omit<ApplyOperation, "targetRestored"> & { targetRestored: number })[];
    return rows.map((r) => ({ ...r, targetRestored: r.targetRestored === 1 }));
  }
}

// Events select list (constitution-mandated col AS camel), used by every event read.
const EVENT_COLS = `id, project_id AS projectId, branch_id AS branchId, node_id AS nodeId,
  agent_run_id AS agentRunId, runtime_session_id AS runtimeSessionId,
  type, status, sequence, seq_rel AS seqRel,
  occurred_at AS occurredAt, received_at AS receivedAt,
  payload_json_redacted AS payloadJsonRedacted`;

// snake_case -> camelCase aliased exactly once (constitution-mandated).
const RUNTIME_SESSION_COLS = `
  id,
  branch_id AS branchId,
  adapter_type AS adapterType,
  external_session_id AS externalSessionId,
  runtime_version AS runtimeVersion,
  status,
  last_seen_at AS lastSeenAt,
  metadata_json AS metadataJson
`;
