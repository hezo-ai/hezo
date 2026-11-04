-- A project's hours budget: how long its containers may be up in a day, a week
-- and a container-hours window (the instance allowance's own period), beside
-- the token budget it already carries.
--
-- 1. The limits.
--
-- Counted in container-seconds, the ledger's own unit, so the gate compares
-- like with like and nothing is rounded twice; every surface shows and takes
-- hours. 0 is no limit, as it is for the token budget, so every existing project
-- reads as unlimited and behaves exactly as it did before this migration.
--
-- Non-negative is enforced here. The cross-window floors (weekly at least seven
-- days of the daily limit, and so on) are not: they live in `@hezo/shared`, where
-- the web editor and every write path read them, as the token floors do.
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS daily_budget_container_seconds   BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS weekly_budget_container_seconds  BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS monthly_budget_container_seconds BIGINT NOT NULL DEFAULT 0;

ALTER TABLE projects
    DROP CONSTRAINT IF EXISTS projects_budget_container_seconds_non_negative;
ALTER TABLE projects
    ADD CONSTRAINT projects_budget_container_seconds_non_negative CHECK (
        daily_budget_container_seconds >= 0
        AND weekly_budget_container_seconds >= 0
        AND monthly_budget_container_seconds >= 0
    );

-- 2. The index the gate reads.
--
-- A project with an hours limit has its uptime summed on every dispatch, every
-- run completion and every chat turn. The sum wants the intervals still open
-- or that ended inside the longest window - and `idx_container_uptime_project`
-- leads on `started_at`, which bounds only the other end, so it walks the
-- project's whole history. This one serves both arms: `ended_at IS NULL` and
-- `ended_at > <window start>`, each a range under the project.
CREATE INDEX IF NOT EXISTS idx_container_uptime_project_end
    ON container_uptime_entries (project_id, ended_at);
