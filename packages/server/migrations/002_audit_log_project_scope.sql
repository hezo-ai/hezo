-------------------------------------------------------------------------------
-- AUDIT LOG: drop the team dimension, scope every row to project or instance.
--
-- Teams are 1:1 with projects (UNIQUE(projects.team_id)), so per-team activity is
-- redundant with per-project. Every audit row is now either project-scoped
-- (project_id set) or instance-scoped (project_id NULL — instance-global
-- credential/connector/skill actions visible only in the superuser view).
-------------------------------------------------------------------------------

-- Carry team-scoped rows forward onto their team's single project. Instance-global
-- catalogs already carry team_id NULL (so they don't match the join and stay
-- project_id NULL); OAuth `connection` rows were historically team-tagged but are
-- instance-global, so they are excluded and remain instance-scoped.
UPDATE audit_log al
SET project_id = p.id
FROM projects p
WHERE al.project_id IS NULL
  AND al.team_id = p.team_id
  AND al.entity_type <> 'connection';

-- Drop the team-keyed indexes and the column itself. The project/global indexes
-- (idx_audit_project, idx_audit_created_global) cover the remaining read paths.
DROP INDEX IF EXISTS idx_audit_team;
DROP INDEX IF EXISTS idx_audit_created;
ALTER TABLE audit_log DROP COLUMN team_id;
