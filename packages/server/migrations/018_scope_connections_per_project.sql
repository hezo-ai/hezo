-- OAuth account connections and MCP connectors were instance-global: connect a
-- GitHub (or SaaS) account once, shared by every project's runs. Real deployments
-- run multiple projects that each need a *separate* upstream account (e.g. two
-- projects, two different GitHub logins whose repos and commit identities must not
-- cross). Scope both catalogs by project: a non-NULL project_id makes the row
-- private to that project; NULL keeps the historical global ("all projects")
-- semantics — the instance-admin /settings/connectors surface and every
-- pre-existing row. (A project owns exactly one team, 1:1, and a run is scoped to
-- the task's project, so project_id is the natural, more-correct key.)

ALTER TABLE oauth_connections
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE mcp_connections
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

-- Backfill: a GitHub oauth connection whose linked repos all live in a single
-- project is unambiguously that project's — claim it so existing single-project
-- setups keep working without a reconnect. A connection whose repos span more
-- than one project (the shared-account case being fixed) stays global, as does a
-- repo-less SaaS connection; those are separated by reconnecting per project.
UPDATE oauth_connections oc
SET project_id = t.project_id
FROM (
    SELECT r.oauth_connection_id, MIN(r.project_id::text)::uuid AS project_id
    FROM repos r
    WHERE r.oauth_connection_id IS NOT NULL
    GROUP BY r.oauth_connection_id
    HAVING COUNT(DISTINCT r.project_id) = 1
) t
WHERE oc.id = t.oauth_connection_id;

-- A connector follows its linked oauth connection's (now-resolved) project, so a
-- GitHub connector lands in the same project as its token. Connectors with no
-- oauth link, or whose oauth stayed global, remain global.
UPDATE mcp_connections mc
SET project_id = oc.project_id
FROM oauth_connections oc
WHERE mc.oauth_connection_id = oc.id AND oc.project_id IS NOT NULL;

-- Replace the global unique keys with project-partitioned ones. NULL project_id
-- keeps a single global namespace; non-NULL gets a per-project namespace, so the
-- same upstream account (or connector name) can exist independently in two
-- projects. The old global uniques are still in force during the backfill above,
-- so no duplicate can pre-exist to violate the new partial indexes.
ALTER TABLE oauth_connections
    DROP CONSTRAINT IF EXISTS oauth_connections_provider_provider_account_id_key;
CREATE UNIQUE INDEX idx_oauth_conn_global_account
    ON oauth_connections (provider, provider_account_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_oauth_conn_project_account
    ON oauth_connections (project_id, provider, provider_account_id) WHERE project_id IS NOT NULL;

ALTER TABLE mcp_connections
    DROP CONSTRAINT IF EXISTS mcp_connections_name_key;
CREATE UNIQUE INDEX idx_mcp_conn_global_name
    ON mcp_connections (name) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_mcp_conn_project_name
    ON mcp_connections (project_id, name) WHERE project_id IS NOT NULL;

CREATE INDEX idx_oauth_connections_project ON oauth_connections(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_mcp_connections_project ON mcp_connections(project_id) WHERE project_id IS NOT NULL;
