-- Archival (soft delete) for projects: a superuser retires a project from the
-- project settings page. An archived project is hidden from the default project
-- index (the left rail) but keeps its row, slug, team, tasks, and history intact
-- so it can be unarchived later from global settings. Archiving also stops the
-- project's container; unarchiving restores visibility only (the container stays
-- stopped, like any other stopped project).
--
-- Purely additive: existing rows backfill to NULL (= active), so nothing changes
-- for current data. `archived_at` NULL = active, non-null = archived. The partial
-- index mirrors `idx_goals_active` — the default index for the active-only list.
ALTER TABLE projects ADD COLUMN archived_at TIMESTAMPTZ;

CREATE INDEX idx_projects_active ON projects(created_at) WHERE archived_at IS NULL;
