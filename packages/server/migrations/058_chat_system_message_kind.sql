-- Discriminate the kinds of system message a chat thread can carry, and index
-- the lookup the CEO chat's no-wake exit check runs.
--
-- 1. `chat_messages.system_kind`
--
-- Until now `role = 'system'` had exactly one producer - the marker written when
-- a conversation is converted into a task - so the web chatbox could render every
-- system row as that marker, reading the thread's `converted_task_id` for the
-- link. The CEO chat now writes a second kind: a warning that a comment the turn
-- posted on some project's task named a teammate without notifying anyone. With
-- no discriminator those two collapse: in a thread that was later converted, the
-- older warning would re-render as the converted-task link, since the deciding
-- fact lives on the conversation rather than the message.
--
-- NULL for every non-system row (nothing to discriminate) and constrained rather
-- than free text, so a typo in a producer fails loudly at the write instead of
-- silently rendering as the fallback. Every pre-existing system row is a
-- converted-task marker by construction, hence the backfill.
--
-- 2. `idx_comments_author_created`
--
-- A chat turn's own comments cannot be found by `created_by_run_id`: a chat
-- session principal authenticates against `chat_sessions`, not `heartbeat_runs`,
-- so it has no run id and its comments carry NULL there. They are identified by
-- author plus "since this turn's assistant row was created" instead, which
-- `idx_comments_author` alone serves poorly - it narrows to every comment the
-- CEO has ever written, then filters by time. The composite index answers both
-- halves, once per chat turn.

ALTER TABLE chat_messages ADD COLUMN system_kind TEXT;

ALTER TABLE chat_messages ADD CONSTRAINT chat_messages_system_kind_check
    CHECK (system_kind IS NULL OR system_kind IN ('converted_task', 'handoff_not_delivered'));

UPDATE chat_messages SET system_kind = 'converted_task' WHERE role = 'system';

CREATE INDEX idx_comments_author_created ON task_comments(author_member_id, created_at);
