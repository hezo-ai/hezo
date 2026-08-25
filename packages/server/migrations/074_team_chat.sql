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
