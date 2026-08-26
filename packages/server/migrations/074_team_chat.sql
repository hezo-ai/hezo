-- Team chat, phase 1: per-project agent DMs beside the CEO chat.
--
-- Three independent pieces, one migration (they ship as one feature):
--
-- 1. New system-message kinds. `system_kind` is TEXT under a CHECK list, so the
--    change is a re-stated constraint: every existing row keeps its value, and
--    an unknown kind still fails loudly at the write.
--      - budget_exceeded: the turn was refused because the agent's or project's
--        spend budget, or the instance container-hours allowance, is spent.
--      - capacity_wait: the turn is parked until a container fits the instance
--        memory budget - task runs park invisibly on their run row, a chat turn
--        parks in front of a person, so the wait is said in the thread.
--      - task_created / task_completed / task_blocked: task<->chat breadcrumbs,
--        server-emitted receipts in the conversation a task came from.
--
-- 2. Server-side unread: `chat_conversation_reads` is a per-(user, conversation)
--    watermark, written only on real change. The denormalized
--    `last_message_id` on the conversation is what badge queries compare
--    against, so an unread check never counts message rows.
--
-- 3. `suggested_replies` on chat_messages: up to three short strings an agent
--    reply offers as one-tap responses, parsed out of a structured trailer at
--    message-complete and stored beside the clean body. NULL for every other
--    message.

ALTER TABLE chat_messages DROP CONSTRAINT chat_messages_system_kind_check;

ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_system_kind_check
    CHECK (system_kind IS NULL OR system_kind IN (
        'converted_task', 'handoff_not_delivered', 'connector_refused', 'credential_wait',
        'budget_exceeded', 'capacity_wait',
        'task_created', 'task_completed', 'task_blocked'
    ));

ALTER TABLE chat_messages ADD COLUMN suggested_replies JSONB;

ALTER TABLE chat_conversations
    ADD COLUMN last_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL;

-- Backfill from the newest message each conversation already holds, so unread
-- arithmetic is correct for existing threads from the first read after upgrade.
UPDATE chat_conversations c
   SET last_message_id = m.id
  FROM (
    SELECT DISTINCT ON (conversation_id) conversation_id, id
      FROM chat_messages
     ORDER BY conversation_id, created_at DESC, id DESC
  ) m
 WHERE m.conversation_id = c.id;

CREATE TABLE chat_conversation_reads (
    user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    conversation_id      UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    last_read_message_id UUID REFERENCES chat_messages(id) ON DELETE SET NULL,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, conversation_id)
);

-- The badge query: every conversation a user can see, joined to their watermark.
-- The PK covers (user_id, conversation_id) lookups; this covers the join the
-- other way round when a conversation fans a new-message event to its readers.
CREATE INDEX idx_chat_conversation_reads_convo ON chat_conversation_reads(conversation_id);

-- Task<->chat breadcrumbs: a task created by a chat turn remembers the
-- conversation it came from, and that conversation receives created /
-- completed / blocked receipts. Read only by primary key at status-change
-- time, so no index.
ALTER TABLE tasks
    ADD COLUMN origin_chat_conversation_id UUID REFERENCES chat_conversations(id) ON DELETE SET NULL;

-- Single-stream DMs: each agent's web chat is ONE continuous conversation.
-- Close every open web assistant thread but each member's most recently
-- active one. Data-preserving: nothing is deleted - closed threads keep every
-- message and stay readable as History; converted threads keep their receipts.
UPDATE chat_conversations c
   SET closed_at = now()
 WHERE c.channel = 'web' AND c.external_thread_id IS NULL
   AND c.kind = 'assistant' AND c.closed_at IS NULL
   AND c.id NOT IN (
     SELECT DISTINCT ON (member_id) id FROM chat_conversations
      WHERE channel = 'web' AND external_thread_id IS NULL
        AND kind = 'assistant' AND closed_at IS NULL
      ORDER BY member_id, last_activity_at DESC, created_at DESC
   );

-- ============================================================================
-- Group chats (Phase 2 of the same feature, extending this unshipped file).
-- ============================================================================

