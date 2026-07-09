-- Skills were instance-global: one reusable-skill catalog shared with every
-- project's runs. Real deployments run multiple projects whose know-how should
-- not always cross — a deploy/runbook skill authored while working project A is
-- usually specific to A, not something every other project's agents should see.
-- Scope skills by project exactly like MCP connectors (018): a non-NULL
-- project_id makes a skill private to that project; NULL keeps the historical
-- global ("all projects") semantics — the instance-admin /settings/skills
-- surface and every pre-existing row. A project-scoped skill shadows a global
-- skill of the same slug within that project.

ALTER TABLE skills
    ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE CASCADE;

-- Replace the global unique key with project-partitioned ones. NULL project_id
-- keeps a single global namespace; non-NULL gets a per-project namespace, so the
-- same slug can exist once globally and once per project (and two projects can
-- each author their own "deploy" skill without colliding). Every existing skill
-- stays global (project_id NULL), so no row can pre-exist to violate the new
-- partial indexes.
ALTER TABLE skills DROP CONSTRAINT IF EXISTS skills_slug_key;
CREATE UNIQUE INDEX idx_skills_global_slug
    ON skills (slug) WHERE project_id IS NULL;
CREATE UNIQUE INDEX idx_skills_project_slug
    ON skills (project_id, slug) WHERE project_id IS NOT NULL;

CREATE INDEX idx_skills_project ON skills (project_id) WHERE project_id IS NOT NULL;
