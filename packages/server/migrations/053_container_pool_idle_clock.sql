-- Give each pool member its own idle clock, so idle capacity can be reclaimed
-- without waiting for its whole project to fall quiet.
--
-- Idle retirement used to be decided per *project*: a project was a candidate
-- only when it had no queued or running run, no recently finished run, no
-- dispatchable wakeup and no live chat session. A project with two busy
-- containers and two idle ones therefore never qualified, and those two idle
-- containers held their full memory against the instance budget for as long as
-- the project kept working - starving every other project, which saw only "at
-- its active-container limit". The clock made it worse: it was
-- `projects.container_last_started_at`, so starting any container reset the
-- idle timer for every idle sibling.
--
-- `last_released_at` is already the right clock and is already written on every
-- release (`releasePoolMember`) and on boot-time reclaim
-- (`reclaimBusyPoolMembers`). What it was not is dependable - nullable, and
-- absent on a member that was provisioned but never served a run. This makes it
-- total, so the idle scan and the reclaim-candidate query can both read a plain
-- column instead of a COALESCE expression that no index can serve.

-- A member that never served a run has no release stamp. Its creation is the
-- honest floor: it has been available since the moment it existed, which is
-- exactly what the idle clock is asking. Done before the NOT NULL below, in the
-- same transaction, so no row can fail the constraint.
UPDATE container_pool_members
   SET last_released_at = created_at
 WHERE last_released_at IS NULL;

-- New rows are inserted by `upsertPoolMember`, which does not name this column.
-- The default is what keeps the constraint true for them without teaching every
-- insert site about a field that only the release path has an opinion on.
ALTER TABLE container_pool_members
    ALTER COLUMN last_released_at SET DEFAULT now();

ALTER TABLE container_pool_members
    ALTER COLUMN last_released_at SET NOT NULL;

-- Serves both new scans: the once-a-minute sweep for members idle past the
-- window, and the reclaim-candidate query on the acquire path when a project's
-- next container does not fit the budget. Both filter on state, order by
-- `last_released_at` and skip the chat's pinned member - which is excluded from
-- the instance memory budget anyway, so reclaiming one would free nothing.
CREATE INDEX idx_container_pool_members_idle
    ON container_pool_members (state, last_released_at)
    WHERE NOT reserved_for_chat;