-- Widen the conversation kind with 'group'. Recreate rather than ALTER TYPE
-- ADD VALUE: a value added inside this transaction could not be used by the
-- statements below it.
ALTER TYPE chat_conversation_kind RENAME TO chat_conversation_kind_old;
CREATE TYPE chat_conversation_kind AS ENUM ('assistant', 'coworker', 'group');
ALTER TABLE chat_conversations
    ALTER COLUMN kind DROP DEFAULT,
    ALTER COLUMN kind TYPE chat_conversation_kind
        USING kind::text::chat_conversation_kind,
    ALTER COLUMN kind SET DEFAULT 'assistant';
DROP TYPE chat_conversation_kind_old;

-- A group speaks for several agents, so it has no single member; every other
-- kind keeps exactly one.
ALTER TABLE chat_conversations ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE chat_conversations ADD CONSTRAINT chat_conversations_member_scope
    CHECK (member_id IS NOT NULL OR kind = 'group');

-- The built-in General room: one per project, roster-synced, not closeable.
ALTER TABLE chat_conversations ADD COLUMN is_general BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX idx_chat_conversations_general
    ON chat_conversations(project_id) WHERE is_general;

-- Who is in a group. Participants are validated against the project team's
-- roster at write time; the rows only record the outcome.
CREATE TABLE chat_conversation_participants (
    conversation_id UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    member_id       UUID NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, member_id)
);
-- "Which groups is this agent in" - the roster-sync sweep on hire/fire.
CREATE INDEX idx_chat_participants_member ON chat_conversation_participants(member_id);

-- Group compaction memory lives on the CONVERSATION, not fanned into each
-- participant's personal memory (which stays out of groups entirely). A memory
-- row now carries exactly one scope: a member (DM long-term memory, unchanged)
-- or a conversation (a group's shared memory).
ALTER TABLE chat_memories
    ADD COLUMN conversation_id UUID UNIQUE REFERENCES chat_conversations(id) ON DELETE CASCADE;
ALTER TABLE chat_memories ALTER COLUMN member_id DROP NOT NULL;
ALTER TABLE chat_memories ADD CONSTRAINT chat_memories_one_scope
    CHECK ((member_id IS NULL) <> (conversation_id IS NULL));

-- ============================================================================
-- Remove the pinned chat container (same unshipped feature branch).
-- ============================================================================

-- The CEO no longer holds a standing reserved container: every chat turn - CEO
-- and worker alike - claims a pool member busy for the turn and releases it.
-- The pool-side pin flag therefore has no reader left; dropping it (rather
-- than leaving it dead) makes any missed read fail loudly.
--
-- Dropping the column also drops 053's partial index, whose predicate named
-- it. Recreate the index without the predicate: the idle-shutdown scan now
-- covers every member, since no member is exempt from idling any more.
DROP INDEX IF EXISTS idx_container_pool_members_idle;
ALTER TABLE container_pool_members DROP COLUMN reserved_for_chat;
CREATE INDEX idx_container_pool_members_idle
    ON container_pool_members (state, last_released_at);

-- container_uptime_entries.reserved_for_chat stays: those rows are recorded
-- history from the pinned-container era, and a migration never discards user
-- data. New rows simply default it to false.

-- Indexes for the queries this feature runs per request, and for the FK
-- back-references its deletes must chase.
--
-- The group-room list filters (project, kind='group', open) and pages keyset on
-- (created_at, id); a partial composite serves both the filter and the order.
CREATE INDEX idx_chat_conversations_groups
    ON chat_conversations (project_id, created_at, id)
    WHERE kind = 'group' AND closed_at IS NULL;

-- The three ON DELETE SET NULL references added above are chased row-by-row
-- when their target is deleted (every chat_messages delete scans for pointers
-- to it; every conversation delete scans tasks). Referencing-side indexes keep
-- boot repair's placeholder sweep and project deletion off sequential scans.
CREATE INDEX idx_chat_conversations_last_message
    ON chat_conversations (last_message_id);
CREATE INDEX idx_chat_conversation_reads_last_read
    ON chat_conversation_reads (last_read_message_id);
CREATE INDEX idx_tasks_origin_chat_conversation
    ON tasks (origin_chat_conversation_id)
    WHERE origin_chat_conversation_id IS NOT NULL;
