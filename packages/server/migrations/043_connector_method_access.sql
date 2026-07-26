-- Per-connector control over which of a remote MCP server's methods (tools)
-- agents may use.
--
-- An MCP server ships its read tools and its write tools in one connection, so
-- until now connecting Linear handed every agent `delete_comment` and
-- `merge_diff` alongside `search_documentation`. These columns let an operator
-- (or an agent's own read-only request) narrow that to an allowlist.
--
-- `enabled_methods` NULL means **no allowlist — every method is enabled**, which
-- is deliberately NOT the same as an array naming every method we currently know
-- about. An unrestricted connector must pick up methods the server adds later,
-- while a restricted one must treat an unknown new method as disabled until an
-- operator enables it. Nothing may collapse those two states.
--
-- These are columns rather than keys inside the existing `config` jsonb because
-- `config` is replaced wholesale by the connector create/reconfigure routes and
-- by the `add_connector` MCP tool — an operator editing a server URL would
-- silently wipe the allowlist, i.e. a security control turning itself off with
-- no trace. As columns they also survive `restoreRevokedConnector`, so a
-- revoke/reconnect cycle keeps the restriction in place.
--
-- `requested_access` records what an agent asked for via `register_connector`;
-- `access_applied_at` stamps the moment that request was applied, so it applies
-- exactly once and an operator's later edit is never overwritten by a re-register.

CREATE TYPE connector_access AS ENUM ('read', 'write');

ALTER TABLE mcp_connections
    -- JSON array of enabled method names. NULL = unrestricted (see above).
    ADD COLUMN enabled_methods    JSONB,
    -- Cached `tools/list` catalog: [{name, description, read_only, inferred}].
    ADD COLUMN discovered_methods JSONB,
    ADD COLUMN methods_listed_at  TIMESTAMPTZ,
    ADD COLUMN requested_access   connector_access,
    ADD COLUMN access_applied_at  TIMESTAMPTZ;

-- The egress proxy resolves a restricted connector by host on every agent run,
-- and the connectors list highlights restricted rows. Both only ever care about
-- the rows that actually carry an allowlist, which is the minority — so a
-- partial index keeps that lookup off a full scan without carrying the
-- unrestricted majority.
CREATE INDEX idx_mcp_connections_restricted
    ON mcp_connections(id) WHERE enabled_methods IS NOT NULL;
