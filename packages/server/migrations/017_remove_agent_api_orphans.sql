-- Remove the structures orphaned by deleting the /agent-api surface (PR #305):
--   * the `tool_calls` table (+ the `tool_call_status` enum) — its only writer was
--     the deleted agent-api tool-call endpoint;
--   * the `trace` comment content_type — only the agent-api created trace comments;
--   * the `secret_access` approval type — only the agent-api `/secrets/request`
--     produced it (the MCP `request_credential` tool posts a `credential_request`
--     comment instead, which is untouched).
-- Postgres has no DROP VALUE, so each enum is recreated without the removed value;
-- rows carrying a removed value are deleted first. Pre-v1 → the data loss is
-- acceptable. Mirrors 013_remove_options_comment.sql.

-- 1. Drop the orphaned table and its enum.
DROP TABLE IF EXISTS tool_calls;
DROP TYPE IF EXISTS tool_call_status;

-- 2. Remove `trace` from comment_content_type (the column carries a DEFAULT).
DELETE FROM task_comments WHERE content_type = 'trace';
ALTER TABLE task_comments ALTER COLUMN content_type DROP DEFAULT;
ALTER TYPE comment_content_type RENAME TO comment_content_type_old;
CREATE TYPE comment_content_type AS ENUM (
    'text', 'preview', 'system', 'run', 'action', 'credential_request', 'connect_required'
);
ALTER TABLE task_comments
    ALTER COLUMN content_type TYPE comment_content_type
    USING content_type::text::comment_content_type;
ALTER TABLE task_comments ALTER COLUMN content_type SET DEFAULT 'text';
DROP TYPE comment_content_type_old;

-- 3. Remove `secret_access` from approval_type. The partial index
-- idx_one_pending_repo_setup references the type in its WHERE predicate, so it
-- must be dropped before the enum is recreated and rebuilt against the new type
-- after. (`approvals.type` itself has no default.)
DELETE FROM approvals WHERE type = 'secret_access';
DROP INDEX idx_one_pending_repo_setup;
ALTER TYPE approval_type RENAME TO approval_type_old;
CREATE TYPE approval_type AS ENUM (
    'hire', 'project_creation', 'strategy', 'plan_review',
    'deploy_production', 'designated_repo_request', 'skill_proposal'
);
ALTER TABLE approvals
    ALTER COLUMN type TYPE approval_type
    USING type::text::approval_type;
DROP TYPE approval_type_old;
CREATE UNIQUE INDEX idx_one_pending_repo_setup
    ON approvals (team_id, (payload->>'project_id'))
    WHERE type = 'designated_repo_request'
      AND status = 'pending'
      AND payload->>'reason' = 'designated_repo';
