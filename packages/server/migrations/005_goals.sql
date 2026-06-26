-- Reintroduce Goals as a first-class, project-scoped concept.
--
-- A goal is a project-level objective the Captain tracks. The Captain estimates each
-- goal's progress on a cadence (during its heartbeat), updating a percentage, a coloured
-- health, and a one-paragraph status blurb. Goals are SMART: the title/description are the
-- guidelines, target_date carries the time-bound aspect.
--
-- Additive only; preserves all existing data. heartbeat_runs.kind defaults to 'task' so every
-- existing run row stays correct with no backfill, and tasks.goal_id is nullable.

-- Cadence at which the Captain re-checks a goal.
CREATE TYPE goal_check_frequency AS ENUM ('daily', 'weekly', 'monthly');

-- Captain-set health pill. 'pending' = not yet assessed (grey) so a brand-new goal is honest.
CREATE TYPE goal_health AS ENUM ('pending', 'on_track', 'at_risk', 'off_track');

CREATE TABLE goals (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id               UUID NOT NULL REFERENCES teams(id)    ON DELETE CASCADE,
    project_id            UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title                 TEXT NOT NULL,
    description           TEXT NOT NULL DEFAULT '',          -- SMART guidelines
    progress_percent      INTEGER NOT NULL DEFAULT 0 CHECK (progress_percent BETWEEN 0 AND 100),
    health                goal_health NOT NULL DEFAULT 'pending',   -- coloured pill, Captain-set
    status_blurb          TEXT NOT NULL DEFAULT '',          -- Captain's "where it stands"
    check_frequency       goal_check_frequency NOT NULL DEFAULT 'daily',
    target_date           DATE,                              -- optional, SMART "Timed"
    last_checked_at       TIMESTAMPTZ,                       -- NULL = due now
    archived_at           TIMESTAMPTZ,                       -- NULL = active; admin-set
    created_by_member_id  UUID REFERENCES members(id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_goals_project ON goals(project_id);
CREATE INDEX idx_goals_team    ON goals(team_id);
CREATE INDEX idx_goals_active  ON goals(project_id) WHERE archived_at IS NULL;

-- Classify a heartbeat run; default 'task' keeps every existing/legacy row correct with no
-- backfill. Goal-check runs are Captain runs with task_id IS NULL and kind = 'goal_check'.
CREATE TYPE heartbeat_run_kind AS ENUM ('task', 'goal_check');
ALTER TABLE heartbeat_runs ADD COLUMN kind heartbeat_run_kind NOT NULL DEFAULT 'task';

-- Which goals a goal-check run updated, snapshotting the percent/health/blurb at that moment.
-- This is the single source of a goal's progress history (line charts) and powers the Goals
-- page's "this run updated goals A, B" annotation. Snapshotting keeps both stable after later
-- edits to the live goal.
CREATE TABLE goal_run_updates (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id            UUID NOT NULL REFERENCES heartbeat_runs(id) ON DELETE CASCADE,
    goal_id           UUID NOT NULL REFERENCES goals(id)          ON DELETE CASCADE,
    progress_percent  INTEGER NOT NULL CHECK (progress_percent BETWEEN 0 AND 100),
    health            goal_health NOT NULL DEFAULT 'pending',
    status_blurb      TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, goal_id)
);
CREATE INDEX idx_goal_run_updates_run  ON goal_run_updates(run_id);
CREATE INDEX idx_goal_run_updates_goal ON goal_run_updates(goal_id);

-- Optional, non-gating traceability link from a task to the goal it advances.
ALTER TABLE tasks ADD COLUMN goal_id UUID REFERENCES goals(id) ON DELETE SET NULL;
CREATE INDEX idx_tasks_goal ON tasks(goal_id) WHERE goal_id IS NOT NULL;
