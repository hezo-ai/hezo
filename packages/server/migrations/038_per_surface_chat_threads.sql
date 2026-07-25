-- The de-mirrored chat model: per-surface threads + coworker mode.
--
-- (a) New chat channels. Purely additive: Postgres 12+ (PGlite is PG16) permits
--     ALTER TYPE ... ADD VALUE inside a transaction as long as the new value is
--     not *used* to write a row in the same transaction — this migration only
--     declares column types with the enum (pattern: 027). Do NOT insert 'slack'
--     or 'discord' rows in this file.
ALTER TYPE chat_channel ADD VALUE IF NOT EXISTS 'slack';
ALTER TYPE chat_channel ADD VALUE IF NOT EXISTS 'discord';

-- (b) Conversation kind.
--       'assistant' — the operator's own line to the CEO: a web chatbox thread,
--                     an app DM, or a designated-supergroup topic. Interactive
--                     from the web view; allowlist-gated on external surfaces.
--       'coworker'  — the CEO participating in a team channel/group it was
--                     invited to (Slack channel, Telegram group, Discord
--                     channel). Mention-driven, replies only into the platform
--                     thread, read-only in the web view.
--     All pre-existing conversations are the operator's own threads, hence the
--     'assistant' default.
CREATE TYPE chat_conversation_kind AS ENUM ('assistant', 'coworker');
ALTER TABLE chat_conversations
    ADD COLUMN kind chat_conversation_kind NOT NULL DEFAULT 'assistant';

-- (c) External sender display label for multi-party (coworker) transcripts. In a
--     group channel the sender is usually not a linked Hezo user, so the prompt
--     transcript labels the line with the platform display name ("Alice: …")
--     instead of the generic "Operator". NULL for web/DM messages.
ALTER TABLE chat_messages ADD COLUMN author_label TEXT;

-- (d) De-mirroring: a conversation has exactly ONE home surface, and the
--     conversation row's own (channel, external_thread_id) IS the inbound
--     routing key (unique-per-open enforced by idx_chat_conversations_external
--     from 029). The bindings table was the mirror-era many-surfaces join and is
--     a redundant 1:1 shadow now — its rows carry nothing the conversation row
--     doesn't already hold, so dropping it destroys no data a later version
--     needs. (031 stays frozen as history; this migration retires its table.)
DROP TABLE chat_conversation_bindings;

-- (e) Observed-message buffer for group/coworker context on platforms with no
--     history API (Telegram). The bot passively records the group messages it
--     receives (privacy mode off) into a bounded rolling buffer per chat, read
--     back as ephemeral context when it is mentioned. Pruning happens on insert
--     in code (keep the newest ~200 rows per (channel, external_chat_id)).
CREATE TABLE chat_observed_messages (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel          chat_channel NOT NULL,
    -- Platform group/channel id (Telegram chat id, Discord channel id).
    external_chat_id TEXT NOT NULL,
    -- Optional sub-scope inside the chat (a Telegram forum-topic id); NULL for
    -- plain groups. A topic-scoped mention reads only its topic's buffer.
    thread_scope     TEXT,
    sender_label     TEXT NOT NULL,
    content          TEXT NOT NULL,
    -- Platform message id/ts, for dedupe on webhook retries.
    message_ts       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_chat_observed_chat
    ON chat_observed_messages (channel, external_chat_id, created_at DESC);
