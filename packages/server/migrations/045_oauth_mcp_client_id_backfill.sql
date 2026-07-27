-- Backfill oauth_connections.metadata.client_id for MCP connections created by
-- the auth-code / DCR callbacks.
--
-- Those callbacks persisted token_url + authorize_url but not the client id they
-- had just used for the code exchange. The generic host-side refresh
-- (services/oauth/generic-refresh.ts) needs token_url AND client_id, so it threw
-- before any network call and every such connection was permanently stuck on its
-- original access token -- silently, since the failure was swallowed and the
-- connector kept reporting healthy.
--
-- The client id is recoverable: the DCR registration is cached on the connector
-- row at mcp_connections.config.dcr.client_id. Copy it across for any linked
-- connection still missing it.
--
-- Additive and data-preserving: `||` merges into the existing metadata object, so
-- resource_url / token_url / authorize_url and any other keys are untouched, and
-- a connection that already carries a client_id is left alone.

UPDATE oauth_connections oc
SET metadata   = oc.metadata || jsonb_build_object('client_id', mc.config -> 'dcr' ->> 'client_id'),
    updated_at = now()
FROM mcp_connections mc
WHERE mc.oauth_connection_id = oc.id
  AND oc.metadata ->> 'client_id' IS NULL
  AND mc.config -> 'dcr' ->> 'client_id' IS NOT NULL;
