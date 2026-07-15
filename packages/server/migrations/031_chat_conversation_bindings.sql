-- Make a conversation a *single logical thread mirrored across channels* rather
-- than a per-channel thread. A conversation now has N channel bindings: the web
-- chatbox binding (NULL external id) plus one per external channel it is mirrored
-- into (a Telegram forum-topic id, later a Discord thread id). Creating a thread on
-- any surface creates the peers; a message on any surface fans out to the others;
-- closing anywhere closes everywhere.
--
-- `chat_conversations.channel` / `external_thread_id` stay as *origin* provenance
-- (which surface the thread was born on). Inbound resolution and mirroring go
-- through the bindings table below.
CREATE TABLE chat_conversation_bindings (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    conversation_id    UUID NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    channel            chat_channel NOT NULL,
    external_thread_id TEXT,                          -- NULL for the web binding
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (conversation_id, channel)                 -- one binding per channel per conversation
);

-- Each external thread id resolves to exactly one conversation (inbound routing).
CREATE UNIQUE INDEX idx_ccb_external
    ON chat_conversation_bindings (channel, external_thread_id)
    WHERE external_thread_id IS NOT NULL;

CREATE INDEX idx_ccb_conversation ON chat_conversation_bindings (conversation_id);

-- Backfill a binding for every existing conversation's own (origin) channel, so
-- inbound resolution keeps working after the switch to bindings.
INSERT INTO chat_conversation_bindings (conversation_id, channel, external_thread_id)
SELECT id, channel, external_thread_id FROM chat_conversations;

-- Every conversation is reachable from the web chatbox: give any non-web origin
-- conversation a web binding too (web-origin rows already have one from above).
INSERT INTO chat_conversation_bindings (conversation_id, channel, external_thread_id)
SELECT id, 'web', NULL FROM chat_conversations WHERE channel <> 'web'
ON CONFLICT (conversation_id, channel) DO NOTHING;
