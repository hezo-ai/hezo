-- Agent avatars: an optional user-uploaded image that represents an agent (in
-- place of its initials fallback) on the roster, the agent header, and the org
-- chart. Stored as bytes in the database, in a dedicated 1:1 table so the hot
-- agent-roster SELECT (AGENT_BASE_COLUMNS) never pulls the image blob — mirrors
-- project_icons. Keyed on member_agents.id (the agent's member id).

CREATE TABLE agent_icons (
    member_id    UUID PRIMARY KEY REFERENCES member_agents(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL,
    data         BYTEA NOT NULL,
    byte_size    INTEGER NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
