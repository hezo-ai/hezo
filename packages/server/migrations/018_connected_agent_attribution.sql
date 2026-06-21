-- Attribute admin actions taken by a connected agent (an approved external MCP
-- client; see 016_connected_agents.sql) so the UI can flag human-vs-agent.
--
-- A connected agent is admin-equivalent but is NOT a team member, so its actions
-- can't hang off `actor_member_id` / `author_member_id`. It gets its own parallel
-- nullable FK on each attributed table, alongside the member FK (at most one of
-- the two is set per row). `audit_actor_type` gains a `connected_agent` value.

-- Extend audit_actor_type with 'connected_agent'. PGlite rejects
-- `ALTER TYPE ... ADD VALUE` inside a transaction and the runner wraps every
-- migration in BEGIN/COMMIT, so recreate the type and swap the column over (the
-- same pattern as 008). Only audit_log.actor_type uses this type.
CREATE TYPE audit_actor_type_new AS ENUM ('admin', 'agent', 'system', 'connected_agent');

ALTER TABLE audit_log
    ALTER COLUMN actor_type TYPE audit_actor_type_new
    USING actor_type::text::audit_actor_type_new;

DROP TYPE audit_actor_type;
ALTER TYPE audit_actor_type_new RENAME TO audit_actor_type;

-- Parallel connected-agent attribution columns.
ALTER TABLE audit_log
    ADD COLUMN actor_connected_agent_id UUID REFERENCES connected_agents(id) ON DELETE SET NULL;
ALTER TABLE task_comments
    ADD COLUMN author_connected_agent_id UUID REFERENCES connected_agents(id) ON DELETE SET NULL;
ALTER TABLE document_revisions
    ADD COLUMN author_connected_agent_id UUID REFERENCES connected_agents(id) ON DELETE SET NULL;

CREATE INDEX idx_audit_actor_connected_agent ON audit_log(actor_connected_agent_id)
    WHERE actor_connected_agent_id IS NOT NULL;
CREATE INDEX idx_comments_author_connected_agent ON task_comments(author_connected_agent_id)
    WHERE author_connected_agent_id IS NOT NULL;
