-- 013_remove_options_comment.sql
--
-- Remove the "options" comment type and its companion "option_chosen" wakeup
-- source entirely. The option-card feature had no agent-facing authoring path
-- (the create_comment MCP tool only ever emits 'text', and nothing else in the
-- codebase produced an options comment), so it is being dropped rather than
-- finished. The /choose endpoint that resolved these comments is removed too.
--
-- The `chosen_option` JSONB column is NOT dropped: it is shared by the
-- credential_request (`{ secret_id, ... }`) and action/setup_repo
-- (`{ status, result }`) comment types, which keep using it.
--
-- Postgres can't drop a value from an enum in place, so each affected enum is
-- recreated without the removed value. Any rows still carrying the removed value
-- are deleted first (pre-v1: no real data to preserve), so the USING cast over
-- the remaining values always succeeds.

-------------------------------------------------------------------------------
-- comment_content_type: drop 'options'
-------------------------------------------------------------------------------

DELETE FROM task_comments WHERE content_type = 'options';

ALTER TABLE task_comments ALTER COLUMN content_type DROP DEFAULT;

ALTER TYPE comment_content_type RENAME TO comment_content_type_old;

CREATE TYPE comment_content_type AS ENUM (
    'text', 'preview', 'trace', 'system', 'run', 'action', 'credential_request', 'connect_required'
);

ALTER TABLE task_comments
    ALTER COLUMN content_type TYPE comment_content_type
    USING content_type::text::comment_content_type;

ALTER TABLE task_comments ALTER COLUMN content_type SET DEFAULT 'text';

DROP TYPE comment_content_type_old;

-------------------------------------------------------------------------------
-- wakeup_source: drop 'option_chosen'
-------------------------------------------------------------------------------

DELETE FROM agent_wakeup_requests WHERE source = 'option_chosen';

ALTER TYPE wakeup_source RENAME TO wakeup_source_old;

CREATE TYPE wakeup_source AS ENUM (
    'timer', 'assignment', 'on_demand', 'mention', 'automation', 'credential_provided', 'comment', 'reply', 'heartbeat'
);

ALTER TABLE agent_wakeup_requests
    ALTER COLUMN source TYPE wakeup_source
    USING source::text::wakeup_source;

DROP TYPE wakeup_source_old;
