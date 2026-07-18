-- User avatars: an optional user-uploaded image for a human user (today just the
-- single admin), shown on the global Settings → Users page in place of the
-- initials fallback. Stored as bytes in the database, in a dedicated 1:1 table so
-- the hot `users` SELECTs never pull the image blob — mirrors project_icons /
-- agent_icons. Keyed on users.id.

CREATE TABLE user_icons (
    user_id      UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    data         BYTEA NOT NULL,
    byte_size    INTEGER NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
