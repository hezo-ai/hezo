-- Connectors could previously authenticate only two ways: an OAuth connection
-- (`oauth_connection_id`) or operator-supplied static headers. Many MCP servers
-- expose no OAuth at all and authenticate with a plain API key (e.g. Typefully's
-- `Authorization: Bearer <key>`). Add a typed link from a connector to the vault
-- `secrets` row holding that pasted key, mirroring `oauth_connection_id`.
--
-- The key itself is NEVER stored on the connector — only this FK to the encrypted
-- `secrets` row. At run time the descriptor emits `__HEZO_SECRET_<name>__` for it
-- (never the plaintext); the egress proxy substitutes at request time, scoped by
-- the secret's allowed_hosts. ON DELETE SET NULL so purging the secret cleanly
-- deactivates the connector rather than orphaning a dangling reference.
ALTER TABLE mcp_connections
    ADD COLUMN api_key_secret_id UUID REFERENCES secrets(id) ON DELETE SET NULL;

CREATE INDEX idx_mcp_connections_api_key_secret
    ON mcp_connections(api_key_secret_id) WHERE api_key_secret_id IS NOT NULL;
