-- Slack chat channel + the two-mode conversation model.
--
-- (a) Add `slack` to the chat_channel enum. Purely additive: Postgres 12+ (PGlite
--     is PG16) permits ALTER TYPE ... ADD VALUE inside a transaction as long as the
--     new value is not *used* in the same transaction — this migration only adds it
--     (same pattern as 027_add_api_connector_transport). Do NOT insert any 'slack'
--     row in this file.
ALTER TYPE chat_channel ADD VALUE IF NOT EXISTS 'slack';

-- (b) Conversation kind: every external chat app can support two modes, and the
--     kind records which one a conversation belongs to.
--       'mirror'   — assistant/DM mode (today's model): one logical thread mirrored
--                    across every channel binding (web chatbox ↔ Telegram ↔ …).
--       'coworker' — group mode: the CEO participates in an external group
--                    channel/thread it was invited to (a Slack channel). Exactly one
--                    binding (the origin thread), never mirrored to web or any other
--                    channel; replies post only back to that origin thread.
--     All pre-existing conversations are mirror conversations, hence the default.
CREATE TYPE chat_conversation_kind AS ENUM ('mirror', 'coworker');
ALTER TABLE chat_conversations
    ADD COLUMN kind chat_conversation_kind NOT NULL DEFAULT 'mirror';

-- (c) External sender display label for multi-party (coworker) transcripts. In a
--     group channel the sender is usually not a linked Hezo user, so the prompt
--     transcript labels the line with the platform display name ("Alice: …")
--     instead of the generic "Operator". Channel-agnostic — any group-capable
--     channel uses it. NULL for web/DM messages (label derived from the role or
--     the linked user as before).
ALTER TABLE chat_messages ADD COLUMN author_label TEXT;
