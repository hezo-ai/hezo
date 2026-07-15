-- Relax the single-global-conversation constraint so the CEO chat supports many
-- parallel conversation threads: the existing web chatbox gains a thread switcher,
-- and external channels (Telegram forum topics, later Discord threads) each map to
-- their own conversation.
--
-- Until now `chat_conversations` held exactly one row per CEO member (the code
-- resolved it "first row wins"). This migration keys a conversation by
-- (member_id, channel, external_thread_id) instead:
--   * channel            — which surface the thread lives on (web/telegram/…).
--   * external_thread_id — the platform thread id (Telegram "<chat.id>:<topic>",
--                          Discord channel/thread id); NULL for web threads.
--   * last_activity_at   — drives ordering in the conversation list.
--   * closed_at          — thread lifecycle (NULL = open, set = closed).
--
-- Purely additive. The pre-existing global row already has channel='web' and
-- external_thread_id=NULL by the defaults below, so it simply becomes the default
-- open web thread — no data move.
ALTER TABLE chat_conversations
    ADD COLUMN channel            chat_channel NOT NULL DEFAULT 'web',
    ADD COLUMN external_thread_id TEXT,
    ADD COLUMN last_activity_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN closed_at          TIMESTAMPTZ;

-- Each *open* external thread resolves to exactly one conversation. Scoped to
-- external_thread_id IS NOT NULL (web threads have no external id and may be many)
-- and closed_at IS NULL (a closed thread must not block a fresh conversation if the
-- same platform thread id is later reused).
CREATE UNIQUE INDEX idx_chat_conversations_external
    ON chat_conversations (member_id, channel, external_thread_id)
    WHERE external_thread_id IS NOT NULL AND closed_at IS NULL;

-- List ordering: newest activity first, open threads only.
CREATE INDEX idx_chat_conversations_activity
    ON chat_conversations (member_id, last_activity_at DESC)
    WHERE closed_at IS NULL;
