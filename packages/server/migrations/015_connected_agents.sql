-- 015_connected_agents.sql
-- External AI agents (MCP clients like Claude, openclaw, …) can self-register
-- with the instance and, once a human admin approves them, act with
-- admin-equivalent access across every project and team. A registration is
-- inert (`pending`) until approved, and "disconnect" is a row delete — which
-- gives instant, total revocation since auth resolves the token against this
-- table on every request (no token cache).
--
-- Token storage mirrors `api_keys`: only an 8-char `prefix` (lookup key) and a
-- SHA-256 `token_hash` are stored; the raw `hezoc_…` token is shown once at
-- registration and never persisted.

CREATE TYPE connected_agent_status AS ENUM ('pending', 'approved');

CREATE TABLE connected_agents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                TEXT NOT NULL,
    client_info         JSONB NOT NULL DEFAULT '{}',          -- MCP clientInfo {name,version,...}
    prefix              TEXT NOT NULL UNIQUE,                 -- 8 hex chars, lookup key
    token_hash          TEXT NOT NULL,                        -- sha256(full token)
    status              connected_agent_status NOT NULL DEFAULT 'pending',
    approved_at         TIMESTAMPTZ,
    approved_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    last_used_at        TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_connected_agents_status ON connected_agents(status);
