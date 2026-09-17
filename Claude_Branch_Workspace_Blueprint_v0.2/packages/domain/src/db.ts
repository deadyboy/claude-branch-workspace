import Database from "better-sqlite3";

export type Db = Database.Database;

export const SCHEMA_VERSION = 1;

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
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      db.transaction(() => {
        m.apply(db);
        db.pragma(`user_version = ${m.version}`);
      })();
    }
  }
}
