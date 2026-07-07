-- Generalize the realtime-chat schema so it is first-class for a chat with ANY
-- agent, not just the CEO. Two parts, both data-preserving:
--
-- 1. Rename the CEO-specific tables, enum types, and indexes to generic `chat_*`
--    names. A rename keeps every row, column, foreign key, index, and the
--    `compacted_at` column intact — only the identifiers change. The enum
--    *values* (`web`, `assistant`, `streaming`, …) are already generic and are
--    left untouched; only the type names change. The current feature surface
--    (the `/api/ceo/*` routes, the `ceo:global` WS room, the TS symbols) stays
--    CEO-named — those name the CEO chat feature that ships today; wiring the UI
--    to other agents is future work. A TS symbol name need not match its DB type.
--
-- 2. Make agent scoping explicit and complete (additive, backfilled). Sessions
--    already carry `member_id`/`team_id`/`project_id`, so they already answer
--    "which agent a session is for" — no change there. Conversations already
--    carry `member_id` (the agent) + `team_id`; we add `project_id` so a
--    conversation is scoped exactly like a session. Messages gain
--    `author_member_id` so the responding agent is explicit on each row rather
--    than only derivable via the conversation, and stays correct if a
--    conversation ever spans agents.
--
-- The single global CEO conversation is a usage convention in code, never a
-- schema constraint, so nothing here changes today's behaviour — it just makes
-- the durable schema ready for per-agent chats.

-- 1. Renames -----------------------------------------------------------------
ALTER TYPE ceo_channel        RENAME TO chat_channel;
ALTER TYPE ceo_message_role   RENAME TO chat_message_role;
ALTER TYPE ceo_message_status RENAME TO chat_message_status;
ALTER TYPE ceo_session_status RENAME TO chat_session_status;

ALTER TABLE ceo_sessions      RENAME TO chat_sessions;
ALTER TABLE ceo_conversations RENAME TO chat_conversations;
ALTER TABLE ceo_messages      RENAME TO chat_messages;

ALTER INDEX idx_ceo_sessions_status       RENAME TO idx_chat_sessions_status;
ALTER INDEX idx_ceo_sessions_singleton    RENAME TO idx_chat_sessions_singleton;
ALTER INDEX idx_ceo_messages_conversation RENAME TO idx_chat_messages_conversation;
ALTER INDEX idx_ceo_messages_active       RENAME TO idx_chat_messages_active;

-- 2. Explicit agent scoping (additive + backfill) ----------------------------

-- Conversations: scope to a project, like sessions. Backfill the existing CEO
-- conversation(s) to their team's internal (HQ) project, then enforce NOT NULL.
ALTER TABLE chat_conversations
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
UPDATE chat_conversations c
    SET project_id = p.id
    FROM projects p
    WHERE p.team_id = c.team_id AND p.is_internal = true;
ALTER TABLE chat_conversations ALTER COLUMN project_id SET NOT NULL;
CREATE INDEX idx_chat_conversations_project ON chat_conversations(project_id);

-- Messages: name the responding agent explicitly. Nullable — user rows have no
-- agent author (`author_user_id` attributes them). Backfill assistant rows from
-- their conversation's agent.
ALTER TABLE chat_messages
    ADD COLUMN author_member_id UUID REFERENCES members(id) ON DELETE SET NULL;
UPDATE chat_messages m
    SET author_member_id = c.member_id
    FROM chat_conversations c
    WHERE m.conversation_id = c.id AND m.role = 'assistant';
