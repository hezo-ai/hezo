-- Two tables backing external chat channels (Telegram now, Discord later):
--
--   chat_channel_configs — per-channel bot configuration. Fully generic: the bot
--     token lives in the `secrets` vault (referenced by name, never stored raw
--     here) and all channel-specific settings live in `metadata` jsonb accessed via
--     the channel adapter's own typed accessor — no per-channel columns, so a new
--     channel is one adapter file, not a schema change.
--
--   chat_identity_links — the access allowlist. Only external senders explicitly
--     mapped to a Hezo user may chat; unlinked senders are ignored/prompted to link.
--     `user_id` targets the same `users(id)` as chat_messages.author_user_id, so a
--     linked turn attributes to that user with no extra plumbing.
CREATE TABLE chat_channel_configs (
    channel          chat_channel PRIMARY KEY,
    enabled          BOOLEAN NOT NULL DEFAULT false,
    -- secrets.name of the encrypted bot token (decrypted in-process by trusted
    -- server code — bot API calls go direct, not through the agent egress proxy).
    bot_token_secret TEXT,
    -- Shared secret echoed by webhook-style adapters (Telegram secret_token, etc.).
    webhook_secret   TEXT,
    -- All channel-specific settings (Discord app/guild id, Telegram group id, …).
    metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_identity_links (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel          chat_channel NOT NULL,
    external_user_id TEXT NOT NULL,                              -- Telegram from.id / Discord author.id
    user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    external_handle  TEXT,                                       -- display handle, for the UI
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (channel, external_user_id)
);

CREATE INDEX idx_chat_identity_links_user ON chat_identity_links(user_id);
