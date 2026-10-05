import Database from "better-sqlite3";

export type Db = Database.Database;

export const SCHEMA_VERSION = 5;

// Versioned migrations, applied in order. Each entry upgrades the DB from
// version N-1 to N. Idempotent within a transaction per version.
const MIGRATIONS: { version: number; apply: (db: Db) => void }[] = [
  {
    version: 1,
    apply(db) {
      db.exec(`
        CREATE TABLE projects (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          root_path  TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE branches (
          id                 TEXT PRIMARY KEY,
          project_id         TEXT NOT NULL REFERENCES projects(id),
          parent_branch_id   TEXT REFERENCES branches(id),
          fork_from_node_id  TEXT REFERENCES conversation_nodes(id),
          display_name       TEXT,
          runtime_adapter    TEXT NOT NULL DEFAULT 'claude-cli',
          runtime_session_id TEXT,
          runtime_profile_id TEXT,
          origin_strategy    TEXT NOT NULL,
          workspace_mode     TEXT NOT NULL DEFAULT 'shared',
          workspace_path     TEXT,
          status             TEXT NOT NULL DEFAULT 'active',
          created_at         TEXT NOT NULL,
          archived_at        TEXT
        );
        CREATE INDEX idx_branches_project ON branches(project_id);
        CREATE INDEX idx_branches_parent ON branches(parent_branch_id);
        CREATE INDEX idx_branches_session ON branches(runtime_session_id);

        CREATE TABLE conversation_nodes (
          id                      TEXT PRIMARY KEY,
          project_id              TEXT NOT NULL REFERENCES projects(id),
          branch_id               TEXT NOT NULL REFERENCES branches(id),
          parent_node_id          TEXT REFERENCES conversation_nodes(id),
          local_turn_index        INTEGER NOT NULL,
          user_message_ref        TEXT NOT NULL REFERENCES messages(id),
          assistant_message_ref   TEXT REFERENCES messages(id),
          runtime_user_message_id       TEXT,
          runtime_assistant_message_id  TEXT,
          status                  TEXT NOT NULL DEFAULT 'completed',
          created_at              TEXT NOT NULL,
          completed_at            TEXT,
          UNIQUE (branch_id, local_turn_index)
        );
        CREATE INDEX idx_nodes_branch ON conversation_nodes(branch_id);
        CREATE INDEX idx_nodes_project ON conversation_nodes(project_id);

        CREATE TABLE messages (
          id                TEXT PRIMARY KEY,
          node_id           TEXT REFERENCES conversation_nodes(id),
          branch_id         TEXT NOT NULL REFERENCES branches(id),
          role              TEXT NOT NULL,
          visible_content   TEXT NOT NULL,
          runtime_message_id TEXT,
          seq               INTEGER NOT NULL,
          created_at        TEXT NOT NULL
        );
        CREATE INDEX idx_messages_node ON messages(node_id);
        CREATE INDEX idx_messages_branch ON messages(branch_id);
        CREATE UNIQUE INDEX uq_messages_branch_seq ON messages(branch_id, seq);

        CREATE TABLE runtime_sessions (
          id                TEXT PRIMARY KEY,
          branch_id         TEXT NOT NULL REFERENCES branches(id),
          adapter_type      TEXT NOT NULL,
          external_session_id TEXT,
          runtime_version   TEXT,
          status            TEXT NOT NULL,
          last_seen_at      TEXT NOT NULL,
          metadata_json     TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_sessions_branch ON runtime_sessions(branch_id);

        CREATE TABLE agent_runs (
          id                 TEXT PRIMARY KEY,
          owner_branch_id    TEXT NOT NULL REFERENCES branches(id),
          owner_node_id      TEXT REFERENCES conversation_nodes(id),
          parent_agent_run_id TEXT REFERENCES agent_runs(id),
          runtime_agent_id   TEXT,
          type               TEXT NOT NULL,
          task_summary       TEXT,
          status             TEXT NOT NULL,
          started_at         TEXT NOT NULL,
          ended_at           TEXT
        );
        CREATE INDEX idx_agent_runs_branch ON agent_runs(owner_branch_id);

        CREATE TABLE events (
          id                  TEXT PRIMARY KEY,
          project_id          TEXT NOT NULL REFERENCES projects(id),
          branch_id           TEXT REFERENCES branches(id),
          node_id             TEXT REFERENCES conversation_nodes(id),
          agent_run_id        TEXT REFERENCES agent_runs(id),
          runtime_session_id  TEXT REFERENCES runtime_sessions(id),
          type                TEXT NOT NULL,
          sequence            INTEGER,
          occurred_at         TEXT NOT NULL,
          received_at         TEXT NOT NULL,
          payload_json_redacted TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_events_branch ON events(branch_id);
        CREATE INDEX idx_events_node ON events(node_id);
        CREATE INDEX idx_events_type ON events(type);

        CREATE TABLE workspace_bindings (
          branch_id  TEXT PRIMARY KEY REFERENCES branches(id),
          mode       TEXT NOT NULL,
          path       TEXT,
          git_branch TEXT,
          worktree_id TEXT
        );

        CREATE TABLE runtime_profiles (
          id                    TEXT PRIMARY KEY,
          label                 TEXT NOT NULL,
          adapter_type          TEXT NOT NULL,
          executable_path       TEXT,
          config_dir_reference  TEXT,
          metadata_json_nonsecret TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE branch_context_snapshots (
          branch_id      TEXT PRIMARY KEY REFERENCES branches(id),
          fork_from_node_id TEXT NOT NULL,
          ancestor_node_ids_json TEXT NOT NULL,
          visible_messages_json TEXT NOT NULL,
          project_instructions TEXT,
          workspace_binding_json TEXT,
          created_at     TEXT NOT NULL
        );
      `);
    },
  },
  {
    // Phase 3: execution tree. agent_runs/events existed in v1 but were
    // unused; this migration adds the fields the execution tree needs
    // (status, display_label, kind/name, parent linkage) and an events.status
    // column so canonical event status (started/completed/failed/cancelled)
    // survives alongside the event type.
    version: 2,
    apply(db) {
      db.exec(`
        ALTER TABLE agent_runs ADD COLUMN display_label TEXT;
        ALTER TABLE agent_runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'subagent';
        ALTER TABLE agent_runs ADD COLUMN name TEXT;
        ALTER TABLE events ADD COLUMN status TEXT;
        CREATE INDEX IF NOT EXISTS idx_agent_runs_parent ON agent_runs(parent_agent_run_id);
        CREATE INDEX IF NOT EXISTS idx_agent_runs_type ON agent_runs(type);
        CREATE INDEX IF NOT EXISTS idx_events_agentrun ON events(agent_run_id);
      `);
    },
  },
  {
    // Phase 4: durable event cursor. Adds a project-scoped monotonic seq_rel
    // to every event so the WS/REST layer can do crucially simple
    // events-after-cursor catch-up and gap-fill (hard gate 8). Backfilled in
    // creation order so pre-existing rows get stable, ordered cursors.
    version: 3,
    apply(db) {
      db.exec(`
        ALTER TABLE events ADD COLUMN seq_rel INTEGER NOT NULL DEFAULT 0;
        UPDATE events SET seq_rel = (
          SELECT n FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY received_at, id) AS n
            FROM events
          ) ranked WHERE ranked.id = events.id
        );
        CREATE INDEX IF NOT EXISTS idx_events_project_seq ON events(project_id, seq_rel);
      `);
    },
  },
  {
    // S3 / E4a (docs/14 §4.2): the baseline commit for result review. Adds a
    // nullable base_ref to branches — the HEAD observed when the branch's
    // workspace was FIRST bound ("state before the work began"). Nullable so
    // pre-existing rows stay readable; written once and never overwritten
    // (see Repository.setBaseRef's guarded UPDATE).
    version: 4,
    apply(db) {
      db.exec(`
        ALTER TABLE branches ADD COLUMN base_ref TEXT;
      `);
    },
  },
  {
    // S4 (docs/14 §5): task persistence for E5/E4b. Three additive tables —
    // tasks / task_attempts / artifacts. A Task is the durable unit of work; a
    // TaskAttempt is ONE try at it. Retries NEVER overwrite: each attempt is a
    // new row, old attempts are retained (E5 "重试不丢旧记录"). Task.status is
    // the aggregate view; attempts carry their own status.
    //
    // NOTE (intentional, minimal extension over the frozen §5 schema): tasks
    // gains a nullable `role` column so E5's "任务角色和名称可编辑" has a home.
    // No other column deviates from the frozen shape.
    version: 5,
    apply(db) {
      db.exec(`
        CREATE TABLE tasks (
          id           TEXT PRIMARY KEY,
          project_id   TEXT NOT NULL,
          branch_id    TEXT,
          title        TEXT NOT NULL,
          instructions TEXT NOT NULL,
          role         TEXT,
          status       TEXT NOT NULL,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_branch ON tasks(branch_id);
        CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

        CREATE TABLE task_attempts (
          id           TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL,
          branch_id    TEXT,
          node_id      TEXT,
          agent_run_id TEXT,
          status       TEXT NOT NULL,
          result_ref   TEXT,
          error        TEXT,
          started_at   TEXT NOT NULL,
          ended_at     TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_task_attempts_task ON task_attempts(task_id);

        CREATE TABLE artifacts (
          id               TEXT PRIMARY KEY,
          project_id       TEXT NOT NULL,
          origin_branch_id TEXT,
          origin_node_id   TEXT,
          origin_task_id   TEXT,
          kind             TEXT NOT NULL,
          path             TEXT,
          summary          TEXT,
          created_at       TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_artifacts_project ON artifacts(project_id);
        CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(origin_task_id);
      `);
    },
  },
];

export function openDb(path: string | null): Db {
  const db = path ? new Database(path) : new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  const current = db.pragma("user_version", { simple: true }) as number;
  // Apply in VERSION order, not array order. Two independent writers append to
  // this array (S4 tasks=5, S1 base_ref=4); a naive left-to-right pass would
  // run 5 before 4 and then leave user_version=4, so the next open would RE-RUN
  // 5 (CREATE TABLE → "already exists") and brick the DB. Sorting + adopting the
  // true max keeps every version applied exactly once regardless of append order.
  const ordered = [...MIGRATIONS].sort((a, b) => a.version - b.version);
  let applied = current;
  for (const m of ordered) {
    if (m.version > current) {
      db.transaction(() => {
        m.apply(db);
        db.pragma(`user_version = ${m.version}`);
      })();
      applied = Math.max(applied, m.version);
    }
  }
  if (applied !== current) db.pragma(`user_version = ${applied}`);
}
