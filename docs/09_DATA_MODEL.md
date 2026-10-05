# 09 — Data Model Draft

这是逻辑模型，不要求 Phase 0 直接照搬 SQL。

## projects

- id
- name
- root_path
- created_at
- updated_at

## branches

- id UUID PK
- project_id
- parent_branch_id nullable
- fork_from_node_id nullable
- display_name nullable
- runtime_adapter
- runtime_session_id nullable
- runtime_profile_id nullable
- origin_strategy
- workspace_mode
- workspace_path
- status
- created_at
- archived_at

Indexes:
- project_id
- parent_branch_id
- runtime_session_id

No unique constraint on display_name.

## conversation_nodes

- id UUID PK
- project_id
- branch_id
- parent_node_id nullable
- local_turn_index
- user_message_ref
- assistant_message_ref
- runtime_user_message_id nullable
- runtime_assistant_message_id nullable
- status
- created_at
- completed_at

Constraints:
- local_turn_index unique within branch
- parent lineage valid
- fork_from_node belongs to same project

## messages

- id
- node_id
- role
- visible_content
- runtime_message_id nullable
- created_at

## runtime_sessions

- id
- branch_id
- adapter_type
- external_session_id
- runtime_version
- status
- last_seen_at
- metadata_json

## agent_runs

- id
- owner_branch_id
- owner_node_id nullable
- parent_agent_run_id nullable
- runtime_agent_id nullable
- type
- task_summary
- status
- started_at
- ended_at

## events

- id
- project_id
- branch_id
- node_id nullable
- agent_run_id nullable
- runtime_session_id nullable
- type
- sequence nullable
- occurred_at
- received_at
- payload_json_redacted

## workspace_bindings

- branch_id
- mode shared|worktree
- path
- git_branch nullable
- worktree_id nullable

## runtime_profiles

- id
- label
- adapter_type
- executable_path nullable
- config_dir_reference nullable
- metadata_json_nonsecret
