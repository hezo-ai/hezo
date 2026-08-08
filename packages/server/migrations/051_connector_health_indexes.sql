-- Indexes for the two queries the connector-health work adds to a recurring
-- path. Each is paired with the query it exists for; an index nobody's predicate
-- can use is not an index.
--
-- 1. `oauth_connections (expires_at) WHERE refresh_token_secret_id IS NOT NULL`
--    `refreshExpiringTokens` selects
--    `WHERE expires_at IS NOT NULL AND expires_at <= $1
--       AND refresh_token_secret_id IS NOT NULL ORDER BY expires_at ASC LIMIT $2`.
--    The table carried only `idx_oauth_connections_provider`, so this was a full
--    scan plus a sort. It already ran on the egress substitution path (every
--    proxied agent request that misses the 5s vault cache); the new
--    `connector-health` cron makes it periodic as well, and adds the ORDER BY +
--    LIMIT that the sort would otherwise have to serve. Partial on the refresh
--    token: a connection with none can never be a candidate, and excluding them
--    holds the index to the working set.
--
-- 2. `mcp_connections (project_id) WHERE activated_at IS NOT NULL
--       AND auth_error IS NOT NULL AND revoked_at IS NULL`
--    The connector-health banner endpoint asks "does this project see any
--    connector that was working and has stopped?" on every project page load.
--    The healthy answer is the empty set, and a partial index over exactly the
--    broken rows means the common case touches almost nothing - the index stays
--    empty on a healthy instance.
--
-- Both are additive; no data is read, moved or dropped.

CREATE INDEX IF NOT EXISTS idx_oauth_connections_refreshable
    ON oauth_connections (expires_at)
    WHERE refresh_token_secret_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mcp_connections_degraded
    ON mcp_connections (project_id)
    WHERE activated_at IS NOT NULL AND auth_error IS NOT NULL AND revoked_at IS NULL;
