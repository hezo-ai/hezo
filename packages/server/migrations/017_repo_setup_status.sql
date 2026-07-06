-- Repo checkout setup (container up + in-container clone + first-repo
-- designation) now runs in the background after POST /repos returns, instead
-- of holding the HTTP request open for minutes. Track its lifecycle on the
-- row so the UI can render progress/failure and a failed or interrupted
-- setup can be retried instead of dead-ending on the unique index.
--
-- Existing rows predate the state machine and only ever persisted after a
-- successful (or explicitly tolerated) setup, so they backfill to 'ready'.
CREATE TYPE repo_setup_status AS ENUM ('pending', 'ready', 'failed');

ALTER TABLE repos
    ADD COLUMN setup_status repo_setup_status NOT NULL DEFAULT 'ready',
    ADD COLUMN setup_error TEXT;
